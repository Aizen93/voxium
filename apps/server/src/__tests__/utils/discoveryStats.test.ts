import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DISCOVERY_SCORE_WEIGHTS } from '@voxium/shared';

// The directory's activity figures on a rolling daily cycle: budgeted,
// bounded batches under a cluster lock, plus the housekeeping that rides the
// same timer.

const prismaMock = vi.hoisted(() => ({
  server: { findMany: vi.fn(), count: vi.fn() },
  serverJoinRequest: { deleteMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const redis = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), eval: vi.fn() }));
vi.mock('../../utils/redis', () => ({ NODE_ID: () => 'node-under-test', getRedis: () => redis }));

import {
  runDiscoveryStatsCycle, startDiscoveryStats, stopDiscoveryStats, pickStaleServerIds, recomputeServerStats,
  sweepJoinRequests, correctDrift, housekeepingDue, countStatsBacklog,
  DISCOVERY_STATS_LOCK_KEY, DISCOVERY_STATS_LOCK_TTL_SECONDS, DISCOVERY_STATS_RETRY_MS, DISCOVERY_STATS_INTERVAL_MS,
  DISCOVERY_STATS_BATCH, DISCOVERY_STATS_RUN_MAX, DISCOVERY_STATS_RUN_BUDGET_MS, DISCOVERY_STATS_STALE_MS,
  DISCOVERY_HOUSEKEEPING_HOURLY_KEY, DISCOVERY_HOUSEKEEPING_DAILY_KEY, DISCOVERY_HOUSEKEEPING_HOUR,
} from '../../utils/discoveryStats';

const ids = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  redis.set.mockResolvedValue('OK');
  redis.get.mockResolvedValue(null);
  redis.eval.mockResolvedValue(1);
  prismaMock.server.findMany.mockResolvedValue([]);
  prismaMock.server.count.mockResolvedValue(0);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.$executeRaw.mockResolvedValue(0);
  prismaMock.serverJoinRequest.deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  stopDiscoveryStats();
  vi.useRealTimers();
});

describe('pickStaleServerIds — NULL figures first, then oldest, two index range scans', () => {
  it('takes never-refreshed servers first and stops there when they fill the batch', async () => {
    prismaMock.server.findMany.mockResolvedValueOnce(ids(500));
    const picked = await pickStaleServerIds(500);
    expect(picked).toHaveLength(500);
    expect(prismaMock.server.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith({
      where: { discoveryListed: true, statsRefreshedAt: null }, orderBy: { statsRefreshedAt: 'asc' }, select: { id: true }, take: 500,
    });
  });

  it('fills the remainder with the oldest refreshed servers past the 24 h cutoff, ascending', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    prismaMock.server.findMany.mockResolvedValueOnce(ids(2, 'n')).mockResolvedValueOnce(ids(3, 'o'));
    const picked = await pickStaleServerIds(10, now);
    expect(picked).toEqual(['n0', 'n1', 'o0', 'o1', 'o2']);
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(2, {
      where: { discoveryListed: true, statsRefreshedAt: { lt: new Date(now.getTime() - DISCOVERY_STATS_STALE_MS) } },
      orderBy: { statsRefreshedAt: 'asc' },
      select: { id: true },
      take: 8,
    });
  });
});

