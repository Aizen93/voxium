import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import type { AuthPayload } from '../middleware/auth';
import { setUserOnline, setUserOffline } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { handleVoiceEvents, getVoiceStateForServer } from './voiceHandler';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

export function getIO(): SocketServer<ClientToServerEvents, ServerToClientEvents> {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function initSocketServer(httpServer: HttpServer) {
  io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: (process.env.CORS_ORIGIN || 'http://localhost:8080')
        .split(',')
        .map((o) => o.trim()),
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ─── Authentication middleware ───────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
      socket.data.userId = payload.userId;
      socket.data.username = payload.username;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection handler ─────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const userId = socket.data.userId as string;
    console.log(`[WS] User connected: ${userId} (${socket.id})`);

    // ═══════════════════════════════════════════════════════════════════
    // CRITICAL: Register ALL event handlers SYNCHRONOUSLY before any
    // async work. The client may send events (channel:join, voice:join,
    // etc.) immediately after connecting. If handlers are registered
    // after awaits, those early events are silently lost — causing
    // broken real-time messaging after reconnects.
    // ═══════════════════════════════════════════════════════════════════

    // ─── Channel subscription ───────────────────────────────────────
    socket.on('channel:join', (channelId: string) => {
      socket.join(`channel:${channelId}`);
      console.log(`[WS] ${userId} (${socket.id}) joined room channel:${channelId}`);
    });

    socket.on('channel:leave', (channelId: string) => {
      socket.leave(`channel:${channelId}`);
      console.log(`[WS] ${userId} (${socket.id}) left room channel:${channelId}`);
    });

    // ─── Typing indicators ──────────────────────────────────────────
    socket.on('typing:start', (channelId: string) => {
      socket.to(`channel:${channelId}`).emit('typing:start', {
        channelId,
        userId,
        username: socket.data.username as string,
      });
    });

    socket.on('typing:stop', (channelId: string) => {
      socket.to(`channel:${channelId}`).emit('typing:stop', { channelId, userId });
    });

    // ─── Latency measurement ────────────────────────────────────────
    socket.on('ping:latency', (ts) => {
      socket.emit('pong:latency', ts);
    });

    // ─── Voice events ───────────────────────────────────────────────
    handleVoiceEvents(io, socket);

    // ─── Disconnect ─────────────────────────────────────────────────
    socket.on('disconnecting', async () => {
      console.log(`[WS] User disconnecting: ${userId}`);

      // Fetch memberships needed for presence broadcast (can't rely on
      // the variable from the outer scope — it may not be set yet if
      // the connection handler's async work hasn't finished)
      try {
        const membershipList = await prisma.serverMember.findMany({
          where: { userId },
          select: { serverId: true },
        });

        await setUserOffline(socket.id);
        await prisma.user.update({ where: { id: userId }, data: { status: 'offline' } });

        for (const m of membershipList) {
          socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'offline' });
        }
      } catch (err) {
        console.error(`[WS] Error during disconnect cleanup for ${userId}:`, err);
      }
    });

    // ═══════════════════════════════════════════════════════════════════
    // Now do async initialization (server room joins, presence, etc.)
    // Events arriving during this work will be handled by the
    // synchronously-registered handlers above.
    // ═══════════════════════════════════════════════════════════════════

    try {
      // Track online presence
      await setUserOnline(userId, socket.id);

      // Join rooms for all servers the user is a member of
      const memberships = await prisma.serverMember.findMany({
        where: { userId },
        select: { serverId: true },
      });
      for (const m of memberships) {
        socket.join(`server:${m.serverId}`);
      }

      // Auto-join all text channel rooms so message:new events reach all members
      const textChannels = await prisma.channel.findMany({
        where: { serverId: { in: memberships.map((m) => m.serverId) }, type: 'text' },
        select: { id: true },
      });
      for (const ch of textChannels) {
        socket.join(`channel:${ch.id}`);
      }

      // Broadcast online status to all servers
      for (const m of memberships) {
        socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'online' });
      }

      // Send existing voice channel users for all servers
      for (const m of memberships) {
        const voiceState = getVoiceStateForServer(m.serverId);
        for (const { channelId, userIds, userStates } of voiceState) {
          const userInfos = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, displayName: true, avatarUrl: true },
          });
          const voiceUsers = userInfos.map((u) => {
            const state = userStates.get(u.id);
            return {
              ...u,
              selfMute: state?.selfMute ?? false,
              selfDeaf: state?.selfDeaf ?? false,
              speaking: false,
            };
          });
          socket.emit('voice:channel_users', { channelId, users: voiceUsers });
        }
      }

      // Update DB status
      await prisma.user.update({ where: { id: userId }, data: { status: 'online' } });
    } catch (err) {
      console.error(`[WS] Error during connection setup for ${userId}:`, err);
    }
  });

  return io;
}
