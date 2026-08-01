import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitMessageSend, rateLimitInteract, rateLimitMarkRead } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam } from '../utils/errors';
import { validateMessageContent, validateEmoji, LIMITS, parseE2EEnvelope, E2E_ATTACHMENT_MIME, E2E_ATTACHMENT_NAME, E2E_GCM_TAG_BYTES, type Message } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';
import { sanitizeText } from '../utils/sanitize';
import { VALID_ATTACHMENT_KEY_RE, deleteMultipleFromS3 } from '../utils/s3';

const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

export const dmRouter = Router();

dmRouter.use(authenticate, requireVerifiedEmail);

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, status: true, role: true, isSupporter: true, supporterTier: true },
};

const replyToSelect = {
  select: {
    id: true,
    content: true,
    encrypted: true,
    author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
  },
};

/** Ensure user1Id < user2Id for uniqueness constraint */
function sortUserIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Verify the requesting user is a participant of the conversation */
async function getConversationOrThrow(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) throw new NotFoundError('Conversation');
  if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
    throw new ForbiddenError('Not a participant of this conversation');
  }
  return conversation;
}

// ─── List conversations ──────────────────────────────────────────────────────

dmRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const conversations = await prisma.conversation.findMany({
      where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
      include: {
        user1: authorSelect,
        user2: authorSelect,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, encrypted: true, createdAt: true, authorId: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      // Bounded: most-recently-active first. Each row costs a lastMessage
      // subquery — an unbounded list grows without limit over an account's life.
      take: 200,
    });

    const data = conversations.map((c) => ({
      id: c.id,
      user1Id: c.user1Id,
      user2Id: c.user2Id,
      participant: c.user1Id === userId ? c.user2 : c.user1,
      lastMessage: c.messages[0]
        ? {
            id: c.messages[0].id,
            content: c.messages[0].content,
            encrypted: c.messages[0].encrypted,
            createdAt: c.messages[0].createdAt.toISOString(),
            authorId: c.messages[0].authorId,
          }
        : null,
      // always set — conversations are born encrypted (plan §4.2)
      encryptedAt: c.encryptedAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── Create or get conversation ──────────────────────────────────────────────

dmRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.user!.userId;
    const { userId: targetUserId } = req.body;

    if (!targetUserId || typeof targetUserId !== 'string') {
      throw new BadRequestError('userId is required');
    }
    if (targetUserId === currentUserId) {
      throw new BadRequestError('Cannot create conversation with yourself');
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
    });
    if (!targetUser) throw new NotFoundError('User');

    const [user1Id, user2Id] = sortUserIds(currentUserId, targetUserId);

    // Atomic upsert — eliminates TOCTOU race when two users create the same conversation concurrently
    const existing = await prisma.conversation.findUnique({
      where: { user1Id_user2Id: { user1Id, user2Id } },
    });

    const isNew = !existing;
    // encryptedAt is filled by the column default — a conversation is born
    // encrypted and there is no route that turns it on (plan §4.2)
    const conversation = existing ?? await prisma.conversation.create({
      data: { user1Id, user2Id },
    }).catch(async (err) => {
      // Handle unique constraint race: another request created it between our check and create
      if (err?.code === 'P2002') {
        const found = await prisma.conversation.findUnique({
          where: { user1Id_user2Id: { user1Id, user2Id } },
        });
        if (found) return found;
      }
      throw err;
    });

    if (isNew) {
      // Create read records for both participants
      const now = new Date();
      await prisma.conversationRead.createMany({
        data: [
          { userId: user1Id, conversationId: conversation.id, lastReadAt: now },
          { userId: user2Id, conversationId: conversation.id, lastReadAt: now },
        ],
        skipDuplicates: true,
      });

      // Join both users' sockets to the DM room via their per-user rooms —
      // adapter-wide socketsJoin instead of fetching every socket on every node
      const io = getIO();
      io.in(`user:${user1Id}`).socketsJoin(`dm:${conversation.id}`);
      io.in(`user:${user2Id}`).socketsJoin(`dm:${conversation.id}`);
    }

    res.status(isNew ? 201 : 200).json({
      success: true,
      data: {
        id: conversation.id,
        user1Id: conversation.user1Id,
        user2Id: conversation.user2Id,
        participant: targetUser,
        lastMessage: null,
        encryptedAt: conversation.encryptedAt.toISOString(),
        createdAt: conversation.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get messages in conversation ────────────────────────────────────────────

dmRouter.get('/:conversationId/messages', async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, LIMITS.MESSAGES_PER_PAGE);
    const before = req.query.before as string | undefined;
    const around = req.query.around as string | undefined;

    await getConversationOrThrow(conversationId, userId);

    const messageInclude = {
      author: authorSelect,
      replyTo: replyToSelect,
      reactions: reactionInclude,
      attachments: attachmentSelect,
    };

    // "around" mode: fetch messages surrounding a target message
    if (around) {
      const target = await prisma.message.findUnique({
        where: { id: around },
        select: { id: true, conversationId: true, createdAt: true },
      });
      if (!target || target.conversationId !== conversationId) throw new NotFoundError('Message');

      const half = Math.floor(limit / 2);

      const [olderMessages, newerMessages] = await Promise.all([
        prisma.message.findMany({
          where: { conversationId, createdAt: { lte: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'desc' },
          take: half + 1,
        }),
        prisma.message.findMany({
          where: { conversationId, createdAt: { gt: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'asc' },
          take: half + 1,
        }),
      ]);

      const hasMore = olderMessages.length > half;
      const hasMoreAfter = newerMessages.length > half;
      if (hasMore) olderMessages.pop();
      if (hasMoreAfter) newerMessages.pop();

      const combined = [...olderMessages.reverse(), ...newerMessages];
      const seen = new Set<string>();
      const unique = combined.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      const data = unique.map((m) => ({
        ...m,
        reactions: aggregateReactions(m.reactions),
      }));

      res.json({ success: true, data, hasMore, hasMoreAfter, targetMessageId: around });
      return;
    }

    // Standard pagination
    const where: Record<string, unknown> = { conversationId };
    if (before) {
      where.createdAt = { lt: parseDateParam(before, 'before') };
    }

    const messages = await prisma.message.findMany({
      where,
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    const data = messages.reverse().map((m) => ({
      ...m,
      reactions: aggregateReactions(m.reactions),
    }));

    res.json({ success: true, data, hasMore });
  } catch (err) {
    next(err);
  }
});

// ─── Send DM ─────────────────────────────────────────────────────────────────

dmRouter.post('/:conversationId/messages', rateLimitMessageSend, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
    await getConversationOrThrow(conversationId, userId);
    const wantsEncrypted = req.body.encrypted === true;

    // Every conversation is born encrypted (plan §4.2 — encrypted_at is NOT
    // NULL), so a DM is always an opaque ciphertext envelope and there is no
    // plaintext path left to fall back to. An un-updated client must get a
    // hard error, not a silent downgrade (docs/e2e-dm-spec.md §6).
    if (!wantsEncrypted) {
      throw new BadRequestError('This conversation is end-to-end encrypted; update your client to send messages');
    }

    // E2E attachments (spec §13): the server stores opaque AES-GCM blobs. Real
    // fileName/mimeType/size live inside the message ciphertext — only the S3
    // key and the ciphertext size are validated here.
    const attachments = req.body.attachments as Array<{
      s3Key: string; fileSize: number; mimeType: string;
    }> | undefined;

    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) throw new BadRequestError('attachments must be an array');
      if (attachments.length === 0 || attachments.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new BadRequestError(`Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
      }
      const expectedPrefix = `attachments/dm-${conversationId}/`;
      const maxCipherSize = LIMITS.MAX_VIDEO_ATTACHMENT_SIZE + E2E_GCM_TAG_BYTES;
      for (const a of attachments) {
        if (!a || typeof a !== 'object') throw new BadRequestError('Invalid attachment');
        if (typeof a.s3Key !== 'string' || typeof a.fileSize !== 'number') {
          throw new BadRequestError('Invalid attachment fields');
        }
        if (!VALID_ATTACHMENT_KEY_RE.test(a.s3Key)) throw new BadRequestError('Invalid attachment key');
        if (!a.s3Key.startsWith(expectedPrefix)) throw new BadRequestError('Attachment does not belong to this conversation');
        if (a.fileSize <= 0 || a.fileSize > maxCipherSize) throw new BadRequestError('Invalid attachment size');
        if (a.mimeType !== E2E_ATTACHMENT_MIME) throw new BadRequestError('Encrypted attachments must be opaque');
      }
    }

    if (!parseE2EEnvelope(req.body.content)) {
      throw new BadRequestError('Invalid encrypted message envelope');
    }
    // Stored verbatim: sanitizeText would corrupt ciphertext, and the envelope
    // was already strictly validated above.
    const content = req.body.content as string;

    // Validate optional replyToId
    const replyToId = req.body.replyToId as string | undefined;
    if (replyToId !== undefined && typeof replyToId !== 'string') throw new BadRequestError('replyToId must be a string');
    if (replyToId) {
      const parent = await prisma.message.findUnique({ where: { id: replyToId }, select: { conversationId: true } });
      if (!parent || parent.conversationId !== conversationId) throw new BadRequestError('Invalid replyToId');
    }

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          content,
          encrypted: true,
          conversationId,
          authorId: userId,
          ...(replyToId && { replyToId }),
        },
      });
      if (attachments?.length) {
        await tx.messageAttachment.createMany({
          data: attachments.map((a) => ({
            messageId: msg.id,
            s3Key: a.s3Key,
            // never trust/store a client-supplied name for E2E blobs — the
            // real name lives inside the message ciphertext
            fileName: E2E_ATTACHMENT_NAME,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        });
      }
      return tx.message.findUniqueOrThrow({
        where: { id: msg.id },
        include: {
          author: authorSelect,
          replyTo: replyToSelect,
          attachments: attachmentSelect,
        },
      });
    });

    // Update conversation updatedAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    const payload = { ...message, reactions: [] };
    getIO().to(`dm:${conversationId}`).emit('dm:message:new', payload as unknown as Message);

    res.status(201).json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

// There is deliberately no "enable encryption" route: POST
// /:conversationId/encryption was removed in the always-on cutover (plan §4.2,
// §5). Conversations are encrypted from the moment they are created, so there
// is nothing to turn on and no window in which a conversation is plaintext.

// ─── Edit DM ─────────────────────────────────────────────────────────────────

dmRouter.patch('/:conversationId/messages/:messageId', rateLimitInteract, async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;
    const wantsEncrypted = req.body.encrypted === true;

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');
    if (message.authorId !== userId) throw new ForbiddenError('You can only edit your own messages');
    // A system row ("Voice call started") carries a real participant as its
    // author, so the ownership check above passes for it. Without this, that
    // row's content could be edited into arbitrary text that still renders
    // with system styling — words the app appears to be saying itself.
    if (message.type === 'system') throw new ForbiddenError('System messages cannot be edited');

    // Every editable DM is encrypted: user messages always are after the
    // cutover, and the only plaintext DM rows are the `type: 'system'` voice
    // notices refused above. So an edit is always a fresh ciphertext envelope
    // — a new ratchet message, which is why clients version their plaintext
    // cache by editedAt.
    if (!wantsEncrypted) {
      throw new BadRequestError('This message is end-to-end encrypted; update your client to edit it');
    }
    if (!parseE2EEnvelope(req.body.content)) {
      throw new BadRequestError('Invalid encrypted message envelope');
    }
    const content = req.body.content as string; // verbatim — never sanitized

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        author: authorSelect,
        replyTo: replyToSelect,
        reactions: reactionInclude,
        attachments: attachmentSelect,
      },
    });

    const payload = { ...updated, reactions: aggregateReactions(updated.reactions) };
    getIO().to(`dm:${conversationId}`).emit('dm:message:update', payload as unknown as Message);

    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

// ─── Delete DM ───────────────────────────────────────────────────────────────

dmRouter.delete('/:conversationId/messages/:messageId', rateLimitInteract, async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { attachments: { select: { s3Key: true } } },
    });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');
    if (message.authorId !== userId) throw new ForbiddenError('You can only delete your own messages');

    await prisma.message.delete({ where: { id: messageId } });

    // Fire-and-forget S3 cleanup
    if (message.attachments.length > 0) {
      deleteMultipleFromS3(message.attachments.map((a) => a.s3Key)).catch((err) => console.warn('[S3] Failed to delete DM attachments:', err));
    }

    getIO().to(`dm:${conversationId}`).emit('dm:message:delete', { messageId, conversationId });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Toggle reaction on DM ──────────────────────────────────────────────────

dmRouter.put('/:conversationId/messages/:messageId/reactions/:emoji', rateLimitInteract, async (req: Request<{ conversationId: string; messageId: string; emoji: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const emoji = decodeURIComponent(req.params.emoji);
    const userId = req.user!.userId;

    const emojiErr = validateEmoji(emoji);
    if (emojiErr) throw new BadRequestError(emojiErr);

    await getConversationOrThrow(conversationId, userId);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true },
    });
    if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });

    // Toggle is check-then-act — both branches must be idempotent so a
    // double-click's losing request doesn't 500 (see messages.ts reactions)
    let action: 'add' | 'remove';
    if (existing) {
      await prisma.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
      action = 'remove';
    } else {
      const distinctCount = await prisma.messageReaction.groupBy({
        by: ['emoji'],
        where: { messageId },
      });
      if (distinctCount.length >= LIMITS.MAX_REACTIONS_PER_MESSAGE) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_REACTIONS_PER_MESSAGE} different reactions per message`);
      }
      try {
        await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
      } catch (err) {
        // P2002: the concurrent duplicate add won the race — same outcome
        if (!(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002')) throw err;
      }
      action = 'add';
    }

    const rawReactions = await prisma.messageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
      orderBy: { createdAt: 'asc' },
    });
    const reactions = aggregateReactions(rawReactions);

    getIO().to(`dm:${conversationId}`).emit('dm:message:reaction_update', {
      messageId, conversationId, emoji, userId, action, reactions,
    });

    res.json({ success: true, data: { action, reactions } });
  } catch (err) {
    next(err);
  }
});

// ─── Delete conversation ────────────────────────────────────────────────────

dmRouter.delete('/:conversationId', rateLimitInteract, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    // Collect attachment S3 keys before cascade delete
    const attachments = await prisma.messageAttachment.findMany({
      where: { message: { conversationId } },
      select: { s3Key: true },
    });

    // Delete conversation (cascades messages + attachments + conversation reads)
    await prisma.conversation.delete({ where: { id: conversationId } });

    // Fire-and-forget S3 cleanup
    if (attachments.length > 0) {
      deleteMultipleFromS3(attachments.map((a) => a.s3Key)).catch((err) => console.warn('[S3] Failed to delete DM conversation attachments:', err));
    }

    // Notify the other participant
    const io = getIO();
    io.to(`dm:${conversationId}`).emit('dm:conversation:deleted', { conversationId });

    // Remove all sockets from the DM room
    const sockets = await io.in(`dm:${conversationId}`).fetchSockets();
    for (const s of sockets) {
      s.leave(`dm:${conversationId}`);
    }

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── Mark conversation as read ───────────────────────────────────────────────

dmRouter.post('/:conversationId/read', rateLimitMarkRead, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;

    await getConversationOrThrow(conversationId, userId);

    await prisma.conversationRead.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      update: { lastReadAt: new Date() },
      create: { userId, conversationId, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
