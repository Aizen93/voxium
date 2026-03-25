import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateServerName, validateNickname, LIMITS, WS_EVENTS, DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@voxium/shared';
import type { MemberRole, Server } from '@voxium/shared';
import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@voxium/shared';
import { broadcastMemberJoined, broadcastMemberLeft, joinServerRoom } from '../utils/memberBroadcast';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import { rateLimitMemberManage, rateLimitSearch } from '../middleware/rateLimiter';
import { VALID_S3_KEY_RE, deleteFromS3 } from '../utils/s3';
import { hasServerPermission, getHighestRolePosition, filterVisibleChannels } from '../utils/permissionCalculator';
import { Permissions } from '@voxium/shared';
import { leaveCurrentVoiceChannel, cleanupServerVoice } from '../websocket/voiceHandler';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getEffectiveLimits } from '../utils/serverLimits';

export const serverRouter = Router();

serverRouter.use(authenticate, requireVerifiedEmail);

// List servers the user is a member of
serverRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const memberships = await prisma.serverMember.findMany({
      where: { userId: req.user!.userId },
      include: {
        server: {
          select: { id: true, name: true, iconUrl: true, invitesLocked: true, ownerId: true, createdAt: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    res.json({
      success: true,
      data: memberships.map((m) => m.server),
    });
  } catch (err) {
    next(err);
  }
});

// Create a new server
serverRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('server_creation')) throw new ForbiddenError('Server creation is currently disabled');
    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateServerName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    const ownedServerCount = await prisma.server.count({
      where: { ownerId: req.user!.userId },
    });
    if (ownedServerCount >= LIMITS.MAX_SERVERS_PER_USER) {
      throw new BadRequestError(`You can only create up to ${LIMITS.MAX_SERVERS_PER_USER} servers`);
    }

    const server = await prisma.$transaction(async (tx) => {
      // Create server with member
      const srv = await tx.server.create({
        data: {
          name,
          ownerId: req.user!.userId,
          members: {
            create: { userId: req.user!.userId, role: 'owner' },
          },
        },
      });

      // Create default categories
      const textCategory = await tx.category.create({
        data: { name: 'Text Channels', serverId: srv.id, position: 0 },
      });
      const voiceCategory = await tx.category.create({
        data: { name: 'Voice Channels', serverId: srv.id, position: 1 },
      });

      // Create @everyone default role
      await tx.role.create({
        data: {
          serverId: srv.id,
          name: 'everyone',
          position: 0,
          permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
          isDefault: true,
        },
      });

      // Create default channels linked to categories
      await tx.channel.createMany({
        data: [
          { name: 'general', type: 'text', serverId: srv.id, categoryId: textCategory.id, position: 0 },
          { name: 'General', type: 'voice', serverId: srv.id, categoryId: voiceCategory.id, position: 1 },
        ],
      });

      // Fetch the full server with includes
      return tx.server.findUniqueOrThrow({
        where: { id: srv.id },
        include: {
          channels: { orderBy: { position: 'asc' } },
          categories: { orderBy: { position: 'asc' } },
          _count: { select: { members: true } },
        },
      });
    });

    // Add creator's socket to the new server room so server-scoped events work
    await joinServerRoom(req.user!.userId, server.id);

    // Seed ChannelRead for the default text channel so existing messages don't show as unread
    const generalChannel = server.channels.find((c) => c.type === 'text');
    if (generalChannel) {
      await prisma.channelRead.create({
        data: { userId: req.user!.userId, channelId: generalChannel.id, lastReadAt: new Date() },
      });
    }

    res.status(201).json({
      success: true,
      data: { ...server, memberCount: server._count.members },
    });
  } catch (err) {
    next(err);
  }
});

// Get server details
serverRouter.get('/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const server = await prisma.server.findUnique({
      where: { id: serverId },
      include: {
        channels: { orderBy: { position: 'asc' } },
        categories: { orderBy: { position: 'asc' } },
        roles: { orderBy: { position: 'asc' } },
        _count: { select: { members: true } },
      },
    });

    if (!server) throw new NotFoundError('Server');

    // Filter channels by VIEW_CHANNEL permission
    const visibleChannels = await filterVisibleChannels(req.user!.userId, serverId, server.channels);

    res.json({
      success: true,
      data: { ...server, channels: visibleChannels, memberCount: server._count.members },
    });
  } catch (err) {
    next(err);
  }
});

// Get server resource limits (read-only for members)
serverRouter.get('/:serverId/limits', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const limits = await getEffectiveLimits(serverId);
    res.json({ success: true, data: limits });
  } catch (err) {
    next(err);
  }
});

