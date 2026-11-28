import { E2E_LIMITS, IP_RECORD_RETENTION_DAYS, JOIN_REQUEST_DECLINE_COOLDOWN_DAYS, JOIN_REQUEST_PENDING_TTL_DAYS, LIMITS, ORPHAN_GRACE_DAYS, REPORT_RETENTION_MONTHS } from '@voxium/shared';
import { NODE_ID } from './redis';
import { msUntilDailySlot, wasSkipped } from './dailySchedule';
import { describeCaughtError, describeStoreError, errorLabel } from './loggableError';
import { ConflictError, prismaErrorCode } from './errors';

// The server's scheduled jobs: one registry that names and describes each of
// them, and one wrapper every tick of every job goes through.
//
// The wrapper reads the job's mode at EACH tick (from the database, no cache:
// a switch reaches every node at its next tick, with no restart), runs
// nothing when the mode is off, hands the mode to the job, and records the
// run (job_runs). It decides nothing else: each job keeps its own lock, its
// schedule, its guards, its log lines and its return values, and only tells
// the run handle what it counted and how it ended.
//
// What it never does: throw. A job's own failure is handed back to the
// caller (which logs it as it always did); the wrapper's writes fail on their
// own, with one warning per job per hour, and never fail the job. Its mode
// read can delay a start by up to JOB_STORE_TIMEOUT_MS, and a mode that cannot
// be read skips the tick (see decideMode).

/** The modes of a job. `count` works out what the job would do without doing it. */
export const JOB_MODES = ['off', 'count', 'on'] as const;
export type JobMode = typeof JOB_MODES[number];
/** The mode a run runs in. */
export type RunMode = Exclude<JobMode, 'off'>;

export const JOB_OUTCOMES = ['success', 'failed', 'skipped'] as const;
export type JobOutcome = typeof JOB_OUTCOMES[number];

/**
 * Why a run did nothing, for the skips worth keeping. A tick skipped because
 * the job is off is not recorded (its settings row says so), nor one skipped
 * because another node holds the job's lock (every other node would write
 * one at every tick).
 */
export const JOB_SKIP_REASONS = [
  // Redis could not be reached to claim the job's lock (the job fails closed)
  'store-unavailable',
  // The orphan sweep refused its candidates: over its absolute ceiling, or over its share of the store
  'over-cap',
  'over-fraction',
  // A sample of what the session sweep would delete disagreed with its predicate
  'guard-refused',
  // The presence reaper had no usable cluster snapshot
  'snapshot-refused',
  // A switchable job's mode could not be read (not for want of the settings table): the tick is not run
  'mode-unreadable',
] as const;
export type JobSkipReason = typeof JOB_SKIP_REASONS[number];

/**
 * The only words a run's summary may hold beside numbers: which check
 * refused a session sweep, and `manual` for a run an administrator asked for. A closed list, never a pattern: an id, a name, an
 * address, a key or a message would pass any pattern a word passes.
 */
export const JOB_SUMMARY_WORDS = ['expiry', 'version', 'redemption-expiry', 'manual'] as const;
export type JobSummaryWord = typeof JOB_SUMMARY_WORDS[number];

export type JobSummary = Record<string, number | JobSummaryWord>;

export type JobSchedule =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'interval'; seconds: number };

export interface JobDefinition {
  /** Stable, kebab-case: the key of the settings row and of the runs. */
  name: string;
  title: string;
  /** What it does, what it deletes or changes, what stops when it is off. */
  description: string;
  schedule: JobSchedule;
  /** The schedule in words, for the page. */
  scheduleText: string;
  /** Whether an administrator may switch it off. */
  switchable: boolean;
  /** Why it cannot be switched, when it cannot. */
  notSwitchableReason: string | null;
  /** Whether it has a `count` mode. */
  supportsCountOnly: boolean;
  defaultMode: JobMode;
  /**
   * `every-run`: a row per run. `on-change`, for a job that runs more often
   * than hourly: a row only when the outcome changes, a count is not zero or
   * the run failed, and otherwise at most once an hour (JOB_QUIET_RECORD_INTERVAL_MS).
   */
  recording: 'every-run' | 'on-change';
  /** The keys its summary may hold: nothing else is recorded. */
  counts: readonly string[];
}

const DAY_S = 24 * 60 * 60;

