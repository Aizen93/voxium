import type { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, Message, ServerToClientEvents } from '@voxium/shared';
import { prisma } from './prisma';
import { SIDE_STATE_SELECT, rowForViewer, sidesBelowFloor, type ConversationSideState } from './conversationVisibility';
import { describeCaughtError } from './loggableError';

/**
 * Who receives an event about one message of a direct conversation (#47):
 * the DM room, without the people whose floor hides that message. Every
 * sender of a DM message event goes through here (routes/dm.ts, the call
 * notices of websocket/dmVoiceHandler.ts, the admin report resolution in
 * routes/admin.ts), so nobody is told about a row they cleared.
 *
 * The audience is read when the event goes out, AFTER the write committed
 * (readConversationAudience): a removal can commit between a message's
 * commit and its event, and the floor it set must be seen. The people the
 * floor hides are left out by their `user:{id}` room (`except`); everyone
 * else in `dm:{id}` gets the event.
 */

type IO = Pick<SocketServer<ClientToServerEvents, ServerToClientEvents>, 'to'>;

const userRoom = (userId: string) => `user:${userId}`;

/**
 * Both read rows of a conversation as they stand now. A failed read is
 * logged and answered with `fallback` (the rows read before the write, or
 * none): an event then reaches someone who cleared the row, which a reload
 * corrects; leaving everyone without it would drop a message the other
 * person is waiting for.
 */
export async function readConversationAudience(
  conversationId: string,
  fallback: readonly ConversationSideState[] = [],
): Promise<ConversationSideState[]> {
  try {
    return await prisma.conversationRead.findMany({ where: { conversationId }, select: SIDE_STATE_SELECT });
  } catch (err) {
    console.warn(`[DM] The audience of an event in conversation ${conversationId} could not be read (the floors read earlier apply):`, describeCaughtError(err));
    return [...fallback];
  }
}

/** The DM room without the people who cannot see a row written at `createdAt`. */
export function viewersRoom(io: IO, conversationId: string, sides: readonly ConversationSideState[], createdAt: Date): ReturnType<IO['to']> {
  const room = io.to(`dm:${conversationId}`);
  const blind = sidesBelowFloor(sides, createdAt);
  return blind.length > 0 ? room.except(blind.map(userRoom)) : room;
}

/**
 * A new or edited message to the people who can see it: nothing to a side
 * whose floor hides the row, the row without its quote (a deleted quote) to
 * a side whose floor hides only the quoted row, the row as it is to the rest
 * of the DM room. The quote's time is read to decide and never sent.
 */
export function emitRowToViewers(
  io: IO,
  event: 'dm:message:new' | 'dm:message:update',
  conversationId: string,
  sides: readonly ConversationSideState[],
  row: { createdAt: Date; replyTo: { createdAt: Date } | null },
): void {
  const blind = sidesBelowFloor(sides, row.createdAt);
  const quoteBlind = row.replyTo
    ? sidesBelowFloor(sides, row.replyTo.createdAt).filter((userId) => !blind.includes(userId))
    : [];
  const skipped = [...blind, ...quoteBlind];
  const room = io.to(`dm:${conversationId}`);
  (skipped.length > 0 ? room.except(skipped.map(userRoom)) : room).emit(event, rowForViewer(row, null) as unknown as Message);
  for (const userId of quoteBlind) {
    io.to(userRoom(userId)).emit(event, { ...row, replyTo: null } as unknown as Message);
  }
}
