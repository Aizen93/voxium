import { prisma } from './prisma';
import { NotFoundError } from './errors';
import { getRedis } from './redis';
import { getIO } from '../websocket/socketServer';
import { broadcastVoiceEvictUser } from '../websocket/voiceCluster';
import {
  announceSecureMembershipsRemoved,
  removeSecureMembershipsInTx,
  type SecureMembershipRemoval,
} from './secureChannelLifecycle';
import { collectAttachmentKeys, deleteAttachmentBlobs } from './attachmentBlobs';
import { broadcastMemberLeft } from './memberBroadcast';
import { emitWebhookChanged } from './webhookLifecycle';

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
 * 2. One transaction, which commits whole or not at all:
 *    a. with a ban (a kick), FIRST, the webhooks whose LIVE URL the member
 *       holds (created by them and never rotated by another, or last rotated
 *       by them: a rotate hands its caller the only working URL), enabled or
 *       not, disabled and marked `creatorRemovedAt`. The URL is a bearer
 *       credential that may have left with the kicked member, so it stops
 *       posting the moment they are out, and a row already disabled carries
 *       the mark too, so whoever enables it later is warned; any enable or a
 *       rotate clears the mark. A voluntary leave keeps them. First because a
 *       60 s purge-delete may hold one of these rows, and that wait must come
 *       before this transaction takes any row a create or a join needs;
 *    b. the pending/declined join request gone;
 *    c. the membership row gone. Every writer of a secure-channel row locks
 *       that row first (FOR SHARE), so this delete waits for one in progress.
 *       Before any statement that locks the space row: a secure-channel
 *       creation locks the member rows and then the space row, and taking
 *       them in the other order here could deadlock with it;
 *    c'. with a ban, the ServerBan upsert, AFTER (c): its foreign key locks
 *       the space row (KEY SHARE) on a first ban;
 *    d. THEN the member's secure-channel state (removeSecureMembershipsInTx):
 *       the secure channels they created deleted (a creator never stays the
 *       manager of a channel in a space they left; if the delete fails, the
 *       departure fails), their rows in the others and the key shares
 *       addressed to them there removed. After (c), so it also removes a row
 *       an invite wrote while (c) waited for it;
 *    e. their ChannelRead rows in the space;
 *    f. memberCount − 1 (never below zero), LAST, so the space row, which
 *       every join and secure-channel creation also takes, is held for the
 *       shortest time.
 * 3. After the commit, best effort: the attachment files of the deleted
 *    channels, the secure-channel notices (removed member, remaining members,
 *    voice eviction per channel, the deleted channels' rooms emptied).
 * 4. The room invariant's other half: sockets leave `server:{id}` and every
 *    `channel:{id}` room, remaining members get member:left.
 * 5. When step 2a disabled any webhook: the `webhook:changed` refetch hint to
 *    `server:{id}` (the server id alone), after step 4 so the removed
 *    member's sockets are no longer in the room.
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

  // The files of the secure channels this member created, which the
  // transaction deletes: read now, in bounded batches, removed once it
  // committed. (A file a member attaches meanwhile is the orphan sweep's.)
  const attachmentKeys = await collectAttachmentKeys({ channel: { serverId, createdById: userId, secure: true } });

  let outcome: { disabledWebhooks: number; secure: SecureMembershipRemoval };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // One statement after the other: they share the transaction's one
      // connection, and the order is the one documented above.
      let disabled = 0;
      if (opts.ban) {
        ({ count: disabled } = await tx.webhook.updateMany({
          where: {
            serverId,
            // The webhooks whose LIVE URL the member holds: created by them
            // and never rotated since, or rotated last by them. Disabled or
            // not: a disabled row gets the mark too, so a later enable is warned.
            OR: [{ lastRotatedById: userId }, { lastRotatedAt: null, createdById: userId }],
          },
          data: { enabled: false, creatorRemovedAt: new Date() },
        }));
      }
      await tx.serverJoinRequest.deleteMany({ where: { serverId, userId } });
      await tx.serverMember.delete({
        where: { userId_serverId: { userId, serverId } },
      });
      if (opts.ban) {
        // After the member row: inserting a ban locks the space row through
        // its foreign key
        await tx.serverBan.upsert({
          where: { serverId_userId: { serverId, userId } },
          create: { serverId, userId, bannedById: opts.ban.by, reason: opts.ban.reason },
          // A re-ban refreshes who, why and when — the latest decision is the
          // one the Banned section should show.
          update: { bannedById: opts.ban.by, reason: opts.ban.reason, createdAt: new Date() },
        });
      }
      const removal = await removeSecureMembershipsInTx(tx, userId, serverId);
      await tx.channelRead.deleteMany({ where: { userId, channel: { serverId } } });
      // Guarded so inline drift can never push the count negative; the
      // nightly recount is what makes it exact again.
      await tx.server.updateMany({
        where: { id: serverId, memberCount: { gt: 0 } },
        data: { memberCount: { decrement: 1 } },
      });
      return { disabledWebhooks: disabled, secure: removal };
    }, {
      // A departing creator's channels are deleted in here, with every
      // message they hold, and a kick may first wait for a webhook purge:
      // Prisma's 5 s interactive default would roll back a removal that is
      // merely slow.
      timeout: 60_000,
      maxWait: 10_000,
    });
  } catch (err) {
    // The member left (or was removed) between the caller's membership check
    // and this transaction: serverMember.delete is the only statement here
    // that can raise P2025 (every other one is an updateMany, a deleteMany or
    // an upsert). Same answer the pre-check gives — not a 500 that rolls back
    // the ban the moderator asked for and tells them nothing.
    if ((err as { code?: unknown })?.code === 'P2025') throw new NotFoundError('Member');
    throw err;
  }
  const { disabledWebhooks, secure } = outcome;

  if (secure.deleted.length > 0) deleteAttachmentBlobs(attachmentKeys, '[Servers]', 'the secure channels of a departed member');
  await announceSecureMembershipsRemoved(secure);

  await broadcastMemberLeft(userId, serverId);

  if (disabledWebhooks > 0) emitWebhookChanged(serverId);
}
