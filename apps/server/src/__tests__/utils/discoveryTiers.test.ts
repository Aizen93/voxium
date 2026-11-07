import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DISCOVERY_TIER_MIN_POPULATION } from '@voxium/shared';

// Activity badges: the cuts are percentiles of the Active score over listed
// spaces with any activity, stored in Redis by the stats cycle and read by
// the directory. A tie at a cut is in; below the minimum population there
// are no badges at all.

const prismaMock = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../utils/redis', () => ({ getRedis: () => redis }));

import {
  computeTierThresholds, refreshTierThresholds, getTierThresholds, tierOf, nextTierFor,
  DISCOVERY_TIERS_KEY, DISCOVERY_TIERS_TTL_S,
} from '../../utils/discoveryTiers';

const CUTS = {
  computedAt: '2026-10-11T12:00:00.000Z', population: 50,
  thresholds: { bronze: 10, silver: 20, gold: 40, platinum: 60, diamond: 80 },
};

function sqlOf(call: unknown[]): string {
  const strings = call[0] as readonly string[];
  return strings.join('?');
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.set.mockResolvedValue('OK');
});

describe('computeTierThresholds', () => {
  it('asks for the five percentile cuts in ONE statement over listed, active spaces', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ n: 50, cuts: [10, 20, 40, 60, 80] }]);
    const now = new Date('2026-10-11T12:00:00Z');

    // the tier starts ONE ABOVE the boundary score: strictly the top fraction, never more
    await expect(computeTierThresholds(now)).resolves.toEqual({ ...CUTS, thresholds: { bronze: 11, silver: 21, gold: 41, platinum: 61, diamond: 81 } });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(prismaMock.$queryRaw.mock.calls[0]);
    expect(sql).toContain('percentile_disc(');
    expect(sql).toContain('WITHIN GROUP (ORDER BY discovery_activity_score)');
    expect(sql).toContain('WHERE discovery_listed = true AND discovery_activity_score > 0');
    // bronze = top 50% → the 0.5 quantile … diamond = top 1% → the 0.99 quantile
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toEqual([0.5, 0.75, 0.9, 0.97, 0.99]);
  });

  it('answers no cuts below the minimum population, and when the statement has nothing to say', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ n: DISCOVERY_TIER_MIN_POPULATION - 1, cuts: [1, 1, 2, 2, 3] }]);
    await expect(computeTierThresholds()).resolves.toMatchObject({ population: DISCOVERY_TIER_MIN_POPULATION - 1, thresholds: null });
    prismaMock.$queryRaw.mockResolvedValue([{ n: 0, cuts: null }]);
    await expect(computeTierThresholds()).resolves.toMatchObject({ population: 0, thresholds: null });
    prismaMock.$queryRaw.mockResolvedValue([]);
    await expect(computeTierThresholds()).resolves.toMatchObject({ population: 0, thresholds: null });
  });

  it('coerces cuts the driver hands back as strings', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ n: 12, cuts: ['3', '5', '9', '12', '20'] }]);
    await expect(computeTierThresholds()).resolves.toMatchObject({ thresholds: { bronze: 4, silver: 6, gold: 10, platinum: 13, diamond: 21 } });
  });
});

describe('refreshTierThresholds / getTierThresholds', () => {
  it('stores the cuts under the tiers key with a day of TTL, and reads them back', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ n: 50, cuts: [10, 20, 40, 60, 80] }]);
    const stored = await refreshTierThresholds();
    expect(redis.set).toHaveBeenCalledWith(DISCOVERY_TIERS_KEY, JSON.stringify(stored), { EX: DISCOVERY_TIERS_TTL_S });

    redis.get.mockResolvedValue(JSON.stringify(CUTS));
    await expect(getTierThresholds()).resolves.toEqual(CUTS);
    expect(redis.get).toHaveBeenCalledWith(DISCOVERY_TIERS_KEY);
  });

  it('is fail-open: no key, a corrupt value or a Redis error all mean "no badges", never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redis.get.mockResolvedValue(null);
    await expect(getTierThresholds()).resolves.toBeNull();
    redis.get.mockResolvedValue('{"computedAt":1}');
    await expect(getTierThresholds()).resolves.toBeNull();
    redis.get.mockResolvedValue(JSON.stringify({ ...CUTS, thresholds: { bronze: 'x' } }));
    await expect(getTierThresholds()).resolves.toBeNull();
    redis.get.mockResolvedValue('not json');
    await expect(getTierThresholds()).resolves.toBeNull();
    redis.get.mockRejectedValue(new Error('redis down'));
    await expect(getTierThresholds()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    // a stored "no cuts" answer is itself valid
    redis.get.mockResolvedValue(JSON.stringify({ ...CUTS, thresholds: null }));
    await expect(getTierThresholds()).resolves.toEqual({ ...CUTS, thresholds: null });
    warn.mockRestore();
  });
});

describe('tierOf / nextTierFor', () => {
  it('a flat top awards nobody: with every score tied at the 99th percentile, the boundary + 1 is out of reach', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ n: 1000, cuts: [1, 2, 2, 4, 4] }]);
    const cuts = await computeTierThresholds();
    expect(cuts.thresholds).toEqual({ bronze: 2, silver: 3, gold: 3, platinum: 5, diamond: 5 });
    expect(tierOf(4, cuts)).toBe('gold');
    expect(tierOf(5, cuts)).toBe('diamond');
  });

  it('gives the highest starting score the score reaches, and nothing below Bronze or at zero', () => {
    expect(tierOf(0, CUTS)).toBeNull();
    expect(tierOf(9, CUTS)).toBeNull();
    expect(tierOf(10, CUTS)).toBe('bronze');
    expect(tierOf(39, CUTS)).toBe('silver');
    expect(tierOf(40, CUTS)).toBe('gold');
    expect(tierOf(79, CUTS)).toBe('platinum');
    expect(tierOf(80, CUTS)).toBe('diamond');
    expect(tierOf(5000, CUTS)).toBe('diamond');
    expect(tierOf(5000, null)).toBeNull();
    expect(tierOf(5000, { ...CUTS, thresholds: null })).toBeNull();
  });

  it('names the next tier and the score it starts at; nothing at the top or without cuts', () => {
    expect(nextTierFor(0, CUTS)).toEqual({ tier: 'bronze', score: 10 });
    expect(nextTierFor(10, CUTS)).toEqual({ tier: 'silver', score: 20 });
    expect(nextTierFor(79, CUTS)).toEqual({ tier: 'diamond', score: 80 });
    expect(nextTierFor(80, CUTS)).toBeNull();
    expect(nextTierFor(80, null)).toBeNull();
  });

  it('two tiers can share a starting score: the higher one is the answer', () => {
    const flat = { ...CUTS, thresholds: { bronze: 2, silver: 2, gold: 5, platinum: 5, diamond: 9 } };
    expect(tierOf(2, flat)).toBe('silver');
    expect(tierOf(5, flat)).toBe('platinum');
    expect(nextTierFor(2, flat)).toEqual({ tier: 'gold', score: 5 });
  });
});
