import { getIO } from '../websocket/socketServer';
import { prisma } from './prisma';
import { deleteMultipleFromS3 } from './s3';
import { WS_EVENTS, e2eChannelScope } from '@voxium/shared';

/**
 * Lifecycle helpers for SECURE channels (invite-only, E2E-encrypted).
 *
 * Invariants these helpers exist to uphold:
 *  - Secure-channel events are NEVER emitted to `server:{id}` — non-members
 *    must learn nothing, so every emit targets member `user:{id}` rooms or the
 *    `channel:{id}` room (whose membership is already the member set).
 *  - Room membership operations go through the Socket.IO adapter
 *    (`io.in(...).socketsJoin/Leave`) so they work across nodes.
 *  - Attachment blobs are cleaned from S3 on channel deletion (they are
 *    ciphertext, but ciphertext nobody can ever read again is still storage).
 */

/** Member-list payload for CHANNEL_MEMBERS_UPDATED (bounded by the member cap). */
export async function getSecureChannelMembersPayload(channelId: string) {
  const members = await prisma.channelMember.findMany({
    where: { channelId },
    orderBy: { addedAt: 'asc' },
    select: {
      userId: true,
      isCreator: true,
      addedAt: true,
      user: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
    },
  });
  return members.map((m) => ({
    userId: m.userId,
    isCreator: m.isCreator,
    addedAt: m.addedAt.toISOString(),
    user: m.user,
  }));
}

/**
 * Emit CHANNEL_MEMBERS_UPDATED to the channel room so member clients refresh
 * their member list and re-key their outbound Megolm session on next send.
 */
export async function broadcastSecureMembersUpdated(channelId: string, serverId: string): Promise<void> {
  try {
    const members = await getSecureChannelMembersPayload(channelId);
    getIO().to(`channel:${channelId}`).emit(WS_EVENTS.CHANNEL_MEMBERS_UPDATED, {
      channelId,
      serverId,
      members,
    });
  } catch (err) {
    console.error('[SecureChannel] Failed to broadcast members update:', err);
  }
}

/**
 * Delete a secure channel: DB row (cascades members/messages/attachments/reads),
 * member-scoped `channel:deleted` events, room teardown, S3 cleanup.
 *
 * Returns false if the channel does not exist or is not secure (callers treat
 * that as not-found — this helper must never delete a plaintext channel).
 */
export async function deleteSecureChannel(channelId: string): Promise<boolean> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      secure: true,
      serverId: true,
      members: { select: { userId: true } },
      messages: {
        select: { attachments: { select: { s3Key: true } } },
        where: { attachments: { some: {} } },
      },
    },
  });
  if (!channel || !channel.secure) return false;

  const memberIds = channel.members.map((m) => m.userId);
  const s3Keys = channel.messages.flatMap((m) => m.attachments.map((a) => a.s3Key));

  await prisma.channel.delete({ where: { id: channelId } });

  const io = getIO();
  for (const userId of memberIds) {
    io.to(`user:${userId}`).emit(WS_EVENTS.CHANNEL_DELETED, {
      channelId,
      serverId: channel.serverId,
    });
  }
  io.in(`channel:${channelId}`).socketsLeave(`channel:${channelId}`);

  if (s3Keys.length > 0) {
    // Fire-and-forget: a failed blob delete must not fail the channel delete;
    // the attachment rows are already gone so the sweep can't find them, hence
    // the loud log if this ever fails.
    deleteMultipleFromS3(s3Keys).catch((err) => {
      console.error(
        `[SecureChannel] Failed to delete ${s3Keys.length} attachment blob(s) for deleted channel ${channelId}:`,
        err,
      );
    });
  }

  return true;
}

/**
 * Delete every secure channel a user created (optionally scoped to one
 * server). Called BEFORE removing the user's ServerMember row (leave/kick) or
 * the user itself (account deletion) — the creator is the only membership
 * manager, so their channels do not outlive them.
 */
export async function deleteSecureChannelsOwnedBy(userId: string, serverId?: string): Promise<void> {
  const channels = await prisma.channel.findMany({
    where: { createdById: userId, secure: true, ...(serverId ? { serverId } : {}) },
    select: { id: true },
  });
  for (const ch of channels) {
    try {
      await deleteSecureChannel(ch.id);
    } catch (err) {
      console.error(`[SecureChannel] Failed to delete creator-owned channel ${ch.id}:`, err);
    }
  }
}

/**
 * Remove one member from a secure channel: membership + ChannelRead rows,
 * `channel:deleted` to the removed member (their sidebar drops the channel),
 * members-update to the remaining members, socket room teardown.
 */
export async function removeSecureMember(channelId: string, serverId: string, userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.channelMember.deleteMany({ where: { channelId, userId } }),
    prisma.channelRead.deleteMany({ where: { channelId, userId } }),
    // Hygiene: unclaimed key shares addressed to the removed member for this
    // channel's scope die with the membership. They could only ever carry the
    // OLD session (the in-tx keyshare gate refuses new ones once the row is
    // gone), but leaving them claimable is inbox litter and a wider window
    // than necessary.
    prisma.e2EKeyShare.deleteMany({
      where: { recipientUserId: userId, conversationId: e2eChannelScope(channelId) },
    }),
  ]);

  const io = getIO();
  io.to(`user:${userId}`).emit(WS_EVENTS.CHANNEL_DELETED, { channelId, serverId });
  io.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);

  await broadcastSecureMembersUpdated(channelId, serverId);
}

/**
 * Remove a departing server member from every secure channel in that server:
 * channels they created are deleted outright; channels they were invited to
 * just lose them as a member. Called from leave/kick BEFORE the ServerMember
 * row is removed.
 */
export async function purgeSecureChannelState(userId: string, serverId: string): Promise<void> {
  await deleteSecureChannelsOwnedBy(userId, serverId);

  // Channels the user CREATED are excluded here: they were handled above, and
  // if one of those deletes failed, stripping the creator's membership row now
  // would leave an orphan channel nobody can manage. Keeping the row costs
  // nothing — the permission calculator cross-checks ServerMember, so the
  // departed creator still computes to 0n everywhere.
  const memberships = await prisma.channelMember.findMany({
    where: { userId, channel: { serverId, secure: true, createdById: { not: userId } } },
    select: { channelId: true },
  });
  for (const m of memberships) {
    try {
      await removeSecureMember(m.channelId, serverId, userId);
    } catch (err) {
      console.error(`[SecureChannel] Failed to remove departing member from ${m.channelId}:`, err);
    }
  }
}

/**
 * Account-deletion variant: every server at once. The DB cascade would clean
 * the rows anyway — this exists for the EVENTS (created channels announce
 * their deletion to their members; remaining members of other channels get a
 * members-update so their UI refreshes). Called before the user delete.
 */
export async function purgeSecureChannelStateForAccount(userId: string): Promise<void> {
  await deleteSecureChannelsOwnedBy(userId);

  // Created channels excluded for the same orphan-channel reason as
  // purgeSecureChannelState (here the user-delete cascade is the backstop)
  const memberships = await prisma.channelMember.findMany({
    where: { userId, channel: { secure: true, createdById: { not: userId } } },
    select: { channelId: true, channel: { select: { serverId: true } } },
  });
  for (const m of memberships) {
    try {
      await removeSecureMember(m.channelId, m.channel.serverId, userId);
    } catch (err) {
      console.error(`[SecureChannel] Failed to remove deleted account from ${m.channelId}:`, err);
    }
  }
}
