import { test as base } from '@playwright/test';
import { createClient } from 'redis';

/** Extended test fixture that clears rate limit keys before each test. */
export const test = base.extend({
  // Automatically clear rate limits before each test
  page: async ({ page }, use) => {
    const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    await redis.connect();
    const keys = await redis.keys('rl:*');
    if (keys.length > 0) await redis.del(keys);
    await redis.quit();

    await use(page);
  },
});

export { expect } from '@playwright/test';
