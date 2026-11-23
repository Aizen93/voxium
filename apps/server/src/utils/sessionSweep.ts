import { prisma } from './prisma';
import { withClusterLock, wasSkipped } from './dailySchedule';
import { disconnectSessionRooms } from './sessionRevocation';
import {
  countSweepableSessions, sampleExpiredSessions, sampleOutdatedSessions, deleteSweepableSessions,
  sampleExpiredLegacyRedemptions, deleteExpiredLegacyRedemptions,
  SWEEP_BATCH_SIZE,
} from './sessionStore';
import { describeCaughtError } from './loggableError';

// Retention of the sign-in sessions (services/sessionService.ts), never their
// authority: every refusal is decided by the renewal itself, on the
// database's clock, whether or not this has run. It deletes, in batches,
// what the renewal already refuses:
//  - sessions whose expiry passed more than SWEEP_MARGIN_SECONDS ago (the
//    margin guards against a clock mistake in the sweep itself);
//  - sessions below their account's token version (a password change or
//    reset, a ban);
//  - redemption records of refresh tokens issued before sessions, with the
//    same margin past the token's own expiry (deleted early, a token signed
//    out with would become upgradeable again).
// After each batch of sessions, the sockets still open on them are
// disconnected through their `session:{sid}` rooms (best effort).
//
// THE GUARDS. Before anything is deleted, samples of what each predicate
// picks are checked by a path independent of that predicate; one that
// disagrees refuses the WHOLE run (sessions and redemption records), with an
// error line naming the kind and the counts, never an id:
//  - expired sessions, the candidates nearest the boundary: each must be
//    past its expiry on this node's own clock. Guards against a comparison
//    that reads the time wrong (a time zone, a cast, a clock): rows still in
//    use would be deleted, and their users signed out at the next renewal.
//  - outdated sessions, the candidates nearest to their account's version
//    AND, in every run, as many drawn at random over all of them: read again
//    through the typed client and compared in JavaScript, each must be
//    strictly below its account's version. Guards against a comparison that
//    picks live rows: one that also takes equal versions shows among the
//    nearest; one joined to the wrong account picks live rows anywhere among
//    the candidates, a minority of them perhaps, which only the random
//    sample can meet. It costs about what the count costs: one more pass
//    over the sessions joined to their accounts, with a sort that keeps only
//    the rows it returns (about 35 ms for 150,000 candidates among 300,000
//    sessions on PostgreSQL 16, the count about 25), once a run.
//  - redemption records, the candidates nearest the boundary: each must be
//    past its token's expiry on this node's clock, which is what the nodes'
//    token checks use: deleted while a node still accepts the token, a
//    record would let a token signed out with be upgraded again.
//  When more than SESSION_SWEEP_MAX_FRACTION of all sessions (and more than
//  SESSION_SWEEP_FRACTION_FLOOR) are due, which is expected after an
//  instance was offline for a while, a wave of bans or sweeps that did not
//  run, the run says so in ONE warning with the counts and ALSO checks a
//  sample of the expired sessions drawn over all their candidates. The
//  proportion alone refuses nothing.
//
// Why none of them refuses for ever on correct data: a row past its expiry
// by the margin on the database's clock is past it on any node clock within
// that margin of the database's; no writer lifts a row back (a renewal and
// a re-key only touch a row that has not expired, and a re-key only one at
// its account's version, which is never below it); a row deleted between a
// sample and its check is no disagreement. A refusal therefore means a wrong
// comparison or a node clock more than the margin away from the
// database's, and repeats at every run until that is fixed; nothing is
// refused to a user meanwhile: the renewal decides on its own.

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
/**
 * The first run, a few minutes after start: an instance restarted daily
 * still sweeps, and the lock (held for its TTL after a success) keeps
 * restarts from sweeping more often than the interval. The jitter spreads
 * the nodes of a cluster started together.
 */
export const SESSION_SWEEP_FIRST_DELAY_MS = 5 * 60 * 1000;
export const SESSION_SWEEP_FIRST_JITTER_MS = 5 * 60 * 1000;

