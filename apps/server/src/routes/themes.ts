import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitThemeManage, rateLimitThemeBrowse } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/requireSuperAdmin';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import { getIO } from '../websocket/socketServer';
import {
  LIMITS,
  validateThemeName,
  validateThemeDescription,
  validateThemeTag,
  validateThemeColors,
  validateThemePatterns,
  sanitizeThemePatterns,
} from '@voxium/shared';
import type { CommunityTheme } from '@voxium/shared';

export const themeRouter = Router();

themeRouter.use(authenticate, requireVerifiedEmail);

// ─── Helper: format theme for API response ──────────────────────────────────

function formatTheme(theme: {
  id: string;
  name: string;
  description: string;
  tags: string[];
  colors: unknown;
  patterns: unknown;
  version: number;
  status: string;
  installCount: number;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  author: { username: string; displayName: string };
}): CommunityTheme {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    tags: theme.tags,
    colors: theme.colors as CommunityTheme['colors'],
    patterns: theme.patterns as CommunityTheme['patterns'],
    version: theme.version,
    status: theme.status as CommunityTheme['status'],
    installCount: theme.installCount,
    authorId: theme.authorId,
    authorUsername: theme.author.username,
    authorDisplayName: theme.author.displayName,
    createdAt: theme.createdAt.toISOString(),
    updatedAt: theme.updatedAt.toISOString(),
  };
}

const authorSelect = { username: true, displayName: true } as const;

// ─── Browse published themes ─────────────────────────────────────────────────

themeRouter.get('/', rateLimitThemeBrowse, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(LIMITS.THEMES_PER_PAGE, Math.max(1, parseInt(req.query.limit as string, 10) || LIMITS.THEMES_PER_PAGE));
    const sort = req.query.sort as string || 'newest';
    const search = req.query.search as string || '';
    const tag = req.query.tag as string || '';

    const where: Record<string, unknown> = { status: 'published' };
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }
    if (tag) {
      where.tags = { has: tag };
    }

    let orderBy: Record<string, string>;
    switch (sort) {
      case 'popular':
        orderBy = { installCount: 'desc' };
        break;
      case 'name':
        orderBy = { name: 'asc' };
        break;
      default:
        orderBy = { createdAt: 'desc' };
    }

    const [themes, total] = await Promise.all([
      prisma.communityTheme.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: { author: { select: authorSelect } },
      }),
      prisma.communityTheme.count({ where }),
    ]);

    res.json({
      success: true,
      data: themes.map(formatTheme),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    next(err);
  }
});

// ─── List user's own themes ──────────────────────────────────────────────────

themeRouter.get('/mine', rateLimitThemeBrowse, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const themes = await prisma.communityTheme.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: authorSelect } },
    });

    res.json({ success: true, data: themes.map(formatTheme) });
  } catch (err) {
    next(err);
  }
});

// ─── Get single theme ────────────────────────────────────────────────────────

themeRouter.get('/:themeId', rateLimitThemeBrowse, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;
    const userId = req.user!.userId;

    const theme = await prisma.communityTheme.findUnique({
      where: { id: themeId },
      include: { author: { select: authorSelect } },
    });

    if (!theme) throw new NotFoundError('Theme');

    // Only author can see non-published themes
    if (theme.status !== 'published' && theme.authorId !== userId) {
      throw new NotFoundError('Theme');
    }

    res.json({ success: true, data: formatTheme(theme) });
  } catch (err) {
    next(err);
  }
});

// ─── Create theme ────────────────────────────────────────────────────────────

