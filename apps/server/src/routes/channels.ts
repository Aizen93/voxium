import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateChannelName, WS_EVENTS, Permissions, permissionsFromString, hasPermission, DEFAULT_EVERYONE_PERMISSIONS, type Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { rateLimitCategoryManage, rateLimitMarkRead } from '../middleware/rateLimiter';
import { sanitizeText } from '../utils/sanitize';
import { getEffectiveLimits } from '../utils/serverLimits';
import { hasServerPermission, hasChannelPermission, filterVisibleChannels, computeServerPermissions } from '../utils/permissionCalculator';
import { deleteSecureChannel } from '../utils/secureChannelLifecycle';
import { emitWebhookChanged } from '../utils/webhookLifecycle';
import { broadcastChannelVoiceCleanup } from '../websocket/voiceCluster';
import { collectAttachmentKeys, deleteAttachmentBlobs } from '../utils/attachmentBlobs';
import { isSortPosition, MAX_SORT_POSITION, positionAfter } from '../utils/sortPosition';
import { retryOnTransactionConflict } from '../utils/transactionRetry';

export const channelRouter = Router({ mergeParams: true });

channelRouter.use(authenticate, requireVerifiedEmail, requireConsent);

/** User rooms per broadcast when the audience has to be enumerated. Bounds the
 *  size of a single adapter message on a large staff-gated server. */
const ROOM_FANOUT_BATCH = 500;

/** A step after a channel's row delete committed failed: logged, never thrown. */
function logChannelDeleteFanOutFailure(channelId: string, step: string, err: unknown): void {
  console.error(`[Channels] Channel ${channelId} deleted, but ${step} failed:`, err instanceof Error ? err.message : err);
}

/**
 * The rooms to announce a BRAND-NEW channel to. A new channel has no overrides
 * yet, so visibility is exactly base VIEW_CHANNEL — no per-user recompute
 * needed, and in the common case no enumeration either.
 *
 * Fast path: if @everyone already carries VIEW_CHANNEL (or ADMINISTRATOR),
 * every member can see it and one server-wide op does the whole job — the
 * O(1) behaviour MED-15 was careful to keep.
 *
 * Otherwise the audience is derived from roles: members holding a role with
 * VIEW_CHANNEL or ADMINISTRATOR, plus the owner (who may hold no MemberRole
 * rows at all). Addressed as `user:{id}` rooms, which are adapter-wide and so
 * work across nodes — never `fetchSockets()`.
 */
async function visibilityRoomsForNewChannel(serverId: string): Promise<(string | string[])[]> {
  const [everyoneRole, server] = await Promise.all([
    prisma.role.findFirst({ where: { serverId, isDefault: true }, select: { id: true, permissions: true } }),
    prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
  ]);
  const everyonePerms = everyoneRole
    ? permissionsFromString(everyoneRole.permissions)
    : DEFAULT_EVERYONE_PERMISSIONS;
  const grantsView = (perms: bigint) =>
    hasPermission(perms, Permissions.VIEW_CHANNEL) || hasPermission(perms, Permissions.ADMINISTRATOR);

  if (grantsView(everyonePerms)) return [`server:${serverId}`];

  const viewRoles = (await prisma.role.findMany({ where: { serverId }, select: { id: true, permissions: true } }))
    .filter((r) => grantsView(permissionsFromString(r.permissions)))
    .map((r) => r.id);
  const holders = viewRoles.length > 0
    ? await prisma.memberRole.findMany({
        where: { serverId, roleId: { in: viewRoles } },
        // distinct: a member holding several VIEW-granting roles would
        // otherwise appear once per role, inflating the fan-out for nothing
        distinct: ['userId'],
        select: { userId: true },
      })
    : [];

  const userIds = new Set(holders.map((h) => h.userId));
  // The owner always sees everything here: this route cannot create a secure
  // channel, and secure is the one case where the owner fast path is skipped.
  if (server) userIds.add(server.ownerId);
  // The creator is NOT added unconditionally. MANAGE_CHANNELS and VIEW_CHANNEL
  // are independent bits, so a channel manager without a VIEW-granting role can
  // create a channel they cannot see — and adding them would put a socket in
  // `channel:{id}` for a channel `GET /servers/:id/channels` filters out for
  // them, which is precisely the leak this function exists to close, just
  // narrowed to one person. They are already in `holders` whenever they can
  // actually view it; when they cannot, announcing it live and then omitting it
  // from every subsequent fetch is the inconsistency, not the fix.

  const rooms = [...userIds].map((id) => `user:${id}`);
  // BroadcastOperator accepts an ARRAY of rooms and matches a socket in ANY of
  // them, so each batch is one adapter op rather than one per user.
  const batches: string[][] = [];
  for (let i = 0; i < rooms.length; i += ROOM_FANOUT_BATCH) {
    batches.push(rooms.slice(i, i + ROOM_FANOUT_BATCH));
  }
  return batches;
}

