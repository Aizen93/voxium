import { getIO } from '../websocket/socketServer';
import { prisma } from './prisma';
import { filterVisibleChannels } from './permissionCalculator';

/**
 * Re-sync `channel:{id}` room membership for connected members after a
 * permission-affecting mutation (role permissions changed, role deleted,
 * member roles reassigned, channel override changed).
 *
 * `channel:{id}` rooms are the visibility boundary for real-time events
 * (messages, typing, voice presence). REST reads enforce VIEW_CHANNEL per
 * request, but room membership is only computed at connect time — without
 * this resync, a member whose VIEW_CHANNEL was revoked keeps receiving live
 * events until they reconnect, and a member who was granted access receives
 * nothing until they reconnect.
 *
 * Scoping (both optional, both narrow the work):
 *  - opts.channelId — only re-sync one channel (channel override change)
 *  - opts.userId    — only re-sync one member's sockets (member role change)
 *
 * Uses fetchSockets() + RemoteSocket.join/leave, so it works across nodes
 * with the Redis adapter. Errors are logged, never thrown — a failed resync
 * must not fail the originating mutation (the next reconnect self-heals).
 */
export async function syncChannelVisibilityRooms(
  serverId: string,
  opts?: { channelId?: string; userId?: string },
): Promise<void> {
  try {
    const io = getIO();
    const room = opts?.userId ? `user:${opts.userId}` : `server:${serverId}`;
    const sockets = await io.in(room).fetchSockets();
    if (sockets.length === 0) return;

    const channels = await prisma.channel.findMany({
      where: { serverId, ...(opts?.channelId ? { id: opts.channelId } : {}) },
      // `secure` is load-bearing: filterVisibleChannels can only apply the
      // membership-only rule to channels it can recognize as secure
      select: { id: true, secure: true },
    });
    if (channels.length === 0) return;

    // Visibility is per-user; users can have multiple sockets
    const socketsByUser = new Map<string, typeof sockets>();
    for (const s of sockets) {
      const uid = s.data.userId as string | undefined;
      if (!uid) continue;
      const list = socketsByUser.get(uid) || [];
      list.push(s);
      socketsByUser.set(uid, list);
    }

    for (const [uid, userSockets] of socketsByUser) {
      // When scoped by userId, sockets come from the user room — confirm the
      // user is still a member of this server before recomputing visibility
      if (opts?.userId) {
        const membership = await prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: uid, serverId } },
          select: { userId: true },
        });
        if (!membership) {
          for (const ch of channels) {
            for (const s of userSockets) s.leave(`channel:${ch.id}`);
          }
          continue;
        }
      }

      const visible = await filterVisibleChannels(uid, serverId, channels);
      const visibleIds = new Set(visible.map((c) => c.id));
      for (const ch of channels) {
        for (const s of userSockets) {
          if (visibleIds.has(ch.id)) {
            s.join(`channel:${ch.id}`);
          } else if (s.data.voiceChannelId !== ch.id) {
            // Never cut a socket off from the voice channel it is actively in —
            // it must keep receiving that channel's presence events until it leaves
            s.leave(`channel:${ch.id}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Visibility] Failed to sync channel visibility rooms:', err);
  }
}
