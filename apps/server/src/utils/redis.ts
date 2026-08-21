import { createClient, type RedisClientType, type RedisFunctions, type RedisModules, type RedisScripts } from 'redis';
import type { RedisClientOptions } from 'redis';
import crypto from 'crypto';

/** Unique identifier for this server node (for multi-node coordination). */
let _nodeId: string | null = null;
export function NODE_ID(): string {
  if (!_nodeId) {
    _nodeId = process.env.NODE_ID || crypto.randomUUID().slice(0, 8);
  }
  return _nodeId;
}

let redisClient: RedisClientType;
let redisPub: RedisClientType;
let redisSub: RedisClientType;
let redisConfigSub: RedisClientType;

/** Shared socket options for all Redis clients — exponential backoff, keepalive, timeout. */
const REDIS_SOCKET_OPTIONS: NonNullable<RedisClientOptions<RedisModules, RedisFunctions, RedisScripts>['socket']> = {
  reconnectStrategy: (retries: number) => Math.min(retries * 50, 2000),
  keepAlive: true,
  connectTimeout: 10000,
};

export async function initRedis(): Promise<RedisClientType> {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  redisClient = createClient({ url, socket: REDIS_SOCKET_OPTIONS });
  redisClient.on('error', (err) => console.error('[Redis] Error:', err));
  await redisClient.connect();

  // Dedicated pub/sub pair for Socket.IO Redis adapter
  redisPub = redisClient.duplicate();
  redisSub = redisClient.duplicate();
  // Separate subscriber for config propagation (feature flags, rate limits)
  redisConfigSub = redisClient.duplicate();
  redisPub.on('error', (err) => console.error('[Redis:pub] Error:', err));
  redisSub.on('error', (err) => console.error('[Redis:sub] Error:', err));
  redisConfigSub.on('error', (err) => console.error('[Redis:configSub] Error:', err));
  await Promise.all([redisPub.connect(), redisSub.connect(), redisConfigSub.connect()]);

  return redisClient;
}

export function getRedis(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return redisClient;
}

/** Returns the dedicated pub/sub client pair for Socket.IO Redis adapter. */
export function getRedisPubSub(): { pub: RedisClientType; sub: RedisClientType } {
  if (!redisPub || !redisSub) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return { pub: redisPub, sub: redisSub };
}

/** Returns the config subscriber for cross-node config propagation. */
export function getRedisConfigSub(): RedisClientType {
  if (!redisConfigSub) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return redisConfigSub;
}

// ─── Node liveness heartbeat (multi-node) ────────────────────────────────────
// Each node maintains `node:alive:{NODE_ID}` with a short TTL. Peers use it to
// decide whether another node's state (voice mirrors, etc.) is live or reapable.
// Production runs multiple horizontally-scaled instances — boot/periodic cleanup
// must NEVER assume it is the only node.

export const NODE_HEARTBEAT_TTL_S = 30;
const NODE_HEARTBEAT_INTERVAL_MS = 10_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function heartbeatKey(nodeId: string): string {
  return `node:alive:${nodeId}`;
}

/** Start refreshing this node's liveness key. Call once, right after initRedis(). */
export async function startNodeHeartbeat(): Promise<void> {
  const redis = getRedis();
  const key = heartbeatKey(NODE_ID());
  await redis.set(key, String(Date.now()), { EX: NODE_HEARTBEAT_TTL_S });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    redis.set(key, String(Date.now()), { EX: NODE_HEARTBEAT_TTL_S })
      .catch((err) => console.warn('[Redis] Node heartbeat refresh failed:', err));
  }, NODE_HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive just for the heartbeat
  heartbeatTimer.unref?.();
}

/** Stop the heartbeat and delete the liveness key (graceful shutdown) so peers
 *  reap this node's state promptly instead of waiting out the TTL. */
export async function stopNodeHeartbeat(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await getRedis().del(heartbeatKey(NODE_ID()))
    .catch((err) => console.warn('[Redis] Node heartbeat delete failed:', err));
}

/** True if the given node currently holds a live heartbeat. */
export async function isNodeAlive(nodeId: string): Promise<boolean> {
  return (await getRedis().exists(heartbeatKey(nodeId))) === 1;
}

/** How many nodes hold a live heartbeat, split by self vs peers. `total` may
 *  exclude this node at boot, before `startNodeHeartbeat` has written its key —
 *  which is why callers that need "is there anyone else" read `peers`. */
