import { useEffect, useState, Fragment } from 'react';
import { Clock, RefreshCw, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import type { AdminJob, AdminJobRun, JobMode } from '@voxium/shared';
import { useAdminStore } from '../stores/adminStore';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { AdminConfirmModal } from './AdminConfirmModal';

const MODE_LABELS: Record<JobMode, string> = { off: 'Off', count: 'Count only', on: 'On' };

const OUTCOME_STYLES: Record<AdminJobRun['outcome'], string> = {
  success: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  skipped: 'bg-yellow-500/20 text-yellow-400',
};

/** The skip reasons the server records, in words; one it adds later shows as it is. */
const SKIP_LABELS: Record<string, string> = {
  'store-unavailable': 'Redis unreachable',
  'over-cap': 'over its ceiling',
  'over-fraction': 'over its share of the store',
  'guard-refused': 'refused by its check',
  'snapshot-refused': 'no cluster snapshot',
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function formatSummary(summary: AdminJobRun['summary']): string {
  if (!summary) return '';
  return Object.entries(summary).map(([key, value]) => `${key}: ${value}`).join(', ');
}

function OutcomeBadge({ run }: { run: AdminJobRun }) {
  const reason = run.skipReason ? SKIP_LABELS[run.skipReason] ?? run.skipReason : null;
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', OUTCOME_STYLES[run.outcome])} data-testid="job-outcome">
      {run.outcome}{reason ? ` (${reason})` : ''}
    </span>
  );
}

/** Why a job deserves a look: its last run failed, or it has not run for longer than its records allow. */
function JobMarks({ job }: { job: AdminJob }) {
  const marks: string[] = [];
  if (job.lastRun?.outcome === 'failed') marks.push('Last run failed');
  if (job.overdue) marks.push('Overdue: no run recorded for more than twice its interval');
  if (marks.length === 0) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-vox-accent-warning" data-testid="job-mark">
      <AlertTriangle size={13} /> {marks.join(' · ')}
    </span>
  );
}

