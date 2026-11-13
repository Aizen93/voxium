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
/** How long a local pass waits for the one queued before it for the same
 *  server (see resyncLocalSockets). */
export const LOCAL_PASS_MAX_WAIT_MS = 30_000;
/** How long one count of the live nodes is reused (see expectedReceivers). */
export const LIVE_NODES_MEMO_MS = 5000;
/** Waits before a failed local pass is queued again: a pool timeout clears in
 *  seconds, a database restart in minutes. A failure after the last of them is
 *  the pass's last (see afterFailedPass). */
export const LOCAL_PASS_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 30_000, 120_000];
/** How long a node's heartbeat lives: NODE_HEARTBEAT_TTL_S (redis.ts) in ms.
 *  A copy, held equal to it by a test: an import, read at module load, would
 *  have to be provided by every test suite that mocks redis.ts. */
export const NODE_HEARTBEAT_TTL_MS = 30_000;
/** What a follow-up waits past the heartbeat TTL (the margin the deferred boot
 *  sweep in index.ts takes for the same wait). */
export const RESYNC_FOLLOW_UP_MARGIN_MS = 5000;
/** How long after a publish failed closed its scope is published again, once
 *  (see scheduleFollowUp): past the TTL of every heartbeat that was live when
 *  it failed. */
export const RESYNC_FOLLOW_UP_DELAY_MS = NODE_HEARTBEAT_TTL_MS + RESYNC_FOLLOW_UP_MARGIN_MS;
/** Scopes one space's pending follow-up holds before it widens to the space. */
export const RESYNC_FOLLOW_UP_SCOPES_MAX = 8;

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
 * so any other number of receivers than live nodes means a node may have
 * missed it (its subscriber was reconnecting, or it runs a build without the
 * subscription; fanOutResync says what the count cannot tell). Pub/sub is
 * at most once, so an unconfirmed publish is retried (RESYNC_PUBLISH_ATTEMPTS,
 * RESYNC_RETRY_DELAYS_MS, each attempt logged), and when it is still
 * unconfirmed the resync FAILS CLOSED: `revokeHiddenRoomsClusterWide` derives
 * from the database which users of the scope may not view which channel and
 * makes their sockets leave those rooms on every node through the adapter
 * (no reply awaited), sparing the sockets in that channel's `voice:{id}` room.
 * Grants are not part of the fallback. Every node that received a copy ran the
 * whole pass, grants included; a grant on a node that missed every copy, or
 * one the fallback's own leaves took back, comes with the follow-up: the scope
 * is published once more RESYNC_FOLLOW_UP_DELAY_MS later, when a heartbeat a
 * node killed hard left behind has expired (scheduleFollowUp). A follow-up
 * that fails closed too is not repeated; such a grant then reaches the member
 * at their next connect, which is a delay, never a leak.
 *
 * What the fallback cannot cover: it is published on the same Redis client as
 * the resync, so when THIS node cannot reach Redis at all both wait in that
 * client's offline queue and go out, in order, when it reconnects (until then
 * nothing this node emits reaches a peer either). A node that misses both
 * messages — its config and adapter subscribers both down for the whole
 * window — keeps its stale rooms until the follow-up reaches it, or, when it
 * misses that too, until its sockets reconnect. Three windows
 * read as unconfirmed although no node with sockets missed anything: a node
 * killed hard keeps its heartbeat for up to its 30 s TTL; a booting node holds
 * its heartbeat a few seconds before it subscribes (index.ts starts the
 * heartbeat first, and no socket can connect to it before it listens); and a
 * node shutting down has deleted its heartbeat while its subscriber still
 * receives (one receiver too many, usually gone before the retries end). A
 * resync in any of them retries, then takes the fallback and its follow-up
 * (logged): correct, only slower.
 *
 * Errors are logged, never thrown: a failed resync must not fail the
 * originating mutation, which fires and forgets it.
 */
export async function syncChannelVisibilityRooms(
  serverId: string,
  opts?: { channelId?: string; userId?: string },
): Promise<void> {
  noteResyncRequest(serverId);
  await resyncEveryNode({ serverId, channelId: opts?.channelId, userId: opts?.userId }, false);
}

/**
 * The cluster-wide resync an ADAPTER-WIDE join site runs when a request raced
 * its read (see resyncRequestedSince): the same passes as
 * syncChannelVisibilityRooms, but it is not a visibility MUTATION, so it does
 * not count as a request here or on the peers (its message says `recheck`).
 * Counted, the re-checks of overlapping joins in one busy space set each other
 * off: each was a request since the others' marks.
 */
export async function recheckVisibilityAfterJoin(
  serverId: string,
  opts: { channelId?: string; userId?: string },
): Promise<void> {
  await resyncEveryNode({ serverId, channelId: opts.channelId, userId: opts.userId }, true);
}

/** `followUp`: this run is a failed publish's follow-up (see
 *  scheduleFollowUp), which schedules none of its own. Never rejects. */
async function resyncEveryNode(scope: ResyncScope, recheck: boolean, followUp = false): Promise<void> {
  // Independent halves, each catching its own errors: a database failure in
  // the local pass must not keep the peers from resyncing, nor the reverse
  await Promise.all([
    resyncLocalSockets(passScope(scope)),
    fanOutResync(scope, recheck).then((confirmed) => afterFanOut(scope, confirmed, followUp)),
  ]);
}