/** One entry of a reorder: a channel id, its new position and, optionally, its category (null: none). */
function isChannelOrderEntry(entry: unknown): entry is { id: string; position: number; categoryId?: string | null } {
  if (!entry || typeof entry !== 'object') return false;
  const { id, position, categoryId } = entry as Record<string, unknown>;
  return typeof id === 'string'
    && isSortPosition(position)
    && (categoryId === undefined || categoryId === null || typeof categoryId === 'string');
}

// Bulk reorder channels (with optional category reassignment)
channelRouter.put('/reorder', rateLimitCategoryManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CHANNELS);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage channels');

    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      throw new BadRequestError('order must be a non-empty array');
    }
    if (!order.every(isChannelOrderEntry)) {
      throw new BadRequestError(`Each order entry needs a channel id and a whole-number position from 0 to ${MAX_SORT_POSITION}`);
    }

    // Validate all channel IDs belong to this server. Secure channels are
    // excluded: they cannot be reordered/categorized by MANAGE_CHANNELS
    // holders, and a secure id must fail exactly like a foreign id (no oracle)
    const channelIds = order.map((o: { id: string }) => o.id);
    const channels = await prisma.channel.findMany({
      where: { id: { in: channelIds }, serverId, secure: false },
      select: { id: true, secure: true },
    });
    // A channel the caller cannot VIEW fails exactly like a foreign id: same
    // error, no way to tell the two apart, and no reordering of channels they
    // cannot see. Their own client only ever submits the visible ones, so this
    // costs a legitimate reorder nothing.
    const visible = await filterVisibleChannels(req.user!.userId, serverId, channels);
    if (visible.length !== channelIds.length) {
      throw new BadRequestError('One or more channel IDs do not belong to this server');
    }

    // Validate all non-null categoryIds belong to this server
    const categoryIds = [...new Set(
      order
        .map((o: { categoryId?: string | null }) => o.categoryId)
        .filter((id: string | null | undefined): id is string => id != null)
    )];
    if (categoryIds.length > 0) {
      const categories = await prisma.category.findMany({
        where: { id: { in: categoryIds }, serverId },
        select: { id: true },
      });
      if (categories.length !== categoryIds.length) {
        throw new BadRequestError('One or more category IDs do not belong to this server');
      }
    }

    // Update positions + categoryId in a transaction
    await prisma.$transaction(
      order.map((o: { id: string; position: number; categoryId?: string | null }) =>
        prisma.channel.update({
          where: { id: o.id },
          data: { position: o.position, categoryId: o.categoryId ?? null },
        })
      )
    );

    // Re-read updated channels and emit events
    const updated = await prisma.channel.findMany({
      where: { id: { in: channelIds } },
    });
    // To the channel's OWN room, not the server's. Since the create path was
    // narrowed, `channel:{id}` IS the VIEW_CHANNEL audience — and a reorder
    // that includes a staff-only channel would otherwise put its name on the
    // wire for every connected member. The stock client drops it, which is not
    // the same as it not being sent.
    const io = getIO();
    for (const ch of updated) {
      io.to(`channel:${ch.id}`).emit(WS_EVENTS.CHANNEL_UPDATED, ch as unknown as Channel);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// List channels in a server
channelRouter.get('/', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const allChannels = await prisma.channel.findMany({
      where: { serverId },
      // id breaks position ties, as GET /servers/:serverId does: the sidebar
      // keeps whichever order its last list arrived in for equal positions
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });

    const channels = await filterVisibleChannels(req.user!.userId, serverId, allChannels);

    res.json({ success: true, data: channels });
  } catch (err) {
    next(err);
  }
});

