import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { rateLimitMessageSend, rateLimitInteract, rateLimitMarkRead, rateLimitDmOpen } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import type { Prisma } from '../generated/prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError, parseDateParam, prismaErrorCode, violatesForeignKey } from '../utils/errors';
import { validateEmoji, LIMITS, parseE2EEnvelope, E2E_ATTACHMENT_MIME, E2E_ATTACHMENT_NAME, E2E_GCM_TAG_BYTES, DM_CLEARED_LIST_MAX, DM_LIST_PAGE_DEFAULT, DM_LIST_PAGE_MAX, CONVERSATION_READ_ONLY_MESSAGE } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { aggregateReactions, reactionInclude } from '../utils/reactions';
import { VALID_ATTACHMENT_KEY_RE, deleteMultipleFromS3 } from '../utils/s3';
import { verifyAttachmentUploads } from '../utils/uploadVerification';
import { shapeConversationMessageRow } from '../utils/messageAuthor';
import { endDMCall, endDMCallIfParticipant } from '../websocket/dmVoiceHandler';
import { deleteAttachmentBlobs } from '../utils/attachmentBlobs';
import { otherParticipant, deletedParticipantId } from '../utils/deletedParticipant';
import {
  aboveFloorWhere,
  isAboveFloor,
  isReadOnlyConversation,
  isVisibleMessage,
  loadConversationView,
  rowForViewer,
  type ConversationView,
} from '../utils/conversationVisibility';
import { emitRowToViewers, readConversationAudience, viewersRoom } from '../utils/conversationAudience';
import {
  changeConversationMessage,
  reopenConversationForUser,
  removeConversationForUser,
  writeConversationMessage,
} from '../utils/conversationLifecycle';
import { describeCaughtError, describeStoreError } from '../utils/loggableError';
import { encodeDmListCursor, decodeDmListCursor } from '../utils/dmListCursor';

/**
 * The early refusal of a write in a conversation whose other side's account
 * is gone (#131): 403 CONVERSATION_READ_ONLY_MESSAGE. Every write repeats it
 * under the conversation row lock (utils/conversationLifecycle.ts), which is
 * where an account deletion that commits while the request runs is seen.
 */
function refuseReadOnly(view: ConversationView): void {
  if (isReadOnlyConversation(view)) throw new ForbiddenError(CONVERSATION_READ_ONLY_MESSAGE);
}

/** A step after a removal committed failed: logged, never thrown. */
function logRemovalFanOutFailure(conversationId: string, step: string, err: unknown): void {
  console.error(`[DM] Conversation ${conversationId} removed, but ${step} failed:`, describeCaughtError(err));
}

const userRoom = (userId: string) => `user:${userId}`;

/**
 * `?clearHistory=true`: the removal clears the caller's history too (the
 * client asked for a confirmation first); absent or `false`: it only hides
 * (what the 2.1.x desktop sends, with no confirmation). Anything else, a
 * repeated parameter included, is refused: it never falls through to a clear.
 */
function parseClearHistory(raw: unknown): boolean {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new BadRequestError('clearHistory must be true or false');
}

const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

export const dmRouter = Router();

dmRouter.use(authenticate, requireVerifiedEmail, requireConsent);

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, status: true, role: true, isSupporter: true, supporterTier: true },
};

// webhookId/webhookName: a DM row has a user author, or none in a conversation
// kept for the other person after an account deletion (the deleted account's
// rows there, utils/conversationLifecycle.ts), and every reader here
// shapes through shapeConversationMessageRow() (utils/messageAuthor.ts), which
// needs both to keep the author non-null. It takes the conversation from the
// route, never from a select, so an authorless row or quote here becomes the
// deleted-account placeholder, never a webhook. createdAt: the quote is kept
// only for a viewer whose floor lies below it (rowForViewer), and never leaves
// the server.
const replyToSelect = {
  select: {
    id: true,
    content: true,
    encrypted: true,
    createdAt: true,
    webhookId: true,
    webhookName: true,
    author: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true } },
  },
};

/**
 * The caller's floor on what is answered to them about a conversation (the
 * list, an open, a removal): `clearedUntil`, present only when they cleared
 * their history there, so a 2.1.x client, which never cleared one, reads the
 * body it always read. A 2.2.0 client purges its local cache up to it.
 */
