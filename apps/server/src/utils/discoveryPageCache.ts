import { getRedis } from './redis';

/**
 * The Explore page cache's generation.
 *
 * `GET /discovery/servers` keeps the PUBLIC part of each page in Redis for
 * `DISCOVERY_PAGE_CACHE_TTL_S` (60 s), so a burst of visitors costs one query
 * per distinct page. Until 2.1.1 a listing change (a space hidden or relisted,
 * renamed, re-described, re-tagged, featured, deleted) stayed invisible for up
 * to that minute, and nothing short of a never-used search skipped the cache.
 *
 * The cache key now carries a generation: every write that changes what a
 * card shows, or whether a server is listed at all, bumps it, and the next
 * browse misses the old entries (they expire on their own). Explore stays
 * pull-based: a change shows when the user opens Explore, searches or changes
 * a filter, never through a live push (owner's decision, 2026-11-07).
 *
 * Both functions are fail-safe on purpose. A generation that cannot be read
 * makes the route skip the cache for that request (one uncached page, never a
 * stale one); a bump that fails is logged and the TTL still bounds the
 * staleness to a minute, as before.
 */
export const DISCOVERY_PAGE_GENERATION_KEY = 'discovery:page:gen';

/** The generation to key a page with. Throws when Redis does not answer: the caller serves uncached. */
export async function discoveryPageGeneration(): Promise<string> {
  const gen = await getRedis().get(DISCOVERY_PAGE_GENERATION_KEY);
  return gen ?? '0';
}

/**
 * Invalidate every cached Explore page. `reason` names the write, for the log
 * line when Redis refuses. Never throws: the caller's own write has committed.
 */
export async function bumpDiscoveryPageCache(reason: string): Promise<void> {
  try {
    await getRedis().incr(DISCOVERY_PAGE_GENERATION_KEY);
  } catch (err) {
    console.warn(`[Discovery] Page cache not invalidated after ${reason}:`, err instanceof Error ? err.message : err);
  }
}