// Get server members
serverRouter.get('/:serverId/members', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, LIMITS.MEMBERS_PER_PAGE);

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const [members, total] = await Promise.all([
      prisma.serverMember.findMany({
        where: { serverId },
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, status: true, isSupporter: true, supporterTier: true, createdAt: true },
          },
          memberRoles: {
            include: { role: true },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { joinedAt: 'asc' },
      }),
      prisma.serverMember.count({ where: { serverId } }),
    ]);

    // Flatten memberRoles to roles array for the response
    const membersWithRoles = members.map((m) => ({
      ...m,
      roles: m.memberRoles.map((mr) => mr.role),
      memberRoles: undefined,
    }));

    res.json({
      success: true,
      data: membersWithRoles,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    next(err);
  }
});

// Search server members by username/displayName (for @mention autocomplete)
serverRouter.get('/:serverId/members/search', rateLimitSearch, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const q = (req.query.q as string || '').trim();
    if (!q || q.length > 100) {
      res.json({ success: true, data: [] });
      return;
    }

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const members = await prisma.serverMember.findMany({
      where: {
        serverId,
        user: {
          OR: [
            { username: { contains: q, mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
        },
      },
      take: 8,
      orderBy: { joinedAt: 'asc' },
    });

    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// Join a server (via invite code - simplified)
serverRouter.post('/:serverId/join', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');

    const existing = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (existing) throw new BadRequestError('Already a member of this server');

    await prisma.serverMember.create({
      data: { userId: req.user!.userId, serverId },
    });

    // Notify all members and add the joiner's socket(s) to the server room
    await broadcastMemberJoined(req.user!.userId, serverId);

    // Seed ChannelRead for all text channels so existing history doesn't show as unread
    const textChannels = await prisma.channel.findMany({
      where: { serverId, type: 'text' },
      select: { id: true },
    });
    if (textChannels.length > 0) {
      const now = new Date();
      await prisma.channelRead.createMany({
        data: textChannels.map((ch) => ({
          userId: req.user!.userId,
          channelId: ch.id,
          lastReadAt: now,
        })),
        skipDuplicates: true,
      });
    }

    res.json({ success: true, data: server });
  } catch (err) {
    next(err);
  }
});

// Leave a server
serverRouter.post('/:serverId/leave', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server membership');
    if (membership.role === 'owner') throw new ForbiddenError('Server owner cannot leave. Transfer ownership first.');

    // Clean up ChannelRead records for this server's channels
    const textChannelIds = await prisma.channel.findMany({
      where: { serverId, type: 'text' },
      select: { id: true },
    });
    if (textChannelIds.length > 0) {
      await prisma.channelRead.deleteMany({
        where: { userId: req.user!.userId, channelId: { in: textChannelIds.map((c) => c.id) } },
      });
    }

    await prisma.serverMember.delete({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });

    // Remove the leaver's socket(s) from the server room and notify remaining members
    await broadcastMemberLeft(req.user!.userId, serverId);

    res.json({ success: true, message: 'Left server' });
  } catch (err) {
    next(err);
  }
});