function clearedFloorField(floor: Date | null): { clearedUntil?: string } {
  return floor ? { clearedUntil: floor.toISOString() } : {};
}

/** Ensure user1Id < user2Id for uniqueness constraint */
function sortUserIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// Every route below reads the conversation through loadConversationView()
// (utils/conversationVisibility.ts): the participant check (a NULL side is a
// deleted account: `null !== userId`, so the remaining person still passes
// and nobody can pass as the deleted side) and the caller's floor, which
// every reader and every action applies through the same helpers.

// ─── List conversations ──────────────────────────────────────────────────────

/**
 * `?limit=`: a whole number of 1 or more (above DM_LIST_PAGE_MAX it is the
 * maximum). Anything else, an empty value included, is a 400.
 */
function parseDmListLimit(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new BadRequestError('limit must be a whole number of 1 or more');
  const n = Number(raw);
  if (n < 1) throw new BadRequestError('limit must be a whole number of 1 or more');
  return Math.min(n, DM_LIST_PAGE_MAX);
}

// A request with neither `limit` nor `cursor` is the legacy list (what a 2.1.x
// client reads: one answer of at most 200 rows, no `nextCursor`). Either
// parameter enters the paged mode: a signed keyset cursor over (updatedAt, id)
// (utils/dmListCursor.ts), `nextCursor` only when more rows exist, and the
// `cleared` floors on the first page alone.
dmRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const paged = req.query.limit !== undefined || req.query.cursor !== undefined;
    const limit = paged && req.query.limit !== undefined ? parseDmListLimit(req.query.limit) : DM_LIST_PAGE_DEFAULT;
    let after: { updatedAt: Date; id: string } | null = null;
    if (req.query.cursor !== undefined) {
      after = decodeDmListCursor(req.query.cursor, userId);
      if (!after) throw new BadRequestError('Invalid cursor');
    }

    const [fetched, clearedReads] = await Promise.all([
      prisma.conversation.findMany({
        where: {
          OR: [{ user1Id: userId }, { user2Id: userId }],
          // strictly after the last row of the previous page, in the order
          // below (an explicit (key, id) predicate, never a Prisma cursor)
          ...(after && {
            AND: [{ OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] }],
          }),
          // removed by the caller: off their list until a message newer than
          // their floor or their own reopening brings it back
          reads: { none: { userId, hiddenAt: { not: null } } },
        },
        include: {
          user1: authorSelect,
          user2: authorSelect,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, content: true, encrypted: true, type: true, createdAt: true, authorId: true },
          },
          // the caller's floor, for the preview
          reads: { where: { userId }, select: { clearedAt: true } },
        },
        // id breaks ties: conversations touched in one statement share an
        // updatedAt, and a page boundary inside a tie would skip or repeat rows
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        // Bounded: most-recently-active first. Each row costs a lastMessage
        // subquery — an unbounded list grows without limit over an account's life.
        take: paged ? limit + 1 : 200,
      }),
      // The floors of the conversations the caller removed with their
      // history cleared, which the list above leaves out (hidden): every
      // device of theirs learns them each session, a device that missed the
      // removal included. The caller's own read rows only, no join: a range
      // of the primary key (user_id, conversation_id), newest floor first,
      // bounded. A conversation really deleted since has no read row left.
      // Every list answers them again, so a failure here never fails the
      // list: it is answered without them, and the next one teaches them.
      // Paged mode answers them on the first page only.
      (after
        ? Promise.resolve([] as Array<{ conversationId: string; clearedAt: Date | null }>)
        : prisma.conversationRead.findMany({
            where: { userId, hiddenAt: { not: null }, clearedAt: { not: null } },
            orderBy: { clearedAt: 'desc' },
            take: DM_CLEARED_LIST_MAX,
            select: { conversationId: true, clearedAt: true },
          })).catch((err: unknown) => {
        console.warn(
          '[DM] The conversation list is answered without the floors of removed conversations:',
          err instanceof Error ? err.name : typeof err,
          prismaErrorCode(err) ?? 'no code',
        );
        return [] as Array<{ conversationId: string; clearedAt: Date | null }>;
      }),
    ]);
    const hasMore = paged && fetched.length > limit;
    const conversations = hasMore ? fetched.slice(0, limit) : fetched;
    const lastRow = conversations[conversations.length - 1];
    const cleared = clearedReads.flatMap((r) =>
      r.clearedAt ? [{ conversationId: r.conversationId, clearedUntil: r.clearedAt.toISOString() }] : []);

    const data = conversations.map((c) => {
      // the newest row, unless the caller cleared it (then every row is at
      // or below their floor, and there is no preview)
      const newest = c.messages[0];
      const floor = c.reads[0]?.clearedAt ?? null;
      const last = newest && isAboveFloor(newest.createdAt, floor) ? newest : null;
      return {
        id: c.id,
        user1Id: c.user1Id,
        user2Id: c.user2Id,
        // the other side, or the deleted-account placeholder with
        // participantDeleted: true (absent for a live side, utils/deletedParticipant.ts)
        ...otherParticipant(c, userId),
        lastMessage: last
          ? {
              id: last.id,
              content: last.content,
              encrypted: last.encrypted,
              // the client shows an unencrypted preview ONLY for a system notice
              type: last.type,
              createdAt: last.createdAt.toISOString(),
              // a row whose author's account is gone names the placeholder the
              // message itself carries as author, never null
              authorId: last.authorId ?? deletedParticipantId(c.id),
            }
          : null,
        // always set — conversations are born encrypted (docs/e2e-always-on-plan.md §4.2)
        encryptedAt: c.encryptedAt.toISOString(),
        createdAt: c.createdAt.toISOString(),
        // The list's own order key, paged mode only (the legacy body is
        // unchanged): a client holding several pages compares it with the
        // last row of a first page to tell what lies beyond that page
        ...(paged && { updatedAt: c.updatedAt.toISOString() }),
        // the caller's floor (clearedFloorField): their device purges what
        // it cached up to it
        ...clearedFloorField(floor),
      };
    });

    // `cleared` only when there is one: otherwise the body a 2.1.x client
    // reads today (it ignores the field either way)
    res.json({
      success: true,
      data,
      ...(cleared.length > 0 && { cleared }),
      ...(hasMore && lastRow && { nextCursor: encodeDmListCursor(userId, lastRow) }),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Create or get conversation ──────────────────────────────────────────────

dmRouter.post('/', rateLimitDmOpen, async (req: Request, res: Response, next: NextFunction) => {
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
    const found = await prisma.conversation.findUnique({
      where: { user1Id_user2Id: { user1Id, user2Id } },
      // the caller's floor, in the same statement (a relation load is one
      // query, schema `relationJoins`). Read before the reopen's lock, so a
      // removal of the caller's own committing meanwhile can leave it lower
      // than the one that removal set: a floor only rises, and that removal
      // tells every device of the caller its own (dm:conversation:deleted).
      include: { reads: { where: { userId: currentUserId }, select: { clearedAt: true } } },
    });
    // Opening a conversation the caller removed puts it back on their list
    // (their floor stays: only what lies above it shows). A removal that
    // deleted it meanwhile leaves the pair free for a new one.
    const reopened = found ? await reopenConversationForUser(found.id, currentUserId, targetUserId) : 'missing';
    // The target's account was deleted while the reopen waited for the
    // conversation (an account deletion kept it read-only): the answer an
    // unknown account always gets, never the deleted account's profile read
    // above
    if (reopened === 'other-side-gone') throw new NotFoundError('User');
    const existing = reopened === 'reopened' ? found : null;
    // a new conversation (the pair free, or a removal deleted it) has none
    const floor = existing?.reads[0]?.clearedAt ?? null;

    const isNew = !existing;
    // encryptedAt is filled by the column default — a conversation is born
    // encrypted and there is no route that turns it on (docs/e2e-always-on-plan.md §4.2)
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
      // The target's account was deleted after the lookup above (its key
      // refused): the answer an unknown account always gets
      if (violatesForeignKey(err, 'conversations_user1_id_fkey') || violatesForeignKey(err, 'conversations_user2_id_fkey')) {
        throw new NotFoundError('User');
      }
      throw err;
    });

    if (isNew) {
      // Create read records for both participants
      const now = new Date();
      try {
        await prisma.conversationRead.createMany({
          data: [
            { userId: user1Id, conversationId: conversation.id, lastReadAt: now },
            { userId: user2Id, conversationId: conversation.id, lastReadAt: now },
          ],
          skipDuplicates: true,
        });
      } catch (err) {
        // The same, between the conversation's insert and its read rows: the
        // account deletion settled the new conversation with the others
        if (violatesForeignKey(err, 'conversation_reads_user_id_fkey')) throw new NotFoundError('User');
        throw err;
      }

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
        // the row's own list-order key (a reopen moves nothing on it), so a
        // conversation opened here has a served place in a paged list
        updatedAt: conversation.updatedAt.toISOString(),
        // reopened after a removal that cleared the caller's history
        ...clearedFloorField(floor),
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

    const view = await loadConversationView(conversationId, userId);
    // Nothing at or below the caller's floor, in every mode
    const visible = aboveFloorWhere(view.floor);

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
      // a target the caller cleared answers like a missing one
      if (!isVisibleMessage(target, conversationId, view.floor)) throw new NotFoundError('Message');

      const half = Math.floor(limit / 2);

      const [olderMessages, newerMessages] = await Promise.all([
        prisma.message.findMany({
          where: { conversationId, AND: [visible, { createdAt: { lte: target.createdAt } }] },
          include: messageInclude,
          orderBy: { createdAt: 'desc' },
          take: half + 1,
        }),
        prisma.message.findMany({
          where: { conversationId, AND: [visible, { createdAt: { gt: target.createdAt } }] },
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
        ...rowForViewer(shapeConversationMessageRow(m, conversationId), view.floor),
        reactions: aggregateReactions(m.reactions),
      }));

      res.json({ success: true, data, hasMore, hasMoreAfter, targetMessageId: around });
      return;
    }

    // Standard pagination
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        AND: [visible, before ? { createdAt: { lt: parseDateParam(before, 'before') } } : {}],
      },
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    const data = messages.reverse().map((m) => ({
      ...rowForViewer(shapeConversationMessageRow(m, conversationId), view.floor),
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
    // The early answer (404 / 403, read-only, the caller's floor for the
    // reply check); the write repeats all of it under the conversation row lock
    const view = await loadConversationView(conversationId, userId);
    refuseReadOnly(view);
    const wantsEncrypted = req.body.encrypted === true;

    // Every conversation is born encrypted (docs/e2e-always-on-plan.md §4.2 — encrypted_at is NOT
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
        if (!Number.isSafeInteger(a.fileSize) || a.fileSize <= 0 || a.fileSize > maxCipherSize) throw new BadRequestError('Invalid attachment size');
        if (a.mimeType !== E2E_ATTACHMENT_MIME) throw new BadRequestError('Encrypted attachments must be opaque');
      }
    }

    if (!parseE2EEnvelope(req.body.content)) {
      throw new BadRequestError('Invalid encrypted message envelope');
    }
    // Stored verbatim: sanitizeText would corrupt ciphertext, and the envelope
    // was already strictly validated above.
    const content = req.body.content as string;

    // Validate optional replyToId: a parent the caller cleared (at or below
    // their floor) answers like a missing one
    const replyToId = req.body.replyToId as string | undefined;
    if (replyToId !== undefined && typeof replyToId !== 'string') throw new BadRequestError('replyToId must be a string');
    const assertReplyParent = async (db: Pick<Prisma.TransactionClient, 'message'>, floor: Date | null) => {
      if (!replyToId) return;
      const parent = await db.message.findUnique({ where: { id: replyToId }, select: { conversationId: true, createdAt: true } });
      if (!isVisibleMessage(parent, conversationId, floor)) throw new BadRequestError('Invalid replyToId');
    };
    await assertReplyParent(prisma, view.floor);

    // Read the uploaded blobs back before the row points at them: the stored
    // size is the real ciphertext size
    if (attachments?.length) {
      const maxCipherSize = LIMITS.MAX_VIDEO_ATTACHMENT_SIZE + E2E_GCM_TAG_BYTES;
      await verifyAttachmentUploads(attachments.map((a) => ({
        key: a.s3Key,
        declaredSize: a.fileSize,
        maxSize: maxCipherSize,
      })));
    }

    const toWire = <M extends Parameters<typeof shapeConversationMessageRow>[0] & { replyTo: { createdAt: Date } | null }>(m: M) =>
      ({ ...shapeConversationMessageRow(m, conversationId), reactions: [] });

    // One transaction under the conversation row lock (utils/conversationLifecycle.ts):
    // a removal cannot pass it, a conversation deleted meanwhile answers 404,
    // and the sides that had it hidden see it again. The event goes out right
    // after the commit, to the audience read then (the writer's `announce`).
    const { message, context } = await writeConversationMessage(conversationId, userId, async (tx, ctx) => {
      await assertReplyParent(tx, ctx.authorFloor);
      let msg: { id: string };
      try {
        msg = await tx.message.create({
          data: {
            content,
            encrypted: true,
            conversationId,
            authorId: userId,
            // after every floor and the newest message (newMessageTime), so everyone sees it
            createdAt: ctx.createdAt,
            ...(replyToId && { replyToId }),
          },
        });
      } catch (err) {
        // The parent was deleted after the check (its key refused): the
        // answer a missing parent always gets. Anything else is itself.
        if (replyToId && violatesForeignKey(err, 'messages_reply_to_id_fkey')) throw new BadRequestError('Invalid replyToId');
        throw err;
      }
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
    }, (written, audience) => {
      emitRowToViewers(getIO(), 'dm:message:new', conversationId, audience, toWire(written));
    });

    res.status(201).json({ success: true, data: rowForViewer(toWire(message), context.authorFloor) });
  } catch (err) {
    next(err);
  }
});

