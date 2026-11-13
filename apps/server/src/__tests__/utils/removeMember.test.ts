import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// removeMemberFromServer — the kick route's teardown lifted out, plus the ban
// upsert, the join-request delete, the member's secure-channel state, the read
// markers and the memberCount decrement in ONE transaction, and (kick only)
// the creator's webhooks disabled in it. Kick calls it with a ban; leave calls
// it without one. The interleavings with secure-channel invites run against
// an in-memory database in secureChannelMembership.test.ts.

const order: string[] = [];

/** The interactive transaction's client: every statement records itself. */
const tx = vi.hoisted(() => ({
  // the membership row lock, the transaction's first statement
  $queryRaw: vi.fn(),
  webhook: { updateMany: vi.fn() },
  serverBan: { upsert: vi.fn() },
  serverJoinRequest: { deleteMany: vi.fn() },
  serverMember: { deleteMany: vi.fn(), findUnique: vi.fn() },
  server: { updateMany: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  messageAttachment: { findMany: vi.fn() },
  // The read markers go after the commit, on the plain client
  channelRead: { deleteMany: vi.fn() },
  // Read only when the transaction found the member gone or lost a deadlock
  server: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const redisGet = vi.hoisted(() => vi.fn());
vi.mock('../../utils/redis', () => ({ getRedis: () => ({ get: (...a: unknown[]) => redisGet(...a) }) }));

const io = vi.hoisted(() => ({ tag: 'io' }));
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

const evict = vi.hoisted(() => vi.fn());
vi.mock('../../websocket/voiceCluster', () => ({ broadcastVoiceEvictUser: (...a: unknown[]) => evict(...a) }));

const removeSecure = vi.hoisted(() => vi.fn());
const announceSecure = vi.hoisted(() => vi.fn());
vi.mock('../../utils/secureChannelLifecycle', () => ({
  removeSecureMembershipsInTx: (...a: unknown[]) => removeSecure(...a),
  announceSecureMembershipsRemoved: (...a: unknown[]) => announceSecure(...a),
}));

const deleteBlobs = vi.hoisted(() => vi.fn());
vi.mock('../../utils/attachmentBlobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/attachmentBlobs')>()),
  deleteAttachmentBlobs: (...a: unknown[]) => deleteBlobs(...a),
}));
vi.mock('../../utils/s3', () => ({ VALID_ATTACHMENT_KEY_RE: /^attachments\//, deleteMultipleFromS3: vi.fn() }));

const memberLeft = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberLeft: (...a: unknown[]) => memberLeft(...a) }));

const webhookChanged = vi.hoisted(() => vi.fn());
vi.mock('../../utils/webhookLifecycle', () => ({ emitWebhookChanged: (...a: unknown[]) => webhookChanged(...a) }));

import { removeMemberFromServer } from '../../utils/removeMember';

const NO_SECURE = { userId: 'u-1', deleted: [], left: [] };

function webhooksDisabled(count: number): void {
  tx.webhook.updateMany.mockImplementation(async () => { order.push('webhooks.disable'); return { count }; });
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  redisGet.mockResolvedValue(null);
  evict.mockImplementation(async () => { order.push('voice'); });
  prismaMock.messageAttachment.findMany.mockImplementation(async () => { order.push('attachment-keys'); return []; });
  webhooksDisabled(0);
  tx.$queryRaw.mockImplementation(async () => { order.push('lock:member'); return [{ user_id: 'u-1' }]; });
  tx.serverBan.upsert.mockImplementation(async () => { order.push('ban'); return {}; });
  tx.serverJoinRequest.deleteMany.mockImplementation(async () => { order.push('request'); return { count: 0 }; });
  tx.serverMember.deleteMany.mockImplementation(async () => { order.push('member'); return { count: 1 }; });
  tx.serverMember.findUnique.mockResolvedValue(null);
  removeSecure.mockImplementation(async () => { order.push('secure'); return NO_SECURE; });
  prismaMock.channelRead.deleteMany.mockImplementation(async () => { order.push('reads'); return { count: 2 }; });
  prismaMock.server.findUnique.mockResolvedValue({ id: 's-1' });
  tx.server.updateMany.mockImplementation(async () => { order.push('count'); return { count: 1 }; });
  prismaMock.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
    order.push('txn:start');
    const result = await fn(tx);
    order.push('txn:end');
    return result;
  });
  announceSecure.mockImplementation(async () => { order.push('secure:notices'); });
  memberLeft.mockImplementation(async () => { order.push('left'); });
  webhookChanged.mockImplementation(() => { order.push('webhook:changed'); });
});

