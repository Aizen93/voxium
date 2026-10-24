import { createClient } from 'redis';

/** A failed quit must not fail the test, but it must not vanish either. */
function quitQuietly(redis: { quit(): Promise<unknown> }): Promise<unknown> {
  return redis.quit().catch((err: unknown) => console.warn('[e2e] redis quit failed:', err instanceof Error ? err.message : String(err)));
}

/**
 * Reset every rate-limit counter (never `rl:config`, which holds the admin
 * overrides the server loaded at boot).
 *
 * Why a test needs this MID-run, not just between tests: one Playwright
 * worker drives every browser context from the same address, and every
 * per-address bucket (the anonymous general budget, the sign-in failure
 * buckets, registration) is shared by all of them. The signed-in general
 * budget is per user, so ordinary reads no longer pile up on one bucket, but a
 * multi-device scenario still registers and signs in several accounts from
 * one address, and the reset keeps one spec's spend from reaching the next.
 *
 * That is a property of the harness, not of the product: a real user is one
 * browser, and the per-route E2E budgets sit at a few percent of their limits
 * throughout (`rl:e2estat` peaked at 16 of 300 while `rl:general` hit 104).
 * Raising the product's limit to suit the harness would be fixing the wrong
 * thing, so the harness resets its own counter instead.
 */
/**
 * Drop the directory's 60 s page cache (`discovery:page:*`) so the next
 * Explore read is fresh. Not an `rl:` key, so `clearRateLimits()` leaves it:
 * a retry inside the minute would otherwise read the previous attempt's page.
 */
export async function clearDiscoveryPageCache(): Promise<void> {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  try {
    await redis.connect();
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: 'discovery:page:*', COUNT: 100 })) {
      for (const key of batch) keys.push(key);
    }
    if (keys.length > 0) await redis.del(keys);
  } finally {
    await quitQuietly(redis);
  }
}

export async function clearRateLimits(): Promise<void> {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  try {
    await redis.connect();
    const keys: string[] = [];
    // node-redis v5 yields a BATCH (array) per iteration, not one key. Treating
    // each yield as a string pushes arrays into the list and `del` then throws
    // `"arguments[1]" must be of type "string | Buffer", got object`.
    for await (const batch of redis.scanIterator({ MATCH: 'rl:*', COUNT: 100 })) {
      for (const key of batch) {
        if (key !== 'rl:config') keys.push(key);
      }
    }
    if (keys.length > 0) await redis.del(keys);
  } finally {
    await quitQuietly(redis);
  }
}
