import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRedis, mockPublish, mockSubscribe, mockIsNodeAlive, mockCleanupServerVoice, mockCleanupChannelVoice, mockEvictUser, mockGuardedReap } = vi.hoisted(() => ({
  mockRedis: {
    sMembers: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  },
  mockPublish: vi.fn().mockResolvedValue(1),
  mockSubscribe: vi.fn().mockResolvedValue(undefined),
  mockIsNodeAlive: vi.fn().mockResolvedValue(false),
  mockCleanupServerVoice: vi.fn(),
  mockCleanupChannelVoice: vi.fn(),
  mockEvictUser: vi.fn(),
  mockGuardedReap: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
  getRedisPubSub: vi.fn().mockReturnValue({ pub: { publish: mockPublish }, sub: {} }),
  getRedisConfigSub: vi.fn().mockReturnValue({ subscribe: mockSubscribe }),
  NODE_ID: vi.fn().mockReturnValue('test-node-1'),
  isNodeAlive: mockIsNodeAlive,
}));

// The reaps are mocked; the departure announcement is the real one
vi.mock('../../utils/voiceMirror', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/voiceMirror')>()),
  reapVoiceChannelMirror: vi.fn().mockResolvedValue([]),
  reapDeadOwnerChannelMirror: mockGuardedReap,
}));

vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: mockCleanupServerVoice,
  cleanupChannelVoice: mockCleanupChannelVoice,
  evictUserFromChannelVoice: mockEvictUser,
  reapOrphanedRemoteParticipants: vi.fn().mockResolvedValue(undefined),
}));

import { initVoiceCluster, stopVoiceCluster, broadcastServerVoiceCleanup, broadcastChannelVoiceCleanup, broadcastVoiceEvictUser, reapDeadNodeVoiceState } from '../../websocket/voiceCluster';
import { REAPER_INTERVAL_MS } from '../../websocket/voiceCluster';
import { reapOrphanedRemoteParticipants } from '../../websocket/voiceHandler';
import { jobDefinition } from '../../utils/jobs';
import { useFakeJobStore, restoreJobStore, type FakeJobStore } from '../helpers/jobStoreFake';

function createMockIO() {
  const emitFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    _emit: emitFn,
  };
}

describe('voiceCluster — broadcastServerVoiceCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the local cleanup AND publishes to the cluster channel', async () => {
    const io = createMockIO();
    await broadcastServerVoiceCleanup(io as never, 'server-1');

    expect(mockCleanupServerVoice).toHaveBeenCalledWith(io, 'server-1');
    expect(mockPublish).toHaveBeenCalledWith(
      'voice:cluster',
      JSON.stringify({ type: 'server_cleanup', serverId: 'server-1', fromNode: 'test-node-1' }),
    );
  });

  it('still cleans locally when the publish fails (logged, not thrown)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPublish.mockRejectedValueOnce(new Error('redis down'));

    const io = createMockIO();
    await expect(broadcastServerVoiceCleanup(io as never, 'server-1')).resolves.toBeUndefined();

    expect(mockCleanupServerVoice).toHaveBeenCalledWith(io, 'server-1');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('voiceCluster — cluster message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopVoiceCluster();
  });

  async function initAndGetHandler(io: ReturnType<typeof createMockIO>) {
    await initVoiceCluster(io as never);
    expect(mockSubscribe).toHaveBeenCalledWith('voice:cluster', expect.any(Function));
    return mockSubscribe.mock.calls[0][1] as (message: string) => void;
  }

  it('runs the local server cleanup for a peer node\'s broadcast', async () => {
    const io = createMockIO();
    const handler = await initAndGetHandler(io);

    handler(JSON.stringify({ type: 'server_cleanup', serverId: 'server-2', fromNode: 'peer-node' }));

    expect(mockCleanupServerVoice).toHaveBeenCalledWith(io, 'server-2');
  });

  it('ignores its OWN broadcast (originator already cleaned locally)', async () => {
    const io = createMockIO();
    const handler = await initAndGetHandler(io);

    handler(JSON.stringify({ type: 'server_cleanup', serverId: 'server-2', fromNode: 'test-node-1' }));

    expect(mockCleanupServerVoice).not.toHaveBeenCalled();
  });

  it('ignores malformed messages without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const io = createMockIO();
    const handler = await initAndGetHandler(io);

    expect(() => handler('not-json{{{')).not.toThrow();
    expect(mockCleanupServerVoice).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles channel_cleanup and voice_evict_user from peers (secure voice, spec §21)', async () => {
    const io = createMockIO();
    const handler = await initAndGetHandler(io);

    handler(JSON.stringify({ type: 'channel_cleanup', channelId: 'ch-9', fromNode: 'peer-node' }));
    expect(mockCleanupChannelVoice).toHaveBeenCalledWith(io, 'ch-9');

    handler(JSON.stringify({ type: 'voice_evict_user', channelId: 'ch-9', userId: 'u-2', fromNode: 'peer-node' }));
    expect(mockEvictUser).toHaveBeenCalledWith(io, 'ch-9', 'u-2');

    // Own broadcasts are ignored (originator already ran locally)
    mockCleanupChannelVoice.mockClear();
    mockEvictUser.mockClear();
    handler(JSON.stringify({ type: 'channel_cleanup', channelId: 'ch-9', fromNode: 'test-node-1' }));
    handler(JSON.stringify({ type: 'voice_evict_user', channelId: 'ch-9', userId: 'u-2', fromNode: 'test-node-1' }));
    expect(mockCleanupChannelVoice).not.toHaveBeenCalled();
    expect(mockEvictUser).not.toHaveBeenCalled();
  });
});

