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
}));

// We need to test msUntilNext4AM which is not exported,
// so we test the behavior indirectly via startAttachmentCleanup + stopAttachmentCleanup
import { startAttachmentCleanup, stopAttachmentCleanup } from '../../utils/attachmentCleanup';

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
