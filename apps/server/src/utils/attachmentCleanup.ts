import { prisma } from './prisma';
import { deleteMultipleFromS3 } from './s3';
import { sendCleanupReport, describeEmailError } from './email';
import { LIMITS } from '@voxium/shared';
import { msUntilDailySlot, withClusterLock, wasSkipped, type ClusterLockSkip } from './dailySchedule';

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

const CLEANUP_HOUR = 4; // 4 AM
const BATCH_SIZE = 100;

// Production is multi-node and every node fires this slot. Without the lock
// each of them ran the expiry pass — N S3 delete passes over the same rows
// and N CLEANUP_REPORT_EMAIL reports a night. The lock is HELD for 20 hours
// after a successful pass rather than released (withClusterLock's
// holdOnSuccess): a peer whose timer fires a moment later — or an hour later,
// in another timezone — must find it taken. 20 h < 24 h, so tomorrow's slot
// claims it again.
export const ATTACHMENT_CLEANUP_LOCK_KEY = 'lock:attachmentcleanup';
export const ATTACHMENT_CLEANUP_LOCK_TTL_SECONDS = 20 * 60 * 60;
// When Redis itself is unreachable at the slot, nobody knows whether the pass
// ran. Try again soon rather than in 24 h — a peer that did run holds the lock,
// so the retry is safe; if Redis is still down it says so every 15 minutes.
export const ATTACHMENT_CLEANUP_RETRY_MS = 15 * 60 * 1000;

export interface AttachmentCleanupResult {
  filesExpired: number;
  sizeFreed: number;
  error: string | null;
}

export function startAttachmentCleanup() {
  if (!stopped) return;
  stopped = false;
  scheduleNext(false);
}

export function stopAttachmentCleanup() {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext(afterRun: boolean) {
  if (stopped) return;
  const delay = msUntilDailySlot(CLEANUP_HOUR, 0, afterRun);
  console.log(`[Cleanup] Next run scheduled in ${Math.round(delay / 60000)} minutes`);
  timeoutId = setTimeout(runCleanup, delay);
}

async function runCleanup() {
  if (stopped) return;
  let retrySoon = false;
  try {
    const result = await runAttachmentCleanup();
    retrySoon = wasSkipped(result) && result.skipped === 'unavailable';
  } catch (err) {
    // The pass logs its own failures; this only catches the lock plumbing.
    console.error('[Cleanup] Attachment cleanup run failed:', err instanceof Error ? err.message : err);
  } finally {
    if (retrySoon) scheduleRetry(); else scheduleNext(true);
  }
}

function scheduleRetry() {
  if (stopped) return;
  console.error(`[Cleanup] Redis unavailable at the cleanup slot — retrying in ${ATTACHMENT_CLEANUP_RETRY_MS / 60000} minutes`);
  timeoutId = setTimeout(runCleanup, ATTACHMENT_CLEANUP_RETRY_MS);
}

/**
 * One expiry pass plus its report, under the cluster lock. Exported for tests;
 * the scheduler calls it from the timer. Resolves `{ skipped: 'locked' }` when
 * another node holds the lock — no rows are touched and no report is sent, the
 * holder's report is the night's — and `{ skipped: 'unavailable' }` when Redis
 * could not be reached (fail closed; the scheduler retries soon).
 */
export async function runAttachmentCleanup(): Promise<AttachmentCleanupResult | ClusterLockSkip> {
  return withClusterLock(
    { key: ATTACHMENT_CLEANUP_LOCK_KEY, ttlSeconds: ATTACHMENT_CLEANUP_LOCK_TTL_SECONDS, tag: '[Cleanup]', holdOnSuccess: true },
    expireAttachmentsAndReport,
  );
}

async function expireAttachmentsAndReport(): Promise<AttachmentCleanupResult> {
  const startedAt = new Date();
  const cutoff = new Date(Date.now() - LIMITS.ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalExpired = 0;
  let totalSizeFreed = 0;
  let error: string | null = null;

  try {
    while (true) {
      const toExpire = await prisma.messageAttachment.findMany({
        where: { createdAt: { lt: cutoff }, expired: false },
        select: { id: true, s3Key: true, fileSize: true },
        take: BATCH_SIZE,
      });

      if (toExpire.length === 0) break;

      // Delete S3 objects first to avoid orphaned storage if DB update succeeds but S3 fails
      await deleteMultipleFromS3(toExpire.map((a) => a.s3Key));

      // Mark as expired in DB (keep records for "File expired" UI placeholder)
      await prisma.messageAttachment.updateMany({
        where: { id: { in: toExpire.map((a) => a.id) } },
        data: { expired: true },
      });

      totalExpired += toExpire.length;
      totalSizeFreed += toExpire.reduce((sum, a) => sum + a.fileSize, 0);
    }

    if (totalExpired > 0) {
      console.log(`[Cleanup] Expired ${totalExpired} attachments`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error = msg;
    console.error('[Cleanup] Attachment cleanup error:', err);
  }

  // Send report email
  const finishedAt = new Date();
  const reportEmail = process.env.CLEANUP_REPORT_EMAIL;
  if (reportEmail) {
    try {
      const remaining = await prisma.messageAttachment.count({ where: { expired: false } });
      const totalExpiredInDb = await prisma.messageAttachment.count({ where: { expired: true } });

      await sendCleanupReport(reportEmail, {
        startedAt,
        finishedAt,
        filesExpired: totalExpired,
        sizeFreed: totalSizeFreed,
        retentionDays: LIMITS.ATTACHMENT_RETENTION_DAYS,
        remainingActive: remaining,
        totalExpiredRecords: totalExpiredInDb,
        error,
      });
    } catch (emailErr) {
      console.error('[Cleanup] Failed to send report email:', describeEmailError(emailErr));
    }
  }

  return { filesExpired: totalExpired, sizeFreed: totalSizeFreed, error };
}
