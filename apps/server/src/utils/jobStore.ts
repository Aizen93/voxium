import type { AdminJob, AdminJobRun, AdminJobRunsPage, JobMode, JobRunOutcome } from '@voxium/shared';
import { prisma } from './prisma';
import { JOB_MODES, checkJobSummary, jobOverdueAfterMs, modeOf, nextJobSlot, type JobDefinition, type JobStore } from './jobs';

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

// ─── What the admin routes read and write (routes/admin.ts) ─────────────────

/** A history page: 1 to JOB_RUNS_PAGE_MAX runs, JOB_RUNS_PAGE_DEFAULT when not asked. */
export const JOB_RUNS_PAGE_DEFAULT = 25;
export const JOB_RUNS_PAGE_MAX = 100;

interface RunRow {
  id: number;
  job: string;
  startedAt: Date;
  finishedAt: Date;
  nodeId: string;
  mode: string;
  outcome: string;
  skipReason: string | null;
  summary: unknown;
  error: string | null;
}

const runSelect = {
  id: true, job: true, startedAt: true, finishedAt: true, nodeId: true, mode: true,
  outcome: true, skipReason: true, summary: true, error: true,
} as const;

/** A run as the page shows it. A summary that is not numbers and listed words (a row written by hand) is left out. */
function toRun(definition: JobDefinition, row: RunRow): AdminJobRun {
  // Checked against the keys the job DECLARES, never the row's own: a key the job does not declare is left out
  const summary = typeof row.summary === 'object' && row.summary !== null
    ? checkJobSummary(definition.counts, row.summary)
    : null;
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    durationMs: Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime()),
    nodeId: row.nodeId,
    mode: row.mode === 'count' ? 'count' : 'on',
    outcome: row.outcome as JobRunOutcome,
    skipReason: row.skipReason,
    summary: summary === 'refused' ? null : summary,
    error: row.error,
  };
}

const KNOWN_MODES: ReadonlySet<string> = new Set(JOB_MODES);

/** Whether `value` is one of the modes (whether the job has it is the caller's to ask). */
export function isJobMode(value: unknown): value is JobMode {
  return typeof value === 'string' && KNOWN_MODES.has(value);
}

/**
 * The mode the page shows: what is stored when this job runs in it; the
 * default when nothing is stored (and always for a job that cannot be
 * switched); `off` for a stored value this job cannot run in (the job does
 * not run then: see isStoredModeUnrunnable).
 */
export function shownJobMode(definition: JobDefinition, stored: string | null | undefined): JobMode {
  if (!definition.switchable || stored === null || stored === undefined) return definition.defaultMode;
  return modeOf(definition, stored) ?? 'off';
}

/** Whether a stored value is one this job cannot run in (`count` on a job without it, or a word this server does not know). */
export function isStoredModeUnrunnable(definition: JobDefinition, stored: string | null | undefined): boolean {
  return definition.switchable && stored !== null && stored !== undefined && modeOf(definition, stored) === null;
}

/**
 * The jobs of `definitions` as the page lists them: their settings and, by
 * one statement each, the last run and the last failure of every one of
 * them (DISTINCT ON over job_runs(job, id), which holds at most 200 runs per
 * job).
 */
