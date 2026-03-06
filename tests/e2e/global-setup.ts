import { createClient } from 'redis';

/**
 * Global setup: clear rate limit keys in Redis so E2E tests don't hit
 * rate limits from previous test runs.
 */
async function globalSetup() {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  try {
    await redis.connect();

    // Delete rate limit counter keys, preserving rl:config
    const keysToDelete: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: 'rl:*', COUNT: 100 })) {
      if (key !== 'rl:config') keysToDelete.push(key);
    }
    if (keysToDelete.length > 0) {
      await redis.del(keysToDelete);
      console.log(`[E2E Setup] Cleared ${keysToDelete.length} rate limit keys`);
    }
  } finally {
    await redis.quit().catch(() => {});
  }
}

export default globalSetup;
