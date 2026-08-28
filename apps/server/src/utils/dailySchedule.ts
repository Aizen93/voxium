// Shared slot maths for the nightly jobs (attachment cleanup 04:00, registration
// hygiene 04:30, orphan sweep 05:00).
//
// Each of them used to carry its own copy of "ms until HH:MM, tomorrow if that
// is already past", and each inherited the same bug from it.

import { randomUUID } from 'crypto';
import { NODE_ID, getRedis } from './redis';

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
 * The value to store in a `SET NX EX` lock: unique per ACQUISITION, not per
 * process.
 *
 * `NODE_ID()` alone identified the process, and one process can hold two
 * acquisitions of the same lock: the scheduled sweep and an admin's manual
 * trigger (POST /storage/cleanup-orphans, POST /registration/hygiene) run in
 * the same node, and once a long scan outruns the TTL the manual run's
 * `SET NX` succeeds with the very same value. The scheduled run's `finally`
 * then compared 'A' == 'A' and released the manual run's lock mid-scan, and
 * the operator's retry started a third concurrent full-bucket sweep. The node
 * id stays as a readable prefix for MONITOR and the logs.
 */
export function lockToken(): string {
  return `${NODE_ID()}:${randomUUID()}`;
}

/**
 * Release a `SET NX EX` lock only if this caller still owns it.
 *
 * A plain `DEL` in a `finally` releases whatever is there, including a lock a
 * DIFFERENT acquisition took after the TTL expired mid-run — at which point
 * the mutual exclusion the lock exists for is simply gone, and a third caller
 * can claim it while the second is still working. The value compared is the
 * per-acquisition `lockToken()`, so even a re-acquisition by the SAME process
 * (the manual-trigger case above) is someone else's lock.
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

/**
 * `locked`: a peer holds the lock (or ran this slot already) — the work is
 * being done, or was. `unavailable`: Redis could not be reached — nobody
 * knows whether the work is being done, and the caller should retry soon.
 */
export type ClusterLockSkip = { skipped: 'locked' | 'unavailable' };

/**
 * Run `fn` under a `SET NX EX` cluster lock, or not at all.
 *
 * Production is multi-node: a scheduled job fires on EVERY node at the same
 * slot, and a job that is not leader-locked runs N times — for the attachment
 * cleanup that was N S3 delete passes over the same rows and N report emails
 * a night; for the key-share sweep N identical `deleteMany`s.
 *
 * A mutex alone does not give "once per slot": node A's pass takes 200 ms,
 * node B's timer fires 300 ms later, finds the lock released, and runs the
 * whole thing again — deterministically so when the two containers sit in
 * different timezones and their 04:00 slots are an hour apart. So a slot job
 * passes `holdOnSuccess`: after a successful run the lock is LEFT TO EXPIRE
 * at `ttlSeconds` instead of being released, and `ttlSeconds` is sized as
 * the slot's exclusivity window (shorter than the interval, so the next slot
 * can claim it), not as the run's duration. A failed run releases the lock
 * so the next attempt is not blocked.
 *
 * Fail CLOSED on a Redis error — racing a peer is the bug the lock exists to
 * prevent — but say so at error level and as a distinct result, because a
 * retention job that silently did not run is a job nobody can trust.
 *
 * `registrationHygiene` and `orphanCleanup` carry their own copies of this
 * idiom with run records and audit rows around it; this is the plain form.
 */
export async function withClusterLock<T>(
  opts: { key: string; ttlSeconds: number; tag: string; holdOnSuccess?: boolean },
  fn: () => Promise<T>,
): Promise<T | ClusterLockSkip> {
  const owner = lockToken();
  let claimed: string | null;
  try {
    claimed = await getRedis().set(opts.key, owner, { NX: true, EX: opts.ttlSeconds });
  } catch (err) {
    console.error(`${opts.tag} Could not claim the cluster lock (Redis unavailable) — skipping this run:`, err instanceof Error ? err.message : err);
    return { skipped: 'unavailable' };
  }
  if (claimed === null) {
    console.log(`${opts.tag} Another node holds the lock — skipping this run`);
    return { skipped: 'locked' };
  }
  let succeeded = false;
  try {
    const result = await fn();
    succeeded = true;
    return result;
  } finally {
    if (!(succeeded && opts.holdOnSuccess)) {
      // Only if we still own it: a run that outlives the TTL must not release
      // the lock a peer (or this node's own next run) has since taken.
      await releaseLockIfOwned(getRedis(), opts.key, owner).catch((err) =>
        console.warn(`${opts.tag} Lock release failed (it expires on its own):`, err instanceof Error ? err.message : err));
    }
  }
}

export function wasSkipped(result: unknown): result is ClusterLockSkip {
  if (typeof result !== 'object' || result === null) return false;
  const skipped = (result as { skipped?: unknown }).skipped;
  return skipped === 'locked' || skipped === 'unavailable';
}
