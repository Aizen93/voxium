import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimitUpload } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { generatePresignedPutUrl, generatePresignedGetUrl, VALID_S3_KEY_RE } from '../utils/s3';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export const uploadRouter = Router();

// POST /uploads/presign/avatar — get a presigned PUT URL for avatar upload
uploadRouter.post(
  '/presign/avatar',
  authenticate,
  rateLimitUpload,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `avatars/${req.user!.userId}-${Date.now()}.webp`;
      const uploadUrl = await generatePresignedPutUrl(key, 'image/webp');

      res.json({ success: true, data: { uploadUrl, key } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /uploads/presign/server-icon/:serverId — get a presigned PUT URL for server icon upload (owner only)
uploadRouter.post(
  '/presign/server-icon/:serverId',
  authenticate,
  rateLimitUpload,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw new NotFoundError('Server');
      if (server.ownerId !== req.user!.userId) throw new ForbiddenError('Only the server owner can change the icon');

      const key = `server-icons/${serverId}-${Date.now()}.webp`;
      const uploadUrl = await generatePresignedPutUrl(key, 'image/webp');

      res.json({ success: true, data: { uploadUrl, key } });
    } catch (err) {
      next(err);
    }
  },
);

// GET /uploads/* — redirect to presigned S3 GET URL
uploadRouter.get(
  '/*',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.params[0];
      if (!key || key.includes('..') || !VALID_S3_KEY_RE.test(key)) {
        throw new BadRequestError('Invalid key');
      }

      const url = await generatePresignedGetUrl(key);
      res.set('Cache-Control', 'no-cache');
      res.redirect(302, url);
    } catch (err) {
      // generatePresignedGetUrl signs locally; S3 errors surface on the client redirect
      next(err);
    }
  },
);
