import { CONVERSATION_READ_ONLY_MESSAGE, DELETED_MESSAGE_TYPE, DM_SYSTEM_NOTICES } from '@voxium/shared';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { ForbiddenError, NotFoundError } from './errors';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from './transactionRetry';
import { collectAttachmentKeys } from './attachmentBlobs';
import { VALID_ATTACHMENT_KEY_RE } from './s3';
import { readConversationAudience } from './conversationAudience';
import {
  conversationAfterAccountDeletion,
  isReadOnlyConversation,
  newMessageTime,
  nobodyCanReach,
  readConversationView,
  type ConversationSideState,
  type ConversationView,
  type SideReach,
} from './conversationVisibility';
import { describeCaughtError } from './loggableError';

/**
 * The transactions that change one person's side of a direct conversation
 * (#47): a new message, an edit, a reaction or a delete of one, a removal, a
 * reopen, and what an account deletion does with the account's
 * conversations (#131). What each person sees is decided in
 * utils/conversationVisibility.ts.
 *
 * LOCK ORDER of every transaction that touches a conversation. The
 * conversation row comes FIRST in each of the four below, and none takes
 * another conversation's row:
 *  - a new message (writeConversationMessage: the send route and the call
 *    notices of websocket/dmVoiceHandler.ts): the conversation row FOR KEY
 *    SHARE; then the newest message (read); then, through the insert's
 *    foreign keys, the author's account row and the quoted message (key
 *    share); the attachment rows it inserts; last, the read rows it unhides
 *    (only rows that are hidden). After the commit, holding nothing: the
 *    audience read, the event, then the list-order bump (`updatedAt`), a
 *    statement of its own on the shared client that waits for a removal
 *    queued behind the write, which is why it comes after the event.
 *  - an edit, a reaction or the delete of one message (changeConversationMessage,
 *    routes/dm.ts): the conversation row FOR KEY SHARE; then the message row
 *    (the edit's and the delete's update or delete; a reaction's insert
 *    key-shares it and the reactor's account row, its toggle-off deletes the
 *    reactor's own reaction row); a delete then reaches the message's
 *    attachment and reaction rows and the quotes of it (SET NULL) through
 *    its cascade. A message's own row comes before its children, as in every
 *    other writer of messages.
 *  - a removal (removeConversationForUser): the conversation row FOR UPDATE,
 *    which waits for every message write in flight and holds back every new
 *    one (a message insert key-shares that row through its foreign key, so
 *    no writer can slip past it), so the newest message it reads is the
 *    newest there is and the real-deletion rule sees every message and every
 *    side's state as they stand; then the remover's read row (inserting one
 *    key-shares the remover's account row); then, when nobody can reach the
 *    conversation any more, the attachment rows (read) and the delete of the
 *    conversation with its cascade: messages, their attachments and
 *    reactions, both read rows, and the keys of replies and reports set NULL.
 *  - a reopen (reopenConversationForUser): the conversation row FOR KEY
 *    SHARE, its sides (read), then the opener's read row.
 *  Message writes, edits, reactions and deletes share the conversation row and
 *  meet only on rows of their own (a read row two writes both unhide, in the
 *  same index order; a message a delete removes while a reply to it is
 *  inserted, which then answers its missing parent); a removal queues behind
 *  every one of them and every removal or reopen of that conversation, and
 *  they queue behind it.
 * Outside a transaction: the creation (POST /dm: the conversation insert,
 * which key-shares both account rows, then both read rows) and the mark-read
 * upsert (the reader's read row; an insert key-shares the conversation row,
 * so it waits for a removal and holds nothing while it does).
 *
 * THE ACCOUNT DELETION (utils/accountDeletion.ts, settleConversationsOfDeletedAccount
 * below) takes, after its member rows, secure channels, E2E material and the
 * account row (FOR UPDATE), EVERY conversation row of the account FOR UPDATE
 * in id order, in one statement, before it touches anything in any of them:
 * the account row lock holds back every new conversation with the account
 * (its insert key-shares that row), so the set it locks is the whole set.
 * Then, under those locks: the other sides' read rows (read), the account's
 * messages in the conversations that survive (rewritten to placeholders,
 * each message row before its reaction and attachment rows, which are
 * deleted), the other sides' read rows it unhides, the conversations' sides
 * (set NULL), and the conversations that do not survive (deleted, with their
 * cascade); last, the user delete and its cascade (the account's messages in
 * channels, its reactions and read rows everywhere). Against the four
 * transactions above, by the other person: each takes the conversation row
 * first and then only rows the deletion does not hold before its own lock on
 * that conversation (the other person's account row, read row and messages,
 * a reply's parent, new rows), so either it commits first and the deletion
 * waits for it at the conversation row, or it waits there for the deletion
 * and then finds the conversation read-only (the write, an edit, a reaction:
 * 403 CONVERSATION_READ_ONLY_MESSAGE; a delete of one's own message and a
 * removal go on) or gone (404 `Conversation`). By the deleted account itself
 * (a request in flight, or the "call ended" notice its sockets' disconnect
 * writes once its sessions are revoked): an insert key-shares the account
 * row the deletion holds, while the deletion waits for the conversation row
 * that insert's transaction holds. That cycle is real; PostgreSQL aborts one
 * side and it runs again whole (all of them run under
 * retryOnTransactionConflict, the account deletion included), and the
 * account's own write retried after the deletion committed finds no
 * conversation (404) or no longer a participant in it (403). Two deletions of
 * the two people of one conversation take it in the same id order; the
 * second finds the first's NULL side and deletes the conversation. The
 * registration hygiene sweep takes the same step for the stale unverified
 * accounts it deletes: their account rows first (FOR UPDATE, id order), then
 * every conversation of them in one statement (FOR UPDATE, id order), then
 * the step for each account, then the accounts.
 */