// Create a channel
// The structure bucket the PATCH and the reorder already use
channelRouter.post('/', rateLimitCategoryManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const { type = 'text', categoryId } = req.body;
    const name = sanitizeText(req.body.name ?? '');

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CHANNELS);
    if (!canManage) throw new ForbiddenError('You do not have permission to create channels');

    // No VIEW_CHANNEL check here, deliberately. A new channel has no overrides,
    // so who can see it is decided entirely by base permissions — and a
    // MANAGE_CHANNELS holder carries VIEW_CHANNEL in any sane role setup
    // (@everyone has it by default), so the creator sees what they made for the
    // same reason everyone else does. Creation confers no special status, and
    // rejecting the create for a role that lacks VIEW would refuse work Discord
    // allows, to protect against a role nobody builds. The management routes
    // below DO require VIEW on their target — that is about not editing what
    // you cannot see, which is a different question.
    const nameErr = validateChannelName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    if (!['text', 'voice'].includes(type)) {
      throw new BadRequestError('Channel type must be "text" or "voice"');
    }

    // Validate categoryId if provided
    if (categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: categoryId, serverId },
      });
      if (!category) throw new BadRequestError('Category not found in this server');
    }

    const limits = await getEffectiveLimits(serverId);

    // Count, place and insert under the space row lock (FOR UPDATE, the lock
    // a secure-channel or webhook creation takes too), so concurrent
    // creations in one space run one after the other: each counts, and
    // places itself after, the channels committed before it (each statement
    // reads afresh under READ COMMITTED). Two creations at the limit can no
    // longer both pass it, nor two creations take one position. Past the
    // space row, the insert only key-shares the category row through its
    // foreign key, and the one writer that locks a category row (its delete)
    // never takes a space row. Run again when PostgreSQL aborts it to break a
    // deadlock.
    const channel = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      // A space deleted since the permission check answers as one
      const space = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM servers WHERE id = ${serverId} FOR UPDATE`;
      if (space.length === 0) throw new NotFoundError('Server');
      // Secure channels count against their own limit (secureChannels.ts);
      // every channel, secure ones included, holds a position. One grouped
      // read gives the count and the highest position.
      const bySecure = await tx.channel.groupBy({
        by: ['secure'],
        where: { serverId },
        _count: { _all: true },
        _max: { position: true },
      });
      let regularCount = 0;
      let highest: number | null = null;
      for (const row of bySecure) {
        if (!row.secure) regularCount += row._count._all;
        if (row._max.position !== null && (highest === null || row._max.position > highest)) highest = row._max.position;
      }
      if (regularCount >= limits.maxChannelsPerServer) {
        throw new BadRequestError(`Server can have at most ${limits.maxChannelsPerServer} channels`);
      }
      return tx.channel.create({
        data: { name, type, serverId, position: positionAfter(highest), categoryId: categoryId || null },
      });
    }), '[Channels] A channel creation');

    // Announce to — and subscribe — exactly the members who can VIEW the new
    // channel, and nobody else. The old code did both server-wide on the
    // premise that "a new channel has no overrides, so everyone can view it",
    // but visibility is decided by BASE permissions (@everyone + the member's
    // roles) BEFORE overrides matter. In the standard staff-only setup, where
    // @everyone has no VIEW_CHANNEL, that put every connected member in the
    // room: they received message:new, typing, reactions — and, since voice
    // channels get the room too, voice presence and screen-share events —
    // until they happened to reconnect. `channel:{id}` is supposed to BE the
    // VIEW_CHANNEL boundary.
    //
    // The emit and the join must keep the SAME audience: narrowing one alone
    // leaves clients showing a channel that never produces events, or vice
    // versa.
    for (const room of await visibilityRoomsForNewChannel(serverId)) {
      getIO().to(room).emit('channel:created', channel as unknown as Channel);
      // Voice channels get the room too — it carries voice presence events.
      getIO().in(room).socketsJoin(`channel:${channel.id}`);
    }

    // NOTE (MED-15): no per-member ChannelRead seeding here. A brand-new channel
    // has zero messages, so the unread computation (COALESCE(last_read_at, epoch))
    // yields 0 for everyone regardless — while seeding wrote one row per member,
    // making channel creation in a 10k-member server a multi-second, lock-heavy
    // operation. Rows are created lazily when a member first reads the channel;
    // join-time seeding (which DOES guard against pre-existing history) stays.

    res.status(201).json({ success: true, data: channel });
  } catch (err) {
    next(err);
  }
});

// Mark a channel as read
channelRouter.post('/:channelId/read', rateLimitMarkRead, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;

    // Single query: verify membership + channel exists in this server
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId, server: { members: { some: { userId: req.user!.userId } } } },
      select: { id: true },
    });
    if (!channel) throw new ForbiddenError('Not authorized');

    // VIEW gate: without it, mark-read is a channel-existence oracle (and for
    // secure channels an enumeration hole — non-members must see the same
    // error as for a channel that does not exist)
    const canView = await hasChannelPermission(
      req.user!.userId, channelId, serverId, Permissions.VIEW_CHANNEL,
    );
    if (!canView) throw new ForbiddenError('Not authorized');

    await prisma.channelRead.upsert({
      where: { userId_channelId: { userId: req.user!.userId, channelId } },
      update: { lastReadAt: new Date() },
      create: { userId: req.user!.userId, channelId, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Update a channel (move between categories)
channelRouter.patch('/:channelId', rateLimitCategoryManage, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CHANNELS);
    if (!canManage) throw new ForbiddenError('You do not have permission to update channels');

    // Secure channels read as not-found: they are uncategorized by design, and
    // their lifecycle events go through secureChannelLifecycle, never here
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId, secure: false },
    });
    if (!channel) throw new NotFoundError('Channel');

    // Managing a channel requires being able to SEE it. Answering 404 rather
    // than 403 matches what this same caller gets for an id that does not
    // exist, so the check adds no existence oracle of its own.
    if (!await hasChannelPermission(req.user!.userId, channelId, serverId, Permissions.VIEW_CHANNEL)) {
      throw new NotFoundError('Channel');
    }

    const { categoryId } = req.body;
    if (categoryId === undefined) throw new BadRequestError('categoryId is required');

    // Validate categoryId if not null
    if (categoryId !== null) {
      const category = await prisma.category.findFirst({
        where: { id: categoryId, serverId },
      });
      if (!category) throw new BadRequestError('Category not found in this server');
    }

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: { categoryId },
    });

    // The channel's own room is the VIEW_CHANNEL audience; see the reorder note.
    getIO().to(`channel:${channelId}`).emit(WS_EVENTS.CHANNEL_UPDATED, updated as unknown as Channel);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a channel
channelRouter.delete('/:channelId', rateLimitCategoryManage, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;
    const userId = req.user!.userId;

    const [channel, canManage] = await Promise.all([
      prisma.channel.findFirst({
        where: { id: channelId, serverId },
        select: { id: true, secure: true, createdById: true, server: { select: { ownerId: true } } },
      }),
      hasServerPermission(userId, serverId, Permissions.MANAGE_CHANNELS),
    ]);

    if (channel?.secure) {
      // Secure channels: MANAGE_CHANNELS is NOT sufficient. Deletable by the
      // creator, or — the single opaque-moderation lever — the server owner /
      // an ADMINISTRATOR acting on a channel id learned from an abuse report.
      // Content stays unreadable either way; deletion is the only power.
      let allowed = channel.server.ownerId === userId;
      if (!allowed && channel.createdById === userId) {
        // The creator's lever holds while they are a member of the space AND
        // still the channel's creator member: a departure deletes the
        // creator's channels with it, and a channel that outlived one (its
        // creator's row removed by the channel_members migration) gives its
        // former creator no say over it, even after they join again
        const [spaceMember, creatorRow] = await Promise.all([
          prisma.serverMember.findUnique({
            where: { userId_serverId: { userId, serverId } },
            select: { userId: true },
          }),
          prisma.channelMember.findUnique({
            where: { channelId_userId: { channelId, userId } },
            select: { isCreator: true },
          }),
        ]);
        allowed = !!spaceMember && creatorRow?.isCreator === true;
      }
      if (!allowed) {
        const perms = await computeServerPermissions(userId, serverId);
        allowed = (perms & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR;
      }
      if (!allowed) {
        // Opacity, matched to what THIS caller would see for a nonexistent id:
        // without MANAGE_CHANNELS a nonexistent id gets the permission 403
        // below, so a secure id must too — a 404 here would be an INVERTED
        // oracle (404 ⇒ "a secure channel exists there").
        throw canManage
          ? new NotFoundError('Channel')
          : new ForbiddenError('You do not have permission to delete channels');
      }

      await deleteSecureChannel(channelId);
      res.json({ success: true, message: 'Channel deleted' });
      return;
    }

    if (!canManage) throw new ForbiddenError('You do not have permission to delete channels');

    if (!channel) throw new NotFoundError('Channel');

    // Same prerequisite as every other management op, and the same 404 as a
    // nonexistent id gives this caller. (The secure branch above returns
    // earlier and keeps its own, deliberately inverted, opacity rules.)
    if (!await hasChannelPermission(userId, channelId, serverId, Permissions.VIEW_CHANNEL)) {
      throw new NotFoundError('Channel');
    }

    // The channel's webhooks go with it (FK cascade) and leave the server's
    // webhook count, but channel:deleted reaches only the channel's own room: a
    // webhook manager who could not see the channel would keep a stale "N of M"
    // in the Integrations tab. webhook:changed carries the server id alone.
    const webhooks = await prisma.webhook.count({ where: { channelId } });
    // The cascade takes the attachment rows with the messages: their keys are
    // read now and the files deleted once the row is gone
    const attachmentKeys = await collectAttachmentKeys({ channelId });

    await prisma.channel.delete({ where: { id: channelId } });
    deleteAttachmentBlobs(attachmentKeys, '[Channels]', `channel ${channelId}`);

    // The row is gone: every step below is best effort, each on its own, so
    // one that throws is logged and never answers 500 for a delete that
    // happened (the client would keep a channel that no longer exists).
    const io = getIO();

    // Same audience as every other lifecycle event for this channel: the people
    // who could see it. Nobody else has it in their sidebar to remove.
    try {
      io.to(`channel:${channelId}`).emit('channel:deleted', { channelId, serverId });
    } catch (err) {
      logChannelDeleteFanOutFailure(channelId, 'the channel:deleted notice', err);
    }
    if (webhooks > 0) {
      try {
        emitWebhookChanged(serverId);
      } catch (err) {
        logChannelDeleteFanOutFailure(channelId, 'the webhook:changed notice', err);
      }
    }

    // Live voice must die with the channel on every node — participants used
    // to keep their transports (and the Redis mirror entry) until they left
    // manually. (deleteSecureChannel does the same for the secure branch.)
    try {
      await broadcastChannelVoiceCleanup(io, channelId);
    } catch (err) {
      logChannelDeleteFanOutFailure(channelId, 'the voice cleanup', err);
    }

    res.json({ success: true, message: 'Channel deleted' });
  } catch (err) {
    next(err);
  }
});