// ─── The follow-up of a publish that failed closed ──────────────────────────

/** The follow-ups waiting on this node, per space: the scopes to publish
 *  again, the one timer that fires them, and when. */
const pendingFollowUps = new Map<string, { scopes: ResyncScope[]; timer: ReturnType<typeof setTimeout>; dueAt: number }>();
/** Set by stopChannelVisibilitySync: a fan-out still retrying at the stop
 *  schedules nothing. */
let followUpsStopped = false;

/** A scope as the log lines name it: ids only, as the other lines do. */
function scopeLabel({ serverId, channelId, userId }: ResyncScope): string {
  return `server ${serverId}${channelId ? `, channel ${channelId}` : ''}${userId ? `, member ${userId}` : ''}`;
}

/** What follows a fan-out: a follow-up's outcome logged, or a follow-up
 *  scheduled for a publish that failed closed. Never throws. */
function afterFanOut(scope: ResyncScope, confirmed: boolean, followUp: boolean): void {
  if (followUp) {
    if (confirmed) {
      console.log(`[Visibility] Follow-up resync of ${scopeLabel(scope)} confirmed by every node`);
    } else {
      console.error(`[Visibility] Follow-up resync of ${scopeLabel(scope)} failed closed too; no further follow-up: a grant on a node that missed it reaches the member at their next connect`);
    }
    return;
  }
  if (!confirmed) scheduleFollowUp(scope);
}

/**
 * After a publish of `scope` failed closed: publish it once more,
 * RESYNC_FOLLOW_UP_DELAY_MS later, through resyncEveryNode (this node's pass
 * in the space's queue, and a new message every other node applies in its own).
 *
 * What it is for. Every node that received a copy of the request ran the whole
 * pass, grants included, and the fallback only takes rooms away. Two kinds of
 * grant are left to a later pass: one on a node that missed every copy (its
 * subscriber
 * was down through the retries, which the receiver count cannot tell from a
 * heartbeat a node killed hard leaves behind), and one the fallback's own
 * leaves took back (the race it accepts, see revokeHiddenRoomsClusterWide).
 * The delay outlasts the TTL of every heartbeat that was live when the publish
 * failed, so the follow-up is judged against the live nodes only.
 *
 * It is a pass like any other: each node reads the database when its pass
 * starts, behind the passes already queued for the space, and applies what is
 * true then. It goes out as a re-check (`recheck: true`): it is no mutation,
 * so it moves no join site's mark, here or on the peers. Counted, it would set
 * the join sites racing it re-checking; a re-check that fails closed is
 * followed up like any resync, and that follow-up would set them off again,
 * with no end.
 *
 * Bounds. One follow-up per failure: a follow-up that fails closed too runs
 * the fallback again and schedules nothing, since past the TTL a mismatch is a
 * node that is up and does not receive, which another publish would not reach
 * either. One timer per space, set by the first failure and never moved, so a
 * stream of failures cannot postpone it; a later failure adds its scope to it:
 * a scope one already held covers is absorbed, one that covers held scopes
 * replaces them, and past RESYNC_FOLLOW_UP_SCOPES_MAX scopes the follow-up
 * widens to the whole space. It is scheduled on the node that published, the
 * only one that knows the publish failed; the timer never keeps the process
 * alive, and a stop drops what is pending (stopChannelVisibilitySync).
 */
function scheduleFollowUp(scope: ResyncScope): void {
  if (followUpsStopped) return;
  const { serverId } = scope;
  const held = { serverId, ...(scope.channelId ? { channelId: scope.channelId } : {}), ...(scope.userId ? { userId: scope.userId } : {}) };
  let pending = pendingFollowUps.get(serverId);
  if (!pending) {
    const timer = setTimeout(() => runFollowUps(serverId), RESYNC_FOLLOW_UP_DELAY_MS);
    timer.unref?.();
    pending = { scopes: [held], timer, dueAt: Date.now() + RESYNC_FOLLOW_UP_DELAY_MS };
    pendingFollowUps.set(serverId, pending);
  } else if (!pending.scopes.some((s) => covers(passScope(s), passScope(held)))) {
    const kept = pending.scopes.filter((s) => !covers(passScope(held), passScope(s)));
    pending.scopes = kept.length + 1 > RESYNC_FOLLOW_UP_SCOPES_MAX ? [{ serverId }] : [...kept, held];
  }
  const dueIn = Math.max(0, pending.dueAt - Date.now());
  console.warn(`[Visibility] Resync of ${scopeLabel(held)} failed closed; its scope is published again in ${dueIn} ms, past the heartbeat TTL, so a grant reaches the members of a node that missed it (${pending.scopes.length} scope(s) pending for the space)`);
}

/** Fire a space's follow-ups: the entry goes first, so a failure from now on
 *  schedules a follow-up of its own. */
function runFollowUps(serverId: string): void {
  const pending = pendingFollowUps.get(serverId);
  if (!pending) return;
  pendingFollowUps.delete(serverId);
  // resyncEveryNode never rejects
  for (const scope of pending.scopes) void resyncEveryNode(scope, true, true);
}

