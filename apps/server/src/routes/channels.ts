import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateChannelName, WS_EVENTS, type Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { rateLimitCategoryManage, rateLimitMarkRead } from '../middleware/rateLimiter';
import { sanitizeText } from '../utils/sanitize';
import { getEffectiveLimits } from '../utils/serverLimits';

export const channelRouter = Router({ mergeParams: true });

channelRouter.use(authenticate, requireVerifiedEmail);

// Bulk reorder channels (with optional category reassignment)
channelRouter.put('/reorder', rateLimitCategoryManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ForbiddenError('Only admins can reorder channels');
    }

    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      throw new BadRequestError('order must be a non-empty array');
    }

    // Validate all channel IDs belong to this server
    const channelIds = order.map((o: { id: string }) => o.id);
    const channels = await prisma.channel.findMany({
      where: { id: { in: channelIds }, serverId },
      select: { id: true },
    });
    if (channels.length !== channelIds.length) {
      throw new BadRequestError('One or more channel IDs do not belong to this server');
    }

    // Validate all non-null categoryIds belong to this server
    const categoryIds = [...new Set(
      order
        .map((o: { categoryId?: string | null }) => o.categoryId)
        .filter((id: string | null | undefined): id is string => id != null)
    )];
    if (categoryIds.length > 0) {
      const categories = await prisma.category.findMany({
        where: { id: { in: categoryIds }, serverId },
        select: { id: true },
      });
      if (categories.length !== categoryIds.length) {
        throw new BadRequestError('One or more category IDs do not belong to this server');
      }
    }

    // Update positions + categoryId in a transaction
    await prisma.$transaction(
      order.map((o: { id: string; position: number; categoryId?: string | null }) =>
        prisma.channel.update({
          where: { id: o.id },
          data: { position: o.position, categoryId: o.categoryId ?? null },
        })
      )
    );

    // Re-read updated channels and emit events
    const updated = await prisma.channel.findMany({
      where: { id: { in: channelIds } },
    });
    const io = getIO();
    for (const ch of updated) {
      io.to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_UPDATED, ch as unknown as Channel);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

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
    const { type = 'text', categoryId } = req.body;
    const name = sanitizeText(req.body.name ?? '');

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

    // Validate categoryId if provided
    if (categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: categoryId, serverId },
      });
      if (!category) throw new BadRequestError('Category not found in this server');
    }

    const [channelCount, limits] = await Promise.all([
      prisma.channel.count({ where: { serverId } }),
      getEffectiveLimits(serverId),
    ]);
    if (channelCount >= limits.maxChannelsPerServer) {
      throw new BadRequestError(`Server can have at most ${limits.maxChannelsPerServer} channels`);
    }

    const channel = await prisma.channel.create({
      data: { name, type, serverId, position: channelCount, categoryId: categoryId || null },
    });

    getIO().to(`server:${serverId}`).emit('channel:created', channel as unknown as Channel);

    // Auto-subscribe all server members' sockets to the new text channel room
    // and seed ChannelRead so existing history doesn't show as unread
    if (type === 'text') {
      const socketsInServer = await getIO().in(`server:${serverId}`).fetchSockets();
      for (const s of socketsInServer) {
        s.join(`channel:${channel.id}`);
      }

      const members = await prisma.serverMember.findMany({
        where: { serverId },
        select: { userId: true },
      });
      if (members.length > 0) {
        const now = new Date();
        await prisma.channelRead.createMany({
          data: members.map((m) => ({
            userId: m.userId,
            channelId: channel.id,
            lastReadAt: now,
          })),
          skipDuplicates: true,
        });
      }
    }

    res.status(201).json({ success: true, data: channel });
  } catch (err) {
    next(err);
  }
});

// Mark a channel as read
channelRouter.post('/:channelId/read', rateLimitMarkRead, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;

    // Single query: verify membership + channel exists in this server
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId, server: { members: { some: { userId: req.user!.userId } } } },
      select: { id: true },
    });
    if (!channel) throw new ForbiddenError('Not authorized');

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

// Update a channel (move between categories)
channelRouter.patch('/:channelId', rateLimitCategoryManage, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ForbiddenError('Only admins can update channels');
    }

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId },
    });
    if (!channel) throw new NotFoundError('Channel');

    const { categoryId } = req.body;
    if (categoryId === undefined) throw new BadRequestError('categoryId is required');

    // Validate categoryId if not null
    if (categoryId !== null) {
      const category = await prisma.category.findFirst({
        where: { id: categoryId, serverId },
      });
      if (!category) throw new BadRequestError('Category not found in this server');
    }

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: { categoryId },
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_UPDATED, updated as unknown as Channel);

    res.json({ success: true, data: updated });
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
