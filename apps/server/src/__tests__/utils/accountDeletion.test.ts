import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), delete: vi.fn() },
  server: { updateMany: vi.fn() },
  serverMember: { findMany: vi.fn(), deleteMany: vi.fn() },
  serverJoinRequest: { findMany: vi.fn() },
  messageAttachment: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const purgeE2E = vi.hoisted(() => vi.fn());
vi.mock('../../utils/e2ePurge', () => ({ purgeE2EMaterial: (...a: unknown[]) => purgeE2E(...a) }));
const removeSecure = vi.hoisted(() => vi.fn());
const announceSecure = vi.hoisted(() => vi.fn());
vi.mock('../../utils/secureChannelLifecycle', () => ({
  removeSecureMembershipsInTx: (...a: unknown[]) => removeSecure(...a),
  announceSecureMembershipsRemoved: (...a: unknown[]) => announceSecure(...a),
}));
const memberLeft = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberLeft: (...a: unknown[]) => memberLeft(...a) }));
const deleteFromS3 = vi.hoisted(() => vi.fn());
const deleteMultipleFromS3 = vi.hoisted(() => vi.fn());
vi.mock('../../utils/s3', () => ({
  deleteFromS3: (...a: unknown[]) => deleteFromS3(...a),
  deleteMultipleFromS3: (...a: unknown[]) => deleteMultipleFromS3(...a),
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
}));
const emitMods = vi.hoisted(() => vi.fn());
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: (...a: unknown[]) => emitMods(...a) }));

const io = vi.hoisted(() => {
  const emit = vi.fn();
  const disconnectSockets = vi.fn();
  const localDisconnectSockets = vi.fn();
  return {
    emit,
    disconnectSockets,
    localDisconnectSockets,
    to: vi.fn(() => ({ emit })),
    in: vi.fn(() => ({ disconnectSockets })),
    local: { in: vi.fn(() => ({ disconnectSockets: localDisconnectSockets })) },
  };
});
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

import { deleteUserAccount } from '../../utils/accountDeletion';

const order: string[] = [];
const SECURE_REMOVAL = {
  userId: 'u-1',
  deleted: [{ channelId: 'sec-own', serverId: 's-1', memberIds: ['u-1', 'u-2'] }],
  left: [{ channelId: 'sec-other', serverId: 's-2' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', avatarUrl: 'avatars/u-1.webp', ownedServers: [] });
  prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's-1' }, { serverId: 's-2' }]);
  prismaMock.serverJoinRequest.findMany.mockResolvedValue([]);
  memberLeft.mockImplementation(async (_u: string, s: string) => { order.push(`left:${s}`); });
  io.localDisconnectSockets.mockImplementation(() => { order.push('disconnect:local'); });
  io.disconnectSockets.mockImplementation(() => { order.push('disconnect'); });
  io.emit.mockImplementation(() => { order.push('force:logout'); });
  prismaMock.serverMember.deleteMany.mockImplementation(async () => { order.push('memberships'); return { count: 2 }; });
  removeSecure.mockImplementation(async () => { order.push('secure'); return SECURE_REMOVAL; });
  announceSecure.mockImplementation(async () => { order.push('secure:notices'); });
  purgeE2E.mockImplementation(async () => { order.push('e2e'); });
  prismaMock.user.delete.mockImplementation(async () => { order.push('delete'); return {}; });
  prismaMock.server.updateMany.mockImplementation(async () => { order.push('counts'); return { count: 2 }; });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    order.push('txn:start');
    const result = await fn({ user: prismaMock.user, server: prismaMock.server, serverMember: prismaMock.serverMember });
    order.push('txn:end');
    return result;
  });
  deleteFromS3.mockImplementation(async () => { order.push('s3'); });
  prismaMock.messageAttachment.findMany.mockImplementation(async () => { order.push('attachment-keys'); return []; });
  deleteMultipleFromS3.mockImplementation(async (keys: string[]) => { order.push('s3:attachments'); return keys.length; });
});

