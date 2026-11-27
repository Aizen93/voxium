import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REPORT_RETENTION_MONTHS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/prisma', () => ({ prisma: { $queryRaw: vi.fn() } }));

const redisSet = vi.fn();
const redisEval = vi.fn();
vi.mock('../../utils/redis', () => ({
  NODE_ID: () => 'node-under-test',
  getRedis: () => ({ set: redisSet, eval: redisEval }),
}));

const logAuditEvent = vi.hoisted(() => vi.fn());
vi.mock('../../utils/auditLog', () => ({ logAuditEvent }));

// The job never asks the flag: a report kept while it was on still expires
// once it is off. Mocked so a read of it would show.
const flag = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: (...a: unknown[]) => flag(...(a as [])) }));

import { prisma } from '../../utils/prisma';
import {
  runReportRetention,
  deleteExpiredReports,
  reportExpiries,
  startReportRetention,
  stopReportRetention,
  REPORT_RETENTION_LOCK_KEY,
  REPORT_RETENTION_LOCK_TTL_SECONDS,
  REPORT_RETENTION_RETRY_MS,
  REPORT_RETENTION_BATCH,
  REPORT_RETENTION_MAX_BATCHES,
} from '../../utils/reportRetention';

const queryRaw = vi.mocked(prisma.$queryRaw);

/** `n` deleted ids, as one batch's RETURNING answers them. */
const batchOf = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `rep-${from + i}` }));

function sqlOf(call: unknown[]): string {
  return (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue('OK');
  redisEval.mockResolvedValue(1);
  queryRaw.mockResolvedValue([] as never);
});

afterEach(() => {
  stopReportRetention();
});

