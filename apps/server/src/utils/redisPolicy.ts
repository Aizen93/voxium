/**
 * Redis holds this server's state, not a cache: rate-limit and abuse budgets,
 * the single-use marks of solved sign-up challenges and of used two-factor
 * codes, the admin's feature-flag and rate-limit overrides, scheduled-job
 * locks, node heartbeats, presence and voice state. Under an eviction policy
 * Redis drops such keys silently once it reaches `maxmemory`; `volatile-*`
 * policies are no better, since the marks, the budgets and the locks all
 * carry a TTL. The policy this server expects is `noeviction`, which refuses
 * new writes when Redis is full and keeps everything it holds
 * (docker-compose.production.yml sets it, with the reasons).
 *
 * The check runs once at startup and decides nothing: a Redis that evicts
 * still serves, and a managed Redis may refuse CONFIG altogether.
 */

/** The one CONFIG GET call the check makes (the node-redis client's own method). */
export interface RedisConfigReader {
  configGet(parameters: string): Promise<Record<string, string | null | undefined>>;
}

/**
 * One pattern for both settings: CONFIG GET takes a single parameter before
 * Redis 7, and `maxmemory*` answers maxmemory and maxmemory-policy (with
 * their siblings) on every version.
 */
export const EVICTION_SETTINGS_PATTERN = 'maxmemory*';

export type EvictionPolicyCheck = 'noeviction' | 'no-limit' | 'evicting' | 'unknown';

/**
 * Read `maxmemory` and `maxmemory-policy` and log what they mean for the
 * server's state: one line, a warning when keys can be evicted or the
 * settings could not be read.
 */
export async function checkRedisEvictionPolicy(redis: RedisConfigReader): Promise<EvictionPolicyCheck> {
  let config: Record<string, string | null | undefined>;
  try {
    config = await redis.configGet(EVICTION_SETTINGS_PATTERN);
  } catch (err) {
    console.warn(
      '[Redis] Could not read the eviction policy (CONFIG GET failed or is not allowed):',
      err instanceof Error ? err.message : String(err),
      '- make sure maxmemory-policy is noeviction, or keys this server relies on can be dropped when memory runs short',
    );
    return 'unknown';
  }
  const policy = config['maxmemory-policy'];
  const maxmemory = config.maxmemory;
  if (typeof policy !== 'string' || typeof maxmemory !== 'string' || !/^\d+$/.test(maxmemory)) {
    console.warn('[Redis] Could not read the eviction policy (CONFIG GET answered without maxmemory and maxmemory-policy): make sure maxmemory-policy is noeviction');
    return 'unknown';
  }
  if (policy === 'noeviction') {
    console.log('[Redis] Eviction policy: noeviction (a full Redis refuses new writes and drops nothing)');
    return 'noeviction';
  }
  if (maxmemory === '0') {
    // No memory limit: Redis evicts nothing whatever the policy says, until
    // a limit is set (or the host runs out of memory).
    console.log(`[Redis] No maxmemory limit set: nothing is evicted (maxmemory-policy ${policy} would apply once a limit is set; noeviction is the one this server expects)`);
    return 'no-limit';
  }
  console.warn(
    `[Redis] maxmemory-policy is ${policy}: once Redis reaches maxmemory it drops keys this server relies on ` +
    '(abuse budgets, single-use marks, admin overrides, job locks, presence and voice state) without an error. ' +
    'Set maxmemory-policy noeviction.',
  );
  return 'evicting';
}
