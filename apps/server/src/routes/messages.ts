import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitMessageSend, rateLimitInteract } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam } from '../utils/errors';
import { validateMessageContent, validateEmoji, LIMITS, ALLOWED_ATTACHMENT_TYPES, getMaxAttachmentSize, Permissions, parseE2EEnvelope, E2E_ATTACHMENT_MIME, E2E_ATTACHMENT_NAME, E2E_GCM_TAG_BYTES, type Message } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';
import { sanitizeText } from '../utils/sanitize';
import { VALID_ATTACHMENT_KEY_RE, deleteMultipleFromS3 } from '../utils/s3';
import { extractMentionIds, resolveMentionsForServer, batchResolveMentions, attachMentions } from '../utils/mentions';
import { hasChannelPermission } from '../utils/permissionCalculator';

const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

export const messageRouter = Router({ mergeParams: true });

messageRouter.use(authenticate, requireVerifiedEmail);

// Get messages in a channel (paginated, newest first — or around a target message)
messageRouter.get('/', async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, LIMITS.MESSAGES_PER_PAGE);
    const before = req.query.before as string | undefined;
    const around = req.query.around as string | undefined;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true, secure: true },
    });
    if (!channel) throw new NotFoundError('Channel');
    // Opacity: for a SECURE channel, every authorization failure must be
    // byte-identical to the nonexistent-channel response — a 403 here would
    // tell a prober "exists, but you are not in it"
    const secureDenied = () => channel.secure
      ? new NotFoundError('Channel')
      : null;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
    });
    if (!membership) throw secureDenied() ?? new ForbiddenError('Not a member of this server');

    // Check VIEW_CHANNEL permission
    const canView = await hasChannelPermission(req.user!.userId, channelId, channel.serverId, Permissions.VIEW_CHANNEL);
    if (!canView) throw secureDenied() ?? new ForbiddenError('You do not have permission to view this channel');

    const messageInclude = {
      author: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
      },
      replyTo: {
        select: {
          id: true,
          content: true,
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
        },
      },
      reactions: reactionInclude,
      attachments: attachmentSelect,
    };

    // "around" mode: fetch messages surrounding a target message
    if (around) {
      const target = await prisma.message.findUnique({
        where: { id: around },
        select: { id: true, channelId: true, createdAt: true },
      });
      if (!target || target.channelId !== channelId) throw new NotFoundError('Message');

      const half = Math.floor(limit / 2);

      const [olderMessages, newerMessages] = await Promise.all([
        prisma.message.findMany({
          where: { channelId, createdAt: { lte: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'desc' },
          take: half + 1,
        }),
        prisma.message.findMany({
          where: { channelId, createdAt: { gt: target.createdAt } },
          include: messageInclude,
          orderBy: { createdAt: 'asc' },
          take: half + 1,
        }),
      ]);

      const hasMore = olderMessages.length > half;
      const hasMoreAfter = newerMessages.length > half;
      if (hasMore) olderMessages.pop();
      if (hasMoreAfter) newerMessages.pop();

      // Combine: older (reversed to chronological) + newer
      const combined = [...olderMessages.reverse(), ...newerMessages];
      // Deduplicate by id
      const seen = new Set<string>();
      const unique = combined.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      const mentionMap = await batchResolveMentions(unique, channel.serverId);
      const data = unique.map((m) => ({
        ...m,
        reactions: aggregateReactions(m.reactions),
        mentions: attachMentions(m, mentionMap),
      }));

      res.json({ success: true, data, hasMore, hasMoreAfter, targetMessageId: around });
      return;
    }

    // Standard pagination
    const where: Record<string, unknown> = { channelId };
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

    const reversed = messages.reverse();
    const mentionMap = await batchResolveMentions(reversed, channel.serverId);
    const data = reversed.map((m) => ({
      ...m,
      reactions: aggregateReactions(m.reactions),
      mentions: attachMentions(m, mentionMap),
    }));

    res.json({
      success: true,
      data,
      hasMore,
    });
  } catch (err) {
    next(err);
  }
});

