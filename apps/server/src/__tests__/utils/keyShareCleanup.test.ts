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
import { runSweep, startKeyShareCleanup, stopKeyShareCleanup, KEYSHARE_SWEEP_LOCK_KEY, KEYSHARE_SWEEP_LOCK_TTL_SECONDS } from '../../utils/keyShareCleanup';

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
  it('claims the lock with SET NX EX before deleting, and releases its own token after', async () => {
    vi.mocked(prisma.e2EKeyShare.deleteMany).mockResolvedValue({ count: 1 } as any);
    expect(await runSweep()).toBe(1);
    expect(redisSet).toHaveBeenCalledWith(
      KEYSHARE_SWEEP_LOCK_KEY,
      expect.stringMatching(/^node-under-test:[0-9a-f-]{36}$/),
      { NX: true, EX: KEYSHARE_SWEEP_LOCK_TTL_SECONDS },
    );
    expect(redisSet.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(prisma.e2EKeyShare.deleteMany).mock.invocationCallOrder[0]);
    expect(redisEval).toHaveBeenCalledWith(expect.any(String), { keys: [KEYSHARE_SWEEP_LOCK_KEY], arguments: [redisSet.mock.calls[0][1]] });
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

  it('fails closed when Redis is unreachable', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runSweep()).toBe(0);
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
