import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from './errors';
import { getEffectiveLimits } from './serverLimits';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from './transactionRetry';
import { broadcastMemberJoined } from './memberBroadcast';
import { emitToModerators } from './moderatorAudience';
import { WS_EVENTS } from '@voxium/shared';

/**
 * A foreign-key violation (P2003) on `constraint`, as the driver names it
 * (the adapter's constraint index, or the message that quotes it).
 */
function violatesForeignKey(err: unknown, constraint: string): boolean {
  const e = err as {
    code?: unknown;
    message?: unknown;
    meta?: { constraint?: unknown; field_name?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } };
  } | null;
  if (e?.code !== 'P2003') return false;
  const named = [e.message, e.meta?.constraint, e.meta?.field_name, e.meta?.driverAdapterError?.cause?.constraint?.index];
  return named.some((v) => typeof v === 'string' && v.includes(constraint));
}

/** Which door the member came through — logged, never a branch. */
export type JoinServerVia = 'invite' | 'discovery' | 'approval';

export interface JoinServerOptions {
  via: JoinServerVia;
  /**
   * Writes that must commit WITH the membership, in the same transaction and
   * before it, built on that transaction's client for EACH attempt (the
   * transaction can run again after a deadlock): the invite route passes
   * `(tx) => [tx.invite.delete({ where: { code } })]`, the approval route the
   * join-request delete. If one of them finds no row the whole transaction
   * fails and no membership is created — which is what keeps a single-use
   * invite from being consumed twice, on every attempt.
   */
  extraWrites?: (tx: Prisma.TransactionClient) => Array<Promise<unknown>>;
  /**
   * The rows the extra writes take, waited for before each attempt's
   * transaction opens, on the client given (the shared one), outside any
   * transaction: a statement that locks them and lets them go as soon as it
   * has them (`SELECT … FOR UPDATE`). The invite route passes its invite. The
   * approval route passes nothing: the join waits for the joiner's own join
   * requests in the space itself (see waitForJoinRows).
   */
  awaitRows?: (db: typeof prisma) => Promise<unknown>;
}

/**
 * Before a join's transaction: wait, holding nothing, for the existing rows
 * that transaction takes after the space row, so that whatever transaction
 * holds one of them is waited for before the space row is taken, and the
 * space's other joins and creations do not queue behind this one. One
 * statement per kind of row, each on the shared client and outside any
 * transaction, so each lock is let go as soon as it is granted and no
 * statement holds a row while it waits for the next. The rows: the joiner's
 * join requests in the space (the sweep below, and the approval route's
 * settle of the same row), the joiner's secure-channel rows in the space
 * (the reset below), the joiner's account row in the mode the membership's
 * key takes it, then the caller's rows (`awaitRows`). Inside the transaction
 * the space row stays first, as in a space delete, which reaches invites and
 * join requests through its cascade after the space row.
 */
