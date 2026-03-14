import { getIO } from '../websocket/socketServer';
import { prisma } from './prisma';
import type { UserRole, UserStatus, SupporterTier } from '@voxium/shared';

/**
 * After a user joins a server:
 * 1. Makes their active socket(s) join the `server:<id>` room.
 * 2. Broadcasts `member:joined` with safe user fields (no email) to all
 *    members in the server room.
 */
export async function broadcastMemberJoined(userId: string, serverId: string): Promise<void> {
  const io = getIO();

  // Add the new member's socket(s) to the server room + all text channel rooms
  const textChannels = await prisma.channel.findMany({
    where: { serverId, type: 'text' },
    select: { id: true },
  });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.join(`server:${serverId}`);
    for (const ch of textChannels) {
      s.join(`channel:${ch.id}`);
    }
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
  const io = getIO();
  const textChannels = await prisma.channel.findMany({
    where: { serverId, type: 'text' },
    select: { id: true },
  });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.join(`server:${serverId}`);
    for (const ch of textChannels) {
      s.join(`channel:${ch.id}`);
    }
  }
}

/**
 * After a user leaves a server:
 * 1. Removes their socket(s) from the `server:<id>` room.
 * 2. Broadcasts `member:left` to remaining members.
 */
export async function broadcastMemberLeft(userId: string, serverId: string): Promise<void> {
  const io = getIO();

  const textChannels = await prisma.channel.findMany({
    where: { serverId, type: 'text' },
    select: { id: true },
  });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    s.leave(`server:${serverId}`);
    for (const ch of textChannels) {
      s.leave(`channel:${ch.id}`);
    }
  }

  io.to(`server:${serverId}`).emit('member:left', { serverId, userId });
}
