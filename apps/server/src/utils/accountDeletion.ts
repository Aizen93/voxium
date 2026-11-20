import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { purgeE2EMaterial } from './e2ePurge';
import {
  announceSecureMembershipsRemoved,
  removeSecureMembershipsInTx,
  type SecureMembershipRemoval,
} from './secureChannelLifecycle';
import { retryOnTransactionConflict } from './transactionRetry';
import { NotFoundError, OwnedServersError } from './errors';
import { broadcastMemberLeft } from './memberBroadcast';
import { deleteFromS3 } from './s3';
import { collectAttachmentKeys, deleteAttachmentBlobs } from './attachmentBlobs';
import { revokeUserSessions } from './sessionRevocation';
import { emitToModerators } from './moderatorAudience';
import { isFeatureEnabled } from './featureFlags';
import { settleConversationsOfDeletedAccount, type DeletedAccountConversations } from './conversationLifecycle';
import { getIO } from '../websocket/socketServer';
import { endDMCall } from '../websocket/dmVoiceHandler';
import { deletedParticipantId } from './deletedParticipant';
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

  // What becomes of the account's direct conversations (#131), read ONCE for
  // the whole deletion, before its transaction, so a retried attempt and the
  // steps after the commit follow the same rule: off, each is deleted for
  // both people (as an account deletion always did); on, one the other
  // person can still reach outlives the account for them, read-only.
  const keepConversations = isFeatureEnabled('account_deletion_keeps_conversations');

  // The user delete cascades every message the account wrote in every
  // channel (Message.author is onDelete: Cascade), attachment rows included,
  // and the transaction below deletes the secure channels the account
  // created with every message in them. Their keys are read now and the
  // files deleted once the delete has committed. One read per indexed
  // column, merged: an OR across tables starts from no index and walked the
  // attachments of every message ever sent. The account's messages in its
  // direct conversations are among the first read (its own files go in every
  // case); the other person's files there are NOT read here: the
  // transaction decides, conversation by conversation, which are deleted,
  // and reads the keys of those under their locks (the files of a
  // conversation that survives stay with it). A read that fails must not
  // stop the erasure: the sessions are already revoked, so it is logged,
  // those files are left to the nightly orphan sweep, and the deletion goes
  // on.
  const readKeys = async (messages: Prisma.MessageWhereInput, what: string): Promise<string[]> => {
    try {
      return await collectAttachmentKeys(messages);
    } catch (err) {
      console.error(`${opts.logPrefix} Reading the attachment keys of ${what} failed (the orphan sweep will reclaim those files):`, err instanceof Error ? err.message : err);
      return [];
    }
  };
  const ownKeys = [
    ...await readKeys({ authorId: userId }, "the account's messages"),
    ...await readKeys({ channel: { createdById: userId, secure: true } }, 'the secure channels the account created'),
  ];

  const { secure, removedFrom, conversations } = await deleteAccountRows(userId, { keepConversations });

  // Everything below follows the commit: each step on its own, a failure
  // logged and never thrown, so a deletion that has committed is answered as
  // done whatever a notice or a file does (and the steps after a failed one
  // still run). The second revocation first, as for every committing write.
  const afterCommit = async (step: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (err) {
      console.warn(`${opts.logPrefix} After the deletion of account ${userId}, ${step} failed:`, err instanceof Error ? err.message : err);
    }
  };

  // Again, now that the row is gone: a socket whose handshake landed while
  // the row still existed joined user:{id} after the first pass and passed
  // the connection handler's re-check. Any later handshake finds no row.
  await afterCommit('the second session revocation', () => revokeUserSessions(userId, { forceLogoutReason: opts.reason }));

  // The account's own files, and those of the conversations the committed
  // attempt deleted (read under their locks). A message the account wrote in
  // a deleted conversation (or in its own secure channel) is found twice,
  // hence the Set.
  await afterCommit('the attachment file cleanup', () =>
    deleteAttachmentBlobs([...new Set([...ownKeys, ...conversations.attachmentKeys])], opts.logPrefix, 'a deleted account'));

  // The people of its conversations hear what became of them.
  await afterCommit('the notices of its direct conversations', () => announceConversationsOfDeletedAccount(conversations, opts.logPrefix));

  // Every space the committed deletion removed a membership from that the
  // notices above did not name (a membership that committed after the read
  // above): its members hear the departure too, each space on its own.
  const announced = new Set(memberships.map((m) => m.serverId));
  for (const serverId of new Set(removedFrom)) {
    if (announced.has(serverId)) continue;
    await afterCommit(`the departure notice in space ${serverId}`, () => broadcastMemberLeft(userId, serverId));
  }

  // The members of its secure channels hear it (created channels vanish
  // from their sidebars, member lists refresh, live voice ends).
  await afterCommit('the secure-channel notices', () => announceSecureMembershipsRemoved(secure));

  for (const { serverId } of pendingRequests) {
    await afterCommit(`the withdrawn join request notice in space ${serverId}`, () =>
      emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'cancelled' }));
  }

  if (target.avatarUrl) {
    const avatar = target.avatarUrl;
    await afterCommit('the avatar cleanup (the orphan sweep will reclaim it)', () => deleteFromS3(avatar));
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
 *  4. the account row (FOR UPDATE), then the member rows committed since
 *     step 1 (a second DELETE), then the account's device-registry row a
 *     second time;
 *  5. the account's direct conversations, every row FOR UPDATE in id order,
 *     then what becomes of each: kept for the other person (the account's
 *     messages there rewritten to placeholders, each row before its
 *     reactions and attachments, the other read row unhidden, the side set
 *     NULL) or deleted with its cascade
 *     (settleConversationsOfDeletedAccount, utils/conversationLifecycle.ts,
 *     which documents this step against every writer of a conversation);
 *  6. the user delete and every row it cascades to or sets null (messages,
 *     reactions, reads, invites it created, join requests it decided, bans
 *     it issued, webhooks it created or rotated, its E2E devices with their
 *     one-time keys, …): the long part.
 * It takes NO space row. Why each comes where it does:
 *  - in 4, the account row before the second member-row delete: a
 *    membership's key to the account waits for that lock, so every
 *    membership within reach of the user delete's cascade has been deleted
 *    here first, and is counted (lowerMemberCounts) and announced
 *    (deleteUserAccount) with the others.
 *  - in 4, the registry row after the account row: an E2E device
 *    registration (PUT /e2e/devices) takes the account row first and the
 *    registry row last, so one that committed between steps 3 and 4 (an
 *    account's first device, whose rows step 3 could not see) is covered,
 *    and none can write the registry once this transaction holds the
 *    account row. Its device rows have a key to the account and go with the
 *    user delete, and their one-time keys go with the devices; the registry
 *    row has none, hence the second delete. The registration takes the
 *    account row and the registry row in this same order. But this step
 *    takes the registry row BEFORE the device rows its user delete reaches
 *    through the cascade, while three E2E writers that never take the
 *    account row take a device row and then the registry row: a revoke
 *    (DELETE /e2e/devices/me/:deviceId), the master-key publication with
 *    device signatures (PUT /e2e/master-key, which the stock client sends
 *    right after a first registration) and a device approval (POST
 *    /e2e/devices/:deviceId/signature). On a device registered after step
 *    3, each can close a cycle with this step: PostgreSQL aborts one side,
 *    and all four run under retryOnTransactionConflict (this one retried
 *    whole ends clean). Each of the three reads the device row under a lock,
 *    so one that waited for this transaction, or runs again after it
 *    committed, finds the device gone and answers as for a missing one (404,
 *    or 400 for a device named in the master-key publication's
 *    signatures).
 * What #114 (foreign keys from the E2E tables to the account) still leaves
 * open: a master-key publication that waited on step 3's delete inserts a
 * master-key row and a registry row once this commits; a key share
 * addressed to a device created after step 3 survives the account; and a
 * master transfer likewise. None of those writers takes the account row, so
 * a second delete here cannot cover them.
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
 * The transactions that need the account's member row and a row this one
 * takes after it lock that member row first and queue with this one there: a
 * transfer to the account (the owner's route in routes/servers.ts, the admin
 * heir path) locks the heir's member row before its owner update key-shares
 * the account row; a removal of the account (removeMemberFromServer) locks
 * the member row before the webhooks and the ban key that this transaction's
 * cascade and account-row lock reach. A space delete's cascade reaches this
 * account's member row before any other row this transaction holds and waits
 * there; that rests on the order PostgreSQL fires the cascade triggers of
 * `servers` in, which is the text order of the trigger names, each ending in
 * the trigger's oid: `server_members` ahead of `channels` on a database built
 * from these migrations in one go, not necessarily on a restored one, where
 * the delete may hold another of these rows first (PostgreSQL then aborts
 * one side, and both are retried). Two cycles stay possible on any database,
 * both on a membership the account gained after step 1. A kick of the account from
 * that space, when the kick locks the new member row after step 4 has locked
 * the account row and before the second member-row delete reaches the row
 * (the kick's ban then key-shares the account row). A transfer to the
 * account in that space, when its batch has locked the space row and the new
 * member row before step 4 locks the account row: its owner update then
 * waits to key-share the account row while the second member-row delete
 * waits for the member row. No single order serves a transfer against both
 * member-row deletes: this transaction deletes the account's earlier member
 * rows before it locks its account row, and its later ones after. PostgreSQL
 * aborts one side and the aborted
 * side runs again whole: every transaction named here is retried
 * (retryOnTransactionConflict), and a retry of this one after a transfer to
 * the account committed answers OwnedServersError (below).
 * The direct conversations: step 5 takes every conversation row of the
 * account before it touches anything in them, after the account row (which
 * holds back every new conversation with the account), so the user delete
 * in step 6 finds none left to cascade into (each is deleted, or its side set
 * NULL, explicitly: nothing rests on the foreign keys' CASCADE). Every writer
 * of a conversation (a message, an edit, a reaction or a delete of one, a
 * removal, a reopen; utils/conversationLifecycle.ts) takes the conversation
 * row first: by the other person, it then needs nothing this transaction
 * holds before its own lock on that row, so one of the two simply waits for
 * the other; by the deleted account itself, an insert key-shares the
 * account row this transaction holds while this transaction waits for the
 * conversation row, a cycle PostgreSQL breaks (both are retried, and the
 * account's write retried after this one committed answers 404 or 403).
 */
export async function deleteAccountRows(userId: string, opts: { keepConversations: boolean }): Promise<AccountRowsDeleted> {
  let committed: { removal: SecureMembershipRemoval; serverIds: string[]; conversations: DeletedAccountConversations };
  try {
    committed = await runAccountDeletionTransaction(userId, opts.keepConversations);
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
  return { secure: committed.removal, removedFrom: committed.serverIds, conversations: committed.conversations };
}

/** What a committed `deleteAccountRows` leaves its caller to announce. */
export interface AccountRowsDeleted {
  /** The secure-channel state removed (the notices follow the commit). */
  secure: SecureMembershipRemoval;
  /**
   * Every space the committed attempt removed a membership from, by either
   * member-row delete: the caller announces the departure in each one it has
   * not announced it in yet.
   */
  removedFrom: string[];
  /**
   * The account's direct conversations as the committed attempt left them:
   * kept for the other person (read-only) or deleted, and the files to
   * delete after the commit (settleConversationsOfDeletedAccount).
   */
  conversations: DeletedAccountConversations;
}

/**
 * After a committed account deletion (or the registration hygiene sweep's,
 * utils/registrationHygiene.ts), its direct conversations' people are told
 * (#131), each step on its own, logged, never failing the deletion (which
 * has committed):
 *  - a conversation kept for the other person: `dm:conversation:read_only`
 *    to its room, only now that its rows are rewritten (a client that
 *    decrypted a row still holding the account's ciphertext after the event
 *    could refill the cache it purges on it);
 *  - a conversation deleted: its room is emptied, the local form first, then
 *    the cluster-wide one (utils/memberBroadcast.ts says why), never a
 *    `fetchSockets()`. No `dm:conversation:deleted` goes out: that is the
 *    remover's notice, and here the one who would get it is the deleted
 *    account, whose sessions are ended; the other person had removed the
 *    conversation (or is gone too) and is told nothing, as for any removal;
 *  - a call left in any of them ends (dm:voice:left / dm:voice:ended to its
 *    room, before a deleted one's room is emptied), with no "call ended"
 *    notice: a deleted conversation cannot hold one, and a kept one is
 *    read-only.
 */
export async function announceConversationsOfDeletedAccount(conversations: DeletedAccountConversations, logPrefix: string): Promise<void> {
  const { kept, deleted } = conversations;
  if (kept.length === 0 && deleted.length === 0) return;
  let io: ReturnType<typeof getIO>;
  try {
    io = getIO();
  } catch (err) {
    console.warn(`${logPrefix} The notices about ${kept.length + deleted.length} direct conversation(s) of a deleted account were not sent:`, err instanceof Error ? err.message : err);
    return;
  }

  for (const conversationId of kept) {
    try {
      io.to(`dm:${conversationId}`).emit(WS_EVENTS.DM_CONVERSATION_READ_ONLY, { conversationId });
    } catch (err) {
      console.warn(`${logPrefix} The read-only notice of conversation ${conversationId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // dm:voice:left names the conversation's placeholder, never the deleted
  // account (still in the call's registry when it was in the call)
  const calls = await Promise.allSettled([...kept, ...deleted].map((conversationId) =>
    endDMCall(io, conversationId, { notice: false, leftUserId: deletedParticipantId(conversationId) })));
  const failedCalls = calls.filter((c): c is PromiseRejectedResult => c.status === 'rejected');
  if (failedCalls.length > 0) {
    console.warn(
      `${logPrefix} Ending the calls of ${failedCalls.length} direct conversation(s) of a deleted account failed:`,
      failedCalls[0].reason instanceof Error ? failedCalls[0].reason.message : failedCalls[0].reason,
    );
  }

  if (deleted.length > 0) {
    const rooms = deleted.map((conversationId) => `dm:${conversationId}`);
    try {
      io.local.in(rooms).socketsLeave(rooms);
    } catch (err) {
      console.warn(`${logPrefix} The local room leave of ${rooms.length} deleted conversation(s) failed:`, err instanceof Error ? err.message : err);
    }
    try {
      io.in(rooms).socketsLeave(rooms);
    } catch (err) {
      console.warn(`${logPrefix} The cluster room leave of ${rooms.length} deleted conversation(s) failed:`, err instanceof Error ? err.message : err);
    }
  }
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

function runAccountDeletionTransaction(
  userId: string,
  keepConversations: boolean,
): Promise<{ removal: SecureMembershipRemoval; serverIds: string[]; conversations: DeletedAccountConversations }> {
  // Most E2E material has no key to the account (the key shares, master
  // transfers, master key and device registry; the devices and the two
  // backups do, and cascade, and the one-time keys cascade from their device),
  // so it would otherwise outlive the account it belongs to. One transaction with the delete: purging a
  // user who then survives strands every device they own.
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
    // The account row, then the memberships committed since the first delete
    // (a join of this account meanwhile). With the account row held, a new
    // membership's key to the account waits for this transaction, so the
    // user delete below removes no membership that this transaction does not
    // count and announce.
    // Gone already (another deletion, or the registration hygiene sweep,
    // deleted it first): the answer an unknown account gets, everything this
    // attempt did rolled back
    const account = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (account.length === 0) throw new NotFoundError('User');
    const joinedSince = (await tx.$queryRaw<Array<{ server_id: string }>>`
      DELETE FROM server_members WHERE user_id = ${userId} RETURNING server_id`).map((r) => r.server_id);
    // The registry row a device registration committed since step 3 (the
    // account's first device: invisible to the purge until it committed).
    // Its device rows go with the user delete; this row has no key to the
    // account. Under the account row lock, no registration can write it again.
    await tx.e2EDeviceRegistry.deleteMany({ where: { userId } });
    // The direct conversations, under the account row lock (no new one can
    // start with this account meanwhile): each locked in id order, then kept
    // for the other person read-only or deleted, explicitly, whatever the
    // foreign keys from the sides say (see the lock order above).
    const conversations = await settleConversationsOfDeletedAccount(tx, userId, { keep: keepConversations });
    // The row, and with it the long cascade. The last statement: nothing in
    // this transaction touches a space row (see the lock order above).
    await tx.user.delete({ where: { id: userId } });
    return { removal, serverIds: [...serverIds, ...joinedSince], conversations };
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
