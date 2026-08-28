import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateChannelName, WS_EVENTS, Permissions, E2E_LIMITS, type Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { rateLimitSecureChannelManage, rateLimitMemberManage } from '../middleware/rateLimiter';
import { sanitizeText } from '../utils/sanitize';
import { getEffectiveLimits } from '../utils/serverLimits';
import { hasServerPermission } from '../utils/permissionCalculator';
import {
  broadcastSecureMembersUpdated,
  getSecureChannelMembersPayload,
  removeSecureMember,
} from '../utils/secureChannelLifecycle';

/**
 * Secure channels: invite-only, E2E-encrypted text channels.
 *
 * OPACITY RULE — the load-bearing convention of this file: every failure that
 * could distinguish "this channel exists but you are not in it" from "no such
 * channel" returns the identical NotFoundError('Channel'). Owners and
 * ADMINISTRATOR holders are NOT exempt: their only surface is the count
 * endpoint and delete-by-id (routes/channels.ts DELETE).
 *
 * Socket rule: nothing here ever emits to `server:{serverId}` — creation and
 * membership events target member `user:{id}` rooms / the channel room only.
 */
export const secureChannelRouter = Router({ mergeParams: true });

secureChannelRouter.use(authenticate, requireVerifiedEmail, requireConsent);

/** Membership lookup used as the visibility gate by every :channelId route. */
async function getSecureChannelForMemberOrThrow(channelId: string, serverId: string, userId: string) {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, serverId, secure: true },
    select: { id: true, name: true, serverId: true, createdById: true },
  });
  if (!channel) throw new NotFoundError('Channel');
  const [membership, serverMembership] = await Promise.all([
    prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { isCreator: true },
    }),
    // Defense in depth against a stale ChannelMember row (a purge that failed
    // mid-leave): someone no longer in the SERVER gets nothing here either
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
      select: { userId: true },
    }),
  ]);
  // Non-member sees exactly what they would for a nonexistent channel
  if (!membership || !serverMembership) throw new NotFoundError('Channel');
  return { channel, isCreator: membership.isCreator };
}

// ─── Count (the whole opaque-moderation read surface) ───────────────────────

secureChannelRouter.get('/count', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManage) throw new ForbiddenError('You do not have permission to view server settings');

    const count = await prisma.channel.count({ where: { serverId, secure: true } });
    res.json({ success: true, data: { count } });
  } catch (err) {
    next(err);
  }
});

// ─── Create ─────────────────────────────────────────────────────────────────

secureChannelRouter.post('/', rateLimitSecureChannelManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const userId = req.user!.userId;

    const canCreate = await hasServerPermission(userId, serverId, Permissions.CREATE_SECURE_CHANNELS);
    if (!canCreate) throw new ForbiddenError('You do not have permission to create secure channels');

    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateChannelName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    // Secure channels come in two types: text (E2E messages) and voice (E2E
    // media frames, spec §21). Anything else is rejected.
    const type = req.body.type ?? 'text';
    if (type !== 'text' && type !== 'voice') {
      throw new BadRequestError('Channel type must be text or voice');
    }

    // Invitees: optional, deduped, never the creator, capped, all server members
    const rawMemberIds = req.body.memberIds ?? [];
    if (!Array.isArray(rawMemberIds) || rawMemberIds.some((id) => typeof id !== 'string')) {
      throw new BadRequestError('memberIds must be an array of user ids');
    }
    const memberIds = [...new Set(rawMemberIds as string[])].filter((id) => id !== userId);
    if (memberIds.length > E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP - 1) {
      throw new BadRequestError(
        `A secure channel can have at most ${E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP} members`,
      );
    }
    if (memberIds.length > 0) {
      const serverMembers = await prisma.serverMember.findMany({
        where: { serverId, userId: { in: memberIds } },
        select: { userId: true },
      });
      if (serverMembers.length !== memberIds.length) {
        throw new BadRequestError('All invited users must be members of this server');
      }
    }

    const [channelCount, limits] = await Promise.all([
      prisma.channel.count({ where: { serverId } }),
      getEffectiveLimits(serverId),
    ]);
    if (channelCount >= limits.maxChannelsPerServer) {
      throw new BadRequestError(`Server can have at most ${limits.maxChannelsPerServer} channels`);
    }

    const now = new Date();
    const allMemberIds = [userId, ...memberIds];
    const channel = await prisma.$transaction(async (tx) => {
      const ch = await tx.channel.create({
        data: {
          name,
          type,
          secure: true,
          createdById: userId,
          serverId,
          position: channelCount,
          categoryId: null,
        },
      });
      await tx.channelMember.createMany({
        data: allMemberIds.map((uid) => ({
          channelId: ch.id,
          userId: uid,
          isCreator: uid === userId,
        })),
      });
      // Unread tracking starts at creation for everyone present from the
      // start. Voice channels carry no messages — nothing to track.
      if (type === 'text') {
        await tx.channelRead.createMany({
          data: allMemberIds.map((uid) => ({ userId: uid, channelId: ch.id, lastReadAt: now })),
          skipDuplicates: true,
        });
      }
      return ch;
    });

    // Members-only fanout: their sidebars gain the channel, their sockets join
    // the room. The server room is deliberately never touched.
    const io = getIO();
    for (const uid of allMemberIds) {
      io.to(`user:${uid}`).emit(WS_EVENTS.CHANNEL_CREATED, channel as unknown as Channel);
      io.in(`user:${uid}`).socketsJoin(`channel:${channel.id}`);
    }

    res.status(201).json({ success: true, data: channel });
  } catch (err) {
    next(err);
  }
});

