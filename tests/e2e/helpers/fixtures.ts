import { test as base } from '@playwright/test';
import { createClient } from 'redis';

/** Extended test fixture that clears rate limit counter keys before each test. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    try {
      await redis.connect();
      // Use SCAN to find rate limit counter keys, excluding the config key
      const keysToDelete: string[] = [];
      for await (const key of redis.scanIterator({ MATCH: 'rl:*', COUNT: 100 })) {
        if (key !== 'rl:config') keysToDelete.push(key);
      }
      if (keysToDelete.length > 0) await redis.del(keysToDelete);
    } finally {
      await redis.quit().catch(() => {});
    }

    await use(page);
  },
});

export { expect } from '@playwright/test';
