import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/prisma', () => ({
  prisma: {
    messageAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock('../../utils/s3', () => ({
  deleteMultipleFromS3: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/email', () => ({
  sendCleanupReport: vi.fn().mockResolvedValue(undefined),
  describeEmailError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const redisSet = vi.fn();
const redisEval = vi.fn();
vi.mock('../../utils/redis', () => ({
  NODE_ID: () => 'node-under-test',
  getRedis: () => ({ set: redisSet, eval: redisEval }),
}));

// We need to test msUntilNext4AM which is not exported,
// so we test the behavior indirectly via startAttachmentCleanup + stopAttachmentCleanup
import {
  startAttachmentCleanup,
  stopAttachmentCleanup,
  runAttachmentCleanup,
  ATTACHMENT_CLEANUP_LOCK_KEY,
  ATTACHMENT_CLEANUP_LOCK_TTL_SECONDS,
} from '../../utils/attachmentCleanup';
import { prisma } from '../../utils/prisma';
import { deleteMultipleFromS3 } from '../../utils/s3';
import { sendCleanupReport } from '../../utils/email';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('attachmentCleanup — msUntilNext4AM (via fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopAttachmentCleanup();
    vi.useRealTimers();
  });

  it('schedules at 4 AM today if current time is before 4 AM', () => {
    // Set to 2 AM on Jan 15, 2024
    vi.setSystemTime(new Date(2024, 0, 15, 2, 0, 0, 0));

    // Start cleanup — should schedule for 4 AM (2 hours later)
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    startAttachmentCleanup();

    expect(setTimeoutSpy).toHaveBeenCalled();
    const delay = setTimeoutSpy.mock.calls[0][1];
    // 2 hours = 7,200,000 ms
    expect(delay).toBe(2 * 60 * 60 * 1000);
  });

  it('schedules at 4 AM tomorrow if current time is after 4 AM', () => {
    // Set to 10 AM on Jan 15, 2024
    vi.setSystemTime(new Date(2024, 0, 15, 10, 0, 0, 0));

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    startAttachmentCleanup();

    expect(setTimeoutSpy).toHaveBeenCalled();
    const delay = setTimeoutSpy.mock.calls[0][1];
    // 18 hours until next 4 AM = 64,800,000 ms
    expect(delay).toBe(18 * 60 * 60 * 1000);
  });

  it('schedules at 4 AM tomorrow if current time is exactly 4 AM', () => {
    // Set to exactly 4:00:00 AM on Jan 15, 2024
    vi.setSystemTime(new Date(2024, 0, 15, 4, 0, 0, 0));

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    startAttachmentCleanup();

    expect(setTimeoutSpy).toHaveBeenCalled();
    const delay = setTimeoutSpy.mock.calls[0][1];
    // Should be 24 hours (next day at 4 AM)
    expect(delay).toBe(24 * 60 * 60 * 1000);
  });

  it('schedules at 4 AM tomorrow if current time is 11:59 PM', () => {
    // Set to 11:59 PM on Jan 15, 2024
    vi.setSystemTime(new Date(2024, 0, 15, 23, 59, 0, 0));

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    startAttachmentCleanup();

    expect(setTimeoutSpy).toHaveBeenCalled();
    const delay = setTimeoutSpy.mock.calls[0][1];
    // 4 hours and 1 minute = 14,460,000 ms
    expect(delay).toBe(4 * 60 * 60 * 1000 + 1 * 60 * 1000);
  });
});

describe('attachmentCleanup — start/stop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 2, 0, 0, 0));
  });

  afterEach(() => {
    stopAttachmentCleanup();
    vi.useRealTimers();
  });

  it('stopAttachmentCleanup clears the scheduled timeout', () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    startAttachmentCleanup();
    stopAttachmentCleanup();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('calling startAttachmentCleanup twice does not schedule twice', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    startAttachmentCleanup();
    const firstCallCount = setTimeoutSpy.mock.calls.length;

    startAttachmentCleanup(); // second call
    // Should not add another setTimeout call
    expect(setTimeoutSpy.mock.calls.length).toBe(firstCallCount);
  });

  it('can restart after stop', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    startAttachmentCleanup();
    stopAttachmentCleanup();

    const callsBeforeRestart = setTimeoutSpy.mock.calls.length;
    startAttachmentCleanup();
    expect(setTimeoutSpy.mock.calls.length).toBe(callsBeforeRestart + 1);
  });
});

