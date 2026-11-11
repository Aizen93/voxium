import { prisma } from './prisma';
import { purgeE2EMaterial } from './e2ePurge';
import { purgeSecureChannelStateForAccount } from './secureChannelLifecycle';
import { broadcastMemberLeft } from './memberBroadcast';
import { deleteFromS3 } from './s3';
import { collectAttachmentKeys, deleteAttachmentBlobs } from './attachmentBlobs';
import { revokeUserSessions } from './sessionRevocation';
import { emitToModerators } from './moderatorAudience';
import { WS_EVENTS } from '@voxium/shared';

/**
 * Delete an account that owns NO servers, with everything that has to happen
 * around the row going: the surviving members of its servers told, its live
 * sessions ended, its secure channels and E2E key material purged, and its
 * avatar and the attachment files of the messages the delete cascades
 * removed AFTER the row.
 *
 * Shared by the admin delete-user flow (which first resolves the servers
 * the account owns, by transfer or deletion) and the self-service
 * DELETE /auth/account (which refuses while the account still owns any —
 * GDPR right to erasure, Terms "you may delete your account at any time").
 * Owned servers are the caller's problem: `Server.owner` is onDelete:
 * Restrict, so the delete would fail anyway, and choosing between handing a
 * community to someone else and destroying it is not a decision to make on
 * the account's behalf.
 *
 * Ordering is load-bearing and each step explains itself below.
 */
export async function deleteUserAccount(userId: string, opts: { reason: string; logPrefix: string }): Promise<void> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    // avatarUrl so the blob goes with the row — read BEFORE the delete, removed
    // AFTER it, so a failed delete never strands a live account without its
    // avatar.
    select: { id: true, avatarUrl: true, ownedServers: { select: { id: true }, take: 1 } },
  });
  if (!target) return;
  if (target.ownedServers.length > 0) {
    throw new Error('deleteUserAccount called for an account that still owns servers');
  }

  // Surviving members of every server see the departure (member:left plus
  // the socket room leaves that stop this account's sockets receiving their
  // events). Re-read here rather than taken from the caller: a transfer that
  // just happened leaves the membership row in place until the cascade.
  const memberships = await prisma.serverMember.findMany({ where: { userId }, select: { serverId: true } });
  // The cascade takes this account's join requests silently; the moderators
  // who still list one deserve the same event every other settlement sends.
  const pendingRequests = await prisma.serverJoinRequest.findMany({ where: { userId, status: 'pending' }, select: { serverId: true } });
  for (const { serverId } of memberships) {
    await broadcastMemberLeft(userId, serverId);
  }

  // End every live session across the cluster (room-filtered, adapter-wide;
  // see sessionRevocation.ts). This first pass is for promptness; the one
  // after the delete commits is the guarantee (below).
  revokeUserSessions(userId, { forceLogoutReason: opts.reason });

  // Secure channels: the DB cascade would silently reap the rows, but the
  // members deserve events (created channels vanish from their sidebars,
  // membership lists refresh). Best-effort, before the delete.
  await purgeSecureChannelStateForAccount(userId);

  // The user delete cascades every message the account wrote, in every
  // channel, and both sides of every conversation it was in (Message.author
  // and both Conversation users are onDelete: Cascade), attachment rows
  // included. Their keys are read now, in bounded batches, and the files
  // deleted once the delete has committed. (The secure channels the account
  // created were deleted just above, with their own files.)
  const attachmentKeys = await collectAttachmentKeys({
    OR: [
      { authorId: userId },
      { conversation: { OR: [{ user1Id: userId }, { user2Id: userId }] } },
    ],
  });

  // E2E key material has no FK to User (except the key backup), so it would
  // otherwise outlive the account it belongs to. One transaction with the
  // delete: purging a user who then survives strands every device they own.
  await prisma.$transaction(async (tx) => {
    await purgeE2EMaterial(userId, tx);
    // The cascade takes this account's memberships with the row; the inline
    // member counts (server discovery) follow in the same transaction so the
    // directory never shows a departed member until the nightly recount.
    if (memberships.length > 0) {
      await tx.server.updateMany({
        where: { id: { in: memberships.map((m) => m.serverId) }, memberCount: { gt: 0 } },
        data: { memberCount: { decrement: 1 } },
      });
    }
    await tx.user.delete({ where: { id: userId } });
  }, {
    // Deleting a user cascades across ~36 relations (messages, reactions,
    // reads, conversations, reports, tickets, themes…) plus six E2E deletes.
    // Prisma's default 5s interactive budget is a deadline these statements
    // never had before they shared a transaction, and blowing it on a heavy
    // account would roll the whole deletion back.
    timeout: 60_000,
    maxWait: 10_000,
  });

  // Again, now that the row is gone: a socket whose handshake landed while
  // the row still existed joined user:{id} after the first pass and passed
  // the connection handler's re-check. Any later handshake finds no row.
  revokeUserSessions(userId, { forceLogoutReason: opts.reason });

  deleteAttachmentBlobs(attachmentKeys, opts.logPrefix, 'a deleted account');

  for (const { serverId } of pendingRequests) {
    await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'cancelled' });
  }

  if (target.avatarUrl) {
    await deleteFromS3(target.avatarUrl).catch((err) =>
      console.warn(`${opts.logPrefix} Avatar cleanup failed (the orphan sweep will reclaim it):`, err instanceof Error ? err.message : err));
  }
}
