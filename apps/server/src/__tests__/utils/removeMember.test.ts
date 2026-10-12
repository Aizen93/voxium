import { describe, it, expect, vi, beforeEach } from 'vitest';

// removeMemberFromServer — the kick route's teardown lifted out, plus the ban
// upsert, the join-request delete and the memberCount decrement in its
// transaction. Kick calls it with a ban; leave calls it without one.

const prismaMock = vi.hoisted(() => ({
  channel: { findMany: vi.fn() },
  channelRead: { deleteMany: vi.fn() },
  serverBan: { upsert: vi.fn() },
  serverJoinRequest: { deleteMany: vi.fn() },
  serverMember: { delete: vi.fn() },
  server: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const redisGet = vi.hoisted(() => vi.fn());
vi.mock('../../utils/redis', () => ({ getRedis: () => ({ get: (...a: unknown[]) => redisGet(...a) }) }));

const io = vi.hoisted(() => ({ tag: 'io' }));
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

const evict = vi.hoisted(() => vi.fn());
vi.mock('../../websocket/voiceCluster', () => ({ broadcastVoiceEvictUser: (...a: unknown[]) => evict(...a) }));

const purgeSecure = vi.hoisted(() => vi.fn());
vi.mock('../../utils/secureChannelLifecycle', () => ({ purgeSecureChannelState: (...a: unknown[]) => purgeSecure(...a) }));

const memberLeft = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberLeft: (...a: unknown[]) => memberLeft(...a) }));

import { removeMemberFromServer } from '../../utils/removeMember';

const order: string[] = [];
const BAN = { op: 'ban.upsert' };
const REQ = { op: 'request.deleteMany' };
const DEL = { op: 'member.delete' };
const DEC = { op: 'server.updateMany' };

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  redisGet.mockResolvedValue(null);
  evict.mockImplementation(async () => { order.push('voice'); });
  purgeSecure.mockImplementation(async () => { order.push('secure'); });
  prismaMock.channel.findMany.mockImplementation(async () => { order.push('channels'); return [{ id: 'ch-1' }, { id: 'ch-2' }]; });
  prismaMock.channelRead.deleteMany.mockImplementation(async () => { order.push('reads'); return { count: 2 }; });
  prismaMock.serverBan.upsert.mockReturnValue(BAN);
  prismaMock.serverJoinRequest.deleteMany.mockReturnValue(REQ);
  prismaMock.serverMember.delete.mockReturnValue(DEL);
  prismaMock.server.updateMany.mockReturnValue(DEC);
  prismaMock.$transaction.mockImplementation(async () => { order.push('txn'); return []; });
  memberLeft.mockImplementation(async () => { order.push('left'); });
});

describe('removeMemberFromServer', () => {
  it('keeps the kick teardown order: voice → secure purge → read markers → transaction → member:left', async () => {
    redisGet.mockImplementation(async (key: string) =>
      key === 'voice:user:u-1' ? 'vc-1' : key === 'voice:channel:server:vc-1' ? 's-1' : null);

    await removeMemberFromServer('u-1', 's-1');

    expect(order).toEqual(['voice', 'secure', 'channels', 'reads', 'txn', 'left']);
    expect(purgeSecure).toHaveBeenCalledWith('u-1', 's-1');
    expect(prismaMock.channel.findMany).toHaveBeenCalledWith({ where: { serverId: 's-1', type: 'text' }, select: { id: true } });
    expect(prismaMock.channelRead.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', channelId: { in: ['ch-1', 'ch-2'] } } });
    expect(memberLeft).toHaveBeenCalledTimes(1);
    expect(memberLeft).toHaveBeenCalledWith('u-1', 's-1');
  });

  it('without a ban: join-request delete, membership delete and the guarded decrement share ONE transaction', async () => {
    await removeMemberFromServer('u-1', 's-1');

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledWith([REQ, DEL, DEC]);
    expect(prismaMock.serverBan.upsert).not.toHaveBeenCalled();
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's-1', userId: 'u-1' } });
    expect(prismaMock.serverMember.delete).toHaveBeenCalledWith({ where: { userId_serverId: { userId: 'u-1', serverId: 's-1' } } });
    // Never below zero: inline drift must not produce a negative count on a card
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
  });

  it('with a ban: the ServerBan upsert rides FIRST in the same transaction, carrying who and why', async () => {
    await removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: 'spam' } });

    expect(prismaMock.$transaction).toHaveBeenCalledWith([BAN, REQ, DEL, DEC]);
    expect(prismaMock.serverBan.upsert).toHaveBeenCalledWith({
      where: { serverId_userId: { serverId: 's-1', userId: 'u-1' } },
      create: { serverId: 's-1', userId: 'u-1', bannedById: 'mod-1', reason: 'spam' },
      // a re-ban refreshes who, why and when
      update: { bannedById: 'mod-1', reason: 'spam', createdAt: expect.any(Date) },
    });
  });

  it('stores a null reason as null (the reason is optional)', async () => {
    await removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } });
    expect(prismaMock.serverBan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { serverId: 's-1', userId: 'u-1', bannedById: 'mod-1', reason: null },
    }));
  });

  it('evicts from voice across the cluster only when the voice channel belongs to THIS server', async () => {
    redisGet.mockImplementation(async (key: string) =>
      key === 'voice:user:u-1' ? 'vc-9' : key === 'voice:channel:server:vc-9' ? 's-OTHER' : null);
    await removeMemberFromServer('u-1', 's-1');
    expect(evict).not.toHaveBeenCalled();

    vi.clearAllMocks();
    redisGet.mockImplementation(async (key: string) =>
      key === 'voice:user:u-1' ? 'vc-1' : key === 'voice:channel:server:vc-1' ? 's-1' : null);
    prismaMock.channel.findMany.mockResolvedValue([]);
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
    expect(order).toEqual(['secure', 'channels', 'reads', 'txn', 'left']);
    warn.mockRestore();
  });

  it('skips the read-marker delete when the server has no text channels', async () => {
    prismaMock.channel.findMany.mockResolvedValue([]);
    await removeMemberFromServer('u-1', 's-1');
    expect(prismaMock.channelRead.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('a member who left between the caller\'s check and the transaction answers 404 Member, not a 500', async () => {
    prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }));

    await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: 'spam' } }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Member not found' });
    expect(memberLeft).not.toHaveBeenCalled();
  });

  it('a failed transaction surfaces the error and never broadcasts member:left', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(removeMemberFromServer('u-1', 's-1', { ban: { by: 'mod-1', reason: null } })).rejects.toThrow('db gone');
    expect(memberLeft).not.toHaveBeenCalled();
  });
});