/** Drop every pending follow-up and schedule no more (a stop). */
function dropFollowUps(): void {
  followUpsStopped = true;
  if (pendingFollowUps.size === 0) return;
  for (const { timer } of pendingFollowUps.values()) clearTimeout(timer);
  console.warn(`[Visibility] ${pendingFollowUps.size} space(s) with a follow-up resync pending at shutdown; dropped`);
  pendingFollowUps.clear();
}

// ─── Joins that raced a resync ──────────────────────────────────────────────

/** Resync requests this node has seen, in order, and the last one per space. */
let requestSeq = 0;
const lastRequestBySpace = new Map<string, number>();
/** Spaces remembered; past it the oldest are forgotten (see noteResyncRequest). */
export const REQUEST_SPACES_MAX = 10_000;
/** The newest position forgotten that way. */
let forgottenUpTo = 0;

/** Called for every resync request this node sees: its own, and a peer's
 *  first copy. */
function noteResyncRequest(serverId: string): void {
  requestSeq++;
  // delete-then-set keeps the Map in order of last request
  lastRequestBySpace.delete(serverId);
  lastRequestBySpace.set(serverId, requestSeq);
  if (lastRequestBySpace.size > REQUEST_SPACES_MAX) {
    const [oldest, seq] = lastRequestBySpace.entries().next().value as [string, number];
    lastRequestBySpace.delete(oldest);
    // A space no longer listed reads as requested at this position: at worst
    // a re-check for a join that started before it, never a missed one
    forgottenUpTo = seq;
  }
}

/**
 * Code that reads visibility and then joins `channel:` rooms OUTSIDE the
 * per-space queue — the connection handler and `channel:join` — races the
 * resync: a pass that runs between that read and the join finds nothing to
 * remove, and the join then applies the read the revocation had made stale,
 * leaving the member in the room until the next resync. Such code takes a
 * mark before its read and, after its joins, calls resyncAfterJoins.
 */
export function visibilityRequestMark(): number {
  return requestSeq;
}

/**
 * Queue a pass over `userId`'s sockets on this node for every space of
 * `serverIds` whose resync request this node saw since `mark` (one channel
 * only when `channelId` is given). The pass runs in the space's queue, behind
 * the pass of that request, and reads the database afresh, so it corrects
 * whatever the stale join put in. In the normal case nothing was seen since
 * the mark and this is one comparison: no query, no per-space loop.
 */
export function resyncAfterJoins(mark: number, userId: string, serverIds: Iterable<string>, channelId?: string): void {
  if (requestSeq === mark) return;
  for (const serverId of serverIds) {
    if (resyncRequestedSince(mark, serverId)) void resyncLocalSockets(passScope({ serverId, userId, channelId }));
  }
}

/**
 * Did this node see a resync request for `serverId` since `mark`? For code
 * whose join is ADAPTER-WIDE (a new member's rooms, a new channel's audience):
 * a local re-check would repair only this node, so such code answers a true
 * with recheckVisibilityAfterJoin, which resyncs every node (and, not being a
 * mutation, moves no mark).
 *
 * The gap that remains: a request only a PEER had seen at that moment (its
 * publish not yet here) re-checks nothing, and the join may then land on that
 * peer after its pass. It bites both ways — a revoked member put back in a
 * room, a granted one left out of it — until the next resync of the space or
 * the member's reconnect. The full remedy is to stop joining channel rooms
 * across nodes and publish a member resync instead, which every node applies
 * to its own sockets in its queue.
 */
export function resyncRequestedSince(mark: number, serverId: string): boolean {
  if (requestSeq === mark) return false;
  return (lastRequestBySpace.get(serverId) ?? forgottenUpTo) > mark;
}

/**
 * Subscribe this node to the resync requests of its peers. Call once at
 * startup, after Socket.IO is initialised and before the server listens.
 */
export async function initChannelVisibilitySync(): Promise<void> {
  followUpsStopped = false;
  await getRedisConfigSub().subscribe(VISIBILITY_RESYNC_CHANNEL, (raw) => {
    handleResyncMessage(raw);
  });
}

/**
 * Leave the resync channel. Call on a graceful stop right after the heartbeat
 * is deleted: until the process exits its subscriber would still receive,
 * one receiver more than the live heartbeats, and every peer's resync in that
 * window would mismatch, retry and take the fallback (about 7.5 s). Its
 * sockets are disconnected next, so it has nothing left to resync. Bounded
 * by STOP_UNSUBSCRIBE_TIMEOUT_MS: an unsubscribe issued while the subscriber
 * reconnects waits in the client's offline queue, and a stop must never hang
 * on it. The pending follow-ups are dropped first, before anything is awaited,
 * and a fan-out still retrying schedules none. Never rejects.
 */
export async function stopChannelVisibilitySync(): Promise<void> {
  dropFollowUps();
  try {
    await withTimeout(getRedisConfigSub().unsubscribe(VISIBILITY_RESYNC_CHANNEL), STOP_UNSUBSCRIBE_TIMEOUT_MS);
  } catch (err) {
    console.warn('[Visibility] Could not leave the resync channel at shutdown (peers may retry their resyncs until this process exits):', err instanceof Error ? err.message : err);
  }
}

// ─── Scope and wire format ──────────────────────────────────────────────────

interface ResyncScope {
  serverId: string;
  channelId?: string;
  userId?: string;
}

/** The scope of a local pass: `channelIds` names the channels it covers
 *  (absent: every channel of the space). A request names one channel at
 *  most; a member pass absorbing re-checks of several channels names them
 *  all, up to MEMBER_PASS_CHANNELS_MAX (see resyncLocalSockets). */