// Send a message
messageRouter.post('/', rateLimitMessageSend, async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;

    // Fetched before content validation: SECURE channels invert the content
    // rules (ciphertext-only, stored verbatim), so the branch must be known
    // before anything touches req.body.content
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true, type: true, name: true, secure: true, server: { select: { name: true } } },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.type !== 'text') throw new BadRequestError('Cannot send messages to a voice channel');

    // AUTHORIZATION FIRST — before any secure/encrypted branching. The secure
    // branch's errors ("this channel is end-to-end encrypted…") are derived
    // purely from the channel row; reachable pre-auth they would tell any
    // authenticated prober that the channel exists AND that it is secure. For
    // secure channels every denial below is the nonexistent-channel 404.
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: channel.serverId } },
    });
    if (!membership) {
      throw channel.secure ? new NotFoundError('Channel') : new ForbiddenError('Not a member of this server');
    }

    // Check channel-level SEND_MESSAGES permission (membership-derived for
    // secure channels — non-members, owner and ADMINISTRATOR included, get 0n)
    const canSend = await hasChannelPermission(req.user!.userId, channelId, channel.serverId, Permissions.SEND_MESSAGES);
    if (!canSend) {
      throw channel.secure ? new NotFoundError('Channel') : new ForbiddenError('You do not have permission to send messages in this channel');
    }

    const wantsEncrypted = req.body.encrypted === true;
    if (!channel.secure && wantsEncrypted) {
      throw new BadRequestError('Encrypted messages are only supported in secure channels');
    }

    let content: string;
    let attachments: Array<{ s3Key: string; fileName: string; fileSize: number; mimeType: string }> | undefined;

    if (channel.secure) {
      // Mirrors routes/dm.ts: secure channels are born encrypted — there is no
      // plaintext path, and an outdated client gets a hard error, never a
      // silent downgrade
      if (!wantsEncrypted) {
        throw new BadRequestError('This channel is end-to-end encrypted; update your client to send messages');
      }
      if (!parseE2EEnvelope(req.body.content)) {
        throw new BadRequestError('Invalid encrypted message envelope');
      }
      // Stored verbatim: sanitizeText would corrupt ciphertext, and the
      // envelope was already strictly validated above
      content = req.body.content as string;

      // E2E attachments: opaque AES-GCM blobs; the real fileName/mimeType/size
      // live inside the message ciphertext
      const rawAttachments = req.body.attachments as typeof attachments;
      if (rawAttachments !== undefined) {
        if (!Array.isArray(rawAttachments)) throw new BadRequestError('attachments must be an array');
        if (rawAttachments.length === 0 || rawAttachments.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
          throw new BadRequestError(`Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
        }
        const expectedPrefix = `attachments/ch-${channelId}/`;
        const maxCipherSize = LIMITS.MAX_VIDEO_ATTACHMENT_SIZE + E2E_GCM_TAG_BYTES;
        for (const a of rawAttachments) {
          if (!a || typeof a !== 'object') throw new BadRequestError('Invalid attachment');
          if (typeof a.s3Key !== 'string' || typeof a.fileSize !== 'number') {
            throw new BadRequestError('Invalid attachment fields');
          }
          if (!VALID_ATTACHMENT_KEY_RE.test(a.s3Key)) throw new BadRequestError('Invalid attachment key');
          if (!a.s3Key.startsWith(expectedPrefix)) throw new BadRequestError('Attachment does not belong to this channel');
          if (a.fileSize <= 0 || a.fileSize > maxCipherSize) throw new BadRequestError('Invalid attachment size');
          if (a.mimeType !== E2E_ATTACHMENT_MIME) throw new BadRequestError('Encrypted attachments must be opaque');
        }
        attachments = rawAttachments;
      }
    } else {
      content = sanitizeText(req.body.content ?? '');

      // Validate attachments
      attachments = req.body.attachments as typeof attachments;

      if (attachments) {
        if (!Array.isArray(attachments)) throw new BadRequestError('attachments must be an array');
        if (attachments.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
          throw new BadRequestError(`Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
        }
        const expectedPrefix = `attachments/ch-${channelId}/`;
        for (const a of attachments) {
          if (!a || typeof a !== 'object') throw new BadRequestError('Invalid attachment');
          if (typeof a.s3Key !== 'string' || typeof a.fileName !== 'string' || typeof a.fileSize !== 'number' || typeof a.mimeType !== 'string') {
            throw new BadRequestError('Invalid attachment fields');
          }
          if (!VALID_ATTACHMENT_KEY_RE.test(a.s3Key)) throw new BadRequestError('Invalid attachment key');
          if (!a.s3Key.startsWith(expectedPrefix)) throw new BadRequestError('Attachment does not belong to this channel');
          if (a.fileSize <= 0 || a.fileSize > getMaxAttachmentSize(a.mimeType)) throw new BadRequestError('Invalid attachment size');
          if (!ALLOWED_ATTACHMENT_TYPES.includes(a.mimeType as typeof ALLOWED_ATTACHMENT_TYPES[number])) throw new BadRequestError('Invalid file type');
        }
      }

      // Allow empty content if attachments are present
      if (!attachments?.length) {
        const contentErr = validateMessageContent(content);
        if (contentErr) throw new BadRequestError(contentErr);
      } else if (content.length > LIMITS.MESSAGE_MAX) {
        throw new BadRequestError(`Message must be at most ${LIMITS.MESSAGE_MAX} characters`);
      }
    }

    // Check ATTACH_FILES permission if attachments are present (membership and
    // SEND_MESSAGES were verified before the content branching above)
    if (attachments?.length) {
      const canAttach = await hasChannelPermission(req.user!.userId, channelId, channel.serverId, Permissions.ATTACH_FILES);
      if (!canAttach) {
        throw channel.secure ? new NotFoundError('Channel') : new ForbiddenError('You do not have permission to attach files in this channel');
      }
    }

    // Validate optional replyToId
    const replyToId = req.body.replyToId as string | undefined;
    if (replyToId !== undefined && typeof replyToId !== 'string') throw new BadRequestError('replyToId must be a string');
    if (replyToId) {
      const parent = await prisma.message.findUnique({ where: { id: replyToId }, select: { channelId: true } });
      if (!parent || parent.channelId !== channelId) throw new BadRequestError('Invalid replyToId');
    }

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          content,
          encrypted: channel.secure,
          channelId,
          authorId: req.user!.userId,
          ...(replyToId && { replyToId }),
        },
      });
      if (attachments?.length) {
        await tx.messageAttachment.createMany({
          data: attachments.map((a) => ({
            messageId: msg.id,
            s3Key: a.s3Key,
            // Secure channels: never trust/store a client-supplied name for
            // E2E blobs — the real name lives inside the message ciphertext
            fileName: channel.secure ? E2E_ATTACHMENT_NAME : a.fileName,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        });
      }
      return tx.message.findUniqueOrThrow({
        where: { id: msg.id },
        include: {
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
          replyTo: {
            select: {
              id: true, content: true,
              author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
            },
          },
          attachments: attachmentSelect,
        },
      });
    });

    // Resolve mentions from content — never for ciphertext (nothing to parse,
    // and the server must not pretend to know what an encrypted message says)
    const mentionIds = channel.secure ? [] : extractMentionIds(content);
    const mentions = await resolveMentionsForServer(mentionIds, channel.serverId);

    // Broadcast to all users subscribed to this channel
    const room = `channel:${channelId}`;
    // Prisma returns Date objects; Socket.IO serializes them to ISO strings over the wire
    // Attach channel/server names for desktop notification context + mentions
    const payload = { ...message, reactions: [], mentions, channelName: channel.name, serverName: channel.server.name, serverId: channel.serverId };
    getIO().to(room).emit('message:new', payload as unknown as Message);

    res.status(201).json({ success: true, data: { ...message, mentions } });
  } catch (err) {
    next(err);
  }
});

