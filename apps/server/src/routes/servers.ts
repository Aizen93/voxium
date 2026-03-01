import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateServerName, LIMITS, WS_EVENTS } from '@voxium/shared';
import type { MemberRole } from '@voxium/shared';
import { broadcastMemberJoined, broadcastMemberLeft, joinServerRoom } from '../utils/memberBroadcast';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import { rateLimitMemberManage } from '../middleware/rateLimiter';
import { VALID_S3_KEY_RE, deleteFromS3 } from '../utils/s3';
import { outranks, isAdminOrOwner } from '../utils/permissions';
import { leaveCurrentVoiceChannel, cleanupServerVoice } from '../websocket/voiceHandler';

export const serverRouter = Router();

serverRouter.use(authenticate);

// List servers the user is a member of
serverRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const memberships = await prisma.serverMember.findMany({
      where: { userId: req.user!.userId },
      include: {
        server: {
          select: { id: true, name: true, iconUrl: true, ownerId: true, createdAt: true },
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
        _count: { select: { members: true } },
      },
    });

    if (!server) throw new NotFoundError('Server');

    res.json({
      success: true,
      data: { ...server, memberCount: server._count.members },
    });
  } catch (err) {
    next(err);
  }
});

// Get server members
serverRouter.get('/:serverId/members', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, LIMITS.MEMBERS_PER_PAGE);

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const [members, total] = await Promise.all([
      prisma.serverMember.findMany({
        where: { serverId },
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, status: true, createdAt: true },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { joinedAt: 'asc' },
      }),
      prisma.serverMember.count({ where: { serverId } }),
    ]);

    res.json({
      success: true,
      data: members,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
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
    if (server.ownerId !== req.user!.userId) throw new ForbiddenError('Only the server owner can update settings');

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
      select: { id: true, name: true, iconUrl: true, ownerId: true, createdAt: true },
      data: updateData,
    });

    // Delete old icon from S3 after DB update confirmed
    if (updateData.iconUrl !== undefined && oldIconUrl && oldIconUrl !== updateData.iconUrl) {
      deleteFromS3(oldIconUrl).catch(() => {});
    }

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED as any, updated);

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
    cleanupServerVoice(io as any, serverId);

    // 2. Notify all members before removing them from rooms
    io.to(`server:${serverId}`).emit(WS_EVENTS.SERVER_DELETED as any, { serverId });

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
      deleteFromS3(server.iconUrl).catch(() => {});
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

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED as any, {
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

      const actorMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!actorMembership) throw new NotFoundError('Server');
      if (!isAdminOrOwner(actorMembership.role as MemberRole)) throw new ForbiddenError('Only admins and the owner can kick members');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Member');
      if (!outranks(actorMembership.role as MemberRole, targetMembership.role as MemberRole)) {
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
            leaveCurrentVoiceChannel(io as any, s as any, memberId);
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
          s.emit(WS_EVENTS.MEMBER_KICKED as any, { serverId, userId: memberId });
        }
      }

      res.json({ success: true, message: 'Member kicked' });
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

      if (!targetUserId) throw new BadRequestError('targetUserId is required');
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
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED as any, {
        serverId,
        userId: targetUserId,
        role: 'owner' as MemberRole,
      });
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED as any, {
        serverId,
        userId: req.user!.userId,
        role: 'admin' as MemberRole,
      });

      // Emit server:updated with new ownerId
      const updatedServer = await prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, name: true, iconUrl: true, ownerId: true, createdAt: true },
      });
      if (updatedServer) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED as any, updatedServer);
      }

      res.json({ success: true, message: 'Ownership transferred' });
    } catch (err) {
      next(err);
    }
  }
);