describe('the report retention statement', () => {
  it('deletes, in id order and at most a batch at a time, the reports one of whose accounts was deleted more than the period ago, on the database clock', async () => {
    await deleteExpiredReports();

    const [call] = queryRaw.mock.calls;
    expect(sqlOf(call)).toBe(
      'WITH due AS ( SELECT id FROM reports '
      + "WHERE (reporter_deleted_at IS NOT NULL AND reporter_deleted_at + make_interval(months => ?) <= (now() AT TIME ZONE 'UTC')) "
      + "OR (reported_user_deleted_at IS NOT NULL AND reported_user_deleted_at + make_interval(months => ?) <= (now() AT TIME ZONE 'UTC')) "
      + 'ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED ) '
      + 'DELETE FROM reports r USING due WHERE r.id = due.id RETURNING r.id',
    );
    // the period is the shared constant, in calendar months added by the
    // database, and nothing of the node's clock is sent
    expect(call.slice(1)).toEqual([REPORT_RETENTION_MONTHS, REPORT_RETENTION_MONTHS, REPORT_RETENTION_BATCH]);
    expect(REPORT_RETENTION_MONTHS).toBe(12);
    expect(REPORT_RETENTION_BATCH).toBe(1000);
    expect(call.slice(1).some((v) => v instanceof Date)).toBe(false);
    expect(sqlOf(call)).not.toMatch(/days|\* ?\d/);
  });

  it('a report with no deletion mark is never due: each arm requires its own mark, and there is no other arm', async () => {
    await deleteExpiredReports();

    const where = /WHERE (.*) ORDER BY id/.exec(sqlOf(queryRaw.mock.calls[0]))![1];
    const arms = where.split(/ OR /);
    expect(arms).toHaveLength(2);
    expect(arms[0]).toMatch(/^\(reporter_deleted_at IS NOT NULL AND /);
    expect(arms[1]).toMatch(/^\(reported_user_deleted_at IS NOT NULL AND /);
  });

  it('never reads the feature flag: reports kept while it was on still expire once it is off', async () => {
    queryRaw.mockResolvedValueOnce(batchOf(2) as never);

    const result = await deleteExpiredReports();

    expect(result.deleted).toBe(2);
    expect(flag).not.toHaveBeenCalled();
  });
});

describe('the report retention batches', () => {
  it('takes batch after batch until one finds fewer due reports than it could take, and adds them up', async () => {
    queryRaw
      .mockResolvedValueOnce(batchOf(REPORT_RETENTION_BATCH) as never)
      .mockResolvedValueOnce(batchOf(REPORT_RETENTION_BATCH, REPORT_RETENTION_BATCH) as never)
      .mockResolvedValueOnce(batchOf(3, 2 * REPORT_RETENTION_BATCH) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await deleteExpiredReports();

      expect(queryRaw).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ deleted: 2 * REPORT_RETENTION_BATCH + 3, failedBatch: null });
    } finally {
      log.mockRestore();
    }
  });

  it('nothing due: one statement, no audit row', async () => {
    const result = await deleteExpiredReports();

    expect(result).toEqual({ deleted: 0, failedBatch: null });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('a run that deleted something writes ONE audit row with no actor: the count and the period', async () => {
    queryRaw
      .mockResolvedValueOnce(batchOf(REPORT_RETENTION_BATCH) as never)
      .mockResolvedValueOnce(batchOf(5) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await deleteExpiredReports();

      expect(logAuditEvent).toHaveBeenCalledTimes(1);
      expect(logAuditEvent).toHaveBeenCalledWith({
        actorId: null,
        action: 'report.retention_sweep',
        targetType: 'report',
        metadata: { trigger: 'scheduled', deletedReports: REPORT_RETENTION_BATCH + 5, retentionMonths: REPORT_RETENTION_MONTHS },
      });
    } finally {
      log.mockRestore();
    }
  });

  it('a batch that fails ends the run: the batches before it stay counted, the failure is logged by description and recorded by name and code only', async () => {
    const failure = Object.assign(new Error('canceling statement due to statement timeout'), { name: 'PrismaClientKnownRequestError', code: 'P2010' });
    queryRaw
      .mockResolvedValueOnce(batchOf(REPORT_RETENTION_BATCH) as never)
      .mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await deleteExpiredReports();

      expect(queryRaw).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ deleted: REPORT_RETENTION_BATCH, failedBatch: { name: 'PrismaClientKnownRequestError', code: 'P2010' } });
      expect(error).toHaveBeenCalledTimes(1);
      const [line, described] = error.mock.calls[0];
      expect(line).toMatch(/^\[Reports\] A batch of the report retention failed; 1000 report\(s\) deleted before it stay deleted/);
      // the describing helper's text, never the error object
      expect(typeof described).toBe('string');
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ deletedReports: REPORT_RETENTION_BATCH, failedBatch: { name: 'PrismaClientKnownRequestError', code: 'P2010' } }),
      }));
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('a first batch that fails deletes nothing and writes no audit row', async () => {
    queryRaw.mockRejectedValueOnce(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await deleteExpiredReports();

      expect(result).toEqual({ deleted: 0, failedBatch: { name: 'Error', code: null } });
      expect(logAuditEvent).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('stops at the batch bound even if every batch comes back full', async () => {
    queryRaw.mockResolvedValue(batchOf(REPORT_RETENTION_BATCH) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await deleteExpiredReports();

      expect(queryRaw).toHaveBeenCalledTimes(REPORT_RETENTION_MAX_BATCHES);
      expect(result.deleted).toBe(REPORT_RETENTION_MAX_BATCHES * REPORT_RETENTION_BATCH);
    } finally {
      log.mockRestore();
    }
  });
});

describe('the report retention cluster lock', () => {
  it('claims its own lock with SET NX for 20 hours and HOLDS it after the run (one run per slot across the cluster)', async () => {
    const result = await runReportRetention();

    expect(result).toEqual({ deleted: 0, failedBatch: null });
    expect(REPORT_RETENTION_LOCK_KEY).toBe('lock:reportretention');
    expect(REPORT_RETENTION_LOCK_TTL_SECONDS).toBe(20 * 60 * 60);
    expect(redisSet).toHaveBeenCalledWith(REPORT_RETENTION_LOCK_KEY, expect.stringMatching(/^node-under-test:/), { NX: true, EX: REPORT_RETENTION_LOCK_TTL_SECONDS });
    // held: no compare-and-delete after a run that finished
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('a run that stopped at a failed batch still holds the lock: the next night goes on from what is left', async () => {
    queryRaw.mockRejectedValueOnce(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runReportRetention();

      expect(redisEval).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('does nothing when a peer holds the lock', async () => {
    redisSet.mockResolvedValue(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runReportRetention()).toEqual({ skipped: 'locked' });
      expect(queryRaw).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('fails CLOSED when Redis cannot be reached: no statement, a distinct result', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runReportRetention()).toEqual({ skipped: 'unavailable' });
      expect(queryRaw).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('the report retention schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopReportRetention();
    vi.useRealTimers();
  });

  it('runs nightly at 05:30, after the orphan sweep', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0, 0));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      startReportRetention();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls[0][1]).toBe(3.5 * 60 * 60 * 1000);
    } finally {
      log.mockRestore();
    }
  });

  it('starting twice schedules once, and a stop clears the timer', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      startReportRetention();
      startReportRetention();
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      stopReportRetention();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('Redis unreachable at the slot: tried again after the retry delay, not a day later', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 5, 29, 0, 0));
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      startReportRetention();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
      expect(delays).toEqual([60 * 1000, REPORT_RETENTION_RETRY_MS]);
      expect(REPORT_RETENTION_RETRY_MS).toBe(15 * 60 * 1000);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('after a run the next one is the next night\'s slot', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 5, 29, 0, 0));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      startReportRetention();
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([60 * 1000, 24 * 60 * 60 * 1000]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('reportExpiries — the date the moderation queue shows', () => {
  const at = (iso: string) => new Date(iso);

  it('no report with a mark: no statement, no date', async () => {
    const dates = await reportExpiries([{ id: 'rep-1', reporterDeletedAt: null, reportedUserDeletedAt: null }]);

    expect(dates.size).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("asks the database for each marked report's EARLIER mark plus the period, from the marks the caller read, in one statement", async () => {
    queryRaw.mockResolvedValueOnce([
      { id: 'rep-1', expiresAt: at('2027-11-20T08:00:00.000Z') },
      { id: 'rep-3', expiresAt: at('2029-02-28T10:00:00.000Z') },
    ] as never);

    const dates = await reportExpiries([
      { id: 'rep-1', reporterDeletedAt: at('2026-12-01T09:00:00.000Z'), reportedUserDeletedAt: at('2026-11-20T08:00:00.000Z') },
      { id: 'rep-2', reporterDeletedAt: null, reportedUserDeletedAt: null },
      { id: 'rep-3', reporterDeletedAt: null, reportedUserDeletedAt: at('2028-02-29T10:00:00.000Z') },
    ]);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [call] = queryRaw.mock.calls;
    expect(sqlOf(call)).toBe(
      'SELECT m.id, m.mark::timestamp(3) + make_interval(months => ?) AS "expiresAt" FROM unnest(?::text[], ?::text[]) AS m(id, mark)',
    );
    expect(call.slice(1)).toEqual([
      REPORT_RETENTION_MONTHS,
      ['rep-1', 'rep-3'],
      // the earlier of rep-1's two marks; rep-2 has none and is not sent
      ['2026-11-20T08:00:00.000Z', '2028-02-29T10:00:00.000Z'],
    ]);
    // the database's answer, never a date the node computed (29 February plus
    // twelve months is the 28th there)
    expect(dates.get('rep-1')).toEqual(at('2027-11-20T08:00:00.000Z'));
    expect(dates.get('rep-3')).toEqual(at('2029-02-28T10:00:00.000Z'));
    expect(dates.has('rep-2')).toBe(false);
  });
});