// Edit a message
messageRouter.patch('/:messageId', rateLimitInteract, async (req: Request<{ channelId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId, messageId } = req.params;
    const wantsEncrypted = req.body.encrypted === true;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { serverId: true, secure: true } } },
    });
    if (!message) throw new NotFoundError('Message');
    if (message.channelId !== channelId) throw new NotFoundError('Message');
    if (message.authorId !== req.user!.userId) throw new ForbiddenError('You can only edit your own messages');
    // A system row ("Voice call started") carries a real participant as its
    // author, so the ownership check above passes for it. Without this, that
    // row's content could be edited into arbitrary text that still renders
    // with system styling — words the app appears to be saying itself.
    if (message.type === 'system') throw new ForbiddenError('System messages cannot be edited');

    // AUTHORIZATION BEFORE the secure/plaintext content branching: the secure
    // branch's errors are channel-derived, and an author removed from a secure
    // channel must hit the 404 below before any response that confirms the
    // channel still exists.
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: message.channel!.serverId } },
    });
    if (!membership) {
      throw message.channel!.secure
        ? new NotFoundError('Message')
        : new ForbiddenError('Not a member of this server');
    }

    // VIEW re-check: authorship is not enough — an author whose access was
    // revoked (role change, or removal from a secure channel) must not keep
    // editing their old messages in a channel they can no longer see
    const canView = await hasChannelPermission(
      req.user!.userId, channelId, message.channel!.serverId, Permissions.VIEW_CHANNEL,
    );
    if (!canView) throw new NotFoundError('Message');

    let content: string;
    if (message.channel!.secure) {
      // Secure-channel edits are fresh Megolm ciphertexts under the same id
      // (mirrors routes/dm.ts — clients version their plaintext cache by
      // editedAt)
      if (!wantsEncrypted) {
        throw new BadRequestError('This message is end-to-end encrypted; update your client to edit it');
      }
      if (!parseE2EEnvelope(req.body.content)) {
        throw new BadRequestError('Invalid encrypted message envelope');
      }
      content = req.body.content as string; // verbatim — never sanitized
    } else {
      if (wantsEncrypted) {
        throw new BadRequestError('Encrypted messages are only supported in secure channels');
      }
      content = sanitizeText(req.body.content ?? '');
      const contentErr = validateMessageContent(content);
      if (contentErr) throw new BadRequestError(contentErr);
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
          },
        },
        reactions: reactionInclude,
        attachments: attachmentSelect,
      },
    });

    const editMentionIds = message.channel!.secure ? [] : extractMentionIds(content);
    const editMentions = await resolveMentionsForServer(editMentionIds, message.channel!.serverId);
    const payload = { ...updated, reactions: aggregateReactions(updated.reactions), mentions: editMentions };
    getIO().to(`channel:${message.channelId!}`).emit('message:update', payload as unknown as Message);

    res.json({ success: true, data: { ...updated, mentions: editMentions } });
  } catch (err) {
    next(err);
  }
});

