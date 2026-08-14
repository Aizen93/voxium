import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateChannelName, WS_EVENTS, Permissions, type Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { rateLimitCategoryManage, rateLimitMarkRead } from '../middleware/rateLimiter';
import { sanitizeText } from '../utils/sanitize';
import { getEffectiveLimits } from '../utils/serverLimits';
import { hasServerPermission, hasChannelPermission, filterVisibleChannels, computeServerPermissions } from '../utils/permissionCalculator';
import { deleteSecureChannel } from '../utils/secureChannelLifecycle';
import { broadcastChannelVoiceCleanup } from '../websocket/voiceCluster';

export const channelRouter = Router({ mergeParams: true });

channelRouter.use(authenticate, requireVerifiedEmail);

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

    // Validate all channel IDs belong to this server. Secure channels are
    // excluded: they cannot be reordered/categorized by MANAGE_CHANNELS
    // holders, and a secure id must fail exactly like a foreign id (no oracle)
    const channelIds = order.map((o: { id: string }) => o.id);
    const channels = await prisma.channel.findMany({
      where: { id: { in: channelIds }, serverId, secure: false },
      select: { id: true },
    });
    if (channels.length !== channelIds.length) {
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
    const io = getIO();
    for (const ch of updated) {
      io.to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_UPDATED, ch as unknown as Channel);
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
      orderBy: { position: 'asc' },
    });

    const channels = await filterVisibleChannels(req.user!.userId, serverId, allChannels);

    res.json({ success: true, data: channels });
  } catch (err) {
    next(err);
  }
});

// Create a channel
channelRouter.post('/', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const { type = 'text', categoryId } = req.body;
    const name = sanitizeText(req.body.name ?? '');

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CHANNELS);
    if (!canManage) throw new ForbiddenError('You do not have permission to create channels');

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

    const [channelCount, limits] = await Promise.all([
      prisma.channel.count({ where: { serverId } }),
      getEffectiveLimits(serverId),
    ]);
    if (channelCount >= limits.maxChannelsPerServer) {
      throw new BadRequestError(`Server can have at most ${limits.maxChannelsPerServer} channels`);
    }

    const channel = await prisma.channel.create({
      data: { name, type, serverId, position: channelCount, categoryId: categoryId || null },
    });

    getIO().to(`server:${serverId}`).emit('channel:created', channel as unknown as Channel);

    // Auto-subscribe all connected members' sockets to the new channel room —
    // one adapter-wide op instead of fetching and looping every socket. A new
    // channel has no permission overrides yet, so everyone can view it. Voice
    // channels get the room too (it carries voice presence events).
    getIO().in(`server:${serverId}`).socketsJoin(`channel:${channel.id}`);

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

    // Secure channels read as not-found: they are uncategorized by design and
    // a CHANNEL_UPDATED broadcast to server:{id} would leak their name
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId, secure: false },
    });
    if (!channel) throw new NotFoundError('Channel');

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

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_UPDATED, updated as unknown as Channel);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a channel
channelRouter.delete('/:channelId', async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
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
      const isCreator = channel.createdById === userId;
      const isOwner = channel.server.ownerId === userId;
      let allowed = isCreator || isOwner;
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

    await prisma.channel.delete({ where: { id: channelId } });

    getIO().to(`server:${serverId}`).emit('channel:deleted', { channelId, serverId });

    // Live voice must die with the channel on every node — participants used
    // to keep their transports (and the Redis mirror entry) until they left
    // manually. (deleteSecureChannel does the same for the secure branch.)
    await broadcastChannelVoiceCleanup(getIO(), channelId);

    res.json({ success: true, message: 'Channel deleted' });
  } catch (err) {
    next(err);
  }
});
