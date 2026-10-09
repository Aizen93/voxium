import { describe, it, expect, vi, beforeEach } from 'vitest';

// joinServerMember — the ONE path that makes an existing user a server member
// (docs/local/server-discovery-plan.html). Invite joins, direct discovery joins
// and approved join requests all run through it, so the ban check, the member
// limit, the duplicate check and the inline member count are tested here once.

const prismaMock = vi.hoisted(() => ({
  serverBan: { findUnique: vi.fn() },
  serverJoinRequest: { deleteMany: vi.fn() },
  serverMember: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
  server: { update: vi.fn() },
  channel: { findMany: vi.fn() },
  channelRead: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const getEffectiveLimits = vi.hoisted(() => vi.fn());
vi.mock('../../utils/serverLimits', () => ({ getEffectiveLimits: (...a: unknown[]) => getEffectiveLimits(...a) }));

const broadcastMemberJoined = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: (...a: unknown[]) => broadcastMemberJoined(...a) }));

import { joinServerMember } from '../../utils/serverJoin';

const order: string[] = [];
const REQ = { op: 'request.deleteMany' };
const CREATE = { op: 'member.create' };
const UPDATE = { op: 'server.update' };

function unlimited() {
  getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  order.length = 0;
  prismaMock.serverBan.findUnique.mockResolvedValue(null);
  prismaMock.serverMember.findUnique.mockResolvedValue(null);
  prismaMock.serverMember.count.mockResolvedValue(3);
  // The model mocks return SENTINELS (the PrismaPromises a real client would
  // build) so the transaction's contents and order can be asserted exactly.
  prismaMock.serverJoinRequest.deleteMany.mockReturnValue(REQ);
  prismaMock.serverMember.create.mockReturnValue(CREATE);
  prismaMock.server.update.mockReturnValue(UPDATE);
  prismaMock.$transaction.mockImplementation(async () => { order.push('txn'); return []; });
  broadcastMemberJoined.mockImplementation(async () => { order.push('broadcast'); });
  prismaMock.channel.findMany.mockImplementation(async () => { order.push('channels'); return [{ id: 'ch-1' }, { id: 'ch-2' }]; });
  prismaMock.channelRead.createMany.mockImplementation(async () => { order.push('seed'); return { count: 2 }; });
  unlimited();
});

describe('joinServerMember', () => {
  it('refuses a banned user with 403 BEFORE the duplicate check, the member-limit count and the transaction', async () => {
    prismaMock.serverBan.findUnique.mockResolvedValue({ userId: 'u-1' });

    await expect(joinServerMember('u-1', 's-1', { via: 'invite' }))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/banned from this server/) });

    expect(prismaMock.serverBan.findUnique).toHaveBeenCalledWith({
      where: { serverId_userId: { serverId: 's-1', userId: 'u-1' } },
      select: { userId: true },
    });
    expect(prismaMock.serverMember.findUnique).not.toHaveBeenCalled();
    expect(getEffectiveLimits).not.toHaveBeenCalled();
    expect(prismaMock.serverMember.count).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
  });

  it('refuses an existing member with 400 and writes nothing', async () => {
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'u-1', serverId: 's-1' });

    await expect(joinServerMember('u-1', 's-1', { via: 'discovery' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/already a member/) });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
  });

  it('enforces the effective member limit against the authoritative count', async () => {
    getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 10 });
    prismaMock.serverMember.count.mockResolvedValue(10);

    await expect(joinServerMember('u-1', 's-1', { via: 'approval' })).rejects.toThrow(/member limit \(10\)/);
    expect(getEffectiveLimits).toHaveBeenCalledWith('s-1');
    expect(prismaMock.serverMember.count).toHaveBeenCalledWith({ where: { serverId: 's-1' } });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('admits the member one below the limit, and skips the count entirely when the limit is 0 (unlimited)', async () => {
    getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 10 });
    prismaMock.serverMember.count.mockResolvedValue(9);
    await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).resolves.toBeUndefined();

    vi.clearAllMocks();
    unlimited();
    prismaMock.serverBan.findUnique.mockResolvedValue(null);
    prismaMock.serverMember.findUnique.mockResolvedValue(null);
    prismaMock.channel.findMany.mockResolvedValue([]);
    await joinServerMember('u-2', 's-1', { via: 'invite' });
    expect(prismaMock.serverMember.count).not.toHaveBeenCalled();
  });

  it('commits the extra writes, the request sweep, the membership row and memberCount + 1 in ONE transaction, extra writes first', async () => {
    const INVITE_DELETE = { op: 'invite.delete' };

    await joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: [INVITE_DELETE] as never });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledWith([INVITE_DELETE, REQ, CREATE, UPDATE]);
    // a membership replaces any request the joiner had open or declined
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's-1', userId: 'u-1' } });
    expect(prismaMock.serverMember.create).toHaveBeenCalledWith({ data: { userId: 'u-1', serverId: 's-1' } });
    expect(prismaMock.server.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { memberCount: { increment: 1 } },
    });
  });

  it('works without extra writes (direct discovery join): request sweep + membership + count', async () => {
    await joinServerMember('u-1', 's-1', { via: 'discovery' });
    expect(prismaMock.$transaction).toHaveBeenCalledWith([REQ, CREATE, UPDATE]);
  });

  it('broadcasts member:joined exactly once, AFTER the transaction, then seeds reads for non-secure text channels', async () => {
    await joinServerMember('u-1', 's-1', { via: 'invite' });

    expect(order).toEqual(['txn', 'broadcast', 'channels', 'seed']);
    expect(broadcastMemberJoined).toHaveBeenCalledTimes(1);
    expect(broadcastMemberJoined).toHaveBeenCalledWith('u-1', 's-1');
    // SECURE channels are excluded from seeding — a joiner is not a member of
    // any, and seeding would leak their ids into the joiner's read rows
    expect(prismaMock.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 's-1', type: 'text', secure: false },
      select: { id: true },
    });
    expect(prismaMock.channelRead.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: 'u-1', channelId: 'ch-1', lastReadAt: expect.any(Date) }),
        expect.objectContaining({ userId: 'u-1', channelId: 'ch-2', lastReadAt: expect.any(Date) }),
      ],
      skipDuplicates: true,
    });
  });

  it('skips the seeding write when the server has no text channels', async () => {
    prismaMock.channel.findMany.mockResolvedValue([]);
    await joinServerMember('u-1', 's-1', { via: 'invite' });
    expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
  });

  it('a failed extra write fails the whole transaction: no membership, no broadcast, no seeding', async () => {
    // The invite delete finds no row (already consumed) — Prisma P2025
    const consumed = Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
    prismaMock.$transaction.mockRejectedValue(consumed);

    await expect(joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: [{ op: 'invite.delete' }] as never }))
      .rejects.toBe(consumed);
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
    expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
  });

  it('maps a concurrent duplicate join (P2002 on the composite key) to "already a member", not a 500', async () => {
    prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    await expect(joinServerMember('u-1', 's-1', { via: 'discovery' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/already a member/) });
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
  });
});
