import { createClient, type RedisClientType } from 'redis';
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

export async function initRedis(): Promise<RedisClientType> {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  redisClient = createClient({ url });
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

/**
 * Clear all presence state from Redis and reset DB user statuses to 'offline'.
 * Must be called on server startup to clean up stale state from previous runs
 * (e.g. crash, hot reload) where disconnect handlers never fired.
 */
export async function clearPresenceState(db: { user: { updateMany: (args: { where: { status: string }; data: { status: string } }) => Promise<unknown> } }): Promise<void> {
  const redis = getRedis();
  // Collect all user IDs that Redis thinks are online
  const staleUsers = await redis.sMembers('online_users');
  // Delete per-user socket sets
  if (staleUsers.length > 0) {
    await redis.del(staleUsers.map((id) => `user:sockets:${id}`));
  }
  // Clear global presence keys
  await redis.del(['online_users', 'socket:users']);
  // Reset all 'online' users in DB to 'offline'
  await db.user.updateMany({ where: { status: 'online' }, data: { status: 'offline' } });
}