// There is deliberately no "enable encryption" route: POST
// /:conversationId/encryption was removed in the always-on cutover (docs/e2e-always-on-plan.md §4.2,
// §5). Conversations are encrypted from the moment they are created, so there
// is nothing to turn on and no window in which a conversation is plaintext.

// ─── Edit DM ─────────────────────────────────────────────────────────────────

dmRouter.patch('/:conversationId/messages/:messageId', rateLimitInteract, async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;
    const wantsEncrypted = req.body.encrypted === true;

    const view = await loadConversationView(conversationId, userId);
    refuseReadOnly(view);

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    // a row the caller cleared answers like a missing one
    if (!isVisibleMessage(message, conversationId, view.floor)) throw new NotFoundError('Message');
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

    const editMessage = (db: Pick<Prisma.TransactionClient, 'message'>) => db.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        author: authorSelect,
        replyTo: replyToSelect,
        reactions: reactionInclude,
        attachments: attachmentSelect,
      },
    });
    // Under the conversation row lock, read-only refused again there
    // (utils/conversationLifecycle.ts): an account deletion that committed
    // meanwhile turned the conversation read-only
    const updated = await changeConversationMessage(conversationId, userId, { refuseReadOnly: true }, async (tx) => {
      try {
        return await editMessage(tx);
      } catch (err) {
        // deleted after the read above (no row to update): a missing message
        if (prismaErrorCode(err) === 'P2025') throw new NotFoundError('Message');
        throw err;
      }
    });

    const row = { ...shapeConversationMessageRow(updated, conversationId), reactions: aggregateReactions(updated.reactions) };
    // to the audience as it stands after the write
    emitRowToViewers(getIO(), 'dm:message:update', conversationId, await readConversationAudience(conversationId, view.sides), row);

    res.json({ success: true, data: rowForViewer(row, view.floor) });
  } catch (err) {
    next(err);
  }
});

