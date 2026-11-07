import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockClearPresenceState, mockRedisSet, mockRedisEval, mockIsUserOnline } = vi.hoisted(() => ({
  mockClearPresenceState: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisEval: vi.fn(),
  mockIsUserOnline: vi.fn(),
}));

// withClusterLock (utils/dailySchedule.ts) stays REAL: the lock's token, hold
// and release semantics are the rule this job must follow
vi.mock('../../utils/redis', () => ({
  clearPresenceState: mockClearPresenceState,
  isUserOnline: mockIsUserOnline,
  getRedis: () => ({ set: mockRedisSet, eval: mockRedisEval }),
  NODE_ID: () => 'node-1',
}));

import {
  reapStalePresence, startPresenceReaper, stopPresenceReaper,
  PRESENCE_REAP_INTERVAL_MS, PRESENCE_REAP_LOCK_TTL_S, PRESENCE_REAP_LOCK_KEY,
} from '../../utils/presenceReaper';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeIO() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { to, _emit: emit };
}

function makeDb() {
  return {
    user: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
    serverMember: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('presenceReaper — reapStalePresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1);
    mockIsUserOnline.mockResolvedValue(false);
    mockClearPresenceState.mockResolvedValue({ skipped: false, offlineUserIds: [] });
  });

  it('runs the SCOPED sweep (never the full wipe), demands ONE adapter snapshot and reconciles the column: this node is serving every minute', async () => {
    const io = makeIO();
    const db = makeDb();

    await reapStalePresence(io as never, db);

    expect(mockClearPresenceState).toHaveBeenCalledWith(db, io, { allowFullWipe: false, requireSnapshot: true, reconcileColumn: true });
  });

  it('a reaped user who registered a new socket by the time their turn to be announced comes is NOT announced offline', async () => {
    // A large batch takes a while to announce (two DB reads per user); an
    // offline landing after the user's own online would be the last word on
    // every client
    mockClearPresenceState.mockResolvedValueOnce({ skipped: false, offlineUserIds: ['u-back', 'u-gone'] });
    mockIsUserOnline.mockImplementation(async (id: string) => id === 'u-back');
    const io = makeIO();
    const db = makeDb();
    db.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await reapStalePresence(io as never, db);

    expect(io._emit).toHaveBeenCalledTimes(1);
    expect(io._emit).toHaveBeenCalledWith('presence:update', { userId: 'u-gone', status: 'offline' });
    // Checked AFTER the room reads, as late as it can be
    expect(db.serverMember.findMany.mock.invocationCallOrder[0]).toBeLessThan(mockIsUserOnline.mock.invocationCallOrder[0]);
    warn.mockRestore();
  });

  it('takes the shared cluster lock with a per-acquisition token, and sweeps nothing when another node holds it', async () => {
    // Every node runs the interval; one sweep per tick is enough and the
    // socket:users hash is read whole each time
    mockRedisSet.mockResolvedValueOnce(null);
    const io = makeIO();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const reaped = await reapStalePresence(io as never, makeDb());

    expect(mockRedisSet).toHaveBeenCalledWith(PRESENCE_REAP_LOCK_KEY, expect.stringMatching(/^node-1:/), { NX: true, EX: PRESENCE_REAP_LOCK_TTL_S });
    expect(mockClearPresenceState).not.toHaveBeenCalled();
    expect(reaped).toBe(0);
    log.mockRestore();
  });

  it('HOLDS the lock after a successful sweep (never released: the TTL is the exclusivity window)', async () => {
    await reapStalePresence(makeIO() as never, makeDb());

    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  it('the hold expires before the next tick, so a crashed holder cannot stall the sweep for good', () => {
    expect(PRESENCE_REAP_LOCK_TTL_S * 1000).toBeLessThan(PRESENCE_REAP_INTERVAL_MS);
  });

  it('releases the lock (if still its own) when the sweep throws, so the next attempt is not blocked', async () => {
    mockClearPresenceState.mockRejectedValueOnce(new Error('redis down'));

    await expect(reapStalePresence(makeIO() as never, makeDb())).rejects.toThrow('redis down');

    // Compare-and-delete on the token this run wrote
    const owner = mockRedisSet.mock.calls[0][1] as string;
    expect(mockRedisEval).toHaveBeenCalledWith(expect.stringContaining('del'), { keys: [PRESENCE_REAP_LOCK_KEY], arguments: [owner] });
  });

  it('fails CLOSED when Redis cannot answer the lock: no sweep, nothing reaped', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reaped = await reapStalePresence(makeIO() as never, makeDb());

    expect(reaped).toBe(0);
    expect(mockClearPresenceState).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('tells every server and DM room of a reaped user that they are offline, and reports the count', async () => {
    mockClearPresenceState.mockResolvedValueOnce({ skipped: false, offlineUserIds: ['u-ghost'] });
    const io = makeIO();
    const db = makeDb();
    db.serverMember.findMany.mockResolvedValueOnce([{ serverId: 'srv-1' }, { serverId: 'srv-2' }]);
    db.conversation.findMany.mockResolvedValueOnce([{ id: 'conv-1' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reaped = await reapStalePresence(io as never, db);

    expect(reaped).toBe(1);
    expect(db.serverMember.findMany).toHaveBeenCalledWith({ where: { userId: 'u-ghost' }, select: { serverId: true } });
    expect(db.conversation.findMany).toHaveBeenCalledWith({
      where: { OR: [{ user1Id: 'u-ghost' }, { user2Id: 'u-ghost' }] },
      select: { id: true },
    });
    expect(io.to).toHaveBeenCalledWith('server:srv-1');
    expect(io.to).toHaveBeenCalledWith('server:srv-2');
    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledTimes(3);
    for (const call of io._emit.mock.calls) {
      expect(call).toEqual(['presence:update', { userId: 'u-ghost', status: 'offline' }]);
    }
    warn.mockRestore();
  });

  it('broadcasts nothing when the sweep was refused (a partial cluster snapshot) or found nothing', async () => {
    const io = makeIO();

    mockClearPresenceState.mockResolvedValueOnce({ skipped: true, offlineUserIds: [] });
    expect(await reapStalePresence(io as never, makeDb())).toBe(0);

    mockClearPresenceState.mockResolvedValueOnce({ skipped: false, offlineUserIds: [] });
    expect(await reapStalePresence(io as never, makeDb())).toBe(0);

    expect(io.to).not.toHaveBeenCalled();
  });

  it('one user whose rooms cannot be read does not cost the next one its broadcast', async () => {
    mockClearPresenceState.mockResolvedValueOnce({ skipped: false, offlineUserIds: ['u-a', 'u-b'] });
    const io = makeIO();
    const db = makeDb();
    db.serverMember.findMany
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce([{ serverId: 'srv-b' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reaped = await reapStalePresence(io as never, db);

    expect(reaped).toBe(2);
    expect(io.to).toHaveBeenCalledWith('server:srv-b');
    expect(io._emit).toHaveBeenCalledWith('presence:update', { userId: 'u-b', status: 'offline' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('u-a'), 'db hiccup');
    warn.mockRestore();
  });
});

describe('presenceReaper — interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1);
    mockIsUserOnline.mockResolvedValue(false);
    mockClearPresenceState.mockResolvedValue({ skipped: false, offlineUserIds: [] });
  });

  afterEach(() => {
    stopPresenceReaper();
    vi.useRealTimers();
  });

  it('sweeps once per interval and stops when told to', async () => {
    startPresenceReaper(makeIO() as never, makeDb());

    await vi.advanceTimersByTimeAsync(PRESENCE_REAP_INTERVAL_MS);
    expect(mockClearPresenceState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PRESENCE_REAP_INTERVAL_MS);
    expect(mockClearPresenceState).toHaveBeenCalledTimes(2);

    stopPresenceReaper();
    await vi.advanceTimersByTimeAsync(PRESENCE_REAP_INTERVAL_MS * 3);
    expect(mockClearPresenceState).toHaveBeenCalledTimes(2);
  });

  it('a failing sweep is logged and the interval keeps going', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockClearPresenceState.mockRejectedValueOnce(new Error('redis down'));
    startPresenceReaper(makeIO() as never, makeDb());

    await vi.advanceTimersByTimeAsync(PRESENCE_REAP_INTERVAL_MS);
    expect(warn).toHaveBeenCalledWith('[Presence] Stale presence reap failed:', 'redis down');

    await vi.advanceTimersByTimeAsync(PRESENCE_REAP_INTERVAL_MS);
    expect(mockClearPresenceState).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