function ModeControl({ job, isSuperAdmin, onChoose }: { job: AdminJob; isSuperAdmin: boolean; onChoose: (mode: JobMode) => void }) {
  if (!job.switchable) {
    return (
      <div className="text-right max-w-xs">
        <p className="text-sm text-vox-text-primary">{MODE_LABELS[job.mode]}</p>
        <p className="text-[11px] text-vox-text-muted" data-testid="job-mode-reason">Cannot be switched. {job.notSwitchableReason}</p>
      </div>
    );
  }
  if (!isSuperAdmin) {
    return (
      <div className="text-right max-w-xs">
        <p className="text-sm text-vox-text-primary">{MODE_LABELS[job.mode]}</p>
        <p className="text-[11px] text-vox-text-muted" data-testid="job-mode-reason">Only a super admin can switch a job.</p>
      </div>
    );
  }
  const modes: JobMode[] = job.supportsCountOnly || job.mode === 'count' ? ['off', 'count', 'on'] : ['off', 'on'];
  return (
    <select
      aria-label={`Mode of ${job.title}`}
      value={job.mode}
      onChange={(e) => onChoose(e.target.value as JobMode)}
      className="px-2 py-1 text-sm rounded-md bg-vox-bg-hover border border-vox-border text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
    >
      {modes.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
    </select>
  );
}

function RunsPanel({ job }: { job: AdminJob }) {
  const { jobRuns, fetchJobRuns } = useAdminStore();
  const state = jobRuns[job.name];
  if (!state || (state.loading && state.runs.length === 0)) {
    return <p className="text-xs text-vox-text-muted py-2">Loading runs...</p>;
  }
  if (state.error && state.runs.length === 0) {
    return <p className="text-xs text-vox-accent-danger py-2">The runs could not be loaded.</p>;
  }
  if (state.runs.length === 0) {
    return <p className="text-xs text-vox-text-muted py-2">No run recorded yet.</p>;
  }
  return (
    <div className="mt-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label={`Runs of ${job.title}`}>
          <thead>
            <tr className="border-b border-vox-border">
              {['Started', 'Took', 'Outcome', 'Mode', 'Node', 'Counts'].map((label) => (
                <th key={label} className="px-3 py-2 text-left text-xs font-medium text-vox-text-muted uppercase">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.runs.map((run) => (
              <Fragment key={run.id}>
                <tr className="border-b border-vox-border/50" data-run-id={run.id}>
                  <td className="px-3 py-2 text-xs text-vox-text-secondary whitespace-nowrap">{new Date(run.startedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-vox-text-secondary whitespace-nowrap">{formatDuration(run.durationMs)}</td>
                  <td className="px-3 py-2"><OutcomeBadge run={run} /></td>
                  <td className="px-3 py-2 text-xs text-vox-text-secondary">{MODE_LABELS[run.mode]}</td>
                  <td className="px-3 py-2 text-xs text-vox-text-muted font-mono">{run.nodeId}</td>
                  <td className="px-3 py-2 text-xs text-vox-text-secondary">{formatSummary(run.summary) || <span className="text-vox-text-muted">—</span>}</td>
                </tr>
                {run.error && (
                  <tr className="border-b border-vox-border/50" data-run-error={run.id}>
                    <td colSpan={6} className="px-3 pb-2">
                      <code className="block whitespace-pre-wrap break-words text-xs bg-vox-bg-hover text-vox-accent-danger px-2 py-1 rounded font-mono">{run.error}</code>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {state.error && <p className="text-xs text-vox-accent-danger mt-2">The next runs could not be loaded.</p>}
      {state.nextCursor && (
        <button
          onClick={() => fetchJobRuns(job.name, true)}
          disabled={state.loading}
          className="mt-2 text-xs px-2.5 py-1.5 rounded border border-vox-border text-vox-text-secondary hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
        >
          {state.loading ? 'Loading...' : 'Load older runs'}
        </button>
      )}
    </div>
  );
}

function LastRun({ run }: { run: AdminJobRun | null }) {
  if (!run) return <p className="text-vox-text-muted">No run recorded yet</p>;
  return (
    <p className="text-vox-text-primary flex flex-wrap items-center gap-1.5">
      <OutcomeBadge run={run} />
      <span>{new Date(run.startedAt).toLocaleString()}</span>
      <span className="text-vox-text-muted">in {formatDuration(run.durationMs)}</span>
    </p>
  );
}

function nextRunText(job: AdminJob): string {
  if (job.nextRunAt) return new Date(job.nextRunAt).toLocaleString();
  if (job.mode === 'off') return 'None while off';
  return job.schedule.kind === 'interval' ? 'Counted from each node\'s start' : '—';
}

/** What a switch to `mode` means, in the confirmation. */
function switchLead(job: AdminJob, mode: JobMode): string {
  if (mode === 'off') return `"${job.title}" stops running on every node from its next tick, until it is switched on again.`;
  if (mode === 'count') return `"${job.title}" works out what it would do from its next tick, and records the counts without doing it.`;
  return `"${job.title}" runs again on every node from its next tick.`;
}

/**
 * Every scheduled job of the server (GET /admin/jobs): what it does, its
 * schedule, its mode, its last run and its next slot, and on demand its
 * runs. Every administrator can look; only a superadmin gets the switch,
 * through the confirmation dialog, and a refused switch changes nothing on
 * screen (the control shows the mode the server holds).
 */
export function AdminJobs() {
  const { jobs, jobsError, fetchJobs, fetchJobRuns, setJobMode } = useAdminStore();
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'superadmin');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<{ job: AdminJob; mode: JobMode } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetchJobs();
      for (const name of open) await fetchJobRuns(name);
    } finally {
      setRefreshing(false);
    }
  };

  const toggle = (job: AdminJob) => {
    const next = new Set(open);
    if (next.has(job.name)) {
      next.delete(job.name);
    } else {
      next.add(job.name);
      fetchJobRuns(job.name);
    }
    setOpen(next);
  };

  const choose = (job: AdminJob, mode: JobMode) => {
    if (mode === job.mode) return;
    setPending({ job, mode });
  };

  const confirm = async () => {
    if (!pending) return;
    const { job, mode } = pending;
    // A refused switch toasts the server's reason (the store) and leaves the dialog open
    if (await setJobMode(job.name, mode)) {
      toast.success(`"${job.title}" is now ${MODE_LABELS[mode].toLowerCase()}`);
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-vox-text-primary flex items-center gap-2">
          <Clock size={20} /> Jobs
        </h2>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <p className="text-xs text-vox-text-muted">
        Every scheduled job of the server. A switch takes effect at each node&apos;s next tick, without a restart; only a super admin can switch a job.
      </p>

      {jobs === null && !jobsError && <div className="text-center py-8 text-sm text-vox-text-muted">Loading jobs...</div>}
      {jobs === null && jobsError && <div className="text-center py-8 text-sm text-vox-accent-danger">The jobs could not be loaded.</div>}

      <div className="grid gap-3">
        {jobs?.map((job) => (
          <div
            key={job.name}
            className={clsx('rounded-lg bg-vox-bg-secondary border p-4', job.lastRun?.outcome === 'failed' || job.overdue ? 'border-vox-accent-warning/60' : 'border-vox-border')}
            data-job={job.name}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-vox-text-primary">{job.title}</span>
                  <span className="text-[10px] text-vox-text-muted">{job.name}</span>
                  <JobMarks job={job} />
                </div>
                <p className="text-xs text-vox-text-secondary mt-1">{job.description}</p>
              </div>
              <ModeControl job={job} isSuperAdmin={isSuperAdmin} onChoose={(mode) => choose(job, mode)} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs mt-3">
              <div>
                <p className="text-vox-text-muted">Schedule</p>
                <p className="text-vox-text-primary">{job.scheduleText}</p>
              </div>
              <div>
                <p className="text-vox-text-muted">Last run</p>
                <LastRun run={job.lastRun} />
              </div>
              <div>
                <p className="text-vox-text-muted">Next run</p>
                <p className="text-vox-text-primary">{nextRunText(job)}</p>
              </div>
            </div>

            {job.setAt && (
              <p className="text-[11px] text-vox-text-muted mt-2">
                Set to {MODE_LABELS[job.mode].toLowerCase()} by {job.setBy?.username ?? 'a deleted account'} on {new Date(job.setAt).toLocaleString()}
              </p>
            )}
            {job.lastFailure && job.lastRun?.outcome !== 'failed' && (
              <p className="text-[11px] text-vox-text-muted mt-1">Last failure {new Date(job.lastFailure.startedAt).toLocaleString()}</p>
            )}

            <button
              onClick={() => toggle(job)}
              aria-expanded={open.has(job.name)}
              className="mt-3 flex items-center gap-1 text-xs text-vox-text-secondary hover:text-vox-text-primary transition-colors"
            >
              {open.has(job.name) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {open.has(job.name) ? 'Hide runs' : 'Show runs'}
            </button>
            {open.has(job.name) && <RunsPanel job={job} />}
          </div>
        ))}
      </div>

      {pending && (
        <AdminConfirmModal
          title={`Switch "${pending.job.title}" ${MODE_LABELS[pending.mode].toLowerCase()}`}
          message={(
            <div className="space-y-2">
              <p>{switchLead(pending.job, pending.mode)}</p>
              <p className="text-vox-text-muted">{pending.job.description}</p>
            </div>
          )}
          confirmLabel={`Switch ${MODE_LABELS[pending.mode].toLowerCase()}`}
          variant={pending.mode === 'off' ? 'danger' : 'primary'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