describe('voiceCluster — channel cleanup / eviction broadcasts (spec §21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcastChannelVoiceCleanup runs locally AND publishes', async () => {
    const io = createMockIO();
    await broadcastChannelVoiceCleanup(io as never, 'ch-7');
    expect(mockCleanupChannelVoice).toHaveBeenCalledWith(io, 'ch-7');
    expect(mockPublish).toHaveBeenCalledWith(
      'voice:cluster',
      JSON.stringify({ type: 'channel_cleanup', channelId: 'ch-7', fromNode: 'test-node-1' }),
    );
  });

  it('broadcastVoiceEvictUser runs locally AND publishes, surviving publish failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const io = createMockIO();
    await broadcastVoiceEvictUser(io as never, 'ch-7', 'u-9');
    expect(mockEvictUser).toHaveBeenCalledWith(io, 'ch-7', 'u-9');
    expect(mockPublish).toHaveBeenCalledWith(
      'voice:cluster',
      JSON.stringify({ type: 'voice_evict_user', channelId: 'ch-7', userId: 'u-9', fromNode: 'test-node-1' }),
    );

    mockPublish.mockRejectedValueOnce(new Error('redis down'));
    await expect(broadcastVoiceEvictUser(io as never, 'ch-8', 'u-9')).resolves.toBeUndefined();
    expect(mockEvictUser).toHaveBeenCalledWith(io, 'ch-8', 'u-9');
    warnSpy.mockRestore();
  });
});

describe('voiceCluster — reapDeadNodeVoiceState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.sMembers.mockResolvedValue([]);
    mockRedis.get.mockResolvedValue(null);
    mockIsNodeAlive.mockResolvedValue(false);
    mockGuardedReap.mockResolvedValue([]);
  });

  it('reaps channels owned by dead nodes (CAS-guarded) and emits voice:user_left for each ghost', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRedis.sMembers.mockResolvedValue(['ch-dead']);
    mockRedis.get.mockResolvedValue('gone-node');
    mockIsNodeAlive.mockResolvedValue(false);
    mockGuardedReap.mockResolvedValue([{ userId: 'u-1' }, { userId: 'u-2', epoch: 'epochAAAA0001' }]);

    const io = createMockIO();
    await reapDeadNodeVoiceState(io as never);

    // The reap is guarded by the OBSERVED owner — never a blind delete
    expect(mockGuardedReap).toHaveBeenCalledWith('ch-dead', 'gone-node');
    expect(io.to).toHaveBeenCalledWith('channel:ch-dead');
    // A ghost whose session announced an epoch (secure voice) leaves with it; one that did not, without the field
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-dead', userId: 'u-1' });
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-dead', userId: 'u-2', epoch: 'epochAAAA0001' });
    warnSpy.mockRestore();
  });

  it('backs off when a peer took the channel over mid-reap (guarded reap returns null)', async () => {
    mockRedis.sMembers.mockResolvedValue(['ch-contested']);
    mockRedis.get.mockResolvedValue('gone-node');
    mockIsNodeAlive.mockResolvedValue(false);
    mockGuardedReap.mockResolvedValue(null); // ownership changed under us

    const io = createMockIO();
    await reapDeadNodeVoiceState(io as never);

    expect(io._emit).not.toHaveBeenCalled(); // nothing reaped, nothing announced
  });

  it('never touches its OWN channels or a live peer\'s channels', async () => {
    mockRedis.sMembers.mockResolvedValue(['ch-own', 'ch-peer']);
    mockRedis.get.mockImplementation((key: string) => {
      if (key === 'voice:channel:node:ch-own') return Promise.resolve('test-node-1');
      if (key === 'voice:channel:node:ch-peer') return Promise.resolve('peer-node');
      return Promise.resolve(null);
    });
    mockIsNodeAlive.mockImplementation(async (nodeId: string) => nodeId === 'peer-node');

    const io = createMockIO();
    await reapDeadNodeVoiceState(io as never);

    expect(mockGuardedReap).not.toHaveBeenCalled();
  });
});

