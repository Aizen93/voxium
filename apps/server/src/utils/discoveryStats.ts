import { prisma } from './prisma';
import { getRedis } from './redis';
import { withClusterLock, wasSkipped, lockToken, releaseLockIfOwned } from './dailySchedule';
import { DISCOVERY_SCORE_WEIGHTS, JOIN_REQUEST_DECLINE_COOLDOWN_DAYS, JOIN_REQUEST_PENDING_TTL_DAYS } from '@voxium/shared';

// The directory's activity figures on a daily cycle
// (docs/local/server-discovery-plan.html, "Statistics, daily cycle").
//
// The directory does not need live figures: a day-old number is fine, two
// days under backlog is fine, and a server not yet refreshed ranks on what it
// has. So this is a BUDGETED background cycle, not a reaction to writes —
// nothing on the message or membership paths marks anything, no route
// recomputes on write. The one live figure is memberCount, maintained inline
// by joinServerMember / removeMemberFromServer.
//
// Every 5 minutes on every node, under a cluster lock HELD for 290 s after a
// successful run (so the cluster runs it ~once per interval, whichever node's
// timer fires first), each run refreshes the stalest listed servers in
// batches of 500 until its time budget or row cap is spent. Every statement
// is bounded by an id list and served by an existing index; nothing scans the
// platform. At one million listed servers the 24-hour cycle needs ~3,500
// refreshes per run, inside the cap; if the backlog grows the fix is a bigger
// cap or a shorter cadence, both constants.
//
// Housekeeping rides on the same timer: once an hour the two join-request
// sweeps, once a day in the 04:xx slot the two drift corrections (member
// counts recounted, the listing column recomputed from its inputs).

export const DISCOVERY_STATS_INTERVAL_MS = 5 * 60 * 1000;
export const DISCOVERY_STATS_FIRST_RUN_MS = 60 * 1000;
export const DISCOVERY_STATS_LOCK_KEY = 'lock:discoverystats';
export const DISCOVERY_STATS_LOCK_TTL_SECONDS = 290;
/** Redis unreachable: retry soon, not in five minutes. */
export const DISCOVERY_STATS_RETRY_MS = 60 * 1000;
export const DISCOVERY_STATS_BATCH = 500;
/** Wall-clock budget per run — what keeps the job from competing with user traffic. */
export const DISCOVERY_STATS_RUN_BUDGET_MS = 30 * 1000;
export const DISCOVERY_STATS_RUN_MAX = 5000;
/** A listed server is refreshed when its figures are older than this. */
export const DISCOVERY_STATS_STALE_MS = 24 * 60 * 60 * 1000;
/** Figures older than this are logged as backlog after each run. */
export const DISCOVERY_STATS_BACKLOG_MS = 48 * 60 * 60 * 1000;
export const DISCOVERY_HOUSEKEEPING_HOURLY_KEY = 'discovery:housekeeping:hourly';
export const DISCOVERY_HOUSEKEEPING_DAILY_KEY = 'discovery:housekeeping:daily';
export const DISCOVERY_HOUSEKEEPING_HOUR = 4;
/** The housekeeping claims are SET NX EX keys sized as the slot's exclusivity
 *  window (shorter than the interval, so the next slot can claim) — the same
 *  idiom as the held cluster lock. Two nodes in different timezones have
 *  different 04:xx hours; the claim, not the wall clock, is what makes the
 *  nightly pass once per cluster-day. */
export const DISCOVERY_HOUSEKEEPING_HOURLY_TTL_S = 55 * 60;
export const DISCOVERY_HOUSEKEEPING_DAILY_TTL_S = 20 * 60 * 60;
/** The backlog count after a run is capped: its cost grows with the backlog,
 *  i.e. exactly when the job is behind. Above the cap the log says "N+". */
export const DISCOVERY_BACKLOG_COUNT_CAP = 100_000;

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

export function startDiscoveryStats(): void {
  if (!stopped) return;
  stopped = false;
  scheduleNext(DISCOVERY_STATS_FIRST_RUN_MS);
}

