import { Router, type Request, type Response, type NextFunction } from 'express';
import net from 'net';
import { authenticate } from '../middleware/auth';
import { requireAdmin, requireSuperAdmin } from '../middleware/requireSuperAdmin';
import { rateLimitAdmin } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { getOnlineUsers, getUserSocket } from '../utils/redis';
import { getIO } from '../websocket/socketServer';
import { cleanupServerVoice } from '../websocket/voiceHandler';
import { sanitizeText } from '../utils/sanitize';
import { broadcastMemberJoined, broadcastMemberLeft } from '../utils/memberBroadcast';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { listAllS3Objects, deleteFromS3, VALID_S3_KEY_RE } from '../utils/s3';
import type { StorageStats, StorageFile, StorageTopUploader, MemberRole, AuditLogEntry } from '@voxium/shared';
import { WS_EVENTS } from '@voxium/shared';
import { logAuditEvent } from '../utils/auditLog';

export const adminRouter = Router();

adminRouter.use(authenticate, requireAdmin, rateLimitAdmin);

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

adminRouter.get('/users/:userId/owned-servers', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundError('User');

    const servers = await prisma.server.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        name: true,
        iconUrl: true,
        _count: { select: { members: true } },
        members: {
          where: { userId: { not: user.id } },
          select: {
            userId: true,
            role: true,
            user: { select: { username: true, displayName: true } },
          },
          orderBy: [{ role: 'asc' }, { user: { username: 'asc' } }],
          take: 50,
        },
      },
    });

    const data = servers.map((s) => ({
      id: s.id,
      name: s.name,
      iconUrl: s.iconUrl,
      memberCount: s._count.members,
      members: s.members.map((m) => ({
        userId: m.userId,
        username: m.user.username,
        displayName: m.user.displayName,
        role: m.role,
      })),
    }));

    res.json({ success: true, data });
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

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'user.ban',
      targetType: 'user',
      targetId: targetId,
      metadata: { reason: sanitizedReason, banIps: !!banIps, ipsBanned },
    });

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

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'user.unban',
      targetType: 'user',
      targetId: req.params.userId,
      metadata: { ipsReleased: ipsToRelease.length },
    });

    res.json({ success: true, message: 'User unbanned' });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/users/:userId', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { userId: targetId } = req.params;
    const { serverActions } = req.body as {
      serverActions?: Array<{ serverId: string; action: 'transfer' | 'delete'; newOwnerId?: string }>;
    };

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
      prisma.server.findMany({ where: { ownerId: targetId }, select: { id: true, name: true } }),
    ]);

    // If user owns servers, require serverActions
    if (ownedServers.length > 0) {
      if (!serverActions || serverActions.length === 0) {
        throw new BadRequestError(
          `User owns ${ownedServers.length} server(s). Provide serverActions for each owned server.`
        );
      }

      const ownedServerIds = new Set(ownedServers.map((s) => s.id));
      const actionMap = new Map(serverActions.map((a) => [a.serverId, a]));

      // Validate every owned server is accounted for
      for (const serverId of ownedServerIds) {
        if (!actionMap.has(serverId)) {
          throw new BadRequestError(`Missing serverAction for server "${serverId}"`);
        }
      }

      // Validate no actions for non-owned servers
      for (const action of serverActions) {
        if (!ownedServerIds.has(action.serverId)) {
          throw new BadRequestError(`Server "${action.serverId}" is not owned by this user`);
        }
      }

      const io = getIO();

      // Process each server action
      for (const action of serverActions) {
        if (action.action === 'transfer') {
          if (!action.newOwnerId) throw new BadRequestError(`newOwnerId required for transfer of server "${action.serverId}"`);
          if (action.newOwnerId === targetId) throw new BadRequestError('Cannot transfer to the user being deleted');

          // Validate new owner exists and is not banned
          const newOwner = await prisma.user.findUnique({
            where: { id: action.newOwnerId },
            select: { id: true, bannedAt: true },
          });
          if (!newOwner) throw new NotFoundError('Transfer target user');
          if (newOwner.bannedAt) throw new BadRequestError('Cannot transfer ownership to a banned user');

          // Check if new owner is already a member
          const existingMembership = await prisma.serverMember.findUnique({
            where: { userId_serverId: { userId: action.newOwnerId, serverId: action.serverId } },
          });

          if (!existingMembership) {
            // Add them as a member first, seed ChannelRead records
            const textChannels = await prisma.channel.findMany({
              where: { serverId: action.serverId, type: 'text' },
              select: { id: true },
            });

            await prisma.$transaction([
              prisma.serverMember.create({
                data: { userId: action.newOwnerId, serverId: action.serverId, role: 'owner' },
              }),
              ...textChannels.map((ch) =>
                prisma.channelRead.upsert({
                  where: { userId_channelId: { userId: action.newOwnerId!, channelId: ch.id } },
                  update: {},
                  create: { userId: action.newOwnerId!, channelId: ch.id, lastReadAt: new Date() },
                })
              ),
              prisma.server.update({
                where: { id: action.serverId },
                data: { ownerId: action.newOwnerId },
              }),
            ]);

            await broadcastMemberJoined(action.newOwnerId, action.serverId);
          } else {
            // Already a member — transfer ownership in transaction
            await prisma.$transaction([
              prisma.server.update({
                where: { id: action.serverId },
                data: { ownerId: action.newOwnerId },
              }),
              prisma.serverMember.update({
                where: { userId_serverId: { userId: action.newOwnerId, serverId: action.serverId } },
                data: { role: 'owner' },
              }),
            ]);
          }

          // Emit role + server update events
          io.to(`server:${action.serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED as any, {
            serverId: action.serverId,
            userId: action.newOwnerId,
            role: 'owner' as MemberRole,
          });

          const updatedServer = await prisma.server.findUnique({
            where: { id: action.serverId },
            select: { id: true, name: true, iconUrl: true, ownerId: true, createdAt: true },
          });
          if (updatedServer) {
            io.to(`server:${action.serverId}`).emit(WS_EVENTS.SERVER_UPDATED as any, updatedServer);
          }

          // Broadcast that the deleted user left this server
          await broadcastMemberLeft(targetId, action.serverId);

        } else {
          // action === 'delete' — clean up and delete the server
          cleanupServerVoice(io, action.serverId);
          io.to(`server:${action.serverId}`).emit('server:deleted', { serverId: action.serverId });

          const room = io.sockets.adapter.rooms.get(`server:${action.serverId}`);
          if (room) {
            for (const sid of room) {
              const s = io.sockets.sockets.get(sid);
              if (s) s.leave(`server:${action.serverId}`);
            }
          }

          await prisma.server.delete({ where: { id: action.serverId } });
        }
      }

      // Notify non-owned servers that user left
      for (const { serverId } of memberships) {
        if (!ownedServerIds.has(serverId)) {
          await broadcastMemberLeft(targetId, serverId);
        }
      }

      // Force logout then disconnect active socket
      const socketId = await getUserSocket(targetId);
      if (socketId) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          targetSocket.emit('force:logout', { reason: 'Your account has been deleted' });
          targetSocket.disconnect(true);
        }
      }

      // Delete user — cascade only removes ServerMember records for transferred servers
      await prisma.user.delete({ where: { id: targetId } });

      logAuditEvent({
        actorId: req.user!.userId,
        action: 'user.delete',
        targetType: 'user',
        targetId,
        metadata: { serverActions: serverActions.map((a) => ({ serverId: a.serverId, action: a.action })) },
      });

      res.json({ success: true, message: 'User deleted' });
    } else {
      // User owns no servers — proceed with original simple delete
      const ownedServerIds = new Set<string>();

      for (const { serverId } of memberships) {
        if (!ownedServerIds.has(serverId)) {
          await broadcastMemberLeft(targetId, serverId);
        }
      }

      const io = getIO();

      const socketId = await getUserSocket(targetId);
      if (socketId) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          targetSocket.emit('force:logout', { reason: 'Your account has been deleted' });
          targetSocket.disconnect(true);
        }
      }

      await prisma.user.delete({ where: { id: targetId } });

      logAuditEvent({
        actorId: req.user!.userId,
        action: 'user.delete',
        targetType: 'user',
        targetId,
      });

      res.json({ success: true, message: 'User deleted' });
    }
  } catch (err) {
    next(err);
  }
});

// ─── Role Management (superadmin only) ───────────────────────────────────────

adminRouter.patch('/users/:userId/role', requireSuperAdmin, async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { userId: targetId } = req.params;
    const { role } = req.body as { role?: string };

    if (!role || !['user', 'admin'].includes(role)) {
      throw new BadRequestError('Role must be "user" or "admin"');
    }

    if (targetId === req.user!.userId) throw new ForbiddenError('Cannot change your own role');

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, username: true },
    });
    if (!target) throw new NotFoundError('User');
    if (target.role === 'superadmin') throw new ForbiddenError('Cannot modify a super admin\'s role');
    if (target.role === role) throw new BadRequestError(`User already has role "${role}"`);

    await prisma.user.update({
      where: { id: targetId },
      data: { role },
    });

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'user.role_change',
      targetType: 'user',
      targetId,
      metadata: { oldRole: target.role, newRole: role, username: target.username },
    });

    res.json({ success: true, message: `User "${target.username}" role changed to ${role}` });
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
      select: { id: true, name: true },
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

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'server.delete',
      targetType: 'server',
      targetId: server.id,
      metadata: { serverName: server.name },
    });

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

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'ip_ban.create',
      targetType: 'ip',
      targetId: trimmedIp,
      metadata: { reason: sanitizedReason },
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

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'ip_ban.delete',
      targetType: 'ip',
      targetId: ipBan.ip,
    });

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

// ─── Storage Management ──────────────────────────────────────────────────────

function classifyKey(key: string): 'avatar' | 'server-icon' {
  return key.startsWith('server-icons/') ? 'server-icon' : 'avatar';
}

adminRouter.get('/storage/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [objects, usersWithAvatar, serversWithIcon] = await Promise.all([
      listAllS3Objects(),
      prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
      prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { iconUrl: true } }),
    ]);

    const referencedKeys = new Set<string>();
    for (const u of usersWithAvatar) if (u.avatarUrl) referencedKeys.add(u.avatarUrl);
    for (const s of serversWithIcon) if (s.iconUrl) referencedKeys.add(s.iconUrl);

    const stats: StorageStats = {
      totalFiles: 0, totalSize: 0,
      avatarCount: 0, avatarSize: 0,
      serverIconCount: 0, serverIconSize: 0,
      orphanCount: 0, orphanSize: 0,
    };

    for (const obj of objects) {
      stats.totalFiles++;
      stats.totalSize += obj.size;

      const type = classifyKey(obj.key);
      if (type === 'avatar') {
        stats.avatarCount++;
        stats.avatarSize += obj.size;
      } else {
        stats.serverIconCount++;
        stats.serverIconSize += obj.size;
      }

      if (!referencedKeys.has(obj.key)) {
        stats.orphanCount++;
        stats.orphanSize += obj.size;
      }
    }

    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

let topUploadersCache: { data: StorageTopUploader[]; expiresAt: number } | null = null;
const TOP_UPLOADERS_TTL_MS = 60_000; // 60 seconds

adminRouter.get('/storage/top-uploaders', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (topUploadersCache && Date.now() < topUploadersCache.expiresAt) {
      return res.json({ success: true, data: topUploadersCache.data });
    }

    const objects = await listAllS3Objects();

    // Aggregate by entity ID parsed from S3 keys
    const entityMap = new Map<string, { type: 'user' | 'server'; fileCount: number; totalSize: number }>();

    for (const obj of objects) {
      let type: 'user' | 'server';
      let filename: string;

      if (obj.key.startsWith('avatars/')) {
        filename = obj.key.slice('avatars/'.length);
        type = 'user';
      } else if (obj.key.startsWith('server-icons/')) {
        filename = obj.key.slice('server-icons/'.length);
        type = 'server';
      } else {
        continue;
      }

      // Key format: {entityId}-{timestamp}.webp — split on last hyphen to get the entity ID
      const lastDash = filename.lastIndexOf('-');
      if (lastDash <= 0) continue;
      const entityId = filename.slice(0, lastDash);

      const existing = entityMap.get(entityId);
      if (existing) {
        existing.fileCount++;
        existing.totalSize += obj.size;
      } else {
        entityMap.set(entityId, { type, fileCount: 1, totalSize: obj.size });
      }
    }

    // Collect user IDs and server IDs
    const userIds: string[] = [];
    const serverIds: string[] = [];
    for (const [id, info] of entityMap) {
      if (info.type === 'user') userIds.push(id);
      else serverIds.push(id);
    }

    // Fetch names from DB
    const [users, servers] = await Promise.all([
      userIds.length > 0
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
        : [],
      serverIds.length > 0
        ? prisma.server.findMany({ where: { id: { in: serverIds } }, select: { id: true, name: true } })
        : [],
    ]);

    const nameMap = new Map<string, string>();
    for (const u of users) nameMap.set(u.id, u.username);
    for (const s of servers) nameMap.set(s.id, s.name);

    // Build result, sort by totalSize desc, limit to 10
    const result: StorageTopUploader[] = [];
    for (const [entityId, info] of entityMap) {
      result.push({
        entityId,
        entityName: nameMap.get(entityId) ?? 'Deleted',
        type: info.type,
        fileCount: info.fileCount,
        totalSize: info.totalSize,
      });
    }
    result.sort((a, b) => b.totalSize - a.totalSize);

    const data = result.slice(0, 10);
    topUploadersCache = { data, expiresAt: Date.now() + TOP_UPLOADERS_TTL_MS };

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/storage/files', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const filter = (req.query.filter as string) || 'all';

    const prefix = filter === 'avatars' ? 'avatars/' : filter === 'server-icons' ? 'server-icons/' : undefined;
    const objects = await listAllS3Objects(prefix);

    const [usersWithAvatar, serversWithIcon] = await Promise.all([
      prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { id: true, username: true, avatarUrl: true } }),
      prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { id: true, name: true, iconUrl: true } }),
    ]);

    const keyToUser = new Map<string, { id: string; name: string }>();
    for (const u of usersWithAvatar) if (u.avatarUrl) keyToUser.set(u.avatarUrl, { id: u.id, name: u.username });
    const keyToServer = new Map<string, { id: string; name: string }>();
    for (const s of serversWithIcon) if (s.iconUrl) keyToServer.set(s.iconUrl, { id: s.id, name: s.name });

    let files: StorageFile[] = objects.map((obj) => {
      const type = classifyKey(obj.key);
      const userRef = keyToUser.get(obj.key);
      const serverRef = keyToServer.get(obj.key);
      const linked = userRef ?? serverRef ?? null;

      return {
        key: obj.key,
        type,
        size: obj.size,
        lastModified: obj.lastModified,
        linkedEntity: linked?.name ?? null,
        linkedEntityId: linked?.id ?? null,
        isOrphan: !linked,
      };
    });

    if (filter === 'orphaned') {
      files = files.filter((f) => f.isOrphan);
    }

    // Sort by lastModified desc
    files.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    const total = files.length;
    const paginated = files.slice((page - 1) * limit, page * limit);

    res.json({ success: true, data: paginated, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/storage/files/*', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = (req.params as Record<string, string>)[0];
    if (!key || !VALID_S3_KEY_RE.test(key)) throw new BadRequestError('Invalid file key');

    // Nullify DB reference
    if (key.startsWith('avatars/')) {
      await prisma.user.updateMany({ where: { avatarUrl: key }, data: { avatarUrl: null } });
    } else if (key.startsWith('server-icons/')) {
      await prisma.server.updateMany({ where: { iconUrl: key }, data: { iconUrl: null } });
    }

    await deleteFromS3(key);

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'storage.file_delete',
      targetType: 'file',
      targetId: key,
    });

    res.json({ success: true, message: 'File deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Audit Log ──────────────────────────────────────────────────────────

adminRouter.get('/audit-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const action = (req.query.action as string)?.trim() || '';
    const search = (req.query.search as string)?.trim() || '';

    const where: Record<string, unknown> = {};
    if (action) where.action = action;
    if (search) {
      where.OR = [
        { actor: { username: { contains: search, mode: 'insensitive' } } },
        { targetId: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const data: AuditLogEntry[] = logs.map((log) => ({
      id: log.id,
      actorId: log.actorId,
      actorUsername: log.actor?.username ?? null,
      action: log.action as AuditLogEntry['action'],
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata as Record<string, unknown> | null,
      createdAt: log.createdAt.toISOString(),
    }));

    res.json({ success: true, data, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

// ─── Data Export ─────────────────────────────────────────────────────────────

adminRouter.get('/export/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, displayName: true, email: true, avatarUrl: true,
        role: true, status: true, bannedAt: true, banReason: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/export/servers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const servers = await prisma.server.findMany({
      select: {
        id: true, name: true, iconUrl: true, ownerId: true, createdAt: true,
        owner: { select: { username: true } },
        _count: { select: { members: true, channels: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const serverIds = servers.map((s) => s.id);
    const messageCounts = serverIds.length > 0
      ? await prisma.message.groupBy({
          by: ['channelId'],
          where: { channel: { serverId: { in: serverIds } } },
          _count: true,
        })
      : [];

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

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/export/bans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const bans = await prisma.user.findMany({
      where: { bannedAt: { not: null } },
      select: { id: true, username: true, displayName: true, email: true, bannedAt: true, banReason: true },
      orderBy: { bannedAt: 'desc' },
    });
    res.json({ success: true, data: bans });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/export/ip-bans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ipBans = await prisma.ipBan.findMany({
      select: { id: true, ip: true, reason: true, bannedBy: true, createdAt: true, creator: { select: { username: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const data = ipBans.map((b) => ({
      id: b.id,
      ip: b.ip,
      reason: b.reason,
      bannedBy: b.bannedBy,
      bannedByUsername: b.creator?.username ?? 'Deleted admin',
      createdAt: b.createdAt,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/storage/cleanup-orphans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [objects, usersWithAvatar, serversWithIcon] = await Promise.all([
      listAllS3Objects(),
      prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
      prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { iconUrl: true } }),
    ]);

    const referencedKeys = new Set<string>();
    for (const u of usersWithAvatar) if (u.avatarUrl) referencedKeys.add(u.avatarUrl);
    for (const s of serversWithIcon) if (s.iconUrl) referencedKeys.add(s.iconUrl);

    const orphans = objects.filter((obj) => !referencedKeys.has(obj.key));
    let deleted = 0;

    for (const orphan of orphans) {
      try {
        await deleteFromS3(orphan.key);
        deleted++;
      } catch {
        // Continue with remaining orphans
      }
    }

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'storage.cleanup_orphans',
      targetType: 'storage',
      metadata: { found: orphans.length, deleted },
    });

    res.json({ success: true, data: { found: orphans.length, deleted } });
  } catch (err) {
    next(err);
  }
});