/** The registry: a CLOSED list. A job not in it has no switch and no record. */
export const JOBS = [
  {
    name: 'presence-reaper',
    title: 'Presence reaper',
    description: 'Takes offline every user who reads as online with no live connection anywhere in the cluster (a node stopped hard, a disconnect that failed), and tells the servers and conversations they are in. It changes presence in Redis and the status column of users; it deletes nothing. One node runs it per minute, under a cluster lock.',
    schedule: { kind: 'interval', seconds: 60 },
    scheduleText: 'Every minute',
    switchable: false,
    notSwitchableReason: 'It keeps presence true: switched off, people whose connection was lost would stay online for ever.',
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'on-change',
    counts: ['usersOffline'],
  },
  {
    name: 'voice-reaper',
    title: 'Voice reaper',
    description: 'Clears the voice channels owned by a node that stopped (its heartbeat expired) and tells their listeners that the ghost occupants left, and ends the voice sessions of relayed participants whose own connection is gone. It changes the voice state kept in Redis and on the node; it deletes nothing stored. Every node runs it, each for what it can see.',
    schedule: { kind: 'interval', seconds: 60 },
    scheduleText: 'Every minute, on every node',
    switchable: false,
    notSwitchableReason: 'It keeps voice occupancy true: switched off, dead calls and their ghost occupants would stay listed.',
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'on-change',
    counts: ['channelsReaped', 'ghostUsers', 'orphanedParticipants'],
  },
  {
    name: 'attachment-cleanup',
    title: 'Attachment expiry',
    description: `Deletes from the object store the files of message attachments older than ${LIMITS.ATTACHMENT_RETENTION_DAYS} days and marks their rows as expired, so the message shows that its file expired; it mails a report when CLEANUP_REPORT_EMAIL is set. Switched off, attachment files are kept past their retention period: nothing else deletes them.`,
    schedule: { kind: 'daily', hour: 4, minute: 0 },
    scheduleText: 'Daily at 04:00 (server time)',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['filesExpired', 'bytesFreed'],
  },
  {
    name: 'registration-hygiene',
    title: 'Registration hygiene',
    description: `Deletes the accounts that never verified their e-mail address within 7 days (never an administrator, never a server owner), with their avatars and their conversations settled as an account deletion settles them; deletes the IP records not seen for ${IP_RECORD_RETENTION_DAYS} days and the expired sign-up codes and sign-up mail records. Switched off, all of these are kept, IP records past their retention period included.`,
    schedule: { kind: 'daily', hour: 4, minute: 30 },
    scheduleText: 'Daily at 04:30 (server time)',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['deletedUsers', 'deletedAvatars', 'deletedIpRecords', 'purgedPendingRegistrations', 'purgedMailLedger', 'trigger'],
  },
  {
    name: 'orphan-cleanup',
    title: 'Object-store orphan sweep',
    description: `Deletes the files of the object store that nothing in the database points at and that are older than ${ORPHAN_GRACE_DAYS} days, and refuses the whole run when the number looks wrong (over 50,000, or over a quarter of the store once it has more than 200 candidates). It is the backstop of the delete paths. Switched off, such files stay in the store.`,
    schedule: { kind: 'daily', hour: 5, minute: 0 },
    scheduleText: 'Daily at 05:00 (server time)',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['scanned', 'orphaned', 'deleted', 'withinGrace', 'notOurs', 'trigger'],
  },
  {
    name: 'report-retention',
    title: 'Report retention',
    description: `Deletes the moderation reports kept after the deletion of an account they concern, ${REPORT_RETENTION_MONTHS} months after that deletion. Switched off, those reports are kept past their retention period.`,
    schedule: { kind: 'daily', hour: 5, minute: 30 },
    scheduleText: 'Daily at 05:30 (server time)',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['deleted'],
  },
  {
    name: 'key-share-sweep',
    title: 'Key-share sweep',
    description: `Deletes the end-to-end key shares and device-approval transfers older than ${E2E_LIMITS.KEYSHARE_MAX_AGE_MS / (DAY_S * 1000)} days that no device acknowledged. These rows hold who shared keys with whom, and when. Switched off, they are kept until a device acknowledges them, which for a device that never comes back is for ever.`,
    schedule: { kind: 'interval', seconds: 6 * 60 * 60 },
    scheduleText: 'Every 6 hours, counted from each node\'s start',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['keyShares', 'masterTransfers'],
  },
  {
    name: 'session-sweep',
    title: 'Session sweep',
    description: 'Deletes the sign-in sessions that have ended (expired for more than an hour, or below their account\'s token version after a password change, a reset or a ban) and the expired records of refresh tokens issued before sessions, after checking samples of each, and disconnects the sockets still open on them. The renewal refuses those sessions whether or not it runs. Switched off, ended sessions stay in the database.',
    schedule: { kind: 'interval', seconds: 6 * 60 * 60 },
    scheduleText: 'Every 6 hours, the first 5 to 10 minutes after each node\'s start',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['sessions', 'redemptions', 'mismatch'],
  },
  {
    name: 'discovery-cycle',
    title: 'Discovery cycle',
    description: `Refreshes the activity figures the Explore directory ranks and prints, the stalest listed servers first, in a bounded batch; every hour deletes declined join requests past their ${JOIN_REQUEST_DECLINE_COOLDOWN_DAYS}-day cooldown and pending ones older than ${JOIN_REQUEST_PENDING_TTL_DAYS} days and refreshes the badge cuts; once a day corrects drifted member counts and listing flags. Switched off, the directory's figures and badges stop changing and old join requests are kept.`,
    schedule: { kind: 'interval', seconds: 5 * 60 },
    scheduleText: 'Every 5 minutes; join requests hourly; corrections daily in the 04:00 hour (server time)',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'on-change',
    counts: ['refreshed', 'batches', 'backlog', 'declinedJoinRequests', 'stalePendingJoinRequests', 'tierPopulation', 'driftMemberCounts', 'driftListingFlags'],
  },
] as const satisfies readonly JobDefinition[];

