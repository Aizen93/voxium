import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRedis, mockPublish, mockSubscribe, mockIsNodeAlive, mockCleanupServerVoice, mockReapChannelMirror } = vi.hoisted(() => ({
  mockRedis: {
    sMembers: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  },
  mockPublish: vi.fn().mockResolvedValue(1),
  mockSubscribe: vi.fn().mockResolvedValue(undefined),
  mockIsNodeAlive: vi.fn().mockResolvedValue(false),
  mockCleanupServerVoice: vi.fn(),
  mockReapChannelMirror: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
  getRedisPubSub: vi.fn().mockReturnValue({ pub: { publish: mockPublish }, sub: {} }),
  getRedisConfigSub: vi.fn().mockReturnValue({ subscribe: mockSubscribe }),
  NODE_ID: vi.fn().mockReturnValue('test-node-1'),
  isNodeAlive: mockIsNodeAlive,
}));

vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: mockCleanupServerVoice,
  reapVoiceChannelMirror: mockReapChannelMirror,
  reapOrphanedRemoteParticipants: vi.fn().mockResolvedValue(undefined),
}));

import { initVoiceCluster, stopVoiceCluster, broadcastServerVoiceCleanup, reapDeadNodeVoiceState } from '../../websocket/voiceCluster';

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
});

describe('voiceCluster — reapDeadNodeVoiceState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.sMembers.mockResolvedValue([]);
    mockRedis.get.mockResolvedValue(null);
    mockIsNodeAlive.mockResolvedValue(false);
    mockReapChannelMirror.mockResolvedValue([]);
  });

  it('reaps channels owned by dead nodes and emits voice:user_left for each ghost', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRedis.sMembers.mockResolvedValue(['ch-dead']);
    mockRedis.get.mockResolvedValue('gone-node');
    mockIsNodeAlive.mockResolvedValue(false);
    mockReapChannelMirror.mockResolvedValue(['u-1', 'u-2']);

    const io = createMockIO();
    await reapDeadNodeVoiceState(io as never);

    expect(mockReapChannelMirror).toHaveBeenCalledWith('ch-dead');
    expect(io.to).toHaveBeenCalledWith('channel:ch-dead');
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-dead', userId: 'u-1' });
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-dead', userId: 'u-2' });
    warnSpy.mockRestore();
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

    expect(mockReapChannelMirror).not.toHaveBeenCalled();
  });
});
