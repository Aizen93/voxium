import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import type { AdminJob, AdminJobRun } from '@voxium/shared';

/**
 * The Jobs page's state: the list, each job's history paged by its cursor,
 * and a switch whose answer (the job as the list shows it) replaces the row;
 * a refused switch toasts the server's reason and changes nothing.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/socket', () => ({ getSocket: () => null, onSocketReconnect: () => () => {} }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useAdminStore } from '../../stores/adminStore';
import { toast } from '../../stores/toastStore';

function job(over: Partial<AdminJob> = {}): AdminJob {
  return {
    name: 'session-sweep', title: 'Session sweep', description: 'd', schedule: { kind: 'interval', seconds: 21600 }, scheduleText: 's',
    switchable: true, notSwitchableReason: null, supportsCountOnly: false, defaultMode: 'on', mode: 'on', modeUnrunnable: false, setAt: null, setBy: null,
    lastRun: null, lastFailure: null, nextRunAt: null, overdue: false, neverRecorded: false, ...over,
  };
}
function run(id: number): AdminJobRun {
  return {
    id, startedAt: '2026-11-27T06:00:00.000Z', finishedAt: '2026-11-27T06:00:01.000Z', durationMs: 1000, nodeId: 'n',
    mode: 'on', outcome: 'success', skipReason: null, summary: null, error: null,
  };
}
function refusal(status: number, error: string): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, { status, statusText: '', headers: {}, config, data: { success: false, error } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdminStore.setState({ jobs: null, jobsError: false, jobRuns: {} });
});

describe('adminStore — jobs', () => {
  it('fetchJobs holds the list the server answers', async () => {
    api.get.mockResolvedValue({ data: { data: [job()] } });
    await useAdminStore.getState().fetchJobs();
    expect(api.get).toHaveBeenCalledWith('/admin/jobs');
    expect(useAdminStore.getState().jobs).toEqual([job()]);
    expect(useAdminStore.getState().jobsError).toBe(false);
  });

  it('a failed list keeps what it held, says it failed and logs the message only', async () => {
    useAdminStore.setState({ jobs: [job()] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.get.mockRejectedValue(refusal(500, 'Internal server error'));
    await useAdminStore.getState().fetchJobs();
    expect(useAdminStore.getState().jobs).toEqual([job()]);
    expect(useAdminStore.getState().jobsError).toBe(true);
    expect(error).toHaveBeenCalledWith('Failed to fetch jobs:', 'Internal server error');
    error.mockRestore();
  });

  it('a list answered after a later request was sent is not applied, and neither is one answered before a switch\'s answer', async () => {
    const answers: Array<(v: unknown) => void> = [];
    api.get.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const first = useAdminStore.getState().fetchJobs();
    const second = useAdminStore.getState().fetchJobs();
    answers[1]({ data: { data: [job({ title: 'newer' })] } });
    await second;
    answers[0]({ data: { data: [job({ title: 'older' })] } });
    await first;
    expect(useAdminStore.getState().jobs![0].title).toBe('newer');

    // a list asked for before a switch, answered after the switch's answer
    useAdminStore.setState({ jobs: [job()] });
    const beforeSwitch = useAdminStore.getState().fetchJobs();
    api.put.mockResolvedValue({ data: { data: job({ mode: 'off' }) } });
    await useAdminStore.getState().setJobMode('session-sweep', 'off');
    answers[2]({ data: { data: [job({ mode: 'on' })] } });
    await beforeSwitch;
    expect(useAdminStore.getState().jobs![0].mode).toBe('off');

    // a list asked for after the switch's answer is applied
    const afterSwitch = useAdminStore.getState().fetchJobs();
    answers[3]({ data: { data: [job({ mode: 'off', title: 'fresh' })] } });
    await afterSwitch;
    expect(useAdminStore.getState().jobs![0].title).toBe('fresh');
  });

  it('a stale list that fails neither reports an error nor logs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejects: Array<(e: unknown) => void> = [];
    api.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejects.push(reject); }));
    const stale = useAdminStore.getState().fetchJobs();
    api.get.mockResolvedValueOnce({ data: { data: [job()] } });
    await useAdminStore.getState().fetchJobs();
    rejects[0](refusal(500, 'late failure'));
    await stale;
    expect(useAdminStore.getState().jobsError).toBe(false);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('fetchJobRuns loads the first page, then appends the next one by its cursor', async () => {
    api.get.mockResolvedValueOnce({ data: { data: { runs: [run(9), run(8)], nextCursor: '8' } } });
    await useAdminStore.getState().fetchJobRuns('session-sweep');
    expect(api.get).toHaveBeenLastCalledWith('/admin/jobs/session-sweep/runs', { params: {} });
    expect(useAdminStore.getState().jobRuns['session-sweep']).toEqual({ runs: [run(9), run(8)], nextCursor: '8', loading: false, error: false });

    api.get.mockResolvedValueOnce({ data: { data: { runs: [run(7)], nextCursor: null } } });
    await useAdminStore.getState().fetchJobRuns('session-sweep', true);
    expect(api.get).toHaveBeenLastCalledWith('/admin/jobs/session-sweep/runs', { params: { before: '8' } });
    expect(useAdminStore.getState().jobRuns['session-sweep'].runs.map((r) => r.id)).toEqual([9, 8, 7]);
    expect(useAdminStore.getState().jobRuns['session-sweep'].nextCursor).toBeNull();

    // nothing more to load: no request
    await useAdminStore.getState().fetchJobRuns('session-sweep', true);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('a first page asked again replaces the history, and an older answer never paints over a newer one', async () => {
    let answerFirst!: (v: unknown) => void;
    api.get.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }));
    const first = useAdminStore.getState().fetchJobRuns('session-sweep');
    api.get.mockResolvedValueOnce({ data: { data: { runs: [run(5)], nextCursor: null } } });
    await useAdminStore.getState().fetchJobRuns('session-sweep');
    answerFirst({ data: { data: { runs: [run(1)], nextCursor: null } } });
    await first;
    expect(useAdminStore.getState().jobRuns['session-sweep'].runs.map((r) => r.id)).toEqual([5]);
  });

  it('a failed history page keeps the runs held and says it failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAdminStore.setState({ jobRuns: { 'session-sweep': { runs: [run(9)], nextCursor: '9', loading: false, error: false } } });
    api.get.mockRejectedValue(refusal(400, 'before must be a run id'));
    await useAdminStore.getState().fetchJobRuns('session-sweep', true);
    expect(useAdminStore.getState().jobRuns['session-sweep']).toEqual({ runs: [run(9)], nextCursor: '9', loading: false, error: true });
    expect(error).toHaveBeenCalledWith('Failed to fetch the runs of a job:', 'before must be a run id');
    error.mockRestore();
  });

  it('setJobMode sends the mode and replaces the row with the job the server answers', async () => {
    useAdminStore.setState({ jobs: [job(), job({ name: 'report-retention' })] });
    api.put.mockResolvedValue({ data: { data: job({ mode: 'off', setAt: '2026-11-27T12:00:00.000Z' }) } });
    await expect(useAdminStore.getState().setJobMode('session-sweep', 'off')).resolves.toBe(true);
    expect(api.put).toHaveBeenCalledWith('/admin/jobs/session-sweep', { mode: 'off' });
    const jobs = useAdminStore.getState().jobs!;
    expect(jobs[0]).toMatchObject({ name: 'session-sweep', mode: 'off', setAt: '2026-11-27T12:00:00.000Z' });
    expect(jobs[1]).toEqual(job({ name: 'report-retention' }));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused switch toasts the server\'s reason, logs the message only, changes nothing and resolves false', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAdminStore.setState({ jobs: [job()] });
    api.put.mockRejectedValue(refusal(403, 'Super admin access required'));
    await expect(useAdminStore.getState().setJobMode('session-sweep', 'off')).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Super admin access required');
    expect(error).toHaveBeenCalledWith('Failed to switch the job:', 'Super admin access required');
    expect(useAdminStore.getState().jobs).toEqual([job()]);
    error.mockRestore();
  });

  it('a switch with no answer at all says it failed in its own words', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.put.mockRejectedValue(new Error('Network Error'));
    await expect(useAdminStore.getState().setJobMode('session-sweep', 'off')).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Failed to switch the job');
    error.mockRestore();
  });
});
