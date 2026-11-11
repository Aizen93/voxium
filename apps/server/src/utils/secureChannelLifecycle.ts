import type { Prisma } from '../generated/prisma/client';
import { getIO } from '../websocket/socketServer';
import { prisma } from './prisma';
import { collectAttachmentKeys, deleteAttachmentBlobs } from './attachmentBlobs';
import { WS_EVENTS, e2eChannelScope } from '@voxium/shared';
import { broadcastChannelVoiceCleanup, broadcastVoiceEvictUser } from '../websocket/voiceCluster';

/**
 * Lifecycle helpers for SECURE channels (invite-only, E2E-encrypted).
 *
 * Invariants these helpers exist to uphold:
 *  - A ChannelMember row exists only while its user is a member of the
 *    channel's space. Access is derived from the row alone, so the rows go in
 *    the transaction that ends the space membership
 *    (`removeSecureMembershipsInTx`), and every write of a row checks the
 *    space membership inside its own transaction under a row lock
 *    (`lockServerMemberRows`).
 *  - Secure-channel events are NEVER emitted to `server:{id}` — non-members
 *    must learn nothing, so every emit targets member `user:{id}` rooms or the
 *    `channel:{id}` room (whose membership is already the member set).
 *  - Room membership operations go through the Socket.IO adapter
 *    (`io.in(...).socketsJoin/Leave`) so they work across nodes.
 *  - Attachment blobs are cleaned from S3 on channel deletion (they are
 *    ciphertext, but ciphertext nobody can ever read again is still storage).
 */

/**
 * Lock the `server_members` rows of `userIds` in `serverId` FOR SHARE and
 * return the ids that are members. Called first in every transaction that
 * writes a ChannelMember row, which then writes rows only for ids returned:
 * a removal deletes the membership row, so it waits for this transaction and
 * then deletes the rows written here, or it committed first and the row is
 * not there to lock. FOR SHARE, so two writers never wait for each other.
 * Taken BEFORE any channel or space row, the order the removal takes them
 * in, so the two never deadlock.
 */
