import { describe, it, expect, vi, beforeEach } from 'vitest';

// Server.discoveryListed is materialised from four inputs so the directory's
// listing query never joins. These pin the truth table, the per-server
// recompute and the per-owner variant (one updateMany either way).

const prismaMock = vi.hoisted(() => ({
  server: { findUnique: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

import { isDiscoveryListed, recomputeListed, recomputeListedForOwner } from '../../utils/discoveryListing';

const NOW = new Date('2026-10-09T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.server.updateMany.mockResolvedValue({ count: 1 });
});

describe('isDiscoveryListed — the truth table', () => {
  it('is true only when ALL four inputs allow it', () => {
    for (const discoverable of [true, false]) {
      for (const invitesLocked of [true, false]) {
        for (const discoveryBlockedAt of [null, NOW]) {
          for (const ownerBannedAt of [null, NOW]) {
            const expected = discoverable && !invitesLocked && discoveryBlockedAt === null && ownerBannedAt === null;
            expect(isDiscoveryListed({ discoverable, invitesLocked, discoveryBlockedAt, ownerBannedAt }))
              .toBe(expected);
          }
        }
      }
    }
  });
});

describe('recomputeListed(serverId)', () => {
  function server(overrides: Partial<{ discoverable: boolean; invitesLocked: boolean; discoveryBlockedAt: Date | null; discoveryListed: boolean; bannedAt: Date | null }> = {}) {
    const { bannedAt = null, ...rest } = overrides;
    prismaMock.server.findUnique.mockResolvedValue({
      discoverable: true, invitesLocked: false, discoveryBlockedAt: null, discoveryListed: true,
      ...rest,
      owner: { bannedAt },
    });
  }

  it('reads exactly the four inputs (plus the current value) through the owner relation', async () => {
    server();
    await recomputeListed('s-1');
    expect(prismaMock.server.findUnique).toHaveBeenCalledWith({
      where: { id: 's-1' },
      select: {
        discoverable: true, invitesLocked: true, discoveryBlockedAt: true, discoveryListed: true,
        owner: { select: { bannedAt: true } },
      },
    });
  });

  it('hides a server whose invites are locked — with the write bound to the inputs it was computed from', async () => {
    server({ invitesLocked: true, discoveryListed: true });
    await expect(recomputeListed('s-1')).resolves.toBe(false);
    // Compare-and-set: a concurrent unlock that already recomputed must not
    // be overwritten by this (now stale) answer; the where misses instead.
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', discoverable: true, invitesLocked: true, discoveryBlockedAt: null, owner: { is: { bannedAt: null } } },
      data: { discoveryListed: false },
    });
  });

  it('hides a server whose owner is platform-banned, and one an admin blocked, and one the owner unlisted', async () => {
    for (const bad of [{ bannedAt: NOW }, { discoveryBlockedAt: NOW }, { discoverable: false }]) {
      vi.clearAllMocks();
      server({ ...bad, discoveryListed: true });
      await expect(recomputeListed('s-1')).resolves.toBe(false);
      expect(prismaMock.server.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { discoveryListed: false } }));
    }
    // the banned-owner case binds the write to that very ban state
    expect(prismaMock.server.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ owner: { is: { bannedAt: NOW } } }),
    }));
    vi.clearAllMocks();
    server({ bannedAt: NOW, discoveryListed: true });
    await recomputeListed('s-1');
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', discoverable: true, invitesLocked: false, discoveryBlockedAt: null, owner: { is: { bannedAt: NOW } } },
      data: { discoveryListed: false },
    });
  });

  it('relists a server whose inputs all allow it again', async () => {
    server({ discoveryListed: false });
    await expect(recomputeListed('s-1')).resolves.toBe(true);
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', discoverable: true, invitesLocked: false, discoveryBlockedAt: null, owner: { is: { bannedAt: null } } },
      data: { discoveryListed: true },
    });
  });

  it('does not write when the column already holds the right value', async () => {
    server({ discoveryListed: true });
    await expect(recomputeListed('s-1')).resolves.toBe(true);
    expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
  });

  it('answers null and writes nothing for a server that no longer exists', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    await expect(recomputeListed('gone')).resolves.toBeNull();
    expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
  });

  it('never throws: a DB failure is logged at error level and answered with null (the nightly pass corrects drift)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.server.findUnique.mockRejectedValue(new Error('db gone'));

    await expect(recomputeListed('s-1')).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('recomputeListed(s-1) failed'), 'db gone');
    error.mockRestore();
  });
});

describe('recomputeListedForOwner(ownerId)', () => {
  it('a banned owner: ONE updateMany hides every listed server they own', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ bannedAt: NOW });
    prismaMock.server.updateMany.mockResolvedValue({ count: 3 });

    await expect(recomputeListedForOwner('o-1')).resolves.toBe(3);
    expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { ownerId: 'o-1', discoveryListed: true, owner: { is: { bannedAt: { not: null } } } },
      data: { discoveryListed: false },
    });
  });

  it('an unbanned owner: ONE updateMany relists only the servers whose per-server inputs still allow it', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ bannedAt: null });
    prismaMock.server.updateMany.mockResolvedValue({ count: 2 });

    await expect(recomputeListedForOwner('o-1')).resolves.toBe(2);
    expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: {
        ownerId: 'o-1', discoveryListed: false, discoverable: true, invitesLocked: false, discoveryBlockedAt: null,
        owner: { is: { bannedAt: null } },
      },
      data: { discoveryListed: true },
    });
  });

  it('an unknown user: null, no write', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(recomputeListedForOwner('ghost')).resolves.toBeNull();
    expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
  });

  it('never throws either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.user.findUnique.mockResolvedValue({ bannedAt: null });
    prismaMock.server.updateMany.mockRejectedValue(new Error('db gone'));

    await expect(recomputeListedForOwner('o-1')).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('recomputeListedForOwner(o-1) failed'), 'db gone');
    error.mockRestore();
  });
});
