import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateChannelName, WS_EVENTS, Permissions, E2E_LIMITS, type Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { replayVoiceState } from '../websocket/voiceHandler';
import { rateLimitSecureChannelManage, rateLimitMemberManage } from '../middleware/rateLimiter';
import { sanitizeText } from '../utils/sanitize';
import { getEffectiveLimits } from '../utils/serverLimits';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from '../utils/transactionRetry';
import { positionAfter } from '../utils/sortPosition';
import { hasServerPermission } from '../utils/permissionCalculator';
import {
  broadcastSecureMembersUpdated,
  getSecureChannelMembersPayload,
  lockServerMemberRows,
  removeSecureMember,
  undoRoomJoinsOfRemovedMembers,
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
    // A ChannelMember row counts only with the space membership behind it.
    // A departure removes both in one transaction and a join starts with no
    // row, so they agree; this read keeps the rule here on its own too
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
      throw new BadRequestError('Channel type must be "text" or "voice"');
    }

    // Invitees: optional, deduped, never the creator, capped, all server
    // members (checked in the transaction below)
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

    // Secure channels have their own limit (maxSecureChannelsPerServer), apart
    // from maxChannelsPerServer
    const limits = await getEffectiveLimits(serverId);

    const now = new Date();
    const allMemberIds = [userId, ...memberIds];
    // Run again when PostgreSQL aborts it to break a deadlock (a space delete
    // takes the space row, then the member rows): the second run then finds
    // the space gone and answers so. The long budget: an account deletion of
    // a listed member holds their member row through its whole cascade, and a
    // space delete the space row through its own; a creation waiting for
    // either must not expire meanwhile.
    const channel = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      // Every row written below belongs to a current member of the space,
      // the creator included: their membership rows are locked FIRST (a
      // removal of one of them waits for this transaction, then deletes what
      // it wrote, or committed before and the row is gone) and before the
      // space row, the order a removal takes them in.
      const members = await lockServerMemberRows(tx, serverId, allMemberIds);
      // Count, place and insert under the space row lock, so two concurrent
      // creations can neither both pass the limit nor take one position. A
      // space deleted since the permission check answers as one: not found.
      const space = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM servers WHERE id = ${serverId} FOR UPDATE`;
      if (space.length === 0) throw new NotFoundError('Server');
      if (!members.has(userId)) {
        throw new ForbiddenError('You do not have permission to create secure channels');
      }
      if (members.size !== allMemberIds.length) {
        throw new BadRequestError('All invited users must be members of this server');
      }
      const secureCount = await tx.channel.count({ where: { serverId, secure: true } });
      if (secureCount >= limits.maxSecureChannelsPerServer) {
        throw new BadRequestError(`Server can have at most ${limits.maxSecureChannelsPerServer} secure channels`);
      }
      // After every channel of the space, read under the same lock: a
      // concurrent creation, secure or not, never takes the same position
      const { _max } = await tx.channel.aggregate({ where: { serverId }, _max: { position: true } });
      const ch = await tx.channel.create({
        data: {
          name,
          type,
          secure: true,
          createdById: userId,
          serverId,
          position: positionAfter(_max.position),
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
    }, LOCK_WAIT_TRANSACTION_OPTIONS), '[SecureChannels] A secure-channel creation');

    // Members-only fanout: their sidebars gain the channel, their sockets join
    // the room. The server room is deliberately never touched.
    const io = getIO();
    for (const uid of allMemberIds) {
      io.to(`user:${uid}`).emit(WS_EVENTS.CHANNEL_CREATED, channel as unknown as Channel);
      io.in(`user:${uid}`).socketsJoin(`channel:${channel.id}`);
    }
    // A member removed since the commit got their room leave before this
    // join: take them back out
    await undoRoomJoinsOfRemovedMembers(channel.id, allMemberIds);

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

    const members = await getSecureChannelMembersPayload(channelId, serverId);
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

    // Run again when PostgreSQL aborts it to break a deadlock (a space
    // delete): the second run then finds the channel gone and answers so.
    // The long budget: an account deletion of the target holds their member
    // row, and one of another member the channel row, through its whole
    // cascade, and an invite waiting for either must not expire meanwhile.
    const channel = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      // The target's space membership is checked HERE, under a lock on its
      // row, taken first (before the channel row, the order a removal takes
      // them in): a removal of the target waits for this transaction and then
      // deletes the row written below, or it committed first and there is no
      // row to lock.
      const members = await lockServerMemberRows(tx, serverId, [targetUserId]);

      // Cap + duplicate checks live INSIDE the transaction, serialized by a
      // row lock on the channel: two concurrent invites both reading count=24
      // under READ COMMITTED would otherwise both insert — and an over-cap
      // channel is not just untidy, the CLIENT refuses to encrypt to more than
      // the cap, so every member's sends would break. A channel deleted since
      // the gate above (its creator's departure or its space's delete) answers
      // like any other missing channel, before the target's membership.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM channels WHERE id = ${channelId} AND server_id = ${serverId} AND secure = true FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError('Channel');
      if (!members.has(targetUserId)) throw new BadRequestError('User is not a member of this server');

      // One after the other, never Promise.all: Prisma gives a findUnique its
      // own batch, so issued together these two ran at once on the
      // transaction's ONE pg connection (pg 8 deprecates it, pg 9 removes
      // it); under the row lock there is nothing to gain from overlapping.
      // __tests__/utils/transactionRelationLoads.test.ts holds the rule.
      const existing = await tx.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: targetUserId } },
        select: { userId: true },
      });
      const memberCount = await tx.channelMember.count({ where: { channelId } });
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
    }, LOCK_WAIT_TRANSACTION_OPTIONS), '[SecureChannels] A secure-channel invite');

    // The invitee's sidebar gains the channel; their sockets join the room
    const io = getIO();
    io.to(`user:${targetUserId}`).emit(WS_EVENTS.CHANNEL_CREATED, channel as unknown as Channel);
    io.in(`user:${targetUserId}`).socketsJoin(`channel:${channelId}`);
    // An invitee removed since the commit got their room leave before this
    // join: take them back out, and replay them nothing
    const stillMember = (await undoRoomJoinsOfRemovedMembers(channelId, [targetUserId])).has(targetUserId);
    // Every voice event in that room happened before their sockets were in
    // it: replay the occupants, as the connect path does, or a call already
    // in progress reads empty to the invitee until someone moves. Best
    // effort — the invitation stands either way.
    if (stillMember) {
      try {
        await replayVoiceState(io.to(`user:${targetUserId}`), [serverId], new Set([channelId]), { source: 'connect' });
      } catch (err) {
        console.warn('[SecureChannels] Could not replay voice occupancy to the invitee:', err instanceof Error ? err.message : err);
      }
    }

    await broadcastSecureMembersUpdated(channelId, serverId);

    res.status(201).json({ success: true, data: await getSecureChannelMembersPayload(channelId, serverId) });
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
