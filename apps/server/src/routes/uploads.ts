import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import { authenticate } from '../middleware/auth';
import { rateLimitUpload } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { uploadToS3, streamFromS3, deleteFromS3, VALID_S3_KEY_RE } from '../utils/s3';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { getIO } from '../websocket/socketServer';
import { WS_EVENTS } from '@voxium/shared';

// ─── Multer config ──────────────────────────────────────────────────────────

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIMES.has(file.mimetype) && ALLOWED_EXTS.has(ext)) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Only image files are allowed (JPG, PNG, WebP, GIF)'));
    }
  },
});

// ─── Shared sharp pipeline ──────────────────────────────────────────────────

async function processImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(256, 256, { fit: 'cover' })
    .webp({ quality: 85 })
    .toBuffer();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const uploadRouter = Router();

// POST /uploads/avatar — upload user avatar
uploadRouter.post(
  '/avatar',
  authenticate,
  rateLimitUpload,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new BadRequestError('No file uploaded');

      const processed = await processImage(req.file.buffer);

      // Fetch old avatar key + displayName before uploading
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { avatarUrl: true, displayName: true },
      });

      // Upload new avatar first, then update DB, then delete old one.
      // This ordering ensures the user never loses their avatar if the upload fails.
      const key = await uploadToS3('avatars', req.user!.userId, processed);

      await prisma.user.update({
        where: { id: req.user!.userId },
        data: { avatarUrl: key },
      });

      // Delete old avatar after the new one is confirmed saved
      if (user?.avatarUrl) {
        await deleteFromS3(user.avatarUrl).catch(() => {
          // Non-critical: old file becomes orphaned but user experience is unaffected
        });
      }

      // Broadcast to all servers the user is in so other members see the new avatar
      const memberships = await prisma.serverMember.findMany({
        where: { userId: req.user!.userId },
        select: { serverId: true },
      });
      const io = getIO();
      const payload = { userId: req.user!.userId, displayName: user?.displayName || '', avatarUrl: key };
      for (const { serverId } of memberships) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.USER_UPDATED as any, payload);
      }

      res.json({ success: true, data: { key } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /uploads/server-icon/:serverId — upload server icon (owner only)
uploadRouter.post(
  '/server-icon/:serverId',
  authenticate,
  rateLimitUpload,
  upload.single('file'),
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new BadRequestError('No file uploaded');

      const { serverId } = req.params;
      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw new NotFoundError('Server');
      if (server.ownerId !== req.user!.userId) throw new ForbiddenError('Only the server owner can change the icon');

      const processed = await processImage(req.file.buffer);
      const oldIconUrl = server.iconUrl;

      // Upload new icon first, then update DB, then delete old one.
      // This ordering ensures the server never loses its icon if the upload fails.
      const key = await uploadToS3('server-icons', serverId, processed);

      const updated = await prisma.server.update({
        where: { id: serverId },
        data: { iconUrl: key },
        select: { id: true, name: true, iconUrl: true, ownerId: true, createdAt: true },
      });

      // Delete old icon after the new one is confirmed saved
      if (oldIconUrl) {
        await deleteFromS3(oldIconUrl).catch(() => {
          // Non-critical: old file becomes orphaned but user experience is unaffected
        });
      }

      // Broadcast to all server members so their sidebar icons update in real-time
      getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED as any, updated);

      res.json({ success: true, data: { key } });
    } catch (err) {
      next(err);
    }
  },
);

// GET /uploads/* — serve file from S3
uploadRouter.get(
  '/*',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.params[0];
      // Reject empty keys, path traversal, and keys outside known folders
      if (!key || key.includes('..') || !VALID_S3_KEY_RE.test(key)) {
        throw new BadRequestError('Invalid key');
      }

      const { stream, contentType, contentLength } = await streamFromS3(key);

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      if (contentLength !== undefined) {
        res.set('Content-Length', String(contentLength));
      }

      stream.pipe(res);
      // Clean up S3 stream if the client disconnects mid-transfer
      res.on('close', () => {
        if (!res.writableFinished) {
          stream.destroy();
        }
      });
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return next(new NotFoundError('File'));
      }
      next(err);
    }
  },
);
