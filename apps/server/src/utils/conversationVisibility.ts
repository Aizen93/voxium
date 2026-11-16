import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { ForbiddenError, NotFoundError } from './errors';

/**
 * What one person of a direct conversation can still see of it: THE rule,
 * for every reader and every action on a conversation's messages (#47).
 *
 * Removing a conversation is one person's act, kept on their own
 * `conversation_reads` row (never on `conversations`, whose `updatedAt`
 * orders the other person's list):
 *  - `hiddenAt`: the conversation is off their list. It comes back when a
 *    message newer than their floor is written (utils/conversationLifecycle.ts
 *    writeConversationMessage) or when they open it again (POST /dm).
 *  - `clearedAt`: their FLOOR. A message whose `createdAt` is at or below it
 *    is gone for them for good: absent from every page, the list preview and
 *    the unread counts, refused like a missing message by every action
 *    (edit, delete, reaction, reply, report, attachment download), and a
 *    quote of it comes back as a deleted quote. The floor never moves back.
 * A message is visible above the floor, STRICTLY (`createdAt > floor`); the
 * writer makes every new message's `createdAt` later than every floor
 * (newMessageTime), so a message written after a removal is always
 * seen by everyone and brings the conversation back.
 *
 * A side whose account is gone (a NULL `user1Id` / `user2Id`) is no
 * participant: it sees nothing, counts as hidden with an infinite floor in
 * the real-deletion rule (nobodyCanReach) and is never in an audience.
 *
 * The rule exists once, here, in three forms that must agree: the predicate
 * (isAboveFloor), the Prisma filter (aboveFloorWhere) and the SQL used by the
 * raw readers (dmUnreadSinceSql, dmListedSql and the EXISTS of
 * conversationLifecycle.ts). No route compares a time with a floor itself.
 */

/** One person's removal state, as their read row holds it. */
export interface ConversationSideState {
  userId: string;
  hiddenAt: Date | null;
  clearedAt: Date | null;
}

/** The read-row columns every view selects, for both sides. */
export const SIDE_STATE_SELECT = { userId: true, hiddenAt: true, clearedAt: true } as const;

/** Whether a row written at `createdAt` is visible to a person whose floor is `floor` (null: none). */
export function isAboveFloor(createdAt: Date, floor: Date | null): boolean {
  return floor === null || createdAt.getTime() > floor.getTime();
}

/** The Prisma filter for the messages above a floor: nothing to add without one. */
export function aboveFloorWhere(floor: Date | null): Prisma.MessageWhereInput {
  return floor === null ? {} : { createdAt: { gt: floor } };
}

/**
 * A message this viewer may see or act on: it exists, belongs to this
 * conversation and lies above their floor. Every action answers a message
 * that fails this exactly like a missing one.
 */
export function isVisibleMessage<M extends { conversationId: string | null; createdAt: Date }>(
  message: M | null | undefined,
  conversationId: string,
  floor: Date | null,
): message is M {
  return !!message && message.conversationId === conversationId && isAboveFloor(message.createdAt, floor);
}

/**
 * The people (among the live sides' read rows) who can NOT see a row written
 * at `createdAt`: their floor is at or above it. A message event about such a
 * row skips them (their `user:{id}` room is excepted).
 */
export function sidesBelowFloor(sides: readonly ConversationSideState[], createdAt: Date): string[] {
  return sides.filter((s) => !isAboveFloor(createdAt, s.clearedAt)).map((s) => s.userId);
}

/**
 * A quote as one viewer may see it: null (the client shows "original message
 * deleted", the row keeps its `replyToId`) when the quoted row is at or
 * below their floor. The quote's `createdAt` is read only to decide this and
 * never leaves the server.
 */
export function quoteForViewer<Q extends { createdAt: Date }>(
  quote: Q | null,
  floor: Date | null,
): Omit<Q, 'createdAt'> | null {
  if (!quote) return null;
  const { createdAt, ...rest } = quote;
  return isAboveFloor(createdAt, floor) ? rest : null;
}

/**
 * A row as one viewer receives it: its quote only when the quoted row lies
 * above the viewer's floor (quoteForViewer), the quote's time never sent.
 */
export function rowForViewer<S extends { replyTo: { createdAt: Date } | null }>(row: S, floor: Date | null) {
  return { ...row, replyTo: quoteForViewer(row.replyTo, floor) };
}

/**
 * The `createdAt` a new message must carry: the latest of now, one
 * millisecond after the highest floor, and one millisecond after the newest
 * message already there. A floor is an earlier message's `createdAt`,
 * written by whichever clock wrote that message (another node's, or this
 * one's in the same millisecond), so `now` alone could land at or below a
 * floor just set: the message would be invisible to the person who cleared
 * and would never bring the conversation back for them. And once the clock
 * is behind a floor, `floor + 1 ms` alone gives every later message the same
 * stamp, which a `before=<createdAt>` page then skips: one millisecond after
 * the newest message keeps the stamps strictly increasing, and never puts a
 * new message before an existing one. (Two writes in the same millisecond
 * read the same newest message and can still tie, as two writes at the same
 * clock time always could.)
 */
