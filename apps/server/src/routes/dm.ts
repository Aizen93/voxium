import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitMessageSend, rateLimitGeneral, rateLimitMarkRead } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam } from '../utils/errors';
import { validateMessageContent, validateEmoji, LIMITS, ALLOWED_ATTACHMENT_TYPES, getMaxAttachmentSize, type Message } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';
import { sanitizeText } from '../utils/sanitize';
import { VALID_ATTACHMENT_KEY_RE, deleteMultipleFromS3 } from '../utils/s3';

const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

export const dmRouter = Router();

dmRouter.use(authenticate, requireVerifiedEmail);

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, status: true, role: true, isSupporter: true, supporterTier: true },
};

const replyToSelect = {
  select: {
    id: true,
    content: true,
    author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
  },
};

/** Ensure user1Id < user2Id for uniqueness constraint */
function sortUserIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Verify the requesting user is a participant of the conversation */
async function getConversationOrThrow(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) throw new NotFoundError('Conversation');
  if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
    throw new ForbiddenError('Not a participant of this conversation');
  }
  return conversation;
}

// ─── List conversations ──────────────────────────────────────────────────────

dmRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const conversations = await prisma.conversation.findMany({
      where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
      include: {
        user1: authorSelect,
        user2: authorSelect,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, createdAt: true, authorId: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const data = conversations.map((c) => ({
      id: c.id,
      user1Id: c.user1Id,
      user2Id: c.user2Id,
      participant: c.user1Id === userId ? c.user2 : c.user1,
      lastMessage: c.messages[0]
        ? { content: c.messages[0].content, createdAt: c.messages[0].createdAt.toISOString(), authorId: c.messages[0].authorId }
        : null,
      createdAt: c.createdAt.toISOString(),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── Create or get conversation ──────────────────────────────────────────────

dmRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.user!.userId;
    const { userId: targetUserId } = req.body;

    if (!targetUserId || typeof targetUserId !== 'string') {
      throw new BadRequestError('userId is required');
    }
    if (targetUserId === currentUserId) {
      throw new BadRequestError('Cannot create conversation with yourself');
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
    });
    if (!targetUser) throw new NotFoundError('User');

    const [user1Id, user2Id] = sortUserIds(currentUserId, targetUserId);

    // Upsert conversation
    let conversation = await prisma.conversation.findUnique({
      where: { user1Id_user2Id: { user1Id, user2Id } },
    });

    let isNew = false;
    if (!conversation) {
      isNew = true;
      conversation = await prisma.conversation.create({
        data: { user1Id, user2Id },
      });

      // Create read records for both participants
      const now = new Date();
      await prisma.conversationRead.createMany({
        data: [
          { userId: user1Id, conversationId: conversation.id, lastReadAt: now },
          { userId: user2Id, conversationId: conversation.id, lastReadAt: now },
        ],
      });

      // Join both users' sockets to the DM room
      const io = getIO();
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        if (s.data.userId === user1Id || s.data.userId === user2Id) {
          s.join(`dm:${conversation.id}`);
        }
      }
    }

    res.status(isNew ? 201 : 200).json({
      success: true,
      data: {
        id: conversation.id,
        user1Id: conversation.user1Id,
        user2Id: conversation.user2Id,
        participant: targetUser,
        lastMessage: null,
        createdAt: conversation.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get messages in conversation ────────────────────────────────────────────

dmRouter.get('/:conversationId/messages', async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, LIMITS.MESSAGES_PER_PAGE);
    const before = req.query.before as string | undefined;
    const around = req.query.around as string | undefined;

    await getConversationOrThrow(conversationId, userId);

    const messageInclude = {
      author: authorSelect,
      replyTo: replyToSelect,
      reactions: reactionInclude,
      attachments: attachmentSelect,
    };

    // "around" mode: fetch messages surrounding a target message
    if (around) {
      const target = await prisma.message.findUnique({
        where: { id: around },
        select: { id: true, conversationId: true, createdAt: true },
      });
      if (!target || target.conversationId !== conversationId) throw new NotFoundError('Message');

      const half = Math.floor(limit / 2);

      const [olderMessages, newerMessages] = await Promise.all([
        prisma.message.findMany({
          where: { conversationId, createdAt: { lte: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'desc' },
          take: half + 1,
        }),
        prisma.message.findMany({
          where: { conversationId, createdAt: { gt: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'asc' },
          take: half + 1,
        }),
      ]);

      const hasMore = olderMessages.length > half;
      const hasMoreAfter = newerMessages.length > half;
      if (hasMore) olderMessages.pop();
      if (hasMoreAfter) newerMessages.pop();

      const combined = [...olderMessages.reverse(), ...newerMessages];
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
    const where: Record<string, unknown> = { conversationId };
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

    res.json({ success: true, data, hasMore });
  } catch (err) {
    next(err);
  }
});

// ─── Send DM ─────────────────────────────────────────────────────────────────

dmRouter.post('/:conversationId/messages', rateLimitMessageSend, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
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
      const expectedPrefix = `attachments/dm-${conversationId}/`;
      for (const a of attachments) {
        if (!a || typeof a !== 'object') throw new BadRequestError('Invalid attachment');
        if (typeof a.s3Key !== 'string' || typeof a.fileName !== 'string' || typeof a.fileSize !== 'number' || typeof a.mimeType !== 'string') {
          throw new BadRequestError('Invalid attachment fields');
        }
        if (!VALID_ATTACHMENT_KEY_RE.test(a.s3Key)) throw new BadRequestError('Invalid attachment key');
        if (!a.s3Key.startsWith(expectedPrefix)) throw new BadRequestError('Attachment does not belong to this conversation');
        if (a.fileSize <= 0 || a.fileSize > getMaxAttachmentSize(a.mimeType)) throw new BadRequestError('Invalid attachment size');
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

    await getConversationOrThrow(conversationId, userId);

    // Validate optional replyToId
    const replyToId = req.body.replyToId as string | undefined;
    if (replyToId !== undefined && typeof replyToId !== 'string') throw new BadRequestError('replyToId must be a string');
    if (replyToId) {
      const parent = await prisma.message.findUnique({ where: { id: replyToId }, select: { conversationId: true } });
      if (!parent || parent.conversationId !== conversationId) throw new BadRequestError('Invalid replyToId');
    }

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          content,
          conversationId,
          authorId: userId,
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
          author: authorSelect,
          replyTo: replyToSelect,
          attachments: attachmentSelect,
        },
      });
    });

    // Update conversation updatedAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    const payload = { ...message, reactions: [] };
    getIO().to(`dm:${conversationId}`).emit('dm:message:new', payload as unknown as Message);

    res.status(201).json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

// ─── Edit DM ─────────────────────────────────────────────────────────────────

dmRouter.patch('/:conversationId/messages/:messageId', rateLimitGeneral, async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;
    const content = sanitizeText(req.body.content ?? '');

    const contentErr = validateMessageContent(content);
    if (contentErr) throw new BadRequestError(contentErr);

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');
    if (message.authorId !== userId) throw new ForbiddenError('You can only edit your own messages');

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        author: authorSelect,
        replyTo: replyToSelect,
        reactions: reactionInclude,
        attachments: attachmentSelect,
      },
    });

    const payload = { ...updated, reactions: aggregateReactions(updated.reactions) };
    getIO().to(`dm:${conversationId}`).emit('dm:message:update', payload as unknown as Message);

    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

// ─── Delete DM ───────────────────────────────────────────────────────────────

dmRouter.delete('/:conversationId/messages/:messageId', rateLimitGeneral, async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { attachments: { select: { s3Key: true } } },
    });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');
    if (message.authorId !== userId) throw new ForbiddenError('You can only delete your own messages');

    await prisma.message.delete({ where: { id: messageId } });

    // Fire-and-forget S3 cleanup
    if (message.attachments.length > 0) {
      deleteMultipleFromS3(message.attachments.map((a) => a.s3Key)).catch(() => {});
    }

    getIO().to(`dm:${conversationId}`).emit('dm:message:delete', { messageId, conversationId });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Toggle reaction on DM ──────────────────────────────────────────────────

dmRouter.put('/:conversationId/messages/:messageId/reactions/:emoji', rateLimitGeneral, async (req: Request<{ conversationId: string; messageId: string; emoji: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const emoji = decodeURIComponent(req.params.emoji);
    const userId = req.user!.userId;

    const emojiErr = validateEmoji(emoji);
    if (emojiErr) throw new BadRequestError(emojiErr);

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true },
    });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });

    let action: 'add' | 'remove';
    if (existing) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
      action = 'remove';
    } else {
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

    getIO().to(`dm:${conversationId}`).emit('dm:message:reaction_update', {
      messageId, conversationId, emoji, userId, action, reactions,
    });

    res.json({ success: true, data: { action, reactions } });
  } catch (err) {
    next(err);
  }
});

// ─── Delete conversation ────────────────────────────────────────────────────

dmRouter.delete('/:conversationId', rateLimitGeneral, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    // Collect attachment S3 keys before cascade delete
    const attachments = await prisma.messageAttachment.findMany({
      where: { message: { conversationId } },
      select: { s3Key: true },
    });

    // Delete conversation (cascades messages + attachments + conversation reads)
    await prisma.conversation.delete({ where: { id: conversationId } });

    // Fire-and-forget S3 cleanup
    if (attachments.length > 0) {
      deleteMultipleFromS3(attachments.map((a) => a.s3Key)).catch(() => {});
    }

    // Notify the other participant
    const io = getIO();
    io.to(`dm:${conversationId}`).emit('dm:conversation:deleted', { conversationId });

    // Remove all sockets from the DM room
    const sockets = await io.in(`dm:${conversationId}`).fetchSockets();
    for (const s of sockets) {
      s.leave(`dm:${conversationId}`);
    }

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Mark conversation as read ───────────────────────────────────────────────

dmRouter.post('/:conversationId/read', rateLimitMarkRead, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    await prisma.conversationRead.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      update: { lastReadAt: new Date() },
      create: { userId, conversationId, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
