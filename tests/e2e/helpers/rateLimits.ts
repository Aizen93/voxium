import { createClient } from 'redis';

/**
 * Reset every rate-limit counter (never `rl:config`, which holds the admin
 * overrides the server loaded at boot).
 *
 * Why a test needs this MID-run, not just between tests: the global limiter is
 * IP-keyed at 100 requests/60s, and one Playwright worker drives every browser
 * context from the same address. A single-user test stays well inside that, but
 * a multi-device scenario runs three contexts — two devices of one account plus
 * the peer — and their combined traffic crosses 100 partway through, at which
 * point ordinary reads start coming back 429.
 *
 * That is a property of the harness, not of the product: a real user is one
 * browser, and the per-route E2E budgets sit at a few percent of their limits
 * throughout (`rl:e2estat` peaked at 16 of 300 while `rl:general` hit 104).
 * Raising the product's limit to suit the harness would be fixing the wrong
 * thing, so the harness resets its own counter instead.
 */
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
    await redis.quit().catch(() => {});
  }
}