// ─── Leader lock ────────────────────────────────────────────────────────────
//
// Every node fires the 04:00 slot. Unlocked, each ran the expiry pass — N S3
// delete passes over the same rows and N CLEANUP_REPORT_EMAIL reports a
// night — which is exactly what an operator cannot tell apart from "the
// cleanup is broken".

describe('attachmentCleanup — cluster lock', () => {
  const savedReportEmail = process.env.CLEANUP_REPORT_EMAIL;
  beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue('OK');
    redisEval.mockResolvedValue(1);
    process.env.CLEANUP_REPORT_EMAIL = 'ops@example.test';
    vi.mocked(prisma.messageAttachment.findMany)
      .mockResolvedValueOnce([{ id: 'a1', s3Key: 'attachments/a1', fileSize: 10 }, { id: 'a2', s3Key: 'attachments/a2', fileSize: 20 }] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.messageAttachment.count).mockResolvedValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (savedReportEmail === undefined) delete process.env.CLEANUP_REPORT_EMAIL; else process.env.CLEANUP_REPORT_EMAIL = savedReportEmail;
    vi.restoreAllMocks();
  });

  it('the lock holder expires the rows, sends the ONE report, and releases its own lock', async () => {
    const result = await runAttachmentCleanup();

    expect(result).toEqual({ filesExpired: 2, sizeFreed: 30, error: null });
    expect(redisSet).toHaveBeenCalledWith(
      ATTACHMENT_CLEANUP_LOCK_KEY,
      expect.stringMatching(/^node-under-test:[0-9a-f-]{36}$/),
      { NX: true, EX: ATTACHMENT_CLEANUP_LOCK_TTL_SECONDS },
    );
    expect(deleteMultipleFromS3).toHaveBeenCalledWith(['attachments/a1', 'attachments/a2']);
    expect(prisma.messageAttachment.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['a1', 'a2'] } }, data: { expired: true } });
    expect(sendCleanupReport).toHaveBeenCalledTimes(1);
    expect(sendCleanupReport).toHaveBeenCalledWith('ops@example.test', expect.objectContaining({ filesExpired: 2, sizeFreed: 30, error: null }));
    // Released with the token it was claimed under
    expect(redisEval).toHaveBeenCalledWith(expect.any(String), { keys: [ATTACHMENT_CLEANUP_LOCK_KEY], arguments: [redisSet.mock.calls[0][1]] });
  });

  it('a node that loses the SET NX race touches nothing and sends NO report', async () => {
    redisSet.mockResolvedValue(null);
    const result = await runAttachmentCleanup();

    expect(result).toEqual({ skipped: 'locked' });
    expect(prisma.messageAttachment.findMany).not.toHaveBeenCalled();
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    expect(prisma.messageAttachment.updateMany).not.toHaveBeenCalled();
    expect(sendCleanupReport).not.toHaveBeenCalled();
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is unreachable: skips the night rather than racing a peer', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(runAttachmentCleanup()).resolves.toEqual({ skipped: 'locked' });
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    expect(sendCleanupReport).not.toHaveBeenCalled();
  });

  it('the scheduled timer runs the locked pass and re-arms for tomorrow even when the lock was lost', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 3, 59, 0, 0));
    redisSet.mockResolvedValue(null);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    try {
      startAttachmentCleanup();
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000); // fire the 04:00 slot
      expect(redisSet).toHaveBeenCalledTimes(1);
      expect(deleteMultipleFromS3).not.toHaveBeenCalled();
      // Re-armed for tomorrow's slot (afterRun=true → never the slot just served)
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      const delay = setTimeoutSpy.mock.calls[1][1] as number;
      expect(delay).toBeGreaterThan(23 * 60 * 60 * 1000);
    } finally {
      stopAttachmentCleanup();
      vi.useRealTimers();
    }
  });
});