interface PassScope {
  serverId: string;
  userId?: string;
  channelIds?: string[];
}

/** The local pass of a request's scope. */
function passScope({ serverId, userId, channelId }: ResyncScope): PassScope {
  return { serverId, ...(userId ? { userId } : {}), ...(channelId ? { channelIds: [channelId] } : {}) };
}

/** How long a stopping node waits to leave the resync channel. */
export const STOP_UNSUBSCRIBE_TIMEOUT_MS = 1000;

/** Channels a waiting member pass remembers before it widens to the space. */
export const MEMBER_PASS_CHANNELS_MAX = 8;

interface ResyncMessage extends ResyncScope {
  /** One id per resync request; its retries reuse it. */
  id: string;
  fromNode: string;
  /** Not a mutation, so it moves no mark: a join site's re-check (see
   *  recheckVisibilityAfterJoin) or a follow-up (see scheduleFollowUp). */
  recheck?: true;
}

const isOptionalId = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && OPAQUE_ID_RE.test(value));

/** The message, or null when any field is not what a node publishes. */
function parseResyncMessage(value: unknown): ResyncMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, fromNode, serverId, channelId, userId, recheck } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !OPAQUE_ID_RE.test(id)) return null;
  if (typeof fromNode !== 'string' || fromNode.length === 0 || fromNode.length > 128) return null;
  if (typeof serverId !== 'string' || !OPAQUE_ID_RE.test(serverId)) return null;
  if (!isOptionalId(channelId) || !isOptionalId(userId)) return null;
  if (recheck !== undefined && recheck !== true) return null;
  return { id, fromNode, serverId, channelId, userId, ...(recheck ? { recheck } : {}) };
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
  // Only a mutation's request moves the mark the join sites compare against
  if (!message.recheck) noteResyncRequest(message.serverId);
  void resyncLocalSockets(passScope({ serverId: message.serverId, channelId: message.channelId, userId: message.userId }));
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

/** One queued local pass. `started` resolves when it begins to run (its own
 *  wait is over); `overtaken` is set when the pass queued after it stopped
 *  waiting for it (see waitAtMost); `applying` once it has read the database
 *  and begins to change rooms. */
interface LocalPass {
  run: Promise<void>;
  started: Promise<void>;
  overtaken: boolean;
  applying: boolean;
  job: PassJob;
}

/** The tail of the local passes queued for each server on this node. */
const localPassTail = new Map<string, LocalPass>();
/** Every pass queued and not finished, per server, in queue order. */
const livePasses = new Map<string, LocalPass[]>();

/** Does a pass of scope `outer` recompute everything a pass of `inner` does? */
function covers(outer: PassScope, inner: PassScope): boolean {
  return (outer.userId === undefined || outer.userId === inner.userId)
    && (outer.channelIds === undefined
      || (inner.channelIds !== undefined && inner.channelIds.every((id) => outer.channelIds!.includes(id))));
}

/**
 * Will a pass queued after `pass` give back whatever `pass`'s late leaves
 * take? Yes when one of a covering scope has not begun to change rooms yet:
 * it read (or will read) the database after `pass` did and applies after it.
 * A later pass that is already applying, or done, may have granted rooms
 * `pass` just took away.
 */
function laterPassWillApply(pass: LocalPass): boolean {
  const list = livePasses.get(pass.job.scope.serverId) ?? [];
  return list.slice(list.indexOf(pass) + 1).some((later) => !later.applying && covers(later.job.scope, pass.job.scope));
}

/**
 * Resync THIS node's sockets for `scope`, after the passes already queued on
 * this node for the same server. Two passes that overlap otherwise finish in
 * any order, each applying what it read from the database when it started: a
 * slow space-wide pass that read a member's roles before they were taken away
 * re-joined the member after the later member-scoped pass had removed them,
 * and the revocation was lost until the member reconnected. A pass that has
 * not finished after LOCAL_PASS_MAX_WAIT_MS (one stuck on a connection that
 * never answers) no longer holds the next one back, and from then on it
 * applies its LEAVES ONLY: it read the database before the passes that ran
 * past it, so a join of its own could undo a later revocation, while a leave
 * at worst removes a room the passes past it had granted. When it finishes,
 * one fresh pass of its scope is queued to give such rooms back.
 *
 * A pass that fails (the database refused one of its reads) is queued again,
 * through this same queue, after each of LOCAL_PASS_RETRY_DELAYS_MS: the
 * publish only proves the request was DELIVERED, so without this a node whose
 * pool timed out once kept a revoked member in the room although every node
 * had confirmed. A repeat is safe: every pass reads the database afresh, and
 * the queue keeps it behind the passes already waiting. The promise resolves
 * when the first run ends (a repeat is not awaited) and never rejects.
 *
 * A pass over ONE MEMBER that has not started yet absorbs the next one for
 * the same member and space (it will read the database after that request
 * too): a reconnect storm, every socket re-checking after its joins, queues
 * one pass per member per space, not one per socket. Re-checks of different
 * channels add up (the pass covers them all, and its fail-closed end stays
 * those channels' leaves, see afterFailedPass); past MEMBER_PASS_CHANNELS_MAX
 * channels, or with a pass over the member's whole space, it widens to the
 * whole space.
 */