// ─── Delete DM ───────────────────────────────────────────────────────────────

dmRouter.delete('/:conversationId/messages/:messageId', rateLimitInteract, async (req: Request<{ conversationId: string; messageId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId, messageId } = req.params;
    const userId = req.user!.userId;

    const view = await loadConversationView(conversationId, userId);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { attachments: { select: { s3Key: true } } },
    });
    if (!isVisibleMessage(message, conversationId, view.floor)) throw new NotFoundError('Message');
    if (message.authorId !== userId) throw new ForbiddenError('You can only delete your own messages');

    // Under the conversation row lock (utils/conversationLifecycle.ts), where
    // it queues with an account deletion of the other person instead of
    // meeting its rewrite of their messages row by row. Allowed in a
    // read-only conversation: the person left may delete their own messages.
    await changeConversationMessage(conversationId, userId, { refuseReadOnly: false }, async (tx) => {
      try {
        await tx.message.delete({ where: { id: messageId } });
      } catch (err) {
        // deleted after the read above (a second delete of the same row): a
        // missing message, whose files the first delete took care of
        if (prismaErrorCode(err) === 'P2025') throw new NotFoundError('Message');
        throw err;
      }
    });

    // Fire-and-forget S3 cleanup
    if (message.attachments.length > 0) {
      deleteMultipleFromS3(message.attachments.map((a) => a.s3Key)).catch((err) => console.warn('[S3] Failed to delete DM attachments:', describeStoreError(err)));
    }

    // not to a side that cleared the row: it is already gone for them
    viewersRoom(getIO(), conversationId, await readConversationAudience(conversationId, view.sides), message.createdAt)
      .emit('dm:message:delete', { messageId, conversationId });

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

    const view = await loadConversationView(conversationId, userId);
    refuseReadOnly(view);

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, createdAt: true },
    });
    if (!isVisibleMessage(message, conversationId, view.floor)) throw new NotFoundError('Message');

    // Under the conversation row lock, read-only refused again there
    // (utils/conversationLifecycle.ts): an account deletion that committed
    // meanwhile deleted every reaction on the deleted account's messages, and
    // one added after it would sit on a placeholder.
    const action = await changeConversationMessage(conversationId, userId, { refuseReadOnly: true }, async (tx): Promise<'add' | 'remove'> => {
      const existing = await tx.messageReaction.findUnique({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
      });

      // Toggle is check-then-act — both branches must be idempotent so a
      // double-click's losing request doesn't 500 (see messages.ts reactions)
      if (existing) {
        await tx.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
        return 'remove';
      }
      const distinctCount = await tx.messageReaction.groupBy({
        by: ['emoji'],
        where: { messageId },
      });
      if (distinctCount.length >= LIMITS.MAX_REACTIONS_PER_MESSAGE) {
        throw new BadRequestError(`Maximum of ${LIMITS.MAX_REACTIONS_PER_MESSAGE} different reactions per message`);
      }
      try {
        // ON CONFLICT DO NOTHING: the concurrent duplicate add won the race,
        // same outcome, and no failed statement aborts the transaction
        await tx.messageReaction.createMany({ data: [{ messageId, userId, emoji }], skipDuplicates: true });
      } catch (err) {
        // The message deleted after the read above (its key refused): a
        // missing message. Anything else is itself.
        if (violatesForeignKey(err, 'message_reactions_message_id_fkey')) throw new NotFoundError('Message');
        throw err;
      }
      return 'add';
    });

    const rawReactions = await prisma.messageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
      orderBy: { createdAt: 'asc' },
    });
    const reactions = aggregateReactions(rawReactions);

    viewersRoom(getIO(), conversationId, await readConversationAudience(conversationId, view.sides), message.createdAt).emit('dm:message:reaction_update', {
      messageId, conversationId, emoji, userId, action, reactions,
    });

    res.json({ success: true, data: { action, reactions } });
  } catch (err) {
    next(err);
  }
});

