import { prisma } from './prisma';
import { REPORT_RETENTION_MONTHS } from '@voxium/shared';
import { msUntilDailySlot, withClusterLock, wasSkipped, type ClusterLockSkip } from './dailySchedule';
import { logAuditEvent } from './auditLog';
import { describeCaughtError, loggableError } from './loggableError';

// Retention of the moderation reports an account deletion kept (#48): a
// report filed by or about an account that was deleted is kept, without its
// link to the account, for REPORT_RETENTION_MONTHS after that deletion (the
// earlier one when both of its accounts are gone), then deleted here.
//
// It runs whatever the flag account_deletion_keeps_reports says: a report
// kept while the flag was on still expires after the flag is switched off.
// A report whose accounts both live carries no deletion mark and is never
// deleted here.
//
// THE CLOCK. The marks are written on the database's clock in UTC
// (utils/reportSettlement.ts), so they are compared on it too, and the
// months are added by PostgreSQL (`make_interval(months => …)`: a calendar
// month, the 29th of February plus twelve months being the 28th), never as
// a number of days. A report expires at its mark plus the period (the
// earlier mark: either one alone is enough), the instant the moderation
// queue shows it will be deleted (reportExpiries, below, the same
// arithmetic done by the same database).
//
// THE BATCHES. In id order, REPORT_RETENTION_BATCH at a time, each one
// statement of its own (a transaction that commits on its own). Each takes
// its rows FOR UPDATE SKIP LOCKED: a report another transaction holds (a
// resolution, a dismissal, an account deletion settling it) is left for the
// next night instead of waited for, so the job waits on no row and cannot
// be part of a deadlock. Deleting a report fires nothing (no table has a key
// to `reports`). A batch that fails ends the run, the batches before it stay
// committed, and the next night goes on from what is left.
//
// No index serves the predicate (a mark plus an interval): the job reads the
// table once a night, and the table holds moderation reports only. An index
// on the marks would be a partial one (they are NULL on almost every row),
// which this schema cannot declare (see the note on Report in
// schema.prisma), so it would be one more index `prisma migrate dev` reads
// as drift.

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

// After the orphan sweep (05:00), so the nightly jobs never contend for the
// database
const RETENTION_HOUR = 5;
const RETENTION_MINUTE = 30;

// Every node fires this slot. The lock is HELD for 20 hours after a run
// (withClusterLock's holdOnSuccess), so a peer whose timer fires a moment
// later, or an hour later in another timezone, finds it taken; 20 h < 24 h,
// so tomorrow's slot claims it again.
export const REPORT_RETENTION_LOCK_KEY = 'lock:reportretention';
export const REPORT_RETENTION_LOCK_TTL_SECONDS = 20 * 60 * 60;
// Redis unreachable at the slot: nobody knows whether the run happened, so
// it is tried again soon (a peer that did run holds the lock).
export const REPORT_RETENTION_RETRY_MS = 15 * 60 * 1000;
/** Reports deleted per statement. */
export const REPORT_RETENTION_BATCH = 1000;
/** Batches per run: a bound far above any real backlog (one million reports). */
export const REPORT_RETENTION_MAX_BATCHES = 1000;

export interface ReportRetentionResult {
  /** Reports deleted by this run. */
  deleted: number;
  /** The batch that failed and ended the run, by the error's name and code only. */
  failedBatch: { name: string; code: string | null } | null;
}

export function startReportRetention(): void {
  if (!stopped) return;
  stopped = false;
  scheduleNext(false);
}