describe('removeMemberFromServer', () => {
  it('keeps the teardown order: voice → one transaction (request, member, secure state, count) → read markers → secure notices → member:left', async () => {
    redisGet.mockImplementation(async (key: string) =>
      key === 'voice:user:u-1' ? 'vc-1' : key === 'voice:channel:server:vc-1' ? 's-1' : null);

    await removeMemberFromServer('u-1', 's-1');

    expect(order).toEqual([
      'voice', 'attachment-keys',
      'txn:start', 'lock:member', 'request', 'member', 'secure', 'count', 'txn:end',
      'reads', 'secure:notices', 'left',
    ]);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(memberLeft).toHaveBeenCalledWith('u-1', 's-1');
  });

  it('locks the membership row FIRST, FOR UPDATE, on the transaction\'s client: before the webhooks, the check, the request and the delete', async () => {
    const authorize = vi.fn(async (db: unknown) => { order.push(db === tx ? 'authorize:tx' : 'authorize:shared'); });
    await removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null }, authorize });

    const inTx = order.slice(order.indexOf('txn:start') + 1, order.indexOf('txn:end'));
    expect(inTx[0]).toBe('lock:member');
    expect(inTx.slice(0, 4)).toEqual(['lock:member', 'webhooks.disable', 'authorize:tx', 'request']);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(strings.join('?')).toBe('SELECT user_id FROM server_members WHERE user_id = ? AND server_id = ? FOR UPDATE');
    expect(values).toEqual(['u-1', 's-1']);
  });

  it('a voluntary leave locks the membership row first too', async () => {
    await removeMemberFromServer('u-1', 's-1');
    expect(order[order.indexOf('txn:start') + 1]).toBe('lock:member');
  });

  it('removes the member\'s secure-channel state INSIDE the transaction, on its client, after the membership row', async () => {
    await removeMemberFromServer('u-1', 's-1');

    expect(removeSecure).toHaveBeenCalledWith(tx, 'u-1', 's-1');
    // After the member delete: a writer of a secure-channel row holds a lock
    // on that row, the delete waits for it, and this later statement then
    // sees what it wrote
    expect(order.indexOf('secure')).toBeGreaterThan(order.indexOf('member'));
    expect(order.indexOf('secure')).toBeLessThan(order.indexOf('txn:end'));
  });

  it('a secure-channel step that throws fails the whole removal: no notice, no member:left', async () => {
    removeSecure.mockRejectedValue(new Error('channel delete failed'));

    await expect(removeMemberFromServer('u-1', 's-1')).rejects.toThrow('channel delete failed');

    expect(tx.server.updateMany).not.toHaveBeenCalled();
    expect(announceSecure).not.toHaveBeenCalled();
    expect(deleteBlobs).not.toHaveBeenCalled();
    expect(memberLeft).not.toHaveBeenCalled();
  });

  it('announces the secure-channel removal after the commit, and deletes the deleted channels\' files only then', async () => {
    const removal = { userId: 'u-1', deleted: [{ channelId: 'sec-own', serverId: 's-1', memberIds: ['u-1', 'u-2'] }], left: [{ channelId: 'sec-other', serverId: 's-1' }] };
    removeSecure.mockImplementation(async () => { order.push('secure'); return removal; });
    prismaMock.messageAttachment.findMany.mockImplementation(async () => {
      order.push('attachment-keys');
      return [{ id: 'att-1', s3Key: 'attachments/ch-sec-own/aaaa-encrypted.bin' }];
    });
    deleteBlobs.mockImplementation(() => { order.push('files'); });

    await removeMemberFromServer('u-1', 's-1');

    // The keys of the channels the member created are read before the
    // transaction deletes their rows
    expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { expired: false, message: { channel: { serverId: 's-1', createdById: 'u-1', secure: true } } },
    }));
    expect(order.indexOf('attachment-keys')).toBeLessThan(order.indexOf('txn:start'));
    expect(deleteBlobs).toHaveBeenCalledWith(['attachments/ch-sec-own/aaaa-encrypted.bin'], '[Servers]', 'the secure channels of a departed member');
    expect(order.indexOf('files')).toBeGreaterThan(order.indexOf('txn:end'));
    expect(announceSecure).toHaveBeenCalledWith(removal);
    expect(order.indexOf('secure:notices')).toBeGreaterThan(order.indexOf('txn:end'));
  });

  it('deletes no file when the member created no secure channel', async () => {
    await removeMemberFromServer('u-1', 's-1');
    expect(deleteBlobs).not.toHaveBeenCalled();
  });

  it('removes the read markers of every channel of the space AFTER the commit, outside the transaction', async () => {
    await removeMemberFromServer('u-1', 's-1');

    // They grant nothing, and inside the transaction they were one more row
    // locked in an order a channel delete's cascade does not share
    expect(prismaMock.channelRead.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', channel: { serverId: 's-1' } } });
    expect((tx as Record<string, unknown>).channelRead).toBeUndefined();
    expect(order.indexOf('reads')).toBeGreaterThan(order.indexOf('txn:end'));
  });

  it('a read-marker delete that fails is logged and the removal still completes', async () => {
    prismaMock.channelRead.deleteMany.mockRejectedValue(new Error('db hiccup'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeMemberFromServer('u-1', 's-1')).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith('[Servers] Member u-1 removed from s-1, but their read markers were not deleted:', 'db hiccup');
      expect(announceSecure).toHaveBeenCalled();
      expect(memberLeft).toHaveBeenCalledWith('u-1', 's-1');
    } finally {
      warn.mockRestore();
    }
  });

  describe('a transaction PostgreSQL aborted to break a deadlock', () => {
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), { code: 'P2034' });
    const rawDeadlock = () => Object.assign(new Error('Raw query failed. Code: `40P01`. Message: `deadlock detected`'), {
      code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '40P01' } } },
    });
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });

    it('is run again whole, and the removal completes once, with one set of notices', async () => {
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => { order.push('txn:aborted'); throw deadlock(); })
        .mockImplementationOnce(async () => { order.push('txn:aborted'); throw rawDeadlock(); })
        .mockImplementation(real);

      await removeMemberFromServer('u-1', 's-1');

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(3);
      expect(order.filter((o) => o === 'txn:aborted')).toHaveLength(2);
      expect(announceSecure).toHaveBeenCalledTimes(1);
      expect(memberLeft).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('was aborted by a deadlock or a serialization failure; retrying (1 of 2)'));
    });

    it('is retried twice at most, then the error is the answer and nothing is announced', async () => {
      prismaMock.$transaction.mockImplementation(async () => { throw deadlock(); });

      await expect(removeMemberFromServer('u-1', 's-1')).rejects.toMatchObject({ code: 'P2034' });

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(3);
      expect(announceSecure).not.toHaveBeenCalled();
      expect(memberLeft).not.toHaveBeenCalled();
    });

    it('any other error is never retried: a member already gone is the 404 at once', async () => {
      tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });

      await expect(removeMemberFromServer('u-1', 's-1')).rejects.toMatchObject({ statusCode: 404 });
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);

      prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Raw query failed. Code: `23503`.'), {
        code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23503' } } },
      }));
      await expect(removeMemberFromServer('u-1', 's-1')).rejects.toMatchObject({ code: 'P2010' });
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    });
  });

  it('without a ban: request, membership, secure state, read markers and the guarded decrement, no ban, no webhook statement', async () => {
    await removeMemberFromServer('u-1', 's-1');

    expect(tx.serverBan.upsert).not.toHaveBeenCalled();
    expect(tx.webhook.updateMany).not.toHaveBeenCalled();
    expect(tx.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's-1', userId: 'u-1' } });
    // never the owner's row, whatever the caller checked before the transaction
    expect(tx.serverMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', serverId: 's-1', role: { not: 'owner' } } });
    // Never below zero: inline drift must not produce a negative count on a card
    expect(tx.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
  });

  it('gives the transaction a budget a departing creator\'s channel delete can finish in', async () => {
    await removeMemberFromServer('u-1', 's-1');
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
  });

  it('with a ban: the ServerBan upsert rides in the same transaction, right before the count, carrying who and why', async () => {
    await removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: 'spam' } });

    // Inserting a ban locks the space row through its foreign key, and every
    // secure-channel and webhook creation waits for that row: taken right
    // before the count (which locks it anyway), after the member row and the
    // secure-channel cascade, it is held for the shortest time
    expect(order.slice(0, order.indexOf('txn:end') + 1)).toEqual([
      'attachment-keys', 'txn:start', 'lock:member', 'webhooks.disable', 'request', 'member', 'secure', 'ban', 'count', 'txn:end',
    ]);
    expect(tx.serverBan.upsert).toHaveBeenCalledWith({
      where: { serverId_userId: { serverId: 's-1', userId: 'u-1' } },
      create: { serverId: 's-1', userId: 'u-1', bannedById: 'mod-1', reason: 'spam' },
      // a re-ban refreshes who, why and when
      update: { bannedById: 'mod-1', reason: 'spam', createdAt: expect.any(Date) },
    });
  });

  it('stores a null reason as null (the reason is optional)', async () => {
    await removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } });
    expect(tx.serverBan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { serverId: 's-1', userId: 'u-1', bannedById: 'mod-1', reason: null },
    }));
  });

  it('evicts from voice across the cluster only when the voice channel belongs to THIS server', async () => {
    redisGet.mockImplementation(async (key: string) =>
      key === 'voice:user:u-1' ? 'vc-9' : key === 'voice:channel:server:vc-9' ? 's-OTHER' : null);
    await removeMemberFromServer('u-1', 's-1');
    expect(evict).not.toHaveBeenCalled();

    redisGet.mockImplementation(async (key: string) =>
      key === 'voice:user:u-1' ? 'vc-1' : key === 'voice:channel:server:vc-1' ? 's-1' : null);
    await removeMemberFromServer('u-1', 's-1');
    expect(evict).toHaveBeenCalledWith(io, 'vc-1', 'u-1');
  });

  it('does nothing about voice when the member is not in a voice channel', async () => {
    await removeMemberFromServer('u-1', 's-1');
    expect(redisGet).toHaveBeenCalledWith('voice:user:u-1');
    expect(redisGet).toHaveBeenCalledTimes(1);
    expect(evict).not.toHaveBeenCalled();
  });

  it('a Redis failure in the voice step is logged and does NOT abort the removal (the reaper catches up)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisGet.mockRejectedValue(new Error('redis down'));

    await removeMemberFromServer('u-1', 's-1');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Voice eviction'), expect.any(Error));
    expect(order).toContain('txn:end');
    expect(order[order.length - 1]).toBe('left');
    warn.mockRestore();
  });

  it('a member who left between the caller\'s check and the transaction answers 404 Member, not a 500', async () => {
    tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });

    await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: 'spam' } }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Member not found' });
    expect(removeSecure).not.toHaveBeenCalled();
    expect(memberLeft).not.toHaveBeenCalled();
  });

  describe('the precondition holds on every attempt of the transaction', () => {
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });

    it('never deletes the owner\'s row: a member who became the owner answers what the leave route answers for the owner', async () => {
      tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });
      tx.serverMember.findUnique.mockResolvedValue({ role: 'owner' });

      await expect(removeMemberFromServer('u-1', 's-1'))
        .rejects.toMatchObject({ statusCode: 403, message: 'Server owner cannot leave. Transfer ownership first.' });
      expect(removeSecure).not.toHaveBeenCalled();
      expect(tx.server.updateMany).not.toHaveBeenCalled();
      expect(announceSecure).not.toHaveBeenCalled();
      expect(memberLeft).not.toHaveBeenCalled();
    });

    it('a kick of a member who became the owner answers what the kick route answers for an outranking target', async () => {
      tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });
      tx.serverMember.findUnique.mockResolvedValue({ role: 'owner' });

      await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } }))
        .rejects.toMatchObject({ statusCode: 403, message: 'Cannot kick a member with an equal or higher role' });
      expect(tx.serverBan.upsert).not.toHaveBeenCalled();
    });

    it('a retried attempt meets the owner a transfer made of the member meanwhile, and refuses instead of removing them', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => {
          // the first attempt loses a deadlock to a transfer to this member,
          // which then commits
          tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });
          tx.serverMember.findUnique.mockResolvedValue({ role: 'owner' });
          throw deadlock();
        })
        .mockImplementation(real);
      try {
        await expect(removeMemberFromServer('u-1', 's-1'))
          .rejects.toMatchObject({ statusCode: 403, message: 'Server owner cannot leave. Transfer ownership first.' });
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(memberLeft).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('runs the caller\'s check on every attempt twice: before its transaction opens on the shared client, then inside it on the transaction\'s client, right after the webhook statement', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let open = 0;
      const seen: Array<{ open: number; client: 'shared' | 'tx' | 'other' }> = [];
      const authorize = vi.fn(async (db: unknown) => {
        seen.push({ open, client: db === prismaMock ? 'shared' : db === tx ? 'tx' : 'other' });
        order.push(db === tx ? 'authorize:tx' : 'authorize:shared');
      });
      const real = prismaMock.$transaction.getMockImplementation()!;
      const tracked = (impl: (fn: (client: typeof tx) => Promise<unknown>) => Promise<unknown>) =>
        async (fn: (client: typeof tx) => Promise<unknown>) => {
          open++;
          try { return await impl(fn); } finally { open--; }
        };
      prismaMock.$transaction
        .mockImplementationOnce(tracked(async (fn) => { await fn(tx); throw deadlock(); }))
        .mockImplementation(tracked(real));
      try {
        await removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null }, authorize });

        // the early refusal with no transaction open, then the one that holds,
        // inside the transaction and on its client: on each of the two attempts
        expect(seen).toEqual([
          { open: 0, client: 'shared' }, { open: 1, client: 'tx' },
          { open: 0, client: 'shared' }, { open: 1, client: 'tx' },
        ]);
        const lastAttempt = order.slice(order.lastIndexOf('authorize:shared'));
        expect(lastAttempt.slice(0, 6)).toEqual(['authorize:shared', 'txn:start', 'lock:member', 'webhooks.disable', 'authorize:tx', 'request']);
        expect(lastAttempt.indexOf('member')).toBeGreaterThan(lastAttempt.indexOf('authorize:tx'));
      } finally {
        warn.mockRestore();
      }
    });

    it('a check that passes before the transaction and refuses inside it (the actor demoted while the webhook statement waited) rolls everything back: 403, nobody removed, nobody banned', async () => {
      const refusal = Object.assign(new Error('You do not have permission to kick members'), { statusCode: 403 });
      const authorize = vi.fn(async (db: unknown) => { if (db === tx) throw refusal; });
      webhooksDisabled(1);

      await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null }, authorize }))
        .rejects.toBe(refusal);

      expect(authorize).toHaveBeenCalledTimes(2);
      // a refusal is the answer, never a retry
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.serverJoinRequest.deleteMany).not.toHaveBeenCalled();
      expect(tx.serverMember.deleteMany).not.toHaveBeenCalled();
      expect(tx.serverBan.upsert).not.toHaveBeenCalled();
      expect(tx.server.updateMany).not.toHaveBeenCalled();
      // the webhook statement before it rolls back with the transaction: no event for it
      expect(webhookChanged).not.toHaveBeenCalled();
      expect(announceSecure).not.toHaveBeenCalled();
      expect(memberLeft).not.toHaveBeenCalled();
      expect(prismaMock.channelRead.deleteMany).not.toHaveBeenCalled();
    });

    it('a check that refuses on a retried attempt is the answer: no transaction is opened for it, nothing is removed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const refusal = Object.assign(new Error('Cannot kick a member with an equal or higher role'), { statusCode: 403 });
      const authorize = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(refusal);
      prismaMock.$transaction.mockImplementationOnce(async () => { throw deadlock(); });
      try {
        await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null }, authorize }))
          .rejects.toBe(refusal);
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.serverMember.deleteMany).not.toHaveBeenCalled();
        expect(memberLeft).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('a space deleted while the removal ran', () => {
    beforeEach(() => { prismaMock.server.findUnique.mockResolvedValue(null); });

    it('answers 404 Server when its delete committed first (the member row is already gone), not 404 Member', async () => {
      tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });

      await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } }))
        .rejects.toMatchObject({ statusCode: 404, message: 'Server not found' });
      expect(prismaMock.server.findUnique).toHaveBeenCalledWith({ where: { id: 's-1' }, select: { id: true } });
      expect(memberLeft).not.toHaveBeenCalled();
    });

    it('answers 404 Server, not a 500, when its delete won every deadlock against the removal', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.$transaction.mockImplementation(async () => {
        throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
      });
      try {
        await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } }))
          .rejects.toMatchObject({ statusCode: 404, message: 'Server not found' });
      } finally {
        warn.mockRestore();
      }
    });

    it('a space lookup that fails keeps the answer the error had (it is not read as "gone")', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.server.findUnique.mockRejectedValue(new Error('db hiccup'));
      tx.serverMember.deleteMany.mockResolvedValue({ count: 0 });
      try {
        await expect(removeMemberFromServer('u-1', 's-1'))
          .rejects.toMatchObject({ statusCode: 404, message: 'Member not found' });
        expect(warn).toHaveBeenCalledWith('[Servers] Could not tell whether space s-1 still exists:', 'db hiccup');
      } finally {
        warn.mockRestore();
      }
    });

    it('a plain error is never turned into a not-found', async () => {
      prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

      await expect(removeMemberFromServer('u-1', 's-1')).rejects.toThrow('db gone');
      expect(prismaMock.server.findUnique).not.toHaveBeenCalled();
    });
  });

  it('a failed transaction surfaces the error and never broadcasts member:left', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } })).rejects.toThrow('db gone');
    expect(announceSecure).not.toHaveBeenCalled();
    expect(memberLeft).not.toHaveBeenCalled();
  });
});

