import { Router, type Request, type Response, type NextFunction } from 'express';
import net from 'net';
import { authenticate } from '../middleware/auth';
import { requireAdmin, requireSuperAdmin } from '../middleware/requireSuperAdmin';
import { rateLimitAdmin } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { purgeE2EMaterial } from '../utils/e2ePurge';
import { purgeSecureChannelStateForAccount } from '../utils/secureChannelLifecycle';
import { getOnlineUsers } from '../utils/redis';
import { getIO } from '../websocket/socketServer';
import { getVoiceMediaCounts, getTransportCountsByChannel, getActiveVoiceChannelCount, getTotalVoiceUsers, getVoiceDiagnostics } from '../websocket/voiceHandler';
import { broadcastServerVoiceCleanup } from '../websocket/voiceCluster';
import { getActiveDMCallCount, getTotalDMVoiceUsers } from '../websocket/dmVoiceHandler';
import { getSfuStats } from '../mediasoup/mediasoupManager';
import { getGlobalLimits } from '../utils/serverLimits';
import { sanitizeText } from '../utils/sanitize';
import { broadcastMemberJoined, broadcastMemberLeft } from '../utils/memberBroadcast';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { listAllS3Objects, deleteFromS3, VALID_S3_KEY_RE, VALID_ATTACHMENT_KEY_RE } from '../utils/s3';
import type { StorageStats, StorageFile, StorageTopUploader, MemberRole, AuditLogEntry, Announcement, AnnouncementType, AnnouncementScope, SupportMessageData } from '@voxium/shared';
import { WS_EVENTS, LIMITS } from '@voxium/shared';
import { logAuditEvent } from '../utils/auditLog';

export const adminRouter = Router();

adminRouter.use(authenticate, requireAdmin, rateLimitAdmin);

/** Force-logout and disconnect a user across all nodes. */
async function forceLogoutUser(userId: string, reason: string): Promise<void> {
  const io = getIO();
  io.to(`user:${userId}`).emit('force:logout', { reason });
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) s.disconnect(true);
}

/** Remove all sockets from a server room across all nodes. */
async function clearServerRoom(serverId: string): Promise<void> {
  const io = getIO();
  const sockets = await io.in(`server:${serverId}`).fetchSockets();
  for (const s of sockets) s.leave(`server:${serverId}`);
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────


// Registration abuse triage (anti-bot Phase 4): the numbers that make a bot
// wave visible — volume over two windows, the unverified backlog, and which
// registration IPs are pulling the average up. All queries are bounded
// (counts + a groupBy take:10) per the admin-analytics rules.
adminRouter.get('/registration-stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [lastHour, last24h, unverifiedTotal, topRegisterIps, topDomains] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: hourAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.user.count({ where: { emailVerified: false } }),
      prisma.ipRecord.groupBy({
        by: ['ip'],
        where: { kind: 'register', lastSeenAt: { gte: weekAgo } },
        _count: { ip: true },
        orderBy: { _count: { ip: 'desc' } },
        take: 10,
      }),
      // Domain is derived, not stored, so raw SQL — bounded by LIMIT, and the
      // only parameter is a server-computed Date (no user input reaches it)
      prisma.$queryRaw<Array<{ domain: string; registrations: bigint }>>`
        SELECT split_part(email, '@', 2) AS domain, COUNT(*) AS registrations
        FROM users WHERE created_at >= ${weekAgo}
        GROUP BY domain ORDER BY registrations DESC LIMIT 10`,
    ]);

    res.json({
      success: true,
      data: {
        lastHour,
        last24h,
        unverifiedTotal,
        topRegisterIps: topRegisterIps.map((r) => ({ ip: r.ip, registrations: r._count.ip })),
        // bigint from raw SQL does not survive JSON.stringify
        topDomains: topDomains.map((r) => ({ domain: r.domain, registrations: Number(r.registrations) })),
      },
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [totalUsers, totalServers, totalMessages, bannedUsers, onlineUserIds, pendingReports, openTickets, totalConversations, totalFriendships] = await Promise.all([
      prisma.user.count(),
      prisma.server.count(),
      prisma.message.count(),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      getOnlineUsers(),
      prisma.report.count({ where: { status: 'pending' } }),
      prisma.supportTicket.count({ where: { status: { in: ['open', 'claimed'] } } }),
      prisma.conversation.count(),
      prisma.friendship.count({ where: { status: 'accepted' } }),
    ]);

    res.json({
      success: true,
      data: { totalUsers, totalServers, totalMessages, onlineUsers: onlineUserIds.length, bannedUsers, pendingReports, openTickets, totalConversations, totalFriendships },
    });
  } catch (err) {
    next(err);
  }
});

// ─── SFU Stats ─────────────────────────────────────────────────────────────

