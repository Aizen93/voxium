import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimitSearch } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam } from '../utils/errors';
import { validateSearchQuery, LIMITS } from '@voxium/shared';
import { sanitizeText } from '../utils/sanitize';

export const searchRouter = Router();

searchRouter.use(authenticate);
searchRouter.use(rateLimitSearch);

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true },
};

// ─── Search server messages ─────────────────────────────────────────────────

searchRouter.get('/servers/:serverId/messages', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const userId = req.user!.userId;
    const q = sanitizeText((req.query.q as string) ?? '');
    const channelId = req.query.channelId as string | undefined;
    const authorId = req.query.authorId as string | undefined;
    const before = req.query.before as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || LIMITS.SEARCH_RESULTS_PER_PAGE, LIMITS.SEARCH_RESULTS_PER_PAGE);

    const queryErr = validateSearchQuery(q);
    if (queryErr) throw new BadRequestError(queryErr);

    // Verify server membership
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    // Get text channel IDs for the server (or filter to a specific channel)
    let channelIds: string[];
    if (channelId) {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true, serverId: true, type: true },
      });
      if (!channel || channel.serverId !== serverId || channel.type !== 'text') {
        throw new BadRequestError('Invalid channel');
      }
      channelIds = [channelId];
    } else {
      const channels = await prisma.channel.findMany({
        where: { serverId, type: 'text' },
        select: { id: true },
      });
      channelIds = channels.map((c) => c.id);
    }

    if (channelIds.length === 0) {
      res.json({ success: true, data: [], hasMore: false });
      return;
    }

    const where: Record<string, unknown> = {
      channelId: { in: channelIds },
      content: { contains: q, mode: 'insensitive' },
      type: 'user',
    };
    if (authorId) {
      where.authorId = authorId;
    }
    if (before) {
      where.createdAt = { lt: parseDateParam(before, 'before') };
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        author: authorSelect,
        channel: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    const data = messages.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      channelId: m.channelId,
      author: m.author,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      channelName: m.channel?.name,
    }));

    res.json({ success: true, data, hasMore });
  } catch (err) {
    next(err);
  }
});

// ─── Search DM messages ─────────────────────────────────────────────────────

searchRouter.get('/dm/:conversationId/messages', async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
    const q = sanitizeText((req.query.q as string) ?? '');
    const before = req.query.before as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || LIMITS.SEARCH_RESULTS_PER_PAGE, LIMITS.SEARCH_RESULTS_PER_PAGE);

    const queryErr = validateSearchQuery(q);
    if (queryErr) throw new BadRequestError(queryErr);

    // Verify conversation participation
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundError('Conversation');
    if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
      throw new ForbiddenError('Not a participant of this conversation');
    }

    const where: Record<string, unknown> = {
      conversationId,
      content: { contains: q, mode: 'insensitive' },
      type: 'user',
    };
    if (before) {
      where.createdAt = { lt: parseDateParam(before, 'before') };
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        author: authorSelect,
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    const data = messages.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      channelId: m.channelId,
      conversationId: m.conversationId,
      author: m.author,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
    }));

    res.json({ success: true, data, hasMore });
  } catch (err) {
    next(err);
  }
});
