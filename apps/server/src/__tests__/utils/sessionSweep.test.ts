import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The statements are mocked (their SQL: sessionStore.test.ts, and the runs
// against a real PostgreSQL 16 recorded there); the lock is the real
// withClusterLock over a mocked Redis. The typed read the version check
// makes is the mocked prisma.session.findMany.
const store = vi.hoisted(() => ({
  countSweepableSessions: vi.fn(),
  sampleExpiredSessions: vi.fn(),
  sampleOutdatedSessions: vi.fn(),
  deleteSweepableSessions: vi.fn(),
  sampleExpiredLegacyRedemptions: vi.fn(),
  deleteExpiredLegacyRedemptions: vi.fn(),
  SWEEP_BATCH_SIZE: 5000,
  SWEEP_MARGIN_SECONDS: 3600,
}));
vi.mock('../../utils/sessionStore', () => store);

const db = vi.hoisted(() => ({ session: { findMany: vi.fn() } }));
vi.mock('../../utils/prisma', () => ({ prisma: db }));

const disconnect = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sessionRevocation', () => ({ disconnectSessionRooms: (...a: unknown[]) => disconnect(...a) }));

const redisSet = vi.fn();
const redisEval = vi.fn();
vi.mock('../../utils/redis', () => ({
  NODE_ID: () => 'node-under-test',
  getRedis: () => ({ set: redisSet, eval: redisEval }),
}));

import {
  runSessionSweep, sweepSessions, startSessionSweep, stopSessionSweep, firstSweepDelayMs,
  SESSION_SWEEP_LOCK_KEY, SESSION_SWEEP_LOCK_TTL_SECONDS, SESSION_SWEEP_RETRY_MS,
  SESSION_SWEEP_MAX_FRACTION, SESSION_SWEEP_FRACTION_FLOOR, SESSION_SWEEP_MAX_BATCHES, SESSION_SWEEP_SAMPLE_SIZE,
  SESSION_SWEEP_FIRST_DELAY_MS, SESSION_SWEEP_FIRST_JITTER_MS, SWEEP_STATEMENTS,
} from '../../utils/sessionSweep';
import { prisma } from '../../utils/prisma';

const nowS = () => Math.floor(Date.now() / 1000);
const counts = (over: Partial<{ expired: number; outdated: number; due: number; total: number }> = {}) => {
  const c = { expired: 0, outdated: 0, total: 100, ...over };
  return { ...c, due: over.due ?? c.expired + c.outdated };
};
/** `n` ids and the batch the delete would return for them. */
const ids = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
/** The typed read of sampled sessions: each strictly below its account's version unless listed in `live`. */
function typedRead(live: string[] = []) {
  db.session.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({ tokenVersion: live.includes(id) ? 4 : 3, user: { tokenVersion: 4 } })));
}

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue('OK');
  redisEval.mockResolvedValue(1);
  store.countSweepableSessions.mockResolvedValue(counts());
  store.sampleExpiredSessions.mockResolvedValue([]);
  store.sampleOutdatedSessions.mockResolvedValue([]);
  store.deleteSweepableSessions.mockResolvedValue([]);
  store.sampleExpiredLegacyRedemptions.mockResolvedValue([]);
  store.deleteExpiredLegacyRedemptions.mockResolvedValue(0);
  typedRead();
});