// ─── Member list ────────────────────────────────────────────────────────────

secureChannelRouter.get('/:channelId/members', async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;
    await getSecureChannelForMemberOrThrow(channelId, serverId, req.user!.userId);

    const members = await getSecureChannelMembersPayload(channelId);
    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// ─── Invite a member (creator only) ─────────────────────────────────────────

secureChannelRouter.post('/:channelId/members', rateLimitMemberManage, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;
    const userId = req.user!.userId;

    const { isCreator } = await getSecureChannelForMemberOrThrow(channelId, serverId, userId);
    if (!isCreator) throw new ForbiddenError('Only the channel creator can invite members');

    const targetUserId = req.body.userId;
    if (typeof targetUserId !== 'string' || !targetUserId) {
      throw new BadRequestError('userId is required');
    }

    const targetMembership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: targetUserId, serverId } },
      select: { userId: true },
    });
    if (!targetMembership) throw new BadRequestError('User is not a member of this server');

    // Cap + duplicate checks live INSIDE the transaction, serialized by a row
    // lock on the channel: two concurrent invites both reading count=24 under
    // READ COMMITTED would otherwise both insert — and an over-cap channel is
    // not just untidy, the CLIENT refuses to encrypt to more than the cap, so
    // every member's sends would break.
    const channel = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM channels WHERE id = ${channelId} FOR UPDATE`;

      const [existing, memberCount] = await Promise.all([
        tx.channelMember.findUnique({
          where: { channelId_userId: { channelId, userId: targetUserId } },
          select: { userId: true },
        }),
        tx.channelMember.count({ where: { channelId } }),
      ]);
      if (existing) throw new BadRequestError('User is already a member of this channel');
      if (memberCount >= E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP) {
        throw new BadRequestError(
          `A secure channel can have at most ${E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP} members`,
        );
      }

      await tx.channelMember.create({
        data: { channelId, userId: targetUserId, isCreator: false },
      });
      const ch = await tx.channel.findUniqueOrThrow({ where: { id: channelId } });
      // Unread starts at the join point: the invitee cannot decrypt pre-join
      // history (no-history rotation), so it must not count as unread either.
      // Voice channels carry no messages — nothing to track.
      if (ch.type === 'text') {
        await tx.channelRead.upsert({
          where: { userId_channelId: { userId: targetUserId, channelId } },
          update: { lastReadAt: new Date() },
          create: { userId: targetUserId, channelId, lastReadAt: new Date() },
        });
      }
      return ch;
    });

    // The invitee's sidebar gains the channel; their sockets join the room
    const io = getIO();
    io.to(`user:${targetUserId}`).emit(WS_EVENTS.CHANNEL_CREATED, channel as unknown as Channel);
    io.in(`user:${targetUserId}`).socketsJoin(`channel:${channelId}`);

    await broadcastSecureMembersUpdated(channelId, serverId);

    res.status(201).json({ success: true, data: await getSecureChannelMembersPayload(channelId) });
  } catch (err) {
    next(err);
  }
});

// ─── Remove a member / leave (creator removes anyone; members remove self) ──

secureChannelRouter.delete('/:channelId/members/:userId', rateLimitMemberManage, async (req: Request<{ serverId: string; channelId: string; userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId, userId: targetUserId } = req.params;
    const userId = req.user!.userId;

    const { channel, isCreator } = await getSecureChannelForMemberOrThrow(channelId, serverId, userId);

    const removingSelf = targetUserId === userId;
    if (!removingSelf && !isCreator) {
      throw new ForbiddenError('Only the channel creator can remove members');
    }
    // The creator is the sole membership manager — a channel without one would
    // be unmanageable, so the creator's exit is deletion, not leaving.
    if (targetUserId === channel.createdById) {
      throw new BadRequestError('The creator cannot leave — delete the channel instead');
    }

    const target = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!target) throw new BadRequestError('User is not a member of this channel');

    await removeSecureMember(channelId, serverId, targetUserId);

    res.json({ success: true, message: removingSelf ? 'Left channel' : 'Member removed' });
  } catch (err) {
    next(err);
  }
});

// ─── Rename (creator only) ──────────────────────────────────────────────────

secureChannelRouter.patch('/:channelId', rateLimitSecureChannelManage, async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, channelId } = req.params;
    const userId = req.user!.userId;

    const { isCreator } = await getSecureChannelForMemberOrThrow(channelId, serverId, userId);
    if (!isCreator) throw new ForbiddenError('Only the channel creator can rename this channel');

    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateChannelName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: { name },
    });

    // Channel room only — members are exactly the sockets in it
    getIO().to(`channel:${channelId}`).emit(WS_EVENTS.CHANNEL_UPDATED, updated as unknown as Channel);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});
