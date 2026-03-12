import { prisma } from './prisma';
import { deleteMultipleFromS3 } from './s3';
import { sendCleanupReport } from './email';
import { LIMITS } from '@voxium/shared';

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

const CLEANUP_HOUR = 4; // 4 AM
const BATCH_SIZE = 100;

function msUntilNext4AM(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CLEANUP_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function startAttachmentCleanup() {
  if (!stopped) return;
  stopped = false;
  scheduleNext();
}

export function stopAttachmentCleanup() {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext() {
  if (stopped) return;
  const delay = msUntilNext4AM();
  console.log(`[Cleanup] Next run scheduled in ${Math.round(delay / 60000)} minutes`);
  timeoutId = setTimeout(runCleanup, delay);
}

async function runCleanup() {
  if (stopped) return;

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
      console.error('[Cleanup] Failed to send report email:', emailErr);
    }
  }

  scheduleNext();
}