function resyncLocalSockets(scope: PassScope, attempt = 1): Promise<void> {
  if (!scope.userId) return enqueuePass({ scope: copyScope(scope), attempt });
  const key = `${scope.serverId}|${scope.userId}`;
  const pending = pendingMemberPasses.get(key);
  if (pending) {
    const held = pending.job.scope;
    if (held.channelIds !== undefined) {
      const union = scope.channelIds === undefined ? null : [...new Set([...held.channelIds, ...scope.channelIds])];
      if (union === null || union.length > MEMBER_PASS_CHANNELS_MAX) delete held.channelIds;
      else held.channelIds = union;
    }
    pending.job.attempt = Math.max(pending.job.attempt, attempt);
    return pending.run;
  }
  const entry = { job: { scope: copyScope(scope), attempt }, run: Promise.resolve() };
  pendingMemberPasses.set(key, entry);
  entry.run = enqueuePass(entry.job, () => {
    if (pendingMemberPasses.get(key) === entry) pendingMemberPasses.delete(key);
  });
  return entry.run;
}

/** A local pass to run. Its scope and attempt are read when it starts, so a
 *  member pass still waiting can absorb another (see resyncLocalSockets). */
interface PassJob {
  scope: PassScope;
  attempt: number;
}

/** A scope a queued job can change without touching the caller's. */
function copyScope(scope: PassScope): PassScope {
  return { ...scope, ...(scope.channelIds ? { channelIds: [...scope.channelIds] } : {}) };
}

/** Member passes queued and not started yet, by `${serverId}|${userId}`. */
const pendingMemberPasses = new Map<string, { job: PassJob; run: Promise<void> }>();

function enqueuePass(job: PassJob, onStart?: () => void): Promise<void> {
  const { serverId } = job.scope;
  const previous = localPassTail.get(serverId);
  let markStarted!: () => void;
  const pass: LocalPass = {
    run: Promise.resolve(),
    started: new Promise<void>((resolve) => { markStarted = resolve; }),
    overtaken: false,
    applying: false,
    job,
  };
  pass.run = (previous ? waitAtMost(previous, serverId) : Promise.resolve())
    .then(() => {
      markStarted();
      onStart?.();
      return runLocalPass(job.scope, pass);
    })
    .then((applied) => {
      if (!applied) {
        afterFailedPass(job.scope, job.attempt);
      } else if (pass.overtaken && !laterPassWillApply(pass)) {
        // It skipped its joins, and its late leaves may have undone what the
        // passes that ran past it granted: one fresh pass of the same scope,
        // reading the database now, puts the rooms right. Not when a later
        // pass of a covering scope has yet to apply: it has the last word
        // anyway, and requeueing then made a space whose passes all outlast
        // the 30 s bound requeue itself forever (each overtaken by the next).
        console.warn(`[Visibility] An overtaken resync of server ${serverId} on this node finished late; a fresh pass of its scope is queued`);
        void resyncLocalSockets(copyScope(job.scope));
      }
    });
  localPassTail.set(serverId, pass);
  const live = livePasses.get(serverId) ?? [];
  live.push(pass);
  livePasses.set(serverId, live);
  // runLocalPass never rejects and afterFailedPass never throws, so neither does `run`
  void pass.run.then(() => {
    if (localPassTail.get(serverId) === pass) localPassTail.delete(serverId);
    const remaining = (livePasses.get(serverId) ?? []).filter((p) => p !== pass);
    if (remaining.length > 0) livePasses.set(serverId, remaining);
    else livePasses.delete(serverId);
  });
  return pass.run;
}

/**
 * What follows a failed local pass: queued again after each delay of
 * LOCAL_PASS_RETRY_DELAYS_MS, and after the last, by scope (the database has
 * refused this node for about 2.6 minutes, so nothing below reads it):
 *
 *  - ONE CHANNEL OF ONE MEMBER (a re-check after a channel:join), or the few
 *    channels such re-checks added up to: that member's sockets on this node
 *    leave each channel's room, a socket in its voice room kept. Exact, and
 *    nothing else of the member changes.
 *  - ONE CHANNEL (an override change): every socket of the space on this node
 *    leaves the channel's room, the channel's voice participants kept. Its
 *    legitimate viewers get a TEXT channel's room back by opening it
 *    (channel:join re-checks VIEW), a VOICE channel's by joining its call;
 *    either by reconnecting or by a later pass that succeeds.
 *  - ONE MEMBER (a role taken away, a re-check after a connect): that
 *    member's sockets on this node are disconnected, except a socket in a
 *    call, a space voice channel's or a DM's (cutting a call is worse than a
 *    late revocation), which keeps only its call's channel room (see
 *    disconnectOutsideVoice). The client reopens a socket the server closed,
 *    and the connect path computes every room afresh — when the database
 *    answers again, since the handshake reads it too.
 *  - THE WHOLE SPACE (a role permission edit or delete): an error log, nothing
 *    else. Disconnecting every member of the space on this node would send
 *    them all to reconnect against the failing database and end the sessions
 *    of members whose access did not change; their rooms stay as they were
 *    until the next resync of the space reaches this node or they reconnect.
 */
