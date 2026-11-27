import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AdminJob, AdminJobRun } from '@voxium/shared';
import { mount, click, keyDown, deferred, getByRole, queryByRole, queryAllByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The Jobs page: one card per job of the server's registry, with its
 * schedule, its mode, its last run and its next slot, its runs on demand,
 * and a switch for a superadmin only, through the confirmation dialog. The
 * mode shown is always the one the store holds (the server's answer).
 */

interface RunsState { runs: AdminJobRun[]; nextCursor: string | null; loading: boolean; error: boolean }

const store = vi.hoisted(() => ({
  jobs: null as AdminJob[] | null,
  jobsError: false,
  jobRuns: {} as Record<string, RunsState>,
  fetchJobs: vi.fn(),
  fetchJobRuns: vi.fn(),
  setJobMode: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const viewer = vi.hoisted(() => ({ role: 'superadmin' }));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } }) => unknown) => selector({ user: { role: viewer.role } }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminJobs, formatDuration } from '../../components/AdminJobs';

function run(over: Partial<AdminJobRun> = {}): AdminJobRun {
  return {
    id: 1, startedAt: '2026-11-27T06:00:00.000Z', finishedAt: '2026-11-27T06:00:01.250Z', durationMs: 1250, nodeId: 'node-a',
    mode: 'on', outcome: 'success', skipReason: null, summary: { sessions: 3, redemptions: 0 }, error: null, ...over,
  };
}

function job(over: Partial<AdminJob> = {}): AdminJob {
  return {
    name: 'session-sweep', title: 'Session sweep', description: 'Deletes the sign-in sessions that have ended. Switched off, ended sessions stay in the database.',
    schedule: { kind: 'interval', seconds: 21600 }, scheduleText: 'Every 6 hours', switchable: true, notSwitchableReason: null,
    supportsCountOnly: false, defaultMode: 'on', mode: 'on', modeUnrunnable: false, setAt: null, setBy: null,
    lastRun: run(), lastFailure: null, nextRunAt: null, overdue: false, neverRecorded: false, ...over,
  };
}

const SESSIONS = job();
const RETENTION = job({
  name: 'report-retention', title: 'Report retention', description: 'Deletes the reports kept after an account deletion. Switched off, they are kept.',
  schedule: { kind: 'daily', hour: 5, minute: 30 }, scheduleText: 'Daily at 05:30 (server time)',
  lastRun: run({ id: 4, outcome: 'failed', summary: { deleted: 1000 }, error: 'Error [40001]: could not serialize access' }),
  nextRunAt: '2026-11-28T05:30:00.000Z',
});
const PRESENCE = job({
  name: 'presence-reaper', title: 'Presence reaper', description: 'Takes ghost users offline. It deletes nothing.',
  schedule: { kind: 'interval', seconds: 60 }, scheduleText: 'Every minute', switchable: false,
  notSwitchableReason: 'It keeps presence true: switched off, people would stay online for ever.',
  lastRun: run({ id: 9, summary: { usersOffline: 0 } }),
});
const ORPHANS = job({
  name: 'orphan-cleanup', title: 'Object-store orphan sweep', description: 'Deletes unreferenced files. Switched off, they stay.',
  schedule: { kind: 'daily', hour: 5, minute: 0 }, scheduleText: 'Daily at 05:00 (server time)', lastRun: null, overdue: false,
  mode: 'off', setAt: '2026-11-26T10:00:00.000Z', setBy: { id: 'sa', username: 'root' },
});

let view: Mounted;
const cardOf = (name: string) => document.body.querySelector(`[data-job="${name}"]`) as HTMLElement;
const modeGroup = (title: string) => queryByRole('group', `Mode of ${title}`);
/** The button of the mode control of a job, by its label ("Switch off", "Switch on", "Count only"). */
const modeButton = (title: string, label: string) => {
  const hits = Array.from(modeGroup(title)?.querySelectorAll('button') ?? []).filter((b) => b.textContent === label);
  return hits[0] as HTMLButtonElement | undefined;
};
const inDialog = (label: string) => Array.from(getByRole('dialog').querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
// the helper's roles do not include a native table: found by its accessible name
const runsTable = (title: string) => document.body.querySelector(`table[aria-label="Runs of ${title}"]`) as HTMLTableElement | null;

async function renderJobs() {
  await view.render(<AdminJobs />);
}

beforeEach(() => {
  vi.clearAllMocks();
  viewer.role = 'superadmin';
  store.jobs = [SESSIONS, RETENTION, PRESENCE, ORPHANS];
  store.jobsError = false;
  store.jobRuns = {};
  store.fetchJobs.mockResolvedValue(undefined);
  store.fetchJobRuns.mockResolvedValue(undefined);
  store.setJobMode.mockResolvedValue(true);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminJobs — the list', () => {
  it('loads the jobs when it opens', async () => {
    await renderJobs();
    expect(store.fetchJobs).toHaveBeenCalledTimes(1);
  });

  it('shows each job with its title, description, schedule, last run and next run', async () => {
    await renderJobs();
    const card = cardOf('report-retention');
    expect(card.textContent).toContain('Report retention');
    expect(card.textContent).toContain('Deletes the reports kept after an account deletion.');
    expect(card.textContent).toContain('Daily at 05:30 (server time)');
    expect(card.textContent).toContain(new Date('2026-11-27T06:00:00.000Z').toLocaleString());
    expect(card.textContent).toContain('in 1.3 s');
    expect(card.textContent).toContain(new Date('2026-11-28T05:30:00.000Z').toLocaleString());
    expect(card.querySelector('[data-testid="job-outcome"]')!.textContent).toBe('failed');
    expect(cardOf('session-sweep').textContent).toContain('Counted from each node\'s start');
  });

  it('says when a job never ran, when it is off, and who switched it', async () => {
    await renderJobs();
    const card = cardOf('orphan-cleanup');
    expect(card.textContent).toContain('No run recorded');
    expect(card.querySelector('[data-testid="job-never-recorded"]')).toBeNull();
    expect(card.textContent).toContain('None while off');
    expect(card.textContent).toContain(`Set to off by root on ${new Date('2026-11-26T10:00:00.000Z').toLocaleString()}`);
  });

  it('marks a job whose last run failed, and one that is overdue, and no other', async () => {
    store.jobs = [SESSIONS, RETENTION, { ...PRESENCE, overdue: true }];
    await renderJobs();
    expect(cardOf('report-retention').querySelector('[data-testid="job-mark"]')!.textContent).toContain('Last run failed');
    expect(cardOf('presence-reaper').querySelector('[data-testid="job-mark"]')!.textContent).toContain('Overdue');
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mark"]')).toBeNull();
  });

  it('a job that is on and has no recorded run says "No run recorded yet" in the place of its last run, and is not marked overdue', async () => {
    store.jobs = [job({ name: 'report-retention', title: 'Report retention', lastRun: null, neverRecorded: true })];
    await renderJobs();
    const card = cardOf('report-retention');
    expect(card.querySelector('[data-testid="job-never-recorded"]')!.textContent).toBe('No run recorded yet');
    expect(card.querySelector('[data-testid="job-mark"]')).toBeNull();
  });

  it('says it is loading before the first answer, and that the list failed when it did', async () => {
    store.jobs = null;
    await renderJobs();
    expect(bodyText()).toContain('Loading jobs...');
    view.unmount();
    view = mount();
    store.jobsError = true;
    await renderJobs();
    expect(bodyText()).toContain('The jobs could not be loaded.');
  });

  it('formats a duration as milliseconds, seconds or minutes', () => {
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(1250)).toBe('1.3 s');
    expect(formatDuration(150_000)).toBe('3 min');
  });
});

describe('AdminJobs — the switch', () => {
  it('a superadmin gets a button for every mode a job can be switched to, the mode it is in as text, and no control on a job that cannot be switched, with its reason', async () => {
    await renderJobs();
    expect(document.body.querySelectorAll('select')).toHaveLength(0);
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mode"]')!.textContent).toBe('On');
    expect(Array.from(modeGroup('Session sweep')!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Switch off']);
    expect(cardOf('orphan-cleanup').querySelector('[data-testid="job-mode"]')!.textContent).toBe('Off');
    expect(Array.from(modeGroup('Object-store orphan sweep')!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Switch on']);
    expect(modeGroup('Presence reaper')).toBeNull();
    expect(cardOf('presence-reaper').querySelector('[data-testid="job-mode-reason"]')!.textContent)
      .toBe('Cannot be switched. It keeps presence true: switched off, people would stay online for ever.');
  });

  it('an administrator who is not a superadmin gets no control at all, and the reason', async () => {
    viewer.role = 'admin';
    await renderJobs();
    expect(queryAllByRole('group')).toHaveLength(0);
    expect(queryAllByRole('button', /^Switch |^Count only$/)).toHaveLength(0);
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mode-reason"]')!.textContent).toBe('Only a super admin can switch a job.');
    expect(cardOf('session-sweep').textContent).toContain('On');
    expect(cardOf('presence-reaper').querySelector('[data-testid="job-mode-reason"]')!.textContent).toContain('Cannot be switched.');
  });

  it('offers count only on a job that has it', async () => {
    store.jobs = [SESSIONS, { ...RETENTION, supportsCountOnly: true }];
    await renderJobs();
    const labels = (title: string) => Array.from(modeGroup(title)!.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels('Session sweep')).toEqual(['Switch off']);
    // on now: the buttons are the other two modes
    expect(labels('Report retention')).toEqual(['Switch off', 'Count only']);
  });

  it('a stored mode this server cannot run the job in is shown as not running, for a superadmin and for the others', async () => {
    store.jobs = [job({ mode: 'off', modeUnrunnable: true, setAt: '2026-11-26T10:00:00.000Z', setBy: { id: 'sa', username: 'root' } })];
    await renderJobs();
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mode"]')!.textContent).toBe('Stored mode cannot be run by this server: not running');
    expect(modeButton('Session sweep', 'Switch off')).toBeDefined();
    expect(modeButton('Session sweep', 'Switch on')).toBeDefined();
    view.unmount();
    view = mount();
    viewer.role = 'admin';
    await renderJobs();
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mode"]')!.textContent).toBe('Stored mode cannot be run by this server: not running');
  });

  it('there is no list to move through: an arrow key on a control opens nothing, only a click on a button does', async () => {
    await renderJobs();
    const button = modeButton('Session sweep', 'Switch off')!;
    await keyDown(button, 'ArrowDown');
    await keyDown(button, 'ArrowUp');
    expect(queryByRole('dialog')).toBeNull();
    expect(store.setJobMode).not.toHaveBeenCalled();
    await click(button);
    expect(getByRole('dialog')).toBeTruthy();
  });

  it('a change asks for confirmation first; Cancel sends nothing and the control keeps the mode', async () => {
    await renderJobs();
    await click(modeButton('Session sweep', 'Switch off')!);
    const dialog = getByRole('dialog');
    expect(dialog.textContent).toContain('Switch "Session sweep" off');
    expect(dialog.textContent).toContain('stops running on every node from its next tick');
    expect(dialog.textContent).toContain('Switched off, ended sessions stay in the database.');
    expect(store.setJobMode).not.toHaveBeenCalled();
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mode"]')!.textContent).toBe('On');
    await click(getByRole('button', 'Cancel'));
    expect(queryByRole('dialog')).toBeNull();
    expect(store.setJobMode).not.toHaveBeenCalled();
  });

  it('confirming sends the job and the mode, says so and closes the dialog', async () => {
    await renderJobs();
    await click(modeButton('Session sweep', 'Switch off')!);
    await click(inDialog('Switch off'));
    await flush();
    expect(store.setJobMode).toHaveBeenCalledTimes(1);
    expect(store.setJobMode).toHaveBeenCalledWith('session-sweep', 'off');
    expect(toast.success).toHaveBeenCalledWith('"Session sweep" is now off');
    expect(queryByRole('dialog')).toBeNull();
  });

  it('switching a job back on is a primary action, not a destructive one', async () => {
    await renderJobs();
    await click(modeButton('Object-store orphan sweep', 'Switch on')!);
    const confirm = inDialog('Switch on');
    expect(confirm.className).toContain('bg-vox-accent-primary');
    await click(confirm);
    await flush();
    expect(store.setJobMode).toHaveBeenCalledWith('orphan-cleanup', 'on');
  });

  it('a refused change says nothing of success, changes nothing on screen and leaves the dialog open', async () => {
    store.setJobMode.mockResolvedValue(false);
    await renderJobs();
    await click(modeButton('Session sweep', 'Switch off')!);
    await click(inDialog('Switch off'));
    await flush();
    expect(store.setJobMode).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(getByRole('dialog')).toBeTruthy();
    expect(cardOf('session-sweep').querySelector('[data-testid="job-mode"]')!.textContent).toBe('On');
  });

  it('while the change runs, the dialog cannot be confirmed twice', async () => {
    const pending = deferred<boolean>();
    store.setJobMode.mockReturnValue(pending.promise);
    await renderJobs();
    await click(modeButton('Session sweep', 'Switch off')!);
    await click(inDialog('Switch off'));
    await click(getByRole('button', 'Processing...'));
    expect(store.setJobMode).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await flush();
    expect(queryByRole('dialog')).toBeNull();
  });
});

describe('AdminJobs — the runs', () => {
  it('opening a job asks for its runs and shows them, with their counts and a failure\'s error', async () => {
    await renderJobs();
    const toggle = cardOf('report-retention').querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(store.fetchJobRuns).toHaveBeenCalledWith('report-retention');
    expect(bodyText()).toContain('Loading runs...');

    store.jobRuns = {
      'report-retention': {
        runs: [
          run({ id: 4, outcome: 'failed', summary: { deleted: 1000 }, error: 'Error [40001]: could not serialize access' }),
          run({ id: 3, outcome: 'skipped', skipReason: 'store-unavailable', summary: null, durationMs: 12, nodeId: 'node-b' }),
        ],
        nextCursor: '3', loading: false, error: false,
      },
    };
    await renderJobs();
    const table = runsTable('Report retention')!;
    const failed = table.querySelector('[data-run-id="4"]')!;
    expect(failed.textContent).toContain('deleted: 1000');
    expect(failed.textContent).toContain('failed');
    expect(table.querySelector('[data-run-error="4"]')!.textContent).toBe('Error [40001]: could not serialize access');
    const skipped = table.querySelector('[data-run-id="3"]')!;
    expect(skipped.textContent).toContain('skipped (Redis unreachable)');
    expect(skipped.textContent).toContain('12 ms');
    expect(skipped.textContent).toContain('node-b');
    expect(table.querySelector('[data-run-error="3"]')).toBeNull();

    await click(getByRole('button', 'Load older runs'));
    expect(store.fetchJobRuns).toHaveBeenLastCalledWith('report-retention', true);
  });

  it('says when a job has no run, and when its runs could not be loaded', async () => {
    store.jobRuns = {
      'session-sweep': { runs: [], nextCursor: null, loading: false, error: false },
      'report-retention': { runs: [], nextCursor: null, loading: false, error: true },
    };
    await renderJobs();
    await click(cardOf('session-sweep').querySelector('button[aria-expanded]')!);
    await click(cardOf('report-retention').querySelector('button[aria-expanded]')!);
    expect(cardOf('session-sweep').textContent).toContain('No run recorded yet.');
    expect(cardOf('report-retention').textContent).toContain('The runs could not be loaded.');
    expect(queryByRole('button', 'Load older runs')).toBeNull();
  });

  it('closing a job hides its runs and asks for nothing more', async () => {
    store.jobRuns = { 'session-sweep': { runs: [run()], nextCursor: null, loading: false, error: false } };
    await renderJobs();
    const toggle = () => cardOf('session-sweep').querySelector('button[aria-expanded]') as HTMLButtonElement;
    await click(toggle());
    expect(runsTable('Session sweep')).not.toBeNull();
    await click(toggle());
    expect(runsTable('Session sweep')).toBeNull();
    expect(store.fetchJobRuns).toHaveBeenCalledTimes(1);
  });
});
