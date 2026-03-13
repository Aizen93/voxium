import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import type { AuthPayload } from '../middleware/auth';
import { setUserOnline, setUserOffline, getRedisPubSub } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { handleVoiceEvents, getVoiceStateForServer, getScreenShareState } from './voiceHandler';
import { handleDMVoiceEvents } from './dmVoiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

/** Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4) */
function normalizeIp(raw: string): string {
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Get the real client IP. Only reads X-Forwarded-For in production
 * (where a trusted reverse proxy is expected), matching Express's
 * `trust proxy` setting. In other environments, uses the direct
 * socket address to prevent header spoofing.
 */
function getSocketIp(socket: { handshake: { address: string; headers: Record<string, string | string[] | undefined> } }): string | undefined {
  if (process.env.NODE_ENV === 'production') {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const firstHop = forwarded.split(',')[0].trim();
      if (firstHop) return normalizeIp(firstHop);
    }
  }
  return socket.handshake.address ? normalizeIp(socket.handshake.address) : undefined;
}

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

  // Attach Redis adapter for multi-node broadcast support
  const { pub, sub } = getRedisPubSub();
  io.adapter(createAdapter(pub, sub));

  // ─── Authentication middleware ───────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as AuthPayload & { purpose?: string };

      // Reject non-access tokens (e.g. trusted-device, totp-verify)
      if (payload.purpose) return next(new Error('Invalid token type'));

      // Check account ban, token version, and current role
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { bannedAt: true, tokenVersion: true, role: true, emailVerified: true },
      });
      if (!user) return next(new Error('User not found'));
      if (user.bannedAt) return next(new Error('Account banned'));
      if (user.tokenVersion !== payload.tokenVersion) return next(new Error('Session invalidated'));
      if (!user.emailVerified) return next(new Error('Email not verified'));

      // Check IP ban
      const ip = getSocketIp(socket);
      if (ip) {
        const ipBan = await prisma.ipBan.findUnique({ where: { ip } });
        if (ipBan) return next(new Error('Account banned'));
      }

      socket.data.userId = payload.userId;
      socket.data.username = payload.username;
      socket.data.role = user.role;
      next();
    } catch (err) {
      if (err instanceof Error && err.message === 'Account banned') {
        return next(err);
      }
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection handler ─────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const userId = socket.data.userId as string;
    console.log(`[WS] User connected: ${userId} (${socket.id})`);

    // Join per-user room for targeted operations (e.g., support room joins)
    socket.join(`user:${userId}`);

    // ═══════════════════════════════════════════════════════════════════
    // CRITICAL: Register ALL event handlers SYNCHRONOUSLY before any
    // async work. The client may send events (channel:join, voice:join,
    // etc.) immediately after connecting. If handlers are registered
    // after awaits, those early events are silently lost — causing
    // broken real-time messaging after reconnects.
    // ═══════════════════════════════════════════════════════════════════

    // ─── Channel subscription ───────────────────────────────────────
    socket.on('channel:join', async (channelId: string) => {
      if (!socketRateLimit(socket, 'channel:join', 60)) return;
      if (typeof channelId !== 'string' || !channelId) return;
      try {
        // Single query: find channel + verify membership in one shot
        const channel = await prisma.channel.findUnique({
          where: { id: channelId },
          select: {
            serverId: true,
            server: {
              select: {
                members: {
                  where: { userId },
                  select: { userId: true },
                  take: 1,
                },
              },
            },
          },
        });
        if (!channel || channel.server.members.length === 0) return;
        socket.join(`channel:${channelId}`);
        console.log(`[WS] ${userId} (${socket.id}) joined room channel:${channelId}`);
      } catch (err) {
        console.error(`[WS] channel:join auth check failed for ${userId}:`, err);
      }
    });

    socket.on('channel:leave', (channelId: string) => {
      if (!socketRateLimit(socket, 'channel:leave', 60)) return;
      if (typeof channelId !== 'string' || !channelId) return;
      if (!socket.rooms.has(`channel:${channelId}`)) return;
      socket.leave(`channel:${channelId}`);
      console.log(`[WS] ${userId} (${socket.id}) left room channel:${channelId}`);
    });

    // ─── Typing indicators ──────────────────────────────────────────
    socket.on('typing:start', (channelId: string) => {
      if (!socketRateLimit(socket, 'typing', 30)) return;
      if (typeof channelId !== 'string' || !channelId) return;
      if (!socket.rooms.has(`channel:${channelId}`)) return;
      socket.to(`channel:${channelId}`).emit('typing:start', {
        channelId,
        userId,
        username: socket.data.username as string,
      });
    });

    socket.on('typing:stop', (channelId: string) => {
      if (!socketRateLimit(socket, 'typing', 30)) return;
      if (typeof channelId !== 'string' || !channelId) return;
      if (!socket.rooms.has(`channel:${channelId}`)) return;
      socket.to(`channel:${channelId}`).emit('typing:stop', { channelId, userId });
    });

    // ─── DM subscription ────────────────────────────────────────────
    socket.on('dm:join', async (conversationId: string) => {
      if (!socketRateLimit(socket, 'dm:join', 60)) return;
      if (typeof conversationId !== 'string' || !conversationId) return;
      try {
        const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { user1Id: true, user2Id: true } });
        if (!conv || (conv.user1Id !== userId && conv.user2Id !== userId)) return;
        socket.join(`dm:${conversationId}`);
      } catch (err) {
        console.error(`[WS] dm:join auth check failed for ${userId}:`, err);
      }
    });

    socket.on('dm:typing:start', (conversationId: string) => {
      if (!socketRateLimit(socket, 'dm:typing', 30)) return;
      if (typeof conversationId !== 'string' || !conversationId) return;
      if (!socket.rooms.has(`dm:${conversationId}`)) return;
      socket.to(`dm:${conversationId}`).emit('dm:typing:start', {
        conversationId,
        userId,
        username: socket.data.username as string,
      });
    });

    socket.on('dm:typing:stop', (conversationId: string) => {
      if (!socketRateLimit(socket, 'dm:typing', 30)) return;
      if (typeof conversationId !== 'string' || !conversationId) return;
      if (!socket.rooms.has(`dm:${conversationId}`)) return;
      socket.to(`dm:${conversationId}`).emit('dm:typing:stop', {
        conversationId,
        userId,
      });
    });

    // ─── Latency measurement ────────────────────────────────────────
    socket.on('ping:latency', (ts) => {
      if (!socketRateLimit(socket, 'ping:latency', 60)) return;
      socket.emit('pong:latency', ts);
    });

    // ─── Voice events ───────────────────────────────────────────────
    handleVoiceEvents(io, socket);

    // ─── DM Voice events ─────────────────────────────────────────────
    handleDMVoiceEvents(io, socket);

    // ─── Admin metrics subscription ──────────────────────────────────
    socket.on('admin:subscribe_metrics', () => {
      if (!socketRateLimit(socket, 'admin:subscribe_metrics', 10)) return;
      if (socket.data.role !== 'superadmin' && socket.data.role !== 'admin') return;
      socket.join('admin:metrics');
    });

    socket.on('admin:unsubscribe_metrics', () => {
      if (!socketRateLimit(socket, 'admin:unsubscribe', 30)) return;
      socket.leave('admin:metrics');
    });

    // ─── Admin reports subscription ──────────────────────────────────
    socket.on('admin:subscribe_reports', () => {
      if (!socketRateLimit(socket, 'admin:subscribe_reports', 10)) return;
      if (socket.data.role !== 'superadmin' && socket.data.role !== 'admin') return;
      socket.join('admin:reports');
    });

    socket.on('admin:unsubscribe_reports', () => {
      if (!socketRateLimit(socket, 'admin:unsubscribe', 30)) return;
      socket.leave('admin:reports');
    });

    // ─── Admin support subscription ──────────────────────────────────
    socket.on('admin:subscribe_support', () => {
      if (!socketRateLimit(socket, 'admin:subscribe_support', 10)) return;
      if (socket.data.role !== 'superadmin' && socket.data.role !== 'admin') return;
      socket.join('admin:support');
    });

    socket.on('admin:unsubscribe_support', () => {
      if (!socketRateLimit(socket, 'admin:unsubscribe', 30)) return;
      socket.leave('admin:support');
    });

    // ─── Disconnect ─────────────────────────────────────────────────
    socket.on('disconnecting', async () => {
      console.log(`[WS] User disconnecting: ${userId}`);

      // Fetch memberships needed for presence broadcast (can't rely on
      // the variable from the outer scope — it may not be set yet if
      // the connection handler's async work hasn't finished)
      try {
        const result = await setUserOffline(socket.id);

        // Only broadcast offline and update DB if the user has no remaining
        // sockets on any node (1:many presence model).
        if (result?.fullyOffline) {
          const membershipList = await prisma.serverMember.findMany({
            where: { userId },
            select: { serverId: true },
          });

          await prisma.user.update({ where: { id: userId }, data: { status: 'offline' } });

          for (const m of membershipList) {
            socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'offline' });
          }
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

      // Upsert IP record
      const connectIp = getSocketIp(socket);
      if (connectIp) {
        await prisma.ipRecord.upsert({
          where: { userId_ip: { userId, ip: connectIp } },
          update: { lastSeenAt: new Date() },
          create: { userId, ip: connectIp },
        }).catch(() => {}); // Non-critical
      }

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
        select: { id: true, serverId: true },
      });
      for (const ch of textChannels) {
        socket.join(`channel:${ch.id}`);
      }

      // Compute unread counts across all text channels in a single query
      if (textChannels.length > 0) {
        const textChannelIds = textChannels.map((ch) => ch.id);
        const unreads = await prisma.$queryRawUnsafe<
          Array<{ channel_id: string; server_id: string; cnt: bigint }>
        >(
          `SELECT c.id AS channel_id, c.server_id, COUNT(m.id) AS cnt
           FROM channels c
           LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = $1
           INNER JOIN messages m ON m.channel_id = c.id
             AND m.created_at > COALESCE(cr.last_read_at, '1970-01-01'::timestamp)
             AND m.author_id != $1
           WHERE c.id = ANY($2::text[])
           GROUP BY c.id, c.server_id
           HAVING COUNT(m.id) > 0`,
          userId,
          textChannelIds
        );

        if (unreads.length > 0) {
          socket.emit('unread:init', {
            unreads: unreads.map((r) => ({
              channelId: r.channel_id,
              serverId: r.server_id,
              count: Number(r.cnt),
            })),
          });
        }
      }

      // Auto-join all conversation rooms for DMs
      const conversations = await prisma.conversation.findMany({
        where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
        select: { id: true },
      });
      for (const conv of conversations) {
        socket.join(`dm:${conv.id}`);
      }

      // Compute DM unread counts
      if (conversations.length > 0) {
        const convIds = conversations.map((c) => c.id);
        const dmUnreads = await prisma.$queryRawUnsafe<
          Array<{ conversation_id: string; cnt: bigint }>
        >(
          `SELECT m.conversation_id, COUNT(m.id) AS cnt
           FROM messages m
           LEFT JOIN conversation_reads cr ON cr.conversation_id = m.conversation_id AND cr.user_id = $1
           WHERE m.conversation_id = ANY($2::text[])
             AND m.created_at > COALESCE(cr.last_read_at, '1970-01-01'::timestamp)
             AND m.author_id != $1
           GROUP BY m.conversation_id
           HAVING COUNT(m.id) > 0`,
          userId,
          convIds
        );

        if (dmUnreads.length > 0) {
          socket.emit('dm:unread:init', {
            unreads: dmUnreads.map((r) => ({
              conversationId: r.conversation_id,
              count: Number(r.cnt),
            })),
          });
        }
      }

      // Auto-join support ticket room if user has an open/claimed ticket
      try {
        const supportTicket = await prisma.supportTicket.findUnique({
          where: { userId },
          select: { id: true, status: true },
        });
        if (supportTicket && (supportTicket.status === 'open' || supportTicket.status === 'claimed')) {
          socket.join(`support:${supportTicket.id}`);
        }
      } catch (supportErr) {
        console.error(`[WS] Error joining support room for ${userId}:`, supportErr);
      }

      // Send active announcements
      try {
        const memberServerIds = memberships.map((m) => m.serverId);
        const now = new Date();
        const activeAnnouncements = await prisma.announcement.findMany({
          where: {
            publishedAt: { not: null },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            AND: [
              {
                OR: [
                  { scope: 'global' },
                  { scope: 'servers', serverIds: { hasSome: memberServerIds.length > 0 ? memberServerIds : ['__none__'] } },
                ],
              },
            ],
          },
          include: { createdBy: { select: { username: true } } },
          orderBy: { publishedAt: 'desc' },
          take: 10,
        });

        if (activeAnnouncements.length > 0) {
          socket.emit('announcement:init', {
            announcements: activeAnnouncements.map((a) => ({
              id: a.id,
              title: a.title,
              content: a.content,
              type: a.type as import('@voxium/shared').AnnouncementType,
              scope: a.scope as import('@voxium/shared').AnnouncementScope,
              serverIds: a.serverIds,
              createdById: a.createdById,
              createdByUsername: a.createdBy?.username ?? 'Deleted',
              publishedAt: a.publishedAt!.toISOString(),
              expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
              createdAt: a.createdAt.toISOString(),
            })),
          });
        }
      } catch (annErr) {
        console.error(`[WS] Error fetching announcements for ${userId}:`, annErr);
      }

      // Broadcast online status to all servers
      for (const m of memberships) {
        socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'online' });
      }

      // Send existing voice channel users for all servers (reads from Redis for cross-node visibility)
      for (const m of memberships) {
        const voiceState = await getVoiceStateForServer(m.serverId);
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

          // Send screen share state if someone is sharing in this channel
          const sharingUserId = await getScreenShareState(channelId);
          if (sharingUserId) {
            socket.emit('voice:screen_share:state', { channelId, sharingUserId });
          }
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
