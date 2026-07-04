import { getIO } from '../websocket/socketServer';
import { prisma } from './prisma';
import { filterVisibleChannels } from './permissionCalculator';
import type { UserRole, UserStatus, SupporterTier } from '@voxium/shared';

/**
 * Join a user's active socket(s) to the server room and the `channel:{id}`
 * rooms of every channel (text AND voice) they can VIEW. Channel rooms are the
 * visibility boundary for real-time events — joining unfiltered would leak
 * private-channel messages and voice presence to members without VIEW_CHANNEL.
 */
async function joinVisibleChannelRooms(userId: string, serverId: string): Promise<void> {
  const io = getIO();
  const channels = await prisma.channel.findMany({
    where: { serverId },
    select: { id: true },
  });
  const visible = await filterVisibleChannels(userId, serverId, channels);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.join(`server:${serverId}`);
    for (const ch of visible) {
      s.join(`channel:${ch.id}`);
    }
  }
}

/**
 * After a user joins a server:
 * 1. Makes their active socket(s) join the `server:<id>` room.
 * 2. Broadcasts `member:joined` with safe user fields (no email) to all
 *    members in the server room.
 */
export async function broadcastMemberJoined(userId: string, serverId: string): Promise<void> {
  const io = getIO();

  await joinVisibleChannelRooms(userId, serverId);

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
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.leave(`server:${serverId}`);
    for (const ch of channels) {
      s.leave(`channel:${ch.id}`);
    }
  }

  io.to(`server:${serverId}`).emit('member:left', { serverId, userId });
}