describe('recomputeServerStats — three statements, every one bounded by the id list', () => {
  it('reads weekly messages and online members for the batch, writes back with the shared weights', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ serverId: 'b', n: 7 }])            // weekly
      .mockResolvedValueOnce([{ serverId: 'a', n: 2 }, { serverId: 'b', n: 1 }]); // online

    await recomputeServerStats(['a', 'b', 'c']);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    const weeklySql = sqlOf(prismaMock.$queryRaw.mock.calls[0]);
    expect(weeklySql).toContain('FROM channels c JOIN messages m ON m.channel_id = c.id');
    expect(weeklySql).toContain("c.server_id = ANY(?::text[]) AND m.created_at >= now() - interval '7 days'");
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toEqual(['a', 'b', 'c']);
    const onlineSql = sqlOf(prismaMock.$queryRaw.mock.calls[1]);
    expect(onlineSql).toContain('FROM server_members sm JOIN users u ON u.id = sm.user_id');
    expect(onlineSql).toContain("sm.server_id = ANY(?::text[]) AND u.status = 'online'");

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prismaMock.$executeRaw.mock.calls[0];
    const sql = sqlOf([strings]);
    expect(sql).toContain('discovery_activity_score = v.online * ?::int + v.weekly * ?::int + s.member_count * ?::int');
    expect(sql).toContain('FROM unnest(?::text[], ?::int[], ?::int[]) AS v(id, weekly, online) WHERE s.id = v.id');
    // weights from the ONE shared constant; arrays aligned to ids with 0 for servers absent from the aggregates
    expect(values).toEqual([DISCOVERY_SCORE_WEIGHTS.online, DISCOVERY_SCORE_WEIGHTS.messages, DISCOVERY_SCORE_WEIGHTS.members, ['a', 'b', 'c'], [0, 7, 0], [2, 1, 0]]);
  });

  it('is a no-op for an empty batch', async () => {
    await recomputeServerStats([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('the cycle', () => {
  it('claims the lock with holdOnSuccess (TTL 290 s), refreshes batches of 500 until nothing is stale, logs the backlog', async () => {
    prismaMock.server.findMany
      .mockResolvedValueOnce(ids(500))                                // batch 1: nulls fill it (no second scan)
      .mockResolvedValueOnce(ids(120)).mockResolvedValueOnce(ids(30)) // batch 2: 120 nulls + 30 old
      .mockResolvedValue([]);                                         // batch 3: nothing left → stop
    prismaMock.server.count.mockResolvedValue(4);

    const run = await runDiscoveryStatsCycle();

    expect(redis.set).toHaveBeenCalledWith(DISCOVERY_STATS_LOCK_KEY, expect.stringMatching(/^node-under-test:/), { NX: true, EX: DISCOVERY_STATS_LOCK_TTL_SECONDS });
    expect(run).toMatchObject({ refreshed: 650, batches: 2, backlog: 4 });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    // held on success: no compare-and-delete release
    expect(redis.eval).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('backlog older than 48h: 4'));
    expect(DISCOVERY_STATS_BATCH).toBe(500);
  });

  it('stops at the row cap', async () => {
    prismaMock.server.findMany.mockImplementation(async ({ take }: any) => ids(take));
    const run = await runDiscoveryStatsCycle();
    expect(run?.refreshed).toBe(DISCOVERY_STATS_RUN_MAX);
    expect(run?.batches).toBe(DISCOVERY_STATS_RUN_MAX / DISCOVERY_STATS_BATCH);
  });

  it('stops at the time budget and leaves the rest for the next run', async () => {
    prismaMock.server.findMany.mockImplementation(async ({ take }: any) => ids(take));
    let t = 1_000_000;
    // every Date.now() read advances the clock 12 s: start → check (0) → batch → check (24 s) → batch → check (36 s) stop
    vi.spyOn(Date, 'now').mockImplementation(() => { t += 12_000; return t; });

    const run = await runDiscoveryStatsCycle();
    expect(run?.batches).toBeLessThan(DISCOVERY_STATS_RUN_MAX / DISCOVERY_STATS_BATCH);
    expect(run!.elapsedMs).toBeGreaterThanOrEqual(DISCOVERY_STATS_RUN_BUDGET_MS);
    vi.restoreAllMocks();
  });

  it('another node holds the lock: no reads, no writes, next run in 5 min', async () => {
    redis.set.mockResolvedValue(null);
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    startDiscoveryStats(); // a stopped job never re-arms
    const run = await runDiscoveryStatsCycle();
    expect(run).toBeNull();
    expect(prismaMock.server.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    expect(timeouts).toHaveBeenLastCalledWith(expect.any(Function), DISCOVERY_STATS_INTERVAL_MS);
    timeouts.mockRestore();
  });

  it('Redis unavailable: skipped and retried in 60 s instead of 5 min', async () => {
    redis.set.mockRejectedValue(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    startDiscoveryStats();
    const run = await runDiscoveryStatsCycle();
    expect(run).toBeNull();
    expect(timeouts).toHaveBeenLastCalledWith(expect.any(Function), DISCOVERY_STATS_RETRY_MS);
    error.mockRestore();
    timeouts.mockRestore();
  });

  it('a failing run releases the lock and re-arms', async () => {
    prismaMock.server.findMany.mockRejectedValue(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await runDiscoveryStatsCycle();
    expect(run).toBeNull();
    expect(redis.eval).toHaveBeenCalled(); // compare-and-delete release
    expect(error).toHaveBeenCalledWith('[Discovery] Stats cycle failed:', 'db gone');
    error.mockRestore();
  });

  it('start arms the first run 60 s after boot; stop clears it', () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    startDiscoveryStats();
    expect(timeouts).toHaveBeenCalledWith(expect.any(Function), 60_000);
    stopDiscoveryStats();
    timeouts.mockRestore();
  });
});

describe('housekeeping on the same timer', () => {
  it('hourly: due when the marker is missing or an hour old; daily: only in the 04:xx slot and not yet today', async () => {
    const inSlot = new Date(2026, 9, 10, DISCOVERY_HOUSEKEEPING_HOUR, 7, 0);
    const outOfSlot = new Date(2026, 9, 10, 13, 7, 0);

    redis.get.mockResolvedValue(null);
    await expect(housekeepingDue(inSlot)).resolves.toEqual({ hourly: true, daily: true });
    await expect(housekeepingDue(outOfSlot)).resolves.toEqual({ hourly: true, daily: false });

    redis.get.mockImplementation(async (key: string) =>
      key === DISCOVERY_HOUSEKEEPING_HOURLY_KEY ? new Date(inSlot.getTime() - 30 * 60 * 1000).toISOString()
      : new Date(inSlot.getTime() - 60 * 60 * 1000).toISOString()); // daily stamped at 03:07 today
    await expect(housekeepingDue(inSlot)).resolves.toEqual({ hourly: false, daily: false });

    redis.get.mockImplementation(async (key: string) =>
      key === DISCOVERY_HOUSEKEEPING_HOURLY_KEY ? new Date(inSlot.getTime() - 61 * 60 * 1000).toISOString()
      : new Date(inSlot.getTime() - 24 * 60 * 60 * 1000).toISOString()); // daily stamped yesterday
    await expect(housekeepingDue(inSlot)).resolves.toEqual({ hourly: true, daily: true });
  });

  it('the hourly sweep deletes declined requests older than 7 days and pending ones older than 30', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    prismaMock.serverJoinRequest.deleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
    await expect(sweepJoinRequests(now)).resolves.toEqual({ declined: 2, pending: 1 });
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({
      where: { status: 'declined', decidedAt: { lt: new Date(now.getTime() - 7 * 24 * 3600 * 1000) } },
    });
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({
      where: { status: 'pending', createdAt: { lt: new Date(now.getTime() - 30 * 24 * 3600 * 1000) } },
    });
  });

  it('the daily correction recounts member_count and recomputes discovery_listed, writing only rows that disagree', async () => {
    prismaMock.$executeRaw.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    await expect(correctDrift()).resolves.toEqual({ memberCounts: 3, listed: 1 });
    const counts = sqlOf(prismaMock.$executeRaw.mock.calls[0]);
    expect(counts).toContain('UPDATE servers s SET member_count = c.n');
    expect(counts).toContain('GROUP BY server_id');
    expect(counts).toContain('s.member_count <> c.n');
    const listed = sqlOf(prismaMock.$executeRaw.mock.calls[1]);
    expect(listed).toContain('s.discoverable AND NOT s.invites_locked AND s.discovery_blocked_at IS NULL AND u.banned_at IS NULL');
    expect(listed).toContain('IS DISTINCT FROM');
  });

  it('the cycle runs what is due and stamps the markers; nothing when nothing is due', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 10, DISCOVERY_HOUSEKEEPING_HOUR, 30, 0), toFake: ['Date'] });
    redis.get.mockResolvedValue(null);

    const run = await runDiscoveryStatsCycle();
    expect(run).toMatchObject({ hourlyHousekeeping: true, dailyHousekeeping: true });
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith(DISCOVERY_HOUSEKEEPING_HOURLY_KEY, expect.any(String));
    expect(redis.set).toHaveBeenCalledWith(DISCOVERY_HOUSEKEEPING_DAILY_KEY, expect.any(String));

    vi.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.get.mockResolvedValue(new Date().toISOString());
    const quiet = await runDiscoveryStatsCycle();
    expect(quiet).toMatchObject({ hourlyHousekeeping: false, dailyHousekeeping: false });
    expect(prismaMock.serverJoinRequest.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it('countStatsBacklog counts listed servers with missing or 48 h-old figures', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    prismaMock.server.count.mockResolvedValue(9);
    await expect(countStatsBacklog(now)).resolves.toBe(9);
    expect(prismaMock.server.count).toHaveBeenCalledWith({
      where: { discoveryListed: true, OR: [{ statsRefreshedAt: null }, { statsRefreshedAt: { lt: new Date(now.getTime() - 48 * 3600 * 1000) } }] },
    });
  });
});
