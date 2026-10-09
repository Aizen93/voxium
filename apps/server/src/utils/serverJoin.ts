import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { BadRequestError, ForbiddenError } from './errors';
import { getEffectiveLimits } from './serverLimits';
import { broadcastMemberJoined } from './memberBroadcast';
import { emitToModerators } from './moderatorAudience';
import { WS_EVENTS } from '@voxium/shared';

/** Which door the member came through — logged, never a branch. */
export type JoinServerVia = 'invite' | 'discovery' | 'approval';

export interface JoinServerOptions {
  via: JoinServerVia;
  /**
   * Writes that must commit WITH the membership, in the same transaction and
   * before it: the invite route passes `invite.delete({ where: { code } })`,
   * the approval route the join-request delete. If one of them finds no row
   * the whole transaction fails and no membership is created — which is what
   * keeps a single-use invite from being consumed twice.
   */
  extraWrites?: Prisma.PrismaPromise<unknown>[];
}

/**
 * The ONE path that makes an existing user a member of a server (the creator
 * is made a member inside server creation). Invite joins, direct discovery
 * joins and approved join requests all come through here, so the ban check,
 * the member limit, the duplicate check and the inline member count live here
 * and nowhere else (docs/local/server-discovery-plan.html).
 *
 * Order: ban (403) → already a member (400) → member limit (400) → one
 * transaction (extra writes, membership row, memberCount + 1) → the room
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

  // Enforce max members per server. The authoritative count, not the inline
  // column — the column is for ranking and the nightly pass may still be
  // correcting it.
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

  try {
    await prisma.$transaction([
      ...(opts.extraWrites ?? []),
      // A membership replaces any request the joiner had open or declined
      // here (an open-mode join after the owner switched modes, an invite
      // used while a request was pending). The approval route still passes
      // its single-row delete as an extra write: THAT one must fail when the
      // row is gone (double approval), this one is a sweep.
      prisma.serverJoinRequest.deleteMany({ where: { serverId, userId } }),
      prisma.serverMember.create({
        data: { userId, serverId },
      }),
      prisma.server.update({
        where: { id: serverId },
        data: { memberCount: { increment: 1 } },
      }),
    ]);
  } catch (err) {
    // Two concurrent joins by the same user: the second one's create hits the
    // composite primary key. That is "already a member", not a 500.
    if ((err as { code?: unknown })?.code === 'P2002') {
      throw new BadRequestError('You are already a member of this server');
    }
    throw err;
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
}
