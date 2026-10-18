import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { rateLimitSearch } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, parseDateParam } from '../utils/errors';
import { validateSearchQuery, LIMITS } from '@voxium/shared';
import { sanitizeText } from '../utils/sanitize';
import { filterVisibleChannels } from '../utils/permissionCalculator';
import { shapeMessageAuthor } from '../utils/messageAuthor';

export const searchRouter = Router();

searchRouter.use(authenticate, requireVerifiedEmail, requireConsent);
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
    const limit = Math.min(parseInt(req.query.limit as string, 10) || LIMITS.SEARCH_RESULTS_PER_PAGE, LIMITS.SEARCH_RESULTS_PER_PAGE);

    const queryErr = validateSearchQuery(q);
    if (queryErr) throw new BadRequestError(queryErr);

    // Verify server membership
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    // Get text channel IDs for the server (or filter to a specific channel),
    // restricted to channels this member can VIEW. Secure channels are
    // excluded outright — their content is ciphertext the trigram index can
    // never match, and even the attempt must not act as an existence oracle
    // (a secure channelId gets the same generic error as an unknown one).
    let channelIds: string[];
    if (channelId) {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true, serverId: true, type: true, secure: true },
      });
      if (!channel || channel.serverId !== serverId || channel.type !== 'text' || channel.secure) {
        throw new BadRequestError('Invalid channel');
      }
      const visible = await filterVisibleChannels(userId, serverId, [channel]);
      if (visible.length === 0) throw new BadRequestError('Invalid channel');
      channelIds = [channelId];
    } else {
      const channels = await prisma.channel.findMany({
        where: { serverId, type: 'text', secure: false },
        select: { id: true, secure: true },
      });
      const visible = await filterVisibleChannels(userId, serverId, channels);
      channelIds = visible.map((c) => c.id);
    }

    if (channelIds.length === 0) {
      res.json({ success: true, data: [], hasMore: false });
      return;
    }

    const where: Record<string, unknown> = {
      channelId: { in: channelIds },
      content: { contains: q, mode: 'insensitive' },
      type: 'user',
      // Ciphertext never matches meaningfully and must never be returned —
      // encrypted history is searched client-side only (same rule as DMs)
      encrypted: false,
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

    // `include` returns every scalar, so webhookId/webhookName are on the row:
    // a webhook-posted match gets its synthesised author (utils/messageAuthor.ts)
    const data = messages.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      channelId: m.channelId,
      author: shapeMessageAuthor(m),
      webhookId: m.webhookId,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      channelName: m.channel?.name,
    }));

    res.json({ success: true, data, hasMore });
  } catch (err) {
    next(err);
  }
});

// DM search is local-only: every DM is end-to-end encrypted since the 2.0
// cutover, so the server holds nothing it could match. The desktop searches
// its decrypted history (services/e2e/dmCrypto.ts searchEncryptedHistory);
// the old GET /search/dm/:conversationId/messages route filtered on
// `encrypted: false` user rows, which no longer exist, and no client calls it.