export async function lockServerMemberRows(tx: Prisma.TransactionClient, serverId: string, userIds: string[]): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT user_id FROM server_members
    WHERE server_id = ${serverId} AND user_id = ANY(${userIds}::text[])
    ORDER BY user_id
    FOR SHARE`;
  return new Set(rows.map((r) => r.user_id));
}

/** What `removeSecureMembershipsInTx` removed, for the notices after the commit. */
export interface SecureMembershipRemoval {
  userId: string;
  /** The secure channels the user created: deleted with the membership (spec §19.1). */
  deleted: Array<{ channelId: string; serverId: string; memberIds: string[] }>;
  /** The secure channels the user was invited to and is no longer a member of. */
  left: Array<{ channelId: string; serverId: string }>;
}

/**
 * Inside the transaction that ends a space membership, AFTER that
 * transaction deleted the `server_members` row(s): removes every
 * secure-channel row the user holds in `serverId` (every space when it is
 * omitted, for an account deletion). Throws with the transaction, so a
 * removal commits with its rows gone or not at all.
 *
 *  - The channels the user created are deleted, which cascades every
 *    member's row (the creator is the channel's only manager: it does not
 *    outlive their membership, and a delete that fails fails the departure).
 *    They are locked first, FOR UPDATE, so the member list read for the
 *    notices is the one deleted: an invite into one of them holds that lock
 *    and is waited for.
 *  - The user's rows in every other channel of the space go, with the key
 *    shares addressed to them in those channels' scopes. They are deleted
 *    AFTER the member row: every writer of a row locks that member row first
 *    (`lockServerMemberRows`), the delete waits for one in progress, and this
 *    later statement then sees what it wrote; no writer can start after it.
 *
 * Statements one after the other, never in a Promise.all: they share the
 * transaction's one connection.
 */
export async function removeSecureMembershipsInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  serverId?: string,
): Promise<SecureMembershipRemoval> {
  const created = serverId === undefined
    ? await tx.$queryRaw<Array<{ id: string; server_id: string }>>`
        SELECT id, server_id FROM channels
        WHERE created_by_id = ${userId} AND secure = true
        ORDER BY id
        FOR UPDATE`
    : await tx.$queryRaw<Array<{ id: string; server_id: string }>>`
        SELECT id, server_id FROM channels
        WHERE created_by_id = ${userId} AND server_id = ${serverId} AND secure = true
        ORDER BY id
        FOR UPDATE`;
  const createdIds = created.map((c) => c.id);

  const deleted: SecureMembershipRemoval['deleted'] = [];
  if (createdIds.length > 0) {
    const members = await tx.channelMember.findMany({
      where: { channelId: { in: createdIds } },
      select: { channelId: true, userId: true },
    });
    await tx.channel.deleteMany({ where: { id: { in: createdIds }, secure: true } });
    for (const c of created) {
      deleted.push({
        channelId: c.id,
        serverId: c.server_id,
        memberIds: members.filter((m) => m.channelId === c.id).map((m) => m.userId),
      });
    }
  }

  // Every channel of the space, not only the secure ones: rows exist only
  // for secure channels, and none may survive the membership
  const where: Prisma.ChannelMemberWhereInput = serverId === undefined ? { userId } : { userId, channel: { serverId } };
  const rows = await tx.channelMember.findMany({
    where,
    select: { channelId: true, channel: { select: { serverId: true } } },
  });
  const left = rows.map((r) => ({ channelId: r.channelId, serverId: r.channel.serverId }));
  await tx.channelMember.deleteMany({ where });

  const scopes = [...createdIds, ...left.map((l) => l.channelId)].map(e2eChannelScope);
  if (scopes.length > 0) {
    // Unclaimed key shares addressed to the user in those channels die with
    // the membership: they can only carry sessions of the time they were a
    // member (the in-transaction key-share gate refuses new ones), but a share
    // left claimable outlives the row it was meant for.
    await tx.e2EKeyShare.deleteMany({
      where: { recipientUserId: userId, conversationId: { in: scopes } },
    });
  }

  return { userId, deleted, left };
}

/**
 * After the commit of a `removeSecureMembershipsInTx`: the notices, room
 * operations and voice teardown, every step best effort and on its own
 * (logged, never thrown — the rows are already gone).
 *
 * Deleted channels: `channel:deleted` to every member, the room emptied, live
 * voice torn down on every node. Channels left: `channel:deleted` to the user,
 * their sockets out of the room, their live voice session ended (spec §21:
 * the others re-key on the membership change) and the refreshed member list
 * to the members who remain.
 */
export async function announceSecureMembershipsRemoved(removal: SecureMembershipRemoval): Promise<void> {
  const io = getIO();
  for (const ch of removal.deleted) {
    await announceSecureChannelDeleted(ch.channelId, ch.serverId, ch.memberIds);
  }
  for (const { channelId, serverId } of removal.left) {
    try {
      io.to(`user:${removal.userId}`).emit(WS_EVENTS.CHANNEL_DELETED, { channelId, serverId });
      io.in(`user:${removal.userId}`).socketsLeave(`channel:${channelId}`);
    } catch (err) {
      logRemovedMemberNoticeFailure(channelId, 'the notice to the removed member', err);
    }
    try {
      await broadcastVoiceEvictUser(io, channelId, removal.userId);
    } catch (err) {
      logRemovedMemberNoticeFailure(channelId, 'the voice eviction', err);
    }
    await broadcastSecureMembersUpdated(channelId, serverId);
  }
}

function logRemovedMemberNoticeFailure(channelId: string, step: string, err: unknown): void {
  console.error(`[SecureChannel] Member removed from ${channelId}, but ${step} failed:`, err instanceof Error ? err.message : err);
}

/**
 * Member-list payload for CHANNEL_MEMBERS_UPDATED and the member-list route
 * (bounded by the member cap). Only rows whose user is a member of the space:
 * the list is what the members read as the channel's audience, and a row no
 * membership backs grants nothing.
 */
export async function getSecureChannelMembersPayload(channelId: string, serverId: string) {
  const members = await prisma.channelMember.findMany({
    where: { channelId, user: { memberships: { some: { serverId } } } },
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
    const members = await getSecureChannelMembersPayload(channelId, serverId);
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
    },
  });
  if (!channel || !channel.secure) return false;

  const memberIds = channel.members.map((m) => m.userId);
  // Read in bounded batches (utils/attachmentBlobs.ts), not as one nested
  // load of every message with an attachment the channel ever had
  const s3Keys = await collectAttachmentKeys({ channelId });

  await prisma.channel.delete({ where: { id: channelId } });

  // Started right after the row, ahead of the events: a fan-out step that
  // throws below must not skip it. Never awaited, never throws.
  deleteAttachmentBlobs(s3Keys, '[SecureChannel]', `deleted channel ${channelId}`);

  await announceSecureChannelDeleted(channelId, channel.serverId, memberIds);
  return true;
}

/**
 * After a secure channel's row delete committed: `channel:deleted` to every
 * member, the room emptied, live voice torn down on every node. Each step is
 * best effort and on its own, so one that throws neither skips the others
 * (the voice teardown above all) nor reports a channel that no longer exists
 * as not deleted. Never throws.
 */
async function announceSecureChannelDeleted(channelId: string, serverId: string, memberIds: string[]): Promise<void> {
  const io = getIO();
  try {
    for (const userId of memberIds) {
      io.to(`user:${userId}`).emit(WS_EVENTS.CHANNEL_DELETED, { channelId, serverId });
    }
  } catch (err) {
    logSecureDeleteFanOutFailure(channelId, 'the channel:deleted notices', err);
  }
  try {
    io.in(`channel:${channelId}`).socketsLeave(`channel:${channelId}`);
  } catch (err) {
    logSecureDeleteFanOutFailure(channelId, 'the room leave', err);
  }

  // Live voice in a deleted secure VOICE channel must die with it, on every
  // node (spec §21) — mediasoup handles are node-local, hence the fan-out.
  try {
    await broadcastChannelVoiceCleanup(io, channelId);
  } catch (err) {
    logSecureDeleteFanOutFailure(channelId, 'the voice cleanup', err);
  }
}

/** A step after a secure channel's row delete committed failed: logged, never thrown. */
function logSecureDeleteFanOutFailure(channelId: string, step: string, err: unknown): void {
  console.error(`[SecureChannel] Channel ${channelId} deleted, but ${step} failed:`, err instanceof Error ? err.message : err);
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

  // A removed member's live voice session must end NOW — remaining
  // participants rotate their media keys on the membership change, and the
  // removed member must not keep receiving even ciphertext (spec §21).
  await broadcastVoiceEvictUser(io, channelId, userId);

  await broadcastSecureMembersUpdated(channelId, serverId);
}
