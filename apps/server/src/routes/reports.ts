import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimitReport } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import { getIO } from '../websocket/socketServer';
import { LIMITS } from '@voxium/shared';

export const reportsRouter = Router();

reportsRouter.use(authenticate);

// ─── Submit a report ─────────────────────────────────────────────────────────

reportsRouter.post('/', rateLimitReport, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { type, reportedUserId, messageId, reason: rawReason } = req.body;

    // Validate type
    if (type !== 'message' && type !== 'user') {
      throw new BadRequestError('Invalid report type');
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

    let messageContent: string | null = null;
    let channelId: string | null = null;
    let conversationId: string | null = null;
    let serverId: string | null = null;

    if (type === 'message') {
      if (!messageId) throw new BadRequestError('messageId is required for message reports');

      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          content: true,
          channelId: true,
          conversationId: true,
          authorId: true,
          channel: { select: { serverId: true } },
        },
      });
      if (!message) throw new NotFoundError('Message');

      // Ensure the reported user is the actual author of the message
      if (message.authorId !== reportedUserId) {
        throw new BadRequestError('Reported user does not match message author');
      }

      messageContent = message.content;
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
