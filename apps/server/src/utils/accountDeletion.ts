import { prisma } from './prisma';
import { purgeE2EMaterial } from './e2ePurge';
import { purgeSecureChannelStateForAccount } from './secureChannelLifecycle';
import { broadcastMemberLeft } from './memberBroadcast';
import { deleteFromS3 } from './s3';
import { getIO } from '../websocket/socketServer';

/**
 * Delete an account that owns NO servers, with everything that has to happen
 * around the row going: the surviving members of its servers told, its live
 * sessions ended, its secure channels and E2E key material purged, and its
 * avatar blob removed AFTER the row.
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
  for (const { serverId } of memberships) {
    await broadcastMemberLeft(userId, serverId);
  }

  // End every live session across the cluster. A room-filtered
  // disconnectSockets is adapter-wide and does not need a fetch; the
  // dangerous form is the EMPTY filter (see index.ts shutdown).
  const io = getIO();
  io.to(`user:${userId}`).emit('force:logout', { reason: opts.reason });
  io.in(`user:${userId}`).disconnectSockets(true);

  // Secure channels: the DB cascade would silently reap the rows, but the
  // members deserve events (created channels vanish from their sidebars,
  // membership lists refresh). Best-effort, before the delete.
  await purgeSecureChannelStateForAccount(userId);

  // E2E key material has no FK to User (except the key backup), so it would
  // otherwise outlive the account it belongs to. One transaction with the
  // delete: purging a user who then survives strands every device they own.
  await prisma.$transaction(async (tx) => {
    await purgeE2EMaterial(userId, tx);
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

  if (target.avatarUrl) {
    await deleteFromS3(target.avatarUrl).catch((err) =>
      console.warn(`${opts.logPrefix} Avatar cleanup failed (the orphan sweep will reclaim it):`, err instanceof Error ? err.message : err));
  }
}