function afterFailedPass(scope: PassScope, attempt: number): void {
  const total = LOCAL_PASS_RETRY_DELAYS_MS.length + 1;
  const delay = LOCAL_PASS_RETRY_DELAYS_MS[attempt - 1];
  if (delay !== undefined) {
    console.warn(`[Visibility] Resync of server ${scope.serverId} on this node failed (attempt ${attempt}/${total}); queued again in ${delay} ms`);
    const timer = setTimeout(() => {
      void resyncLocalSockets(scope, attempt + 1);
    }, delay);
    timer.unref?.();
    return;
  }
  const { serverId, channelIds, userId } = scope;
  if (channelIds) {
    // Every channel the pass covered: one, or a member's re-checks that
    // added up (never their whole space, which would be the disconnect)
    for (const channelId of channelIds) leaveChannelLocally(serverId, channelId, userId, total);
    return;
  }
  if (userId) {
    void disconnectOutsideVoice(serverId, userId, total);
    return;
  }
  console.error(`[Visibility] Resync of server ${serverId} on this node failed ${total} times; giving up: this node's sockets of the space keep their channel rooms until the next resync of the space or their reconnect`);
}

/** The fail-closed end of a channel's pass (see afterFailedPass): one member's
 *  sockets, or the whole space's, leave the channel's room on this node, its
 *  voice participants kept. Never throws. */
function leaveChannelLocally(serverId: string, channelId: string, userId: string | undefined, failures: number): void {
  const from = userId ? `user:${userId}` : `server:${serverId}`;
  try {
    getIO().local.in(from).except(`voice:${channelId}`).socketsLeave(`channel:${channelId}`);
    console.error(`[Visibility] Resync of channel ${channelId} in server ${serverId} on this node failed ${failures} times: ${userId ? `member ${userId}'s sockets` : 'every socket of the space'} on this node left its room (fail closed), its voice participants kept`);
  } catch (err) {
    console.error(`[Visibility] Could not take channel ${channelId} of server ${serverId} away after ${failures} failed resyncs; this node's sockets keep its room until they reconnect:`, err);
  }
}

/**
 * The fail-closed end of a member's pass (see afterFailedPass). A socket in a
 * call is kept connected, but it is not kept as it was: without the database
 * the pass cannot tell which rooms the member lost, so the socket leaves every
 * `channel:` room except the one of each voice channel it is in (the call's
 * presence events). It gets a text channel's room back when the member opens
 * it (channel:join re-checks VIEW), a voice channel's when they join its call,
 * and any by reconnecting or by a later pass that succeeds. Never rejects.
 */
async function disconnectOutsideVoice(serverId: string, userId: string, failures: number): Promise<void> {
  try {
    const sockets = await getIO().local.in(`user:${userId}`).fetchSockets();
    let closed = 0;
    let trimmed = 0;
    for (const s of sockets) {
      const rooms = [...(s.rooms ?? [])];
      const callRooms = new Set(rooms.filter((room) => room.startsWith('voice:')).map((room) => `channel:${room.slice('voice:'.length)}`));
      // A DM call (`dm:voice:{conversationId}`) is a call too: a disconnect
      // ends it (dmVoiceHandler's `disconnecting`). It holds no channel room
      // of its own, so the socket keeps none.
      const inDmCall = rooms.some((room) => room.startsWith('dm:voice:'));
      if (callRooms.size === 0 && !inDmCall) {
        s.disconnect(true);
        closed++;
        continue;
      }
      for (const room of rooms) {
        if (room.startsWith('channel:') && !callRooms.has(room)) s.leave(room);
      }
      trimmed++;
    }
    console.error(`[Visibility] Resync of member ${userId} in server ${serverId} on this node failed ${failures} times: disconnected ${closed} of their socket(s) so the reconnect recomputes their rooms (fail closed); ${trimmed} in a call kept, with only their call's channel room`);
  } catch (err) {
    console.error(`[Visibility] Could not disconnect member ${userId} after ${failures} failed resyncs of server ${serverId}; their sockets on this node keep their rooms until they reconnect:`, err);
  }
}

/**
 * Resolves when `previous` does, or LOCAL_PASS_MAX_WAIT_MS after `previous`
 * STARTED (logged), marking it overtaken. The clock starts with the pass, not
 * with the wait: counted from the moment this one was queued, a backlog of
 * healthy passes made a later one give up on a predecessor that had only just
 * begun, and dropped that predecessor's joins. Each link of the queue is
 * bounded in turn, so a stuck pass delays the next by the bound and no more.
 */
async function waitAtMost(previous: LocalPass, serverId: string): Promise<void> {
  await previous.started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), LOCAL_PASS_MAX_WAIT_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([previous.run.then(() => 'done' as const), late]);
  clearTimeout(timer);
  if (outcome === 'late') {
    previous.overtaken = true;
    console.warn(`[Visibility] The previous resync of server ${serverId} on this node is still running after ${LOCAL_PASS_MAX_WAIT_MS} ms; the next one runs without waiting for it, and the late one will apply its leaves only`);
  }
}

/** One pass over this node's sockets for `scope`. Resolves false when it
 *  failed (logged), true otherwise; never rejects. */