export type JobName = typeof JOBS[number]['name'];

/** The registry entry of `name`, or undefined for a name it does not hold. */
export function jobDefinition(name: string): JobDefinition | undefined {
  return (JOBS as readonly JobDefinition[]).find((job) => job.name === name);
}

/** Runs kept per job: the wrapper prunes the rest after each insert. */
export const JOB_RUNS_KEPT = 200;
/** A quiet `on-change` job is recorded at least this often (per node). */
export const JOB_QUIET_RECORD_INTERVAL_MS = 60 * 60 * 1000;
/** One warning of a kind per job in this window (per node). */
export const JOB_WARNING_INTERVAL_MS = 60 * 60 * 1000;
/** A read or a write of the wrapper that has not answered by then is given up (the job does not wait). */
export const JOB_STORE_TIMEOUT_MS = 10_000;
/** A failure the same as the one recorded before it is recorded again after this long (a job recorded on change, per node). */
export const JOB_FAILURE_RECORD_INTERVAL_MS = 15 * 60 * 1000;
/** A recorded error is cut to this many characters. */
export const JOB_ERROR_MAX = 1000;

/** The milliseconds between two runs of a job, by its schedule. */
function intervalMs(schedule: JobSchedule): number {
  return schedule.kind === 'daily' ? DAY_S * 1000 : schedule.seconds * 1000;
}

/**
 * How long after its last recorded run a job reads as overdue: twice the
 * longest gap its records can have (its interval, and for an `on-change`
 * job the hour a quiet one waits between two records).
 */
export function jobOverdueAfterMs(definition: JobDefinition): number {
  const gap = Math.max(intervalMs(definition.schedule), definition.recording === 'on-change' ? JOB_QUIET_RECORD_INTERVAL_MS : 0);
  return 2 * gap;
}

/** The next slot of a daily job in the server's time, or null when the schedule gives none (an interval counts from each node's start). */
export function nextJobSlot(definition: JobDefinition, now: Date = new Date()): Date | null {
  const { schedule } = definition;
  if (schedule.kind !== 'daily') return null;
  return new Date(now.getTime() + msUntilDailySlot(schedule.hour, schedule.minute, false, now));
}

/** The mode a stored value gives this job, or null for a value it cannot run in. */
export function modeOf(definition: JobDefinition, stored: string | null): JobMode | null {
  if (stored === null) return definition.defaultMode;
  if (stored === 'off' || stored === 'on') return stored;
  if (stored === 'count' && definition.supportsCountOnly) return 'count';
  return null;
}

// ─── The store ──────────────────────────────────────────────────────────────

/** One run as it is recorded. */
export interface JobRunRecord {
  job: string;
  startedAt: Date;
  finishedAt: Date;
  nodeId: string;
  mode: RunMode;
  outcome: JobOutcome;
  skipReason: JobSkipReason | null;
  summary: JobSummary | null;
  error: string | null;
}

/** Where modes are read and runs written (utils/jobStore.ts). */
export interface JobStore {
  /** The stored mode of `job`, or null when it has no row. Throws when it cannot be read. */
  readMode(job: string): Promise<string | null>;
  insertRun(run: JobRunRecord): Promise<void>;
  /** Delete the runs of `job` past its newest `keep`. */
  pruneRuns(job: string, keep: number): Promise<void>;
}

