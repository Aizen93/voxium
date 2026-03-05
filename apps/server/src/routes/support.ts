import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { rateLimitSupport, rateLimitGeneral } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { LIMITS, WS_EVENTS } from '@voxium/shared';
import { isFeatureEnabled } from '../utils/featureFlags';
import type { SupportMessageData } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';

export const supportRouter = Router();

supportRouter.use(authenticate);

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
};

function mapMessage(m: any): SupportMessageData {
  return {
    id: m.id,
    ticketId: m.ticketId,
    authorId: m.authorId,
    content: m.content,
    type: m.type,
    createdAt: m.createdAt.toISOString(),
    author: m.author,
  };
}

async function emitTicketCount() {
  const total = await prisma.supportTicket.count({ where: { status: { in: ['open', 'claimed'] } } });
  getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_TICKET_NEW as any, { total });
}

// ─── Open / Reopen ticket ────────────────────────────────────────────────────

supportRouter.post('/open', rateLimitGeneral, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('support')) throw new ForbiddenError('Support tickets are currently disabled');
    const userId = req.user!.userId;

    let ticket = await prisma.supportTicket.findUnique({ where: { userId } });

    if (ticket && ticket.status === 'closed') {
      // Reopen
      ticket = await prisma.supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'open', claimedById: null, claimedAt: null, closedAt: null },
      });

      // System message
      const sysMsg = await prisma.supportMessage.create({
        data: { ticketId: ticket.id, authorId: userId, content: 'Support ticket reopened', type: 'system' },
        include: { author: authorSelect },
      });
      const mapped = mapMessage(sysMsg);
      getIO().to(`support:${ticket.id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW as any, mapped);
      getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW as any, mapped);
      getIO().to(`support:${ticket.id}`).emit(WS_EVENTS.SUPPORT_STATUS_CHANGE as any, {
        ticketId: ticket.id, status: 'open',
      });
      getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_STATUS_CHANGE as any, {
        ticketId: ticket.id, status: 'open',
      });
    } else if (!ticket) {
      // Create new
      ticket = await prisma.supportTicket.create({ data: { userId } });

      const sysMsg = await prisma.supportMessage.create({
        data: { ticketId: ticket.id, authorId: userId, content: 'Support ticket opened', type: 'system' },
        include: { author: authorSelect },
      });
      const mapped = mapMessage(sysMsg);
      getIO().to(`support:${ticket.id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW as any, mapped);
      getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW as any, mapped);
    }

    // Join socket to support room
    const io = getIO();
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      if (s.data.userId === userId) {
        s.join(`support:${ticket.id}`);
      }
    }

    await emitTicketCount();

    // Fetch messages
    const messages = await prisma.supportMessage.findMany({
      where: { ticketId: ticket.id },
      include: { author: authorSelect },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    res.json({
      success: true,
      data: {
        ticket: {
          id: ticket.id,
          status: ticket.status,
          createdAt: ticket.createdAt.toISOString(),
          updatedAt: ticket.updatedAt.toISOString(),
        },
        messages: messages.map(mapMessage),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get user's ticket + messages ────────────────────────────────────────────

supportRouter.get('/ticket', rateLimitGeneral, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const ticket = await prisma.supportTicket.findUnique({ where: { userId } });
    if (!ticket) {
      return res.json({ success: true, data: { ticket: null, messages: [] } });
    }

    const before = req.query.before as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const where: Record<string, unknown> = { ticketId: ticket.id };
    if (before) {
      const beforeDate = new Date(before);
      if (isNaN(beforeDate.getTime())) throw new BadRequestError('Invalid before date');
      where.createdAt = { lt: beforeDate };
    }

    const messages = await prisma.supportMessage.findMany({
      where,
      include: { author: authorSelect },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    res.json({
      success: true,
      data: {
        ticket: {
          id: ticket.id,
          status: ticket.status,
          createdAt: ticket.createdAt.toISOString(),
          updatedAt: ticket.updatedAt.toISOString(),
        },
        messages: messages.reverse().map(mapMessage),
        hasMore,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Send message ────────────────────────────────────────────────────────────

supportRouter.post('/messages', rateLimitSupport, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const ticket = await prisma.supportTicket.findUnique({ where: { userId } });
    if (!ticket) throw new NotFoundError('Support ticket');
    if (ticket.status === 'closed') throw new BadRequestError('Ticket is closed. Reopen it to send messages.');

    const content = sanitizeText(req.body.content ?? '');
    if (content.length < LIMITS.SUPPORT_MESSAGE_MIN || content.length > LIMITS.SUPPORT_MESSAGE_MAX) {
      throw new BadRequestError(`Message must be ${LIMITS.SUPPORT_MESSAGE_MIN}-${LIMITS.SUPPORT_MESSAGE_MAX} characters`);
    }

    const message = await prisma.supportMessage.create({
      data: { ticketId: ticket.id, authorId: userId, content },
      include: { author: authorSelect },
    });

    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });

    const payload = mapMessage(message);
    getIO().to(`support:${ticket.id}`).emit(WS_EVENTS.SUPPORT_MESSAGE_NEW as any, payload);
    getIO().to('admin:support').emit(WS_EVENTS.SUPPORT_MESSAGE_NEW as any, payload);
    await emitTicketCount();

    res.status(201).json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});