async function runLocalPass(scope: PassScope, pass: Pick<LocalPass, 'overtaken' | 'applying'>): Promise<boolean> {
  const { serverId } = scope;
  try {
    const io = getIO();
    const room = scope.userId ? `user:${scope.userId}` : `server:${serverId}`;
    // THIS node's sockets only: answered by the node's own adapter, it never
    // asks a peer and cannot time out (the peers run their own pass). They are
    // the real sockets, so `rooms` is this node's live view of each one.
    const sockets = await io.local.in(room).fetchSockets();
    if (sockets.length === 0) return true;

    const ids = scope.channelIds;
    const channels = await prisma.channel.findMany({
      where: { serverId, ...(ids ? { id: ids.length === 1 ? ids[0] : { in: ids } } : {}) },
      // `secure` is load-bearing: filterVisibleChannels can only apply the
      // membership-only rule to channels it can recognize as secure
      select: { id: true, secure: true },
    });
    if (channels.length === 0) return true;

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
    let joinsSkipped = 0;
    for (let i = 0; i < uids.length; i += USER_BATCH) {
      const batch = uids.slice(i, i + USER_BATCH);
      const visibleByUser = await filterVisibleChannelsForUsers(batch, serverId, channels);
      pass.applying = true;
      for (const uid of batch) {
        const visibleIds = visibleByUser.get(uid) ?? new Set<string>();
        const userSockets = socketsByUser.get(uid)!;
        const gained = new Set<string>();
        for (const ch of channels) {
          for (const s of userSockets) {
            if (visibleIds.has(ch.id)) {
              // Read at every join: the flag is set by the next pass's timer,
              // which can only run while this one awaits
              if (pass.overtaken) {
                joinsSkipped++;
                continue;
              }
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
    if (joinsSkipped > 0) {
      console.warn(`[Visibility] A resync of server ${serverId} overtaken on this node applied its leaves only (${joinsSkipped} join(s) skipped)`);
    }
    return true;
  } catch (err) {
    console.error(`[Visibility] Failed to resync this node's channel rooms for server ${serverId}:`, err);
    return false;
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

let liveNodesMemo: { expected: number; at: number } | null = null;
let liveNodesInFlight: Promise<number> | null = null;

/**
 * How many subscribers a publish should reach: every node with a live
 * heartbeat, this one included. `liveNodeCounts()` SCANs the whole keyspace
 * for the heartbeats, one round trip per 100 keys, so on a large Redis reading
 * it on every attempt could alone outlast RESYNC_PUBLISH_TIMEOUT_MS and send a
 * healthy resync to the fallback. One count is shared by the resyncs in flight
 * (a slow scan an attempt gave up on is still the one the next attempt
 * awaits) and reused for LIVE_NODES_MEMO_MS, shorter than the retry window, so
 * the last attempts of a resync read a fresh count. `fresh` skips the reuse
 * (a scan already in flight is still shared: it is newer than the cache).
 */
function expectedReceivers({ fresh = false }: { fresh?: boolean } = {}): Promise<number> {
  if (!fresh && liveNodesMemo && Date.now() - liveNodesMemo.at < LIVE_NODES_MEMO_MS) {
    return Promise.resolve(liveNodesMemo.expected);
  }
  if (!liveNodesInFlight) {
    liveNodesInFlight = liveNodeCounts()
      .then(({ peers }) => {
        liveNodesMemo = { expected: peers + 1, at: Date.now() };
        return peers + 1;
      })
      .finally(() => {
        liveNodesInFlight = null;
      });
  }
  return liveNodesInFlight;
}

/** Forget the live-node count, the requests seen, the queued passes and the
 *  follow-ups pending; the unit tests change them between cases (a pass a
 *  failed case left holding the queue must not hold the next case's). */
export function _resetChannelVisibilityForTests(): void {
  liveNodesMemo = null;
  liveNodesInFlight = null;
  requestSeq = 0;
  lastRequestBySpace.clear();
  forgottenUpTo = 0;
  pendingMemberPasses.clear();
  localPassTail.clear();
  livePasses.clear();
  for (const { timer } of pendingFollowUps.values()) clearTimeout(timer);
  pendingFollowUps.clear();
  followUpsStopped = false;
}

/** One publish; resolves with how many subscribers received it and how many
 *  should have. */
async function publishOnce(payload: string): Promise<{ received: number; expected: number }> {
  const { pub } = getRedisPubSub();
  const [received, expected] = await Promise.all([
    pub.publish(VISIBILITY_RESYNC_CHANNEL, payload),
    expectedReceivers(),
  ]);
  return { received: Number(received), expected };
}

/**
 * Tell every other node to resync its sockets for `scope`; retried while
 * unconfirmed, then the fail-closed fallback (see the header). Resolves true
 * when a publish was confirmed, false once the fallback has run; never
 * rejects.
 *
 * Confirmed only when the receivers EQUAL the live nodes. More receivers than
 * heartbeats is not "everyone and then some": a node that is shutting down
 * deletes its heartbeat before its subscriber leaves, and a node that booted
 * within the cached count is not in it yet, so a surplus can hide a node that
 * missed the message. Any mismatch is judged again against a count read
 * afresh, which also spares the fallback to a resync published right after a
 * node stopped cleanly (heartbeat gone, one receiver fewer).
 *
 * What the totals still cannot tell: a missing node offset by an extra
 * subscriber the heartbeats do not count (a node between deleting its
 * heartbeat and exiting, or any other client subscribed to the channel). A
 * restart of one node while another's subscriber is reconnecting reads 2 of 2
 * and is confirmed although the reconnecting node missed it; it keeps its
 * stale rooms until the next resync of the space or its sockets reconnect.
 */
async function fanOutResync(scope: ResyncScope, recheck = false): Promise<boolean> {
  const message: ResyncMessage = { id: randomUUID(), fromNode: NODE_ID(), ...scope, ...(recheck ? { recheck: true as const } : {}) };
  const payload = JSON.stringify(message);
  let failure = 'not attempted';
  for (let attempt = 1; attempt <= RESYNC_PUBLISH_ATTEMPTS; attempt++) {
    try {
      const { received, expected } = await withTimeout(publishOnce(payload), RESYNC_PUBLISH_TIMEOUT_MS);
      if (received === expected) return true;
      const live = await withTimeout(expectedReceivers({ fresh: true }), RESYNC_PUBLISH_TIMEOUT_MS);
      if (received === live) return true;
      failure = `${received} subscriber(s) received it, ${live} node(s) are live`;
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
  return false;
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
 * the `server_id` index) and recomputes them USER_BATCH at a time (six
 * queries each). Each batch publishes one leave per distinct set of hidden
 * TEXT channels, plus one per VOICE channel hidden from someone, every leave
 * naming only its users. Every leave reaches every node, so the volume
 * matters: Redis drops a subscriber whose pub/sub output buffer passes 32 MB.
 * Measured on 10 000 members (25-character ids), 180 text and 20 voice
 * channels, 122 queries in every case, against the previous one leave per
 * channel per batch:
 *   - four role profiles (hiding 30, 15, 5 and 0 text channels, 5 and 2
 *     voice ones): 160 messages, 1.6 MB (was 700 messages, 8.9 MB);
 *   - the same plus 10 % of members who see nothing: 480, 2.2 MB (4000, 14.7 MB);
 *   - every member sees nothing: 420, 7.1 MB (4000, 66.5 MB), the voice
 *     leaves being 6.6 MB of it (they cannot be merged, see below).
 */
async function revokeHiddenRoomsClusterWide(scope: ResyncScope): Promise<void> {
  const { serverId } = scope;
  try {
    const io = getIO();
    const channels = await prisma.channel.findMany({
      where: { serverId, ...(scope.channelId ? { id: scope.channelId } : {}) },
      // `secure` is load-bearing here too: a secure channel is decided by its
      // membership alone, before the owner/ADMINISTRATOR fast paths. `type`
      // decides which leaves need the voice-room exception.
      select: { id: true, secure: true, type: true },
    });
    if (channels.length === 0) return;
    const textChannels = channels.filter((ch) => ch.type !== 'voice');
    const voiceChannels = channels.filter((ch) => ch.type === 'voice');

    const userIds = scope.userId
      ? [scope.userId]
      : (await prisma.serverMember.findMany({ where: { serverId }, select: { userId: true } })).map((m) => m.userId);

    let messages = 0;
    for (let i = 0; i < userIds.length; i += USER_BATCH) {
      const batch = userIds.slice(i, i + USER_BATCH);
      // ACCEPTED RACE: the leaves below apply what this read saw. A grant that
      // commits between the read and the leave (and whose own resync joined
      // the member first) is undone: the member loses that channel's live
      // events until they open it (a text channel: channel:join re-checks
      // VIEW), join its call (a voice channel), reconnect, or a later pass
      // succeeds: the follow-up of this resync, when it is not one itself,
      // reads the database after these leaves (scheduleFollowUp). It errs on
      // the closed side, on a path already degraded, and closing it here
      // would mean holding the space's permission writes for the whole
      // fallback.
      const visibleByUser = await filterVisibleChannelsForUsers(batch, serverId, channels);
      const hides = (uid: string, channelId: string) => visibleByUser.get(uid)?.has(channelId) !== true;

      // TEXT: one leave per set of hidden channels, naming the users who hide
      // exactly that set. A space has few visibility profiles (its roles), so
      // a batch takes a handful of messages whatever its channel count.
      const groups = new Map<string, { rooms: string[]; users: string[] }>();
      for (const uid of batch) {
        const hidden = textChannels.filter((ch) => hides(uid, ch.id));
        if (hidden.length === 0) continue;
        const key = hidden.map((ch) => ch.id).join(',');
        const group = groups.get(key) ?? { rooms: hidden.map((ch) => `channel:${ch.id}`), users: [] };
        group.users.push(`user:${uid}`);
        groups.set(key, group);
      }
      for (const { rooms, users } of groups.values()) {
        io.in(users).socketsLeave(rooms);
        messages++;
      }

      // VOICE: one leave per channel, each sparing its own `voice:{id}` room
      // (a single `except` over several voice rooms would also spare a
      // participant of one channel from leaving another it may not view)
      for (const ch of voiceChannels) {
        const hidden = batch.filter((uid) => hides(uid, ch.id));
        if (hidden.length === 0) continue;
        io.in(hidden.map((uid) => `user:${uid}`)).except(`voice:${ch.id}`).socketsLeave(`channel:${ch.id}`);
        messages++;
      }
    }
    console.warn(`[Visibility] Fail-closed fallback for server ${serverId}: ${messages} leave message(s) published for ${userIds.length} member(s)`);
  } catch (err) {
    console.error(`[Visibility] Fail-closed fallback for server ${serverId} failed; revoked members on unconfirmed nodes keep their rooms until they reconnect:`, err);
  }
}
