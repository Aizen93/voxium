import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimitMessageSend } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam } from '../utils/errors';
import { validateMessageContent, validateEmoji, LIMITS, type Message } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';
import { sanitizeText } from '../utils/sanitize';

export const messageRouter = Router({ mergeParams: true });

messageRouter.use(authenticate);

// Get messages in a channel (paginated, newest first — or around a target message)
messageRouter.get('/', async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, LIMITS.MESSAGES_PER_PAGE);
    const before = req.query.before as string | undefined;
    const around = req.query.around as string | undefined;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true },
    });
    if (!channel) throw new NotFoundError('Channel');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const messageInclude = {
      author: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
      replyTo: {
        select: {
          id: true,
          content: true,
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      },
      reactions: reactionInclude,
    };

    // "around" mode: fetch messages surrounding a target message
    if (around) {
      const target = await prisma.message.findUnique({
        where: { id: around },
        select: { id: true, channelId: true, createdAt: true },
      });
      if (!target || target.channelId !== channelId) throw new NotFoundError('Message');

      const half = Math.floor(limit / 2);

      const [olderMessages, newerMessages] = await Promise.all([
        prisma.message.findMany({
          where: { channelId, createdAt: { lte: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'desc' },
          take: half + 1,
        }),
        prisma.message.findMany({
          where: { channelId, createdAt: { gt: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'asc' },
          take: half + 1,
        }),
      ]);

      const hasMore = olderMessages.length > half;
      const hasMoreAfter = newerMessages.length > half;
      if (hasMore) olderMessages.pop();
      if (hasMoreAfter) newerMessages.pop();

      // Combine: older (reversed to chronological) + newer
      const combined = [...olderMessages.reverse(), ...newerMessages];
      // Deduplicate by id
      const seen = new Set<string>();
      const unique = combined.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      const data = unique.map((m) => ({
        ...m,
        reactions: aggregateReactions(m.reactions),
      }));

      res.json({ success: true, data, hasMore, hasMoreAfter, targetMessageId: around });
      return;
    }

    // Standard pagination
    const where: Record<string, unknown> = { channelId };
    if (before) {
      where.createdAt = { lt: parseDateParam(before, 'before') };
    }

    const messages = await prisma.message.findMany({
      where,
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    const data = messages.reverse().map((m) => ({
      ...m,
      reactions: aggregateReactions(m.reactions),
    }));

    res.json({
      success: true,
      data,
      hasMore,
    });
  } catch (err) {
    next(err);
  }
});

// Send a message
messageRouter.post('/', rateLimitMessageSend, async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;
    const content = sanitizeText(req.body.content ?? '');

    const contentErr = validateMessageContent(content);
    if (contentErr) throw new BadRequestError(contentErr);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true, type: true, name: true, server: { select: { name: true } } },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.type !== 'text') throw new BadRequestError('Cannot send messages to a voice channel');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    // Validate optional replyToId
    const replyToId = req.body.replyToId as string | undefined;
    if (replyToId) {
      const parent = await prisma.message.findUnique({ where: { id: replyToId }, select: { channelId: true } });
      if (!parent || parent.channelId !== channelId) throw new BadRequestError('Invalid replyToId');
    }

    const message = await prisma.message.create({
      data: {
        content,
        channelId,
        authorId: req.user!.userId,
        ...(replyToId && { replyToId }),
      },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
      },
    });

    // Broadcast to all users subscribed to this channel
    const room = `channel:${channelId}`;
    const socketsInRoom = await getIO().in(room).fetchSockets();
    console.log(`[MSG] Broadcasting message:new to ${room} — ${socketsInRoom.length} socket(s) in room: [${socketsInRoom.map(s => s.data.userId).join(', ')}]`);
    // Prisma returns Date objects; Socket.IO serializes them to ISO strings over the wire
    // Attach channel/server names for desktop notification context
    const payload = { ...message, reactions: [], channelName: channel.name, serverName: channel.server.name, serverId: channel.serverId };
    getIO().to(room).emit('message:new', payload as unknown as Message);

    res.status(201).json({ success: true, data: message });
  } catch (err) {
    next(err);
  }
});

// Edit a message
messageRouter.patch('/:messageId', async (req: Request<{ channelId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { messageId } = req.params;
    const content = sanitizeText(req.body.content ?? '');

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
        replyTo: {
          select: {
            id: true,
            content: true,
            author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
        reactions: reactionInclude,
      },
    });

    const payload = { ...updated, reactions: aggregateReactions(updated.reactions) };
    getIO().to(`channel:${message.channelId!}`).emit('message:update', payload as unknown as Message);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Toggle reaction on a message
messageRouter.put('/:messageId/reactions/:emoji', async (req: Request<{ channelId: string; messageId: string; emoji: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId, messageId } = req.params;
    const emoji = decodeURIComponent(req.params.emoji);
    const userId = req.user!.userId;

    const emojiErr = validateEmoji(emoji);
    if (emojiErr) throw new BadRequestError(emojiErr);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, channel: { select: { serverId: true } } },
    });
    if (!message || message.channelId !== channelId || !message.channel) throw new NotFoundError('Message');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId: message.channel.serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });

    let action: 'add' | 'remove';
    if (existing) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
      action = 'remove';
    } else {
      // Check distinct emoji count limit
      const distinctCount = await prisma.messageReaction.groupBy({
        by: ['emoji'],
        where: { messageId },
      });
      if (distinctCount.length >= LIMITS.MAX_REACTIONS_PER_MESSAGE) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_REACTIONS_PER_MESSAGE} different reactions per message`);
      }
      await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
      action = 'add';
    }

    const rawReactions = await prisma.messageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
      orderBy: { createdAt: 'asc' },
    });
    const reactions = aggregateReactions(rawReactions);

    getIO().to(`channel:${channelId}`).emit('message:reaction_update', {
      messageId, channelId, emoji, userId, action, reactions,
    });

    res.json({ success: true, data: { action, reactions } });
  } catch (err) {
    next(err);
  }
});

// Delete a message
messageRouter.delete('/:messageId', async (req: Request<{ channelId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { serverId: true } } },
    });
    if (!message || !message.channel) throw new NotFoundError('Message');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: message.channel.serverId } },
    });

    const isAuthor = message.authorId === req.user!.userId;
    const isAdmin = membership && ['owner', 'admin'].includes(membership.role);

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenError('You can only delete your own messages');
    }

    await prisma.message.delete({ where: { id: messageId } });

    getIO().to(`channel:${message.channelId!}`).emit('message:delete', {
      messageId,
      channelId: message.channelId!,
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});
