import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisSet = vi.fn();
const redisEval = vi.fn();
vi.mock('../../utils/redis', () => ({
  NODE_ID: () => 'node-under-test',
  getRedis: () => ({ set: redisSet, eval: redisEval }),
}));

import { msUntilDailySlot, SAME_SLOT_MARGIN_MS, withClusterLock, wasSkipped, lockToken } from '../../utils/dailySchedule';

const at = (h: number, m: number, s = 0, ms = 0) => {
  const d = new Date(2026, 7, 21, h, m, s, ms);
  return d;
};

describe('msUntilDailySlot', () => {
  it('counts forward to today\'s slot when it is still ahead', () => {
    expect(msUntilDailySlot(4, 30, false, at(4, 0))).toBe(30 * 60_000);
  });

  it('rolls to tomorrow once the slot has passed', () => {
    // 23.5h from 05:00 to the next 04:30
    expect(msUntilDailySlot(4, 30, false, at(5, 0))).toBe((23 * 60 + 30) * 60_000);
  });

  // The bug this exists for. setTimeout over a ~24h delay fires early — 272ms
  // early on the run that surfaced this — so the job completes a few hundred
  // milliseconds BEFORE its own slot. Re-scheduling with the naive `next <= now`
  // test then finds today's slot still in the future and fires again.
  it('does NOT re-schedule into the slot it just ran, when the timer fired early', () => {
    const finishedEarly = at(4, 29, 59, 728); // the real timestamp from the incident
    const delay = msUntilDailySlot(4, 30, true, finishedEarly);

    // Tomorrow, not the 272ms sliver that produced a second run
    expect(delay).toBeGreaterThan(23 * 60 * 60_000);
    const fires = new Date(finishedEarly.getTime() + delay);
    expect(fires.getDate()).toBe(finishedEarly.getDate() + 1);
    expect(fires.getHours()).toBe(4);
    expect(fires.getMinutes()).toBe(30);
  });

  it('treats anything inside the margin as already served, on either side of the slot', () => {
    for (const offset of [-SAME_SLOT_MARGIN_MS + 1, -1, 0, 1_000, SAME_SLOT_MARGIN_MS - 1]) {
      const now = new Date(at(4, 30).getTime() + offset);
      expect(
        msUntilDailySlot(4, 30, true, now),
        `offset ${offset}ms should roll to tomorrow`,
      ).toBeGreaterThan(23 * 60 * 60_000);
    }
  });

  it('does not apply the margin at startup, so booting just before a slot still runs it', () => {
    // The margin is a re-schedule guard, not a general skip: a node that boots
    // at 04:29:30 must still serve today's 04:30.
    const delay = msUntilDailySlot(4, 30, false, at(4, 29, 30));
    expect(delay).toBe(30_000);
  });
});

// ─── withClusterLock ────────────────────────────────────────────────────────
//
// Production is multi-node and every node fires the same slot. The plain
// lock wrapper the attachment cleanup and key-share sweep use.

describe('withClusterLock', () => {
  const opts = { key: 'lock:test', ttlSeconds: 120, tag: '[Test]' };
  beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue('OK');
    redisEval.mockResolvedValue(1);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('claims with SET NX EX under a per-acquisition token, runs the job, then releases only its own lock', async () => {
    const job = vi.fn().mockResolvedValue({ swept: 3 });
    const result = await withClusterLock(opts, job);

    expect(result).toEqual({ swept: 3 });
    expect(wasSkipped(result)).toBe(false);
    expect(job).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledWith('lock:test', expect.stringMatching(/^node-under-test:[0-9a-f-]{36}$/), { NX: true, EX: 120 });
    const owner = redisSet.mock.calls[0][1];
    // Compare-and-delete in Lua with the SAME token — never a blind DEL
    expect(redisEval).toHaveBeenCalledTimes(1);
    expect(redisEval.mock.calls[0][0]).toMatch(/redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/);
    expect(redisEval.mock.calls[0][1]).toEqual({ keys: ['lock:test'], arguments: [owner] });
  });

  it('skips the run when another node holds the lock (SET NX returned null)', async () => {
    redisSet.mockResolvedValue(null);
    const job = vi.fn();
    const result = await withClusterLock(opts, job);
    expect(result).toEqual({ skipped: 'locked' });
    expect(wasSkipped(result)).toBe(true);
    expect(job).not.toHaveBeenCalled();
    expect(redisEval).not.toHaveBeenCalled(); // nothing to release
  });

  it('fails CLOSED on a Redis error while claiming: skips, does not run, does not throw', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    const job = vi.fn();
    await expect(withClusterLock(opts, job)).resolves.toEqual({ skipped: 'locked' });
    expect(job).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[Test] Could not claim'), 'ECONNREFUSED');
  });

  it('releases the lock even when the job throws, and re-throws', async () => {
    const boom = new Error('boom');
    await expect(withClusterLock(opts, async () => { throw boom; })).rejects.toBe(boom);
    expect(redisEval).toHaveBeenCalledTimes(1);
  });

  it('a failed release is logged and swallowed (the TTL expires it)', async () => {
    redisEval.mockRejectedValue(new Error('gone'));
    await expect(withClusterLock(opts, async () => 'done')).resolves.toBe('done');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[Test] Lock release failed'), 'gone');
  });

  it('every acquisition gets its own token, even inside one process', () => {
    expect(lockToken()).not.toBe(lockToken());
  });
});