export function stopReportRetention(): void {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext(afterRun: boolean): void {
  if (stopped) return;
  const delay = msUntilDailySlot(RETENTION_HOUR, RETENTION_MINUTE, afterRun);
  console.log(`[Reports] Next report retention run in ${Math.round(delay / 60000)} minutes`);
  timeoutId = setTimeout(runScheduled, delay);
  // Never hold the process open just for a retention timer
  timeoutId.unref?.();
}

function scheduleRetry(): void {
  if (stopped) return;
  console.error(`[Reports] Redis unavailable at the report retention slot — retrying in ${REPORT_RETENTION_RETRY_MS / 60000} minutes`);
  timeoutId = setTimeout(runScheduled, REPORT_RETENTION_RETRY_MS);
  timeoutId.unref?.();
}

async function runScheduled(): Promise<void> {
  if (stopped) return;
  let retrySoon = false;
  try {
    const result = await runReportRetention();
    retrySoon = wasSkipped(result) && result.skipped === 'unavailable';
  } catch (err) {
    // The run logs its own failures; this only catches the lock plumbing
    console.error('[Reports] Report retention run failed:', describeCaughtError(err));
  } finally {
    if (retrySoon) scheduleRetry(); else scheduleNext(true);
  }
}

/**
 * One run under the cluster lock. Resolves `{ skipped: 'locked' }` when
 * another node holds it (that node's run is the night's) and
 * `{ skipped: 'unavailable' }` when Redis could not be reached (fail closed;
 * the scheduler retries soon). Exported for tests.
 */
export async function runReportRetention(): Promise<ReportRetentionResult | ClusterLockSkip> {
  return withClusterLock(
    { key: REPORT_RETENTION_LOCK_KEY, ttlSeconds: REPORT_RETENTION_LOCK_TTL_SECONDS, tag: '[Reports]', holdOnSuccess: true },
    deleteExpiredReports,
  );
}

/**
 * The deletion itself, batch after batch, until a batch finds fewer due
 * reports than it could take (or the bound). A run that deleted something
 * writes one audit row (no actor: the system did it), with the count and,
 * when a batch failed, that batch's error by name and code.
 */
export async function deleteExpiredReports(): Promise<ReportRetentionResult> {
  let deleted = 0;
  let failedBatch: ReportRetentionResult['failedBatch'] = null;
  for (let batch = 0; batch < REPORT_RETENTION_MAX_BATCHES; batch++) {
    let taken: number;
    try {
      taken = (await prisma.$queryRaw<Array<{ id: string }>>`
        WITH due AS (
          SELECT id FROM reports
          WHERE (reporter_deleted_at IS NOT NULL
                 AND reporter_deleted_at + make_interval(months => ${REPORT_RETENTION_MONTHS}) <= (now() AT TIME ZONE 'UTC'))
             OR (reported_user_deleted_at IS NOT NULL
                 AND reported_user_deleted_at + make_interval(months => ${REPORT_RETENTION_MONTHS}) <= (now() AT TIME ZONE 'UTC'))
          ORDER BY id
          LIMIT ${REPORT_RETENTION_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM reports r USING due WHERE r.id = due.id
        RETURNING r.id`).length;
    } catch (err) {
      const { name, code } = loggableError(err);
      failedBatch = { name: name ?? 'Error', code: code ?? null };
      console.error(`[Reports] A batch of the report retention failed; ${deleted} report(s) deleted before it stay deleted, the rest wait for the next run:`, describeCaughtError(err));
      break;
    }
    deleted += taken;
    if (taken < REPORT_RETENTION_BATCH) break;
  }

  if (deleted > 0) {
    console.log(`[Reports] Deleted ${deleted} report(s) kept more than ${REPORT_RETENTION_MONTHS} month(s) after the deletion of an account they concern`);
    logAuditEvent({
      actorId: null,
      action: 'report.retention_sweep',
      targetType: 'report',
      metadata: {
        trigger: 'scheduled',
        deletedReports: deleted,
        retentionMonths: REPORT_RETENTION_MONTHS,
        ...(failedBatch && { failedBatch }),
      },
    });
  }
  return { deleted, failedBatch };
}

/** The deletion marks of one report, as a reader has them. */
export interface ReportDeletionMarks {
  id: string;
  reporterDeletedAt: Date | null;
  reportedUserDeletedAt: Date | null;
}

/**
 * When each of `reports` will be deleted: the earlier of its deletion marks
 * plus REPORT_RETENTION_MONTHS, the arithmetic done by PostgreSQL, as the job
 * does it, on the marks the caller read (so a report's marks and its date
 * never come from two reads). A report with no mark has no date and is left
 * out; no statement is sent when none has one.
 */
export async function reportExpiries(reports: ReportDeletionMarks[]): Promise<Map<string, Date>> {
  const marked = reports.flatMap((r) => {
    const marks = [r.reporterDeletedAt, r.reportedUserDeletedAt].filter((d): d is Date => d instanceof Date);
    if (marks.length === 0) return [];
    const earliest = marks.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    return [{ id: r.id, mark: earliest.toISOString() }];
  });
  if (marked.length === 0) return new Map();
  // The marks are timestamps without a zone holding UTC: Prisma reads them
  // as UTC instants, and their ISO form cast back to `timestamp(3)` is the
  // stored value (the zone suffix is ignored by that cast)
  const rows = await prisma.$queryRaw<Array<{ id: string; expiresAt: Date }>>`
    SELECT m.id, m.mark::timestamp(3) + make_interval(months => ${REPORT_RETENTION_MONTHS}) AS "expiresAt"
    FROM unnest(${marked.map((m) => m.id)}::text[], ${marked.map((m) => m.mark)}::text[]) AS m(id, mark)`;
  return new Map(rows.map((r) => [r.id, r.expiresAt]));
}
