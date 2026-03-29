import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitGifSearch, rateLimitUpload } from '../middleware/rateLimiter';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { isFeatureEnabled } from '../utils/featureFlags';
import { prisma } from '../utils/prisma';
import { generatePresignedPutUrl, deleteFromS3, VALID_S3_KEY_RE } from '../utils/s3';
import { sanitizeText } from '../utils/sanitize';
import { LIMITS } from '@voxium/shared';
import type { GiphyGif } from '@voxium/shared';
import crypto from 'crypto';

export const gifRouter = Router();

// ─── Giphy API helpers ─────────────────────────────────────────────────────

interface GiphyApiGif {
  id: string;
  title: string;
  images: {
    original?: { url: string; width: string; height: string };
    fixed_height?: { url: string; width: string; height: string };
    fixed_width_small?: { url: string; width: string; height: string };
  };
}

function parseGiphyResponse(data: { data: GiphyApiGif[]; pagination: { offset: number; total_count: number; count: number } }): { gifs: GiphyGif[]; offset: number; totalCount: number } {
  const gifs: GiphyGif[] = data.data.map((g) => ({
    id: g.id,
    title: g.title || '',
    url: g.images.original?.url || g.images.fixed_height?.url || '',
    previewUrl: g.images.fixed_width_small?.url || g.images.fixed_height?.url || '',
    width: parseInt(g.images.original?.width || g.images.fixed_height?.width || '0') || 0,
    height: parseInt(g.images.original?.height || g.images.fixed_height?.height || '0') || 0,
  })).filter((g) => g.url);

  return {
    gifs,
    offset: data.pagination.offset + data.pagination.count,
    totalCount: data.pagination.total_count,
  };
}

function requireGiphy(res: Response): string | null {
  if (!isFeatureEnabled('gif_giphy')) {
    res.status(404).json({ success: false, error: 'Giphy GIF search is not enabled' });
    return null;
  }
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    res.status(503).json({ success: false, error: 'Giphy is not configured' });
    return null;
  }
  return apiKey;
}

function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(query.limit as string) || LIMITS.GIPHY_RESULTS_PER_PAGE, 1), 50);
  const offset = Math.max(parseInt(query.offset as string) || 0, 0);
  return { limit, offset };
}

// ─── Giphy Proxy Routes ────────────────────────────────────────────────────

// GET /gifs/giphy/search?q=&limit=&offset=
gifRouter.get(
  '/giphy/search',
  authenticate,
  requireVerifiedEmail,
  rateLimitGifSearch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const apiKey = requireGiphy(res);
      if (!apiKey) return;

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q || q.length < 1) throw new BadRequestError('Search query is required');
      if (q.length > 100) throw new BadRequestError('Search query too long');

      const { limit, offset } = parsePagination(req.query);

      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('q', q);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('rating', 'pg-13');
      url.searchParams.set('lang', 'en');

      const response = await fetch(url.toString());
      if (!response.ok) {
        console.error(`[GIF] Giphy search failed: ${response.status} ${response.statusText}`);
        return res.status(502).json({ success: false, error: 'GIF search failed' });
      }

      const data = await response.json() as { data: GiphyApiGif[]; pagination: { offset: number; total_count: number; count: number } };
      res.json({ success: true, data: parseGiphyResponse(data) });
    } catch (err) {
      next(err);
    }
  },
);