const LOG_PREFIX = '[DM]';

/** The conversation row, locked FOR KEY SHARE (a message write, a reopen); false: it is gone. */
async function keyShareConversationRow(tx: Prisma.TransactionClient, conversationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM conversations WHERE id = ${conversationId} FOR KEY SHARE`;
  return rows.length > 0;
}

/** The conversation row, locked FOR UPDATE (a removal); false: it is gone. */
async function lockConversationRowForRemoval(tx: Prisma.TransactionClient, conversationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
  return rows.length > 0;
}

/** What a message write learnt under the conversation row lock. */
export interface MessageWriteContext {
  /** The `createdAt` the new row MUST carry: later than every floor and the newest message (newMessageTime). */
  createdAt: Date;
  /** Both read rows as they stand under the lock (a removal cannot change them meanwhile). */
  sides: ConversationSideState[];
  /** The author's own floor, for the checks of the write (a reply's parent). */
  authorFloor: Date | null;
}

/**
 * Write a message into a conversation and bring the conversation back for
 * every side that had it hidden, in ONE transaction (see the lock order
 * above), run again whole after a deadlock:
 *  1. the conversation row FOR KEY SHARE (gone: 404 `Conversation`);
 *  2. the participation of the author, re-checked after any wait (403), and
 *     both read rows; a conversation whose other side's account is gone is
 *     refused (403 CONVERSATION_READ_ONLY_MESSAGE), a call notice as much as
 *     a message, and so is one that an account deletion turned read-only
 *     while this write waited for its row; the newest message's time (one
 *     indexed max);
 *  3. `write`, which inserts the row with `createdAt: context.createdAt` and
 *     whatever goes with it (attachments), repeats its own checks against
 *     `context.authorFloor`, and resolves the row as it must be sent;
 *  4. in ONE statement, every side that has it hidden and whose floor is
 *     older than the new row unhides it (by construction every floor is).
 * After the commit, in this order and holding nothing:
 *  5. the audience, read again (readConversationAudience): a removal queued
 *     behind the write commits as soon as the write does, and the floor it
 *     sets must decide who is told;
 *  6. `announce`, which sends the event to that audience (an error there is
 *     logged: the message is written and the request still answers it);
 *  7. the list-order bump of the conversation (best effort, logged). It
 *     waits for any removal holding the row, so it comes after the event:
 *     before it, every event that met a removal went out late, with an
 *     audience read before that removal.
 */
export async function writeConversationMessage<T extends { createdAt: Date }>(
  conversationId: string,
  authorId: string,
  write: (tx: Prisma.TransactionClient, context: MessageWriteContext) => Promise<T>,
  announce: (message: T, audience: ConversationSideState[]) => void | Promise<void>,
): Promise<{ message: T; context: MessageWriteContext }> {
  const committed = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    if (!(await keyShareConversationRow(tx, conversationId))) throw new NotFoundError('Conversation');
    const view = await readConversationView(conversationId, authorId, tx);
    if (!view) throw new ForbiddenError('Not a participant of this conversation');
    if (isReadOnlyConversation(view)) throw new ForbiddenError(CONVERSATION_READ_ONLY_MESSAGE);

    const newest = await tx.message.aggregate({ where: { conversationId }, _max: { createdAt: true } });
    const context: MessageWriteContext = {
      createdAt: newMessageTime(new Date(), view.sides, newest._max.createdAt),
      sides: view.sides,
      authorFloor: view.floor,
    };
    const message = await write(tx, context);
    if (message.createdAt.getTime() !== context.createdAt.getTime()) {
      // The guarantee that a new message is above every floor and after
      // every existing message rests on it
      throw new Error('writeConversationMessage: the row must carry context.createdAt');
    }

    // Under the lock nobody can hide it meanwhile (a removal waits), so a
    // conversation nobody has hidden needs no statement at all
    if (view.sides.some((s) => s.hiddenAt !== null)) {
      await tx.conversationRead.updateMany({
        where: {
          conversationId,
          hiddenAt: { not: null },
          OR: [{ clearedAt: null }, { clearedAt: { lt: context.createdAt } }],
        },
        data: { hiddenAt: null },
      });
    }
    return { message, context };
  }, LOCK_WAIT_TRANSACTION_OPTIONS), `${LOG_PREFIX} A message write in conversation ${conversationId}`);

  // The event, to the audience as it stands after the commit
  const audience = await readConversationAudience(conversationId, committed.context.sides);
  try {
    await announce(committed.message, audience);
  } catch (err) {
    console.error(`${LOG_PREFIX} A message was written in conversation ${conversationId}, but announcing it failed:`, describeCaughtError(err));
  }

  // The list order (`updatedAt`, both people's lists): the only write to the
  // conversation row besides its creation and its real deletion. After the
  // event (it can wait for a removal holding the row) and never failing the
  // send: a conversation deleted with an account meanwhile updates no row.
  try {
    await prisma.conversation.updateMany({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  } catch (err) {
    console.warn(`${LOG_PREFIX} The list order of conversation ${conversationId} was not moved after a new message:`, describeCaughtError(err));
  }
  return committed;
}

/** What a committed removal leaves its route to do. */
export interface ConversationRemoval {
  /** Nobody could reach anything of it any more: the conversation and its rows were deleted. */
  deleted: boolean;
  /** The remover's floor after a removal that cleared their history (null: nothing cleared). */
  clearedUntil: Date | null;
  /** The files of a deleted conversation's attachments, to delete after the commit. */
  attachmentKeys: string[];
}

/**
 * Remove a conversation for the person who asks ONLY (#47), in one
 * transaction (see the lock order above), run again whole after a deadlock:
 *  1. the conversation row FOR UPDATE (gone: 404 `Conversation`), then the
 *     participation (403);
 *  2. the newest message, read under that lock;
 *  3. ONE upsert of the remover's read row: hidden, the last read raised to
 *     that message (no unread count survives), and with `clearHistory` the
 *     floor raised to it (it never moves back: GREATEST, which keeps the old
 *     floor when the conversation is empty);
 *  4. every side's state with an EXISTS above its floor, and the
 *     real-deletion rule (nobodyCanReach): when nobody can reach anything,
 *     the attachment keys and the conversation's delete, in this transaction.
 * The `conversations` row is never written otherwise: its `updatedAt`
 * orders the other person's list, and they are told nothing.
 */
export function removeConversationForUser(
  conversationId: string,
  userId: string,
  opts: { clearHistory: boolean },
): Promise<ConversationRemoval> {
  return retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    if (!(await lockConversationRowForRemoval(tx, conversationId))) throw new NotFoundError('Conversation');
    const sides = await tx.conversation.findUnique({ where: { id: conversationId }, select: { user1Id: true, user2Id: true } });
    if (!sides) throw new NotFoundError('Conversation');
    if (sides.user1Id !== userId && sides.user2Id !== userId) throw new ForbiddenError('Not a participant of this conversation');

    const newest = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const now = new Date();
    const readUpTo = newest?.createdAt ?? now;
    const floor = opts.clearHistory ? newest?.createdAt ?? null : null;
    const own = await tx.$queryRaw<Array<{ clearedAt: Date | null }>>`
      INSERT INTO conversation_reads (user_id, conversation_id, last_read_at, hidden_at, cleared_at)
      VALUES (${userId}, ${conversationId}, ${readUpTo}, ${now}, ${floor})
      ON CONFLICT (user_id, conversation_id) DO UPDATE SET
        hidden_at = COALESCE(conversation_reads.hidden_at, EXCLUDED.hidden_at),
        last_read_at = GREATEST(conversation_reads.last_read_at, EXCLUDED.last_read_at),
        cleared_at = GREATEST(conversation_reads.cleared_at, EXCLUDED.cleared_at)
      RETURNING cleared_at AS "clearedAt"`;
    const clearedUntil = opts.clearHistory ? own[0]?.clearedAt ?? null : null;

    // Every side's state under the lock, with whether anything lies above its
    // floor: no message can arrive and no side can change while it is held
    const states = await tx.$queryRaw<Array<{ userId: string; hidden: boolean; messageAboveFloor: boolean }>>`
      SELECT r.user_id AS "userId", (r.hidden_at IS NOT NULL) AS hidden,
        EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = r.conversation_id
            AND (r.cleared_at IS NULL OR m.created_at > r.cleared_at)
        ) AS "messageAboveFloor"
      FROM conversation_reads r
      WHERE r.conversation_id = ${conversationId}`;
    const reachOf = (sideUserId: string | null): SideReach => {
      if (sideUserId === null) return { userId: null, hidden: true, messageAboveFloor: false };
      const state = states.find((s) => s.userId === sideUserId);
      // no read row: never hidden, so it can reach the conversation
      return state ?? { userId: sideUserId, hidden: false, messageAboveFloor: true };
    };
    if (!nobodyCanReach([reachOf(sides.user1Id), reachOf(sides.user2Id)])) {
      return { deleted: false, clearedUntil, attachmentKeys: [] };
    }

    // Nobody can see anything of it any more: its rows go, the files after
    // the commit (their keys read here, before the cascade takes the rows)
    const attachmentKeys = await collectAttachmentKeys({ conversationId }, tx);
    await tx.conversation.delete({ where: { id: conversationId } });
    return { deleted: true, clearedUntil, attachmentKeys };
  }, LOCK_WAIT_TRANSACTION_OPTIONS), `${LOG_PREFIX} The removal of conversation ${conversationId}`);
}

/**
 * Open a conversation again for the person who asks (POST /dm on an existing
 * pair, with `withUserId`): their `hiddenAt` cleared, their floor kept, so it
 * is back on their list with only what lies above the floor. One
 * transaction, the conversation row first (FOR KEY SHARE: it queues behind a
 * removal that may be deleting the row, and behind an account deletion
 * settling it), then its sides as they stand under that lock:
 *  - 'reopened': both people are its sides; the caller's side is unhidden;
 *  - 'missing': the row is gone (a removal or an account deletion deleted it
 *    meanwhile), and the caller creates a new conversation;
 *  - 'other-side-gone': `withUserId` is no longer a side (their account was
 *    deleted while this waited, and the conversation was kept read-only):
 *    nothing is written, and the caller answers as for an unknown account.
 */
export function reopenConversationForUser(
  conversationId: string,
  userId: string,
  withUserId: string,
): Promise<'reopened' | 'missing' | 'other-side-gone'> {
  return retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    if (!(await keyShareConversationRow(tx, conversationId))) return 'missing' as const;
    const sides = await tx.conversation.findUnique({ where: { id: conversationId }, select: { user1Id: true, user2Id: true } });
    if (!sides) return 'missing' as const;
    if (sides.user1Id !== withUserId && sides.user2Id !== withUserId) return 'other-side-gone' as const;
    await tx.conversationRead.updateMany({
      where: { userId, conversationId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    return 'reopened' as const;
  }, LOCK_WAIT_TRANSACTION_OPTIONS), `${LOG_PREFIX} The reopening of conversation ${conversationId}`);
}

/**
 * An edit, a reaction or the delete of one message of a conversation, in one
 * transaction that takes the conversation row FOR KEY SHARE first (as a new
 * message does; see the lock order above), run again whole after a deadlock:
 *  1. the conversation row (gone: 404 `Conversation`), then the participation
 *     of the caller, re-checked after any wait (403);
 *  2. with `refuseReadOnly` (an edit, a reaction), a conversation whose other
 *     side's account is gone is refused (403 CONVERSATION_READ_ONLY_MESSAGE).
 *     An account deletion holds the row FOR UPDATE while it turns the
 *     conversation read-only, so a change that waited for it sees the NULL
 *     side here and is refused, instead of landing in a read-only
 *     conversation (a reaction on a row the deletion has just reduced to a
 *     placeholder). A delete of one's own message is allowed there;
 *  3. `act`, the write, on the transaction's own client, with the view read
 *     under the lock (the caller's floor among it).
 * The route's own early checks (the same view, the message, its author) stay
 * before it: this repeats under the lock only what an account deletion or a
 * real deletion of the conversation can change while the request runs.
 */
export function changeConversationMessage<T>(
  conversationId: string,
  userId: string,
  opts: { refuseReadOnly: boolean },
  act: (tx: Prisma.TransactionClient, view: ConversationView) => Promise<T>,
): Promise<T> {
  return retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    if (!(await keyShareConversationRow(tx, conversationId))) throw new NotFoundError('Conversation');
    const view = await readConversationView(conversationId, userId, tx);
    if (!view) throw new ForbiddenError('Not a participant of this conversation');
    if (opts.refuseReadOnly && isReadOnlyConversation(view)) throw new ForbiddenError(CONVERSATION_READ_ONLY_MESSAGE);
    return act(tx, view);
  }, LOCK_WAIT_TRANSACTION_OPTIONS), `${LOG_PREFIX} A change of a message in conversation ${conversationId}`);
}

/** What an account deletion did with the account's direct conversations, for the steps after its commit. */
export interface DeletedAccountConversations {
  /** Survived for the other person, read-only (`dm:conversation:read_only` goes to their rooms). */
  kept: string[];
  /** Deleted with every row in them (their rooms are emptied). */
  deleted: string[];
  /**
   * The files to delete after the commit: those of the deleted account's own
   * messages in the conversations kept, and every file of the conversations
   * deleted. Never a file of the other person's messages in a conversation
   * kept.
   */
  attachmentKeys: string[];
}

/**
 * What an account deletion does with every direct conversation of the
 * account, inside the deletion's transaction (utils/accountDeletion.ts; the
 * registration hygiene sweep runs it too, for each stale unverified account
 * it deletes, utils/registrationHygiene.ts), after the account row is locked
 * and before the account is deleted:
 *  1. every conversation row of the account FOR UPDATE, in id order, in one
 *     statement (see the lock order above), its sides read under the lock;
 *  2. with `keep` off: every one of them deleted, both people's messages,
 *     files, reactions and read rows with it, as an account deletion always
 *     did. Deleted explicitly here, so that nothing rests on the foreign
 *     keys from the sides to the account (CASCADE today): with every
 *     conversation of the account settled before the user delete, no cascade
 *     reaches one, and the keys can later become SET NULL without changing
 *     what a deletion does;
 *  3. with `keep` on, each decided under its lock
 *     (conversationAfterAccountDeletion) from whether it holds any message,
 *     the other side's read row and whether anything lies above its floor: a
 *     conversation that holds no message at all, whose other side is gone
 *     too, or that the other person removed with nothing above their floor,
 *     is deleted as in 2; every other one SURVIVES for the other person,
 *     read-only:
 *       - each message of the account there becomes a placeholder that keeps
 *         only its id, its conversation and its time (type `deleted`, empty
 *         content, not encrypted, no author, quote, edit time, webhook marks
 *         or `@everyone` claim); a call notice of the account ("Voice call
 *         started" / "ended": a `system` row holding one of DM_SYSTEM_NOTICES)
 *         keeps its fixed text and only loses its author. Each such row
 *         first (the row before its children, as every writer of messages
 *         takes them), then its reactions (the other person's too) and its
 *         attachment rows are deleted, the files after the commit;
 *       - the other person's read row: hidden (they had removed it without
 *         clearing what is there) becomes unhidden, so the conversation is
 *         back on their list; their floor and last read stay;
 *       - the account's side becomes NULL. A raw statement that names only
 *         the two sides: the `conversations` row's `updated_at` orders the
 *         other person's list and is never written here;
 *     the other person's own messages, files and reactions are not touched.
 * The account's own read rows, its reactions on the other person's messages
 * and its messages anywhere else go with the user delete that follows.
 * A conversation with both sides NULL is never left behind: one whose other
 * side is already gone is always deleted.
 */
export async function settleConversationsOfDeletedAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  opts: { keep: boolean },
): Promise<DeletedAccountConversations> {
  const conversations = await tx.$queryRaw<Array<{ id: string; user1Id: string | null; user2Id: string | null }>>`
    SELECT id, user1_id AS "user1Id", user2_id AS "user2Id"
    FROM conversations
    WHERE user1_id = ${userId} OR user2_id = ${userId}
    ORDER BY id
    FOR UPDATE`;
  const result: DeletedAccountConversations = { kept: [], deleted: [], attachmentKeys: [] };
  if (conversations.length === 0) return result;

  // The other side of each, under the locks (NULL: that account is gone too)
  const others = conversations.map((c) => ({ id: c.id, otherId: c.user1Id === userId ? c.user2Id : c.user1Id }));
  const unhide: Array<{ conversationId: string; userId: string }> = [];
  if (!opts.keep) {
    result.deleted = others.map((o) => o.id);
  } else {
    const live = others.filter((o): o is { id: string; otherId: string } => o.otherId !== null);
    const states = live.length === 0 ? [] : await tx.$queryRaw<Array<{ conversationId: string; hidden: boolean; messageAboveFloor: boolean; hasMessages: boolean }>>`
      SELECT s.id AS "conversationId", (r.hidden_at IS NOT NULL) AS hidden,
        EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = s.id
            AND (r.cleared_at IS NULL OR m.created_at > r.cleared_at)
        ) AS "messageAboveFloor",
        EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = s.id) AS "hasMessages"
      FROM unnest(${live.map((o) => o.id)}::text[], ${live.map((o) => o.otherId)}::text[]) AS s(id, other_id)
      LEFT JOIN conversation_reads r ON r.conversation_id = s.id AND r.user_id = s.other_id`;
    const stateOf = new Map(states.map((s) => [s.conversationId, s]));
    for (const { id, otherId } of others) {
      if (otherId === null) {
        result.deleted.push(id);
        continue;
      }
      // every live pair has a state row (the LEFT JOIN over the pairs); were
      // one missing, the conversation would be kept, never deleted on a guess
      const state = stateOf.get(id) ?? { hidden: false, messageAboveFloor: true, hasMessages: true };
      const outcome = conversationAfterAccountDeletion(userId, { userId: otherId, hidden: state.hidden, messageAboveFloor: state.messageAboveFloor }, state.hasMessages);
      if (!outcome.survives) {
        result.deleted.push(id);
        continue;
      }
      result.kept.push(id);
      if (outcome.unhide) unhide.push({ conversationId: id, userId: otherId });
    }
  }

  if (result.kept.length > 0) {
    // The account's messages there, rewritten in place: a placeholder, or a
    // call notice that only loses its author. The CASE reads the row's old
    // values (in an UPDATE every right-hand side does).
    const rewritten = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE messages SET
        type = CASE WHEN type = 'system' AND content = ANY(${[...DM_SYSTEM_NOTICES]}::text[]) THEN type ELSE ${DELETED_MESSAGE_TYPE} END,
        content = CASE WHEN type = 'system' AND content = ANY(${[...DM_SYSTEM_NOTICES]}::text[]) THEN content ELSE '' END,
        author_id = NULL,
        encrypted = false,
        reply_to_id = NULL,
        edited_at = NULL,
        mentions_everyone = false,
        webhook_id = NULL,
        webhook_name = NULL
      WHERE conversation_id = ANY(${result.kept}::text[]) AND author_id = ${userId}
      RETURNING id`;
    const ids = rewritten.map((r) => r.id);
    if (ids.length > 0) {
      await tx.$executeRaw`DELETE FROM message_reactions WHERE message_id = ANY(${ids}::text[])`;
      const files = await tx.$queryRaw<Array<{ s3Key: string; expired: boolean }>>`
        DELETE FROM message_attachments WHERE message_id = ANY(${ids}::text[])
        RETURNING s3_key AS "s3Key", expired`;
      for (const file of files) {
        // An expired row's file is already gone; only keys of the attachment
        // shape ever reach the store (collectAttachmentKeys' rule)
        if (file.expired) continue;
        if (VALID_ATTACHMENT_KEY_RE.test(file.s3Key)) result.attachmentKeys.push(file.s3Key);
        else console.warn('[Attachments] Skipping a stored attachment key of an unexpected shape');
      }
    }
    if (unhide.length > 0) {
      await tx.conversationRead.updateMany({
        where: { OR: unhide, hiddenAt: { not: null } },
        data: { hiddenAt: null },
      });
    }
    await tx.$executeRaw`
      UPDATE conversations SET
        user1_id = CASE WHEN user1_id = ${userId} THEN NULL ELSE user1_id END,
        user2_id = CASE WHEN user2_id = ${userId} THEN NULL ELSE user2_id END
      WHERE id = ANY(${result.kept}::text[])`;
  }

  if (result.deleted.length > 0) {
    // Their files after the commit, their keys read here under the locks,
    // right before the cascade takes the rows
    result.attachmentKeys.push(...await collectAttachmentKeys({ conversationId: { in: result.deleted } }, tx));
    await tx.conversation.deleteMany({ where: { id: { in: result.deleted } } });
  }
  return result;
}