let store: JobStore | null = null;

/**
 * Where the wrapper reads and writes. The server sets it at start, before
 * any job runs (index.ts). Until then (a unit test or a script that runs a
 * job on its own) every job runs in its default mode and nothing is
 * recorded: no read is attempted, so nothing is warned about either.
 */
export function setJobStore(next: JobStore | null): void {
  store = next;
}

// ─── The summary ────────────────────────────────────────────────────────────

const WORDS: ReadonlySet<string> = new Set(JOB_SUMMARY_WORDS);

/**
 * A run's summary as it may be recorded: a flat object whose keys the job
 * declares (`allowed`) and whose values are whole numbers from 0 or words of
 * JOB_SUMMARY_WORDS. Null for an empty one; 'refused' for anything else (a
 * key the job does not declare, a string not on the list, a negative, a
 * fraction, a boolean, a nested object or array).
 */
export function checkJobSummary(allowed: readonly string[], value: unknown): JobSummary | null | 'refused' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'refused';
  if (Object.getPrototypeOf(value) !== Object.prototype) return 'refused';
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const summary: JobSummary = {};
  for (const [key, v] of entries) {
    if (!allowed.includes(key)) return 'refused';
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) return 'refused';
      summary[key] = v;
    } else if (typeof v === 'string' && WORDS.has(v)) {
      summary[key] = v as JobSummaryWord;
    } else {
      return 'refused';
    }
  }
  return summary;
}

// ─── The wrapper ────────────────────────────────────────────────────────────

/** What a job tells the wrapper about its run. */
export interface JobRun {
  readonly job: string;
  /** The mode the run runs in. */
  readonly mode: RunMode;
  /** Add `n` to the count `key` (one the job declares). */
  count(key: string, n: number): void;
  /** Record a word of JOB_SUMMARY_WORDS under `key`. */
  note(key: string, word: JobSummaryWord): void;
  /** The run did nothing, for this reason. */
  skip(reason: JobSkipReason): void;
  /** The run failed without throwing (the job caught its own error): recorded as failed with this error. */
  fail(err: unknown): void;
  /** Another node holds the job's lock: the tick is not recorded. */
  lockHeld(): void;
}

/** What a tick came to: not run (the job is off), or run, with the job's result or its error. */
export type JobTick<T> =
  | { ran: false }
  | { ran: true; ok: true; result: T }
  | { ran: true; ok: false; error: unknown };

/**
 * The job's result, undefined when it did not run (it is off), and its error
 * thrown again: for a caller whose own catch logs a failed run, as it did
 * before the wrapper (that line and the retry it decides stay the job's).
 */
export function resultOf<T>(tick: JobTick<T>): T | undefined {
  if (!tick.ran) return undefined;
  if (!tick.ok) throw tick.error;
  return tick.result;
}

/**
 * What withClusterLock answered, told to the run: a lock another node holds
 * is not recorded, and a Redis that could not be reached is a skip.
 */
export function noteClusterLock(run: JobRun | undefined, result: unknown): void {
  if (!run || !wasSkipped(result)) return;
  if (result.skipped === 'locked') run.lockHeld();
  else run.skip('store-unavailable');
}

/** When each warning was last written, by job and kind (per node). */
const warnedAt = new Map<string, number>();
/** The last record attempted for each `on-change` job (per node). */
const lastRecorded = new Map<string, { signature: string; at: number }>();
/** The last failure recorded for each `on-change` job, while no other outcome has been recorded since (per node). */
const lastFailure = new Map<string, { text: string | null; at: number }>();

/** Forget the warnings and the records made: for tests. */
export function resetJobMemory(): void {
  warnedAt.clear();
  lastRecorded.clear();
  lastFailure.clear();
}

function warnHourly(job: string, kind: string, message: string, level: 'warn' | 'error' = 'warn'): void {
  const key = `${job}\u0000${kind}`;
  const last = warnedAt.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < JOB_WARNING_INTERVAL_MS) return;
  warnedAt.set(key, now);
  if (level === 'error') console.error(message);
  else console.warn(message);
}

