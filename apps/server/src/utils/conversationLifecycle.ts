import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { ForbiddenError, NotFoundError } from './errors';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from './transactionRetry';
import { collectAttachmentKeys } from './attachmentBlobs';
import { readConversationAudience } from './conversationAudience';
import {
  newMessageTime,
  nobodyCanReach,
  readConversationView,
  type ConversationSideState,
  type SideReach,
} from './conversationVisibility';

/**
 * The transactions that change one person's side of a direct conversation
 * (#47): a new message, a removal, a reopen. What each person sees is
 * decided in utils/conversationVisibility.ts.
 *
 * LOCK ORDER of every transaction that touches a conversation. The
 * conversation row comes FIRST in each of the three below, and none takes
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
 *    SHARE, then the opener's read row.
 *  Message writes share the conversation row and meet only on a read row
 *  they both unhide (in the same index order); a removal queues behind every
 *  message write and every removal or reopen of that conversation, and they
 *  queue behind it.
 * Outside a transaction: the creation (POST /dm: the conversation insert,
 * which key-shares both account rows, then both read rows), the mark-read
 * upsert (the reader's read row; an insert key-shares the conversation row,
 * so it waits for a removal and holds nothing while it does), an edit, a
 * message delete and a reaction (the message row, and through a reaction's
 * keys the message and the account).
 *
 * THE ACCOUNT DELETION (utils/accountDeletion.ts) takes the account row FOR
 * UPDATE and then cascades into every conversation of the account (both
 * sides), their messages and read rows, and the account's own messages and
 * read rows elsewhere, in the order PostgreSQL fires the cascade triggers,
 * which is the text order of the trigger names and can differ between
 * databases. One of the three transactions above, holding a conversation row
 * of that account, can then need a row the cascade already holds: the
 * author's or the remover's account row (for the key of an insert), a read
 * row the cascade deleted first, a message of the account that a real
 * deletion's cascade reaches, while the cascade waits for that conversation
 * row. No single order serves both, since the cascade's order is the
 * triggers'. PostgreSQL aborts one side and it runs again whole: all of them
 * run under retryOnTransactionConflict, the account deletion included, and
 * one of the three retried after the account deletion committed finds no
 * conversation row and answers 404 `Conversation`.
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
 *     both read rows; the newest message's time (one indexed max);
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
    console.error(`${LOG_PREFIX} A message was written in conversation ${conversationId}, but announcing it failed:`, err instanceof Error ? err.message : err);
  }

  // The list order (`updatedAt`, both people's lists): the only write to the
  // conversation row besides its creation and its real deletion. After the
  // event (it can wait for a removal holding the row) and never failing the
  // send: a conversation deleted with an account meanwhile updates no row.
  try {
    await prisma.conversation.updateMany({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  } catch (err) {
    console.warn(`${LOG_PREFIX} The list order of conversation ${conversationId} was not moved after a new message:`, err instanceof Error ? err.message : err);
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
 * pair): their `hiddenAt` cleared, their floor kept, so it is back on their
 * list with only what lies above the floor. One transaction, the
 * conversation row first (FOR KEY SHARE: it queues behind a removal that
 * may be deleting the row). False: the row is gone (a removal deleted it
 * meanwhile), and the caller creates a new conversation.
 */
export function reopenConversationForUser(conversationId: string, userId: string): Promise<boolean> {
  return retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
    if (!(await keyShareConversationRow(tx, conversationId))) return false;
    await tx.conversationRead.updateMany({
      where: { userId, conversationId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    return true;
  }, LOCK_WAIT_TRANSACTION_OPTIONS), `${LOG_PREFIX} The reopening of conversation ${conversationId}`);
}
