import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), delete: vi.fn() },
  serverMember: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const purgeE2E = vi.hoisted(() => vi.fn());
vi.mock('../../utils/e2ePurge', () => ({ purgeE2EMaterial: (...a: unknown[]) => purgeE2E(...a) }));
const purgeSecure = vi.hoisted(() => vi.fn());
vi.mock('../../utils/secureChannelLifecycle', () => ({ purgeSecureChannelStateForAccount: (...a: unknown[]) => purgeSecure(...a) }));
const memberLeft = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberLeft: (...a: unknown[]) => memberLeft(...a) }));
const deleteFromS3 = vi.hoisted(() => vi.fn());
vi.mock('../../utils/s3', () => ({ deleteFromS3: (...a: unknown[]) => deleteFromS3(...a) }));

const io = vi.hoisted(() => {
  const emit = vi.fn();
  const disconnectSockets = vi.fn();
  return {
    emit,
    disconnectSockets,
    to: vi.fn(() => ({ emit })),
    in: vi.fn(() => ({ disconnectSockets })),
  };
});
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

import { deleteUserAccount } from '../../utils/accountDeletion';

const order: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', avatarUrl: 'avatars/u-1.webp', ownedServers: [] });
  prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's-1' }, { serverId: 's-2' }]);
  memberLeft.mockImplementation(async (_u: string, s: string) => { order.push(`left:${s}`); });
  io.disconnectSockets.mockImplementation(() => { order.push('disconnect'); });
  purgeSecure.mockImplementation(async () => { order.push('secure'); });
  purgeE2E.mockImplementation(async () => { order.push('e2e'); });
  prismaMock.user.delete.mockImplementation(async () => { order.push('delete'); return {}; });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    order.push('txn:start');
    await fn({ user: prismaMock.user });
    order.push('txn:end');
  });
  deleteFromS3.mockImplementation(async () => { order.push('s3'); });
});

describe('deleteUserAccount', () => {
  it('runs the steps in the order that keeps each one safe', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    // members told and sessions ended before anything is purged; the E2E
    // purge and the row delete share one transaction; the avatar blob goes
    // only AFTER the row (a failed delete must not strand a live account
    // without its avatar)
    expect(order).toEqual(['left:s-1', 'left:s-2', 'disconnect', 'secure', 'txn:start', 'e2e', 'delete', 'txn:end', 's3']);
    expect(purgeE2E).toHaveBeenCalledWith('u-1', expect.objectContaining({ user: prismaMock.user }));
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u-1' } });
    expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
  });

  it('ends every live session with a ROOM-filtered disconnect, never the empty-filter form', () => {
    // The empty room filter fans out to every node's entire namespace (see
    // index.ts shutdown) — restarting one node once hung up the cluster.
    return deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' }).then(() => {
      expect(io.in).toHaveBeenCalledWith('user:u-1');
      expect(io.disconnectSockets).toHaveBeenCalledWith(true);
      expect(io.to).toHaveBeenCalledWith('user:u-1');
      expect(io.emit).toHaveBeenCalledWith('force:logout', { reason: 'bye' });
    });
  });

  it('refuses an account that still owns servers — Server.owner is onDelete: Restrict and the choice is the owner\'s', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', avatarUrl: null, ownedServers: [{ id: 's-owned' }] });

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow(/still owns servers/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(io.disconnectSockets).not.toHaveBeenCalled();
  });

  it('keeps the avatar when the delete fails, and surfaces the error', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('does nothing for an account that no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await deleteUserAccount('ghost', { reason: 'bye', logPrefix: '[T]' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
