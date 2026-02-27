import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateMessageContent, validateEmoji, LIMITS, type Message } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';

export const dmRouter = Router();

dmRouter.use(authenticate);

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true },
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
      select: { id: true, username: true, displayName: true, avatarUrl: true },
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

    await getConversationOrThrow(conversationId, userId);

    const where: Record<string, unknown> = { conversationId };
    if (before) {
      where.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        author: authorSelect,
        reactions: reactionInclude,
      },
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

dmRouter.post('/:conversationId/messages', async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
    const { content } = req.body;

    const contentErr = validateMessageContent(content);
    if (contentErr) throw new BadRequestError(contentErr);

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.create({
      data: {
        content,
        conversationId,
        authorId: userId,
      },
      include: {
        author: authorSelect,
      },
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

dmRouter.patch('/:conversationId/messages/:messageId', async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;
    const { content } = req.body;

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
        reactions: reactionInclude,
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

dmRouter.delete('/:conversationId/messages/:messageId', async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');
    if (message.authorId !== userId) throw new ForbiddenError('You can only delete your own messages');

    await prisma.message.delete({ where: { id: messageId } });

    getIO().to(`dm:${conversationId}`).emit('dm:message:delete', { messageId, conversationId });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Toggle reaction on DM ──────────────────────────────────────────────────

dmRouter.put('/:conversationId/messages/:messageId/reactions/:emoji', async (req: Request<{ conversationId: string; messageId: string; emoji: string }>, res: Response, next: NextFunction) => {
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

dmRouter.delete('/:conversationId', async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    // Delete conversation (cascades messages + conversation reads)
    await prisma.conversation.delete({ where: { id: conversationId } });

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

dmRouter.post('/:conversationId/read', async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
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
