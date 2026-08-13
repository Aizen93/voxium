import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitUpload, rateLimitGeneral } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { generatePresignedPutUrl, generatePresignedGetUrl, getS3Object, VALID_S3_KEY_RE, VALID_ATTACHMENT_KEY_RE } from '../utils/s3';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { ALLOWED_ATTACHMENT_TYPES, getMaxAttachmentSize, Permissions, LIMITS, E2E_ATTACHMENT_MIME, E2E_ATTACHMENT_NAME, E2E_GCM_TAG_BYTES } from '@voxium/shared';
import crypto from 'crypto';
import { Readable } from 'stream';
import { hasServerPermission, hasChannelPermission } from '../utils/permissionCalculator';

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
      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
      if (!canManage) throw new ForbiddenError('You do not have permission to change the server icon');

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
      const { fileName, fileSize, mimeType, channelId, conversationId, encrypted } = req.body;

      // Validate exactly one context
      if (channelId !== undefined && typeof channelId !== 'string') throw new BadRequestError('channelId must be a string');
      if (conversationId !== undefined && typeof conversationId !== 'string') throw new BadRequestError('conversationId must be a string');
      if ((!channelId && !conversationId) || (channelId && conversationId)) {
        throw new BadRequestError('Provide exactly one of channelId or conversationId');
      }

      if (!fileName || typeof fileName !== 'string') throw new BadRequestError('fileName required');
      if (!mimeType || typeof mimeType !== 'string') throw new BadRequestError('mimeType required');

      if (encrypted === true) {
        // E2E attachment: the server stores an opaque AES-GCM blob. The real
        // mime/size are inside the message ciphertext, so only the outer cap
        // (largest allowed plaintext + GCM tag) is enforceable here — clients
        // enforce the per-type plaintext caps before encrypting (spec §13).
        // Context rule (DMs always; channels only when secure) is enforced in
        // the authorization block below, where the channel row is available.
        if (mimeType !== E2E_ATTACHMENT_MIME) throw new BadRequestError('Encrypted attachments must be uploaded as application/octet-stream');
        const maxCipherSize = LIMITS.MAX_VIDEO_ATTACHMENT_SIZE + E2E_GCM_TAG_BYTES;
        if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > maxCipherSize) {
          throw new BadRequestError(`Invalid file size (max ${LIMITS.MAX_VIDEO_ATTACHMENT_SIZE / 1024 / 1024}MB)`);
        }
      } else {
        if (!ALLOWED_ATTACHMENT_TYPES.includes(mimeType as typeof ALLOWED_ATTACHMENT_TYPES[number])) {
          throw new BadRequestError('File type not allowed');
        }
        const maxSize = getMaxAttachmentSize(mimeType);
        if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > maxSize) {
          throw new BadRequestError(`Invalid file size (max ${maxSize / 1024 / 1024}MB)`);
        }
      }

      // Authorization
      if (channelId) {
        const channel = await prisma.channel.findUnique({
          where: { id: channelId },
          select: { serverId: true, secure: true },
        });
        if (!channel) throw new NotFoundError('Channel');
        const membership = await prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
        });
        if (!membership) {
          // Opacity: a secure-channel denial must be byte-identical to the
          // nonexistent-channel response (a 403 would confirm existence)
          throw channel.secure ? new NotFoundError('Channel') : new ForbiddenError('Not a member of this server');
        }
        const canAttach = await hasChannelPermission(req.user!.userId, channelId, channel.serverId, Permissions.ATTACH_FILES);
        // Also the secrecy gate: non-members of a secure channel have 0n
        if (!canAttach) {
          throw channel.secure ? new NotFoundError('Channel') : new ForbiddenError('You do not have permission to attach files in this channel');
        }
        // Secure channels store ONLY opaque blobs; plaintext channels never
        // accept them (the DM-only rule, widened to secure channels)
        if (channel.secure && encrypted !== true) {
          throw new BadRequestError('This channel is end-to-end encrypted; update your client to upload files');
        }
        if (!channel.secure && encrypted === true) {
          throw new BadRequestError('Encrypted attachments are only supported in direct messages and secure channels');
        }
      } else {
        const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
        if (!conv) throw new NotFoundError('Conversation');
        if (conv.user1Id !== req.user!.userId && conv.user2Id !== req.user!.userId) {
          throw new ForbiddenError('Not a participant of this conversation');
        }
      }

      const contextPrefix = channelId ? `ch-${channelId}` : `dm-${conversationId}`;
      // Encrypted attachments never leak the real file name into the S3 key
      const sanitizedName = encrypted === true
        ? E2E_ATTACHMENT_NAME
        : fileName.replace(/[^\w.-]/g, '_').slice(0, 100);
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
  '/attachments/*path',
  authenticate,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pathSegments = req.params.path;
      const pathStr = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments as string;
      const key = `attachments/${pathStr}`;
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
              channel: { select: { serverId: true, secure: true } },
            },
          },
        },
      });
      if (!attachment) throw new NotFoundError('Attachment');
      if (attachment.expired) throw new NotFoundError('Attachment expired');

      // Authorize: server member with VIEW_CHANNEL, or DM participant
      if (attachment.message.channelId && attachment.message.channel) {
        // Opacity: secure-channel denials read exactly like a missing key
        const secure = attachment.message.channel.secure;
        const membership = await prisma.serverMember.findUnique({
          where: {
            userId_serverId: {
              userId: req.user!.userId,
              serverId: attachment.message.channel.serverId,
            },
          },
        });
        if (!membership) throw secure ? new NotFoundError('Attachment') : new ForbiddenError('Not a member');
        // Check VIEW_CHANNEL permission — prevents downloading attachments from restricted channels
        const canView = await hasChannelPermission(
          req.user!.userId,
          attachment.message.channelId,
          attachment.message.channel.serverId,
          Permissions.VIEW_CHANNEL,
        );
        if (!canView) throw secure ? new NotFoundError('Attachment') : new ForbiddenError('Not authorized');
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
  '/*path',
  rateLimitGeneral,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pathSegments = req.params.path;
      const key = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments as string;
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
