import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateChannelName, LIMITS, type Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';

export const channelRouter = Router({ mergeParams: true });

channelRouter.use(authenticate);

// List channels in a server
channelRouter.get('/', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const channels = await prisma.channel.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });

    res.json({ success: true, data: channels });
  } catch (err) {
    next(err);
  }
});

// Create a channel
channelRouter.post('/', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const { name, type = 'text' } = req.body;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ForbiddenError('Only admins can create channels');
    }

    const nameErr = validateChannelName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    if (!['text', 'voice'].includes(type)) {
      throw new BadRequestError('Channel type must be "text" or "voice"');
    }

    const channelCount = await prisma.channel.count({ where: { serverId } });
    if (channelCount >= LIMITS.MAX_CHANNELS_PER_SERVER) {
      throw new BadRequestError(`Server can have at most ${LIMITS.MAX_CHANNELS_PER_SERVER} channels`);
    }

    const channel = await prisma.channel.create({
      data: { name, type, serverId, position: channelCount },
    });

    getIO().to(`server:${serverId}`).emit('channel:created', channel as unknown as Channel);

    // Auto-subscribe all server members' sockets to the new text channel room
    if (type === 'text') {
      const socketsInServer = await getIO().in(`server:${serverId}`).fetchSockets();
      for (const s of socketsInServer) {
        s.join(`channel:${channel.id}`);
      }
    }

    res.status(201).json({ success: true, data: channel });
  } catch (err) {
    next(err);
  }
});

// Mark a channel as read
channelRouter.post('/:channelId/read', async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId },
    });
    if (!channel) throw new NotFoundError('Channel');

    await prisma.channelRead.upsert({
      where: { userId_channelId: { userId: req.user!.userId, channelId } },
      update: { lastReadAt: new Date() },
      create: { userId: req.user!.userId, channelId, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Delete a channel
channelRouter.delete('/:channelId', async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ForbiddenError('Only admins can delete channels');
    }

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId },
    });
    if (!channel) throw new NotFoundError('Channel');

    await prisma.channel.delete({ where: { id: channelId } });

    getIO().to(`server:${serverId}`).emit('channel:deleted', { channelId, serverId });

    res.json({ success: true, message: 'Channel deleted' });
  } catch (err) {
    next(err);
  }
});
