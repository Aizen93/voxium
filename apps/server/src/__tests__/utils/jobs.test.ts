import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The node id a record carries; withClusterLock's own module stays real
vi.mock('../../utils/redis', () => ({ NODE_ID: () => 'node-under-test', getRedis: () => ({}) }));

import {
  JOBS, JOB_MODES, JOB_RUNS_KEPT, JOB_QUIET_RECORD_INTERVAL_MS, JOB_WARNING_INTERVAL_MS, JOB_STORE_TIMEOUT_MS, JOB_ERROR_MAX,
  jobDefinition, runJob, runJobWith, setJobStore, resetJobMemory, checkJobSummary, noteClusterLock, modeOf, resultOf,
  jobOverdueAfterMs, nextJobSlot,
  type JobDefinition, type JobRunRecord, type JobStore,
} from '../../utils/jobs';

interface FakeStore extends JobStore {
  modes: Map<string, string>;
  runs: JobRunRecord[];
  calls: string[];
  readMode: ReturnType<typeof vi.fn>;
  insertRun: ReturnType<typeof vi.fn>;
  pruneRuns: ReturnType<typeof vi.fn>;
}

function fakeStore(): FakeStore {
  const modes = new Map<string, string>();
  const runs: JobRunRecord[] = [];
  const calls: string[] = [];
  return {
    modes,
    runs,
    calls,
    readMode: vi.fn(async (job: string) => { calls.push(`read ${job}`); return modes.get(job) ?? null; }),
    insertRun: vi.fn(async (run: JobRunRecord) => { calls.push(`insert ${run.job}`); runs.push(run); }),
    pruneRuns: vi.fn(async (job: string, keep: number) => { calls.push(`prune ${job} ${keep}`); }),
  };
}

/** A switchable job the registry does not hold, so a test can give it a count mode or another recording. */
function definition(over: Partial<JobDefinition> = {}): JobDefinition {
  return {
    name: 'test-job',
    title: 'Test job',
    description: 'Does a test thing.',
    schedule: { kind: 'daily', hour: 4, minute: 0 },
    scheduleText: 'Daily at 04:00',
    switchable: true,
    notSwitchableReason: null,
    supportsCountOnly: false,
    defaultMode: 'on',
    recording: 'every-run',
    counts: ['deleted', 'scanned', 'mismatch'],
    ...over,
  };
}

let store: FakeStore;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetJobMemory();
  store = fakeStore();
  setJobStore(store);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setJobStore(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the registry', () => {
  it('is a closed list of the nine scheduled jobs, each named once in kebab-case', () => {
    const names = JOBS.map((j) => j.name);
    expect(names).toEqual([
      'presence-reaper', 'voice-reaper', 'attachment-cleanup', 'registration-hygiene', 'orphan-cleanup',
      'report-retention', 'key-share-sweep', 'session-sweep', 'discovery-cycle',
    ]);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(jobDefinition('nope')).toBeUndefined();
    expect(jobDefinition('session-sweep')?.title).toBe('Session sweep');
  });

  it('only the two 60-second reapers cannot be switched, each with its reason; every other job can', () => {
    for (const job of JOBS) {
      const reaper = job.name === 'presence-reaper' || job.name === 'voice-reaper';
      expect(job.switchable, job.name).toBe(!reaper);
      if (reaper) {
        expect(job.notSwitchableReason, job.name).toMatch(/.{20,}/);
        expect(job.schedule).toEqual({ kind: 'interval', seconds: 60 });
      } else {
        expect(job.notSwitchableReason, job.name).toBeNull();
      }
    }
  });

  it('no job of this registry has a count mode yet, and every one starts on', () => {
    for (const job of JOBS) {
      expect(job.supportsCountOnly, job.name).toBe(false);
      expect(job.defaultMode, job.name).toBe('on');
    }
  });

  it('describes every job in a few plain sentences, and declares what its summary may hold', () => {
    for (const job of JOBS) {
      const sentences = job.description.split(/(?<=[.:;])\s+(?=[A-Z])/).length;
      expect(sentences, job.name).toBeGreaterThanOrEqual(2);
      expect(sentences, job.name).toBeLessThanOrEqual(4);
      expect(job.title.length, job.name).toBeGreaterThan(3);
      expect(job.scheduleText.length, job.name).toBeGreaterThan(3);
      expect(job.counts.length, job.name).toBeGreaterThan(0);
      for (const key of job.counts) expect(key, job.name).toMatch(/^[a-z][a-zA-Z]{1,39}$/);
    }
  });

  it('the jobs that run more often than hourly are the ones recorded on change', () => {
    for (const job of JOBS) {
      const frequent = job.schedule.kind === 'interval' && job.schedule.seconds < 3600;
      expect(job.recording, job.name).toBe(frequent ? 'on-change' : 'every-run');
    }
  });

  it('modes are off, count and on', () => {
    expect([...JOB_MODES]).toEqual(['off', 'count', 'on']);
  });
});