afterEach(() => {
  stopSessionSweep();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session sweep — what it deletes', () => {
  it('the sessions past their expiry or below their account\'s version, in batches until one is short, each batch\'s sockets ended; then the redemption records', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ expired: 9000, outdated: 3000, total: 30_000 }));
    store.sampleExpiredSessions.mockResolvedValue([nowS() - 4000, nowS() - 90_000]);
    store.sampleOutdatedSessions.mockResolvedValue(['o1', 'o2']);
    const b1 = ids(5000, 'a'); const b2 = ids(5000, 'b'); const b3 = ids(2000, 'c');
    store.deleteSweepableSessions.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2).mockResolvedValueOnce(b3);
    store.sampleExpiredLegacyRedemptions.mockResolvedValue([nowS() - 4000]);
    store.deleteExpiredLegacyRedemptions.mockResolvedValueOnce(5000).mockResolvedValueOnce(7);

    await expect(sweepSessions()).resolves.toEqual({ sessions: 12_000, redemptions: 5007 });

    expect(store.deleteSweepableSessions).toHaveBeenCalledTimes(3);
    expect(store.deleteExpiredLegacyRedemptions).toHaveBeenCalledTimes(2);
    for (const fn of [store.countSweepableSessions, store.deleteSweepableSessions, store.deleteExpiredLegacyRedemptions]) {
      expect(fn).toHaveBeenCalledWith(prisma);
    }
    // After each batch, that batch's sockets: never a batch it did not delete
    expect(disconnect.mock.calls).toEqual([[b1], [b2], [b3]]);
    expect(disconnect.mock.invocationCallOrder[0]).toBeGreaterThan(store.deleteSweepableSessions.mock.invocationCallOrder[0]);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(store.deleteSweepableSessions.mock.invocationCallOrder[1]);
    // Every check reads before the first delete of either table
    const firstDelete = Math.min(store.deleteSweepableSessions.mock.invocationCallOrder[0], store.deleteExpiredLegacyRedemptions.mock.invocationCallOrder[0]);
    for (const fn of [store.countSweepableSessions, store.sampleExpiredSessions, store.sampleOutdatedSessions, db.session.findMany, store.sampleExpiredLegacyRedemptions]) {
      expect(fn.mock.invocationCallOrder[0]).toBeLessThan(firstDelete);
    }
    expect(log).toHaveBeenCalledWith('[Sessions] Swept 12000 ended session(s) and 5007 expired redemption record(s)');
  });

  it('nothing due: no session sample, no delete statement for the sessions, the redemption records still swept (their own check first)', async () => {
    await expect(sweepSessions()).resolves.toEqual({ sessions: 0, redemptions: 0 });
    expect(store.sampleExpiredSessions).not.toHaveBeenCalled();
    expect(store.sampleOutdatedSessions).not.toHaveBeenCalled();
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
    expect(store.sampleExpiredLegacyRedemptions).toHaveBeenCalledWith(prisma, SESSION_SWEEP_SAMPLE_SIZE);
    expect(store.deleteExpiredLegacyRedemptions).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('only expired rows: no version sample; only outdated rows: no clock sample of sessions', async () => {
    store.countSweepableSessions.mockResolvedValueOnce(counts({ expired: 3 }));
    store.sampleExpiredSessions.mockResolvedValue([nowS() - 4000]);
    await sweepSessions();
    expect(store.sampleOutdatedSessions).not.toHaveBeenCalled();
    expect(db.session.findMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    typedRead();
    store.countSweepableSessions.mockResolvedValueOnce(counts({ outdated: 3 }));
    store.sampleOutdatedSessions.mockResolvedValue(['o1']);
    store.deleteSweepableSessions.mockResolvedValue([]);
    store.sampleExpiredLegacyRedemptions.mockResolvedValue([]);
    store.deleteExpiredLegacyRedemptions.mockResolvedValue(0);
    await sweepSessions();
    expect(store.sampleExpiredSessions).not.toHaveBeenCalled();
    expect(db.session.findMany).toHaveBeenCalledTimes(1);
  });

  it('stops after SESSION_SWEEP_MAX_BATCHES even if every batch comes back full', async () => {
    store.countSweepableSessions.mockResolvedValue(counts({ expired: 2_000_000, total: 10_000_000 }));
    store.deleteSweepableSessions.mockResolvedValue(ids(5000));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await sweepSessions();
    expect(store.deleteSweepableSessions).toHaveBeenCalledTimes(SESSION_SWEEP_MAX_BATCHES);
  });
});

describe('session sweep — the guards against a wrong comparison', () => {
  it('a sampled expired row not past its expiry on this node\'s clock refuses the WHOLE run: no session and no redemption record deleted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ expired: 3, outdated: 2 }));
    // the first is still live by this node's clock: the comparison is wrong
    store.sampleExpiredSessions.mockResolvedValue([nowS() + 600, nowS() - 7200]);
    store.sampleExpiredLegacyRedemptions.mockResolvedValue([nowS() - 7200]);

    await expect(sweepSessions()).resolves.toEqual({ sessions: 0, redemptions: 0, refused: 'sample-mismatch', mismatch: 'expiry' });

    expect(store.sampleExpiredSessions).toHaveBeenCalledWith(prisma, SESSION_SWEEP_SAMPLE_SIZE);
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
    expect(store.deleteExpiredLegacyRedemptions).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "[Sessions] Session sweep refused: 1 of 2 sampled sessions it would delete as expired are not past their expiry on this node's clock. "
      + 'Nothing was deleted (5 of 100 sessions due); the renewal still refuses every expired or outdated session.',
    );
  });

  it('a sampled outdated row that a separate typed read finds NOT below its account\'s version refuses the whole run (a wrong version predicate)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ outdated: 40 }));
    // A store double whose predicate also took equal versions: its sample, nearest first, is live rows
    store.sampleOutdatedSessions.mockResolvedValue(['live-1', 'dead-1', 'live-2']);
    typedRead(['live-1', 'live-2']);

    await expect(sweepSessions()).resolves.toMatchObject({ refused: 'sample-mismatch', mismatch: 'version', sessions: 0, redemptions: 0 });

    // The check is a read of its own through the typed client, of exactly the sampled ids
    expect(db.session.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['live-1', 'dead-1', 'live-2'] } },
      select: { tokenVersion: true, user: { select: { tokenVersion: true } } },
    });
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
    expect(store.deleteExpiredLegacyRedemptions).not.toHaveBeenCalled();
    const line = error.mock.calls[0][0] as string;
    expect(line).toContain("2 of 3 sampled sessions it would delete as below their account's version are not, by a separate read");
    // No id in the log
    expect(line).not.toMatch(/live-|dead-/);
  });

  it('the statements are a parameter (a run against a real database is given a wrong one): a run uses the set it is given and no other', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrongSample = vi.fn().mockResolvedValue(['live-1']);
    const st = { ...SWEEP_STATEMENTS, countSweepableSessions: vi.fn().mockResolvedValue(counts({ outdated: 1 })), sampleOutdatedSessions: wrongSample };
    typedRead(['live-1']);
    await expect(sweepSessions(st)).resolves.toMatchObject({ mismatch: 'version' });
    expect(wrongSample).toHaveBeenCalled();
    expect(store.countSweepableSessions).not.toHaveBeenCalled();
    expect(store.sampleOutdatedSessions).not.toHaveBeenCalled();
    // The default set is the store's own statements
    expect(SWEEP_STATEMENTS.deleteSweepableSessions).toBe(store.deleteSweepableSessions);
  });

  it('every run, whatever the backlog, the version check takes the nearest sample AND one drawn at random over every candidate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ outdated: 3, total: 10_000 }));
    store.sampleOutdatedSessions.mockResolvedValueOnce(['o1', 'o2', 'o3']).mockResolvedValueOnce(['o3', 'o1']);
    store.deleteSweepableSessions.mockResolvedValueOnce(['o1', 'o2', 'o3']);

    await expect(sweepSessions()).resolves.toEqual({ sessions: 3, redemptions: 0 });

    expect(store.sampleOutdatedSessions.mock.calls).toEqual([[prisma, SESSION_SWEEP_SAMPLE_SIZE], [prisma, SESSION_SWEEP_SAMPLE_SIZE, true]]);
    // Both read before the delete, in one typed read of the distinct ids
    expect(store.sampleOutdatedSessions.mock.invocationCallOrder[1]).toBeLessThan(store.deleteSweepableSessions.mock.invocationCallOrder[0]);
    expect(db.session.findMany).toHaveBeenCalledTimes(1);
    expect(db.session.findMany.mock.calls[0][0].where.id.in).toEqual(['o1', 'o2', 'o3']);
    // A small backlog: no warning, and the expiry check is not widened
    expect(warn).not.toHaveBeenCalled();
    expect(store.sampleExpiredSessions).not.toHaveBeenCalled();
  });

  it('a version predicate joined to the wrong account, over a SMALL backlog: its nearest candidates are all outdated, the random sample meets the live rows it also picks, and the whole run is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 400 candidates of 10,000 sessions: more than one sample, far below
    // the "large" share
    store.countSweepableSessions.mockResolvedValue(counts({ outdated: 400, total: 10_000 }));
    const dead = ids(SESSION_SWEEP_SAMPLE_SIZE, 'dead-');
    const spread = [...ids(80, 'dead-'), ...ids(20, 'live-')];
    store.sampleOutdatedSessions.mockImplementation(async (_db: unknown, _limit: number, isSpread?: boolean) => (isSpread ? spread : dead));
    typedRead(ids(20, 'live-'));

    await expect(sweepSessions()).resolves.toEqual({ sessions: 0, redemptions: 0, refused: 'sample-mismatch', mismatch: 'version' });

    expect(warn).not.toHaveBeenCalled();
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
    expect(store.deleteExpiredLegacyRedemptions).not.toHaveBeenCalled();
    const line = error.mock.calls[0][0] as string;
    expect(line).toContain(`20 of ${SESSION_SWEEP_SAMPLE_SIZE + 20} sampled sessions it would delete as below their account's version are not`);
    expect(line).not.toMatch(/live-|dead-/);
  });

  it('a sampled row gone between the sample and the typed read is no disagreement', async () => {
    store.countSweepableSessions.mockResolvedValue(counts({ outdated: 2 }));
    store.sampleOutdatedSessions.mockResolvedValue(['gone', 'dead']);
    db.session.findMany.mockResolvedValue([{ tokenVersion: 1, user: { tokenVersion: 2 } }]);
    store.deleteSweepableSessions.mockResolvedValueOnce(['dead']);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(sweepSessions()).resolves.toEqual({ sessions: 1, redemptions: 0 });
  });

  it('a sampled redemption record not past its token\'s expiry on this node\'s clock refuses the whole run, sessions included', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ outdated: 2 }));
    store.sampleOutdatedSessions.mockResolvedValue(['o1']);
    store.sampleExpiredLegacyRedemptions.mockResolvedValue([nowS() + 1800]);

    await expect(sweepSessions()).resolves.toMatchObject({ refused: 'sample-mismatch', mismatch: 'redemption-expiry' });
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
    expect(store.deleteExpiredLegacyRedemptions).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain("sampled redemption records it would delete as expired are not past their token's expiry on this node's clock");
  });

  it('a node clock two hours behind the database\'s: the rows the database calls an hour past expiry are ahead of it, so everything is refused', async () => {
    vi.useFakeTimers();
    const dbNow = Date.UTC(2026, 10, 20, 12, 0, 0);
    vi.setSystemTime(dbNow - 2 * 3600_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ expired: 50 }));
    const boundary = dbNow / 1000 - 3600 - 1;
    store.sampleExpiredSessions.mockResolvedValue([boundary, boundary - 60]);
    store.sampleExpiredLegacyRedemptions.mockResolvedValue([boundary]);
    await expect(sweepSessions()).resolves.toMatchObject({ refused: 'sample-mismatch', mismatch: 'expiry' });
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
    expect(store.deleteExpiredLegacyRedemptions).not.toHaveBeenCalled();
  });

  it('a node clock behind by less than the margin agrees, and the run sweeps', async () => {
    vi.useFakeTimers();
    const dbNow = Date.UTC(2026, 10, 20, 12, 0, 0);
    vi.setSystemTime(dbNow - 30 * 60_000);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ expired: 2 }));
    store.sampleExpiredSessions.mockResolvedValue([dbNow / 1000 - 3601]);
    store.deleteSweepableSessions.mockResolvedValueOnce(['a', 'b']);
    await expect(sweepSessions()).resolves.toEqual({ sessions: 2, redemptions: 0 });
  });

  it('more than half due (and more than the floor): ONE warning with the counts, a wider sample of each kind, then it sweeps; the proportion refuses nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue({ expired: 1400, outdated: 120, due: 1500, total: 1600 });
    store.sampleExpiredSessions.mockResolvedValue([nowS() - 4000]);
    store.sampleOutdatedSessions.mockResolvedValueOnce(['o1', 'o2']).mockResolvedValueOnce(['o2', 'o3']);
    store.deleteSweepableSessions.mockResolvedValueOnce(ids(1500));

    await expect(sweepSessions()).resolves.toEqual({ sessions: 1500, redemptions: 0 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[Sessions] Session sweep: 1500 of 1600 sessions are due (1400 expired, 120 below their account's version), more than 50%; "
      + 'a sample of each kind spread over all its candidates is checked before they are deleted.',
    );
    // Nearest the boundary AND spread over every candidate, for each kind
    expect(store.sampleExpiredSessions.mock.calls).toEqual([[prisma, SESSION_SWEEP_SAMPLE_SIZE], [prisma, SESSION_SWEEP_SAMPLE_SIZE, true]]);
    expect(store.sampleOutdatedSessions.mock.calls).toEqual([[prisma, SESSION_SWEEP_SAMPLE_SIZE], [prisma, SESSION_SWEEP_SAMPLE_SIZE, true]]);
    // One typed read of the distinct sampled ids
    expect(db.session.findMany.mock.calls[0][0].where.id.in).toEqual(['o1', 'o2', 'o3']);
  });

  it('a table 95% due sweeps (the run never locks itself in), and a mismatch in the WIDER sample still refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue({ expired: 9500, outdated: 0, due: 9500, total: 10_000 });
    store.sampleExpiredSessions.mockResolvedValue([nowS() - 4000]);
    store.deleteSweepableSessions.mockResolvedValueOnce(ids(5000)).mockResolvedValueOnce(ids(4500));
    await expect(sweepSessions()).resolves.toEqual({ sessions: 9500, redemptions: 0 });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.deleteSweepableSessions.mockClear();
    store.sampleExpiredSessions.mockReset()
      .mockResolvedValueOnce([nowS() - 4000])
      .mockResolvedValueOnce([nowS() - 4000, nowS() + 86_400]);
    await expect(sweepSessions()).resolves.toMatchObject({ refused: 'sample-mismatch', mismatch: 'expiry' });
    expect(store.deleteSweepableSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['at most half', { expired: 2000, outdated: 0, due: 2000, total: 4000 }],
    ['more than half but not more than the floor', { expired: SESSION_SWEEP_FRACTION_FLOOR, outdated: 0, due: SESSION_SWEEP_FRACTION_FLOOR, total: SESSION_SWEEP_FRACTION_FLOOR + 1 }],
  ])('%s: no warning, the nearest expiry sample only, deleted', async (_what, c) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(c);
    store.sampleExpiredSessions.mockResolvedValue([nowS() - 4000]);
    store.deleteSweepableSessions.mockResolvedValueOnce(ids(c.due));
    await expect(sweepSessions()).resolves.toMatchObject({ sessions: c.due });
    expect(warn).not.toHaveBeenCalled();
    expect(store.sampleExpiredSessions).toHaveBeenCalledTimes(1);
    expect(SESSION_SWEEP_MAX_FRACTION).toBe(0.5);
  });
});

