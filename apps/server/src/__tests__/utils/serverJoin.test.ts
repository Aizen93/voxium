import { describe, it, expect, vi, beforeEach } from 'vitest';

// joinServerMember — the ONE path that makes an existing user a server member
// (docs/local/server-discovery-plan.html). Invite joins, direct discovery joins
// and approved join requests all run through it, so the ban check, the member
// limit, the duplicate check and the inline member count are tested here once.

const prismaMock = vi.hoisted(() => ({
  serverBan: { findUnique: vi.fn() },
  serverJoinRequest: { deleteMany: vi.fn(), findUnique: vi.fn() },
  serverMember: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  server: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  channel: { findMany: vi.fn(), deleteMany: vi.fn() },
  channelMember: { deleteMany: vi.fn() },
  channelRead: { createMany: vi.fn() },
  $transaction: vi.fn(),
  // the space row lock the join transaction takes first
  $queryRaw: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const getEffectiveLimits = vi.hoisted(() => vi.fn());
vi.mock('../../utils/serverLimits', () => ({ getEffectiveLimits: (...a: unknown[]) => getEffectiveLimits(...a) }));

const broadcastMemberJoined = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: (...a: unknown[]) => broadcastMemberJoined(...a) }));

const emitToModerators = vi.hoisted(() => vi.fn());
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: (...a: unknown[]) => emitToModerators(...a) }));

import { joinServerMember } from '../../utils/serverJoin';
import { lazyStatement } from '../helpers/lazyStatement';

const order: string[] = [];
const REQ = { op: 'request.deleteMany' };
const CREATE = { op: 'member.create' };
const UPDATE = { op: 'server.update' };
const RESET = { op: 'channelMember.deleteMany' };

