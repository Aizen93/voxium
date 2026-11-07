import { prisma } from './prisma';
import { getRedis } from './redis';
import { DISCOVERY_TIERS, DISCOVERY_TIER_TOP_FRACTION, DISCOVERY_TIER_MIN_POPULATION } from '@voxium/shared';
import type { DiscoveryTier, DiscoveryTierThresholds } from '@voxium/shared';

// Activity badges (Bronze … Diamond) from the SAME score the Active sort uses
// and nothing else: a badge is a RANK among the listed spaces that have any
// activity — the top half earns Bronze, the top 1% Diamond
// (DISCOVERY_TIER_TOP_FRACTION). The cuts are the score at each percentile,
// computed by the stats cycle (hourly, and whenever the key is missing) and
// kept in Redis; the directory reads them when it builds a page and stamps a
// tier on every card. No votes, no curation: Featured stays the hand-picked
// row, and the three inputs of the score stay printed on the card.

export const DISCOVERY_TIERS_KEY = 'discovery:tiers';
/** A day: the hourly housekeeping refreshes long before, and a stale set of cuts beats none. */
export const DISCOVERY_TIERS_TTL_S = 24 * 60 * 60;

/**
 * The lowest score that earns every tier, over listed spaces with a non-zero
 * score, in ONE statement: percentile_disc on an index-only scan of the sort
 * index gives the score at the boundary, and the tier starts one above it.
 * STRICTLY above: a badge that says "top 1%" must never cover more than 1%,
 * so a flat stretch of tied scores at the boundary stays out (and a flat
 * top means nobody holds Diamond, which is right — a badge is earned by
 * being distinctly better). Below the minimum population there are no cuts
 * at all — six servers have no "top 1%".
 */
export async function computeTierThresholds(now: Date = new Date()): Promise<DiscoveryTierThresholds> {
  const quantiles = DISCOVERY_TIERS.map((tier) => 1 - DISCOVERY_TIER_TOP_FRACTION[tier]);
  const rows = await prisma.$queryRaw<Array<{ n: number; cuts: Array<number | string> | null }>>`
    SELECT COUNT(*)::int AS n,
           percentile_disc(${quantiles}::float8[]) WITHIN GROUP (ORDER BY discovery_activity_score) AS cuts
    FROM servers
    WHERE discovery_listed = true AND discovery_activity_score > 0`;
  const n = rows[0]?.n ?? 0;
  const cuts = rows[0]?.cuts;
  if (n < DISCOVERY_TIER_MIN_POPULATION || !cuts || cuts.length !== DISCOVERY_TIERS.length) {
    return { computedAt: now.toISOString(), population: n, thresholds: null };
  }
  const thresholds = Object.fromEntries(DISCOVERY_TIERS.map((tier, i) => [tier, Number(cuts[i]) + 1])) as Record<DiscoveryTier, number>;
  return { computedAt: now.toISOString(), population: n, thresholds };
}

/** Compute and store the cuts; the stats cycle calls this. */
export async function refreshTierThresholds(): Promise<DiscoveryTierThresholds> {
  const cuts = await computeTierThresholds();
  await getRedis().set(DISCOVERY_TIERS_KEY, JSON.stringify(cuts), { EX: DISCOVERY_TIERS_TTL_S });
  return cuts;
}

function isThresholds(v: unknown): v is DiscoveryTierThresholds {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<DiscoveryTierThresholds>;
  if (typeof t.computedAt !== 'string' || typeof t.population !== 'number') return false;
  if (t.thresholds === null) return true;
  if (!t.thresholds || typeof t.thresholds !== 'object') return false;
  return DISCOVERY_TIERS.every((tier) => typeof (t.thresholds as Record<string, unknown>)[tier] === 'number');
}

/**
 * The current cuts, or null when none were computed yet. Fail-open: a Redis
 * error means a page without badges, never a page that fails.
 */
export async function getTierThresholds(): Promise<DiscoveryTierThresholds | null> {
  try {
    const raw = await getRedis().get(DISCOVERY_TIERS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isThresholds(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[Discovery] Tier thresholds unavailable (no badges this request):', err instanceof Error ? err.message : err);
    return null;
  }
}

/** The highest tier whose starting score the score reaches. */
export function tierOf(score: number, cuts: DiscoveryTierThresholds | null): DiscoveryTier | null {
  if (!cuts?.thresholds || score <= 0) return null;
  let best: DiscoveryTier | null = null;
  for (const tier of DISCOVERY_TIERS) {
    if (score >= cuts.thresholds[tier]) best = tier;
  }
  return best;
}

/** The next tier up and the score it starts at; null at the top, or without cuts. */
export function nextTierFor(score: number, cuts: DiscoveryTierThresholds | null): { tier: DiscoveryTier; score: number } | null {
  if (!cuts?.thresholds) return null;
  for (const tier of DISCOVERY_TIERS) {
    if (score < cuts.thresholds[tier]) return { tier, score: cuts.thresholds[tier] };
  }
  return null;
}