async function waitForJoinRows(userId: string, serverId: string, opts: JoinServerOptions): Promise<void> {
  await prisma.$queryRaw`SELECT id FROM server_join_requests WHERE server_id = ${serverId} AND user_id = ${userId} FOR UPDATE`;
  await prisma.$queryRaw`
    SELECT cm.channel_id FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
    WHERE cm.user_id = ${userId} AND c.server_id = ${serverId} FOR UPDATE OF cm`;
  await prisma.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR KEY SHARE`;
  if (opts.awaitRows) await opts.awaitRows(prisma);
}

/**
 * The ONE path that makes an existing user a member of a server (the creator
 * is made a member inside server creation). Invite joins, direct discovery
 * joins and approved join requests all come through here, so the ban check,
 * the member limit, the duplicate check and the inline member count live here
 * and nowhere else (docs/local/server-discovery-plan.html).
 *
 * Order: ban (403) → already a member (400) → member limit (400) → a wait,
 * holding nothing, for the rows the transaction takes after the space row
 * (waitForJoinRows) → one transaction, retried on a deadlock and holding
 * those three checks again under the space row lock (extra writes, any secure-channel row an earlier
 * membership left, membership row, memberCount + 1) → the room
 * invariant (broadcastMemberJoined joins the sockets to `server:{id}` and the
 * visible `channel:{id}` rooms) → ChannelRead seeding for the server's
 * non-secure text channels so existing history does not show as unread.
 */
export async function joinServerMember(userId: string, serverId: string, opts: JoinServerOptions): Promise<void> {
  // Every removal is a ban; the row is what refuses the way back in, by
  // invite, direct join or request alike. Checked first: a banned user gets
  // the same answer whatever else is true of the server.
  const ban = await prisma.serverBan.findUnique({
    where: { serverId_userId: { serverId, userId } },
    select: { userId: true },
  });
  if (ban) throw new ForbiddenError('You are banned from this server');

  const existing = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { userId: true },
  });
  if (existing) throw new BadRequestError('You are already a member of this server');

  // Enforce max members per server (0: no limit). The authoritative count,
  // not the inline column — the column is for ranking and the nightly pass
  // may still be correcting it. This count only refuses a full space early,
  // without writing; the one that holds is counted again in the transaction.
  const limits = await getEffectiveLimits(serverId);
  if (limits.maxMembersPerServer > 0) {
    const memberCount = await prisma.serverMember.count({ where: { serverId } });
    if (memberCount >= limits.maxMembersPerServer) {
      throw new BadRequestError(`This server has reached its member limit (${limits.maxMembersPerServer})`);
    }
  }

  // A pending request this join resolves by another door (an open-mode join
  // after the owner switched modes, an invite used while a request waited):
  // the transaction below sweeps the row, and the moderators must hear it
  // the same way they hear an approve or a decline, or their badge and the
  // Members tab keep a request that answers 404 on Approve.
  const pending = opts.via === 'approval'
    ? null
    : await prisma.serverJoinRequest.findUnique({
        where: { serverId_userId: { serverId, userId } },
        select: { status: true },
      });

  // The checks above are a fast answer; the transaction holds them again on
  // every attempt, since PostgreSQL may abort it to break a deadlock with a
  // space delete or an account deletion and it then runs again. Each attempt
  // first waits, holding nothing, for the rows it takes after the space row
  // (waitForJoinRows). Then the transaction: the space row first (FOR
  // UPDATE, the order a space delete and a transfer take it in), so the
  // member limit is counted with no other join in between, then the extra
  // writes (a consumed invite fails them), the ban, the duplicate. The long
  // budget: a transaction holding the space row is waited for inside it
  // (LOCK_WAIT_TRANSACTION_OPTIONS).
  try {
    await retryOnTransactionConflict(async () => {
      await waitForJoinRows(userId, serverId, opts);
      return prisma.$transaction(async (tx) => {
        const space = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM servers WHERE id = ${serverId} FOR UPDATE`;
        if (space.length === 0) throw new NotFoundError('Server');
        for (const write of opts.extraWrites?.(tx) ?? []) await write;
        const bannedNow = await tx.serverBan.findUnique({
          where: { serverId_userId: { serverId, userId } },
          select: { userId: true },
        });
        if (bannedNow) throw new ForbiddenError('You are banned from this server');
        const memberNow = await tx.serverMember.findUnique({
          where: { userId_serverId: { userId, serverId } },
          select: { userId: true },
        });
        if (memberNow) throw new BadRequestError('You are already a member of this server');
        if (limits.maxMembersPerServer > 0) {
          const countNow = await tx.serverMember.count({ where: { serverId } });
          if (countNow >= limits.maxMembersPerServer) {
            throw new BadRequestError(`This server has reached its member limit (${limits.maxMembersPerServer})`);
          }
        }
        // A membership replaces any request the joiner had open or declined
        // here (an open-mode join after the owner switched modes, an invite
        // used while a request was pending). The approval route still passes
        // its single-row delete as an extra write: THAT one must fail when the
        // row is gone (double approval), this one is a sweep.
        await tx.serverJoinRequest.deleteMany({ where: { serverId, userId } });
        // A membership starts with no secure-channel row: access to a secure
        // channel is derived from its ChannelMember rows alone, so one an
        // earlier membership of this space left behind must not be honoured
        // again. Every channel of the space (rows exist only for secure ones).
        await tx.channelMember.deleteMany({ where: { userId, channel: { serverId } } });
        await tx.serverMember.create({ data: { userId, serverId } });
        await tx.server.update({ where: { id: serverId }, data: { memberCount: { increment: 1 } } });
      }, LOCK_WAIT_TRANSACTION_OPTIONS);
    }, `[ServerJoin] The join of ${userId} to ${serverId}`);
  } catch (err) {
    // Two concurrent joins by the same user: the second one's create hits the
    // composite primary key. That is "already a member", not a 500.
    if ((err as { code?: unknown })?.code === 'P2002') {
      throw new BadRequestError('You are already a member of this server');
    }
    // The membership's key to the space refused: the space is gone, the
    // answer for a space that does not exist (the row lock above normally
    // finds that first).
    if (violatesForeignKey(err, 'server_members_server_id_fkey')) throw new NotFoundError('Server');
    // Its key to the joiner refused: the joiner's account was deleted while
    // the join ran (the insert's key check waits for that deletion, which
    // holds the account row through its cascade, then finds no row). The
    // joiner is the caller of an invite or discovery join, the requester of
    // an approval (whose request goes with the account, so that route
    // usually meets the missing request first): the account does not exist.
    if (violatesForeignKey(err, 'server_members_user_id_fkey')) throw new NotFoundError('User');
    throw err;
  }

  // The ban check above and the transaction are separate statements: a kick
  // that committed between them (ban upsert + member delete, one transaction)
  // has just been undone by the create. Nothing has been broadcast or joined
  // yet, so re-read the ban after the commit and compensate: the row and the
  // counter, only if the row is still ours to remove. The same long budget:
  // its channel delete waits on a secure channel an account deletion holds
  // through its cascade, its count update on the space row a space delete
  // holds through its own.
  const banAfter = await prisma.serverBan.findUnique({
    where: { serverId_userId: { serverId, userId } },
    select: { userId: true },
  });
  if (banAfter) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.serverMember.deleteMany({ where: { userId, serverId } });
      if (count > 0) {
        // The membership was real for a moment: a secure-channel row written
        // meanwhile (its writer locked the member row, the delete above waited
        // for it) goes with it, and so does a secure channel created by the
        // joiner, whose rows cascade
        await tx.channel.deleteMany({ where: { serverId, createdById: userId, secure: true } });
        await tx.channelMember.deleteMany({ where: { userId, channel: { serverId } } });
        await tx.server.updateMany({ where: { id: serverId, memberCount: { gt: 0 } }, data: { memberCount: { decrement: 1 } } });
      }
    }, LOCK_WAIT_TRANSACTION_OPTIONS);
    console.warn(`[ServerJoin] User ${userId} was banned from ${serverId} mid-join; the membership was rolled back`);
    throw new ForbiddenError('You are banned from this server');
  }

  console.log(`[ServerJoin] User ${userId} joined server ${serverId} via ${opts.via}`);

  // Notify all members and add the joiner's socket(s) to the server room
  await broadcastMemberJoined(userId, serverId);

  if (pending?.status === 'pending') {
    await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'joined' });
  }

  // Seed ChannelRead for all text channels so existing history doesn't show
  // as unread. Secure channels excluded: a joiner is not a member of any,
  // and seeding would leak their ids into the joiner's read rows.
  const seedReads = async (): Promise<void> => {
    const textChannels = await prisma.channel.findMany({
      where: { serverId, type: 'text', secure: false },
      select: { id: true },
    });
    if (textChannels.length > 0) {
      const now = new Date();
      await prisma.channelRead.createMany({
        data: textChannels.map((ch) => ({
          userId,
          channelId: ch.id,
          lastReadAt: now,
        })),
        skipDuplicates: true,
      });
    }
  };
  try {
    await seedReads();
  } catch (err) {
    // The joiner's account deleted since the commit (its deletion took the
    // new membership with the row): the account does not exist.
    if (violatesForeignKey(err, 'channel_reads_user_id_fkey')) throw new NotFoundError('User');
    // A channel read above was deleted before the insert: the whole space,
    // being deleted since the commit, answers as a space that does not
    // exist; a single channel deleted meanwhile leaves the others to seed,
    // read again once.
    if (!violatesForeignKey(err, 'channel_reads_channel_id_fkey')) throw err;
    const space = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!space) throw new NotFoundError('Server');
    console.warn(`[ServerJoin] A channel of ${serverId} was deleted while ${userId}'s read markers were seeded; seeding again`);
    await seedReads();
  }
}