// Held for 5 h after a successful run (holdOnSuccess): every node's timer
// fires on its own boot clock, and the cluster sweeps once per >= 5 h.
export const SESSION_SWEEP_LOCK_KEY = 'lock:sessionsweep';
export const SESSION_SWEEP_LOCK_TTL_SECONDS = 5 * 60 * 60;
// Redis unreachable at the interval: retry soon, not in 6 h.
export const SESSION_SWEEP_RETRY_MS = 15 * 60 * 1000;

export const SESSION_SWEEP_MAX_FRACTION = 0.5;
export const SESSION_SWEEP_FRACTION_FLOOR = 1000;
/**
 * Candidates of each kind checked before a run deletes anything, the nearest
 * the boundary; and as many again drawn at random: in every run for the
 * version check, when the due share is large for the expiry check.
 */
export const SESSION_SWEEP_SAMPLE_SIZE = 100;
/** Batches per table per run: a bound, far above any real backlog (one million rows). */
export const SESSION_SWEEP_MAX_BATCHES = 200;

export type SweepMismatch = 'expiry' | 'version' | 'redemption-expiry';

export interface SessionSweepResult {
  sessions: number;
  redemptions: number;
  /** A sample disagreed with its predicate: nothing was deleted. */
  refused?: 'sample-mismatch';
  /** Which check disagreed, when refused. */
  mismatch?: SweepMismatch;
}

/** The delay before the first run: SESSION_SWEEP_FIRST_DELAY_MS plus up to SESSION_SWEEP_FIRST_JITTER_MS. */
export function firstSweepDelayMs(random: () => number = Math.random): number {
  return SESSION_SWEEP_FIRST_DELAY_MS + Math.floor(random() * SESSION_SWEEP_FIRST_JITTER_MS);
}

export function startSessionSweep(): void {
  if (!stopped) return;
  stopped = false;
  scheduleNext(firstSweepDelayMs());
}

