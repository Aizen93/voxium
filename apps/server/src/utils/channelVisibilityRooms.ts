import { randomUUID } from 'crypto';
import { OPAQUE_ID_RE } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { getVoiceStateForServers, replayVoiceState } from '../websocket/voiceHandler';
import { prisma } from './prisma';
import { filterVisibleChannelsForUsers } from './permissionCalculator';
import { getRedisPubSub, getRedisConfigSub, liveNodeCounts, NODE_ID } from './redis';

/** Users per batched recompute. Keeps the `userId IN (...)` lists bounded on a
 *  server with tens of thousands of sockets connected at once. */
const USER_BATCH = 500;

/** The Redis pub/sub channel every node listens on for resync requests. */
export const VISIBILITY_RESYNC_CHANNEL = 'visibility:resync';
/** Publishes of one resync request before the fail-closed fallback runs. */
export const RESYNC_PUBLISH_ATTEMPTS = 4;
/** Waits between those publishes (one fewer than the attempts): about 7.5 s
 *  in all, longer than the Redis clients' reconnect back-off (2 s at most), so
 *  a subscriber that is reconnecting is back before the last attempt. */
export const RESYNC_RETRY_DELAYS_MS: readonly number[] = [500, 2000, 5000];
/** How long one publish may take before it counts as failed. A command issued
 *  while the client reconnects waits in its offline queue instead of
 *  rejecting; it still goes out when the connection is back, and the
 *  receivers skip the copies they already applied (by message id). */
export const RESYNC_PUBLISH_TIMEOUT_MS = 2000;
/** Message ids a node remembers, so a retried publish runs once per node. */
const SEEN_IDS_MAX = 1024;

/**
 * Re-sync `channel:{id}` room membership for connected members after a
 * permission-affecting mutation (role permissions changed, role deleted,
 * member roles reassigned, channel override changed, ownership transferred).
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
 * PER NODE, and no node waits on another. The node handling the mutation
 * resyncs its OWN sockets (`io.local`, answered from this node's adapter, so
 * it cannot time out) and publishes the scope on VISIBILITY_RESYNC_CHANNEL;
 * every other node resyncs its own sockets when the message arrives. This used
 * to be one `io.in(room).fetchSockets()` over the whole cluster, which waits
 * for every node's reply and rejects after 5 s when one peer does not answer:
 * the error was logged and the resync skipped on EVERY node, so a member whose
 * VIEW_CHANNEL had just been revoked kept receiving the channel's messages,
 * typing, voice presence and screen-share events until they reconnected (the
 * boundary failed open because of one stalled peer). A stalled peer now only
 * delays its own sockets' resync until it reads the message.
 *
 * FAILURE PATH. The publish is confirmed by Redis's receiver count: every live
 * node (heartbeat, this one included) holds one subscription to the channel,
 * so fewer receivers than live nodes means a node missed it (its subscriber
 * was reconnecting, or it runs a build without the subscription). Pub/sub is
 * at most once, so an unconfirmed publish is retried (RESYNC_PUBLISH_ATTEMPTS,
 * RESYNC_RETRY_DELAYS_MS, each attempt logged), and when it is still
 * unconfirmed the resync FAILS CLOSED: `revokeHiddenRoomsClusterWide` derives
 * from the database which users of the scope may not view which channel and
 * makes their sockets leave those rooms on every node through the adapter
 * (no reply awaited), sparing the sockets in that channel's `voice:{id}` room.
 * Grants are not part of the fallback: a member who gained a channel receives
 * it at their next connect, which is a delay, never a leak.
 *
 * What the fallback cannot cover: it is published on the same Redis client as
 * the resync, so when THIS node cannot reach Redis at all both wait in that
 * client's offline queue and go out, in order, when it reconnects (until then
 * nothing this node emits reaches a peer either). A node that misses both
 * messages — its config and adapter subscribers both down for the whole
 * window — keeps its stale rooms until its sockets reconnect. A node killed
 * hard keeps its heartbeat for up to its 30 s TTL: a resync in that window is
 * unconfirmed and takes the fallback (logged), which is correct, only slower.
 *
 * Errors are logged, never thrown: a failed resync must not fail the
 * originating mutation, which fires and forgets it.
 */
