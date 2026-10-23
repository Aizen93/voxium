import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { consentIsRequired, type AuthPayload } from '../middleware/auth';
import { setUserOnline, setUserOffline, isUserOnline, getRedisPubSub } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { handleVoiceEvents, replayVoiceState } from './voiceHandler';
import { handleDMVoiceEvents } from './dmVoiceHandler';
import { handleAnnotationEvents } from './annotationHandler';
import { socketRateLimit, normalizeIp } from '../middleware/rateLimiter';
import { trustsProxy, forwardedClientAddress } from '../utils/trustProxy';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { Permissions } from '@voxium/shared';
import { hasChannelPermission } from '../utils/permissionCalculator';

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Get the real client IP. Reads X-Forwarded-For only when a trusted reverse
 * proxy is expected — the SAME condition app.ts uses for Express's
 * `trust proxy` (utils/trustProxy.ts), so the socket handshake and every REST
 * control agree about who is calling. Otherwise uses the direct socket
 * address to prevent header spoofing.
 */
export function getSocketIp(socket: { handshake: { address: string; headers: Record<string, string | string[] | undefined> } }): string | undefined {
  if (trustsProxy()) {
    const raw = socket.handshake.headers['x-forwarded-for'];
    // The LAST hop, matching Express's `trust proxy: 1`, because that is the
    // only entry a trusted proxy wrote (for the default hop count). nginx sets
    // `X-Forwarded-For $proxy_add_x_forwarded_for`, which is
    // "$http_x_forwarded_for, $remote_addr" — so the FIRST entry is whatever
    // the client put in the header themselves. Reading it let a banned client
    // pick the address the IpBan lookup queries, and made the socket surface
    // disagree with every REST control about who is calling; the socket is the
    // one surface that can evict an already-authenticated session.
    //
    // "Last" is really "TRUST_PROXY_HOPS-th from the right" — one nginx is
    // the default; a load balancer in front of it makes it two. Both surfaces
    // read the count from trustProxy.ts so they cannot disagree.
    const forwarded = Array.isArray(raw) ? raw.join(',') : raw;
    if (typeof forwarded === 'string') {
      const client = forwardedClientAddress(forwarded);
      if (client) return normalizeIp(client);
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
    pingTimeout: 10000,
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
        select: { bannedAt: true, tokenVersion: true, role: true, emailVerified: true, termsAcceptedAt: true, privacyAcceptedAt: true },
      });
      if (!user) return next(new Error('User not found'));
      if (user.bannedAt) return next(new Error('Account banned'));
      if (user.tokenVersion !== payload.tokenVersion) return next(new Error('Session invalidated'));
      if (!user.emailVerified) return next(new Error('Email not verified'));
      // Same gate as requireConsent on REST: an account that has not accepted
      // the legal documents gets no live session either.
      if (consentIsRequired(user)) return next(new Error('Consent required'));

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

    // Settled once this socket is registered as online (Redis + the DB
    // column), or once that attempt failed. The disconnect handler WAITS for
    // it: a socket that drops during the setup below used to run its
    // unregistration before the registration had landed, find nothing to
    // remove, and leave the user online with a dead socket behind them until
    // the next boot sweep — the "still shows online" ghost.
    let presenceRegistered!: () => void;
    const presenceReady = new Promise<void>((resolve) => { presenceRegistered = resolve; });

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
        // Check VIEW_CHANNEL permission
        const canView = await hasChannelPermission(userId, channelId, channel.serverId, Permissions.VIEW_CHANNEL);
        if (!canView) return;
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
    socket.on('typing:start', async (channelId: string) => {
      if (!socketRateLimit(socket, 'typing', 30)) return;
      if (typeof channelId !== 'string' || !channelId) return;
      if (!socket.rooms.has(`channel:${channelId}`)) return;
      // Check SEND_MESSAGES — user shouldn't appear to type in channels they can't send to
      try {
        const ch = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
        if (!ch) return;
        const canSend = await hasChannelPermission(userId, channelId, ch.serverId, Permissions.SEND_MESSAGES);
        if (!canSend) return;
      } catch (err) {
        console.warn('[Socket] typing:start permission check failed:', err instanceof Error ? err.message : err);
        return;
      }
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

    // ─── Screen-share annotation events ──────────────────────────────
    // Deliberately OUTSIDE the voice relay table: annotations touch no
    // mediasoup state, so they run on the sharer's own node and authorize
    // against the Redis screen-share mirror (see annotationHandler.ts).
    handleAnnotationEvents(io, socket);

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
        // Never unregister before the registration landed (see presenceReady)
        await presenceReady;
        const result = await setUserOffline(socket.id);

        // Only broadcast offline and update DB if the user has no remaining
        // sockets on any node (1:many presence model).
        if (result?.fullyOffline) {
          const [membershipList, dmConversations] = await Promise.all([
            prisma.serverMember.findMany({
              where: { userId },
              select: { serverId: true },
            }),
            prisma.conversation.findMany({
              where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
              select: { id: true },
            }),
          ]);

          // Reconnected while the queries above ran (a page reload, a network
          // blip — the new socket registers in parallel with this teardown):
          // the new connection's online write and broadcast are the truth, and
          // an offline write landing AFTER them would show a connected user as
          // offline to everyone until their next presence event.
          if (await isUserOnline(userId)) return;

          // updateMany with a status filter: no-op write skipped when already offline
          await prisma.user.updateMany({ where: { id: userId, NOT: { status: 'offline' } }, data: { status: 'offline' } });

          for (const m of membershipList) {
            socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'offline' });
          }
          for (const c of dmConversations) {
            socket.to(`dm:${c.id}`).emit('presence:update', { userId, status: 'offline' });
          }

          // The re-check and the write are two steps: a registration landing
          // between them leaves the user online in Redis and offline in the
          // column (the new socket's own write was a no-op while the row still
          // read online) and announced offline. Look once more and put it
          // right: the column back online, and every room told so.
          if (await isUserOnline(userId)) {
            await prisma.user.updateMany({ where: { id: userId, NOT: { status: 'online' } }, data: { status: 'online' } });
            for (const m of membershipList) {
              socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'online' });
            }
            for (const c of dmConversations) {
              socket.to(`dm:${c.id}`).emit('presence:update', { userId, status: 'online' });
            }
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

    // Presence FIRST, Redis and the DB column together, before anything that
    // can take long: the disconnect handler unwinds exactly this pair once
    // presenceReady settles. The column used to be written at the very end of
    // the setup, after a dozen queries — a socket that dropped meanwhile had
    // already been marked offline when the belated write flipped it back to
    // online, with no socket behind it.
    try {
      await setUserOnline(userId, socket.id);
      // updateMany with a status filter: reconnect churn / multi-device connects
      // otherwise rewrite the same 'online' row on every socket (write amplification)
      await prisma.user.updateMany({ where: { id: userId, NOT: { status: 'online' } }, data: { status: 'online' } });
    } catch (err) {
      console.error(`[WS] Presence registration failed for ${userId}:`, err);
    } finally {
      presenceRegistered();
    }

    // A socket that dropped during the registration has already been unwound
    // by its disconnect handler: there is nothing left to set up for it, and a
    // room joined now would hold its dead id (socket.io's join() does not
    // check, and the adapter's cleanup for this socket already ran). Checked
    // again before every later step, the same way.
    if (socket.disconnected) return;

    // Upsert IP record
    const connectIp = getSocketIp(socket);
    if (connectIp) {
      await prisma.ipRecord.upsert({
        where: { userId_ip: { userId, ip: connectIp } },
        update: { lastSeenAt: new Date() },
        create: { userId, ip: connectIp },
      }).catch((err) => console.warn('[WS] IP record upsert failed:', err));
    }

    // The rooms, then the replays and broadcasts that depend on them. Each
    // step below guards itself: one failing query must not abandon the rest
    // of the setup (a thrown unread count used to leave the socket without
    // its DM rooms, its voice replay and its presence broadcast).
    let memberships: Array<{ serverId: string }> = [];
    let visibleChannels: Array<{ id: string; serverId: string; type: string; secure: boolean }> = [];
    try {
      // Join rooms for all servers the user is a member of
      memberships = await prisma.serverMember.findMany({
        where: { userId },
        select: { serverId: true },
      });
      if (socket.disconnected) return;
      for (const m of memberships) {
        socket.join(`server:${m.serverId}`);
      }

      // Auto-join channel rooms the user can view. Includes VOICE channels:
      // `channel:{id}` is the visibility boundary for real-time events, and voice
      // presence (voice:user_joined/state/speaking/screen share) broadcasts there
      // instead of server-wide so private voice channels don't leak occupancy.
      // Visibility for ALL servers is computed in 4 batched queries (the old
      // per-server loop made a deploy that reconnects thousands of clients a
      // self-inflicted DB stampede).
      const allChannels = await prisma.channel.findMany({
        where: { serverId: { in: memberships.map((m) => m.serverId) } },
        // `secure` is load-bearing: without it filterVisibleChannelsMulti
        // treats secure channels as plaintext and joins every member's socket
        select: { id: true, serverId: true, type: true, secure: true },
      });
      const { filterVisibleChannelsMulti } = await import('../utils/permissionCalculator');
      visibleChannels = await filterVisibleChannelsMulti(userId, allChannels);
      if (socket.disconnected) return;
      for (const ch of visibleChannels) {
        socket.join(`channel:${ch.id}`);
      }
    } catch (err) {
      console.error(`[WS] Error joining server/channel rooms for ${userId}:`, err);
    }
    if (socket.disconnected) return;

    // Send existing voice channel users for all servers (reads from Redis for
    // cross-node visibility), right after the channel rooms are joined: every
    // event from here on reaches the socket live, so the replay is the only
    // thing that can be stale, and the later it is sent the larger the window
    // for a leave to land before it. One batched Redis read for ALL
    // memberships; the VIEW_CHANNEL decision reuses the bulk visibility result
    // computed above (the old loop did a per-membership Redis scan over every
    // globally-active channel plus a multi-query permission check per voice
    // channel). The client clears every voice list on (re)connect, so a channel
    // that emptied while it was away is absent here and stays empty there.
    try {
      const visibleChannelIds = new Set(visibleChannels.map((ch) => ch.id));
      await replayVoiceState(socket, memberships.map((m) => m.serverId), visibleChannelIds);
    } catch (err) {
      console.error(`[WS] Error replaying voice state for ${userId}:`, err);
    }
    if (socket.disconnected) return;

    // Auto-join all conversation rooms for DMs
    let conversations: Array<{ id: string }> = [];
    try {
      conversations = await prisma.conversation.findMany({
        where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
        select: { id: true },
      });
      if (socket.disconnected) return;
      for (const conv of conversations) {
        socket.join(`dm:${conv.id}`);
      }
    } catch (err) {
      console.error(`[WS] Error joining DM rooms for ${userId}:`, err);
    }

    // Broadcast online status to all servers and DM conversation rooms (the
    // conversation list fetched above — this was a duplicate query). Guarded:
    // a socket that disconnected during the setup has already been unwound by
    // its disconnect handler, and announcing it online now would leave every
    // contact showing a user who is gone.
    if (socket.disconnected) return;
    for (const m of memberships) {
      socket.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'online' });
    }
    for (const c of conversations) {
      socket.to(`dm:${c.id}`).emit('presence:update', { userId, status: 'online' });
    }

    // Compute unread counts across all text channels in a single query.
    // Uses LATERAL JOIN with LIMIT 100 to cap per-channel scanning — the frontend
    // shows "99+" anyway, so exact counts beyond 100 are unnecessary. This prevents
    // full table scans on channels with thousands of unread messages.
    // `IS DISTINCT FROM`, never `!=`: a webhook-posted row has author_id
    // NULL, `NULL != $1` is NULL (row dropped), and the live message:new
    // handler on the client DOES count it, so a reconnect would lose it.
    try {
      const textChannels = visibleChannels.filter((ch) => ch.type === 'text');
      if (textChannels.length > 0) {
        const textChannelIds = textChannels.map((ch) => ch.id);
        const unreads = await prisma.$queryRawUnsafe<
          Array<{ channel_id: string; server_id: string; cnt: number }>
        >(
          `SELECT c.id AS channel_id, c.server_id, cnt.val AS cnt
           FROM channels c
           LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = $1
           CROSS JOIN LATERAL (
             SELECT COUNT(*)::int AS val FROM (
               SELECT 1 FROM messages m
               WHERE m.channel_id = c.id
                 AND m.created_at > COALESCE(cr.last_read_at, '1970-01-01'::timestamp)
                 AND m.author_id IS DISTINCT FROM $1
               LIMIT 100
             ) sub
           ) cnt
           WHERE c.id = ANY($2::text[])
             AND cnt.val > 0`,
          userId,
          textChannelIds
        );

        if (unreads.length > 0) {
          socket.emit('unread:init', {
            unreads: unreads.map((r) => ({
              channelId: r.channel_id,
              serverId: r.server_id,
              count: r.cnt,
            })),
          });
        }
      }
    } catch (err) {
      console.error(`[WS] Error computing channel unread counts for ${userId}:`, err);
    }

    // Compute DM unread counts — same LATERAL + LIMIT 100 optimization as channels
    try {
      if (conversations.length > 0) {
        const convIds = conversations.map((c) => c.id);
        const dmUnreads = await prisma.$queryRawUnsafe<
          Array<{ conversation_id: string; cnt: number }>
        >(
          `SELECT conv.id AS conversation_id, cnt.val AS cnt
           FROM unnest($2::text[]) AS conv(id)
           LEFT JOIN conversation_reads cr ON cr.conversation_id = conv.id AND cr.user_id = $1
           CROSS JOIN LATERAL (
             SELECT COUNT(*)::int AS val FROM (
               SELECT 1 FROM messages m
               WHERE m.conversation_id = conv.id
                 AND m.created_at > COALESCE(cr.last_read_at, '1970-01-01'::timestamp)
                 AND m.author_id IS DISTINCT FROM $1
               LIMIT 100
             ) sub
           ) cnt
           WHERE cnt.val > 0`,
          userId,
          convIds
        );

        if (dmUnreads.length > 0) {
          socket.emit('dm:unread:init', {
            unreads: dmUnreads.map((r) => ({
              conversationId: r.conversation_id,
              count: r.cnt,
            })),
          });
        }
      }
    } catch (err) {
      console.error(`[WS] Error computing DM unread counts for ${userId}:`, err);
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
  });

  return io;
}
