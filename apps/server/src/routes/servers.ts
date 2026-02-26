import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateServerName, LIMITS, WS_EVENTS } from '@voxium/shared';
import { broadcastMemberJoined, broadcastMemberLeft, joinServerRoom } from '../utils/memberBroadcast';
import { getIO } from '../websocket/socketServer';

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
    const { name } = req.body;
    const nameErr = validateServerName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    const userServerCount = await prisma.serverMember.count({
      where: { userId: req.user!.userId },
    });
    if (userServerCount >= LIMITS.MAX_SERVERS_PER_USER) {
      throw new BadRequestError(`You can only be a member of ${LIMITS.MAX_SERVERS_PER_USER} servers`);
    }

    const server = await prisma.server.create({
      data: {
        name,
        ownerId: req.user!.userId,
        members: {
          create: { userId: req.user!.userId, role: 'owner' },
        },
        channels: {
          createMany: {
            data: [
              { name: 'general', type: 'text', position: 0 },
              { name: 'General', type: 'voice', position: 1 },
            ],
          },
        },
      },
      include: {
        channels: true,
        _count: { select: { members: true } },
      },
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

    const { name } = req.body;
    const updateData: Record<string, unknown> = {};

    if (name !== undefined) {
      const nameErr = validateServerName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      updateData.name = name;
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestError('No fields to update');
    }

    const updated = await prisma.server.update({
      where: { id: serverId },
      select: { id: true, name: true, iconUrl: true, ownerId: true, createdAt: true },
      data: updateData,
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED as any, updated);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a server (owner only)
serverRouter.delete('/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');
    if (server.ownerId !== req.user!.userId) throw new ForbiddenError('Only the server owner can delete it');

    await prisma.server.delete({ where: { id: serverId } });

    res.json({ success: true, message: 'Server deleted' });
  } catch (err) {
    next(err);
  }
});
