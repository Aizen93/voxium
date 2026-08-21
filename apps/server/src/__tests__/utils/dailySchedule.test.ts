import { describe, it, expect } from 'vitest';
import { msUntilDailySlot, SAME_SLOT_MARGIN_MS } from '../../utils/dailySchedule';

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
