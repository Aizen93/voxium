import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitStickerManage, rateLimitGeneral } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { Permissions, LIMITS, ALLOWED_EMOJI_TYPES, validateStickerPackName, validateStickerName } from '@voxium/shared';
import { hasServerPermission } from '../utils/permissionCalculator';
import { generatePresignedPutUrl, deleteFromS3, deleteMultipleFromS3, VALID_S3_KEY_RE } from '../utils/s3';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import crypto from 'crypto';

// ─── Helpers ────────────────────────────────────────────────────────────────

function serializePack(pack: { id: string; name: string; description: string; serverId: string | null; userId: string | null; createdAt: Date; stickers: { id: string; packId: string; name: string; s3Key: string; createdAt: Date }[] }) {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    serverId: pack.serverId,
    userId: pack.userId,
    createdAt: pack.createdAt.toISOString(),
    stickers: pack.stickers.map((s) => ({
      id: s.id,
      packId: s.packId,
      name: s.name,
      s3Key: s.s3Key,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

// ─── Server Sticker Packs (/servers/:serverId/sticker-packs) ────────────────

export const serverStickerRouter = Router({ mergeParams: true });

// GET /servers/:serverId/sticker-packs — list server sticker packs
serverStickerRouter.get(
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

      const packs = await prisma.stickerPack.findMany({
        where: { serverId },
        include: { stickers: { orderBy: { name: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      });

      res.json({ success: true, data: packs.map(serializePack) });
    } catch (err) {
      next(err);
    }
  },
);

// POST /servers/:serverId/sticker-packs — create a server sticker pack
serverStickerRouter.post(
  '/',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const userId = req.user!.userId;

      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage stickers');

      const { name, description } = req.body;
      if (typeof name !== 'string') throw new BadRequestError('name is required');
      const sanitizedName = sanitizeText(name);
      const nameErr = validateStickerPackName(sanitizedName);
      if (nameErr) throw new BadRequestError(nameErr);

      const sanitizedDesc = typeof description === 'string' ? sanitizeText(description).slice(0, LIMITS.MAX_STICKER_PACK_DESCRIPTION_LENGTH) : '';

      // Enforce limit
      const count = await prisma.stickerPack.count({ where: { serverId } });
      if (count >= LIMITS.MAX_STICKER_PACKS_PER_SERVER) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_STICKER_PACKS_PER_SERVER} sticker packs per server`);
      }

      const pack = await prisma.stickerPack.create({
        data: { name: sanitizedName, description: sanitizedDesc, serverId },
        include: { stickers: true },
      });

      const serialized = serializePack(pack);
      getIO().to(`server:${serverId}`).emit('sticker:pack_created', { pack: serialized });

      res.status(201).json({ success: true, data: serialized });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /servers/:serverId/sticker-packs/:packId — delete a server sticker pack
serverStickerRouter.delete(
  '/:packId',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ serverId: string; packId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, packId } = req.params;
      const userId = req.user!.userId;

      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage stickers');

      const pack = await prisma.stickerPack.findUnique({
        where: { id: packId },
        include: { stickers: { select: { s3Key: true } } },
      });
      if (!pack || pack.serverId !== serverId) throw new NotFoundError('Sticker pack');

      // Delete DB first (authoritative, cascades stickers), then best-effort S3 cleanup
      const keys = pack.stickers.map((s) => s.s3Key);
      await prisma.stickerPack.delete({ where: { id: packId } });

      if (keys.length > 0) {
        deleteMultipleFromS3(keys).catch((err) =>
          console.warn(`[Sticker] S3 cleanup failed for pack ${packId} (orphaned):`, err),
        );
      }

      getIO().to(`server:${serverId}`).emit('sticker:pack_deleted', { packId, serverId });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// POST /servers/:serverId/sticker-packs/:packId/stickers — add a sticker to a pack
serverStickerRouter.post(
  '/:packId/stickers',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ serverId: string; packId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, packId } = req.params;
      const userId = req.user!.userId;

      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage stickers');

      const pack = await prisma.stickerPack.findUnique({ where: { id: packId } });
      if (!pack || pack.serverId !== serverId) throw new NotFoundError('Sticker pack');

      const { name, s3Key } = req.body;
      if (typeof name !== 'string') throw new BadRequestError('name is required');
      const sanitizedName = sanitizeText(name);
      const nameErr = validateStickerName(sanitizedName);
      if (nameErr) throw new BadRequestError(nameErr);

      if (typeof s3Key !== 'string' || !s3Key.startsWith(`stickers/pack-${packId}/`) || !VALID_S3_KEY_RE.test(s3Key)) {
        throw new BadRequestError('Invalid s3Key');
      }

      // Enforce limit
      const count = await prisma.sticker.count({ where: { packId } });
      if (count >= LIMITS.MAX_STICKERS_PER_PACK) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_STICKERS_PER_PACK} stickers per pack`);
      }

      // Create sticker — DB unique constraint (packId, name) handles race conditions
      let sticker;
      try {
        sticker = await prisma.sticker.create({
          data: { packId, name: sanitizedName, s3Key },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new BadRequestError('A sticker with this name already exists in this pack');
        }
        throw err;
      }

      const serialized = { id: sticker.id, packId: sticker.packId, name: sticker.name, s3Key: sticker.s3Key, createdAt: sticker.createdAt.toISOString() };
      getIO().to(`server:${serverId}`).emit('sticker:added', { packId, sticker: serialized });

      res.status(201).json({ success: true, data: serialized });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /servers/:serverId/sticker-packs/:packId/stickers/:stickerId — remove a sticker
serverStickerRouter.delete(
  '/:packId/stickers/:stickerId',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ serverId: string; packId: string; stickerId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, packId, stickerId } = req.params;
      const userId = req.user!.userId;

      const canManage = await hasServerPermission(userId, serverId, Permissions.MANAGE_EMOJIS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage stickers');

      const sticker = await prisma.sticker.findUnique({ where: { id: stickerId } });
      if (!sticker || sticker.packId !== packId) throw new NotFoundError('Sticker');

      // Verify pack belongs to server
      const pack = await prisma.stickerPack.findUnique({ where: { id: packId } });
      if (!pack || pack.serverId !== serverId) throw new NotFoundError('Sticker pack');

      await prisma.sticker.delete({ where: { id: stickerId } });

      deleteFromS3(sticker.s3Key).catch((err) =>
        console.warn(`[Sticker] S3 cleanup failed for ${sticker.s3Key} (orphaned):`, err),
      );

      getIO().to(`server:${serverId}`).emit('sticker:removed', { packId, stickerId });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Personal Sticker Packs (/stickers/personal) ───────────────────────────

export const personalStickerRouter = Router();

// GET /stickers/personal — list user's personal sticker packs
personalStickerRouter.get(
  '/personal',
  authenticate,
  requireVerifiedEmail,
  rateLimitGeneral,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const packs = await prisma.stickerPack.findMany({
        where: { userId: req.user!.userId },
        include: { stickers: { orderBy: { name: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      });

      res.json({ success: true, data: packs.map(serializePack) });
    } catch (err) {
      next(err);
    }
  },
);

// POST /stickers/personal — create a personal sticker pack
personalStickerRouter.post(
  '/personal',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      const { name, description } = req.body;
      if (typeof name !== 'string') throw new BadRequestError('name is required');
      const sanitizedName = sanitizeText(name);
      const nameErr = validateStickerPackName(sanitizedName);
      if (nameErr) throw new BadRequestError(nameErr);

      const sanitizedDesc = typeof description === 'string' ? sanitizeText(description).slice(0, LIMITS.MAX_STICKER_PACK_DESCRIPTION_LENGTH) : '';

      // Enforce limit
      const count = await prisma.stickerPack.count({ where: { userId } });
      if (count >= LIMITS.MAX_PERSONAL_STICKER_PACKS) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_PERSONAL_STICKER_PACKS} personal sticker packs`);
      }

      const pack = await prisma.stickerPack.create({
        data: { name: sanitizedName, description: sanitizedDesc, userId },
        include: { stickers: true },
      });

      res.status(201).json({ success: true, data: serializePack(pack) });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /stickers/personal/:packId — delete own personal sticker pack
personalStickerRouter.delete(
  '/personal/:packId',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ packId: string }>, res: Response, next: NextFunction) => {
    try {
      const { packId } = req.params;
      const userId = req.user!.userId;

      const pack = await prisma.stickerPack.findUnique({
        where: { id: packId },
        include: { stickers: { select: { s3Key: true } } },
      });
      if (!pack || pack.userId !== userId) throw new NotFoundError('Sticker pack');

      const keys = pack.stickers.map((s) => s.s3Key);
      await prisma.stickerPack.delete({ where: { id: packId } });

      if (keys.length > 0) {
        deleteMultipleFromS3(keys).catch((err) =>
          console.warn(`[Sticker] S3 cleanup failed for personal pack ${packId} (orphaned):`, err),
        );
      }

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// POST /stickers/personal/:packId/stickers — add sticker to personal pack
personalStickerRouter.post(
  '/personal/:packId/stickers',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ packId: string }>, res: Response, next: NextFunction) => {
    try {
      const { packId } = req.params;
      const userId = req.user!.userId;

      const pack = await prisma.stickerPack.findUnique({ where: { id: packId } });
      if (!pack || pack.userId !== userId) throw new NotFoundError('Sticker pack');

      const { name, s3Key } = req.body;
      if (typeof name !== 'string') throw new BadRequestError('name is required');
      const sanitizedName = sanitizeText(name);
      const nameErr = validateStickerName(sanitizedName);
      if (nameErr) throw new BadRequestError(nameErr);

      if (typeof s3Key !== 'string' || !s3Key.startsWith(`stickers/pack-${packId}/`) || !VALID_S3_KEY_RE.test(s3Key)) {
        throw new BadRequestError('Invalid s3Key');
      }

      // Enforce limit
      const count = await prisma.sticker.count({ where: { packId } });
      if (count >= LIMITS.MAX_STICKERS_PER_PACK) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_STICKERS_PER_PACK} stickers per pack`);
      }

      let sticker;
      try {
        sticker = await prisma.sticker.create({
          data: { packId, name: sanitizedName, s3Key },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new BadRequestError('A sticker with this name already exists in this pack');
        }
        throw err;
      }

      res.status(201).json({ success: true, data: { id: sticker.id, packId: sticker.packId, name: sticker.name, s3Key: sticker.s3Key, createdAt: sticker.createdAt.toISOString() } });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /stickers/personal/:packId/stickers/:stickerId — remove from personal pack
personalStickerRouter.delete(
  '/personal/:packId/stickers/:stickerId',
  authenticate,
  requireVerifiedEmail,
  rateLimitStickerManage,
  async (req: Request<{ packId: string; stickerId: string }>, res: Response, next: NextFunction) => {
    try {
      const { packId, stickerId } = req.params;
      const userId = req.user!.userId;

      const pack = await prisma.stickerPack.findUnique({ where: { id: packId } });
      if (!pack || pack.userId !== userId) throw new NotFoundError('Sticker pack');

      const sticker = await prisma.sticker.findUnique({ where: { id: stickerId } });
      if (!sticker || sticker.packId !== packId) throw new NotFoundError('Sticker');

      await prisma.sticker.delete({ where: { id: stickerId } });

      deleteFromS3(sticker.s3Key).catch((err) =>
        console.warn(`[Sticker] S3 cleanup failed for ${sticker.s3Key} (orphaned):`, err),
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// GET /stickers/:stickerId — resolve a single sticker by ID
personalStickerRouter.get(
  '/:stickerId',
  authenticate,
  requireVerifiedEmail,
  rateLimitGeneral,
  async (req: Request<{ stickerId: string }>, res: Response, next: NextFunction) => {
    try {
      const sticker = await prisma.sticker.findUnique({
        where: { id: req.params.stickerId },
        select: { id: true, packId: true, name: true, s3Key: true, createdAt: true },
      });
      if (!sticker) throw new NotFoundError('Sticker');

      res.json({ success: true, data: { ...sticker, createdAt: sticker.createdAt.toISOString() } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Sticker Upload Presign ─────────────────────────────────────────────────

export function registerStickerPresignRoute(uploadRouter: Router): void {
  uploadRouter.post(
    '/presign/sticker/:packId',
    authenticate,
    requireVerifiedEmail,
    rateLimitStickerManage,
    async (req: Request<{ packId: string }>, res: Response, next: NextFunction) => {
      try {
        const { packId } = req.params;
        const userId = req.user!.userId;

        const pack = await prisma.stickerPack.findUnique({ where: { id: packId } });
        if (!pack) throw new NotFoundError('Sticker pack');

        // Authorize: server member with MANAGE_EMOJIS, or personal pack owner
        if (pack.serverId) {
          const canManage = await hasServerPermission(userId, pack.serverId, Permissions.MANAGE_EMOJIS);
          if (!canManage) throw new ForbiddenError('You do not have permission to manage stickers');
        } else if (pack.userId) {
          if (pack.userId !== userId) throw new ForbiddenError('Not your sticker pack');
        } else {
          // Pack has neither serverId nor userId — orphaned data
          throw new ForbiddenError('Invalid sticker pack');
        }

        const { fileName, fileSize, mimeType } = req.body;

        if (!fileName || typeof fileName !== 'string') throw new BadRequestError('fileName required');
        if (!mimeType || typeof mimeType !== 'string') throw new BadRequestError('mimeType required');
        if (!ALLOWED_EMOJI_TYPES.includes(mimeType as typeof ALLOWED_EMOJI_TYPES[number])) {
          throw new BadRequestError('File type not allowed for stickers (PNG, WebP, or GIF only)');
        }
        if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > LIMITS.MAX_STICKER_FILE_SIZE) {
          throw new BadRequestError(`Invalid file size (max ${LIMITS.MAX_STICKER_FILE_SIZE / 1024}KB)`);
        }

        const ext = mimeType === 'image/gif' ? 'gif' : mimeType === 'image/png' ? 'png' : 'webp';
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const key = `stickers/pack-${packId}/${id}.${ext}`;
        const uploadUrl = await generatePresignedPutUrl(key, mimeType);

        res.json({ success: true, data: { uploadUrl, key } });
      } catch (err) {
        next(err);
      }
    },
  );
}
