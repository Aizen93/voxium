import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitUpload, rateLimitGeneral } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { generatePresignedPutUrl, generatePresignedGetUrl, getS3Object, VALID_S3_KEY_RE, VALID_ATTACHMENT_KEY_RE } from '../utils/s3';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { ALLOWED_ATTACHMENT_TYPES, getMaxAttachmentSize } from '@voxium/shared';
import crypto from 'crypto';
import { Readable } from 'stream';

export const uploadRouter = Router();

// POST /uploads/presign/avatar — get a presigned PUT URL for avatar upload
uploadRouter.post(
  '/presign/avatar',
  authenticate,
  requireVerifiedEmail,
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
  requireVerifiedEmail,
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

// POST /uploads/presign/attachment — get a presigned PUT URL for a message attachment
uploadRouter.post(
  '/presign/attachment',
  authenticate,
  requireVerifiedEmail,
  rateLimitUpload,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fileName, fileSize, mimeType, channelId, conversationId } = req.body;

      // Validate exactly one context
      if ((!channelId && !conversationId) || (channelId && conversationId)) {
        throw new BadRequestError('Provide exactly one of channelId or conversationId');
      }

      if (!fileName || typeof fileName !== 'string') throw new BadRequestError('fileName required');
      if (!ALLOWED_ATTACHMENT_TYPES.includes(mimeType)) {
        throw new BadRequestError('File type not allowed');
      }
      const maxSize = getMaxAttachmentSize(mimeType);
      if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > maxSize) {
        throw new BadRequestError(`Invalid file size (max ${maxSize / 1024 / 1024}MB)`);
      }

      // Authorization
      if (channelId) {
        const channel = await prisma.channel.findUnique({
          where: { id: channelId },
          select: { serverId: true },
        });
        if (!channel) throw new NotFoundError('Channel');
        const membership = await prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
        });
        if (!membership) throw new ForbiddenError('Not a member of this server');
      } else {
        const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
        if (!conv) throw new NotFoundError('Conversation');
        if (conv.user1Id !== req.user!.userId && conv.user2Id !== req.user!.userId) {
          throw new ForbiddenError('Not a participant of this conversation');
        }
      }

      const contextPrefix = channelId ? `ch-${channelId}` : `dm-${conversationId}`;
      const sanitizedName = fileName.replace(/[^\w.-]/g, '_').slice(0, 100);
      const attachmentId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const key = `attachments/${contextPrefix}/${attachmentId}-${sanitizedName}`;
      const uploadUrl = await generatePresignedPutUrl(key, mimeType);

      res.json({ success: true, data: { uploadUrl, key } });
    } catch (err) {
      next(err);
    }
  },
);

// GET /uploads/attachments/* — authorized proxy for attachments
uploadRouter.get(
  '/attachments/*',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `attachments/${req.params[0]}`;
      if (!key || key.includes('..') || !VALID_ATTACHMENT_KEY_RE.test(key)) {
        throw new BadRequestError('Invalid key');
      }

      const attachment = await prisma.messageAttachment.findFirst({
        where: { s3Key: key },
        select: {
          expired: true,
          message: {
            select: {
              channelId: true,
              conversationId: true,
              channel: { select: { serverId: true } },
            },
          },
        },
      });
      if (!attachment) throw new NotFoundError('Attachment');
      if (attachment.expired) throw new NotFoundError('Attachment expired');

      // Authorize: server member or DM participant
      if (attachment.message.channelId && attachment.message.channel) {
        const membership = await prisma.serverMember.findUnique({
          where: {
            userId_serverId: {
              userId: req.user!.userId,
              serverId: attachment.message.channel.serverId,
            },
          },
        });
        if (!membership) throw new ForbiddenError('Not a member');
      } else if (attachment.message.conversationId) {
        const conv = await prisma.conversation.findUnique({
          where: { id: attachment.message.conversationId },
        });
        if (!conv || (conv.user1Id !== req.user!.userId && conv.user2Id !== req.user!.userId)) {
          throw new ForbiddenError('Not a participant');
        }
      }

      // Proxy from S3 — S3 URL never reaches the client
      let s3Response;
      try {
        s3Response = await getS3Object(key);
      } catch (s3Err: unknown) {
        const err = s3Err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          // File deleted from S3 (e.g. admin or manual cleanup) — mark as expired
          await prisma.messageAttachment.updateMany({ where: { s3Key: key }, data: { expired: true } });
          throw new NotFoundError('Attachment expired');
        }
        throw s3Err;
      }
      if (!s3Response.Body) throw new NotFoundError('Attachment');

      res.set('Content-Type', s3Response.ContentType || 'application/octet-stream');
      if (s3Response.ContentLength) res.set('Content-Length', String(s3Response.ContentLength));
      res.set('Cache-Control', 'private, max-age=300');

      (s3Response.Body as Readable).pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

// GET /uploads/* — public redirect for avatars and server icons
// Append ?inline to proxy the image directly instead of 302→S3.
// Used by browser notifications where the S3 redirect fails due to CORS.
uploadRouter.get(
  '/*',
  rateLimitGeneral,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.params[0];
      if (!key || key.includes('..') || !VALID_S3_KEY_RE.test(key)) {
        throw new BadRequestError('Invalid key');
      }

      if (req.query.inline !== undefined) {
        const s3Response = await getS3Object(key);
        if (!s3Response.Body) throw new NotFoundError('Asset');
        // Force image Content-Type regardless of what S3 returns (defense-in-depth against stored XSS)
        res.set('Content-Type', 'image/webp');
        if (s3Response.ContentLength) res.set('Content-Length', String(s3Response.ContentLength));
        res.set('Cache-Control', 'public, max-age=86400, immutable');
        res.set('Content-Disposition', 'inline');
        res.set('X-Content-Type-Options', 'nosniff');
        (s3Response.Body as Readable).pipe(res);
        return;
      }

      const url = await generatePresignedGetUrl(key);
      res.set('Cache-Control', 'no-cache');
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  },
);