describe('deleteUserAccount', () => {
  it('runs the steps in the order that keeps each one safe', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    // members told and sessions ended before anything is purged; the E2E
    // purge and the row delete share one transaction; the avatar blob goes
    // only AFTER the row (a failed delete must not strand a live account
    // without its avatar)
    expect(order).toEqual([
      'left:s-1', 'left:s-2', 'force:logout', 'disconnect:local', 'disconnect',
      'attachment-keys', 'attachment-keys', 'attachment-keys', 'attachment-keys',
      'txn:start', 'e2e', 'memberships', 'secure', 'counts', 'delete', 'txn:end',
      'force:logout', 'disconnect:local', 'disconnect', 'secure:notices', 's3',
    ]);
    expect(purgeE2E).toHaveBeenCalledWith('u-1', expect.objectContaining({ user: prismaMock.user }));
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u-1' } });
    expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
  });

  it('removes the memberships, then the secure-channel state, inside the delete transaction and on its client', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(prismaMock.serverMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1' } });
    // Every space at once (no space argument), on the transaction's client
    expect(removeSecure).toHaveBeenCalledWith(expect.objectContaining({ serverMember: prismaMock.serverMember }), 'u-1');
    // The member rows before any space row: the lock order every writer of a
    // secure-channel row takes them in
    expect(order.indexOf('memberships')).toBeLessThan(order.indexOf('secure'));
    expect(order.indexOf('secure')).toBeLessThan(order.indexOf('counts'));
  });

  it('announces the secure-channel removal only after the delete committed', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(announceSecure).toHaveBeenCalledWith(SECURE_REMOVAL);
    expect(order.indexOf('secure:notices')).toBeGreaterThan(order.indexOf('txn:end'));
  });

  it('a secure-channel step that throws fails the deletion: the account survives and nothing is announced', async () => {
    removeSecure.mockRejectedValue(new Error('channel delete failed'));
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: prismaMock.user, server: prismaMock.server, serverMember: prismaMock.serverMember }));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('channel delete failed');

    expect(prismaMock.user.delete).not.toHaveBeenCalled();
    expect(announceSecure).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  describe('a delete transaction PostgreSQL aborted to break a deadlock (a space delete or a transfer to this account)', () => {
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });

    it('is run again whole: the account is deleted, its notices sent once, the user not left signed out with the account intact', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => { order.push('txn:aborted'); throw deadlock(); })
        .mockImplementation(real);
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(prismaMock.user.delete).toHaveBeenCalledTimes(1);
        expect(announceSecure).toHaveBeenCalledTimes(1);
        expect(order.indexOf('txn:aborted')).toBeLessThan(order.indexOf('txn:start'));
        expect(warn).toHaveBeenCalledWith('[Accounts] The deletion of account u-1 was aborted by a deadlock or a serialization failure; retrying (1 of 2)');
      } finally {
        warn.mockRestore();
      }
    });

    it('a retry that meets a space the account came to own (a transfer to it committed meanwhile) answers 409, not a 500', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.$transaction
        .mockRejectedValueOnce(deadlock())
        .mockRejectedValueOnce(Object.assign(
          new Error('Foreign key constraint violated on the constraint: `servers_owner_id_fkey`'),
          { code: 'P2003' },
        ));
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' }))
          .rejects.toMatchObject({ statusCode: 409, message: 'Transfer or delete the servers you own before deleting your account' });
        expect(announceSecure).not.toHaveBeenCalled();
        expect(deleteFromS3).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('another foreign-key failure is not taken for an owned space', async () => {
      prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Foreign key constraint violated on the constraint: `other_fkey`'), { code: 'P2003' }));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toMatchObject({ code: 'P2003' });
    });

    it('any other failure is not retried', async () => {
      prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  it('withdraws the account\'s pending join requests with it: each server\'s moderators hear it, after the delete committed', async () => {
    prismaMock.serverJoinRequest.findMany.mockResolvedValue([{ serverId: 's-7' }]);
    emitMods.mockImplementation(async () => { order.push('request-withdrawn'); });

    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(prismaMock.serverJoinRequest.findMany).toHaveBeenCalledWith({ where: { userId: 'u-1', status: 'pending' }, select: { serverId: true } });
    expect(emitMods).toHaveBeenCalledWith('s-7', 'server:join_request_resolved', { serverId: 's-7', userId: 'u-1', outcome: 'cancelled' });
    expect(order.indexOf('request-withdrawn')).toBeGreaterThan(order.indexOf('txn:end'));
  });

  it('ends every live session with a ROOM-filtered disconnect, never the empty-filter form', () => {
    // The empty room filter fans out to every node's entire namespace (see
    // index.ts shutdown) — restarting one node once hung up the cluster.
    return deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' }).then(() => {
      expect(io.local.in).toHaveBeenCalledWith('user:u-1');
      expect(io.localDisconnectSockets).toHaveBeenCalledWith(true);
      expect(io.in).toHaveBeenCalledWith('user:u-1');
      expect(io.disconnectSockets).toHaveBeenCalledWith(true);
      expect(io.to).toHaveBeenCalledWith('user:u-1');
      expect(io.emit).toHaveBeenCalledWith('force:logout', { reason: 'bye' });
    });
  });

  it('ends again, after the delete committed, a session that connected while the row still existed', async () => {
    // A second device's handshake lands between the first revocation and the
    // delete: it joins user:{id} after the first disconnect went out.
    const lateSockets = new Set<string>();
    removeSecure.mockImplementation(async () => { order.push('secure'); lateSockets.add('late-socket'); return SECURE_REMOVAL; });
    io.disconnectSockets.mockImplementation(() => { order.push('disconnect'); lateSockets.clear(); });

    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(lateSockets.size).toBe(0);
    const lastDisconnect = order.lastIndexOf('disconnect');
    expect(lastDisconnect).toBeGreaterThan(order.indexOf('txn:end'));
    expect(io.emit).toHaveBeenCalledTimes(2);
    expect(io.emit).toHaveBeenLastCalledWith('force:logout', { reason: 'bye' });
  });

  it('does not run the second revocation when the delete fails (the account survives)', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
    expect(io.disconnectSockets).toHaveBeenCalledTimes(1);
  });

  it('refuses an account that still owns servers — Server.owner is onDelete: Restrict and the choice is the owner\'s', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', avatarUrl: null, ownedServers: [{ id: 's-owned' }] });

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow(/still owns servers/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(io.disconnectSockets).not.toHaveBeenCalled();
    expect(io.localDisconnectSockets).not.toHaveBeenCalled();
  });

  it('keeps the avatar when the delete fails, and surfaces the error', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('decrements the inline member count of every server the account belonged to, inside the delete transaction', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    // The cascade removes the memberships; the directory's live member count
    // (server discovery) must follow in the same transaction — guarded so
    // drift can never push it negative.
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-1', 's-2'] }, memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
  });

  it('skips the count update when the account was a member of nothing', async () => {
    prismaMock.serverMember.findMany.mockResolvedValue([]);
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });
    expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
  });

  describe('the attachment files of the messages the delete cascades', () => {
    const OWN = 'attachments/ch-general/clmsg1-photo.png';
    const PEER = 'attachments/dm-conv1/clmsg2-blob.bin';

    it('are read before the transaction, one read per indexed column: the account\'s messages and each side of its conversations', async () => {
      prismaMock.messageAttachment.findMany.mockImplementation(async () => {
        order.push('attachment-keys');
        return [];
      });

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      const shapes = prismaMock.messageAttachment.findMany.mock.calls.map(([args]: [any]) => args.where);
      expect(shapes).toEqual([
        { expired: false, message: { authorId: 'u-1' } },
        { expired: false, message: { conversation: { user1Id: 'u-1' } } },
        { expired: false, message: { conversation: { user2Id: 'u-1' } } },
        // the secure channels the account created: the transaction deletes them
        { expired: false, message: { channel: { createdById: 'u-1', secure: true } } },
      ]);
      // No OR across the joined tables: it started from no index
      expect(JSON.stringify(shapes)).not.toContain('"OR"');
      // Before the delete transaction takes the rows
      expect(order.lastIndexOf('attachment-keys')).toBeLessThan(order.indexOf('txn:start'));
    });

    it('are deleted only after the delete committed, each file once though two reads found it', async () => {
      // OWN was written by the account in its own conversation: the author
      // read and the conversation read both return it
      prismaMock.messageAttachment.findMany
        .mockResolvedValueOnce([{ id: 'att-1', s3Key: OWN }])
        .mockResolvedValueOnce([{ id: 'att-1', s3Key: OWN }, { id: 'att-2', s3Key: PEER }])
        .mockResolvedValueOnce([]);

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      expect(deleteMultipleFromS3).toHaveBeenCalledTimes(1);
      expect(deleteMultipleFromS3).toHaveBeenCalledWith([OWN, PEER]);
      expect(order.indexOf('s3:attachments')).toBeGreaterThan(order.indexOf('txn:end'));
    });

    it('a key read that fails is logged and the erasure goes on, deleting the files the other reads found', async () => {
      prismaMock.messageAttachment.findMany
        .mockRejectedValueOnce(new Error('db gone'))
        .mockResolvedValueOnce([{ id: 'att-2', s3Key: PEER }])
        .mockResolvedValueOnce([]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        // The sessions were revoked before the read: stopping there would
        // leave the account half erased
        expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u-1' } });
        expect(order.lastIndexOf('disconnect')).toBeGreaterThan(order.indexOf('txn:end'));
        expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
        expect(deleteMultipleFromS3).toHaveBeenCalledWith([PEER]);
        expect(error).toHaveBeenCalledWith(
          "[T] Reading the attachment keys of the account's messages failed (the orphan sweep will reclaim those files):", 'db gone');
      } finally {
        error.mockRestore();
      }
    });

    it('every key read failing still erases the account, with no file delete', async () => {
      prismaMock.messageAttachment.findMany.mockRejectedValue(new Error('db gone'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        expect(prismaMock.user.delete).toHaveBeenCalled();
        expect(deleteMultipleFromS3).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(4);
      } finally {
        error.mockRestore();
      }
    });

    it('stay when the delete fails (the account and its messages survive)', async () => {
      prismaMock.messageAttachment.findMany.mockResolvedValue([{ id: 'att-1', s3Key: OWN }]);
      prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
      expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    });

    it('a storage failure is logged and the deletion still completes', async () => {
      prismaMock.messageAttachment.findMany.mockResolvedValue([{ id: 'att-1', s3Key: OWN }]);
      deleteMultipleFromS3.mockRejectedValue(new Error('S3 unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
          '[T] Attachment file cleanup failed for a deleted account (the orphan sweep will reclaim them):', 'S3 unavailable'));
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('does nothing for an account that no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await deleteUserAccount('ghost', { reason: 'bye', logPrefix: '[T]' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