describe('modeOf: what a stored value gives a job', () => {
  it('no row is the default; off and on are themselves; count only for a job that has it; anything else none', () => {
    const plain = definition();
    expect(modeOf(plain, null)).toBe('on');
    expect(modeOf(plain, 'off')).toBe('off');
    expect(modeOf(plain, 'on')).toBe('on');
    expect(modeOf(plain, 'count')).toBeNull();
    expect(modeOf(definition({ supportsCountOnly: true }), 'count')).toBe('count');
    expect(modeOf(plain, 'ON')).toBeNull();
    expect(modeOf(plain, '')).toBeNull();
  });
});

describe('the wrapper: modes', () => {
  it('on: runs the job, hands it the mode, records a success with its counts, and resolves its result', async () => {
    const body = vi.fn(async (run) => {
      expect(run.mode).toBe('on');
      run.count('deleted', 3);
      run.count('deleted', 2);
      run.count('scanned', 0);
      return 'result';
    });
    const tick = await runJobWith(definition(), body);
    expect(tick).toEqual({ ran: true, ok: true, result: 'result' });
    expect(body).toHaveBeenCalledTimes(1);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({
      job: 'test-job', nodeId: 'node-under-test', mode: 'on', outcome: 'success', skipReason: null,
      summary: { deleted: 5, scanned: 0 }, error: null,
    });
    expect(store.runs[0].startedAt).toBeInstanceOf(Date);
    expect(store.runs[0].finishedAt.getTime()).toBeGreaterThanOrEqual(store.runs[0].startedAt.getTime());
  });

  it('a job with no row runs in its default mode', async () => {
    const body = vi.fn(async () => 1);
    await runJobWith(definition(), body);
    expect(store.readMode).toHaveBeenCalledWith('test-job');
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('off: runs nothing and records nothing', async () => {
    store.modes.set('test-job', 'off');
    const body = vi.fn(async () => 1);
    const tick = await runJobWith(definition(), body);
    expect(tick).toEqual({ ran: false });
    expect(body).not.toHaveBeenCalled();
    expect(store.insertRun).not.toHaveBeenCalled();
    expect(store.pruneRuns).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the mode at EACH tick: a switch reaches the next tick', async () => {
    const body = vi.fn(async () => 1);
    store.modes.set('test-job', 'off');
    await runJobWith(definition(), body);
    store.modes.set('test-job', 'on');
    await runJobWith(definition(), body);
    store.modes.set('test-job', 'off');
    await runJobWith(definition(), body);
    expect(store.readMode).toHaveBeenCalledTimes(3);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('count is refused for a job without it: a stored count runs nothing, with one warning', async () => {
    store.modes.set('test-job', 'count');
    const body = vi.fn(async () => 1);
    expect(await runJobWith(definition(), body)).toEqual({ ran: false });
    expect(body).not.toHaveBeenCalled();
    expect(store.insertRun).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[Jobs] The stored mode of test-job is not one it runs in on this server; it is not run');
  });

  it('a value this server does not know runs nothing either', async () => {
    store.modes.set('test-job', 'paused');
    const body = vi.fn(async () => 1);
    expect(await runJobWith(definition(), body)).toEqual({ ran: false });
    expect(body).not.toHaveBeenCalled();
  });

  it('a job that has a count mode runs in it when it is stored, and the record says so', async () => {
    store.modes.set('test-job', 'count');
    const body = vi.fn(async (run) => { expect(run.mode).toBe('count'); return 1; });
    await runJobWith(definition({ supportsCountOnly: true }), body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(store.runs[0].mode).toBe('count');
  });

  it('a job that is not switchable never reads a mode: a stored off does not stop it', async () => {
    store.modes.set('test-job', 'off');
    const body = vi.fn(async () => 1);
    const tick = await runJobWith(definition({ switchable: false, notSwitchableReason: 'it must run' }), body);
    expect(tick.ran).toBe(true);
    expect(store.readMode).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(1);
  });

  it('runJob runs a registry job by its name', async () => {
    store.modes.set('report-retention', 'off');
    const body = vi.fn(async () => 1);
    expect(await runJob('report-retention', body)).toEqual({ ran: false });
    expect(store.readMode).toHaveBeenCalledWith('report-retention');
  });
});

describe('the wrapper: a mode that cannot be read', () => {
  it('runs the job in its default mode and warns once per job per hour', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 27, 12, 0, 0), toFake: ['Date'] });
    store.readMode.mockRejectedValue(Object.assign(new Error('relation "job_settings" does not exist'), { code: '42P01' }));
    const body = vi.fn(async () => 1);

    await runJobWith(definition(), body);
    await runJobWith(definition(), body);
    expect(body).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe('[Jobs] The mode of test-job could not be read; it runs in its default mode (on): relation "job_settings" does not exist');

    vi.setSystemTime(new Date(2026, 10, 27, 12, 59, 0));
    await runJobWith(definition(), body);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 10, 27, 13, 0, 1));
    await runJobWith(definition(), body);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenCalledTimes(4);
  });

  it('the warning of one job does not silence another\'s', async () => {
    store.readMode.mockRejectedValue(new Error('db down'));
    await runJobWith(definition({ name: 'job-a' }), async () => 1);
    await runJobWith(definition({ name: 'job-b' }), async () => 1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('describes a Prisma error without its arguments', async () => {
    const err = Object.assign(new Error('Invalid `prisma.jobSetting.findUnique()` invocation: where { job: "secret-value" }'), { name: 'PrismaClientKnownRequestError', code: 'P2021' });
    store.readMode.mockRejectedValue(err);
    await runJobWith(definition(), async () => 1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('jobSetting.findUnique() failed (arguments not logged)');
    expect(line).not.toContain('secret-value');
  });

  it('a read that does not answer is given up after JOB_STORE_TIMEOUT_MS and the job runs in its default mode', async () => {
    vi.useFakeTimers();
    store.readMode.mockReturnValue(new Promise(() => { /* never answers */ }));
    const body = vi.fn(async () => 1);
    const tick = runJobWith(definition(), body);
    await vi.advanceTimersByTimeAsync(JOB_STORE_TIMEOUT_MS);
    expect(await tick).toEqual({ ran: true, ok: true, result: 1 });
    expect(body).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`did not answer within ${JOB_STORE_TIMEOUT_MS} ms`);
  });
});

describe('the wrapper: failures', () => {
  it('a job that throws is recorded as failed with the error described, the tick resolves the error, and the next tick runs', async () => {
    const boom = Object.assign(new Error('the store\nrefused'), { code: 'ECONNRESET' });
    const tick = await runJobWith(definition(), async (run) => { run.count('deleted', 4); throw boom; });
    expect(tick).toEqual({ ran: true, ok: false, error: boom });
    expect(store.runs[0]).toMatchObject({ outcome: 'failed', skipReason: null, summary: { deleted: 4 }, error: 'Error [ECONNRESET]: the store\\nrefused' });

    const next = await runJobWith(definition(), async () => 'again');
    expect(next).toEqual({ ran: true, ok: true, result: 'again' });
    expect(store.runs[1].outcome).toBe('success');
  });

  it('never prints or stores the error object: a non-error value is named by its type', async () => {
    const tick = await runJobWith(definition(), async () => { throw { secret: 'x' }; });
    expect(tick.ran && !tick.ok).toBe(true);
    expect(store.runs[0].error).toBe('Error: Non-error value thrown (object)');
  });

  it('cuts a long error', async () => {
    await runJobWith(definition(), async () => { throw new Error('x'.repeat(5000)); });
    expect(store.runs[0].error!.length).toBe(JOB_ERROR_MAX + 3);
  });

  it('a job that caught its own error and says so is recorded as failed; its result still reaches the caller', async () => {
    const tick = await runJobWith(definition(), async (run) => {
      run.fail(new Error('batch failed'));
      run.fail(new Error('a second one is not kept'));
      return { deleted: 0 };
    });
    expect(tick).toEqual({ ran: true, ok: true, result: { deleted: 0 } });
    expect(store.runs[0]).toMatchObject({ outcome: 'failed', error: 'Error: batch failed' });
  });

  it('a record that fails to write does not fail the job, and is warned about once per job per hour', async () => {
    store.insertRun.mockRejectedValue(new Error('relation "job_runs" does not exist'));
    const first = await runJobWith(definition(), async () => 'done');
    const second = await runJobWith(definition(), async () => 'again');
    expect(first).toEqual({ ran: true, ok: true, result: 'done' });
    expect(second).toEqual({ ran: true, ok: true, result: 'again' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe('[Jobs] A run of test-job could not be recorded: relation "job_runs" does not exist');
    expect(store.pruneRuns).not.toHaveBeenCalled();
  });

  it('a prune that fails does not fail the job either', async () => {
    store.pruneRuns.mockRejectedValue(new Error('lock timeout'));
    const tick = await runJobWith(definition(), async () => 'done');
    expect(tick).toEqual({ ran: true, ok: true, result: 'done' });
    expect(store.runs).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a record that does not answer is given up after JOB_STORE_TIMEOUT_MS: the tick does not wait for it', async () => {
    vi.useFakeTimers();
    store.insertRun.mockReturnValue(new Promise(() => { /* never answers */ }));
    const tick = runJobWith(definition(), async () => 'done');
    await vi.advanceTimersByTimeAsync(JOB_STORE_TIMEOUT_MS);
    expect(await tick).toEqual({ ran: true, ok: true, result: 'done' });
  });
});

describe('the wrapper: what is recorded', () => {
  it('a tick another node holds the lock for is not recorded', async () => {
    const tick = await runJobWith(definition(), async (run) => { noteClusterLock(run, { skipped: 'locked' }); return 0; });
    expect(tick.ran).toBe(true);
    expect(store.insertRun).not.toHaveBeenCalled();
  });

  it('a lock that could not be claimed because Redis was unreachable is recorded as a skip', async () => {
    await runJobWith(definition(), async (run) => { noteClusterLock(run, { skipped: 'unavailable' }); return 0; });
    expect(store.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'store-unavailable', error: null });
  });

  it('noteClusterLock says nothing for a run that took the lock, nor without a run', async () => {
    await runJobWith(definition(), async (run) => { noteClusterLock(run, { deleted: 1 }); return 0; });
    expect(store.runs[0].outcome).toBe('success');
    expect(() => noteClusterLock(undefined, { skipped: 'locked' })).not.toThrow();
  });

  it('a skip carries its reason; a reason off the list is dropped', async () => {
    await runJobWith(definition(), async (run) => { run.skip('over-cap'); return 0; });
    await runJobWith(definition(), async (run) => { run.skip('not-a-reason' as never); return 0; });
    expect(store.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'over-cap' });
    expect(store.runs[1]).toMatchObject({ outcome: 'success', skipReason: null });
  });

  it('a word of the closed list is recorded beside the counts', async () => {
    await runJobWith(definition(), async (run) => { run.note('mismatch', 'version'); run.count('deleted', 0); return 0; });
    expect(store.runs[0].summary).toEqual({ mismatch: 'version', deleted: 0 });
  });

  it('counts the job does not declare are not recorded: the run is, without them, with one warning', async () => {
    await runJobWith(definition(), async (run) => { run.count('deleted', 1); run.count('c1x9k2abcdefghijklmnop', 1); return 0; });
    expect(store.runs[0].summary).toBeNull();
    expect(String(warn.mock.calls[0][0])).toBe('[Jobs] The counts of test-job are not a summary it may record; the run is recorded without them');
  });

  it('a run with no counts records no summary', async () => {
    await runJobWith(definition(), async () => 0);
    expect(store.runs[0].summary).toBeNull();
  });

  it('prunes after EACH insert, the job\'s own runs past the newest 200', async () => {
    await runJobWith(definition(), async () => 0);
    await runJobWith(definition({ name: 'other-job' }), async () => 0);
    expect(JOB_RUNS_KEPT).toBe(200);
    expect(store.calls).toEqual([
      'read test-job', 'insert test-job', 'prune test-job 200',
      'read other-job', 'insert other-job', 'prune other-job 200',
    ]);
  });

  it('without a store (a test or a script running a job alone) the job runs in its default mode, nothing is read, recorded or warned', async () => {
    setJobStore(null);
    const body = vi.fn(async () => 1);
    expect(await runJobWith(definition(), body)).toEqual({ ran: true, ok: true, result: 1 });
    expect(await runJobWith(definition(), async () => { throw new Error('x'); })).toMatchObject({ ran: true, ok: false });
    expect(store.readMode).not.toHaveBeenCalled();
    expect(store.insertRun).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the wrapper: the bound of a job recorded on change (the 60-second reapers)', () => {
  const reaper = () => definition({ name: 'reaper', recording: 'on-change', switchable: false, notSwitchableReason: 'must run', schedule: { kind: 'interval', seconds: 60 }, counts: ['usersOffline'] });
  const tickAt = async (at: Date, body: Parameters<typeof runJobWith>[1]) => {
    vi.setSystemTime(at);
    await runJobWith(reaper(), body);
  };
  const minute = (m: number) => new Date(2026, 10, 27, 12, m, 0);

  beforeEach(() => {
    vi.useFakeTimers({ now: minute(0), toFake: ['Date'] });
  });

  it('a quiet hour of empty successes writes ONE row, and the hour after it one more', async () => {
    for (let m = 0; m < 60; m++) await tickAt(minute(m), async (run) => { run.count('usersOffline', 0); return 0; });
    expect(store.runs).toHaveLength(1);
    await tickAt(new Date(minute(0).getTime() + JOB_QUIET_RECORD_INTERVAL_MS), async () => 0);
    expect(store.runs).toHaveLength(2);
  });

  it('a count that is not zero is recorded at once, every time', async () => {
    await tickAt(minute(0), async () => 0);
    await tickAt(minute(1), async (run) => { run.count('usersOffline', 2); return 2; });
    await tickAt(minute(2), async (run) => { run.count('usersOffline', 1); return 1; });
    await tickAt(minute(3), async () => 0);
    expect(store.runs.map((r) => r.summary)).toEqual([null, { usersOffline: 2 }, { usersOffline: 1 }]);
  });

  it('a change of outcome is recorded, and so is the change back', async () => {
    await tickAt(minute(0), async () => 0);
    await tickAt(minute(1), async (run) => { run.skip('snapshot-refused'); return 0; });
    await tickAt(minute(2), async (run) => { run.skip('snapshot-refused'); return 0; });
    await tickAt(minute(3), async () => 0);
    expect(store.runs.map((r) => `${r.outcome}:${r.skipReason}`)).toEqual(['success:null', 'skipped:snapshot-refused', 'success:null']);
  });

  it('every failure is recorded', async () => {
    await tickAt(minute(0), async () => { throw new Error('a'); });
    await tickAt(minute(1), async () => { throw new Error('b'); });
    expect(store.runs.map((r) => r.error)).toEqual(['Error: a', 'Error: b']);
  });

  it('the bound counts attempts: a database that refuses the write is not asked again at every quiet tick', async () => {
    store.insertRun.mockRejectedValue(new Error('no table'));
    for (let m = 0; m < 10; m++) await tickAt(minute(m), async () => 0);
    expect(store.insertRun).toHaveBeenCalledTimes(1);
  });

  it('a job recorded at every run is not bounded', async () => {
    for (let m = 0; m < 5; m++) {
      vi.setSystemTime(minute(m));
      await runJobWith(definition(), async () => 0);
    }
    expect(store.runs).toHaveLength(5);
  });
});

describe('checkJobSummary', () => {
  const allowed = ['deleted', 'scanned', 'mismatch'];

  it('takes whole numbers from 0 and the closed list of words, under keys the job declares', () => {
    expect(checkJobSummary(allowed, { deleted: 0, scanned: 12_345 })).toEqual({ deleted: 0, scanned: 12_345 });
    expect(checkJobSummary(allowed, { mismatch: 'redemption-expiry' })).toEqual({ mismatch: 'redemption-expiry' });
    expect(checkJobSummary(allowed, {})).toBeNull();
  });

  it.each([
    ['a string not on its list', { mismatch: 'refused' }],
    ['an id-shaped value', { mismatch: 'clx9k2abcdefghijklmnopqrs' }],
    ['an e-mail address', { mismatch: 'someone@example.com' }],
    ['a key', { mismatch: 'attachments/u1/file.png' }],
    ['a nested object', { deleted: { count: 1 } }],
    ['an array', { deleted: [1] }],
    ['a boolean', { deleted: true }],
    ['null', { deleted: null }],
    ['a negative', { deleted: -1 }],
    ['a fraction', { deleted: 1.5 }],
    ['NaN', { deleted: Number.NaN }],
    ['an unsafe integer', { deleted: Number.MAX_SAFE_INTEGER + 1 }],
    ['a key the job does not declare', { userId: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(checkJobSummary(allowed, value)).toBe('refused');
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'deleted'],
    ['an object with a prototype of its own', Object.create({ deleted: 1 })],
  ])('refuses %s as the summary itself', (_name, value) => {
    expect(checkJobSummary(allowed, value)).toBe('refused');
  });
});

describe('the schedule as the page shows it', () => {
  it('a daily job\'s next slot is its next hh:mm in the server\'s time', () => {
    const job = jobDefinition('report-retention')!;
    const now = new Date(2026, 10, 27, 5, 29, 0);
    expect(nextJobSlot(job, now)).toEqual(new Date(2026, 10, 27, 5, 30, 0));
    expect(nextJobSlot(job, new Date(2026, 10, 27, 5, 31, 0))).toEqual(new Date(2026, 10, 28, 5, 30, 0));
  });

  it('an interval job has none: each node counts from its own start', () => {
    expect(nextJobSlot(jobDefinition('session-sweep')!)).toBeNull();
  });

  it('a job reads as overdue after twice the longest gap its records can have', () => {
    expect(jobOverdueAfterMs(jobDefinition('attachment-cleanup')!)).toBe(48 * 60 * 60 * 1000);
    expect(jobOverdueAfterMs(jobDefinition('session-sweep')!)).toBe(12 * 60 * 60 * 1000);
    // recorded at most hourly when quiet: twice the hour, never twice the minute
    expect(jobOverdueAfterMs(jobDefinition('presence-reaper')!)).toBe(2 * JOB_QUIET_RECORD_INTERVAL_MS);
    expect(jobOverdueAfterMs(jobDefinition('discovery-cycle')!)).toBe(2 * JOB_QUIET_RECORD_INTERVAL_MS);
  });

  it('warns and records within the hour bounds the constants say', () => {
    expect(JOB_WARNING_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(JOB_QUIET_RECORD_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

describe('resultOf: a tick as the caller of the job reads it', () => {
  it('the result of a run, undefined for a job that is off, and the error of a failed run thrown again', () => {
    expect(resultOf({ ran: true, ok: true, result: 7 })).toBe(7);
    expect(resultOf({ ran: false })).toBeUndefined();
    const boom = new Error('boom');
    expect(() => resultOf({ ran: true, ok: false, error: boom })).toThrow(boom);
  });
});

describe('the server sets the store before any job starts', () => {
  it('index.ts hands the wrapper the database store right after connecting, before the first job is started', () => {
    const index = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
    const set = index.indexOf('setJobStore(prismaJobStore);');
    expect(set).toBeGreaterThan(index.indexOf('await prisma.$connect();'));
    for (const start of [
      'startPresenceReaper(', 'initVoiceCluster(', 'startAttachmentCleanup();', 'startKeyShareCleanup();', 'startSessionSweep();',
      'startRegistrationHygiene();', 'startOrphanCleanup();', 'startReportRetention();', 'startDiscoveryStats();',
    ]) {
      const at = index.indexOf(start, index.indexOf('async function main'));
      expect(at, start).toBeGreaterThan(set);
    }
  });
});