describe('removeMemberFromServer: a kick disables the removed creator\'s webhooks', () => {
  const KICK = { ban: { by: 'mod-1', reason: 'spam' } };

  it('disables the webhooks whose LIVE URL the member holds on THIS server (created and never rotated by another, or last rotated by them), enabled or not, and marks them creatorRemovedAt', async () => {
    const before = Date.now();
    webhooksDisabled(2);
    await removeMemberFromServer('u-1', 's-1', KICK);

    expect(tx.webhook.updateMany).toHaveBeenCalledTimes(1);
    const args = tx.webhook.updateMany.mock.calls[0][0];
    expect(args).toEqual({
      where: { serverId: 's-1', OR: [{ lastRotatedById: 'u-1' }, { lastRotatedAt: null, createdById: 'u-1' }] },
      data: { enabled: false, creatorRemovedAt: expect.any(Date) },
    });
    // no `enabled: true` filter: an already-disabled row must carry the mark too
    expect(JSON.stringify(args.where)).not.toContain('enabled');
    expect(args.data.creatorRemovedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rides in the SAME transaction as the membership delete, right after the membership row lock (a removal never commits without it; the row lock of a purge is waited for before the rows a create or a join needs)', async () => {
    webhooksDisabled(1);
    await removeMemberFromServer('u-1', 's-1', KICK);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(order.slice(order.indexOf('txn:start') + 1, order.indexOf('txn:start') + 3)).toEqual(['lock:member', 'webhooks.disable']);
  });

  it('when it disabled any: one webhook:changed with the server id alone, AFTER member:left (the removed member is out of the room)', async () => {
    webhooksDisabled(3);
    await removeMemberFromServer('u-1', 's-1', KICK);

    expect(webhookChanged).toHaveBeenCalledTimes(1);
    expect(webhookChanged).toHaveBeenCalledWith('s-1');
    expect(order.slice(-2)).toEqual(['left', 'webhook:changed']);
  });

  it('when the member created none (count 0): the statement runs, but no event is sent', async () => {
    webhooksDisabled(0);
    await removeMemberFromServer('u-1', 's-1', KICK);

    expect(tx.webhook.updateMany).toHaveBeenCalledTimes(1);
    // The decrement answers { count: 1 }: the count must be the webhook
    // statement's, never another one's
    expect(webhookChanged).not.toHaveBeenCalled();
  });

  it('a voluntary leave (no ban) keeps the member\'s webhooks: no statement, no event', async () => {
    webhooksDisabled(5);
    await removeMemberFromServer('u-1', 's-1');

    expect(tx.webhook.updateMany).not.toHaveBeenCalled();
    expect(webhookChanged).not.toHaveBeenCalled();
  });

  it('a failed or raced transaction disables nothing it reports, and sends no event', async () => {
    webhooksDisabled(2);
    tx.serverMember.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(removeMemberFromServer('u-1', 's-1', KICK)).rejects.toMatchObject({ statusCode: 404 });
    expect(webhookChanged).not.toHaveBeenCalled();

    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));
    await expect(removeMemberFromServer('u-1', 's-1', KICK)).rejects.toThrow('db gone');
    expect(webhookChanged).not.toHaveBeenCalled();
  });
});