// Each tick of the two sweeps goes through the job registry's wrapper
// (utils/jobs.ts): never switched, recorded on change by the node that ran
// it (every node runs it).
describe('voiceCluster — the reaper and the job registry', () => {
  let jobs: FakeJobStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    jobs = useFakeJobStore();
    mockRedis.sMembers.mockResolvedValue([]);
    mockRedis.get.mockResolvedValue(null);
    mockIsNodeAlive.mockResolvedValue(false);
    vi.mocked(reapOrphanedRemoteParticipants).mockResolvedValue(undefined);
  });
  afterEach(() => {
    stopVoiceCluster();
    restoreJobStore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('states the schedule the module keeps, and is not switchable', () => {
    const job = jobDefinition('voice-reaper')!;
    expect(job.schedule).toEqual({ kind: 'interval', seconds: REAPER_INTERVAL_MS / 1000 });
    expect(job.switchable).toBe(false);
  });

  it('runs both sweeps each tick, never reads a mode, and records what the dead-node sweep reaped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    jobs.modes.set('voice-reaper', 'off');
    mockRedis.sMembers.mockResolvedValue(['ch-1']);
    mockRedis.get.mockResolvedValue('dead-node');
    mockGuardedReap.mockResolvedValueOnce([{ userId: 'u-1' }, { userId: 'u-2' }]).mockResolvedValue(null);
    await initVoiceCluster(createMockIO() as never);
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS);
    expect(reapOrphanedRemoteParticipants).toHaveBeenCalledTimes(1);
    expect(jobs.readMode).not.toHaveBeenCalled();
    expect(jobs.runs).toHaveLength(1);
    expect(jobs.runs[0]).toMatchObject({ job: 'voice-reaper', outcome: 'success', summary: { channelsReaped: 1, ghostUsers: 2 } });
    expect(JSON.stringify(jobs.runs)).not.toContain('ch-1');
    warnSpy.mockRestore();
  });

  it('hands the run to the orphan sweep, which counts what it ends', async () => {
    vi.mocked(reapOrphanedRemoteParticipants).mockImplementation(async (_io, run) => { run?.count('orphanedParticipants', 1); });
    await initVoiceCluster(createMockIO() as never);
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS);
    expect(jobs.runs[0].summary).toEqual({ orphanedParticipants: 1 });
  });

  it('a failing sweep is logged as before and recorded as failed; the other still runs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRedis.sMembers.mockRejectedValueOnce(new Error('redis down'));
    await initVoiceCluster(createMockIO() as never);
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS);
    expect(warnSpy).toHaveBeenCalledWith('[VoiceCluster] Dead-node voice reap failed:', expect.any(Error));
    expect(reapOrphanedRemoteParticipants).toHaveBeenCalledTimes(1);
    expect(jobs.runs[0]).toMatchObject({ outcome: 'failed', error: 'Error: redis down' });
    warnSpy.mockRestore();
  });

  it('a quiet tick after a recorded one writes nothing', async () => {
    await initVoiceCluster(createMockIO() as never);
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS * 5);
    expect(jobs.runs).toHaveLength(1);
    expect(jobs.runs[0].summary).toBeNull();
  });
});