// GET /gifs/giphy/trending?limit=&offset=
gifRouter.get(
  '/giphy/trending',
  authenticate,
  requireVerifiedEmail,
  rateLimitGifSearch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const apiKey = requireGiphy(res);
      if (!apiKey) return;

      const { limit, offset } = parsePagination(req.query);

      const url = new URL('https://api.giphy.com/v1/gifs/trending');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('rating', 'pg-13');

      const response = await fetch(url.toString());
      if (!response.ok) {
        console.error(`[GIF] Giphy trending failed: ${response.status} ${response.statusText}`);
        return res.status(502).json({ success: false, error: 'GIF search failed' });
      }

      const data = await response.json() as { data: GiphyApiGif[]; pagination: { offset: number; total_count: number; count: number } };
      res.json({ success: true, data: parseGiphyResponse(data) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Self-Hosted GIF Library Routes ────────────────────────────────────────

// GET /gifs/library?q=&limit=&offset= — search community GIF library
gifRouter.get(
  '/library',
  authenticate,
  requireVerifiedEmail,
  rateLimitGifSearch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const { limit, offset } = parsePagination(req.query);

      const where = q
        ? { OR: [
            { fileName: { contains: q, mode: 'insensitive' as const } },
            { tags: { has: q.toLowerCase() } },
          ]}
        : {};

      const [gifs, total] = await Promise.all([
        prisma.gifUpload.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.gifUpload.count({ where }),
      ]);

      res.json({
        success: true,
        data: {
          gifs: gifs.map((g) => ({
            id: g.id,
            s3Key: g.s3Key,
            fileName: g.fileName,
            fileSize: g.fileSize,
            tags: g.tags,
            uploaderId: g.uploaderId,
            createdAt: g.createdAt.toISOString(),
          })),
          total,
          offset,
          limit,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /gifs/my — list user's own uploaded GIFs
gifRouter.get(
  '/my',
  authenticate,
  requireVerifiedEmail,
  rateLimitGifSearch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gifs = await prisma.gifUpload.findMany({
        where: { uploaderId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
      });

      res.json({
        success: true,
        data: gifs.map((g) => ({
          id: g.id,
          s3Key: g.s3Key,
          fileName: g.fileName,
          fileSize: g.fileSize,
          tags: g.tags,
          uploaderId: g.uploaderId,
          createdAt: g.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /gifs — upload a GIF to the community library
gifRouter.post(
  '/',
  authenticate,
  requireVerifiedEmail,
  rateLimitUpload,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { s3Key, fileName, fileSize, tags } = req.body;

      if (typeof s3Key !== 'string' || !s3Key.startsWith(`gifs/usr-${userId}/`) || !VALID_S3_KEY_RE.test(s3Key)) {
        throw new BadRequestError('Invalid s3Key');
      }
      if (typeof fileName !== 'string' || !fileName) throw new BadRequestError('fileName required');
      if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > LIMITS.MAX_GIF_FILE_SIZE) {
        throw new BadRequestError(`Invalid file size (max ${LIMITS.MAX_GIF_FILE_SIZE / 1024 / 1024}MB)`);
      }

      // Validate and sanitize tags
      let sanitizedTags: string[] = [];
      if (Array.isArray(tags)) {
        sanitizedTags = tags
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .slice(0, LIMITS.MAX_GIF_TAGS)
          .map((t) => sanitizeText(t).toLowerCase().slice(0, LIMITS.MAX_GIF_TAG_LENGTH))
          .filter((t) => t.length > 0);
      }

      // Enforce per-user limit
      const count = await prisma.gifUpload.count({ where: { uploaderId: userId } });
      if (count >= LIMITS.MAX_GIFS_PER_USER) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_GIFS_PER_USER} GIFs per user`);
      }

      const gif = await prisma.gifUpload.create({
        data: { s3Key, fileName: sanitizeText(fileName), fileSize, tags: sanitizedTags, uploaderId: userId },
      });

      res.status(201).json({
        success: true,
        data: {
          id: gif.id, s3Key: gif.s3Key, fileName: gif.fileName, fileSize: gif.fileSize,
          tags: gif.tags, uploaderId: gif.uploaderId, createdAt: gif.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /gifs/:gifId — delete own GIF from library
gifRouter.delete(
  '/:gifId',
  authenticate,
  requireVerifiedEmail,
  rateLimitUpload,
  async (req: Request<{ gifId: string }>, res: Response, next: NextFunction) => {
    try {
      const gif = await prisma.gifUpload.findUnique({ where: { id: req.params.gifId } });
      if (!gif || gif.uploaderId !== req.user!.userId) throw new NotFoundError('GIF');

      await prisma.gifUpload.delete({ where: { id: gif.id } });

      deleteFromS3(gif.s3Key).catch((err) =>
        console.warn(`[GIF] S3 cleanup failed for ${gif.s3Key} (orphaned):`, err),
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GIF Upload Presign ────────────────────────────────────────────────────

export function registerGifPresignRoute(uploadRouter: Router): void {
  uploadRouter.post(
    '/presign/gif',
    authenticate,
    requireVerifiedEmail,
    rateLimitUpload,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.userId;
        const { fileName, fileSize, mimeType } = req.body;

        if (!fileName || typeof fileName !== 'string') throw new BadRequestError('fileName required');
        if (!mimeType || typeof mimeType !== 'string') throw new BadRequestError('mimeType required');
        if (mimeType !== 'image/gif') throw new BadRequestError('Only GIF files are allowed');
        if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > LIMITS.MAX_GIF_FILE_SIZE) {
          throw new BadRequestError(`Invalid file size (max ${LIMITS.MAX_GIF_FILE_SIZE / 1024 / 1024}MB)`);
        }

        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const key = `gifs/usr-${userId}/${id}.gif`;
        const uploadUrl = await generatePresignedPutUrl(key, mimeType);

        res.json({ success: true, data: { uploadUrl, key } });
      } catch (err) {
        next(err);
      }
    },
  );
}