function unlimited() {
  getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  order.length = 0;
  prismaMock.serverBan.findUnique.mockResolvedValue(null);
  prismaMock.serverMember.findUnique.mockResolvedValue(null);
  prismaMock.serverJoinRequest.findUnique.mockResolvedValue(null);
  prismaMock.serverMember.count.mockResolvedValue(3);
  emitToModerators.mockImplementation(async () => { order.push('resolved'); });
  // The model mocks return SENTINELS (the PrismaPromises a real client would
  // build) so the transaction's contents and order can be asserted exactly.
  prismaMock.serverJoinRequest.deleteMany.mockReturnValue(REQ);
  prismaMock.serverMember.create.mockReturnValue(CREATE);
  prismaMock.server.update.mockReturnValue(UPDATE);
  prismaMock.channelMember.deleteMany.mockReturnValue(RESET);
  // The join runs one interactive transaction on this same mock as its client
  prismaMock.$queryRaw.mockResolvedValue([{ id: 's-1' }]);
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => { order.push('txn'); return fn(prismaMock); });
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

  describe('the rows the transaction takes after the space row are waited for before it opens', () => {
    /**
     * The transaction's own client: the root's models, but an identity and a
     * raw statement of its own, so a statement run on the wrong client, or a
     * client handed to the wrong caller, is told apart.
     */
    const tx = { ...prismaMock, $queryRaw: vi.fn() };
    /**
     * Every raw statement, named when it RUNS (a shared-client statement when
     * it is awaited, as a PrismaPromise runs; built and never awaited, it
     * never runs), with `txn` marking where the transaction opens and `tx:`
     * the statements on the transaction's client.
     */
    function recordWaits(): string[] {
      const seen: string[] = [];
      const name = (sql: string) => {
        if (sql.includes('FROM servers') && sql.includes('FOR UPDATE')) return 'lock:space';
        if (sql.includes('FROM server_join_requests') && sql.includes('FOR UPDATE')) return 'wait:requests';
        if (sql.includes('FROM channel_members') && sql.includes('FOR UPDATE')) return 'wait:secure-rows';
        if (sql.includes('FROM users') && sql.includes('FOR KEY SHARE')) return 'wait:account';
        return `raw:${sql}`;
      };
      prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
        lazyStatement(seen, name(strings.join('?')), [{ id: 's-1' }]));
      tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => { seen.push(`tx:${name(strings.join('?'))}`); return [{ id: 's-1' }]; });
      prismaMock.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => { seen.push('txn'); return fn(tx); });
      return seen;
    }
    /** The invite route's statement: lazy, run on the client it is handed. */
    const inviteWait = (seen: string[]) => vi.fn((_db: unknown) => lazyStatement(seen, 'wait:invite', []));
    const sqlOf = (i: number) => {
      const [strings, ...values] = prismaMock.$queryRaw.mock.calls[i] as [TemplateStringsArray, ...unknown[]];
      return { sql: strings.join('?').replace(/\s+/g, ' '), values };
    };

    it('the joiner\'s join requests and secure-channel rows in the space, the joiner\'s account row, then the caller\'s rows: each its own statement, before the transaction', async () => {
      const seen = recordWaits();
      const awaitRows = inviteWait(seen);

      await joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: () => [], awaitRows });

      expect(seen.slice(0, seen.indexOf('tx:lock:space') + 1)).toEqual(['wait:requests', 'wait:secure-rows', 'wait:account', 'wait:invite', 'txn', 'tx:lock:space']);
      // the caller's statement runs on the shared client, outside the transaction
      expect(awaitRows).toHaveBeenCalledWith(prismaMock);
      expect(awaitRows).not.toHaveBeenCalledWith(tx);
      expect(sqlOf(0)).toEqual({ sql: 'SELECT id FROM server_join_requests WHERE server_id = ? AND user_id = ? FOR UPDATE', values: ['s-1', 'u-1'] });
      expect(sqlOf(1).sql).toMatch(/FROM channel_members cm JOIN channels c ON c\.id = cm\.channel_id WHERE cm\.user_id = \? AND c\.server_id = \? FOR UPDATE OF cm/);
      expect(sqlOf(1).values).toEqual(['u-1', 's-1']);
      expect(sqlOf(2)).toEqual({ sql: 'SELECT id FROM users WHERE id = ? FOR KEY SHARE', values: ['u-1'] });
    });

    it('waits again before each attempt: a retried transaction meets the rows as they are then', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const seen = recordWaits();
      const awaitRows = inviteWait(seen);
      let attempt = 0;
      prismaMock.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
        seen.push('txn');
        if (attempt++ === 0) throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
        return fn(tx);
      });
      try {
        await joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: () => [], awaitRows });

        const waits = ['wait:requests', 'wait:secure-rows', 'wait:account', 'wait:invite'];
        expect(seen.slice(0, 11)).toEqual([...waits, 'txn', ...waits, 'txn', 'tx:lock:space']);
        expect(awaitRows).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });

    it('a direct join waits for its own rows only', async () => {
      const seen = recordWaits();
      await joinServerMember('u-1', 's-1', { via: 'discovery' });
      expect(seen.slice(0, seen.indexOf('tx:lock:space') + 1)).toEqual(['wait:requests', 'wait:secure-rows', 'wait:account', 'txn', 'tx:lock:space']);
    });

    it('a refusal before the transaction waits for nothing', async () => {
      const seen = recordWaits();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'u-1' });
      await expect(joinServerMember('u-1', 's-1', { via: 'discovery' })).rejects.toMatchObject({ statusCode: 400 });
      expect(seen).toEqual([]);
    });
  });

  describe('the join transaction holds its checks on every attempt', () => {
    /** The statements of the join transaction, in the order they run. */
    function recordStatements(): string[] {
      const seen: string[] = [];
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        seen.push(strings.join('?').includes('FROM servers') && strings.join('?').includes('FOR UPDATE') ? 'lock:space' : 'raw');
        return [{ id: 's-1' }];
      });
      prismaMock.serverBan.findUnique.mockImplementation(async () => { seen.push('ban?'); return null; });
      prismaMock.serverMember.findUnique.mockImplementation(async () => { seen.push('member?'); return null; });
      prismaMock.serverMember.count.mockImplementation(async () => { seen.push('count?'); return 3; });
      prismaMock.serverJoinRequest.deleteMany.mockImplementation(async () => { seen.push('request'); return { count: 0 }; });
      prismaMock.channelMember.deleteMany.mockImplementation(async () => { seen.push('reset'); return { count: 0 }; });
      prismaMock.serverMember.create.mockImplementation(async () => { seen.push('create'); return {}; });
      prismaMock.server.update.mockImplementation(async () => { seen.push('count+1'); return {}; });
      return seen;
    }

    it('locks the space row first, then runs the extra writes, re-checks the ban, the duplicate and the limit, then writes', async () => {
      getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 10 });
      const seen = recordStatements();
      const inviteDelete = vi.fn(async () => { seen.push('invite.delete'); return {}; });

      await joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: () => [inviteDelete()] });

      // the checks before the transaction, then the transaction's own
      const inTx = seen.slice(seen.indexOf('lock:space'));
      // (the last ban? is the backstop re-read after the commit)
      expect(inTx).toEqual(['lock:space', 'invite.delete', 'ban?', 'member?', 'count?', 'request', 'reset', 'create', 'count+1', 'ban?']);
      // a membership replaces any request the joiner had open or declined
      expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's-1', userId: 'u-1' } });
      // every channel of the space: a row an earlier membership left is never honoured again
      expect(prismaMock.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', channel: { serverId: 's-1' } } });
      expect(prismaMock.serverMember.create).toHaveBeenCalledWith({ data: { userId: 'u-1', serverId: 's-1' } });
      expect(prismaMock.server.update).toHaveBeenCalledWith({ where: { id: 's-1' }, data: { memberCount: { increment: 1 } } });
    });

    it('gives the transaction the long budget: the space row it waits for is held through an account deletion\'s cascade', async () => {
      await joinServerMember('u-1', 's-1', { via: 'invite' });

      // Under Prisma's 5 s default the wait alone expired the join (P2028, a 500)
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
    });

    it('builds the extra writes on each attempt\'s own transaction client', async () => {
      const clients: unknown[] = [];
      await joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: (tx) => { clients.push(tx); return []; } });
      expect(clients).toEqual([prismaMock]);
    });

    it('works without extra writes (direct discovery join)', async () => {
      const seen = recordStatements();
      await joinServerMember('u-1', 's-1', { via: 'discovery' });
      expect(seen.slice(seen.indexOf('lock:space'))).toEqual(['lock:space', 'ban?', 'member?', 'request', 'reset', 'create', 'count+1', 'ban?']);
    });

    it('a ban that committed after the first check is refused INSIDE the transaction, before any write', async () => {
      prismaMock.serverBan.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: 'u-1' });

      await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).rejects.toMatchObject({ statusCode: 403 });
      expect(prismaMock.serverMember.create).not.toHaveBeenCalled();
      expect(broadcastMemberJoined).not.toHaveBeenCalled();
    });

    it('a space filled since the first check is refused INSIDE the transaction, counted under the space row lock', async () => {
      getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 10 });
      prismaMock.serverMember.count.mockResolvedValueOnce(9).mockResolvedValueOnce(10);

      await expect(joinServerMember('u-1', 's-1', { via: 'invite' }))
        .rejects.toMatchObject({ statusCode: 400, message: 'This server has reached its member limit (10)' });
      expect(prismaMock.serverMember.create).not.toHaveBeenCalled();
    });

    it('a refusal at the limit inside the transaction is the answer: never retried, the extra writes roll back with it', async () => {
      getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 10 });
      // nine when it looked; ten under the lock, a join committed meanwhile
      prismaMock.serverMember.count.mockResolvedValueOnce(9).mockResolvedValueOnce(10);
      const inviteDelete = vi.fn(async () => ({}));

      await expect(joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: () => [inviteDelete()] }))
        .rejects.toMatchObject({ statusCode: 400, message: 'This server has reached its member limit (10)' });

      // the invite delete ran in the transaction the refusal rolls back
      expect(inviteDelete).toHaveBeenCalledTimes(1);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(prismaMock.server.update).not.toHaveBeenCalled();
      expect(broadcastMemberJoined).not.toHaveBeenCalled();
      expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
    });

    it('admits the join that brings the space exactly to its limit', async () => {
      getEffectiveLimits.mockResolvedValue({ maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 10 });
      // nine members under the lock, before this join's own row
      prismaMock.serverMember.count.mockResolvedValueOnce(8).mockResolvedValueOnce(9);

      await expect(joinServerMember('u-1', 's-1', { via: 'discovery' })).resolves.toBeUndefined();
      expect(prismaMock.serverMember.create).toHaveBeenCalledTimes(1);
      expect(broadcastMemberJoined).toHaveBeenCalledTimes(1);
    });

    it('a space deleted since the first check answers 404 Server, not a foreign-key 500', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).rejects.toMatchObject({ statusCode: 404, message: 'Server not found' });
      expect(prismaMock.serverMember.create).not.toHaveBeenCalled();
    });

    it('a join PostgreSQL aborted to break a deadlock (a space delete, an account deletion) runs again whole, the extra writes rebuilt', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => { throw Object.assign(new Error('deadlock'), { code: 'P2034' }); })
        .mockImplementation(real);
      const extraWrites = vi.fn(() => []);
      try {
        await joinServerMember('u-1', 's-1', { via: 'invite', extraWrites });

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(extraWrites).toHaveBeenCalledTimes(1); // the aborted attempt ran nothing
        expect(prismaMock.serverMember.create).toHaveBeenCalledTimes(1);
        expect(broadcastMemberJoined).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
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

  it('a PENDING request this join sweeps is reported to the moderators as resolved (joined), after the rooms are joined', async () => {
    prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ status: 'pending' });

    await joinServerMember('u-1', 's-1', { via: 'invite' });

    expect(prismaMock.serverJoinRequest.findUnique).toHaveBeenCalledWith({ where: { serverId_userId: { serverId: 's-1', userId: 'u-1' } }, select: { status: true } });
    expect(emitToModerators).toHaveBeenCalledWith('s-1', 'server:join_request_resolved', { serverId: 's-1', userId: 'u-1', outcome: 'joined' });
    expect(order.indexOf('resolved')).toBeGreaterThan(order.indexOf('broadcast'));
  });

  it('says nothing to the moderators when there was no pending request, when the row was declined, or when THEY are approving (that route emits its own)', async () => {
    await joinServerMember('u-1', 's-1', { via: 'discovery' });
    prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ status: 'declined' });
    await joinServerMember('u-1', 's-1', { via: 'discovery' });
    expect(emitToModerators).not.toHaveBeenCalled();

    prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ status: 'pending' });
    await joinServerMember('u-1', 's-1', { via: 'approval', extraWrites: () => [] });
    expect(emitToModerators).not.toHaveBeenCalled();
    // the approval path does not even look: its extra write IS the row
    expect(prismaMock.serverJoinRequest.findUnique).toHaveBeenCalledTimes(2);
  });

  it('skips the seeding write when the server has no text channels', async () => {
    prismaMock.channel.findMany.mockResolvedValue([]);
    await joinServerMember('u-1', 's-1', { via: 'invite' });
    expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
  });

  it('a failed extra write fails the whole transaction: no membership, no broadcast, no seeding', async () => {
    // The invite delete finds no row (already consumed) — Prisma P2025
    const consumed = Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });

    await expect(joinServerMember('u-1', 's-1', { via: 'invite', extraWrites: () => [Promise.reject(consumed)] }))
      .rejects.toBe(consumed);
    // never retried: a consumed invite is the answer
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.serverMember.create).not.toHaveBeenCalled();
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
    expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
  });

  it('a kick that commits mid-join (the ban row appears after the first check) rolls the membership back and refuses', async () => {
    prismaMock.serverBan.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: 'u-1' });
    prismaMock.serverMember.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.server.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction
      .mockImplementationOnce(async () => { order.push('txn'); return []; })
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => { order.push('undo'); await fn(prismaMock); });
    prismaMock.serverMember.deleteMany.mockImplementation(async () => { order.push('member'); return { count: 1 }; });
    prismaMock.channel.deleteMany.mockImplementation(async () => { order.push('created-channels'); return { count: 0 }; });
    prismaMock.channelMember.deleteMany.mockImplementation(async () => { order.push('rows'); return { count: 1 }; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).rejects.toMatchObject({ statusCode: 403 });

    expect(order).toEqual(['txn', 'undo', 'member', 'created-channels', 'rows']);
    // the long budget too: its channel delete and its count update wait on
    // rows an account deletion holds through its cascade
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
    expect(prismaMock.serverMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', serverId: 's-1' } });
    // The membership was real for a moment: a secure-channel row written
    // meanwhile, or a secure channel the joiner created, goes with it, after
    // the member row (its writer locked that row first)
    expect(prismaMock.channel.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's-1', createdById: 'u-1', secure: true } });
    expect(prismaMock.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', channel: { serverId: 's-1' } } });
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({ where: { id: 's-1', memberCount: { gt: 0 } }, data: { memberCount: { decrement: 1 } } });
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
    expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the kick that raced the join can also have removed the row itself: nothing is decremented twice', async () => {
    prismaMock.serverBan.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: 'u-1' });
    prismaMock.serverMember.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.$transaction
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => { await fn(prismaMock); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).rejects.toMatchObject({ statusCode: 403 });
    expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
    // the kick's own transaction removed the secure-channel rows with the membership
    expect(prismaMock.channel.deleteMany).not.toHaveBeenCalled();
  });

  describe('a space deleted while the join runs answers 404 Server, never a foreign-key 500', () => {
    /** A foreign-key violation as the pg adapter reports it (shape printed from a real one). */
    const fk = (constraint: string, table: string) => Object.assign(
      new Error(`Foreign key constraint violated on the constraint: \`${constraint}\``),
      {
        code: 'P2003',
        meta: {
          modelName: table,
          driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23503', kind: 'ForeignKeyConstraintViolation', constraint: { index: constraint } } },
        },
      },
    );

    it('the membership\'s key to the space refused inside the transaction', async () => {
      prismaMock.$transaction.mockRejectedValue(fk('server_members_server_id_fkey', 'ServerMember'));

      await expect(joinServerMember('u-1', 's-1', { via: 'discovery' }))
        .rejects.toMatchObject({ statusCode: 404, message: 'Server not found' });
      expect(broadcastMemberJoined).not.toHaveBeenCalled();
    });

    it('matched by the constraint the adapter names, even when the message does not quote it', async () => {
      const err = fk('server_members_server_id_fkey', 'ServerMember');
      err.message = 'Foreign key constraint violated';
      prismaMock.$transaction.mockRejectedValue(err);

      await expect(joinServerMember('u-1', 's-1', { via: 'discovery' }))
        .rejects.toMatchObject({ statusCode: 404, message: 'Server not found' });
    });

    it('a joiner whose account was deleted while the join ran answers 404 User, not a missing space nor a 500', async () => {
      prismaMock.$transaction.mockRejectedValue(fk('server_members_user_id_fkey', 'ServerMember'));

      await expect(joinServerMember('u-1', 's-1', { via: 'invite' }))
        .rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
      expect(broadcastMemberJoined).not.toHaveBeenCalled();
      expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
    });

    it('the joiner\'s key matched by the constraint the adapter names, even when the message does not quote it', async () => {
      const err = fk('server_members_user_id_fkey', 'ServerMember');
      err.message = 'Foreign key constraint violated';
      prismaMock.$transaction.mockRejectedValue(err);

      await expect(joinServerMember('u-1', 's-1', { via: 'approval' }))
        .rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
    });

    it('any other foreign key stays what it is', async () => {
      const err = fk('channel_members_channel_id_fkey', 'ChannelMember');
      prismaMock.$transaction.mockRejectedValue(err);

      await expect(joinServerMember('u-1', 's-1', { via: 'discovery' })).rejects.toBe(err);
    });

    it('the joiner\'s account deleted after the commit, before the read markers are seeded, answers 404 User', async () => {
      prismaMock.channelRead.createMany.mockRejectedValueOnce(fk('channel_reads_user_id_fkey', 'ChannelRead'));

      await expect(joinServerMember('u-1', 's-1', { via: 'discovery' }))
        .rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
      // seeded once, never read again as if a channel had gone
      expect(prismaMock.channelRead.createMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.server.findUnique).not.toHaveBeenCalled();
    });

    it('the space deleted after the commit, before the read markers are seeded (its channels went with it)', async () => {
      prismaMock.channelRead.createMany.mockRejectedValueOnce(fk('channel_reads_channel_id_fkey', 'ChannelRead'));
      prismaMock.server.findUnique.mockResolvedValueOnce(null);

      await expect(joinServerMember('u-1', 's-1', { via: 'invite' }))
        .rejects.toMatchObject({ statusCode: 404, message: 'Server not found' });
      expect(prismaMock.server.findUnique).toHaveBeenCalledWith({ where: { id: 's-1' }, select: { id: true } });
      expect(prismaMock.channelRead.createMany).toHaveBeenCalledTimes(1);
    });

    it('one channel deleted before the markers are seeded, the space still there: the channels are read again and seeded once more', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.channelRead.createMany.mockRejectedValueOnce(fk('channel_reads_channel_id_fkey', 'ChannelRead'));
      prismaMock.channel.findMany
        .mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-gone' }])
        .mockResolvedValueOnce([{ id: 'ch-1' }]);
      prismaMock.server.findUnique.mockResolvedValueOnce({ id: 's-1' });
      try {
        await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).resolves.toBeUndefined();
        expect(prismaMock.channelRead.createMany).toHaveBeenCalledTimes(2);
        expect(prismaMock.channelRead.createMany).toHaveBeenLastCalledWith({
          data: [expect.objectContaining({ userId: 'u-1', channelId: 'ch-1' })],
          skipDuplicates: true,
        });
        expect(warn).toHaveBeenCalledWith('[ServerJoin] A channel of s-1 was deleted while u-1\'s read markers were seeded; seeding again');
      } finally {
        warn.mockRestore();
      }
    });

    it('any other seeding failure is not turned into a not-found', async () => {
      const err = new Error('db gone');
      prismaMock.channelRead.createMany.mockRejectedValueOnce(err);

      await expect(joinServerMember('u-1', 's-1', { via: 'invite' })).rejects.toBe(err);
    });
  });

  it('maps a concurrent duplicate join (P2002 on the composite key) to "already a member", not a 500', async () => {
    prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    await expect(joinServerMember('u-1', 's-1', { via: 'discovery' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/already a member/) });
    expect(broadcastMemberJoined).not.toHaveBeenCalled();
  });
});