export async function liveNodeCounts(): Promise<{ total: number; peers: number }> {
  const redis = getRedis();
  const self = heartbeatKey(NODE_ID());
  let total = 0;
  let peers = 0;
  for await (const batch of redis.scanIterator({ MATCH: 'node:alive:*', COUNT: 100 })) {
    for (const key of batch) {
      total++;
      if (key !== self) peers++;
    }
  }
  return { total, peers };
}

/** True if any node OTHER than this one holds a live heartbeat. */
export async function anyOtherNodeAlive(): Promise<boolean> {
  return (await liveNodeCounts()).peers > 0;
}

// ─── Presence helpers (multi-node safe: 1 user → many sockets) ──────────────

export async function setUserOnline(userId: string, socketId: string): Promise<void> {
  const redis = getRedis();
  await redis.sAdd(`user:sockets:${userId}`, socketId);
  await redis.hSet('socket:users', socketId, userId);
  await redis.sAdd('online_users', userId);
}

export async function setUserOffline(socketId: string): Promise<{ userId: string; fullyOffline: boolean } | undefined> {
  const redis = getRedis();
  const userId = await redis.hGet('socket:users', socketId);
  if (userId) {
    await redis.hDel('socket:users', socketId);
    await redis.sRem(`user:sockets:${userId}`, socketId);
    // Only mark user offline if they have no remaining sockets on any node
    const remaining = await redis.sCard(`user:sockets:${userId}`);
    if (remaining === 0) {
      await redis.sRem('online_users', userId);
      await redis.del(`user:sockets:${userId}`);
      return { userId, fullyOffline: true };
    }
    return { userId, fullyOffline: false };
  }
  return undefined;
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const redis = getRedis();
  return Boolean(await redis.sIsMember('online_users', userId));
}

export async function getOnlineUsers(): Promise<string[]> {
  const redis = getRedis();
  return await redis.sMembers('online_users');
}

/** Get all socket IDs for a user across all nodes. */
export async function getUserSockets(userId: string): Promise<string[]> {
  const redis = getRedis();
  return await redis.sMembers(`user:sockets:${userId}`);
}

/** Minimal structural view of Socket.IO used for cluster-wide socket existence checks. */
export interface ClusterSocketLookup {
  in: (room: string) => { fetchSockets: () => Promise<unknown[]> };
  /** Adapter access for the batched liveness snapshot. Deliberately untyped
   *  beyond "an object": `allRooms` lives on the Redis adapter subclass, not
   *  on socket.io's base `Adapter`, so naming it here would make the real
   *  `Server` fail to satisfy this interface. Narrowed at the call site. */
  of?: (nsp: string) => { adapter: object };
}

/** True if the socket still exists ANYWHERE in the cluster (adapter-wide lookup).
 *  ONE socket per call — use `liveClusterSocketIds` for a sweep. */
export async function socketExistsInCluster(io: ClusterSocketLookup, socketId: string): Promise<boolean> {
  const sockets = await io.in(socketId).fetchSockets();
  return sockets.length > 0;
}

/**
 * Every live socket id in the cluster, in ONE adapter round trip.
 *
 * Every socket auto-joins a room named after its own id, so the adapter's
 * room list IS the liveness set (it also contains the named rooms — all of
 * which are prefixed `user:` / `server:` / `channel:` / `dm:` / `voice:`, so
 * they cannot be mistaken for a socket id).
 *
 * Returns null when the adapter cannot answer at all, so the caller can fall
 * back to the per-socket path. THROWS when the adapter is present but its
 * answer would be PARTIAL — a partial answer looks like "those sockets are
 * dead" and marks live users on a peer offline, so callers must skip the reap
 * rather than act on it. There are two ways to get a partial answer and only
 * one of them announces itself:
 *
 *  - the cluster request TIMES OUT — the adapter rejects, and that propagates;
 *  - the adapter decides there is no cluster to ask. `@socket.io/redis-adapter`
 *    resolves `allRooms()` with THIS NODE'S OWN rooms, silently and with no
 *    error, whenever `PUBSUB NUMSUB` on its request channel reports <= 1
 *    subscriber. That is indistinguishable from a complete answer, and at boot
 *    — before `server.listen()` — this node's room set is EMPTY, so it reads as
 *    "every socket in the cluster is dead". The callers would then mark every
 *    connected user offline and hang up every live DM call in the cluster.
 *
 * `peerCount` is what the heartbeats say. If peers exist but the adapter can
 * see at most itself, the two oracles disagree — the heartbeat lives on the
 * data connection, `serverCount()` on the subscriber one, and a Redis failover
 * or a reconnecting subscriber drops the latter while the former is still
 * fresh. Refusing costs one skipped boot sweep; trusting it costs the cluster.
 */
