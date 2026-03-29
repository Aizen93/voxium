import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitEmojiManage, rateLimitGeneral } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { Permissions, LIMITS, ALLOWED_EMOJI_TYPES, validateEmojiName } from '@voxium/shared';
import { hasServerPermission } from '../utils/permissionCalculator';
import { generatePresignedPutUrl, deleteFromS3, VALID_S3_KEY_RE } from '../utils/s3';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import crypto from 'crypto';

// ─── Server-Scoped Emoji Routes (/servers/:serverId/emojis) ─────────────────

export const serverEmojiRouter = Router({ mergeParams: true });

// GET /servers/:serverId/emojis — list custom emojis for a server
serverEmojiRouter.get(
  '/',
  authenticate,
  requireVerifiedEmail,
  rateLimitGeneral,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!membership) throw new ForbiddenError('Not a member of this server');

      const emojis = await prisma.customEmoji.findMany({
        where: { serverId },
        orderBy: { name: 'asc' },
      });

      res.json({
        success: true,
        data: emojis.map((e) => ({
          id: e.id, serverId: e.serverId, name: e.name, s3Key: e.s3Key,
          animated: e.animated, creatorId: e.creatorId, createdAt: e.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /servers/:serverId/emojis — create a custom emoji
serverEmojiRouter.post(
  '/',
  authenticate,
  requireVerifiedEmail,
  rateLimitEmojiManage,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const userId = req.user!.userId;

      // Permission check
      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage emojis');

      const { name, s3Key, animated } = req.body;

      // Validate name
      if (typeof name !== 'string') throw new BadRequestError('name is required');
      const sanitizedName = sanitizeText(name);
      const nameErr = validateEmojiName(sanitizedName);
      if (nameErr) throw new BadRequestError(nameErr);

      // Validate s3Key format and prefix
      if (typeof s3Key !== 'string' || !s3Key.startsWith(`emojis/srv-${serverId}/`) || !VALID_S3_KEY_RE.test(s3Key)) {
        throw new BadRequestError('Invalid s3Key');
      }

      // Enforce limit
      const count = await prisma.customEmoji.count({ where: { serverId } });
      if (count >= LIMITS.MAX_CUSTOM_EMOJIS_PER_SERVER) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_CUSTOM_EMOJIS_PER_SERVER} custom emojis per server`);
      }

      // Create emoji — DB unique constraint (serverId, name) handles race conditions
      let emoji;
      try {
        emoji = await prisma.customEmoji.create({
          data: {
            serverId,
            name: sanitizedName,
            s3Key,
            animated: animated === true,
            creatorId: userId,
          },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new BadRequestError('An emoji with this name already exists');
        }
        throw err;
      }

      // Broadcast to server room
      getIO().to(`server:${serverId}`).emit('emoji:created', {
        serverId,
        emoji: {
          id: emoji.id,
          serverId: emoji.serverId,
          name: emoji.name,
          s3Key: emoji.s3Key,
          animated: emoji.animated,
          creatorId: emoji.creatorId,
          createdAt: emoji.createdAt.toISOString(),
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: emoji.id, serverId: emoji.serverId, name: emoji.name, s3Key: emoji.s3Key,
          animated: emoji.animated, creatorId: emoji.creatorId, createdAt: emoji.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /servers/:serverId/emojis/:emojiId — rename a custom emoji
serverEmojiRouter.patch(
  '/:emojiId',
  authenticate,
  requireVerifiedEmail,
  rateLimitEmojiManage,
  async (req: Request<{ serverId: string; emojiId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, emojiId } = req.params;
      const userId = req.user!.userId;

      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage emojis');

      const emoji = await prisma.customEmoji.findUnique({ where: { id: emojiId } });
      if (!emoji || emoji.serverId !== serverId) throw new NotFoundError('Emoji');

      const { name } = req.body;
      if (typeof name !== 'string') throw new BadRequestError('name is required');
      const sanitizedName = sanitizeText(name);
      const nameErr = validateEmojiName(sanitizedName);
      if (nameErr) throw new BadRequestError(nameErr);

      let updated;
      try {
        updated = await prisma.customEmoji.update({
          where: { id: emojiId },
          data: { name: sanitizedName },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new BadRequestError('An emoji with this name already exists');
        }
        throw err;
      }

      // Broadcast rename — reuse emoji:created (addEmoji overwrites by ID)
      getIO().to(`server:${serverId}`).emit('emoji:created', {
        serverId,
        emoji: {
          id: updated.id,
          serverId: updated.serverId,
          name: updated.name,
          s3Key: updated.s3Key,
          animated: updated.animated,
          creatorId: updated.creatorId,
          createdAt: updated.createdAt.toISOString(),
        },
      });

      res.json({
        success: true,
        data: {
          id: updated.id, serverId: updated.serverId, name: updated.name, s3Key: updated.s3Key,
          animated: updated.animated, creatorId: updated.creatorId, createdAt: updated.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /servers/:serverId/emojis/:emojiId — delete a custom emoji
serverEmojiRouter.delete(
  '/:emojiId',
  authenticate,
  requireVerifiedEmail,
  rateLimitEmojiManage,
  async (req: Request<{ serverId: string; emojiId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, emojiId } = req.params;
      const userId = req.user!.userId;

      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage emojis');

      const emoji = await prisma.customEmoji.findUnique({ where: { id: emojiId } });
      if (!emoji || emoji.serverId !== serverId) throw new NotFoundError('Emoji');

      // Delete DB record first (authoritative), then best-effort S3 cleanup
      await prisma.customEmoji.delete({ where: { id: emojiId } });

      deleteFromS3(emoji.s3Key).catch((err) =>
        console.warn(`[Emoji] S3 cleanup failed for ${emoji.s3Key} (orphaned):`, err),
      );

      // Broadcast to server room
      getIO().to(`server:${serverId}`).emit('emoji:deleted', { serverId, emojiId });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Global Emoji Resolve Route (/emojis/:emojiId) ─────────────────────────

export const emojiResolveRouter = Router();

// GET /emojis/:emojiId — resolve a single emoji by ID (for DM usage)
emojiResolveRouter.get(
  '/:emojiId',
  authenticate,
  requireVerifiedEmail,
  rateLimitGeneral,
  async (req: Request<{ emojiId: string }>, res: Response, next: NextFunction) => {
    try {
      const emoji = await prisma.customEmoji.findUnique({
        where: { id: req.params.emojiId },
      });
      if (!emoji) throw new NotFoundError('Emoji');

      res.json({
        success: true,
        data: {
          id: emoji.id, serverId: emoji.serverId, name: emoji.name, s3Key: emoji.s3Key,
          animated: emoji.animated, creatorId: emoji.creatorId, createdAt: emoji.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Emoji Upload Presign (/uploads/presign/emoji/:serverId) ────────────────

export function registerEmojiPresignRoute(uploadRouter: Router): void {
  uploadRouter.post(
    '/presign/emoji/:serverId',
    authenticate,
    requireVerifiedEmail,
    rateLimitEmojiManage,
    async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
      try {
        const { serverId } = req.params;
        const userId = req.user!.userId;

        // Permission check
        const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
        if (!canManage) throw new ForbiddenError('You do not have permission to manage emojis');

        const { fileName, fileSize, mimeType } = req.body;

        if (!fileName || typeof fileName !== 'string') throw new BadRequestError('fileName required');
        if (!mimeType || typeof mimeType !== 'string') throw new BadRequestError('mimeType required');
        if (!ALLOWED_EMOJI_TYPES.includes(mimeType as typeof ALLOWED_EMOJI_TYPES[number])) {
          throw new BadRequestError('File type not allowed for emojis (PNG, WebP, or GIF only)');
        }
        if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > LIMITS.MAX_EMOJI_FILE_SIZE) {
          throw new BadRequestError(`Invalid file size (max ${LIMITS.MAX_EMOJI_FILE_SIZE / 1024}KB)`);
        }

        const ext = mimeType === 'image/gif' ? 'gif' : mimeType === 'image/png' ? 'png' : 'webp';
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const key = `emojis/srv-${serverId}/${id}.${ext}`;
        const uploadUrl = await generatePresignedPutUrl(key, mimeType);

        res.json({ success: true, data: { uploadUrl, key } });
      } catch (err) {
        next(err);
      }
    },
  );
}
