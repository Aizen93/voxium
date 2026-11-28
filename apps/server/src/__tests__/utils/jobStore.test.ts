import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  jobSetting: { findUnique: vi.fn() },
  jobRun: { create: vi.fn() },
  $executeRaw: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: db }));

import { prismaJobStore, JOB_PRUNE_BATCH } from '../../utils/jobStore';
import { JOB_RUNS_KEPT, type JobRunRecord } from '../../utils/jobs';

const run: JobRunRecord = {
  job: 'session-sweep',
  startedAt: new Date('2026-11-27T10:00:00.000Z'),
  finishedAt: new Date('2026-11-27T10:00:01.500Z'),
  nodeId: 'node-1',
  mode: 'on',
  outcome: 'success',
  skipReason: null,
  summary: { sessions: 4, redemptions: 0 },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$executeRaw.mockResolvedValue(1);
  db.jobRun.create.mockResolvedValue({});
});

describe('the job store in the database', () => {
  it('reads the stored mode of one job, or null when it has no row', async () => {
    db.jobSetting.findUnique.mockResolvedValueOnce({ mode: 'off' }).mockResolvedValueOnce(null);
    expect(await prismaJobStore.readMode('session-sweep')).toBe('off');
    expect(await prismaJobStore.readMode('report-retention')).toBeNull();
    expect(db.jobSetting.findUnique).toHaveBeenNthCalledWith(1, { where: { job: 'session-sweep' }, select: { mode: true } });
  });

  it('lets a read that fails throw (the wrapper decides what that means)', async () => {
    db.jobSetting.findUnique.mockRejectedValue(new Error('no table'));
    await expect(prismaJobStore.readMode('session-sweep')).rejects.toThrow('no table');
  });

  it('inserts a run with every field', async () => {
    await prismaJobStore.insertRun(run);
    expect(db.jobRun.create).toHaveBeenCalledWith({ data: { ...run } });
  });

  it('writes no summary for a run without one (the column stays NULL)', async () => {
    await prismaJobStore.insertRun({ ...run, summary: null, outcome: 'failed', error: 'Error: x' });
    const data = db.jobRun.create.mock.calls[0][0].data as Record<string, unknown>;
    expect('summary' in data).toBe(false);
    expect(data.error).toBe('Error: x');
  });

  it('prunes in ONE bounded statement: the job\'s runs past its newest `keep`, newest first by id, at most JOB_PRUNE_BATCH', async () => {
    await prismaJobStore.pruneRuns('session-sweep', JOB_RUNS_KEPT);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    expect(sql).toBe('DELETE FROM job_runs WHERE id IN ( SELECT id FROM job_runs WHERE job = ? ORDER BY id DESC OFFSET ? LIMIT ? )');
    expect(values).toEqual(['session-sweep', 200, JOB_PRUNE_BATCH]);
    expect(JOB_PRUNE_BATCH).toBe(500);
  });
});
