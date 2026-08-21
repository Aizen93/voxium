// Shared slot maths for the nightly jobs (attachment cleanup 04:00, registration
// hygiene 04:30, orphan sweep 05:00).
//
// Each of them used to carry its own copy of "ms until HH:MM, tomorrow if that
// is already past", and each inherited the same bug from it.

/**
 * How close to the slot counts as "this is the run we just did".
 *
 * `setTimeout` is not exact, and over a ~24h delay it can fire EARLY — measured
 * at 272ms early on a real run. The naive `next <= now` test then still sees
 * today's slot in the future and schedules a second run milliseconds later.
 * That is not theoretical: the registration sweep deleted 112 accounts at
 * 04:29:59.728, ran again at 04:30:00.002 deleting nothing, and the empty run
 * overwrote `hygiene:last-run` — so the panel built to report what the sweep
 * did reported 0 for the night it did the work.
 *
 * A minute is far larger than any timer skew and far smaller than the interval,
 * so it cannot swallow a real slot.
 */
export const SAME_SLOT_MARGIN_MS = 60_000;

/**
 * Milliseconds until the next `hour:minute` in local time.
 *
 * `afterRun` is the important argument. Pass it when re-scheduling from inside
 * a job that has just finished: it treats a slot within `SAME_SLOT_MARGIN_MS`
 * as already served and skips to tomorrow, which is what stops the double fire
 * above. At startup pass false (the default) — there the slot genuinely has not
 * run yet, and applying the margin would silently skip a job for a node that
 * happened to boot in the minute before it.
 */
export function msUntilDailySlot(
  hour: number,
  minute: number,
  afterRun = false,
  now: Date = new Date(),
): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime() + (afterRun ? SAME_SLOT_MARGIN_MS : 0)) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Release a `SET NX EX` lock only if this caller still owns it.
 *
 * A plain `DEL` in a `finally` releases whatever is there, including a lock a
 * DIFFERENT node acquired after the TTL expired mid-run — at which point the
 * mutual exclusion the lock exists for is simply gone, and a third caller can
 * claim it while the second is still working. Both nightly sweeps write
 * `NODE_ID()` as the value precisely so ownership can be checked; they just
 * were not checking it.
 *
 * Compare-and-delete in Lua so the read and the delete cannot be interleaved.
 */
export async function releaseLockIfOwned(
  redis: { eval: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown> },
  key: string,
  owner: string,
): Promise<boolean> {
  const released = await redis.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
     return 0`,
    { keys: [key], arguments: [owner] },
  );
  return released === 1;
}