/** `p`, or a rejection after JOB_STORE_TIMEOUT_MS (`p` is left to settle on its own). */
function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${JOB_STORE_TIMEOUT_MS} ms`)), JOB_STORE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** What reading a job's mode came to. */
type ModeDecision =
  | { kind: 'run'; mode: RunMode }
  // Switched off, or stored as a mode this job cannot run in: nothing runs, nothing is recorded
  | { kind: 'off' }
  // The mode could not be read: nothing runs, the tick is recorded as skipped
  | { kind: 'unreadable'; err: unknown };

/**
 * The mode this tick runs in. Never throws.
 *
 * Only a missing settings table (P2021) reads as the job's default mode, with
 * one warning per job per hour: these jobs ran before any switch existed, and
 * nobody can have switched a job off in a table that does not exist. ANY
 * other failure of the read, the bound of JOB_STORE_TIMEOUT_MS included, is
 * not a reason to run: the job may have been switched off for a reason (a
 * clean-up that must not run), so the tick is skipped. A value that was read
 * but that this job cannot run in (`count` on a job without it, or a value
 * this server does not know) runs nothing either, with one warning: it was
 * written on purpose, by a server that knows more, and running the job in
 * full would do what it was set to avoid.
 */
async function decideMode(definition: JobDefinition): Promise<ModeDecision> {
  let mode: JobMode | null = definition.defaultMode;
  if (definition.switchable && store) {
    const current = store;
    let stored: string | null;
    try {
      stored = await bounded(current.readMode(definition.name), 'the mode read');
    } catch (err) {
      if (prismaErrorCode(err) !== 'P2021') return { kind: 'unreadable', err };
      warnHourly(definition.name, 'read', `[Jobs] The mode of ${definition.name} could not be read because its table does not exist; it runs in its default mode (${definition.defaultMode}): ${describeCaughtError(err)}`);
      stored = null;
    }
    mode = modeOf(definition, stored);
    if (mode === null) {
      warnHourly(definition.name, 'stored', `[Jobs] The stored mode of ${definition.name} is not one it runs in on this server; it is not run`);
    }
  }
  return mode === null || mode === 'off' ? { kind: 'off' } : { kind: 'run', mode };
}

const SYSTEM_ERROR_CODE_RE = /^E[A-Z0-9_]+$/;

/** Whether the error, or its cause, carries a Node system error code. */
function carriesSystemErrorCode(err: unknown): boolean {
  const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  const causeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined);
  return [codeOf(err), codeOf(causeOf(err))].some((code) => typeof code === 'string' && SYSTEM_ERROR_CODE_RE.test(code));
}

/** The error of a failed run, as the log describes it: the label and the text, never the object or a stack. */
function describeRunError(err: unknown): string {
  // A Node system error (ECONNREFUSED, ENOTFOUND...) has a message that names a host and a port: only its name and code are stored
  const text = carriesSystemErrorCode(err) ? describeStoreError(err) : `${errorLabel(err)}: ${describeCaughtError(err)}`;
  return text.length > JOB_ERROR_MAX ? `${text.slice(0, JOB_ERROR_MAX)}...` : text;
}

const SKIP_REASONS: ReadonlySet<string> = new Set(JOB_SKIP_REASONS);

/**
 * Run one tick of the job `name`: read its mode, run `body` unless it is
 * off, record the run. Resolves what the tick came to; never rejects.
 */
export function runJob<T>(name: JobName, body: (run: JobRun) => Promise<T>): Promise<JobTick<T>> {
  return runJobWith(jobDefinition(name)!, body);
}

/** runJob for a definition given whole (the tests give one the registry does not hold). */
export async function runJobWith<T>(definition: JobDefinition, body: (run: JobRun) => Promise<T>): Promise<JobTick<T>> {
  const decision = await decideMode(definition);
  if (decision.kind === 'off') return { ran: false };
  if (decision.kind === 'unreadable') {
    warnHourly(definition.name, 'unreadable', `[Jobs] The mode of ${definition.name} could not be read; this run is skipped: ${describeCaughtError(decision.err)}`, 'error');
    const now = new Date();
    await record(definition, definition.defaultMode === 'count' ? 'count' : 'on', now, now, { counts: {}, skipReason: 'mode-unreadable', failure: null, lockHeld: false });
    return { ran: false };
  }
  return execute(definition, decision.mode, body, {});
}

/**
 * A run an administrator asks for, through the registry like a scheduled one:
 * a job that is switched off is refused (409) and runs nothing; a mode that
 * cannot be read (other than for want of its table) throws the error it got;
 * otherwise `body` runs and the run is recorded with the summary word
 * `trigger: manual`. It touches no timer. A failure of the job is recorded
 * and thrown again.
 */
export async function runJobByHand<T>(name: JobName, body: (run: JobRun) => Promise<T>): Promise<T> {
  const definition = jobDefinition(name)!;
  const decision = await decideMode(definition);
  if (decision.kind === 'off') throw new ConflictError('This job is switched off');
  if (decision.kind === 'unreadable') throw decision.err;
  const tick = await execute(definition, decision.mode, body, { trigger: 'manual' });
  return resultOf(tick) as T;
}

async function execute<T>(definition: JobDefinition, mode: RunMode, body: (run: JobRun) => Promise<T>, counts: Record<string, unknown>): Promise<JobTick<T>> {
  const state: RunState = { counts: { ...counts }, skipReason: null, failure: null, lockHeld: false };
  const run: JobRun = {
    job: definition.name,
    mode,
    count: (key, n) => {
      const before = state.counts[key];
      state.counts[key] = (typeof before === 'number' ? before : 0) + n;
    },
    note: (key, word) => { state.counts[key] = word; },
    skip: (reason) => { if (SKIP_REASONS.has(reason)) state.skipReason = reason; },
    fail: (err) => { if (!state.failure) state.failure = { err }; },
    lockHeld: () => { state.lockHeld = true; },
  };

  const startedAt = new Date();
  let tick: JobTick<T>;
  try {
    tick = { ran: true, ok: true, result: await body(run) };
  } catch (err) {
    tick = { ran: true, ok: false, error: err };
    if (!state.failure) state.failure = { err };
  }
  // A tick another node held the lock for did nothing here: that node records
  if (!state.lockHeld || state.failure) await record(definition, mode, startedAt, new Date(), state);
  return tick;
}

interface RunState {
  counts: Record<string, unknown>;
  skipReason: JobSkipReason | null;
  failure: { err: unknown } | null;
  lockHeld: boolean;
}

/** Whether a quiet `on-change` job records this run (and if so, notes that it did). */
function dueForRecord(definition: JobDefinition, row: Omit<JobRunRecord, 'nodeId'>, now: number): boolean {
  if (definition.recording !== 'on-change') return true;
  const signature = `${row.outcome}|${row.skipReason ?? ''}`;
  const last = lastRecorded.get(definition.name);
  let due: boolean;
  if (row.outcome === 'failed') {
    // A storm of the same failure is recorded once per JOB_FAILURE_RECORD_INTERVAL_MS; the first failure,
    // a different one and one after another outcome was recorded are recorded at once
    const before = lastFailure.get(definition.name);
    due = !before || before.text !== row.error || now - before.at >= JOB_FAILURE_RECORD_INTERVAL_MS;
    if (due) lastFailure.set(definition.name, { text: row.error, at: now });
  } else {
    const counted = row.summary !== null && Object.values(row.summary).some((v) => typeof v === 'number' && v > 0);
    due = !last || last.signature !== signature || counted || now - last.at >= JOB_QUIET_RECORD_INTERVAL_MS;
    if (due) lastFailure.delete(definition.name);
  }
  // The bound applies to ATTEMPTS: a database that refuses the write is not
  // asked again at every tick
  if (due) lastRecorded.set(definition.name, { signature, at: now });
  return due;
}

/** Write the run and prune its job. Never throws, and never waits past JOB_STORE_TIMEOUT_MS per statement. */
async function record(definition: JobDefinition, mode: RunMode, startedAt: Date, finishedAt: Date, state: RunState): Promise<void> {
  if (!store) return;
  const current = store;
  const checked = checkJobSummary(definition.counts, state.counts);
  if (checked === 'refused') {
    warnHourly(definition.name, 'summary', `[Jobs] The counts of ${definition.name} are not a summary it may record; the run is recorded without them`);
  }
  const failure = state.failure;
  const row: Omit<JobRunRecord, 'nodeId'> = {
    job: definition.name,
    startedAt,
    finishedAt,
    mode,
    outcome: failure ? 'failed' : state.skipReason ? 'skipped' : 'success',
    skipReason: failure ? null : state.skipReason,
    summary: checked === 'refused' ? null : checked,
    error: failure ? describeRunError(failure.err) : null,
  };
  if (!dueForRecord(definition, row, Date.now())) return;
  try {
    await bounded(current.insertRun({ ...row, nodeId: NODE_ID() }), 'the run record');
    await bounded(current.pruneRuns(definition.name, JOB_RUNS_KEPT), 'the run prune');
  } catch (err) {
    warnHourly(definition.name, 'record', `[Jobs] A run of ${definition.name} could not be recorded: ${describeCaughtError(err)}`);
  }
}