adminRouter.get('/stats/sfu', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const channelTransports = getTransportCountsByChannel();
    const [sfuStats, mediaCounts] = await Promise.all([
      getSfuStats(channelTransports),
      Promise.resolve(getVoiceMediaCounts()),
    ]);

    res.json({
      success: true,
      data: {
        ...sfuStats,
        totalTransports: mediaCounts.transports,
        totalProducers: mediaCounts.producers,
        totalConsumers: mediaCounts.consumers,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Voice Diagnostics (for testing optimizations) ────────────────────────

adminRouter.get('/stats/voice-diag', (_req: Request, res: Response) => {
  res.json({ success: true, data: getVoiceDiagnostics() });
});

// ─── Live Metrics ─────────────────────────────────────────────────────────

adminRouter.get('/stats/live', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [onlineUserIds, messagesLastHour, dmCalls, dmVoiceUsers, voiceChannels, voiceUsers] = await Promise.all([
      getOnlineUsers(),
      prisma.message.count({ where: { createdAt: { gte: oneHourAgo } } }),
      getActiveDMCallCount(),
      getTotalDMVoiceUsers(),
      getActiveVoiceChannelCount(),
      getTotalVoiceUsers(),
    ]);

    res.json({
      success: true,
      data: {
        onlineUsers: onlineUserIds.length,
        voiceChannels,
        voiceUsers,
        dmCalls,
        dmVoiceUsers,
        messagesLastHour,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Geo Stats ─────────────────────────────────────────────────────────────

adminRouter.get('/stats/geo', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.ipRecord.groupBy({
      by: ['countryCode', 'country'],
      where: { countryCode: { not: null } },
      _count: { userId: true },
    });

    const data = rows
      .filter((r) => r.countryCode)
      .map((r) => ({
        countryCode: r.countryCode!,
        country: r.country || r.countryCode!,
        count: r._count.userId,
      }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── User Management ────────────────────────────────────────────────────────

adminRouter.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
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
          role: true, status: true, isSupporter: true, supporterTier: true, bannedAt: true, banReason: true, createdAt: true,
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
        bio: true, role: true, status: true, isSupporter: true, supporterTier: true, bannedAt: true, banReason: true, createdAt: true,
        emailVerified: true, emailVerifiedAt: true,
        ipRecords: { select: { ip: true, kind: true, country: true, lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } },
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
    if (target.role === 'admin' && req.user!.role !== 'superadmin') throw new ForbiddenError('Only super admins can ban other admins');

    const sanitizedReason = reason ? sanitizeText(reason) : null;

    // Ban the account + all known IPs ATOMICALLY (MED-13). The old flow updated
    // the user, then upserted IP bans one-by-one in a loop — a failure midway
    // left a half-banned state, and N known IPs meant N+1 statements.
    let ipsBanned = 0;
    const ipRecords = banIps
      ? await prisma.ipRecord.findMany({ where: { userId: targetId }, select: { ip: true } })
      : [];

    const [, ipBanResult] = await prisma.$transaction([
      prisma.user.update({
        where: { id: targetId },
        data: {
          bannedAt: new Date(),
          banReason: sanitizedReason,
          tokenVersion: { increment: 1 }, // Invalidate all tokens
        },
      }),
      prisma.ipBan.createMany({
        data: ipRecords.map((r) => ({ ip: r.ip, reason: sanitizedReason, bannedBy: req.user!.userId })),
        skipDuplicates: true, // already-banned IPs are fine
      }),
    ]);
    ipsBanned = ipBanResult.count;

    // Notify servers that user left
    const memberships = await prisma.serverMember.findMany({
      where: { userId: targetId },
      select: { serverId: true },
    });
    for (const { serverId } of memberships) {
      await broadcastMemberLeft(targetId, serverId);
    }

    // Force logout then disconnect active socket (works across all nodes)
    await forceLogoutUser(targetId, 'Your account has been banned');

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'user.ban',
      targetType: 'user',
      targetId: targetId,
      // knownIps distinguishes "user had no IPs" from "all IPs already banned"
      // (createMany with skipDuplicates only counts NEWLY inserted bans)
      metadata: { reason: sanitizedReason, banIps: !!banIps, ipsBanned, knownIps: ipRecords.length },
    });

    const message = !banIps
      ? 'User banned'
      : ipsBanned > 0
        ? `User banned (${ipsBanned} IP(s) also banned)`
        : ipRecords.length > 0
          ? 'User banned (all known IPs were already banned)'
          : 'User banned (no known IPs to ban)';
    res.json({ success: true, message });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users/:userId/unban', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, bannedAt: true } });
    if (!user) throw new NotFoundError('User');
    if (!user.bannedAt) throw new BadRequestError('User is not banned');

    // Remove IP bans for this user's IPs — but only if no other banned user
    // shares that IP. Resolved in ONE query instead of a findFirst per IP
    // (MED-13: the old loop was N+1 for users seen from many IPs).
    const ipRecords = await prisma.ipRecord.findMany({
      where: { userId: req.params.userId },
      select: { ip: true },
    });
    const ips = ipRecords.map((r) => r.ip);
    const sharedWithOtherBanned = ips.length > 0
      ? await prisma.ipRecord.findMany({
          where: {
            ip: { in: ips },
            userId: { not: req.params.userId },
            user: { bannedAt: { not: null } },
          },
          select: { ip: true },
          distinct: ['ip'],
        })
      : [];
    const stillBannedIps = new Set(sharedWithOtherBanned.map((r) => r.ip));
    const ipsToRelease = ips.filter((ip) => !stillBannedIps.has(ip));

    // Unban + IP release atomically — no half-unbanned state on failure
    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.params.userId },
        data: { bannedAt: null, banReason: null },
      }),
      ...(ipsToRelease.length > 0
        ? [prisma.ipBan.deleteMany({ where: { ip: { in: ipsToRelease } } })]
        : []),
    ]);

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
    if (target.role === 'admin' && req.user!.role !== 'superadmin') throw new ForbiddenError('Only super admins can delete other admins');

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
            // Add them as a member first, seed ChannelRead records (secure
            // channels excluded — ownership grants no secure-channel access)
            const textChannels = await prisma.channel.findMany({
              where: { serverId: action.serverId, type: 'text', secure: false },
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
          io.to(`server:${action.serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
            serverId: action.serverId,
            userId: action.newOwnerId,
            role: 'owner' as MemberRole,
          });

          const updatedServer = await prisma.server.findUnique({
            where: { id: action.serverId },
            select: { id: true, name: true, iconUrl: true, ownerId: true, invitesLocked: true, createdAt: true },
          });
          if (updatedServer) {
            io.to(`server:${action.serverId}`).emit(WS_EVENTS.SERVER_UPDATED, {
              ...updatedServer,
              createdAt: updatedServer.createdAt.toISOString(),
            });
          }

          // Broadcast that the deleted user left this server
          await broadcastMemberLeft(targetId, action.serverId);

        } else {
          // action === 'delete' — clean up and delete the server (voice cleanup
          // fans out to every node; mediasoup objects are node-local)
          await broadcastServerVoiceCleanup(io, action.serverId);
          io.to(`server:${action.serverId}`).emit('server:deleted', { serverId: action.serverId });
          await clearServerRoom(action.serverId);
          await prisma.server.delete({ where: { id: action.serverId } });
        }
      }

      // Notify non-owned servers that user left
      for (const { serverId } of memberships) {
        if (!ownedServerIds.has(serverId)) {
          await broadcastMemberLeft(targetId, serverId);
        }
      }

      // Force logout then disconnect active socket (works across all nodes)
      await forceLogoutUser(targetId, 'Your account has been deleted');

      // Secure channels: the DB cascade would silently reap the rows, but the
      // members deserve events (created channels vanish from their sidebars,
      // membership lists refresh). Best-effort, before the delete.
      await purgeSecureChannelStateForAccount(targetId);

      // E2E key material has no FK to User (except the key backup), so it would
      // otherwise outlive the account it belongs to. One transaction with the
      // delete: purging a user who then survives strands every device they own.
      await prisma.$transaction(async (tx) => {
        await purgeE2EMaterial(targetId, tx);
        // cascade only removes ServerMember records for transferred servers
        await tx.user.delete({ where: { id: targetId } });
      },
        {
          // Deleting a user cascades across ~36 relations (messages,
          // reactions, reads, conversations, reports, tickets, themes…) plus
          // six E2E deletes. Prisma's default 5s interactive budget is a
          // deadline these statements never had before they shared a
          // transaction, and blowing it on a heavy account would roll the
          // whole deletion back — after the account's servers were already
          // gone, since those are not part of this transaction.
          timeout: 60_000,
          maxWait: 10_000,
        });

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

      // Force logout then disconnect active socket (works across all nodes)
      await forceLogoutUser(targetId, 'Your account has been deleted');

      // Secure-channel cleanup (events for surviving members), before delete
      await purgeSecureChannelStateForAccount(targetId);

      await prisma.$transaction(async (tx) => {
        await purgeE2EMaterial(targetId, tx);
        await tx.user.delete({ where: { id: targetId } });
      },
        {
          // Deleting a user cascades across ~36 relations (messages,
          // reactions, reads, conversations, reports, tickets, themes…) plus
          // six E2E deletes. Prisma's default 5s interactive budget is a
          // deadline these statements never had before they shared a
          // transaction, and blowing it on a heavy account would roll the
          // whole deletion back — after the account's servers were already
          // gone, since those are not part of this transaction.
          timeout: 60_000,
          maxWait: 10_000,
        });

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

    // Broadcast badge change to all servers the user is in + DM conversations
    try {
      const io = getIO();
      const payload = { userId: targetId, role };
      const [memberships, conversations] = await Promise.all([
        prisma.serverMember.findMany({ where: { userId: targetId }, select: { serverId: true } }),
        prisma.conversation.findMany({ where: { OR: [{ user1Id: targetId }, { user2Id: targetId }] }, select: { id: true } }),
      ]);
      for (const { serverId } of memberships) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.USER_UPDATED, payload);
      }
      for (const { id } of conversations) {
        io.to(`dm:${id}`).emit(WS_EVENTS.USER_UPDATED, payload);
      }
    } catch (broadcastErr) {
      console.error('[Admin] Failed to broadcast role change:', broadcastErr);
    }

    res.json({ success: true, message: `User "${target.username}" role changed to ${role}` });
  } catch (err) {
    next(err);
  }
});

// ─── Supporter Badge ────────────────────────────────────────────────────────

adminRouter.patch('/users/:userId/supporter', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { userId: targetId } = req.params;
    const { isSupporter, supporterTier } = req.body as { isSupporter?: boolean; supporterTier?: string | null };

    if (typeof isSupporter !== 'boolean') {
      throw new BadRequestError('isSupporter must be a boolean');
    }

    // Validate supporterTier if provided
    const validTiers = ['first', 'top', null];
    if (supporterTier !== undefined && !validTiers.includes(supporterTier)) {
      throw new BadRequestError('supporterTier must be "first", "top", or null');
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, username: true, isSupporter: true, supporterTier: true },
    });
    if (!target) throw new NotFoundError('User');

    await prisma.user.update({
      where: { id: targetId },
      data: {
        isSupporter,
        supporterTier: isSupporter ? (supporterTier !== undefined ? supporterTier : target.supporterTier) : null,
        supporterSince: isSupporter ? (target.isSupporter ? undefined : new Date()) : null,
      },
    });

    // Broadcast badge change to all servers the user is in + DM conversations
    try {
      const io = getIO();
      const finalTier = isSupporter ? (supporterTier !== undefined ? supporterTier : target.supporterTier) : null;
      const payload = { userId: targetId, isSupporter, supporterTier: finalTier };
      const [memberships, conversations] = await Promise.all([
        prisma.serverMember.findMany({ where: { userId: targetId }, select: { serverId: true } }),
        prisma.conversation.findMany({ where: { OR: [{ user1Id: targetId }, { user2Id: targetId }] }, select: { id: true } }),
      ]);
      for (const { serverId } of memberships) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.USER_UPDATED, payload);
      }
      for (const { id } of conversations) {
        io.to(`dm:${id}`).emit(WS_EVENTS.USER_UPDATED, payload);
      }
    } catch (broadcastErr) {
      console.error('[Admin] Failed to broadcast supporter change:', broadcastErr);
    }

    res.json({ success: true, message: `Supporter badge ${isSupporter ? 'granted to' : 'removed from'} "${target.username}"` });
  } catch (err) {
    next(err);
  }
});

// ─── Server Management ──────────────────────────────────────────────────────

adminRouter.get('/servers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
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

    // Clean up voice state on every node (mediasoup objects are node-local)
    await broadcastServerVoiceCleanup(io, server.id);

    // Notify members
    io.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });

    // Remove all sockets from the server room (works across all nodes)
    await clearServerRoom(server.id);

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

// ─── Resource Limits ────────────────────────────────────────────────────────

// Get global resource limits
adminRouter.get('/limits/global', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const limits = await getGlobalLimits();
    res.json({ success: true, data: limits });
  } catch (err) { next(err); }
});

// Update global resource limits
adminRouter.put('/limits/global', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { maxChannelsPerServer, maxVoiceUsersPerChannel, maxCategoriesPerServer, maxMembersPerServer } = req.body;
    const data: Record<string, number> = {};
    if (maxChannelsPerServer !== undefined) data.maxChannelsPerServer = Math.max(1, Math.min(500, Number(maxChannelsPerServer)));
    if (maxVoiceUsersPerChannel !== undefined) data.maxVoiceUsersPerChannel = Math.max(1, Math.min(500, Number(maxVoiceUsersPerChannel)));
    if (maxCategoriesPerServer !== undefined) data.maxCategoriesPerServer = Math.max(1, Math.min(200, Number(maxCategoriesPerServer)));
    if (maxMembersPerServer !== undefined) data.maxMembersPerServer = Math.max(0, Math.min(100000, Number(maxMembersPerServer)));

    const config = await prisma.globalConfig.upsert({
      where: { id: 'global' },
      create: { id: 'global', ...data },
      update: data,
    });

    res.json({ success: true, data: {
      maxChannelsPerServer: config.maxChannelsPerServer,
      maxVoiceUsersPerChannel: config.maxVoiceUsersPerChannel,
      maxCategoriesPerServer: config.maxCategoriesPerServer,
      maxMembersPerServer: config.maxMembersPerServer,
    }});
  } catch (err) { next(err); }
});

// Get per-server limits (returns null fields for "use global")
adminRouter.get('/limits/servers/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const limits = await prisma.serverLimits.findUnique({ where: { serverId: req.params.serverId } });
    res.json({ success: true, data: limits ? {
      maxChannelsPerServer: limits.maxChannelsPerServer,
      maxVoiceUsersPerChannel: limits.maxVoiceUsersPerChannel,
      maxCategoriesPerServer: limits.maxCategoriesPerServer,
      maxMembersPerServer: limits.maxMembersPerServer,
    } : {
      maxChannelsPerServer: null,
      maxVoiceUsersPerChannel: null,
      maxCategoriesPerServer: null,
      maxMembersPerServer: null,
    }});
  } catch (err) { next(err); }
});

// Update per-server limits (null = use global default)
adminRouter.put('/limits/servers/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const server = await prisma.server.findUnique({ where: { id: req.params.serverId }, select: { id: true } });
    if (!server) throw new NotFoundError('Server');

    const { maxChannelsPerServer, maxVoiceUsersPerChannel, maxCategoriesPerServer, maxMembersPerServer } = req.body;
    const toInt = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };

    const data = {
      maxChannelsPerServer: maxChannelsPerServer !== undefined ? (toInt(maxChannelsPerServer) !== null ? Math.max(1, Math.min(500, toInt(maxChannelsPerServer)!)) : null) : undefined,
      maxVoiceUsersPerChannel: maxVoiceUsersPerChannel !== undefined ? (toInt(maxVoiceUsersPerChannel) !== null ? Math.max(1, Math.min(500, toInt(maxVoiceUsersPerChannel)!)) : null) : undefined,
      maxCategoriesPerServer: maxCategoriesPerServer !== undefined ? (toInt(maxCategoriesPerServer) !== null ? Math.max(1, Math.min(200, toInt(maxCategoriesPerServer)!)) : null) : undefined,
      maxMembersPerServer: maxMembersPerServer !== undefined ? (toInt(maxMembersPerServer) !== null ? Math.max(0, Math.min(100000, toInt(maxMembersPerServer)!)) : null) : undefined,
    };

    // Remove undefined keys
    const cleanData = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

    const limits = await prisma.serverLimits.upsert({
      where: { serverId: req.params.serverId },
      create: { serverId: req.params.serverId, ...cleanData },
      update: cleanData,
    });

    res.json({ success: true, data: {
      maxChannelsPerServer: limits.maxChannelsPerServer,
      maxVoiceUsersPerChannel: limits.maxVoiceUsersPerChannel,
      maxCategoriesPerServer: limits.maxCategoriesPerServer,
      maxMembersPerServer: limits.maxMembersPerServer,
    }});
  } catch (err) { next(err); }
});

// Reset per-server limits (remove all overrides)
adminRouter.delete('/limits/servers/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    await prisma.serverLimits.deleteMany({ where: { serverId: req.params.serverId } });
    res.json({ success: true, message: 'Server limits reset to global defaults' });
  } catch (err) { next(err); }
});

// ─── Infrastructure Server Locations ──────────────────────────────────────────

// GET /admin/infra-servers — list all
adminRouter.get('/infra-servers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const servers = await prisma.infraServer.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ success: true, data: servers });
  } catch (err) { next(err); }
});

// POST /admin/infra-servers — create (superadmin only)
adminRouter.post('/infra-servers', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, country, city, provider, latitude, longitude } = req.body;
    if (!name || typeof name !== 'string') throw new BadRequestError('name is required');
    if (!country || typeof country !== 'string') throw new BadRequestError('country is required');
    if (!city || typeof city !== 'string') throw new BadRequestError('city is required');
    if (!provider || typeof provider !== 'string') throw new BadRequestError('provider is required');
    if (name.length > 100) throw new BadRequestError('name must be at most 100 characters');
    if (country.length > 100) throw new BadRequestError('country must be at most 100 characters');
    if (city.length > 100) throw new BadRequestError('city must be at most 100 characters');
    if (provider.length > 100) throw new BadRequestError('provider must be at most 100 characters');
    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) throw new BadRequestError('latitude must be between -90 and 90');
    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) throw new BadRequestError('longitude must be between -180 and 180');
    if (!isFinite(latitude) || !isFinite(longitude)) throw new BadRequestError('latitude and longitude must be finite numbers');

    const server = await prisma.infraServer.create({
      data: { name: sanitizeText(name), country: sanitizeText(country), city: sanitizeText(city), provider: sanitizeText(provider), latitude, longitude },
    });
    res.status(201).json({ success: true, data: server });
  } catch (err) { next(err); }
});

// PATCH /admin/infra-servers/:id — update (superadmin only)
adminRouter.patch('/infra-servers/:id', requireSuperAdmin, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const existing = await prisma.infraServer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Infrastructure server');

    const updateData: Record<string, unknown> = {};
    if (req.body.name !== undefined) { if (typeof req.body.name !== 'string' || req.body.name.length > 100) throw new BadRequestError('name must be a string (max 100 chars)'); updateData.name = sanitizeText(req.body.name); }
    if (req.body.country !== undefined) { if (typeof req.body.country !== 'string' || req.body.country.length > 100) throw new BadRequestError('country must be a string (max 100 chars)'); updateData.country = sanitizeText(req.body.country); }
    if (req.body.city !== undefined) { if (typeof req.body.city !== 'string' || req.body.city.length > 100) throw new BadRequestError('city must be a string (max 100 chars)'); updateData.city = sanitizeText(req.body.city); }
    if (req.body.provider !== undefined) { if (typeof req.body.provider !== 'string' || req.body.provider.length > 100) throw new BadRequestError('provider must be a string (max 100 chars)'); updateData.provider = sanitizeText(req.body.provider); }
    if (req.body.latitude !== undefined) { if (typeof req.body.latitude !== 'number' || !isFinite(req.body.latitude) || req.body.latitude < -90 || req.body.latitude > 90) throw new BadRequestError('latitude must be a finite number between -90 and 90'); updateData.latitude = req.body.latitude; }
    if (req.body.longitude !== undefined) { if (typeof req.body.longitude !== 'number' || !isFinite(req.body.longitude) || req.body.longitude < -180 || req.body.longitude > 180) throw new BadRequestError('longitude must be a finite number between -180 and 180'); updateData.longitude = req.body.longitude; }

    if (Object.keys(updateData).length === 0) throw new BadRequestError('No fields to update');

    const updated = await prisma.infraServer.update({ where: { id }, data: updateData });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// DELETE /admin/infra-servers/:id — delete (superadmin only)
adminRouter.delete('/infra-servers/:id', requireSuperAdmin, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const existing = await prisma.infraServer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Infrastructure server');
    await prisma.infraServer.delete({ where: { id } });
    res.json({ success: true, message: 'Infrastructure server deleted' });
  } catch (err) { next(err); }
});

// ─── Ban Management ─────────────────────────────────────────────────────────

adminRouter.get('/bans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

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
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

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
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string, 10) || 30));
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
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours as string, 10) || 24));
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

adminRouter.get('/server-growth', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string, 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.$queryRawUnsafe<Array<{ day: string; count: bigint }>>(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM servers
       WHERE created_at >= $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      since
    );

    res.json({
      success: true,
      data: rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/top-servers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    // Aggregate messages and members in separate subqueries. The old double
    // LEFT JOIN produced a cartesian rowset (messages × members per server) that
    // COUNT(DISTINCT) then had to deduplicate — one dashboard load could scan
    // millions of intermediate rows and pin Postgres (MED-12).
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; message_count: bigint; member_count: bigint }>>(
      `SELECT s.id, s.name,
              COALESCE(mc.message_count, 0) AS message_count,
              COALESCE(smc.member_count, 0) AS member_count
       FROM servers s
       LEFT JOIN (
         SELECT c.server_id, COUNT(m.id) AS message_count
         FROM channels c
         JOIN messages m ON m.channel_id = c.id
         GROUP BY c.server_id
       ) mc ON mc.server_id = s.id
       LEFT JOIN (
         SELECT server_id, COUNT(*) AS member_count
         FROM server_members
         GROUP BY server_id
       ) smc ON smc.server_id = s.id
       ORDER BY COALESCE(mc.message_count, 0) DESC
       LIMIT $1`,
      limit
    );

    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        messageCount: Number(r.message_count),
        memberCount: Number(r.member_count),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Storage Management ──────────────────────────────────────────────────────

function classifyKey(key: string): 'avatar' | 'server-icon' | 'attachment' {
  if (key.startsWith('server-icons/')) return 'server-icon';
  if (key.startsWith('attachments/')) return 'attachment';
  return 'avatar';
}

adminRouter.get('/storage/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [objects, usersWithAvatar, serversWithIcon, attachmentKeys] = await Promise.all([
      listAllS3Objects(),
      prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
      prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { iconUrl: true } }),
      prisma.messageAttachment.findMany({ where: { expired: false }, select: { s3Key: true } }),
    ]);

    const referencedKeys = new Set<string>();
    for (const u of usersWithAvatar) if (u.avatarUrl) referencedKeys.add(u.avatarUrl);
    for (const s of serversWithIcon) if (s.iconUrl) referencedKeys.add(s.iconUrl);
    for (const a of attachmentKeys) referencedKeys.add(a.s3Key);

    const stats: StorageStats = {
      totalFiles: 0, totalSize: 0,
      avatarCount: 0, avatarSize: 0,
      serverIconCount: 0, serverIconSize: 0,
      attachmentCount: 0, attachmentSize: 0,
      orphanCount: 0, orphanSize: 0,
    };

    for (const obj of objects) {
      stats.totalFiles++;
      stats.totalSize += obj.size;

      const type = classifyKey(obj.key);
      if (type === 'avatar') {
        stats.avatarCount++;
        stats.avatarSize += obj.size;
      } else if (type === 'server-icon') {
        stats.serverIconCount++;
        stats.serverIconSize += obj.size;
      } else {
        stats.attachmentCount++;
        stats.attachmentSize += obj.size;
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

    // ── 1. S3-based aggregation for avatars & server-icons ──
    const objects = await listAllS3Objects();
    const s3EntityMap = new Map<string, { type: 'user' | 'server'; fileCount: number; totalSize: number }>();

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
        continue; // attachments handled via DB below
      }

      const lastDash = filename.lastIndexOf('-');
      if (lastDash <= 0) continue;
      const entityId = filename.slice(0, lastDash);

      const existing = s3EntityMap.get(entityId);
      if (existing) {
        existing.fileCount++;
        existing.totalSize += obj.size;
      } else {
        s3EntityMap.set(entityId, { type, fileCount: 1, totalSize: obj.size });
      }
    }

    // ── 2. DB-based aggregation for attachments ──
    // Aggregated in SQL. The old code grouped by messageId then fetched every
    // message with attachments through an UNBOUNDED `id IN (...)` list — at
    // scale that's a multi-megabyte query that errors out or pins Postgres
    // (MED-12). Two grouped queries return at most one row per user/server.
    const [userRows, serverRows] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ entity_id: string; file_count: bigint; total_size: bigint }>>(
        `SELECT m.author_id AS entity_id, COUNT(a.id) AS file_count, COALESCE(SUM(a.file_size), 0) AS total_size
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE a.expired = false
         GROUP BY m.author_id`,
      ),
      prisma.$queryRawUnsafe<Array<{ entity_id: string; file_count: bigint; total_size: bigint }>>(
        `SELECT c.server_id AS entity_id, COUNT(a.id) AS file_count, COALESCE(SUM(a.file_size), 0) AS total_size
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE a.expired = false
         GROUP BY c.server_id`,
      ),
    ]);

    const userAttachmentMap = new Map<string, { fileCount: number; totalSize: number }>(
      userRows.map((r) => [r.entity_id, { fileCount: Number(r.file_count), totalSize: Number(r.total_size) }]),
    );
    const serverAttachmentMap = new Map<string, { fileCount: number; totalSize: number }>(
      serverRows.map((r) => [r.entity_id, { fileCount: Number(r.file_count), totalSize: Number(r.total_size) }]),
    );

    // ── 3. Merge S3 + attachment data ──
    const mergedUsers = new Map<string, { fileCount: number; totalSize: number }>();
    const mergedServers = new Map<string, { fileCount: number; totalSize: number }>();

    // S3 avatars → users, S3 server-icons → servers
    for (const [entityId, info] of s3EntityMap) {
      const target = info.type === 'user' ? mergedUsers : mergedServers;
      const existing = target.get(entityId);
      if (existing) {
        existing.fileCount += info.fileCount;
        existing.totalSize += info.totalSize;
      } else {
        target.set(entityId, { fileCount: info.fileCount, totalSize: info.totalSize });
      }
    }

    // Attachment data → users
    for (const [userId, info] of userAttachmentMap) {
      const existing = mergedUsers.get(userId);
      if (existing) {
        existing.fileCount += info.fileCount;
        existing.totalSize += info.totalSize;
      } else {
        mergedUsers.set(userId, { fileCount: info.fileCount, totalSize: info.totalSize });
      }
    }

    // Attachment data → servers
    for (const [serverId, info] of serverAttachmentMap) {
      const existing = mergedServers.get(serverId);
      if (existing) {
        existing.fileCount += info.fileCount;
        existing.totalSize += info.totalSize;
      } else {
        mergedServers.set(serverId, { fileCount: info.fileCount, totalSize: info.totalSize });
      }
    }

    // ── 4. Rank first, then resolve names for ONLY the top 10 ──
    // (the old code looked up names for every uploader in the instance)
    const unnamed: Array<Omit<StorageTopUploader, 'entityName'>> = [];
    for (const [entityId, info] of mergedUsers) {
      unnamed.push({ entityId, type: 'user', fileCount: info.fileCount, totalSize: info.totalSize });
    }
    for (const [entityId, info] of mergedServers) {
      unnamed.push({ entityId, type: 'server', fileCount: info.fileCount, totalSize: info.totalSize });
    }
    unnamed.sort((a, b) => b.totalSize - a.totalSize);
    const top = unnamed.slice(0, 10);

    const topUserIds = top.filter((e) => e.type === 'user').map((e) => e.entityId);
    const topServerIds = top.filter((e) => e.type === 'server').map((e) => e.entityId);
    const [users, servers] = await Promise.all([
      topUserIds.length > 0
        ? prisma.user.findMany({ where: { id: { in: topUserIds } }, select: { id: true, username: true } })
        : [],
      topServerIds.length > 0
        ? prisma.server.findMany({ where: { id: { in: topServerIds } }, select: { id: true, name: true } })
        : [],
    ]);
    const nameMap = new Map<string, string>();
    for (const u of users) nameMap.set(u.id, u.username);
    for (const s of servers) nameMap.set(s.id, s.name);

    const data: StorageTopUploader[] = top.map((e) => ({
      ...e,
      entityName: nameMap.get(e.entityId) ?? 'Deleted',
    }));
    topUploadersCache = { data, expiresAt: Date.now() + TOP_UPLOADERS_TTL_MS };

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/storage/files', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const filter = (req.query.filter as string) || 'all';

    const prefix = filter === 'avatars' ? 'avatars/'
      : filter === 'server-icons' ? 'server-icons/'
      : filter === 'attachments' ? 'attachments/'
      : undefined;
    const objects = await listAllS3Objects(prefix);

    const [usersWithAvatar, serversWithIcon, attachmentRecords] = await Promise.all([
      prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { id: true, username: true, avatarUrl: true } }),
      prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { id: true, name: true, iconUrl: true } }),
      prisma.messageAttachment.findMany({ select: { s3Key: true, fileName: true, messageId: true, expired: true } }),
    ]);

    const keyToUser = new Map<string, { id: string; name: string }>();
    for (const u of usersWithAvatar) if (u.avatarUrl) keyToUser.set(u.avatarUrl, { id: u.id, name: u.username });
    const keyToServer = new Map<string, { id: string; name: string }>();
    for (const s of serversWithIcon) if (s.iconUrl) keyToServer.set(s.iconUrl, { id: s.id, name: s.name });
    const keyToAttachment = new Map<string, { id: string; name: string; expired: boolean }>();
    for (const a of attachmentRecords) keyToAttachment.set(a.s3Key, { id: a.messageId, name: a.fileName, expired: a.expired });

    let files: StorageFile[] = objects.map((obj) => {
      const type = classifyKey(obj.key);
      const userRef = keyToUser.get(obj.key);
      const serverRef = keyToServer.get(obj.key);
      const attachRef = keyToAttachment.get(obj.key);
      const linked = userRef ?? serverRef ?? (attachRef ? { id: attachRef.id, name: attachRef.name } : null);

      return {
        key: obj.key,
        type,
        size: obj.size,
        lastModified: obj.lastModified,
        linkedEntity: linked?.name ?? null,
        linkedEntityId: linked?.id ?? null,
        isOrphan: !linked,
        isExpired: attachRef?.expired ?? false,
      };
    });

    if (filter === 'orphaned') {
      files = files.filter((f) => f.isOrphan);
    }

    // Sort by lastModified desc (nulls last)
    files.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta;
    });

    const total = files.length;
    const paginated = files.slice((page - 1) * limit, page * limit);

    res.json({ success: true, data: paginated, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/storage/files/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pathSegments = req.params.path;
    const key = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments as string;
    if (!key || (!VALID_S3_KEY_RE.test(key) && !VALID_ATTACHMENT_KEY_RE.test(key))) {
      throw new BadRequestError('Invalid file key');
    }

    // Nullify or expire DB reference
    if (key.startsWith('avatars/')) {
      await prisma.user.updateMany({ where: { avatarUrl: key }, data: { avatarUrl: null } });
    } else if (key.startsWith('server-icons/')) {
      await prisma.server.updateMany({ where: { iconUrl: key }, data: { iconUrl: null } });
    } else if (key.startsWith('attachments/')) {
      await prisma.messageAttachment.updateMany({ where: { s3Key: key }, data: { expired: true } });
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
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
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

// ─── Rate Limit Controls ─────────────────────────────────────────────────────

adminRouter.get('/rate-limits', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getAllRateLimits } = await import('../middleware/rateLimiter');
    res.json({ success: true, data: getAllRateLimits() });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/rate-limits/clear-user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new BadRequestError('Provide a user ID or IP address');
    }

    const { clearUserRateLimits } = await import('../middleware/rateLimiter');
    const cleared = await clearUserRateLimits(key.trim());

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'ratelimit.clear_user',
      targetType: 'rate_limit',
      targetId: key.trim(),
      metadata: { keysCleared: cleared },
    });

    res.json({ success: true, data: { cleared }, message: `Cleared ${cleared} rate limit key(s)` });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/rate-limits/:name', async (req: Request<{ name: string }>, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const { points, duration, blockDuration } = req.body;

    if (points === undefined && duration === undefined && blockDuration === undefined) {
      throw new BadRequestError('Provide at least one of: points, duration, blockDuration');
    }

    const { updateRateLimit } = await import('../middleware/rateLimiter');
    await updateRateLimit(name, { points, duration, blockDuration });

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'ratelimit.update',
      targetType: 'rate_limit',
      targetId: name,
      metadata: { points, duration, blockDuration },
    });

    res.json({ success: true, message: `Rate limit "${name}" updated` });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/rate-limits/:name/reset', async (req: Request<{ name: string }>, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const { resetRateLimit } = await import('../middleware/rateLimiter');
    await resetRateLimit(name);

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'ratelimit.reset',
      targetType: 'rate_limit',
      targetId: name,
    });

    res.json({ success: true, message: `Rate limit "${name}" reset to default` });
  } catch (err) {
    next(err);
  }
});

// ─── Feature Flags ──────────────────────────────────────────────────────────

adminRouter.get('/feature-flags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getAllFeatureFlags } = await import('../utils/featureFlags');
    res.json({ success: true, data: getAllFeatureFlags() });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/feature-flags/:name', async (req: Request<{ name: string }>, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      throw new BadRequestError('Provide a boolean "enabled" value');
    }

    const { updateFeatureFlag } = await import('../utils/featureFlags');
    await updateFeatureFlag(name, enabled);

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'feature_flag.update',
      targetType: 'feature_flag',
      targetId: name,
      metadata: { enabled },
    });

    res.json({ success: true, message: `Feature "${name}" ${enabled ? 'enabled' : 'disabled'}` });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/feature-flags/:name/reset', async (req: Request<{ name: string }>, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const { resetFeatureFlag } = await import('../utils/featureFlags');
    await resetFeatureFlag(name);

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'feature_flag.reset',
      targetType: 'feature_flag',
      targetId: name,
    });

    res.json({ success: true, message: `Feature "${name}" reset to default` });
  } catch (err) {
    next(err);
  }
});

// ─── Data Export ─────────────────────────────────────────────────────────────

// Exports read whole tables. Fetching them as one statement pins Postgres and
// can exceed statement timeouts at scale (MED-12) — page through with a stable
// id cursor in fixed-size batches instead. The response still contains the
// full dataset (that's what an export is), but each query stays bounded.
const EXPORT_BATCH_SIZE = 1000;

async function collectInBatches<T extends { id: string }>(
  fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor, EXPORT_BATCH_SIZE);
    all.push(...page);
    if (page.length < EXPORT_BATCH_SIZE) return all;
    cursor = page[page.length - 1].id;
  }
}

adminRouter.get('/export/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await collectInBatches((cursor, take) => prisma.user.findMany({
      select: {
        id: true, username: true, displayName: true, email: true, avatarUrl: true,
        role: true, status: true, isSupporter: true, supporterTier: true, bannedAt: true, banReason: true, createdAt: true,
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }));
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/export/servers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const servers = await collectInBatches((cursor, take) => prisma.server.findMany({
      select: {
        id: true, name: true, iconUrl: true, ownerId: true, createdAt: true,
        owner: { select: { username: true } },
        _count: { select: { members: true, channels: true } },
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }));

    // Per-server message counts in ONE grouped query. The old code grouped ALL
    // messages by channel and fetched every channel row to remap channel → server.
    const messageCountRows = await prisma.$queryRawUnsafe<Array<{ server_id: string; message_count: bigint }>>(
      `SELECT c.server_id, COUNT(m.id) AS message_count
       FROM channels c
       JOIN messages m ON m.channel_id = c.id
       GROUP BY c.server_id`,
    );
    const serverMessageCounts = new Map(messageCountRows.map((r) => [r.server_id, Number(r.message_count)]));

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
    const bans = await collectInBatches((cursor, take) => prisma.user.findMany({
      where: { bannedAt: { not: null } },
      select: { id: true, username: true, displayName: true, email: true, bannedAt: true, banReason: true },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }));
    res.json({ success: true, data: bans });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/export/ip-bans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ipBans = await collectInBatches((cursor, take) => prisma.ipBan.findMany({
      select: { id: true, ip: true, reason: true, bannedBy: true, createdAt: true, creator: { select: { username: true } } },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }));

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

// ─── Announcements ──────────────────────────────────────────────────────────

interface AnnouncementRow {
  id: string;
  title: string;
  content: string;
  type: string;
  scope: string;
  serverIds: string[];
  createdById: string;
  createdBy?: { username: string };
  publishedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

function mapAnnouncement(a: AnnouncementRow): Announcement {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    type: a.type as AnnouncementType,
    scope: a.scope as AnnouncementScope,
    serverIds: a.serverIds,
    createdById: a.createdById,
    createdByUsername: a.createdBy?.username ?? 'Deleted',
    publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}

function broadcastAnnouncement(announcement: Announcement) {
  const io = getIO();
  if (announcement.scope === 'global') {
    io.emit(WS_EVENTS.ANNOUNCEMENT_NEW, announcement);
  } else {
    for (const serverId of announcement.serverIds) {
      io.to(`server:${serverId}`).emit(WS_EVENTS.ANNOUNCEMENT_NEW, announcement);
    }
  }
}

adminRouter.get('/announcements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const filter = (req.query.filter as string) || 'all';

    const now = new Date();
    const where: Record<string, unknown> = {};

    if (filter === 'active') {
      where.publishedAt = { not: null };
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
    } else if (filter === 'draft') {
      where.publishedAt = null;
    } else if (filter === 'expired') {
      where.publishedAt = { not: null };
      where.expiresAt = { lte: now };
    }

    const [announcements, total] = await Promise.all([
      prisma.announcement.findMany({
        where,
        include: { createdBy: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.announcement.count({ where }),
    ]);

    const data = announcements.map(mapAnnouncement);

    res.json({ success: true, data, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/announcements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, content, type, scope, serverIds, expiresAt, publish } = req.body;

    // Validate
    if (!title || typeof title !== 'string') throw new BadRequestError('Title is required');
    const sanitizedTitle = sanitizeText(title);
    if (sanitizedTitle.length < LIMITS.ANNOUNCEMENT_TITLE_MIN || sanitizedTitle.length > LIMITS.ANNOUNCEMENT_TITLE_MAX) {
      throw new BadRequestError(`Title must be ${LIMITS.ANNOUNCEMENT_TITLE_MIN}-${LIMITS.ANNOUNCEMENT_TITLE_MAX} characters`);
    }

    if (!content || typeof content !== 'string') throw new BadRequestError('Content is required');
    const sanitizedContent = sanitizeText(content);
    if (sanitizedContent.length < 1 || sanitizedContent.length > LIMITS.ANNOUNCEMENT_CONTENT_MAX) {
      throw new BadRequestError(`Content must be 1-${LIMITS.ANNOUNCEMENT_CONTENT_MAX} characters`);
    }

    const validTypes = ['info', 'warning', 'maintenance'];
    if (type && !validTypes.includes(type)) throw new BadRequestError('Type must be info, warning, or maintenance');

    const validScopes = ['global', 'servers'];
    if (scope && !validScopes.includes(scope)) throw new BadRequestError('Scope must be global or servers');

    const annScope = scope || 'global';
    let annServerIds: string[] = [];

    if (annScope === 'servers') {
      if (!Array.isArray(serverIds) || serverIds.length === 0) {
        throw new BadRequestError('serverIds required when scope is "servers"');
      }
      const existingServers = await prisma.server.findMany({
        where: { id: { in: serverIds } },
        select: { id: true },
      });
      if (existingServers.length !== serverIds.length) {
        throw new BadRequestError('One or more server IDs are invalid');
      }
      annServerIds = serverIds;
    }

    let parsedExpiry: Date | undefined;
    if (expiresAt) {
      parsedExpiry = new Date(expiresAt);
      if (isNaN(parsedExpiry.getTime()) || parsedExpiry <= new Date()) {
        throw new BadRequestError('expiresAt must be a valid future date');
      }
    }

    const announcement = await prisma.announcement.create({
      data: {
        title: sanitizedTitle,
        content: sanitizedContent,
        type: type || 'info',
        scope: annScope,
        serverIds: annServerIds,
        createdById: req.user!.userId,
        publishedAt: publish ? new Date() : undefined,
        expiresAt: parsedExpiry,
      },
      include: { createdBy: { select: { username: true } } },
    });

    const mapped = mapAnnouncement(announcement);

    if (publish) {
      broadcastAnnouncement(mapped);
      logAuditEvent({
        actorId: req.user!.userId,
        action: 'announcement.publish',
        targetType: 'announcement',
        targetId: announcement.id,
        metadata: { title: sanitizedTitle, scope: annScope },
      });
    } else {
      logAuditEvent({
        actorId: req.user!.userId,
        action: 'announcement.create',
        targetType: 'announcement',
        targetId: announcement.id,
        metadata: { title: sanitizedTitle, scope: annScope },
      });
    }

    res.status(201).json({ success: true, data: mapped });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/announcements/:id/publish', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const announcement = await prisma.announcement.findUnique({
      where: { id: req.params.id },
      include: { createdBy: { select: { username: true } } },
    });
    if (!announcement) throw new NotFoundError('Announcement');
    if (announcement.publishedAt) throw new BadRequestError('Announcement is already published');

    const updated = await prisma.announcement.update({
      where: { id: req.params.id },
      data: { publishedAt: new Date() },
      include: { createdBy: { select: { username: true } } },
    });

    const mapped = mapAnnouncement(updated);
    broadcastAnnouncement(mapped);

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'announcement.publish',
      targetType: 'announcement',
      targetId: announcement.id,
      metadata: { title: announcement.title, scope: announcement.scope },
    });

    res.json({ success: true, data: mapped });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/announcements/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!announcement) throw new NotFoundError('Announcement');

    await prisma.announcement.delete({ where: { id: req.params.id } });

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'announcement.delete',
      targetType: 'announcement',
      targetId: announcement.id,
      metadata: { title: announcement.title },
    });

    res.json({ success: true, message: 'Announcement deleted' });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/storage/cleanup-orphans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [objects, usersWithAvatar, serversWithIcon, attachmentKeys] = await Promise.all([
      listAllS3Objects(),
      prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
      prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { iconUrl: true } }),
      prisma.messageAttachment.findMany({ where: { expired: false }, select: { s3Key: true } }),
    ]);

    const referencedKeys = new Set<string>();
    for (const u of usersWithAvatar) if (u.avatarUrl) referencedKeys.add(u.avatarUrl);
    for (const s of serversWithIcon) if (s.iconUrl) referencedKeys.add(s.iconUrl);
    for (const a of attachmentKeys) referencedKeys.add(a.s3Key);

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

// ─── Reports / Moderation Queue ──────────────────────────────────────────────

adminRouter.get('/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const filter = (req.query.filter as string) || 'all';

    const where: Record<string, unknown> = {};
    if (filter === 'pending' || filter === 'resolved' || filter === 'dismissed') {
      where.status = filter;
    }

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        include: {
          reporter: { select: { id: true, username: true } },
          reportedUser: { select: { id: true, username: true } },
          resolvedBy: { select: { id: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.report.count({ where }),
    ]);

    const data = reports.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      reason: r.reason,
      reporterId: r.reporterId,
      reporterUsername: r.reporter.username,
      reportedUserId: r.reportedUserId,
      reportedUsername: r.reportedUser.username,
      messageId: r.messageId,
      messageContent: r.messageContent,
      contentSource: r.contentSource,
      channelId: r.channelId,
      conversationId: r.conversationId,
      serverId: r.serverId,
      resolvedById: r.resolvedById,
      resolvedByUsername: r.resolvedBy?.username ?? null,
      resolution: r.resolution,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    }));

    res.json({ success: true, data, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/reports/:id/resolve', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { resolution, action, deleteMessage } = req.body;

    const report = await prisma.report.findUnique({ where: { id } });
    if (!report) throw new NotFoundError('Report');
    if (report.status !== 'pending') throw new BadRequestError('Report is already processed');

    const sanitizedResolution = resolution ? sanitizeText(resolution) : 'Resolved';

    // Pre-validate the optional ban action BEFORE mutating anything, applying the
    // same self/hierarchy rules as the canonical POST /users/:userId/ban route.
    // Throwing here (rather than silently skipping) means a disallowed ban leaves
    // the report untouched and gives the admin explicit feedback.
    let banTarget: { id: string; role: string } | null = null;
    if (action === 'ban') {
      if (report.reportedUserId === req.user!.userId) throw new ForbiddenError('Cannot ban yourself');
      banTarget = await prisma.user.findUnique({
        where: { id: report.reportedUserId },
        select: { id: true, role: true },
      });
      if (banTarget) {
        if (banTarget.role === 'superadmin') throw new ForbiddenError('Cannot ban a super admin');
        if (banTarget.role === 'admin' && req.user!.role !== 'superadmin') throw new ForbiddenError('Only super admins can ban other admins');
      }
    }

    await prisma.report.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedById: req.user!.userId,
        resolvedAt: new Date(),
        resolution: sanitizedResolution,
      },
    });

    // Optional action: delete the reported message
    if (deleteMessage && report.messageId) {
      const message = await prisma.message.findUnique({ where: { id: report.messageId }, select: { id: true, channelId: true, conversationId: true } });
      if (message) {
        await prisma.message.delete({ where: { id: message.id } });
        const io = getIO();
        if (message.channelId) {
          io.to(`channel:${message.channelId}`).emit(WS_EVENTS.MESSAGE_DELETE, { messageId: message.id, channelId: message.channelId });
        } else if (message.conversationId) {
          io.to(`dm:${message.conversationId}`).emit(WS_EVENTS.DM_MESSAGE_DELETE, { messageId: message.id, conversationId: message.conversationId });
        }
      }
    }

    // Optional action: ban the reported user (validated above)
    if (banTarget) {
      await prisma.user.update({
        where: { id: banTarget.id },
        data: { bannedAt: new Date(), banReason: `Report resolved: ${sanitizedResolution}`, tokenVersion: { increment: 1 } },
      });

      // Remove the banned user from all server member lists/rooms — same as the
      // canonical ban route. Without this the banned user lingers in member lists.
      const memberships = await prisma.serverMember.findMany({
        where: { userId: banTarget.id },
        select: { serverId: true },
      });
      for (const { serverId } of memberships) {
        await broadcastMemberLeft(banTarget.id, serverId);
      }

      // Force logout then disconnect active sockets (works across all nodes)
      await forceLogoutUser(banTarget.id, 'Your account has been banned');

      logAuditEvent({
        actorId: req.user!.userId,
        action: 'user.ban',
        targetType: 'user',
        targetId: banTarget.id,
        metadata: { reason: `Report resolved: ${sanitizedResolution}` },
      });
    }

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'report.resolve',
      targetType: 'report',
      targetId: id,
      metadata: { resolution: sanitizedResolution, action: action ?? null, messageDeleted: !!(deleteMessage && report.messageId) },
    });

    const pendingCount = await prisma.report.count({ where: { status: 'pending' } });
    getIO().to('admin:reports').emit('report:new', { total: pendingCount });

    res.json({ success: true, message: 'Report resolved' });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/reports/:id/dismiss', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const report = await prisma.report.findUnique({ where: { id } });
    if (!report) throw new NotFoundError('Report');
    if (report.status !== 'pending') throw new BadRequestError('Report is already processed');

    await prisma.report.update({
      where: { id },
      data: {
        status: 'dismissed',
        resolvedById: req.user!.userId,
        resolvedAt: new Date(),
      },
    });

    logAuditEvent({
      actorId: req.user!.userId,
      action: 'report.dismiss',
      targetType: 'report',
      targetId: id,
    });

    const pendingCount = await prisma.report.count({ where: { status: 'pending' } });
    getIO().to('admin:reports').emit('report:new', { total: pendingCount });

    res.json({ success: true, message: 'Report dismissed' });
  } catch (err) {
    next(err);
  }
});

// ─── Support Tickets ────────────────────────────────────────────────────────

const supportAuthorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
};

interface SupportMessageRow {
  id: string;
  ticketId: string;
  authorId: string;
  content: string;
  type: string;
  createdAt: Date;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    isSupporter: boolean;
    supporterTier: string | null;
  };
}

function mapSupportMessage(m: SupportMessageRow): SupportMessageData {
  return {
    id: m.id,
    ticketId: m.ticketId,
    authorId: m.authorId,
    content: m.content,
    type: m.type as SupportMessageData['type'],
    createdAt: m.createdAt.toISOString(),
    author: { ...m.author, role: m.author.role as SupportMessageData['author']['role'] },
  };
}

async function emitSupportTicketCount() {
  const total = await prisma.supportTicket.count({ where: { status: { in: ['open', 'claimed'] } } });
  getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_TICKET_NEW, { total });
}

adminRouter.get('/support/tickets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const status = (req.query.status as string) || 'all';

    const where: Record<string, unknown> = {};
    if (status === 'open' || status === 'claimed' || status === 'closed') {
      where.status = status;
    }

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          claimedBy: { select: { id: true, username: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { content: true, createdAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.supportTicket.count({ where }),
    ]);

    const data = tickets.map((t) => ({
      id: t.id,
      userId: t.userId,
      username: t.user.username,
      displayName: t.user.displayName,
      avatarUrl: t.user.avatarUrl,
      status: t.status,
      claimedById: t.claimedById,
      claimedByUsername: t.claimedBy?.username ?? null,
      lastMessage: t.messages[0]?.content ?? null,
      lastMessageAt: t.messages[0]?.createdAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));

    res.json({ success: true, data, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/support/tickets/:id/claim', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const adminUserId = req.user!.userId;

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundError('Ticket');
    if (ticket.status === 'closed') throw new BadRequestError('Ticket is closed');

    const updated = await prisma.supportTicket.update({
      where: { id },
      data: { status: 'claimed', claimedById: adminUserId, claimedAt: new Date() },
    });

    const adminUser = await prisma.user.findUnique({ where: { id: adminUserId }, select: { username: true } });

    // System message
    const sysMsg = await prisma.supportMessage.create({
      data: { ticketId: id, authorId: adminUserId, content: `Staff member ${adminUser?.username} has joined the conversation`, type: 'system' },
      include: { author: supportAuthorSelect },
    });

    // Join admin socket to support room BEFORE emitting events
    const io = getIO();
    io.in(`user:${adminUserId}`).socketsJoin(`support:${id}`);

    const claimPayload = mapSupportMessage(sysMsg);
    io.to(`support:${id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, claimPayload);
    io.to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, claimPayload);
    const statusPayload = { ticketId: id, status: 'claimed' as const, claimedById: adminUserId, claimedByUsername: adminUser?.username };
    io.to(`support:${id}`).emit(WS_EVENTS.SUPPORT_STATUS_CHANGE, statusPayload);
    io.to('admin:support').emit(WS_EVENTS.SUPPORT_STATUS_CHANGE, statusPayload);

    await emitSupportTicketCount();

    logAuditEvent({
      actorId: adminUserId,
      action: 'support.claim',
      targetType: 'support_ticket',
      targetId: id,
      metadata: { userId: ticket.userId },
    });

    res.json({ success: true, data: { id: updated.id, status: updated.status } });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/support/tickets/:id/messages', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const before = req.query.before as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundError('Ticket');

    // Join admin socket to the ticket room so they receive real-time messages
    const adminUserId = req.user!.userId;
    getIO().in(`user:${adminUserId}`).socketsJoin(`support:${id}`);

    const where: Record<string, unknown> = { ticketId: id };
    if (before) {
      const beforeDate = new Date(before);
      if (isNaN(beforeDate.getTime())) throw new BadRequestError('Invalid before date');
      where.createdAt = { lt: beforeDate };
    }

    const messages = await prisma.supportMessage.findMany({
      where,
      include: { author: supportAuthorSelect },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    res.json({
      success: true,
      data: messages.reverse().map(mapSupportMessage),
      hasMore,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/support/tickets/:id/messages', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const adminUserId = req.user!.userId;

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundError('Ticket');
    if (ticket.status === 'closed') throw new BadRequestError('Ticket is closed');

    // Auto-claim if open
    if (ticket.status === 'open') {
      await prisma.supportTicket.update({
        where: { id },
        data: { status: 'claimed', claimedById: adminUserId, claimedAt: new Date() },
      });

      const adminUser = await prisma.user.findUnique({ where: { id: adminUserId }, select: { username: true } });
      const claimMsg = await prisma.supportMessage.create({
        data: { ticketId: id, authorId: adminUserId, content: `Staff member ${adminUser?.username} has joined the conversation`, type: 'system' },
        include: { author: supportAuthorSelect },
      });
      const io = getIO();
      const autoClaimPayload = mapSupportMessage(claimMsg);
      io.to(`support:${id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, autoClaimPayload);
      io.to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, autoClaimPayload);
      const autoStatusPayload = { ticketId: id, status: 'claimed' as const, claimedById: adminUserId, claimedByUsername: adminUser?.username };
      io.to(`support:${id}`).emit(WS_EVENTS.SUPPORT_STATUS_CHANGE, autoStatusPayload);
      io.to('admin:support').emit(WS_EVENTS.SUPPORT_STATUS_CHANGE, autoStatusPayload);

      logAuditEvent({
        actorId: adminUserId,
        action: 'support.claim',
        targetType: 'support_ticket',
        targetId: id,
        metadata: { userId: ticket.userId },
      });
    }

    const content = sanitizeText(req.body.content ?? '');
    if (content.length < LIMITS.SUPPORT_MESSAGE_MIN || content.length > LIMITS.SUPPORT_MESSAGE_MAX) {
      throw new BadRequestError(`Message must be ${LIMITS.SUPPORT_MESSAGE_MIN}-${LIMITS.SUPPORT_MESSAGE_MAX} characters`);
    }

    const message = await prisma.supportMessage.create({
      data: { ticketId: id, authorId: adminUserId, content },
      include: { author: supportAuthorSelect },
    });

    await prisma.supportTicket.update({ where: { id }, data: { updatedAt: new Date() } });

    const payload = mapSupportMessage(message);
    getIO().to(`support:${id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, payload);
    getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, payload);
    await emitSupportTicketCount();

    res.status(201).json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/support/tickets/:id/close', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const adminUserId = req.user!.userId;

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundError('Ticket');
    if (ticket.status === 'closed') throw new BadRequestError('Ticket is already closed');

    await prisma.supportTicket.update({
      where: { id },
      data: { status: 'closed', closedAt: new Date() },
    });

    const adminUser = await prisma.user.findUnique({ where: { id: adminUserId }, select: { username: true } });

    const sysMsg = await prisma.supportMessage.create({
      data: { ticketId: id, authorId: adminUserId, content: `Ticket closed by ${adminUser?.username}`, type: 'system' },
      include: { author: supportAuthorSelect },
    });

    const io = getIO();
    const closePayload = mapSupportMessage(sysMsg);
    io.to(`support:${id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, closePayload);
    io.to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW, closePayload);
    const closeStatusPayload = { ticketId: id, status: 'closed' as const };
    io.to(`support:${id}`).emit(WS_EVENTS.SUPPORT_STATUS_CHANGE, closeStatusPayload);
    io.to('admin:support').emit(WS_EVENTS.SUPPORT_STATUS_CHANGE, closeStatusPayload);

    await emitSupportTicketCount();

    logAuditEvent({
      actorId: adminUserId,
      action: 'support.close',
      targetType: 'support_ticket',
      targetId: id,
      metadata: { userId: ticket.userId },
    });

    res.json({ success: true, message: 'Ticket closed' });
  } catch (err) {
    next(err);
  }
});
