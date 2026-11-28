import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { E2E_LIMITS } from '@voxium/shared';

vi.mock('../../utils/prisma', () => ({
  prisma: {
    e2EKeyShare: { deleteMany: vi.fn() },
    e2EMasterTransfer: { deleteMany: vi.fn() },
  },
}));

const redisSet = vi.fn();
const redisEval = vi.fn();
vi.mock('../../utils/redis', () => ({
  NODE_ID: () => 'node-under-test',
  getRedis: () => ({ set: redisSet, eval: redisEval }),
}));

import { prisma } from '../../utils/prisma';
import { runSweep, startKeyShareCleanup, stopKeyShareCleanup, KEYSHARE_SWEEP_LOCK_KEY, KEYSHARE_SWEEP_LOCK_TTL_SECONDS, KEYSHARE_SWEEP_RETRY_MS } from '../../utils/keyShareCleanup';
import { SWEEP_INTERVAL_MS } from '../../utils/keyShareCleanup';
import { jobDefinition } from '../../utils/jobs';
import { useFakeJobStore, restoreJobStore, type FakeJobStore } from '../helpers/jobStoreFake';

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue('OK');
  redisEval.mockResolvedValue(1);
  vi.mocked(prisma.e2EKeyShare.deleteMany).mockResolvedValue({ count: 0 } as any);
  vi.mocked(prisma.e2EMasterTransfer.deleteMany).mockResolvedValue({ count: 0 } as any);
});

afterEach(() => {
  // runSweep always re-arms its timer; keep test runs from holding one open
  stopKeyShareCleanup();
});

