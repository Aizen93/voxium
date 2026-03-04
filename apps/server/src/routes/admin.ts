import { Router, type Request, type Response, type NextFunction } from 'express';
import net from 'net';
import { authenticate } from '../middleware/auth';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin';
import { rateLimitAdmin } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { getOnlineUsers, getUserSocket } from '../utils/redis';
import { getIO } from '../websocket/socketServer';
import { cleanupServerVoice } from '../websocket/voiceHandler';
import { sanitizeText } from '../utils/sanitize';
import { broadcastMemberLeft } from '../utils/memberBroadcast';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export const adminRouter = Router();

adminRouter.use(authenticate, requireSuperAdmin, rateLimitAdmin);

// ─── Dashboard Stats ────────────────────────────────────────────────────────

adminRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [totalUsers, totalServers, totalMessages, bannedUsers, onlineUserIds] = await Promise.all([
      prisma.user.count(),
      prisma.server.count(),
      prisma.message.count(),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      getOnlineUsers(),
    ]);

    res.json({
      success: true,
      data: { totalUsers, totalServers, totalMessages, onlineUsers: onlineUserIds.length, bannedUsers },
    });
  } catch (err) {
    next(err);
  }
});

// ─── User Management ────────────────────────────────────────────────────────

adminRouter.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = (req.query.search as string)?.trim() || '';
    const filter = (req.query.filter as string) || 'all';
    const sort = (req.query.sort as string) || 'newest';

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (filter === 'banned') where.bannedAt = { not: null };
    else if (filter === 'admin') where.role = { in: ['admin', 'superadmin'] };

    let onlineIds: string[] | null = null;
    if (filter === 'online') {
      onlineIds = await getOnlineUsers();
      where.id = { in: onlineIds };
    }

    const orderBy: Record<string, string> =
      sort === 'oldest' ? { createdAt: 'asc' } :
      sort === 'username' ? { username: 'asc' } :
      { createdAt: 'desc' };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, username: true, displayName: true, email: true, avatarUrl: true,
          role: true, status: true, bannedAt: true, banReason: true, createdAt: true,
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: users,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users/:userId', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: {
        id: true, username: true, displayName: true, email: true, avatarUrl: true,
        bio: true, role: true, status: true, bannedAt: true, banReason: true, createdAt: true,
        ipRecords: { select: { ip: true, lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } },
        _count: { select: { messages: true, memberships: true, ownedServers: true } },
      },
    });

    if (!user) throw new NotFoundError('User');

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users/:userId/ban', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { userId: targetId } = req.params;
    const { reason, banIps } = req.body;

    // Self-protection
    if (targetId === req.user!.userId) throw new ForbiddenError('Cannot ban yourself');

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundError('User');
    if (target.role === 'superadmin') throw new ForbiddenError('Cannot ban a super admin');

    const sanitizedReason = reason ? sanitizeText(reason) : null;

    // Ban the account
    await prisma.user.update({
      where: { id: targetId },
      data: {
        bannedAt: new Date(),
        banReason: sanitizedReason,
        tokenVersion: { increment: 1 }, // Invalidate all tokens
      },
    });

    // Optionally ban all known IPs
    let ipsBanned = 0;
    if (banIps) {
      const ipRecords = await prisma.ipRecord.findMany({
        where: { userId: targetId },
        select: { ip: true },
      });
      for (const record of ipRecords) {
        try {
          await prisma.ipBan.upsert({
            where: { ip: record.ip },
            update: {},
            create: { ip: record.ip, reason: sanitizedReason, bannedBy: req.user!.userId },
          });
          ipsBanned++;
        } catch { /* Ignore if already exists */ }
      }
    }

    // Notify servers that user left
    const memberships = await prisma.serverMember.findMany({
      where: { userId: targetId },
      select: { serverId: true },
    });
    for (const { serverId } of memberships) {
      await broadcastMemberLeft(targetId, serverId);
    }

    // Force logout then disconnect active socket
    const socketId = await getUserSocket(targetId);
    if (socketId) {
      const io = getIO();
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('force:logout', { reason: 'Your account has been banned' });
        socket.disconnect(true);
      }
    }

    res.json({ success: true, message: ipsBanned > 0 ? `User banned (${ipsBanned} IP(s) also banned)` : banIps ? 'User banned (no known IPs to ban)' : 'User banned' });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users/:userId/unban', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, bannedAt: true } });
    if (!user) throw new NotFoundError('User');
    if (!user.bannedAt) throw new BadRequestError('User is not banned');

    // Remove IP bans for this user's IPs — but only if no other banned user shares that IP
    const ipRecords = await prisma.ipRecord.findMany({
      where: { userId: req.params.userId },
      select: { ip: true },
    });
    const ipsToRelease: string[] = [];
    for (const { ip } of ipRecords) {
      const otherBannedOnSameIp = await prisma.ipRecord.findFirst({
        where: {
          ip,
          userId: { not: req.params.userId },
          user: { bannedAt: { not: null } },
        },
      });
      if (!otherBannedOnSameIp) ipsToRelease.push(ip);
    }
    if (ipsToRelease.length > 0) {
      await prisma.ipBan.deleteMany({
        where: { ip: { in: ipsToRelease } },
      });
    }

    await prisma.user.update({
      where: { id: req.params.userId },
      data: { bannedAt: null, banReason: null },
    });

    res.json({ success: true, message: 'User unbanned' });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/users/:userId', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { userId: targetId } = req.params;

    if (targetId === req.user!.userId) throw new ForbiddenError('Cannot delete yourself');

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundError('User');
    if (target.role === 'superadmin') throw new ForbiddenError('Cannot delete a super admin');

    // Fetch memberships and owned servers in parallel
    const [memberships, ownedServers] = await Promise.all([
      prisma.serverMember.findMany({ where: { userId: targetId }, select: { serverId: true } }),
      prisma.server.findMany({ where: { ownerId: targetId }, select: { id: true } }),
    ]);
    const ownedServerIds = new Set(ownedServers.map((s) => s.id));

    // Notify non-owned servers that user left (owned ones get deleted below)
    for (const { serverId } of memberships) {
      if (!ownedServerIds.has(serverId)) {
        await broadcastMemberLeft(targetId, serverId);
      }
    }

    const io = getIO();

    // Force logout then disconnect active socket
    const socketId = await getUserSocket(targetId);
    if (socketId) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) {
        targetSocket.emit('force:logout', { reason: 'Your account has been deleted' });
        targetSocket.disconnect(true);
      }
    }

    // Clean up servers owned by this user before cascade delete
    for (const server of ownedServers) {
      cleanupServerVoice(io, server.id);
      io.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });

      const room = io.sockets.adapter.rooms.get(`server:${server.id}`);
      if (room) {
        for (const sid of room) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.leave(`server:${server.id}`);
        }
      }
    }

    // Cascade delete handles messages, memberships, etc.
    await prisma.user.delete({ where: { id: targetId } });

    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Server Management ──────────────────────────────────────────────────────