export async function syncChannelVisibilityRooms(
  serverId: string,
  opts?: { channelId?: string; userId?: string },
): Promise<void> {
  const scope: ResyncScope = { serverId, channelId: opts?.channelId, userId: opts?.userId };
  // Independent halves, each catching its own errors: a database failure in
  // the local pass must not keep the peers from resyncing, nor the reverse
  await Promise.all([resyncLocalSockets(scope), fanOutResync(scope)]);
}

/**
 * Subscribe this node to the resync requests of its peers. Call once at
 * startup, after Socket.IO is initialised and before the server listens.
 */
export async function initChannelVisibilitySync(): Promise<void> {
  await getRedisConfigSub().subscribe(VISIBILITY_RESYNC_CHANNEL, (raw) => {
    handleResyncMessage(raw);
  });
}

// ─── Scope and wire format ──────────────────────────────────────────────────

interface ResyncScope {
  serverId: string;
  channelId?: string;
  userId?: string;
}

interface ResyncMessage extends ResyncScope {
  /** One id per resync request; its retries reuse it. */
  id: string;
  fromNode: string;
}

const isOptionalId = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && OPAQUE_ID_RE.test(value));

/** The message, or null when any field is not what a node publishes. */
function parseResyncMessage(value: unknown): ResyncMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, fromNode, serverId, channelId, userId } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !OPAQUE_ID_RE.test(id)) return null;
  if (typeof fromNode !== 'string' || fromNode.length === 0 || fromNode.length > 128) return null;
  if (typeof serverId !== 'string' || !OPAQUE_ID_RE.test(serverId)) return null;
  if (!isOptionalId(channelId) || !isOptionalId(userId)) return null;
  return { id, fromNode, serverId, channelId, userId };
}

const seenIds = new Map<string, true>();

/** True the first time an id is seen; remembers the last SEEN_IDS_MAX ids. */
function firstSighting(id: string): boolean {
  if (seenIds.has(id)) return false;
  seenIds.set(id, true);
  if (seenIds.size > SEEN_IDS_MAX) {
    const oldest = seenIds.keys().next().value;
    if (oldest !== undefined) seenIds.delete(oldest);
  }
  return true;
}

function handleResyncMessage(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[Visibility] Ignored a resync message that is not JSON:', err instanceof Error ? err.message : err);
    return;
  }
  const message = parseResyncMessage(parsed);
  if (!message) {
    console.warn('[Visibility] Ignored a resync message with an invalid shape');
    return;
  }
  // The originator runs its own local pass beside the publish
  if (message.fromNode === NODE_ID()) return;
  // A retry of a request this node already applied
  if (!firstSighting(message.id)) return;
  void resyncLocalSockets({ serverId: message.serverId, channelId: message.channelId, userId: message.userId });
}

// ─── The local pass ─────────────────────────────────────────────────────────

/**
 * Is this socket an active participant of voice channel `channelId`?
 *
 * Judged by ROOM membership, which is node-independent: a local participant
 * joins `voice:{id}` in the voice handler, and a relayed participant (channel
 * owned by another node) is put in the same room by the owner-side shim via
 * `io.in(socketId).socketsJoin`, which the adapter applies on the socket's
 * home node — the node that runs this check, since every node resyncs only
 * its own sockets. `socket.data.voiceChannelId` is NOT — it is written on the
 * owner node's shim only, and on the participant's home node it is
 * deliberately unset (it is the local-vs-relayed discriminator in voice:join).
 * Checking it alone made this guard depend on which node the channel's Router
 * happened to live on: a VIEW revoke mid-call dropped a cross-node
 * participant from `channel:{id}` — where every voice presence and
 * screen-share event is broadcast — while a same-node one kept it. The data
 * field stays as a fallback for a hand-rolled socket shape without rooms.
 */