export async function listAdminJobs(definitions: readonly JobDefinition[], now: Date = new Date()): Promise<AdminJob[]> {
  const names = definitions.map((d) => d.name);
  const [settings, lastRuns, lastFailures] = await Promise.all([
    prisma.jobSetting.findMany({
      where: { job: { in: names } },
      select: { job: true, mode: true, setAt: true, setBy: { select: { id: true, username: true } } },
    }),
    prisma.$queryRaw<RunRow[]>`
      SELECT DISTINCT ON (job) id, job, started_at AS "startedAt", finished_at AS "finishedAt", node_id AS "nodeId",
             mode, outcome, skip_reason AS "skipReason", summary, error
      FROM job_runs
      WHERE job = ANY(${names}::text[])
      ORDER BY job DESC, id DESC`,
    prisma.$queryRaw<RunRow[]>`
      SELECT DISTINCT ON (job) id, job, started_at AS "startedAt", finished_at AS "finishedAt", node_id AS "nodeId",
             mode, outcome, skip_reason AS "skipReason", summary, error
      FROM job_runs
      WHERE job = ANY(${names}::text[]) AND outcome = 'failed'
      ORDER BY job DESC, id DESC`,
  ]);
  const settingOf = new Map(settings.map((s) => [s.job, s]));
  const lastOf = new Map(lastRuns.map((r) => [r.job, r]));
  const failureOf = new Map(lastFailures.map((r) => [r.job, r]));

  return definitions.map((definition) => {
    // A row stored for a job that cannot be switched is ignored
    const setting = definition.switchable ? settingOf.get(definition.name) : undefined;
    const mode = shownJobMode(definition, setting?.mode);
    const last = lastOf.get(definition.name);
    const failure = failureOf.get(definition.name);
    const nextSlot = mode === 'off' ? null : nextJobSlot(definition, now);
    return {
      name: definition.name,
      title: definition.title,
      description: definition.description,
      schedule: definition.schedule,
      scheduleText: definition.scheduleText,
      switchable: definition.switchable,
      notSwitchableReason: definition.notSwitchableReason,
      supportsCountOnly: definition.supportsCountOnly,
      defaultMode: definition.defaultMode,
      mode,
      modeUnrunnable: isStoredModeUnrunnable(definition, setting?.mode),
      setAt: setting ? setting.setAt.toISOString() : null,
      setBy: setting?.setBy ?? null,
      lastRun: last ? toRun(definition, last) : null,
      lastFailure: failure ? toRun(definition, failure) : null,
      nextRunAt: nextSlot ? nextSlot.toISOString() : null,
      overdue: mode !== 'off' && last !== undefined && now.getTime() - last.startedAt.getTime() > jobOverdueAfterMs(definition),
      // A switchable job that is on and has no recorded run: not overdue, but the page says so
      neverRecorded: definition.switchable && mode === 'on' && last === undefined,
    };
  });
}

/**
 * A job as the list would show it right after its mode was written, built from
 * what the writer knows (the definition, the new mode, who set it and when) for
 * when the re-read fails: a committed switch is never reported as failed. It
 * knows no run.
 */
export function jobAsWritten(definition: JobDefinition, mode: JobMode, setBy: { id: string; username: string }, setAt: Date): AdminJob {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    schedule: definition.schedule,
    scheduleText: definition.scheduleText,
    switchable: definition.switchable,
    notSwitchableReason: definition.notSwitchableReason,
    supportsCountOnly: definition.supportsCountOnly,
    defaultMode: definition.defaultMode,
    mode,
    modeUnrunnable: false,
    setAt: setAt.toISOString(),
    setBy,
    lastRun: null,
    lastFailure: null,
    nextRunAt: mode === 'off' ? null : nextJobSlot(definition, setAt)?.toISOString() ?? null,
    overdue: false,
    neverRecorded: definition.switchable && mode === 'on',
  };
}

/**
 * One page of a job's history, newest first, by an explicit keyset on the
 * row id (served by job_runs(job, id)), never a Prisma cursor: the runs below
 * `before`, and the cursor of the next page when there is one.
 */
export async function readJobRunsPage(definition: JobDefinition, limit: number, before: number | null): Promise<AdminJobRunsPage> {
  const rows = await prisma.jobRun.findMany({
    where: { job: definition.name, ...(before !== null ? { id: { lt: before } } : {}) },
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: runSelect,
  });
  const page = rows.slice(0, limit);
  return {
    runs: page.map((row) => toRun(definition, row)),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}

/** Set a job's mode, by whom and when. */
export async function writeJobMode(job: string, mode: JobMode, setById: string, setAt: Date): Promise<void> {
  await prisma.jobSetting.upsert({
    where: { job },
    create: { job, mode, setAt, setById },
    update: { mode, setAt, setById },
  });
}
