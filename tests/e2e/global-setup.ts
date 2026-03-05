import { createClient } from 'redis';

/**
 * Global setup: clear rate limit keys in Redis so E2E tests don't hit
 * rate limits from previous test runs.
 */
async function globalSetup() {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await redis.connect();

  // Delete all rate limit keys
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) {
    await redis.del(keys);
    console.log(`[E2E Setup] Cleared ${keys.length} rate limit keys`);
  }

  await redis.quit();
}

export default globalSetup;
