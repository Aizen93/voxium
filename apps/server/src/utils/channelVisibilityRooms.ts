import { getIO } from '../websocket/socketServer';
import { prisma } from './prisma';
import { filterVisibleChannelsForUsers } from './permissionCalculator';

/** Users per batched recompute. Keeps the `userId IN (...)` lists bounded on a
 *  server with tens of thousands of sockets connected at once. */
const USER_BATCH = 500;

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
/**
 * Is this socket an active participant of voice channel `channelId`?
 *
 * Judged by ROOM membership, which is node-independent: a local participant
 * joins `voice:{id}` in the voice handler, and a relayed participant (channel
 * owned by another node) is put in the same room by the owner-side shim via
 * `io.in(socketId).socketsJoin`. `socket.data.voiceChannelId` is NOT — it is
 * written on the owner node's shim only, and on the participant's home node
 * it is deliberately unset (it is the local-vs-relayed discriminator in
 * voice:join). Checking it alone made this guard depend on which node the
 * channel's Router happened to live on: a VIEW revoke mid-call dropped a
 * cross-node participant from `channel:{id}` — where every voice presence and
 * screen-share event is broadcast — while a same-node one kept it.
 * `fetchSockets()` serialises `rooms` onto every RemoteSocket, so the room
 * check works for both; the data field stays as a fallback for a hand-rolled
 * socket shape without rooms.
 */
function inVoiceChannel(s: { rooms?: Set<string>; data: { voiceChannelId?: string } }, channelId: string): boolean {
  return s.rooms?.has(`voice:${channelId}`) === true || s.data.voiceChannelId === channelId;
}

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

    // ONE batched recompute for every affected user, not one per user. The
    // per-user loop here cost 4-5 sequential queries each: a single role
    // permission edit on a 10k-member server with 5k sockets connected fired
    // ~20k uncapped queries, and rateLimitRoleManage allows 20 such edits a
    // minute. Membership is re-verified inside the batch (a user who left
    // loses their rooms), which also subsumes the old per-user lookup.
    const uids = [...socketsByUser.keys()];
    for (let i = 0; i < uids.length; i += USER_BATCH) {
      const batch = uids.slice(i, i + USER_BATCH);
      const visibleByUser = await filterVisibleChannelsForUsers(batch, serverId, channels);
      for (const uid of batch) {
        const visibleIds = visibleByUser.get(uid) ?? new Set<string>();
        const userSockets = socketsByUser.get(uid)!;
        for (const ch of channels) {
          for (const s of userSockets) {
            if (visibleIds.has(ch.id)) {
              s.join(`channel:${ch.id}`);
            } else if (!inVoiceChannel(s, ch.id)) {
              // Never cut a socket off from the voice channel it is actively in —
              // it must keep receiving that channel's presence events until it leaves
              s.leave(`channel:${ch.id}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Visibility] Failed to sync channel visibility rooms:', err);
  }
}
