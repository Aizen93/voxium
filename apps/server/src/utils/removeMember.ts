import { prisma } from './prisma';
import { getRedis } from './redis';
import { getIO } from '../websocket/socketServer';
import { broadcastVoiceEvictUser } from '../websocket/voiceCluster';
import { purgeSecureChannelState } from './secureChannelLifecycle';
import { broadcastMemberLeft } from './memberBroadcast';

export interface RemoveMemberOptions {
  /**
   * Write a ServerBan row in the same transaction as the membership delete.
   * Kick passes it (every removal is a ban); a voluntary leave does not.
   */
  ban?: { by: string; reason: string | null };
}

/**
 * The ONE path that removes a member from a server: the kick route's teardown
 * lifted out, plus the ban upsert, the join-request delete and the inline
 * memberCount decrement in its transaction. The leave route calls it without
 * a ban so a voluntary leave keeps the count right too
 * (docs/local/server-discovery-plan.html).
 *
 * The caller has already verified the membership exists (and whatever
 * permission or hierarchy rule applies); `serverMember.delete` throws if it
 * does not. Order is load-bearing:
 *
 * 1. Voice eviction — a departed member must not keep a live media session.
 *    Cross-node via the Redis reverse lookup + the cluster eviction fan-out
 *    (the channel's mediasoup Router lives on exactly one node).
 * 2. Secure channels — the member's created channels die with them (with
 *    events to their members), other secure memberships are removed so the
 *    remaining members rotate keys. MUST run before the ServerMember delete.
 * 3. ChannelRead rows for this server's text channels.
 * 4. One transaction: ban upsert (optional), pending/declined join request
 *    gone, membership gone, memberCount − 1 (never below zero).
 * 5. The room invariant's other half: sockets leave `server:{id}` and every
 *    `channel:{id}` room, remaining members get member:left.
 *
 * The caller emits anything route-specific afterwards (kick → member:kicked
 * to the removed user's room).
 */
export async function removeMemberFromServer(
  userId: string,
  serverId: string,
  opts: RemoveMemberOptions = {},
): Promise<void> {
  try {
    const redis = getRedis();
    const voiceChannelId = await redis.get(`voice:user:${userId}`);
    if (voiceChannelId) {
      const voiceServerId = await redis.get(`voice:channel:server:${voiceChannelId}`);
      if (voiceServerId === serverId) {
        await broadcastVoiceEvictUser(getIO(), voiceChannelId, userId);
      }
    }
  } catch (err) {
    console.warn('[Servers] Voice eviction on member removal failed (reaper will catch up):', err);
  }

  await purgeSecureChannelState(userId, serverId);

  const textChannelIds = await prisma.channel.findMany({
    where: { serverId, type: 'text' },
    select: { id: true },
  });
  if (textChannelIds.length > 0) {
    await prisma.channelRead.deleteMany({
      where: { userId, channelId: { in: textChannelIds.map((c) => c.id) } },
    });
  }

  await prisma.$transaction([
    ...(opts.ban
      ? [
          prisma.serverBan.upsert({
            where: { serverId_userId: { serverId, userId } },
            create: { serverId, userId, bannedById: opts.ban.by, reason: opts.ban.reason },
            // A re-ban refreshes who, why and when — the latest decision is
            // the one the Banned section should show.
            update: { bannedById: opts.ban.by, reason: opts.ban.reason, createdAt: new Date() },
          }),
        ]
      : []),
    prisma.serverJoinRequest.deleteMany({ where: { serverId, userId } }),
    prisma.serverMember.delete({
      where: { userId_serverId: { userId, serverId } },
    }),
    // Guarded so inline drift can never push the count negative; the nightly
    // recount is what makes it exact again.
    prisma.server.updateMany({
      where: { id: serverId, memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    }),
  ]);

  await broadcastMemberLeft(userId, serverId);
}