export function newMessageTime(
  now: Date,
  sides: readonly { clearedAt: Date | null }[],
  newestMessageAt: Date | null,
): Date {
  let at = now.getTime();
  for (const s of sides) {
    if (s.clearedAt) at = Math.max(at, s.clearedAt.getTime() + 1);
  }
  if (newestMessageAt) at = Math.max(at, newestMessageAt.getTime() + 1);
  return at === now.getTime() ? now : new Date(at);
}

/**
 * SQL, for the raw unread counts: the time after which a DM row counts as
 * unread for the read row `alias` (a LEFT JOIN, so possibly NULL): the
 * later of the last read and the floor. The alias is a constant of the
 * caller's query, never input.
 */
export function dmUnreadSinceSql(alias: string): string {
  return `GREATEST(COALESCE(${alias}.last_read_at, '1970-01-01'::timestamp), COALESCE(${alias}.cleared_at, '1970-01-01'::timestamp))`;
}

/** SQL: the read row `alias` (a LEFT JOIN, so possibly NULL) does not hide its conversation. */
export function dmListedSql(alias: string): string {
  return `${alias}.hidden_at IS NULL`;
}

/** One side as the real-deletion rule sees it. */
export interface SideReach {
  /** NULL: that account is gone. */
  userId: string | null;
  hidden: boolean;
  /** At least one message lies above this side's floor. */
  messageAboveFloor: boolean;
}

/**
 * Whether NOBODY can reach anything of a conversation any more, so that its
 * rows can really be deleted: every live side has it hidden, and each live
 * side either has nothing above its floor or faces a deleted side (no message
 * can arrive and nobody to reopen it with). A deleted side counts as hidden
 * with an infinite floor. A live side without a read row is not hidden (the
 * caller passes it so). Decided under the conversation row lock
 * (conversationLifecycle.ts), never from `updatedAt`.
 */
export function nobodyCanReach(sides: readonly [SideReach, SideReach]): boolean {
  return sides.every((side, i) => {
    if (side.userId === null) return true;
    const facesDeletedSide = sides[1 - i].userId === null;
    return side.hidden && (!side.messageAboveFloor || facesDeletedSide);
  });
}

/** A conversation as one participant sees it. */
export interface ConversationView {
  id: string;
  user1Id: string | null;
  user2Id: string | null;
  /** The viewer's floor (null: none). */
  floor: Date | null;
  /** The viewer has it off their list. */
  hidden: boolean;
  /** Every live side's read row (at most two), for the audiences of message events. */
  sides: ConversationSideState[];
}

type ViewReader = Pick<Prisma.TransactionClient, 'conversation'>;

interface ConversationSidesRow {
  id: string;
  user1Id: string | null;
  user2Id: string | null;
  reads: ConversationSideState[];
}

/** The conversation and both read rows, in one statement (a relation load is one query, schema `relationJoins`). */
function readSides(db: ViewReader, conversationId: string): Promise<ConversationSidesRow | null> {
  return db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, user1Id: true, user2Id: true, reads: { select: SIDE_STATE_SELECT } },
  });
}

/** A NULL side never equals a user id, so nobody passes as a deleted account. */
function isParticipant(row: ConversationSidesRow, userId: string): boolean {
  return row.user1Id === userId || row.user2Id === userId;
}

function toView(row: ConversationSidesRow, viewerId: string): ConversationView {
  const own = row.reads.find((r) => r.userId === viewerId);
  return {
    id: row.id,
    user1Id: row.user1Id,
    user2Id: row.user2Id,
    floor: own?.clearedAt ?? null,
    hidden: own?.hiddenAt != null,
    sides: row.reads,
  };
}

/**
 * The conversation as the participant `viewerId` sees it; null when it does
 * not exist or the viewer is not a participant. `db` is a transaction's own
 * client inside one.
 */
export async function readConversationView(
  conversationId: string,
  viewerId: string,
  db: ViewReader = prisma,
): Promise<ConversationView | null> {
  const row = await readSides(db, conversationId);
  return row && isParticipant(row, viewerId) ? toView(row, viewerId) : null;
}

/**
 * readConversationView() for the DM routes: 404 `Conversation` when it does
 * not exist, 403 when the caller is not a participant (the answers the
 * routes always gave).
 */
export async function loadConversationView(conversationId: string, viewerId: string): Promise<ConversationView> {
  const row = await readSides(prisma, conversationId);
  if (!row) throw new NotFoundError('Conversation');
  if (!isParticipant(row, viewerId)) throw new ForbiddenError('Not a participant of this conversation');
  return toView(row, viewerId);
}