themeRouter.post('/', rateLimitThemeManage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { name: rawName, description: rawDesc, tags: rawTags, colors } = req.body;

    // Validate name
    if (!rawName || typeof rawName !== 'string') throw new BadRequestError('Name is required');
    const name = sanitizeText(rawName.trim());
    const nameErr = validateThemeName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    // Validate description
    const description = sanitizeText((rawDesc ?? '').trim());
    const descErr = validateThemeDescription(description);
    if (descErr) throw new BadRequestError(descErr);

    // Validate tags
    if (rawTags !== undefined && !Array.isArray(rawTags)) throw new BadRequestError('Tags must be an array');
    const tags: string[] = [];
    if (Array.isArray(rawTags)) {
      if (rawTags.length > LIMITS.THEME_MAX_TAGS) throw new BadRequestError(`Maximum ${LIMITS.THEME_MAX_TAGS} tags allowed`);
      for (const rawTag of rawTags) {
        if (typeof rawTag !== 'string') throw new BadRequestError('Each tag must be a string');
        const tag = sanitizeText(rawTag.trim());
        const tagErr = validateThemeTag(tag);
        if (tagErr) throw new BadRequestError(tagErr);
        if (!tags.includes(tag)) tags.push(tag);
      }
    }

    // Validate colors
    if (!colors || typeof colors !== 'object') throw new BadRequestError('Colors object is required');
    const colorsErr = validateThemeColors(colors);
    if (colorsErr) throw new BadRequestError(colorsErr);

    // Validate and sanitize patterns (optional)
    const { patterns: rawPatterns } = req.body;
    let cleanPatterns: Record<string, unknown> | undefined;
    if (rawPatterns !== undefined && rawPatterns !== null) {
      if (typeof rawPatterns !== 'object') throw new BadRequestError('Patterns must be an object');
      const patternsErr = validateThemePatterns(rawPatterns);
      if (patternsErr) throw new BadRequestError(patternsErr);
      cleanPatterns = sanitizeThemePatterns(rawPatterns) as Record<string, unknown>;
    }

    // Check user theme limit
    const count = await prisma.communityTheme.count({ where: { authorId: userId } });
    if (count >= LIMITS.THEME_MAX_PER_USER) {
      throw new BadRequestError(`You can create a maximum of ${LIMITS.THEME_MAX_PER_USER} themes`);
    }

    const theme = await prisma.communityTheme.create({
      data: {
        name,
        description,
        tags,
        colors,
        ...(cleanPatterns ? { patterns: cleanPatterns as object } : {}),
        authorId: userId,
      },
      include: { author: { select: authorSelect } },
    });

    res.status(201).json({ success: true, data: formatTheme(theme) });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return next(new BadRequestError('You already have a theme with that name'));
    }
    next(err);
  }
});

// ─── Update theme ────────────────────────────────────────────────────────────

themeRouter.patch('/:themeId', rateLimitThemeManage, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;
    const userId = req.user!.userId;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId } });
    if (!theme) throw new NotFoundError('Theme');
    if (theme.authorId !== userId) throw new ForbiddenError('You can only edit your own themes');

    const updates: Record<string, unknown> = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string') throw new BadRequestError('Name must be a string');
      const name = sanitizeText(req.body.name.trim());
      const nameErr = validateThemeName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      updates.name = name;
    }

    if (req.body.description !== undefined) {
      if (typeof req.body.description !== 'string') throw new BadRequestError('Description must be a string');
      const description = sanitizeText(req.body.description.trim());
      const descErr = validateThemeDescription(description);
      if (descErr) throw new BadRequestError(descErr);
      updates.description = description;
    }

    if (req.body.tags !== undefined) {
      if (!Array.isArray(req.body.tags)) throw new BadRequestError('Tags must be an array');
      if (req.body.tags.length > LIMITS.THEME_MAX_TAGS) throw new BadRequestError(`Maximum ${LIMITS.THEME_MAX_TAGS} tags allowed`);
      const tags: string[] = [];
      for (const rawTag of req.body.tags) {
        if (typeof rawTag !== 'string') throw new BadRequestError('Each tag must be a string');
        const tag = sanitizeText(rawTag.trim());
        const tagErr = validateThemeTag(tag);
        if (tagErr) throw new BadRequestError(tagErr);
        if (!tags.includes(tag)) tags.push(tag);
      }
      updates.tags = tags;
    }

    if (req.body.colors !== undefined) {
      if (typeof req.body.colors !== 'object') throw new BadRequestError('Colors must be an object');
      const colorsErr = validateThemeColors(req.body.colors);
      if (colorsErr) throw new BadRequestError(colorsErr);
      updates.colors = req.body.colors;
      // Bump version when colors change so installed copies can detect updates
      updates.version = theme.version + 1;
    }

    if (req.body.patterns !== undefined) {
      if (req.body.patterns === null) {
        updates.patterns = null as unknown; // clear patterns
      } else {
        if (typeof req.body.patterns !== 'object') throw new BadRequestError('Patterns must be an object');
        const patternsErr = validateThemePatterns(req.body.patterns);
        if (patternsErr) throw new BadRequestError(patternsErr);
        updates.patterns = sanitizeThemePatterns(req.body.patterns) as object;
      }
      // Bump version for pattern changes too
      if (!updates.version) updates.version = theme.version + 1;
    }

    const updated = await prisma.communityTheme.update({
      where: { id: themeId },
      data: updates,
      include: { author: { select: authorSelect } },
    });

    // If published, broadcast update
    if (updated.status === 'published') {
      const io = getIO();
      io.emit('theme:updated', formatTheme(updated));
    }

    res.json({ success: true, data: formatTheme(updated) });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return next(new BadRequestError('You already have a theme with that name'));
    }
    next(err);
  }
});

