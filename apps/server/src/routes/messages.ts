import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimitMessageSend, rateLimitGeneral } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam } from '../utils/errors';
import { validateMessageContent, validateEmoji, LIMITS, ALLOWED_ATTACHMENT_TYPES, type Message } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';
import { sanitizeText } from '../utils/sanitize';
import { VALID_ATTACHMENT_KEY_RE, deleteMultipleFromS3 } from '../utils/s3';

const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

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
        select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
      },
      replyTo: {
        select: {
          id: true,
          content: true,
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true } },
        },
      },
      reactions: reactionInclude,
      attachments: attachmentSelect,
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

    // Validate attachments
    const attachments = req.body.attachments as Array<{
      s3Key: string; fileName: string; fileSize: number; mimeType: string;
    }> | undefined;

    if (attachments) {
      if (!Array.isArray(attachments)) throw new BadRequestError('attachments must be an array');
      if (attachments.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new BadRequestError(`Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
      }
      const expectedPrefix = `attachments/ch-${channelId}/`;
      for (const a of attachments) {
        if (!a || typeof a !== 'object') throw new BadRequestError('Invalid attachment');
        if (typeof a.s3Key !== 'string' || typeof a.fileName !== 'string' || typeof a.fileSize !== 'number' || typeof a.mimeType !== 'string') {
          throw new BadRequestError('Invalid attachment fields');
        }
        if (!VALID_ATTACHMENT_KEY_RE.test(a.s3Key)) throw new BadRequestError('Invalid attachment key');
        if (!a.s3Key.startsWith(expectedPrefix)) throw new BadRequestError('Attachment does not belong to this channel');
        if (a.fileSize <= 0 || a.fileSize > LIMITS.MAX_ATTACHMENT_SIZE) throw new BadRequestError('Invalid attachment size');
        if (!ALLOWED_ATTACHMENT_TYPES.includes(a.mimeType as typeof ALLOWED_ATTACHMENT_TYPES[number])) throw new BadRequestError('Invalid file type');
      }
    }

    // Allow empty content if attachments are present
    if (!attachments?.length) {
      const contentErr = validateMessageContent(content);
      if (contentErr) throw new BadRequestError(contentErr);
    } else if (content.length > LIMITS.MESSAGE_MAX) {
      throw new BadRequestError(`Message must be at most ${LIMITS.MESSAGE_MAX} characters`);
    }

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

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          content,
          channelId,
          authorId: req.user!.userId,
          ...(replyToId && { replyToId }),
        },
      });
      if (attachments?.length) {
        await tx.messageAttachment.createMany({
          data: attachments.map((a) => ({
            messageId: msg.id,
            s3Key: a.s3Key,
            fileName: a.fileName,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        });
      }
      return tx.message.findUniqueOrThrow({
        where: { id: msg.id },
        include: {
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true } },
          replyTo: {
            select: {
              id: true, content: true,
              author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true } },
            },
          },
          attachments: attachmentSelect,
        },
      });
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
messageRouter.patch('/:messageId', rateLimitGeneral, async (req: Request<{ channelId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId, messageId } = req.params;
    const content = sanitizeText(req.body.content ?? '');

    const contentErr = validateMessageContent(content);
    if (contentErr) throw new BadRequestError(contentErr);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { serverId: true } } },
    });
    if (!message) throw new NotFoundError('Message');
    if (message.channelId !== channelId) throw new NotFoundError('Message');
    if (message.authorId !== req.user!.userId) throw new ForbiddenError('You can only edit your own messages');

    // Verify server membership
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: message.channel!.serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true } },
          },
        },
        reactions: reactionInclude,
        attachments: attachmentSelect,
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
messageRouter.put('/:messageId/reactions/:emoji', rateLimitGeneral, async (req: Request<{ channelId: string; messageId: string; emoji: string }>, res: Response, next: NextFunction) => {
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
messageRouter.delete('/:messageId', rateLimitGeneral, async (req: Request<{ channelId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId, messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { serverId: true } }, attachments: { select: { s3Key: true } } },
    });
    if (!message || !message.channel) throw new NotFoundError('Message');
    if (message.channelId !== channelId) throw new NotFoundError('Message');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: message.channel.serverId } },
    });

    const isAuthor = message.authorId === req.user!.userId;
    const isAdmin = membership && ['owner', 'admin'].includes(membership.role);

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenError('You can only delete your own messages');
    }

    await prisma.message.delete({ where: { id: messageId } });

    // Fire-and-forget S3 cleanup
    if (message.attachments.length > 0) {
      deleteMultipleFromS3(message.attachments.map((a) => a.s3Key)).catch(() => {});
    }

    getIO().to(`channel:${message.channelId!}`).emit('message:delete', {
      messageId,
      channelId: message.channelId!,
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});