export function stopDiscoveryStats(): void {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext(delay: number): void {
  if (stopped) return;
  timeoutId = setTimeout(runDiscoveryStatsCycle, delay);
  timeoutId.unref?.();
}

export interface DiscoveryStatsRun {
  refreshed: number;
  batches: number;
  elapsedMs: number;
  /** Listed servers whose figures are still older than 48 h after this run. */
  backlog: number;
  hourlyHousekeeping: boolean;
  dailyHousekeeping: boolean;
}

/** One locked cycle; 0-refreshed result when another node holds the lock or the run failed. Always re-arms the timer. */
export async function runDiscoveryStatsCycle(): Promise<DiscoveryStatsRun | null> {
  let nextDelay = DISCOVERY_STATS_INTERVAL_MS;
  try {
    const result = await withClusterLock(
      { key: DISCOVERY_STATS_LOCK_KEY, ttlSeconds: DISCOVERY_STATS_LOCK_TTL_SECONDS, tag: '[Discovery]', holdOnSuccess: true },
      runCycleBody,
    );
    if (wasSkipped(result)) {
      if (result.skipped === 'unavailable') nextDelay = DISCOVERY_STATS_RETRY_MS;
      return null;
    }
    return result;
  } catch (err) {
    console.error('[Discovery] Stats cycle failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    scheduleNext(nextDelay);
  }
}

/**
 * The stalest listed servers, NULL figures first, then oldest first, at most
 * `limit`. Two index range scans on (discovery_listed, discovery_stats_at)
 * rather than one ORDER BY ... NULLS FIRST, which a default btree cannot
 * serve without a sort over every stale row.
 */
export async function pickStaleServerIds(limit: number, now: Date = new Date()): Promise<string[]> {
  const never = await prisma.server.findMany({
    where: { discoveryListed: true, statsRefreshedAt: null },
    // The ORDER BY is a planner hint: with NULLs dense (every server, right
    // after the migration) a bare LIMIT plans as a sequential scan; ordered
    // on the index's second column it is one index range scan (measured at
    // one million rows: 0.2 ms either way, but only one of them stays that
    // way when NULLs become rare and the estimate is stale).
    orderBy: { statsRefreshedAt: 'asc' },
    select: { id: true },
    take: limit,
  });
  if (never.length >= limit) return never.map((s) => s.id);
  const cutoff = new Date(now.getTime() - DISCOVERY_STATS_STALE_MS);
  const stale = await prisma.server.findMany({
    where: { discoveryListed: true, statsRefreshedAt: { lt: cutoff } },
    orderBy: { statsRefreshedAt: 'asc' },
    select: { id: true },
    take: limit - never.length,
  });
  return [...never, ...stale].map((s) => s.id);
}

/**
 * Recompute the three figures for a batch of servers: weekly messages and
 * online members read with two bounded aggregates, written back with one
 * statement that also derives the activity score from the shared weights
 * (online × 10 + messages × 1 + members × 1 — printed on every card).
 */
export async function recomputeServerStats(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const W = DISCOVERY_SCORE_WEIGHTS;

  const [weeklyRows, onlineRows] = await Promise.all([
    // nested loop over the server's channels, then an index range per channel
    prisma.$queryRaw<Array<{ serverId: string; n: number }>>`
      SELECT c.server_id AS "serverId", COUNT(*)::int AS n
      FROM channels c JOIN messages m ON m.channel_id = c.id
      WHERE c.server_id = ANY(${ids}::text[]) AND m.created_at >= now() - interval '7 days'
      GROUP BY c.server_id`,
    prisma.$queryRaw<Array<{ serverId: string; n: number }>>`
      SELECT sm.server_id AS "serverId", COUNT(*)::int AS n
      FROM server_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ANY(${ids}::text[]) AND u.status = 'online'
      GROUP BY sm.server_id`,
  ]);
  const weeklyBy = new Map(weeklyRows.map((r) => [r.serverId, r.n]));
  const onlineBy = new Map(onlineRows.map((r) => [r.serverId, r.n]));
  const weekly = ids.map((id) => weeklyBy.get(id) ?? 0);
  const online = ids.map((id) => onlineBy.get(id) ?? 0);

  await prisma.$executeRaw`
    UPDATE servers s SET
      discovery_weekly_messages = v.weekly,
      discovery_online_count    = v.online,
      discovery_activity_score  = v.online * ${W.online}::int + v.weekly * ${W.messages}::int + s.member_count * ${W.members}::int,
      discovery_stats_at        = now()
    FROM unnest(${ids}::text[], ${weekly}::int[], ${online}::int[]) AS v(id, weekly, online)
    WHERE s.id = v.id`;
}

/**
 * Listed servers whose figures are missing or older than the backlog window,
 * counted through a subquery capped at DISCOVERY_BACKLOG_COUNT_CAP + 1 rows
 * (an index-only range scan that stops at the cap — never a count that
 * scales with how far behind the job is).
 */
export async function countStatsBacklog(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DISCOVERY_STATS_BACKLOG_MS);
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM (
      SELECT 1 FROM servers
      WHERE discovery_listed = true AND (discovery_stats_at IS NULL OR discovery_stats_at < ${cutoff})
      LIMIT ${DISCOVERY_BACKLOG_COUNT_CAP + 1}
    ) t`;
  return rows[0]?.n ?? 0;
}

/** The two join-request sweeps, each served by its [status, …] index. */
export async function sweepJoinRequests(now: Date = new Date()): Promise<{ declined: number; pending: number }> {
  const declinedBefore = new Date(now.getTime() - JOIN_REQUEST_DECLINE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const pendingBefore = new Date(now.getTime() - JOIN_REQUEST_PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);
  const [declined, pending] = await Promise.all([
    prisma.serverJoinRequest.deleteMany({ where: { status: 'declined', decidedAt: { lt: declinedBefore } } }),
    prisma.serverJoinRequest.deleteMany({ where: { status: 'pending', createdAt: { lt: pendingBefore } } }),
  ]);
  return { declined: declined.count, pending: pending.count };
}

/**
 * The two drift corrections, as set-based statements: member_count recounted
 * from server_members and discovery_listed recomputed from its four inputs.
 * Each writes only the rows that disagree.
 */
export async function correctDrift(): Promise<{ memberCounts: number; listed: number }> {
  // The GROUP BY is the statement's snapshot, but under READ COMMITTED the
  // `<>` is re-checked against the NEWEST version of a row a concurrent
  // join just incremented — and would write the pre-join count back over
  // it. Both membership helpers stamp updated_at, so rows touched in the
  // last five minutes are left for the next night.
  const memberCounts = await prisma.$executeRaw`
    UPDATE servers s SET member_count = c.n
    FROM (SELECT server_id, COUNT(*)::int AS n FROM server_members GROUP BY server_id) c
    WHERE c.server_id = s.id AND s.member_count <> c.n AND s.updated_at < now() - interval '5 minutes'`;
  const listed = await prisma.$executeRaw`
    UPDATE servers s SET discovery_listed = (
      s.discoverable AND NOT s.invites_locked AND s.discovery_blocked_at IS NULL AND u.banned_at IS NULL
    )
    FROM users u
    WHERE u.id = s.owner_id AND s.discovery_listed IS DISTINCT FROM (
      s.discoverable AND NOT s.invites_locked AND s.discovery_blocked_at IS NULL AND u.banned_at IS NULL
    )`;
  return { memberCounts, listed };
}

/**
 * Claim the hourly and (inside the 04:xx slot) the daily housekeeping BEFORE
 * doing it: `SET NX EX` keys whose TTL is the slot's exclusivity window.
 * Returns the claim tokens (null = not claimed: someone did it this slot, or
 * not in the slot). A claim whose work then fails is released so the next
 * cycle retries, see runCycleBody.
 */
export async function claimHousekeeping(now: Date = new Date()): Promise<{ hourly: string | null; daily: string | null }> {
  const redis = getRedis();
  const claim = async (key: string, ttl: number): Promise<string | null> => {
    const token = lockToken();
    const ok = await redis.set(key, token, { NX: true, EX: ttl });
    return ok === 'OK' ? token : null;
  };
  const hourly = await claim(DISCOVERY_HOUSEKEEPING_HOURLY_KEY, DISCOVERY_HOUSEKEEPING_HOURLY_TTL_S);
  const inSlot = now.getHours() === DISCOVERY_HOUSEKEEPING_HOUR;
  const daily = inSlot ? await claim(DISCOVERY_HOUSEKEEPING_DAILY_KEY, DISCOVERY_HOUSEKEEPING_DAILY_TTL_S) : null;
  return { hourly, daily };
}

async function runCycleBody(): Promise<DiscoveryStatsRun> {
  const startedAt = Date.now();
  let refreshed = 0;
  let batches = 0;
  let drained = false;

  while (refreshed < DISCOVERY_STATS_RUN_MAX && Date.now() - startedAt < DISCOVERY_STATS_RUN_BUDGET_MS) {
    const ids = await pickStaleServerIds(Math.min(DISCOVERY_STATS_BATCH, DISCOVERY_STATS_RUN_MAX - refreshed));
    if (ids.length === 0) {
      drained = true;
      break;
    }
    await recomputeServerStats(ids);
    refreshed += ids.length;
    batches += 1;
  }

  // Nothing stale was left to pick, so nothing can be older than 48 h
  const backlog = drained ? 0 : await countStatsBacklog();
  const elapsedMs = Date.now() - startedAt;
  if (refreshed > 0 || backlog > 0) {
    const backlogLabel = backlog > DISCOVERY_BACKLOG_COUNT_CAP ? `${DISCOVERY_BACKLOG_COUNT_CAP}+` : String(backlog);
    console.log(`[Discovery] Refreshed ${refreshed} listed server(s) in ${batches} batch(es), ${elapsedMs}ms; backlog older than 48h: ${backlogLabel}`);
  }

  const claims = await claimHousekeeping();
  if (claims.hourly) {
    try {
      const swept = await sweepJoinRequests();
      if (swept.declined + swept.pending > 0) {
        console.log(`[Discovery] Swept ${swept.declined} declined and ${swept.pending} stale pending join request(s)`);
      }
    } catch (err) {
      await releaseLockIfOwned(getRedis(), DISCOVERY_HOUSEKEEPING_HOURLY_KEY, claims.hourly)
        .catch((e) => console.warn('[Discovery] Hourly claim release failed (it expires on its own):', e instanceof Error ? e.message : e));
      throw err;
    }
  }
  if (claims.daily) {
    try {
      const fixed = await correctDrift();
      console.log(`[Discovery] Nightly drift correction: ${fixed.memberCounts} member count(s), ${fixed.listed} listing flag(s)`);
    } catch (err) {
      await releaseLockIfOwned(getRedis(), DISCOVERY_HOUSEKEEPING_DAILY_KEY, claims.daily)
        .catch((e) => console.warn('[Discovery] Daily claim release failed (it expires on its own):', e instanceof Error ? e.message : e));
      throw err;
    }
  }

  return { refreshed, batches, elapsedMs, backlog, hourlyHousekeeping: claims.hourly !== null, dailyHousekeeping: claims.daily !== null };
}