describe('E2E retention sweep', () => {
  it('deletes key shares AND master transfers older than the retention window', async () => {
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockResolvedValue({ count: 4 } as any);
    vi.mocked(prisma.e2EMasterTransfer.deleteMany).mockResolvedValue({ count: 2 } as any);

    const before = Date.now();
    const swept = await runSweep();
    const after = Date.now();

    expect(swept).toBe(6);
    for (const call of [
      vi.mocked(prisma.e2EKeyShare.deleteMany).mock.calls[0],
      vi.mocked(prisma.e2EMasterTransfer.deleteMany).mock.calls[0],
    ]) {
      const cutoff = (call[0] as any).where.createdAt.lt as Date;
      // Exactly one retention window back from the moment the sweep ran, never
      // "everything". Bracketed by the real elapsed window rather than measured
      // from `before` alone: the sweep reads its own Date.now() a moment later,
      // so any elapsed millisecond made the old lower bound fail (flaked under
      // full-suite load, passed in isolation).
      const sweptAt = cutoff.getTime() + E2E_LIMITS.KEYSHARE_MAX_AGE_MS;
      expect(sweptAt).toBeGreaterThanOrEqual(before);
      expect(sweptAt).toBeLessThanOrEqual(after);
    }
  });

  it('reports 0 and never throws when a sweep fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockRejectedValue(new Error('db down'));

    await expect(runSweep()).resolves.toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// Every node fires the 6-hourly interval; unlocked, each ran its own scan.
describe('E2E retention sweep — cluster lock', () => {
  it('claims the lock with SET NX EX before deleting, and HOLDS it for most of the interval', async () => {
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockResolvedValue({ count: 1 } as any);
    expect(await runSweep()).toBe(1);
    expect(redisSet).toHaveBeenCalledWith(
      KEYSHARE_SWEEP_LOCK_KEY,
      expect.stringMatching(/^node-under-test:[0-9a-f-]{36}$/),
      { NX: true, EX: KEYSHARE_SWEEP_LOCK_TTL_SECONDS },
    );
    expect(redisSet.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(prisma.e2EKeyShare.deleteMany).mock.invocationCallOrder[0]);
    // Not released: nodes run this interval on their OWN boot clocks and would
    // never contend for a lock released on completion — each would still sweep
    // every 6 h. Held for 5 h (< the 6 h interval) → once per ≥ 5 h cluster-wide.
    expect(redisEval).not.toHaveBeenCalled();
    expect(KEYSHARE_SWEEP_LOCK_TTL_SECONDS * 1000).toBeLessThan(6 * 60 * 60 * 1000);
    expect(KEYSHARE_SWEEP_LOCK_TTL_SECONDS).toBeGreaterThanOrEqual(4 * 60 * 60);
  });

  it('a sweep that throws releases the lock, logs, returns 0 and re-arms', async () => {
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runSweep()).toBe(0);
    expect(redisEval).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[E2E] Key-share sweep failed:', 'db down');
    error.mockRestore();
  });

  it('a sweep that THROWS still re-arms its timer at the interval', async () => {
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    startKeyShareCleanup();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    expect(await runSweep()).toBe(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toBe(SWEEP_INTERVAL_MS);
    setTimeoutSpy.mockRestore();
    error.mockRestore();
  });

  it('a node that loses the race deletes nothing and reports 0 — but still re-arms its timer', async () => {
    redisSet.mockResolvedValue(null);
    startKeyShareCleanup(); // arm the scheduler; a stopped scheduler never re-arms
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    expect(await runSweep()).toBe(0);
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
    expect(prisma.e2EMasterTransfer.deleteMany).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockRestore();
  });

  it('fails closed when Redis is unreachable — and re-arms in 15 minutes, not 6 hours', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    startKeyShareCleanup();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    expect(await runSweep()).toBe(0);
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toBe(KEYSHARE_SWEEP_RETRY_MS);
    setTimeoutSpy.mockRestore();
    error.mockRestore();
  });
});

// The sweep goes through the job registry's wrapper (utils/jobs.ts), around
// the lock: switched off it claims nothing and deletes nothing, and a run
// hands its counts over.
describe('E2E retention sweep — the job registry', () => {
  let store: FakeJobStore;
  beforeEach(() => { store = useFakeJobStore(); });
  afterEach(() => { restoreJobStore(); });

  it('states the schedule the module keeps: every 6 hours', () => {
    expect(jobDefinition('key-share-sweep')!.schedule).toEqual({ kind: 'interval', seconds: SWEEP_INTERVAL_MS / 1000 });
  });

  it('records a success with the two counts it swept', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockResolvedValue({ count: 4 } as any);
    vi.mocked(prisma.e2EMasterTransfer.deleteMany).mockResolvedValue({ count: 2 } as any);
    expect(await runSweep()).toBe(6);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ job: 'key-share-sweep', outcome: 'success', summary: { keyShares: 4, masterTransfers: 2 }, error: null });
    vi.restoreAllMocks();
  });

  it('switched off, claims no lock, deletes nothing, records nothing, answers 0 and re-arms at its interval', async () => {
    store.modes.set('key-share-sweep', 'off');
    startKeyShareCleanup();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    expect(await runSweep()).toBe(0);
    expect(redisSet).not.toHaveBeenCalled();
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(0);
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toContain(SWEEP_INTERVAL_MS);
    setTimeoutSpy.mockRestore();
  });

  it('a mode that cannot be read skips the tick (no lock, no delete), records the skip, and still re-arms at its interval', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.readMode.mockRejectedValue(new Error('connection terminated'));
    startKeyShareCleanup();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    expect(await runSweep()).toBe(0);
    expect(redisSet).not.toHaveBeenCalled();
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'mode-unreadable' });
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toContain(SWEEP_INTERVAL_MS);
    setTimeoutSpy.mockRestore();
    error.mockRestore();
  });

  it('a failed sweep is recorded as failed and still logged as before; a lost lock is not recorded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockRejectedValue(new Error('db down'));
    expect(await runSweep()).toBe(0);
    expect(error).toHaveBeenCalledWith('[E2E] Key-share sweep failed:', 'db down');
    expect(store.runs[0]).toMatchObject({ outcome: 'failed', error: 'Error: db down' });

    redisSet.mockResolvedValue(null);
    expect(await runSweep()).toBe(0);
    expect(store.runs).toHaveLength(1);
    error.mockRestore();
  });
});
