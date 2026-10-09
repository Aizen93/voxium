import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { rateLimitReport } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import { getIO } from '../websocket/socketServer';
import { LIMITS } from '@voxium/shared';

export const reportsRouter = Router();

reportsRouter.use(authenticate, requireVerifiedEmail, requireConsent);

// ─── Submit a report ─────────────────────────────────────────────────────────

reportsRouter.post('/', rateLimitReport, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { type, reportedUserId, messageId, reason: rawReason } = req.body;

    // Validate type
    if (type !== 'message' && type !== 'user') {
      throw new BadRequestError('Invalid report type');
    }

    // Validate reportedUserId
    if (!reportedUserId || typeof reportedUserId !== 'string') {
      throw new BadRequestError('reportedUserId is required');
    }

    // Validate reason
    const reason = sanitizeText(rawReason ?? '');
    if (reason.length < LIMITS.REPORT_REASON_MIN) {
      throw new BadRequestError(`Reason must be at least ${LIMITS.REPORT_REASON_MIN} characters`);
    }
    if (reason.length > LIMITS.REPORT_REASON_MAX) {
      throw new BadRequestError(`Reason must be at most ${LIMITS.REPORT_REASON_MAX} characters`);
    }

    // Can't report yourself
    if (reportedUserId === userId) {
      throw new BadRequestError('You cannot report yourself');
    }

    // Validate reported user exists
    const reportedUser = await prisma.user.findUnique({
      where: { id: reportedUserId },
      select: { id: true },
    });
    if (!reportedUser) throw new NotFoundError('User');

    // Check for existing pending report from this user against the same target
    const existingReport = await prisma.report.findFirst({
      where: {
        reporterId: userId,
        reportedUserId,
        status: 'pending',
        ...(type === 'message' && messageId ? { messageId } : { type: 'user' }),
      },
    });
    if (existingReport) {
      throw new BadRequestError('You already have a pending report against this target');
    }

    let messageContent: string | null = null;
    let contentSource = 'server';
    let channelId: string | null = null;
    let conversationId: string | null = null;
    let serverId: string | null = null;

    if (type === 'message') {
      if (!messageId || typeof messageId !== 'string') throw new BadRequestError('messageId is required for message reports');

      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          content: true,
          encrypted: true,
          channelId: true,
          conversationId: true,
          authorId: true,
          channel: { select: { serverId: true, secure: true } },
        },
      });
      if (!message) throw new NotFoundError('Message');

      // Ensure the reported user is the actual author of the message
      if (message.authorId !== reportedUserId) {
        throw new BadRequestError('Reported user does not match message author');
      }

      // Messages in a SECURE channel cannot be reported, by anyone. Their
      // content is not the server's to read, so a report could only ever carry
      // reporter-provided text nobody can verify — and moderation of a secure
      // channel is not content moderation: the members deal with each other,
      // and a member who wants the channel gone hands its id to a server
      // admin, whose only lever is delete-by-id (§19). Answered exactly like a
      // nonexistent message, for members and non-members alike, BEFORE any
      // membership lookup: the reports endpoint must not become the oracle
      // that tells a prober a secure channel exists (same cost, same body).
      if (message.channel?.secure) throw new NotFoundError('Message');

      // Verify the reporter has access to this message
      if (message.channel?.serverId) {
        const membership = await prisma.serverMember.findUnique({
          where: { userId_serverId: { userId, serverId: message.channel.serverId } },
          select: { userId: true },
        });
        if (!membership) throw new ForbiddenError('You do not have access to this message');
      } else if (message.conversationId) {
        const conversation = await prisma.conversation.findFirst({
          where: {
            id: message.conversationId,
            OR: [{ user1Id: userId }, { user2Id: userId }],
          },
          select: { id: true },
        });
        if (!conversation) throw new ForbiddenError('You do not have access to this message');
      }

      if (message.encrypted) {
        // The server only holds ciphertext for E2E messages. The reporter's
        // client attaches its locally-decrypted plaintext; admins see it
        // flagged as reporter-provided (unverifiable against the ciphertext).
        const provided = sanitizeText(req.body.reportedContent ?? '');
        if (provided.length > LIMITS.MESSAGE_MAX) {
          throw new BadRequestError(`reportedContent must be at most ${LIMITS.MESSAGE_MAX} characters`);
        }
        messageContent = provided.length > 0 ? provided : null;
        contentSource = 'reporter';
      } else {
        messageContent = message.content;
      }
      channelId = message.channelId;
      conversationId = message.conversationId;
      if (message.channel) {
        serverId = message.channel.serverId;
      }
    }

    await prisma.report.create({
      data: {
        type,
        reason,
        reporterId: userId,
        reportedUserId,
        messageId: type === 'message' ? messageId : null,
        messageContent,
        contentSource,
        channelId,
        conversationId,
        serverId,
      },
    });

    // Notify admin report subscribers
    const pendingCount = await prisma.report.count({ where: { status: 'pending' } });
    getIO().to('admin:reports').emit('report:new', { total: pendingCount });

    res.status(201).json({ success: true, message: 'Report submitted' });
  } catch (err) {
    next(err);
  }
});