// ─── Delete theme ────────────────────────────────────────────────────────────

themeRouter.delete('/:themeId', rateLimitThemeManage, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;
    const userId = req.user!.userId;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId } });
    if (!theme) throw new NotFoundError('Theme');
    if (theme.authorId !== userId) throw new ForbiddenError('You can only delete your own themes');

    const wasPublished = theme.status === 'published';
    await prisma.communityTheme.delete({ where: { id: themeId } });

    // If was published, notify clients
    if (wasPublished) {
      const io = getIO();
      io.emit('theme:removed', { themeId });
    }

    res.json({ success: true, message: 'Theme deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Publish theme ───────────────────────────────────────────────────────────

themeRouter.post('/:themeId/publish', rateLimitThemeManage, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;
    const userId = req.user!.userId;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId } });
    if (!theme) throw new NotFoundError('Theme');
    if (theme.authorId !== userId) throw new ForbiddenError('You can only publish your own themes');
    if (theme.status === 'published') throw new BadRequestError('Theme is already published');
    if (theme.status === 'removed') throw new ForbiddenError('This theme has been removed by an admin');

    const updated = await prisma.communityTheme.update({
      where: { id: themeId },
      data: { status: 'published' },
      include: { author: { select: authorSelect } },
    });

    const io = getIO();
    io.emit('theme:published', formatTheme(updated));

    res.json({ success: true, data: formatTheme(updated) });
  } catch (err) {
    next(err);
  }
});

// ─── Unpublish theme ─────────────────────────────────────────────────────────

themeRouter.post('/:themeId/unpublish', rateLimitThemeManage, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;
    const userId = req.user!.userId;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId } });
    if (!theme) throw new NotFoundError('Theme');
    if (theme.authorId !== userId) throw new ForbiddenError('You can only unpublish your own themes');
    if (theme.status !== 'published') throw new BadRequestError('Theme is not published');

    const updated = await prisma.communityTheme.update({
      where: { id: themeId },
      data: { status: 'draft' },
      include: { author: { select: authorSelect } },
    });

    const io = getIO();
    io.emit('theme:removed', { themeId });

    res.json({ success: true, data: formatTheme(updated) });
  } catch (err) {
    next(err);
  }
});

// ─── Install (increment count) ──────────────────────────────────────────────

themeRouter.post('/:themeId/install', rateLimitThemeBrowse, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId }, select: { id: true, status: true } });
    if (!theme) throw new NotFoundError('Theme');
    if (theme.status !== 'published') throw new BadRequestError('Theme is not published');

    await prisma.communityTheme.update({
      where: { id: themeId },
      data: { installCount: { increment: 1 } },
    });

    res.json({ success: true, message: 'Install count incremented' });
  } catch (err) {
    next(err);
  }
});

// ─── Uninstall (decrement count) ─────────────────────────────────────────────

themeRouter.post('/:themeId/uninstall', rateLimitThemeBrowse, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId }, select: { id: true, status: true, installCount: true } });
    if (!theme) throw new NotFoundError('Theme');
    if (theme.installCount <= 0) {
      return res.json({ success: true, message: 'Install count already at zero' });
    }

    // Use a WHERE guard to prevent going negative under concurrent requests
    await prisma.communityTheme.updateMany({
      where: { id: themeId, installCount: { gt: 0 } },
      data: { installCount: { decrement: 1 } },
    });

    res.json({ success: true, message: 'Install count decremented' });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: remove a published theme ─────────────────────────────────────────

themeRouter.post('/:themeId/remove', requireAdmin, rateLimitThemeManage, async (req: Request<{ themeId: string }>, res: Response, next: NextFunction) => {
  try {
    const { themeId } = req.params;

    const theme = await prisma.communityTheme.findUnique({ where: { id: themeId } });
    if (!theme) throw new NotFoundError('Theme');

    await prisma.communityTheme.update({
      where: { id: themeId },
      data: { status: 'removed' },
    });

    const io = getIO();
    io.emit('theme:removed', { themeId });

    res.json({ success: true, message: 'Theme removed' });
  } catch (err) {
    next(err);
  }
});
