import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { getRedis } from '../utils/redis';
import { rateLimitStats } from '../middleware/rateLimiter';

export const statsRouter = Router();

const CACHE_KEY = 'platform:stats';
const CACHE_TTL = 60; // seconds
/** How long the in-process copy of the totals may stand in for an unusable Redis cache. */
const LOCAL_COPY_MAX_AGE_MS = CACHE_TTL * 1000;
/** At most one warning per kind of cache failure per this long, not one per request. */
const WARN_INTERVAL_MS = 60_000;

interface Totals { users: number; servers: number; messages: number }
type CacheFailureKind = 'read' | 'corrupt' | 'write';

// The cache fails open, bounded per node: the last totals this node counted, with the time it
// counted them, and the one count in flight (concurrent requests share it).
let localCopy: { data: Totals; at: number } | null = null;
let inFlightCount: Promise<Totals> | null = null;
const lastWarnAt: Partial<Record<CacheFailureKind, number>> = {};

/** One warning per kind per minute, naming the error's type and code only: a Redis error's message
 *  can carry the connection string. */
function warnCacheFailure(kind: CacheFailureKind, err: unknown): void {
  const now = Date.now();
  const last = lastWarnAt[kind];
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
  lastWarnAt[kind] = now;
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  console.warn(`[Stats] Cache ${kind} failed (${name}${typeof code === 'string' ? `, ${code}` : ''}); serving without the Redis cache`);
}

/** How long a cache command may take before the cache counts as unusable. The Redis client queues
 *  commands while it is disconnected, so during an outage a command hangs instead of rejecting. */
const CACHE_COMMAND_TIMEOUT_MS = 1000;

/** Races one cache command against CACHE_COMMAND_TIMEOUT_MS; the timeout rejects with an error
 *  named TimeoutError. The timer is cleared when the command settles, and a command abandoned by
 *  the timeout has its later rejection swallowed here (it was already reported as a timeout). */
function withCacheTimeout<T>(command: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      const err = new Error('Redis command timed out');
      err.name = 'TimeoutError';
      reject(err);
    }, CACHE_COMMAND_TIMEOUT_MS);
    command.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        // After the timeout the caller has moved on: the late rejection is not reported again
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isTotals(value: unknown): value is Totals {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.users === 'number' && typeof v.servers === 'number' && typeof v.messages === 'number';
}

async function countTotals(): Promise<Totals> {
  const [users, servers, messages] = await Promise.all([
    prisma.user.count(),
    prisma.server.count(),
    prisma.message.count(),
  ]);
  const data = { users, servers, messages };
  localCopy = { data, at: Date.now() };
  return data;
}

/** ONE database count at a time: every request that needs one while it runs shares it. */
function sharedCount(): Promise<Totals> {
  if (!inFlightCount) {
    inFlightCount = countTotals().finally(() => { inFlightCount = null; });
  }
  return inFlightCount;
}

/** The totals while the Redis cache cannot be used: the in-process copy when it is younger than a
 *  minute, else the shared database count. */
function totalsWithoutCache(): Promise<Totals> | Totals {
  if (localCopy && Date.now() - localCopy.at < LOCAL_COPY_MAX_AGE_MS) return localCopy.data;
  return sharedCount();
}

statsRouter.get('/', rateLimitStats, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Try cache first
    let redis: ReturnType<typeof getRedis> | null = null;
    let cached: string | null = null;
    let cacheUsable = true;
    try {
      redis = getRedis();
      cached = await withCacheTimeout(redis.get(CACHE_KEY));
    } catch (err) {
      warnCacheFailure('read', err);
      cacheUsable = false;
    }

    if (cached) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cached);
      } catch (err) {
        parsed = undefined;
        warnCacheFailure('corrupt', err);
      }
      if (isTotals(parsed)) {
        res.json({ success: true, data: parsed });
        return;
      }
      if (parsed !== undefined) warnCacheFailure('corrupt', new TypeError('cached totals have the wrong shape'));
      cacheUsable = false;
    }

    if (!cacheUsable) {
      res.json({ success: true, data: await totalsWithoutCache() });
      return;
    }

    // Cache miss: count once, however many requests found the cache empty at the same moment
    const data = await sharedCount();

    // Store in cache; a failed write never fails the request
    try {
      await withCacheTimeout(redis!.set(CACHE_KEY, JSON.stringify(data), { EX: CACHE_TTL }));
    } catch (err) {
      warnCacheFailure('write', err);
    }

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