export function stopSessionSweep(): void {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext(delay: number): void {
  if (stopped) return;
  timeoutId = setTimeout(runSessionSweep, delay);
  // Never hold the process open just for a cleanup timer
  timeoutId.unref?.();
}

/** The run under the cluster lock, or null when another node holds it or the run failed. Always re-arms the timer. */
export async function runSessionSweep(): Promise<SessionSweepResult | null> {
  let nextDelay = SWEEP_INTERVAL_MS;
  try {
    const result = await withClusterLock(
      { key: SESSION_SWEEP_LOCK_KEY, ttlSeconds: SESSION_SWEEP_LOCK_TTL_SECONDS, tag: '[Sessions]', holdOnSuccess: true },
      () => sweepSessions(),
    );
    if (wasSkipped(result)) {
      if (result.skipped === 'unavailable') nextDelay = SESSION_SWEEP_RETRY_MS;
      return null;
    }
    return result;
  } catch (err) {
    console.error('[Sessions] Session sweep failed:', describeCaughtError(err));
    return null;
  } finally {
    scheduleNext(nextDelay);
  }
}

/** How many of `expiries` (epoch seconds) are NOT past on the clock `nowMs`. */
function notPast(expiries: number[], nowMs: number): number {
  return expiries.filter((exp) => exp * 1000 >= nowMs).length;
}

/**
 * The statements a sweep runs (utils/sessionStore.ts). A parameter so that a
 * run against a real database can be given a statement whose predicate is
 * deliberately wrong, and show the guards refuse it.
 */
export const SWEEP_STATEMENTS = {
  countSweepableSessions,
  sampleExpiredSessions,
  sampleOutdatedSessions,
  deleteSweepableSessions,
  sampleExpiredLegacyRedemptions,
  deleteExpiredLegacyRedemptions,
};
export type SweepStatements = typeof SWEEP_STATEMENTS;

/** How many of the sessions `ids` are NOT strictly below their account's version, by the typed client. */
async function notOutdated(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await prisma.session.findMany({
    where: { id: { in: ids } },
    select: { tokenVersion: true, user: { select: { tokenVersion: true } } },
  });
  // A row gone since the sample is no disagreement
  return rows.filter((r) => !(r.tokenVersion < r.user.tokenVersion)).length;
}

interface Disagreement { kind: SweepMismatch; wrong: number; checked: number }

const MISMATCH_TEXT: Record<SweepMismatch, string> = {
  expiry: "it would delete as expired are not past their expiry on this node's clock",
  version: "it would delete as below their account's version are not, by a separate read",
  'redemption-expiry': "it would delete as expired are not past their token's expiry on this node's clock",
};

/** Every check of the guards, before anything is deleted: the first disagreement, or null. */
async function checkSamples(
  st: SweepStatements,
  counts: { expired: number; outdated: number },
  large: boolean,
): Promise<Disagreement | null> {
  const nowMs = Date.now();
  if (counts.expired > 0) {
    const sample = await st.sampleExpiredSessions(prisma, SESSION_SWEEP_SAMPLE_SIZE);
    if (large) sample.push(...await st.sampleExpiredSessions(prisma, SESSION_SWEEP_SAMPLE_SIZE, true));
    const wrong = notPast(sample, nowMs);
    if (wrong > 0) return { kind: 'expiry', wrong, checked: sample.length };
  }
  if (counts.outdated > 0) {
    // Both samples, whatever the backlog: the nearest alone is complete only
    // against a comparison off by one version, never against a wrong join
    const ids = await st.sampleOutdatedSessions(prisma, SESSION_SWEEP_SAMPLE_SIZE);
    ids.push(...await st.sampleOutdatedSessions(prisma, SESSION_SWEEP_SAMPLE_SIZE, true));
    const unique = [...new Set(ids)];
    const wrong = await notOutdated(unique);
    if (wrong > 0) return { kind: 'version', wrong, checked: unique.length };
  }
  const redemptions = await st.sampleExpiredLegacyRedemptions(prisma, SESSION_SWEEP_SAMPLE_SIZE);
  const wrong = notPast(redemptions, nowMs);
  if (wrong > 0) return { kind: 'redemption-expiry', wrong, checked: redemptions.length };
  return null;
}

/** One sweep: every guard first, then the sessions, then the redemption records. */
export async function sweepSessions(st: SweepStatements = SWEEP_STATEMENTS): Promise<SessionSweepResult> {
  const counts = await st.countSweepableSessions(prisma);
  const large = counts.due > SESSION_SWEEP_FRACTION_FLOOR && counts.due > counts.total * SESSION_SWEEP_MAX_FRACTION;
  if (large) {
    console.warn(
      `[Sessions] Session sweep: ${counts.due} of ${counts.total} sessions are due (${counts.expired} expired, `
      + `${counts.outdated} below their account's version), more than ${SESSION_SWEEP_MAX_FRACTION * 100}%; `
      + 'a sample of each kind spread over all its candidates is checked before they are deleted.',
    );
  }

  const disagreement = await checkSamples(st, counts, large);
  if (disagreement) {
    const what = disagreement.kind === 'redemption-expiry' ? 'redemption records' : 'sessions';
    console.error(
      `[Sessions] Session sweep refused: ${disagreement.wrong} of ${disagreement.checked} sampled ${what} `
      + `${MISMATCH_TEXT[disagreement.kind]}. Nothing was deleted (${counts.due} of ${counts.total} sessions due); `
      + 'the renewal still refuses every expired or outdated session.',
    );
    return { sessions: 0, redemptions: 0, refused: 'sample-mismatch', mismatch: disagreement.kind };
  }

  let sessions = 0;
  if (counts.due > 0) {
    for (let batch = 0; batch < SESSION_SWEEP_MAX_BATCHES; batch++) {
      const deleted = await st.deleteSweepableSessions(prisma);
      sessions += deleted.length;
      // The sockets still open on them, on every node (never throws)
      disconnectSessionRooms(deleted);
      if (deleted.length < SWEEP_BATCH_SIZE) break;
    }
  }

  let redemptions = 0;
  for (let batch = 0; batch < SESSION_SWEEP_MAX_BATCHES; batch++) {
    const deleted = await st.deleteExpiredLegacyRedemptions(prisma);
    redemptions += deleted;
    if (deleted < SWEEP_BATCH_SIZE) break;
  }

  if (sessions > 0 || redemptions > 0) {
    console.log(`[Sessions] Swept ${sessions} ended session(s) and ${redemptions} expired redemption record(s)`);
  }
  return { sessions, redemptions };
}
