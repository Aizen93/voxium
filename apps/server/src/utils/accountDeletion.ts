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
 * The delete transaction of `deleteUserAccount`: the account's memberships,
 * secure-channel state, E2E material and the row itself, in one transaction,
 * run again as a whole (retryOnTransactionConflict) when PostgreSQL aborts it
 * to break a deadlock. Everything `deleteUserAccount` does before it (the
 * member:left notices, the first session revocation, the key reads) is
 * idempotent, so a retry needs nothing redone. The inline member counts of
 * the spaces the account was in follow the commit (`lowerMemberCounts`).
 *
 * Lock order (1 to 3 are the order a removal and a secure-channel creation
 * or invite take their rows in):
 *  1. the member rows (the explicit DELETE);
 *  2. the secure channels, FOR UPDATE, in id order;
 *  3. the key shares and the rest of the account's E2E material;
 *  4. the account row and every row its delete cascades to or sets null
 *     (messages, reactions, reads, invites it created, join requests it
 *     decided, bans it issued, webhooks it created or rotated, …): the long
 *     part, tens of seconds on a heavy account.
 * It takes NO space row. Why each comes where it does:
 *  - 2 before 3: a member's removal from one secure channel
 *    (removeSecureMember) locks the channel, then deletes the key shares
 *    addressed to that member there. With the purge first (as this
 *    transaction once ran it), it held a share that removal waited for while
 *    it waited for the channel the removal held.
 *  - no space row: every join, channel, category, secure-channel and webhook
 *    creation, kick and ownership transfer in a space takes that space's
 *    row, and this is the longest transaction there is, so it holds none.
 *    A statement on `servers` ahead of the user delete would keep those
 *    rows through the whole cascade; behind it, it would be the last lock
 *    taken and close a cycle with every transaction that takes a space row
 *    first and then needs a row this one holds (a join through an invite
 *    this account created, a webhook it creates, a transfer to it). The
 *    member counts, the one statement that locks space rows, therefore
 *    follow the commit. The cascade itself locks no space row: the one key
 *    from `servers` to `users` is the owner's (Restrict, and an account
 *    deleted here owns no space), and nothing it sets null lives in
 *    `servers`.
 * Two deadlocks stay possible, both with a transaction that starts between
 * step 1 and step 4 (a short window, longer when the account created secure
 * channels with a long history): a transfer to this account (it key-shares
 * the account row through the new owner's key, then waits for the member row
 * deleted here, while step 4 waits for that key share) and a kick of this
 * account (it holds the webhooks the account created or rotated, then waits
 * for the member row, while the cascade waits for those webhooks). PostgreSQL
 * aborts one side, usually this transaction (the side that began waiting
 * last, when the other had waited longer than the deadlock check's delay),
 * and the aborted side runs again whole: the transfer and the kick are
 * retried as this transaction is. After a transfer that committed meanwhile
 * this transaction's retry answers OwnedServersError (below). A space delete
 * was not seen to close a cycle with it: its cascade reaches this account's
 * member row before any other row this transaction holds, and waits there.
 * That rests on the order PostgreSQL fires the cascade triggers of `servers`
 * in (by constraint id: `server_members` ahead of `channels` on a database
 * built from these migrations). A migration that drops and re-creates one of
 * those keys changes the order, and the retry is then what settles it.
 */
export async function deleteAccountRows(userId: string): Promise<SecureMembershipRemoval> {
  let committed: { removal: SecureMembershipRemoval; serverIds: string[] };
  try {
    committed = await runAccountDeletionTransaction(userId);
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
  // Not awaited: each of its statements waits for a space row while another
  // transaction holds it (a space delete holds one through its cascade), and
  // what follows the commit (the second session revocation first of all)
  // must not wait with it. It never rejects.
  void lowerMemberCounts(committed.serverIds, userId);
  return committed.removal;
}

function ownsASpaceNow(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { constraint?: unknown; field_name?: unknown } } | null;
  if (e?.code !== 'P2003') return false;
  const named = [e.message, e.meta?.constraint, e.meta?.field_name].filter((v): v is string => typeof v === 'string');
  return named.some((v) => v.includes('servers_owner_id_fkey'));
}

/**
 * The inline member counts (the directory's figure and the member list's
 * total) of the spaces a deleted account was a member of: lowered once the
 * delete has committed, outside its transaction (see the lock order above:
 * these are the statements that lock space rows). Best effort, like every
 * step that follows a committed delete: nothing decides on this figure (the
 * member limit counts the rows), a failure is logged and the nightly drift
 * correction (discoveryStats.ts) recounts. The spaces are the ones the
 * committed attempt removed a row from, so a retried transaction lowers each
 * count once.
 *
 * ONE STATEMENT PER SPACE, one after the other, never one statement for all
 * of them: a statement over several rows keeps the rows it has already
 * updated locked while it waits for the next, so a space row another
 * transaction holds for long (a space delete, through its cascade) would
 * keep the account's OTHER spaces locked for as long, with every join and
 * creation there queued behind them. A statement over one row holds nothing
 * while it waits and commits as soon as it has its row, so it can neither
 * hold up another space nor be part of a deadlock; a row held for long only
 * delays the counts that come after it.
 */
async function lowerMemberCounts(serverIds: string[], userId: string): Promise<void> {
  let failed = 0;
  let lastError: unknown;
  for (const serverId of serverIds) {
    try {
      await prisma.server.updateMany({
        where: { id: serverId, memberCount: { gt: 0 } },
        data: { memberCount: { decrement: 1 } },
      });
    } catch (err) {
      failed++;
      lastError = err;
    }
  }
  if (failed > 0) {
    console.warn(
      `[Accounts] The member count of ${failed} of ${serverIds.length} space(s) was not lowered after the deletion of account ${userId} (the nightly recount corrects it):`,
      lastError instanceof Error ? lastError.message : lastError,
    );
  }
}

function runAccountDeletionTransaction(userId: string): Promise<{ removal: SecureMembershipRemoval; serverIds: string[] }> {
  // E2E key material has no FK to User (except the key backup), so it would
  // otherwise outlive the account it belongs to. One transaction with the
  // delete: purging a user who then survives strands every device they own.
  return retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    // The memberships first, explicitly (the cascade would take them with the
    // row, last): see the lock order above. The spaces whose count moves
    // after the commit are the ones this very statement removed a row from,
    // on this attempt: a list read before the transaction would miscount
    // after a join or a removal committed between two attempts.
    const removedFrom = await tx.$queryRaw<Array<{ server_id: string }>>`
      DELETE FROM server_members WHERE user_id = ${userId} RETURNING server_id`;
    const serverIds = removedFrom.map((r) => r.server_id);
    // Then the secure-channel state, in the same transaction: the channels
    // the account created (with every member's row), its rows in the others,
    // the key shares addressed to it there. The notices go out after the commit.
    const removal = await removeSecureMembershipsInTx(tx, userId);
    // Then every other key share and E2E row of the account, after the
    // secure channels (see the lock order above). Neither step reads what the
    // other deletes: the secure-channel step reads channels and their member
    // rows, the purge deletes by user id alone.
    await purgeE2EMaterial(userId, tx);
    // The row, and with it the long cascade. The last statement: nothing in
    // this transaction touches a space row (see the lock order above).
    await tx.user.delete({ where: { id: userId } });
    return { removal, serverIds };
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