// ─── Remove conversation (for the caller only) ──────────────────────────────

// The person who asks takes the conversation off their own list (#47). The
// other person is told nothing and keeps it, with its whole history. Without
// a flag (what the 2.1.x desktop sends, with no confirmation) it is only
// hidden, its history kept: it comes back whole when anyone writes or the
// caller opens it again. With `?clearHistory=true` (sent after a
// confirmation) everything up to now is gone for the caller for good; a
// later message brings the conversation back with only what is newer. Once
// nobody can reach anything of it any more, its rows are deleted. The answer
// is the one this route always gave, with the floor added when there is one.
dmRouter.delete('/:conversationId', rateLimitInteract, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;
    const clearHistory = parseClearHistory(req.query.clearHistory);

    // The early answer (404 / 403) before the row lock; the removal repeats
    // both under it
    await loadConversationView(conversationId, userId);

    const removal = await removeConversationForUser(conversationId, userId, { clearHistory });

    // Everything below is best effort, each step on its own: the removal has
    // committed, so a step that throws is logged and the request still
    // answers it.
    const io = getIO();

    // The files of a conversation that was deleted, after its row; never
    // awaited, never throws
    if (removal.deleted) deleteAttachmentBlobs(removal.attachmentKeys, '[DM]', `conversation ${conversationId}`);

    // A call the REMOVER is in there (connected, or their own outgoing ring)
    // ends: a call is 1-on-1, so without them there is none. Both sides get
    // dm:voice:ended (sent to dm:{id}, so before that room is emptied), the
    // call's Redis state goes and the sockets leave dm:voice:{id}. No "call
    // ended" notice: it would be a message newer than the removal, which
    // brings the conversation back for the remover. With the call's state
    // gone first, the remover's client leaving the call writes none either.
    // The other person ringing the remover is left alone (they are told
    // nothing): that ring ends by a decline or a timeout as usual, and the
    // notice it writes brings the conversation back like any new message. A
    // conversation that was deleted ends whatever call is left in it: there
    // is no conversation to hold one.
    try {
      if (removal.deleted) await endDMCall(io, conversationId, { notice: false });
      else await endDMCallIfParticipant(io, conversationId, userId, { notice: false });
    } catch (err) {
      logRemovalFanOutFailure(conversationId, 'ending its call', err);
    }

    // Every device of the remover, and nobody else
    try {
      io.to(userRoom(userId)).emit('dm:conversation:deleted', {
        conversationId,
        ...(removal.clearedUntil && { clearedUntil: removal.clearedUntil.toISOString() }),
      });
    } catch (err) {
      logRemovalFanOutFailure(conversationId, 'the dm:conversation:deleted notice', err);
    }

    // The remover's sockets STAY in dm:{id} while the conversation exists: a
    // later message reaches them there and brings it back. A conversation
    // that was deleted empties the room: an adapter-wide room operation,
    // never a `fetchSockets()` round trip (it waits for every node's reply
    // and throws after 5 s when one peer is unresponsive). Local form first,
    // then cluster-wide (see utils/memberBroadcast.ts: the Redis adapter
    // applies the cluster form on this node only when its own message comes
    // back), published after the notice on the same Redis connection.
    if (removal.deleted) {
      const rooms = [`dm:${conversationId}`];
      try {
        io.local.in(rooms).socketsLeave(rooms);
      } catch (err) {
        logRemovalFanOutFailure(conversationId, 'the local room leave', err);
      }
      try {
        io.in(rooms).socketsLeave(rooms);
      } catch (err) {
        logRemovalFanOutFailure(conversationId, 'the cluster room leave', err);
      }
    }

    // `data.clearedUntil` when this removal set the remover's floor or kept a
    // higher one (the same value as the event's): the device that asked
    // purges its cache from the answer, whatever its socket missed. A
    // removal that cleared nothing answers exactly what the route always did.
    res.json({
      success: true,
      message: 'Conversation deleted',
      ...(removal.clearedUntil && { data: clearedFloorField(removal.clearedUntil) }),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Mark conversation as read ───────────────────────────────────────────────

dmRouter.post('/:conversationId/read', rateLimitMarkRead, async (req: Request<{ conversationId: string }>, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user!.userId;

    await loadConversationView(conversationId, userId);

    // The last read only: never the caller's removal state (hiddenAt,
    // clearedAt), which a read does not change
    try {
      await prisma.conversationRead.upsert({
        where: { userId_conversationId: { userId, conversationId } },
        update: { lastReadAt: new Date() },
        create: { userId, conversationId, lastReadAt: new Date() },
      });
    } catch (err) {
      // the conversation was really deleted after the view (the new read
      // row's key refused): a missing conversation. Anything else is itself.
      if (violatesForeignKey(err, 'conversation_reads_conversation_id_fkey')) throw new NotFoundError('Conversation');
      throw err;
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