// Update server settings (owner only)
serverRouter.patch('/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');

    const canManageServer = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManageServer) throw new ForbiddenError('You do not have permission to manage server settings');

    const updateData: Record<string, unknown> = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string') throw new BadRequestError('name must be a string');
      const name = sanitizeText(req.body.name);
      const nameErr = validateServerName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      updateData.name = name;
    }

    if (req.body.iconUrl !== undefined) {
      const { iconUrl } = req.body;
      if (iconUrl !== null) {
        if (typeof iconUrl !== 'string' || !VALID_S3_KEY_RE.test(iconUrl)) {
          throw new BadRequestError('Invalid icon key');
        }
        if (!iconUrl.startsWith(`server-icons/${serverId}-`)) {
          throw new BadRequestError('Invalid icon key');
        }
      }
      updateData.iconUrl = iconUrl;
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestError('No fields to update');
    }

    const oldIconUrl = server.iconUrl;

    const updated = await prisma.server.update({
      where: { id: serverId },
      select: { id: true, name: true, iconUrl: true, invitesLocked: true, ownerId: true, createdAt: true },
      data: updateData,
    });

    // Delete old icon from S3 after DB update confirmed
    if (updateData.iconUrl !== undefined && oldIconUrl && oldIconUrl !== updateData.iconUrl) {
      deleteFromS3(oldIconUrl).catch((err) => console.warn('[S3] Failed to delete old asset:', err));
    }

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updated as unknown as Server);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Toggle invites lock (owner or admin)
serverRouter.patch('/:serverId/invites-lock', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const { locked } = req.body;

    if (typeof locked !== 'boolean') throw new BadRequestError('Provide a boolean "locked" value');

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');

    const canManageServer = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManageServer) throw new ForbiddenError('You do not have permission to manage server settings');

    const updated = await prisma.server.update({
      where: { id: serverId },
      select: { id: true, name: true, iconUrl: true, invitesLocked: true, ownerId: true, createdAt: true },
      data: { invitesLocked: locked },
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updated as unknown as Server);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a server (owner only)
serverRouter.delete('/:serverId', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');
    if (server.ownerId !== req.user!.userId) throw new ForbiddenError('Only the server owner can delete it');

    const io = getIO();

    // 1. Silently eject all users from voice channels (no voice:user_left events — clients handle via server:deleted)
    cleanupServerVoice(io, serverId);

    // 2. Notify all members before removing them from rooms
    io.to(`server:${serverId}`).emit(WS_EVENTS.SERVER_DELETED, { serverId });

    // 3. Remove all sockets from server room and channel rooms
    const channels = await prisma.channel.findMany({
      where: { serverId },
      select: { id: true },
    });

    const roomsToLeave = [`server:${serverId}`, ...channels.map((c) => `channel:${c.id}`)];
    for (const room of roomsToLeave) {
      const socketsInRoom = await io.in(room).fetchSockets();
      for (const s of socketsInRoom) {
        s.leave(room);
      }
    }

    // 4. Delete from DB (Prisma cascade handles channels, members, messages, reactions, reads, categories, invites)
    await prisma.server.delete({ where: { id: serverId } });

    // 5. Clean up S3 icon if exists
    if (server.iconUrl) {
      deleteFromS3(server.iconUrl).catch((err) => console.warn('[S3] Failed to delete old asset:', err));
    }

    res.json({ success: true, message: 'Server deleted' });
  } catch (err) {
    next(err);
  }
});

// Change member role (owner only)
serverRouter.patch(
  '/:serverId/members/:memberId/role',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;
      const { role: newRole } = req.body as { role: string };

      if (!newRole || (newRole !== 'admin' && newRole !== 'member')) {
        throw new BadRequestError('role must be "admin" or "member"');
      }

      const actorMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!actorMembership) throw new NotFoundError('Server');
      if (actorMembership.role !== 'owner') throw new ForbiddenError('Only the server owner can change roles');

      if (memberId === req.user!.userId) throw new BadRequestError('Cannot change your own role');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Member');
      if (targetMembership.role === 'owner') throw new ForbiddenError('Cannot change the owner\'s role');

      await prisma.serverMember.update({
        where: { userId_serverId: { userId: memberId, serverId } },
        data: { role: newRole },
      });

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: memberId,
        role: newRole as MemberRole,
      });

      res.json({ success: true, message: `Role updated to ${newRole}` });
    } catch (err) {
      next(err);
    }
  }
);

// Kick a member (owner or admin, must outrank target)
serverRouter.post(
  '/:serverId/members/:memberId/kick',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;

      if (memberId === req.user!.userId) throw new BadRequestError('Cannot kick yourself');

      const canKick = await hasServerPermission(req.user!.userId, serverId, Permissions.KICK_MEMBERS);
      if (!canKick) throw new ForbiddenError('You do not have permission to kick members');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Member');

      // Role hierarchy check: actor must outrank target
      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      const targetHighest = await getHighestRolePosition(memberId, serverId);
      if (actorHighest <= targetHighest) {
        throw new ForbiddenError('Cannot kick a member with an equal or higher role');
      }

      // Force-leave the kicked user from voice if they're in a voice channel on THIS server
      const io = getIO();
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        if (s.data.userId === memberId && s.data.voiceChannelId) {
          // Verify the voice channel belongs to the server the user is being kicked from
          const voiceChannel = await prisma.channel.findUnique({
            where: { id: s.data.voiceChannelId as string },
            select: { serverId: true },
          });
          if (voiceChannel?.serverId === serverId) {
            leaveCurrentVoiceChannel(io, s as unknown as Socket<ClientToServerEvents, ServerToClientEvents>, memberId);
          }
        }
      }

      // Clean up ChannelRead records for this server's channels
      const textChannelIds = await prisma.channel.findMany({
        where: { serverId, type: 'text' },
        select: { id: true },
      });
      if (textChannelIds.length > 0) {
        await prisma.channelRead.deleteMany({
          where: { userId: memberId, channelId: { in: textChannelIds.map((c) => c.id) } },
        });
      }

      await prisma.serverMember.delete({
        where: { userId_serverId: { userId: memberId, serverId } },
      });

      // Remove kicked user's socket from server room and notify remaining members
      await broadcastMemberLeft(memberId, serverId);

      // Emit member:kicked directly to the kicked user's sockets (they're already out of the server room)
      const kickedSockets = await io.fetchSockets();
      for (const s of kickedSockets) {
        if (s.data.userId === memberId) {
          s.emit(WS_EVENTS.MEMBER_KICKED, { serverId, userId: memberId });
        }
      }

      res.json({ success: true, message: 'Member kicked' });
    } catch (err) {
      next(err);
    }
  }
);

