import { prisma } from './prisma';
import type { JobStore } from './jobs';

/** Runs deleted by one prune at most: after each insert there is one to delete, normally. */
export const JOB_PRUNE_BATCH = 500;

/**
 * The job registry's store in the database (job_settings, job_runs): what
 * the server hands the wrapper at start (setJobStore, utils/jobs.ts).
 */
export const prismaJobStore: JobStore = {
  async readMode(job) {
    const row = await prisma.jobSetting.findUnique({ where: { job }, select: { mode: true } });
    return row?.mode ?? null;
  },

  async insertRun(run) {
    await prisma.jobRun.create({
      data: {
        job: run.job,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        nodeId: run.nodeId,
        mode: run.mode,
        outcome: run.outcome,
        skipReason: run.skipReason,
        ...(run.summary ? { summary: run.summary } : {}),
        error: run.error,
      },
    });
  },

  // One bounded statement, served by job_runs(job, id): the subquery walks
  // that index backwards from the job's newest run, past the `keep` kept, and
  // takes at most JOB_PRUNE_BATCH; the delete finds them by primary key
  async pruneRuns(job, keep) {
    await prisma.$executeRaw`
      DELETE FROM job_runs WHERE id IN (
        SELECT id FROM job_runs WHERE job = ${job}
        ORDER BY id DESC
        OFFSET ${keep} LIMIT ${JOB_PRUNE_BATCH}
      )`;
  },
};