// Toggle reaction on a message
messageRouter.put('/:messageId/reactions/:emoji', rateLimitInteract, async (req: Request<{ channelId: string; messageId: string; emoji: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId, messageId } = req.params;
    const emoji = decodeURIComponent(req.params.emoji);
    const userId = req.user!.userId;

    const emojiErr = validateEmoji(emoji);
    if (emojiErr) throw new BadRequestError(emojiErr);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, channel: { select: { serverId: true, secure: true } } },
    });
    if (!message || message.channelId !== channelId || !message.channel) throw new NotFoundError('Message');

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId: message.channel.serverId } },
    });
    if (!membership) {
      // Opacity: secure-channel denials read exactly like a missing message
      throw message.channel.secure ? new NotFoundError('Message') : new ForbiddenError('Not a member of this server');
    }

    // Check ADD_REACTIONS permission
    const canReact = await hasChannelPermission(userId, channelId, message.channel.serverId, Permissions.ADD_REACTIONS);
    if (!canReact) {
      throw message.channel.secure ? new NotFoundError('Message') : new ForbiddenError('You do not have permission to add reactions in this channel');
    }

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });

    // Toggle is check-then-act — a double-click fires two concurrent requests
    // that both observe the same `existing`. Both branches must be idempotent
    // or the loser 500s (P2025 on the second delete / P2002 on the second add).
    let action: 'add' | 'remove';
    if (existing) {
      await prisma.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
      action = 'remove';
    } else {
      // Check distinct emoji count limit
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

    getIO().to(`channel:${channelId}`).emit('message:reaction_update', {
      messageId, channelId, emoji, userId, action, reactions,
    });

    res.json({ success: true, data: { action, reactions } });
  } catch (err) {
    next(err);
  }
});

// Delete a message
messageRouter.delete('/:messageId', rateLimitInteract, async (req: Request<{ channelId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId, messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { serverId: true, secure: true } }, attachments: { select: { s3Key: true } } },
    });
    if (!message || !message.channel) throw new NotFoundError('Message');
    if (message.channelId !== channelId) throw new NotFoundError('Message');

    // Verify server membership (even for own messages — kicked users shouldn't delete retroactively)
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: message.channel!.serverId } },
    });
    if (!membership) {
      throw message.channel!.secure ? new NotFoundError('Message') : new ForbiddenError('Not a member of this server');
    }

    // VIEW re-check, mirroring the PATCH guard: authorship is not enough. A
    // member removed from a secure channel (or an author whose VIEW was
    // revoked) must not keep destroying history — and its S3 blobs — in a
    // channel they can no longer see.
    const canView = await hasChannelPermission(
      req.user!.userId, channelId, message.channel!.serverId, Permissions.VIEW_CHANNEL,
    );
    if (!canView) throw new NotFoundError('Message');

    const isAuthor = message.authorId === req.user!.userId;
    if (!isAuthor) {
      const canManageMessages = await hasChannelPermission(req.user!.userId, message.channelId!, message.channel!.serverId, Permissions.MANAGE_MESSAGES);
      if (!canManageMessages) throw new ForbiddenError('You can only delete your own messages');
    }

    await prisma.message.delete({ where: { id: messageId } });

    // Fire-and-forget S3 cleanup
    if (message.attachments.length > 0) {
      deleteMultipleFromS3(message.attachments.map((a) => a.s3Key)).catch((err) => console.warn('[S3] Failed to delete attachments on message delete:', err));
    }

    getIO().to(`channel:${message.channelId!}`).emit('message:delete', {
      messageId,
      channelId: message.channelId!,
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});
