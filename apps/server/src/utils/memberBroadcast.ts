import { getIO } from '../websocket/socketServer';
import { replayVoiceState } from '../websocket/voiceHandler';
import { prisma } from './prisma';
import { filterVisibleChannels } from './permissionCalculator';
import type { UserRole, UserStatus, SupporterTier } from '@voxium/shared';

/**
 * Join a user's active socket(s) to the server room and the `channel:{id}`
 * rooms of every channel (text AND voice) they can VIEW. Channel rooms are the
 * visibility boundary for real-time events — joining unfiltered would leak
 * private-channel messages and voice presence to members without VIEW_CHANNEL.
 *
 * Adapter-wide room operations by the `user:{id}` room, never a
 * `fetchSockets()` round trip: the latter waits for every node's reply and
 * throws after 5 s when one peer is unresponsive, which skipped the
 * member:joined broadcast below (or the member:left one) for everyone.
 *
 * Twice on purpose: `io.local` applies the change to THIS node's sockets now,
 * and the cluster-wide call reaches every other node (the Redis adapter only
 * publishes it, and applies it here when its own message comes back one
 * round trip later — so without the local call the broadcast that follows
 * would still find the sockets in the rooms they are leaving, or miss the
 * ones they are joining). The echo re-applies the same join: idempotent.
 *
 * Returns the ids of the channels the user can view.
 */
async function joinVisibleChannelRooms(userId: string, serverId: string): Promise<string[]> {
  const io = getIO();
  const channels = await prisma.channel.findMany({
    where: { serverId },
    // `secure` is load-bearing: filterVisibleChannels can only apply the
    // membership-only rule to channels it can recognize as secure
    select: { id: true, secure: true },
  });
  const visible = await filterVisibleChannels(userId, serverId, channels);
  const visibleIds = visible.map((ch) => ch.id);
  const rooms = [`server:${serverId}`, ...visibleIds.map((id) => `channel:${id}`)];
  io.local.in(`user:${userId}`).socketsJoin(rooms);
  io.in(`user:${userId}`).socketsJoin(rooms);
  return visibleIds;
}

/**
 * After a user joins a server:
 * 1. Makes their active socket(s) join the `server:<id>` room and the
 *    visible `channel:<id>` rooms.
 * 2. Replays the server's live voice occupancy to them: every join and leave
 *    happened before their sockets were in the rooms, so without it the new
 *    member's sidebar shows the voice channels empty until someone moves.
 * 3. Broadcasts `member:joined` with safe user fields (no email) to all
 *    members in the server room.
 */
export async function broadcastMemberJoined(userId: string, serverId: string): Promise<void> {
  const io = getIO();

  const visibleIds = await joinVisibleChannelRooms(userId, serverId);

  try {
    await replayVoiceState(io.to(`user:${userId}`), [serverId], new Set(visibleIds), { source: 'connect' });
  } catch (err) {
    // The rooms are joined and the broadcast below still goes out: the voice
    // lists catch up on the member's next connect
    console.warn(`[Members] Voice occupancy replay to new member ${userId} failed:`, err instanceof Error ? err.message : err);
  }

  // Fetch only the fields needed for the broadcast (no email)
  const joinedUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, status: true, role: true, isSupporter: true, supporterTier: true, createdAt: true },
  });

  if (joinedUser) {
    io.to(`server:${serverId}`).emit('member:joined', {
      serverId,
      user: {
        ...joinedUser,
        bio: joinedUser.bio ?? null,
        status: joinedUser.status as UserStatus,
        role: joinedUser.role as UserRole,
        supporterTier: joinedUser.supporterTier as SupporterTier,
        createdAt: joinedUser.createdAt.toISOString(),
      },
    });
  }
}

/**
 * Makes a user's active socket(s) join the `server:<id>` room without
 * broadcasting.  Used when the user is the server creator (no one else
 * to notify).
 */
export async function joinServerRoom(userId: string, serverId: string): Promise<void> {
  await joinVisibleChannelRooms(userId, serverId);
}

/**
 * After a user leaves a server:
 * 1. Removes their socket(s) from the `server:<id>` room and ALL of the
 *    server's channel rooms (text and voice — no visibility filter needed,
 *    a departed member must receive nothing).
 * 2. Broadcasts `member:left` to remaining members.
 */
export async function broadcastMemberLeft(userId: string, serverId: string): Promise<void> {
  const io = getIO();

  const channels = await prisma.channel.findMany({
    where: { serverId },
    select: { id: true },
  });
  // Adapter-wide and fire-and-forget (see joinVisibleChannelRooms): the
  // departed member's sockets on every node leave the server room and every
  // channel room — this node's at once, so the broadcast below never reaches
  // them — and the broadcast never waits on a peer
  const rooms = [`server:${serverId}`, ...channels.map((ch) => `channel:${ch.id}`)];
  io.local.in(`user:${userId}`).socketsLeave(rooms);
  io.in(`user:${userId}`).socketsLeave(rooms);

  io.to(`server:${serverId}`).emit('member:left', { serverId, userId });
}
