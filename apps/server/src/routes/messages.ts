import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateMessageContent, LIMITS } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';

export const messageRouter = Router({ mergeParams: true });

messageRouter.use(authenticate);

// Get messages in a channel (paginated, newest first)
messageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, LIMITS.MESSAGES_PER_PAGE);
    const before = req.query.before as string | undefined;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true },
    });
    if (!channel) throw new NotFoundError('Channel');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const where: Record<string, unknown> = { channelId };
    if (before) {
      where.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    res.json({
      success: true,
      data: messages.reverse(),
      hasMore,
    });
  } catch (err) {
    next(err);
  }
});

// Send a message
messageRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;
    const { content } = req.body;

    const contentErr = validateMessageContent(content);
    if (contentErr) throw new BadRequestError(contentErr);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true, type: true },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.type !== 'text') throw new BadRequestError('Cannot send messages to a voice channel');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const message = await prisma.message.create({
      data: {
        content,
        channelId,
        authorId: req.user!.userId,
      },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });

    // Broadcast to all users subscribed to this channel
    const room = `channel:${channelId}`;
    const socketsInRoom = await getIO().in(room).fetchSockets();
    console.log(`[MSG] Broadcasting message:new to ${room} — ${socketsInRoom.length} socket(s) in room: [${socketsInRoom.map(s => s.data.userId).join(', ')}]`);
    getIO().to(room).emit('message:new', message);

    res.status(201).json({ success: true, data: message });
  } catch (err) {
    next(err);
  }
});

// Edit a message
messageRouter.patch('/:messageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;

    const contentErr = validateMessageContent(content);
    if (contentErr) throw new BadRequestError(contentErr);

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundError('Message');
    if (message.authorId !== req.user!.userId) throw new ForbiddenError('You can only edit your own messages');

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });

    getIO().to(`channel:${message.channelId}`).emit('message:update', updated);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a message
messageRouter.delete('/:messageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { serverId: true } } },
    });
    if (!message) throw new NotFoundError('Message');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: message.channel.serverId } },
    });

    const isAuthor = message.authorId === req.user!.userId;
    const isAdmin = membership && ['owner', 'admin'].includes(membership.role);

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenError('You can only delete your own messages');
    }

    await prisma.message.delete({ where: { id: messageId } });

    getIO().to(`channel:${message.channelId}`).emit('message:delete', {
      messageId,
      channelId: message.channelId,
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});
