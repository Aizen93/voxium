import { prisma } from './prisma';
import { getIO } from '../websocket/socketServer';
import { Permissions, permissionsFromString, hasPermission } from '@voxium/shared';
import type { ServerToClientEvents } from '@voxium/shared';

/**
 * Who hears about a server's join requests: the members who can act on them.
 *
 * Join-request events must NOT reach the whole `server:{id}` room — that
 * would show every member who is asking to join. The audience is enumerated
 * the way routes/channels.ts enumerates who can see a new channel: members
 * holding a role that grants KICK_MEMBERS or ADMINISTRATOR, plus the owner
 * (who may hold no MemberRole rows at all), addressed as `user:{id}` rooms,
 * which are adapter-wide and so work across nodes — never fetchSockets().
 *
 * The @everyone role is a role like any other here: if it grants
 * KICK_MEMBERS (unusual, but a server may do that), every member is a
 * moderator and the audience is every member — still addressed per user, so
 * the rule "never the server room" holds by construction.
 */
export async function moderatorAudienceUserIds(serverId: string): Promise<string[]> {
  const [server, roles] = await Promise.all([
    prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
    prisma.role.findMany({ where: { serverId }, select: { id: true, permissions: true, isDefault: true } }),
  ]);
  if (!server) return [];

  const grantsModeration = (perms: bigint) =>
    hasPermission(perms, Permissions.KICK_MEMBERS) || hasPermission(perms, Permissions.ADMINISTRATOR);
  const moderating = roles.filter((r) => grantsModeration(permissionsFromString(r.permissions)));

  const userIds = new Set<string>([server.ownerId]);
  if (moderating.some((r) => r.isDefault)) {
    // @everyone moderates: the audience is the member list
    const members = await prisma.serverMember.findMany({ where: { serverId }, select: { userId: true } });
    for (const m of members) userIds.add(m.userId);
  } else if (moderating.length > 0) {
    const holders = await prisma.memberRole.findMany({
      where: { serverId, roleId: { in: moderating.map((r) => r.id) } },
      // distinct: a member holding several moderating roles would otherwise
      // appear once per role
      distinct: ['userId'],
      select: { userId: true },
    });
    for (const h of holders) userIds.add(h.userId);
  }
  return [...userIds];
}

/** User rooms per emit — bounds the size of one adapter message. */
const ROOM_FANOUT_BATCH = 500;

/**
 * Emit one event to the moderator audience of a server, `user:{id}` rooms in
 * batches. Used by every join-request emit; nothing else should address the
 * moderators of a server.
 */
export async function emitToModerators<E extends keyof ServerToClientEvents>(
  serverId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): Promise<void> {
  // Every caller runs this AFTER its write committed. A failure here (the
  // audience lookup is two queries) must not turn a successful request into
  // a 500 the client would retry into the idempotent branch — log it and let
  // the moderators find the row in the Members tab.
  try {
    const userIds = await moderatorAudienceUserIds(serverId);
    if (userIds.length === 0) return;
    const io = getIO();
    for (let i = 0; i < userIds.length; i += ROOM_FANOUT_BATCH) {
      const rooms = userIds.slice(i, i + ROOM_FANOUT_BATCH).map((id) => `user:${id}`);
      io.to(rooms).emit(event, ...args);
    }
  } catch (err) {
    console.error(`[ModeratorAudience] Failed to emit ${String(event)} for server ${serverId}:`, err instanceof Error ? err.message : err);
  }
}