adminRouter.get('/servers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = (req.query.search as string)?.trim() || '';

    const where: Record<string, unknown> = {};
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const [servers, total] = await Promise.all([
      prisma.server.findMany({
        where,
        select: {
          id: true, name: true, iconUrl: true, ownerId: true, createdAt: true,
          owner: { select: { username: true } },
          _count: { select: { members: true, channels: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.server.count({ where }),
    ]);

    // Get message counts per server
    const serverIds = servers.map((s) => s.id);
    const messageCounts = serverIds.length > 0
      ? await prisma.message.groupBy({
          by: ['channelId'],
          where: { channel: { serverId: { in: serverIds } } },
          _count: true,
        })
      : [];

    // Map channelId -> serverId for aggregation
    const channelToServer = new Map<string, string>();
    if (serverIds.length > 0) {
      const channels = await prisma.channel.findMany({
        where: { serverId: { in: serverIds } },
        select: { id: true, serverId: true },
      });
      for (const ch of channels) channelToServer.set(ch.id, ch.serverId);
    }

    const serverMessageCounts = new Map<string, number>();
    for (const mc of messageCounts) {
      if (mc.channelId) {
        const sid = channelToServer.get(mc.channelId);
        if (sid) serverMessageCounts.set(sid, (serverMessageCounts.get(sid) || 0) + mc._count);
      }
    }

    const data = servers.map((s) => ({
      id: s.id,
      name: s.name,
      iconUrl: s.iconUrl,
      ownerId: s.ownerId,
      ownerUsername: s.owner.username,
      memberCount: s._count.members,
      channelCount: s._count.channels,
      messageCount: serverMessageCounts.get(s.id) || 0,
      createdAt: s.createdAt,
    }));

    res.json({ success: true, data, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/servers/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const server = await prisma.server.findUnique({
      where: { id: req.params.serverId },
      select: { id: true },
    });
    if (!server) throw new NotFoundError('Server');

    const io = getIO();

    // Clean up voice state
    cleanupServerVoice(io, server.id);

    // Notify members
    io.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });

    // Remove all sockets from the server room
    const room = io.sockets.adapter.rooms.get(`server:${server.id}`);
    if (room) {
      for (const socketId of room) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) socket.leave(`server:${server.id}`);
      }
    }

    // Cascade delete
    await prisma.server.delete({ where: { id: server.id } });

    res.json({ success: true, message: 'Server deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Ban Management ─────────────────────────────────────────────────────────

adminRouter.get('/bans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const [bans, total] = await Promise.all([
      prisma.user.findMany({
        where: { bannedAt: { not: null } },
        select: { id: true, username: true, displayName: true, email: true, bannedAt: true, banReason: true },
        orderBy: { bannedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
    ]);

    res.json({ success: true, data: bans, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/ip-bans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const [ipBans, total] = await Promise.all([
      prisma.ipBan.findMany({
        select: { id: true, ip: true, reason: true, bannedBy: true, createdAt: true, creator: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ipBan.count(),
    ]);

    const data = ipBans.map((b) => ({
      id: b.id,
      ip: b.ip,
      reason: b.reason,
      bannedBy: b.bannedBy,
      bannedByUsername: b.creator?.username ?? 'Deleted admin',
      createdAt: b.createdAt,
    }));

    res.json({ success: true, data, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/ip-bans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ip, reason } = req.body;
    if (!ip || typeof ip !== 'string') throw new BadRequestError('IP address is required');

    const trimmedIp = ip.trim();
    if (net.isIP(trimmedIp) === 0) {
      throw new BadRequestError('Invalid IP address format');
    }

    const sanitizedReason = reason ? sanitizeText(reason) : null;

    const ipBan = await prisma.ipBan.create({
      data: { ip: trimmedIp, reason: sanitizedReason, bannedBy: req.user!.userId },
    });

    res.status(201).json({ success: true, data: ipBan });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/ip-bans/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const ipBan = await prisma.ipBan.findUnique({ where: { id: req.params.id } });
    if (!ipBan) throw new NotFoundError('IP ban');

    await prisma.ipBan.delete({ where: { id: req.params.id } });

    res.json({ success: true, message: 'IP ban removed' });
  } catch (err) {
    next(err);
  }
});

// ─── Chart Data ─────────────────────────────────────────────────────────────

adminRouter.get('/signups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const signups = await prisma.$queryRawUnsafe<Array<{ day: string; count: bigint }>>(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM users
       WHERE created_at >= $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      since
    );

    res.json({
      success: true,
      data: signups.map((r) => ({ day: r.day, count: Number(r.count) })),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/messages-per-hour', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours as string) || 24));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const messages = await prisma.$queryRawUnsafe<Array<{ hour: string; count: bigint }>>(
      `SELECT DATE_TRUNC('hour', created_at) AS hour, COUNT(*) AS count
       FROM messages
       WHERE created_at >= $1
       GROUP BY DATE_TRUNC('hour', created_at)
       ORDER BY hour ASC`,
      since
    );

    res.json({
      success: true,
      data: messages.map((r) => ({ hour: r.hour, count: Number(r.count) })),
    });
  } catch (err) {
    next(err);
  }
});