// Set own nickname (requires CHANGE_NICKNAME permission)
serverRouter.patch(
  '/:serverId/nickname',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const { nickname } = req.body as { nickname: string | null };

      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!membership) throw new NotFoundError('Server');

      // Setting to null (clearing) always allowed; setting a new nickname requires permission
      if (nickname !== null) {
        const canChange = await hasServerPermission(req.user!.userId, serverId, Permissions.CHANGE_NICKNAME);
        if (!canChange) throw new ForbiddenError('You do not have permission to change your nickname');

        if (typeof nickname !== 'string') throw new BadRequestError('nickname must be a string');
        const sanitized = sanitizeText(nickname);
        const err = validateNickname(sanitized);
        if (err) throw new BadRequestError(err);

        await prisma.serverMember.update({
          where: { userId_serverId: { userId: req.user!.userId, serverId } },
          data: { nickname: sanitized },
        });

        getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_NICKNAME_UPDATED, {
          serverId,
          userId: req.user!.userId,
          nickname: sanitized,
        });

        res.json({ success: true, data: { nickname: sanitized } });
      } else {
        await prisma.serverMember.update({
          where: { userId_serverId: { userId: req.user!.userId, serverId } },
          data: { nickname: null },
        });

        getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_NICKNAME_UPDATED, {
          serverId,
          userId: req.user!.userId,
          nickname: null,
        });

        res.json({ success: true, data: { nickname: null } });
      }
    } catch (err) {
      next(err);
    }
  }
);

// Set another member's nickname (requires MANAGE_NICKNAMES permission)
serverRouter.patch(
  '/:serverId/members/:memberId/nickname',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;
      const { nickname } = req.body as { nickname: string | null };

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_NICKNAMES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage nicknames');

      const targetMember = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMember) throw new NotFoundError('Member');

      // Hierarchy check: can't manage nicknames of users with equal/higher roles
      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      const targetHighest = await getHighestRolePosition(memberId, serverId);
      if (actorHighest <= targetHighest && actorHighest !== Infinity) {
        throw new ForbiddenError('Cannot manage the nickname of a member with an equal or higher role');
      }

      let sanitized: string | null = null;
      if (nickname !== null) {
        if (typeof nickname !== 'string') throw new BadRequestError('nickname must be a string');
        sanitized = sanitizeText(nickname);
        const err = validateNickname(sanitized);
        if (err) throw new BadRequestError(err);
      }

      await prisma.serverMember.update({
        where: { userId_serverId: { userId: memberId, serverId } },
        data: { nickname: sanitized },
      });

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_NICKNAME_UPDATED, {
        serverId,
        userId: memberId,
        nickname: sanitized,
      });

      res.json({ success: true, data: { nickname: sanitized } });
    } catch (err) {
      next(err);
    }
  }
);

// Transfer ownership (owner only)
serverRouter.post(
  '/:serverId/transfer-ownership',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const { targetUserId } = req.body as { targetUserId: string };

      if (!targetUserId || typeof targetUserId !== 'string') throw new BadRequestError('targetUserId is required');
      if (targetUserId === req.user!.userId) throw new BadRequestError('Cannot transfer ownership to yourself');

      const actorMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!actorMembership) throw new NotFoundError('Server');
      if (actorMembership.role !== 'owner') throw new ForbiddenError('Only the server owner can transfer ownership');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: targetUserId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Target member');

      await prisma.$transaction([
        prisma.server.update({ where: { id: serverId }, data: { ownerId: targetUserId } }),
        prisma.serverMember.update({
          where: { userId_serverId: { userId: targetUserId, serverId } },
          data: { role: 'owner' },
        }),
        prisma.serverMember.update({
          where: { userId_serverId: { userId: req.user!.userId, serverId } },
          data: { role: 'admin' },
        }),
      ]);

      const io = getIO();

      // Emit role updates for both users
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: targetUserId,
        role: 'owner' as MemberRole,
      });
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: req.user!.userId,
        role: 'admin' as MemberRole,
      });

      // Emit server:updated with new ownerId
      const updatedServer = await prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, name: true, iconUrl: true, invitesLocked: true, ownerId: true, createdAt: true },
      });
      if (updatedServer) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updatedServer as unknown as Server);
      }

      res.json({ success: true, message: 'Ownership transferred' });
    } catch (err) {
      next(err);
    }
  }
);
