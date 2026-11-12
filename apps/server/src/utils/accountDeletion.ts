import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { purgeE2EMaterial } from './e2ePurge';
import {
  announceSecureMembershipsRemoved,
  removeSecureMembershipsInTx,
  type SecureMembershipRemoval,
} from './secureChannelLifecycle';
import { retryOnTransactionConflict } from './transactionRetry';
import { OwnedServersError } from './errors';
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

  // The user delete cascades every message the account wrote, in every
  // channel, and both sides of every conversation it was in (Message.author
  // and both Conversation users are onDelete: Cascade), attachment rows
  // included, and the transaction below deletes the secure channels the
  // account created with every message in them. Their keys are read now and
  // the files deleted once the delete has committed. One read per indexed
  // column, merged: an OR across messages and conversations starts from no
  // index and walked the attachments of every message ever sent. A message
  // the account wrote in its own conversation (or in its own secure channel)
  // is found twice, hence the Set. A read that fails must not stop the
  // erasure: the sessions are already revoked, so it is logged, those files
  // are left to the nightly orphan sweep, and the deletion goes on.
  const readKeys = async (messages: Prisma.MessageWhereInput, what: string): Promise<string[]> => {
    try {
      return await collectAttachmentKeys(messages);
    } catch (err) {
      console.error(`${opts.logPrefix} Reading the attachment keys of ${what} failed (the orphan sweep will reclaim those files):`, err instanceof Error ? err.message : err);
      return [];
    }
  };
  const attachmentKeys = [...new Set([
    ...await readKeys({ authorId: userId }, "the account's messages"),
    ...await readKeys({ conversation: { user1Id: userId } }, "the account's conversations (first side)"),
    ...await readKeys({ conversation: { user2Id: userId } }, "the account's conversations (second side)"),
    ...await readKeys({ channel: { createdById: userId, secure: true } }, 'the secure channels the account created'),
  ])];

  const secure = await deleteAccountRows(userId);

  // Again, now that the row is gone: a socket whose handshake landed while
  // the row still existed joined user:{id} after the first pass and passed
  // the connection handler's re-check. Any later handshake finds no row.
  revokeUserSessions(userId, { forceLogoutReason: opts.reason });

  deleteAttachmentBlobs(attachmentKeys, opts.logPrefix, 'a deleted account');

  // The members of its secure channels hear it (created channels vanish
  // from their sidebars, member lists refresh, live voice ends). Never throws.
  await announceSecureMembershipsRemoved(secure);

  for (const { serverId } of pendingRequests) {
    await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'cancelled' });
  }

  if (target.avatarUrl) {
    await deleteFromS3(target.avatarUrl).catch((err) =>
      console.warn(`${opts.logPrefix} Avatar cleanup failed (the orphan sweep will reclaim it):`, err instanceof Error ? err.message : err));
  }
}

/**
 * The delete transaction of `deleteUserAccount`: the account's E2E material,
 * memberships, secure-channel state, member counts and the row itself, in
 * one transaction, run again as a whole (retryOnTransactionConflict) when
 * PostgreSQL aborts it to break a deadlock. Everything `deleteUserAccount`
 * does before it (the member:left notices, the first session revocation, the
 * key reads) is idempotent, so a retry needs nothing redone.
 *
 * Lock order: the member rows, then the secure channels (FOR UPDATE, in id
 * order), then the space rows (the member counts), the order a removal and a
 * secure-channel creation or invite take them in. Taking the space rows
 * first instead (as this transaction once did), to match a space delete and
 * an ownership transfer, would close a cycle with a removal: the removal
 * holds a secure channel and waits for the space row last, this transaction
 * would hold the space row and wait for that channel. Against a space delete
 * or a transfer to this account (space row, then member rows) a deadlock
 * stays possible either way; PostgreSQL aborts one side and both sides
 * retry.
 */
export async function deleteAccountRows(userId: string): Promise<SecureMembershipRemoval> {
  try {
    return await runAccountDeletionTransaction(userId);
  } catch (err) {
    // `Server.owner` is onDelete: Restrict: the account came to own a space
    // after `deleteUserAccount` checked it owned none (a transfer to it, which
    // a retried attempt meets committed). Nothing was deleted, and the answer
    // is the one an owner gets, with the spaces the client's owned-spaces
    // dialog lists, not a 500. By then `deleteUserAccount` has already sent
    // member:left in every space and ended the account's sessions with
    // force:logout: the user is signed out and their account is intact; they
    // sign in again, transfer or delete the space, and ask again.
    if (ownsASpaceNow(err)) {
      const servers = await prisma.server.findMany({ where: { ownerId: userId }, select: { id: true, name: true } })
        .catch((readErr: unknown) => {
          console.warn(`[Accounts] Could not list the spaces account ${userId} owns now:`, readErr instanceof Error ? readErr.message : readErr);
          return [];
        });
      throw new OwnedServersError(servers);
    }
    throw err;
  }
}

function ownsASpaceNow(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { constraint?: unknown; field_name?: unknown } } | null;
  if (e?.code !== 'P2003') return false;
  const named = [e.message, e.meta?.constraint, e.meta?.field_name].filter((v): v is string => typeof v === 'string');
  return named.some((v) => v.includes('servers_owner_id_fkey'));
}

function runAccountDeletionTransaction(userId: string): Promise<SecureMembershipRemoval> {
  // E2E key material has no FK to User (except the key backup), so it would
  // otherwise outlive the account it belongs to. One transaction with the
  // delete: purging a user who then survives strands every device they own.
  return retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    await purgeE2EMaterial(userId, tx);
    // The memberships first, explicitly (the cascade would take them with the
    // row, last): see the lock order above. The spaces whose count moves are
    // the ones this very statement removed a row from, on this attempt: a
    // list read before the transaction would miscount after a join or a
    // removal committed between two attempts.
    const removedFrom = await tx.$queryRaw<Array<{ server_id: string }>>`
      DELETE FROM server_members WHERE user_id = ${userId} RETURNING server_id`;
    const serverIds = removedFrom.map((r) => r.server_id);
    // Then the secure-channel state, in the same transaction: the channels
    // the account created (with every member's row), its rows in the others,
    // the key shares addressed to it there. The notices go out after the commit.
    const removal = await removeSecureMembershipsInTx(tx, userId);
    // The inline member counts (server discovery) follow in the same
    // transaction so the directory never shows a departed member until the
    // nightly recount.
    if (serverIds.length > 0) {
      await tx.server.updateMany({
        where: { id: { in: serverIds }, memberCount: { gt: 0 } },
        data: { memberCount: { decrement: 1 } },
      });
    }
    await tx.user.delete({ where: { id: userId } });
    return removal;
  }, {
    // Deleting a user cascades across ~36 relations (messages, reactions,
    // reads, conversations, reports, tickets, themes…) plus six E2E deletes.
    // Prisma's default 5s interactive budget is a deadline these statements
    // never had before they shared a transaction, and blowing it on a heavy
    // account would roll the whole deletion back.
    timeout: 60_000,
    maxWait: 10_000,
  }), `[Accounts] The deletion of account ${userId}`);
}