function inVoiceChannel(s: { rooms?: Set<string>; data: { voiceChannelId?: string } }, channelId: string): boolean {
  return s.rooms?.has(`voice:${channelId}`) === true || s.data.voiceChannelId === channelId;
}

/** Resync THIS node's sockets for `scope`. Never rejects. */
async function resyncLocalSockets(scope: ResyncScope): Promise<void> {
  const { serverId } = scope;
  try {
    const io = getIO();
    const room = scope.userId ? `user:${scope.userId}` : `server:${serverId}`;
    // THIS node's sockets only: answered by the node's own adapter, it never
    // asks a peer and cannot time out (the peers run their own pass). They are
    // the real sockets, so `rooms` is this node's live view of each one.
    const sockets = await io.local.in(room).fetchSockets();
    if (sockets.length === 0) return;

    const channels = await prisma.channel.findMany({
      where: { serverId, ...(scope.channelId ? { id: scope.channelId } : {}) },
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
    // A socket that ENTERS a channel room here missed every voice event in
    // it, exactly like a socket that just connected: the occupants are
    // replayed to it (`source: 'connect'`: a snapshot to the client), or the
    // channel reads empty until someone moves. One Redis read decides which
    // of the affected channels have occupants at all, so the per-user replay
    // runs only for users who gained one of THOSE — a role edit on a big
    // server with nobody in voice costs one round trip, not one per user.
    const affectedIds = new Set(channels.map((c) => c.id));
    let occupied = new Set<string>();
    try {
      occupied = new Set((await getVoiceStateForServers([serverId])).map((v) => v.channelId).filter((id) => affectedIds.has(id)));
    } catch (err) {
      console.warn('[Visibility] Could not read voice occupancy for the replay:', err instanceof Error ? err.message : err);
    }

    const uids = [...socketsByUser.keys()];
    for (let i = 0; i < uids.length; i += USER_BATCH) {
      const batch = uids.slice(i, i + USER_BATCH);
      const visibleByUser = await filterVisibleChannelsForUsers(batch, serverId, channels);
      for (const uid of batch) {
        const visibleIds = visibleByUser.get(uid) ?? new Set<string>();
        const userSockets = socketsByUser.get(uid)!;
        const gained = new Set<string>();
        for (const ch of channels) {
          for (const s of userSockets) {
            if (visibleIds.has(ch.id)) {
              if (occupied.has(ch.id) && s.rooms?.has(`channel:${ch.id}`) !== true) gained.add(ch.id);
              s.join(`channel:${ch.id}`);
            } else if (!inVoiceChannel(s, ch.id)) {
              // Never cut a socket off from the voice channel it is actively in —
              // it must keep receiving that channel's presence events until it leaves
              s.leave(`channel:${ch.id}`);
            }
          }
        }
        if (gained.size > 0) {
          try {
            // To this node's sockets of the user: every node replays to its own
            await replayVoiceState(io.local.to(`user:${uid}`), [serverId], gained, { source: 'connect' });
          } catch (err) {
            console.warn('[Visibility] Could not replay voice occupancy to', uid, '(the rooms are joined):', err instanceof Error ? err.message : err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Visibility] Failed to resync this node's channel rooms for server ${serverId}:`, err);
  }
}

// ─── The fan-out ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or a rejection once `ms` have passed. Promise.race keeps a
 *  handler on the losing promise, so its late rejection is never unhandled. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from Redis within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One publish; resolves with how many subscribers received it and how many
 *  should have (every node with a live heartbeat, this one included). */
async function publishOnce(payload: string): Promise<{ received: number; expected: number }> {
  const { pub } = getRedisPubSub();
  const [received, { peers }] = await Promise.all([
    pub.publish(VISIBILITY_RESYNC_CHANNEL, payload),
    liveNodeCounts(),
  ]);
  return { received: Number(received), expected: peers + 1 };
}

/** Tell every other node to resync its sockets for `scope`; retried while
 *  unconfirmed, then the fail-closed fallback (see the header). */
async function fanOutResync(scope: ResyncScope): Promise<void> {
  const message: ResyncMessage = { id: randomUUID(), fromNode: NODE_ID(), ...scope };
  const payload = JSON.stringify(message);
  let failure = 'not attempted';
  for (let attempt = 1; attempt <= RESYNC_PUBLISH_ATTEMPTS; attempt++) {
    try {
      const { received, expected } = await withTimeout(publishOnce(payload), RESYNC_PUBLISH_TIMEOUT_MS);
      if (received >= expected) return;
      failure = `${received} subscriber(s) received it, ${expected} node(s) are live`;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (attempt < RESYNC_PUBLISH_ATTEMPTS) {
      console.warn(`[Visibility] Resync of server ${scope.serverId} not confirmed by every node (attempt ${attempt}/${RESYNC_PUBLISH_ATTEMPTS}: ${failure}); retrying`);
      await sleep(RESYNC_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }
  }
  console.error(`[Visibility] Resync of server ${scope.serverId} not confirmed by every node after ${RESYNC_PUBLISH_ATTEMPTS} attempts (${failure}): removing hidden channel rooms cluster-wide (fail closed)`);
  await revokeHiddenRoomsClusterWide(scope);
}

/**
 * The fail-closed fallback: every socket, on every node, of a user in `scope`
 * leaves the room of each channel of `scope` that user may not view, except a
 * socket in that channel's `voice:{id}` room (an active participant keeps its
 * channel's presence events until it leaves the call). Computed from the
 * database, never from a socket snapshot, and applied with adapter-wide room
 * operations that wait on no reply, so a silent peer cannot stop it.
 *
 * Cost, on this rare path only: a user-scoped resync is one recompute; a
 * server-wide or channel-scoped one reads the space's member ids (one query on
 * the `server_id` index), recomputes them USER_BATCH at a time, and publishes
 * one leave per channel per batch naming only the users that channel hides.
 */
async function revokeHiddenRoomsClusterWide(scope: ResyncScope): Promise<void> {
  const { serverId } = scope;
  try {
    const io = getIO();
    const channels = await prisma.channel.findMany({
      where: { serverId, ...(scope.channelId ? { id: scope.channelId } : {}) },
      // `secure` is load-bearing here too: a secure channel is decided by its
      // membership alone, before the owner/ADMINISTRATOR fast paths
      select: { id: true, secure: true },
    });
    if (channels.length === 0) return;

    const userIds = scope.userId
      ? [scope.userId]
      : (await prisma.serverMember.findMany({ where: { serverId }, select: { userId: true } })).map((m) => m.userId);

    let removals = 0;
    for (let i = 0; i < userIds.length; i += USER_BATCH) {
      const batch = userIds.slice(i, i + USER_BATCH);
      const visibleByUser = await filterVisibleChannelsForUsers(batch, serverId, channels);
      for (const ch of channels) {
        const hidden = batch.filter((uid) => visibleByUser.get(uid)?.has(ch.id) !== true);
        if (hidden.length === 0) continue;
        io.in(hidden.map((uid) => `user:${uid}`)).except(`voice:${ch.id}`).socketsLeave(`channel:${ch.id}`);
        removals += hidden.length;
      }
    }
    console.warn(`[Visibility] Fail-closed fallback for server ${serverId}: ${removals} user/channel room removal(s) published; grants wait for each member's next connect`);
  } catch (err) {
    console.error(`[Visibility] Fail-closed fallback for server ${serverId} failed; revoked members on unconfirmed nodes keep their rooms until they reconnect:`, err);
  }
}