export async function liveClusterSocketIds(
  io: ClusterSocketLookup,
  peerCount = 0,
): Promise<Set<string> | null> {
  const adapter = io.of?.('/')?.adapter as {
    allRooms?: () => Promise<Set<string>>;
    serverCount?: () => Promise<number>;
  } | undefined;
  if (typeof adapter?.allRooms !== 'function') return null;

  if (peerCount > 0 && typeof adapter.serverCount === 'function') {
    const seen = await adapter.serverCount();
    if (seen <= 1) {
      throw new Error(
        `adapter sees ${seen} server(s) but ${peerCount} peer heartbeat(s) are live — `
        + 'the snapshot would be this node\'s own rooms, not the cluster\'s',
      );
    }
  }
  return await adapter.allRooms();
}

/**
 * Clear stale presence state from Redis and reset affected DB user statuses.
 * Called on server startup (crash/redeploy leftovers) and shutdown.
 *
 * Multi-node aware: production runs multiple instances, so wiping ALL presence
 * would mark every user on the peer nodes offline. When another node is alive
 * (heartbeat present) and an `io` is provided, only sockets that no longer
 * exist anywhere in the cluster are reaped. The full wipe is used only when
 * this is the sole node (single-node semantics — every socket is dead anyway).
 */
export async function clearPresenceState(
  db: { user: { updateMany: (args: { where: { status: string; id?: { in: string[] } }; data: { status: string } }) => Promise<unknown> } },
  io?: ClusterSocketLookup,
): Promise<{ skipped: boolean }> {
  const redis = getRedis();

  const { peers } = io ? await liveNodeCounts() : { peers: 0 };
  if (io && peers > 0) {
    // Scoped reap: drop only cluster-wide-dead sockets; peers' users stay online.
    //
    // ONE adapter snapshot, not one cluster round trip per entry. `socket:users`
    // is the GLOBAL hash, so the old loop probed every LIVE socket on every peer
    // too — just to `continue`. After a crash or redeploy that is tens of
    // thousands of serial 2-round-trip lookups before server.listen(), and an
    // unresponsive peer made each one sit out the adapter's full 5s timeout.
    // ORDER MATTERS: read the candidate list FIRST, take the snapshot AFTER.
    // The reverse leaves a window where a socket that connects between the two
    // is absent from the snapshot but present in the hash — and gets reaped
    // while its user is connected. Snapshotting last makes the liveness view
    // strictly newer than every candidate in it, which is the safe direction.
    const socketUsers = await redis.hGetAll('socket:users');

    let live: Set<string> | null;
    try {
      live = await liveClusterSocketIds(io, peers);
    } catch (err) {
      // A partial snapshot — timed out, or an adapter that cannot see the
      // cluster it is being asked about. Acting on it would mark live users on
      // a peer offline, which is worse than leaving stale rows for the next
      // boot to clear.
      console.warn('[Presence] Cluster socket snapshot unusable — skipping the scoped reap:', err instanceof Error ? err.message : err);
      return { skipped: true };
    }

    const fullyOffline: string[] = [];
    for (const socketId of Object.keys(socketUsers)) {
      if (live) {
        if (live.has(socketId)) continue;
      } else {
        // Adapter without allRooms (a hand-rolled io): legacy per-socket path
        try {
          if (await socketExistsInCluster(io, socketId)) continue;
        } catch (err) {
          console.warn('[Presence] Cluster socket lookup failed, skipping reap for', socketId, err);
          continue;
        }
      }
      const result = await setUserOffline(socketId);
      if (result?.fullyOffline) fullyOffline.push(result.userId);
    }
    if (fullyOffline.length > 0) {
      await db.user.updateMany({ where: { status: 'online', id: { in: fullyOffline } }, data: { status: 'offline' } });
      console.log(`[Presence] Reaped ${fullyOffline.length} stale user(s) (scoped, peers alive)`);
    }
    return { skipped: false };
  }

  // Sole node: legacy full wipe.
  const staleUsers = await redis.sMembers('online_users');
  if (staleUsers.length > 0) {
    await redis.del(staleUsers.map((id) => `user:sockets:${id}`));
  }
  await redis.del(['online_users', 'socket:users']);
  await db.user.updateMany({ where: { status: 'online' }, data: { status: 'offline' } });
  return { skipped: false };
}