describe('session sweep — once per cluster, under its lock', () => {
  it('claims the lock with SET NX EX and a per-acquisition token before reading anything, and HOLDS it after a success', async () => {
    store.countSweepableSessions.mockResolvedValue(counts({ outdated: 1 }));
    store.sampleOutdatedSessions.mockResolvedValue(['o']);
    store.deleteSweepableSessions.mockResolvedValueOnce(['o']);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runSessionSweep()).resolves.toEqual({ sessions: 1, redemptions: 0 });

    expect(redisSet).toHaveBeenCalledWith(SESSION_SWEEP_LOCK_KEY, expect.stringMatching(/^node-under-test:[0-9a-f-]{36}$/), { NX: true, EX: SESSION_SWEEP_LOCK_TTL_SECONDS });
    expect(redisSet.mock.invocationCallOrder[0]).toBeLessThan(store.countSweepableSessions.mock.invocationCallOrder[0]);
    // Held (not released): the other nodes' timers skip this slot
    expect(redisEval).not.toHaveBeenCalled();
    expect(SESSION_SWEEP_LOCK_KEY).toBe('lock:sessionsweep');
    expect(SESSION_SWEEP_LOCK_TTL_SECONDS).toBe(5 * 60 * 60);
  });

  it('another node holds the lock: nothing read, nothing deleted', async () => {
    redisSet.mockResolvedValue(null);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runSessionSweep()).resolves.toBeNull();
    expect(store.countSweepableSessions).not.toHaveBeenCalled();
    expect(store.deleteExpiredLegacyRedemptions).not.toHaveBeenCalled();
  });

  it('a refused run is a completed run: the lock is held for its TTL like a success, so the error line repeats at the interval, not at every node\'s timer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.countSweepableSessions.mockResolvedValue(counts({ expired: 1 }));
    store.sampleExpiredSessions.mockResolvedValue([nowS() + 600]);
    await expect(runSessionSweep()).resolves.toMatchObject({ refused: 'sample-mismatch' });
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('Redis unreachable: fails CLOSED (nothing deleted) and retries in 15 minutes, not 6 hours', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    startSessionSweep();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_FIRST_DELAY_MS);
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(store.countSweepableSessions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_RETRY_MS);
    expect(redisSet).toHaveBeenCalledTimes(2);
    expect(SESSION_SWEEP_RETRY_MS).toBe(15 * 60 * 1000);
  });

  it('a failed run is logged, releases the lock for the next attempt, never throws, and the timer is re-armed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.countSweepableSessions.mockRejectedValueOnce(new Error('db down'));
    await expect(runSessionSweep()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith('[Sessions] Session sweep failed:', 'db down');
    expect(redisEval).toHaveBeenCalledTimes(1);
  });

  it('the first run comes a few minutes after start (a fixed delay plus jitter), then every 6 hours', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = SESSION_SWEEP_FIRST_DELAY_MS + SESSION_SWEEP_FIRST_JITTER_MS / 2;
    startSessionSweep();
    await vi.advanceTimersByTimeAsync(first - 1);
    expect(redisSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(redisSet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1);
    expect(redisSet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(redisSet).toHaveBeenCalledTimes(2);
    stopSessionSweep();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(redisSet).toHaveBeenCalledTimes(2);
  });

  it('firstSweepDelayMs: five minutes, plus up to five more', () => {
    expect(SESSION_SWEEP_FIRST_DELAY_MS).toBe(5 * 60 * 1000);
    expect(SESSION_SWEEP_FIRST_JITTER_MS).toBe(5 * 60 * 1000);
    expect(firstSweepDelayMs(() => 0)).toBe(5 * 60 * 1000);
    expect(firstSweepDelayMs(() => 0.999999)).toBeLessThan(10 * 60 * 1000);
    expect(firstSweepDelayMs(() => 0.999999)).toBeGreaterThan(9 * 60 * 1000);
  });

  it('startSessionSweep twice arms one timer', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    startSessionSweep();
    startSessionSweep();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_FIRST_DELAY_MS);
    expect(redisSet).toHaveBeenCalledTimes(1);
  });
});
