import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { E2E_LIMITS } from '@voxium/shared';

vi.mock('../../utils/prisma', () => ({
  prisma: {
    e2EKeyShare: { deleteMany: vi.fn() },
    e2EMasterTransfer: { deleteMany: vi.fn() },
  },
}));

import { prisma } from '../../utils/prisma';
import { runSweep, stopKeyShareCleanup } from '../../utils/keyShareCleanup';

beforeEach(() => {
  vi.clearAllMocks();
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

    expect(swept).toBe(6);
    for (const call of [
      vi.mocked(prisma.e2EKeyShare.deleteMany).mock.calls[0],
      vi.mocked(prisma.e2EMasterTransfer.deleteMany).mock.calls[0],
    ]) {
      const cutoff = (call[0] as any).where.createdAt.lt as Date;
      // exactly one retention window back, never "everything"
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(E2E_LIMITS.KEYSHARE_MAX_AGE_MS);
      expect(before - cutoff.getTime()).toBeLessThan(E2E_LIMITS.KEYSHARE_MAX_AGE_MS + 60_000);
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
