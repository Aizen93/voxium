import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../utils/prisma', () => ({
  prisma: {
    e2EKeyShare: { deleteMany: vi.fn() },
    e2EMasterTransfer: { deleteMany: vi.fn() },
    e2EMasterKey: { deleteMany: vi.fn() },
    e2EDeviceRegistry: { deleteMany: vi.fn() },
    e2EDevice: { deleteMany: vi.fn() },
  },
}));

import { prisma } from '../../utils/prisma';
import { purgeE2EMaterial } from '../../utils/e2ePurge';

const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of [
    prisma.e2EKeyShare,
    prisma.e2EMasterTransfer,
    prisma.e2EMasterKey,
    prisma.e2EDeviceRegistry,
    prisma.e2EDevice,
  ]) {
    vi.mocked(table.deleteMany).mockResolvedValue({ count: 0 } as never);
  }
});

describe('purging E2E material when an account is deleted', () => {
  it('clears every table that has no foreign key to hold it', async () => {
    // prisma.user.delete() cascades nothing here: these tables were written
    // without FKs, and unlike key shares the device rows and master key never
    // expire. Missing one leaves a deleted account still publishing keys.
    await purgeE2EMaterial(USER);

    expect(prisma.e2EMasterTransfer.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(prisma.e2EMasterKey.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(prisma.e2EDeviceRegistry.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(prisma.e2EDevice.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it('clears key shares in BOTH directions', async () => {
    // The mailbox is keyed by sender AND recipient. Purging only what was
    // addressed TO the user leaves their outbound envelopes sitting in other
    // people's inboxes, addressed from an account that no longer exists.
    await purgeE2EMaterial(USER);

    const calls = vi.mocked(prisma.e2EKeyShare.deleteMany).mock.calls.map(([arg]) => arg);
    expect(calls).toContainEqual({ where: { recipientUserId: USER } });
    expect(calls).toContainEqual({ where: { senderUserId: USER } });
  });

  it('never deletes unscoped', async () => {
    // A missing `where` would empty the table for every user on the platform.
    await purgeE2EMaterial(USER);

    for (const table of [
      prisma.e2EKeyShare,
      prisma.e2EMasterTransfer,
      prisma.e2EMasterKey,
      prisma.e2EDeviceRegistry,
      prisma.e2EDevice,
    ]) {
      for (const [arg] of vi.mocked(table.deleteMany).mock.calls) {
        const where = (arg as { where?: Record<string, unknown> })?.where;
        expect(where).toBeTruthy();
        expect(Object.values(where!)).toContain(USER);
      }
    }
  });

  it('propagates a failure instead of letting the account be deleted anyway', async () => {
    // The caller runs this BEFORE prisma.user.delete, so a throw has to abort
    // the deletion rather than orphan the key material.
    vi.mocked(prisma.e2EDevice.deleteMany).mockRejectedValueOnce(new Error('db down'));
    await expect(purgeE2EMaterial(USER)).rejects.toThrow('db down');
  });
});

describe('key backup retention', () => {
  it('is the one E2E table that cascades, because nothing else can reclaim it', () => {
    // A backup is meant to outlive every device, so no age sweep will ever
    // clear it. Without the cascade a deleted account leaves its sealed
    // account master secret in the database indefinitely.
    const schema = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
      'utf8'
    );
    const model = schema.slice(schema.indexOf('model E2EKeyBackup'));
    const body = model.slice(0, model.indexOf('\n}'));

    expect(body).toContain('@relation(fields: [userId], references: [id], onDelete: Cascade)');
  });
});
