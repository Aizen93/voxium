import { createClient, type RedisClientType } from 'redis';

let redisClient: RedisClientType;

export async function initRedis(): Promise<RedisClientType> {
  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  redisClient.on('error', (err) => {
    console.error('[Redis] Error:', err);
  });

  await redisClient.connect();
  return redisClient;
}

export function getRedis(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return redisClient;
}

// ─── Presence helpers ────────────────────────────────────────────────────────

export async function setUserOnline(userId: string, socketId: string): Promise<void> {
  const redis = getRedis();
  await redis.hSet('user:sockets', userId, socketId);
  await redis.hSet('socket:users', socketId, userId);
  await redis.sAdd('online_users', userId);
}

export async function setUserOffline(socketId: string): Promise<string | undefined> {
  const redis = getRedis();
  const userId = await redis.hGet('socket:users', socketId);
  if (userId) {
    await redis.hDel('user:sockets', userId);
    await redis.hDel('socket:users', socketId);
    await redis.sRem('online_users', userId);
    return userId;
  }
  return undefined;
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const redis = getRedis();
  return await redis.sIsMember('online_users', userId);
}

export async function getOnlineUsers(): Promise<string[]> {
  const redis = getRedis();
  return await redis.sMembers('online_users');
}

export async function getUserSocket(userId: string): Promise<string | undefined> {
  const redis = getRedis();
  return (await redis.hGet('user:sockets', userId)) ?? undefined;
}
