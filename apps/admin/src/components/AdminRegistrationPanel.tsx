import { useCallback, useEffect, useState } from 'react';
import { UserPlus, RefreshCw, AlertTriangle, Trash2, Eye } from 'lucide-react';
import { api } from '../services/api';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';

interface RegistrationStats {
  lastHour: number;
  last24h: number;
  unverifiedTotal: number;
  topRegisterIps: Array<{ ip: string; registrations: number }>;
  topDomains: Array<{ domain: string; registrations: number }>;
}

interface HygieneRun {
  at: string;
  durationMs: number;
  trigger: 'scheduled' | 'manual';
  deletedUsers: number;
  deletedAvatars: number;
  deletedIpRecords: number;
  dryRun: boolean;
}

interface HygieneStatus {
  lastRun: HygieneRun | null;
  history: HygieneRun[];
  pendingDeletions: number;
  ttlDays: number;
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (secs < 90) return 'just now';
  const mins = secs / 60;
  if (mins < 90) return `${Math.round(mins)} min ago`;
  const hours = mins / 60;
  if (hours < 36) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Registration-abuse triage panel (anti-bot Phase 4): volume over two
 * windows, the unverified backlog, and the IPs registering the most accounts
 * this week. REST + refresh button, per the admin conventions.
 */
export function AdminRegistrationPanel() {
  const [stats, setStats] = useState<RegistrationStats | null>(null);
  const [hygiene, setHygiene] = useState<HygieneStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [confirmSweep, setConfirmSweep] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [statsRes, hygieneRes] = await Promise.all([
        api.get('/admin/registration-stats'),
        api.get('/admin/registration/hygiene'),
      ]);
      setStats(statsRes.data.data);
      setHygiene(hygieneRes.data.data);
    } catch (err) {
      console.error('Failed to load registration stats:', err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runSweep = useCallback(async (dryRun: boolean) => {
    setSweeping(true);
    try {
      const { data } = await api.post(`/admin/registration/hygiene${dryRun ? '?dryRun=1' : ''}`);
      const r = data.data as HygieneRun;
      const summary = `${r.deletedUsers} account${r.deletedUsers === 1 ? '' : 's'}, ${r.deletedAvatars} avatar${r.deletedAvatars === 1 ? '' : 's'}, ${r.deletedIpRecords} IP record${r.deletedIpRecords === 1 ? '' : 's'}`;
      if (dryRun) toast.success(`Dry run: would delete ${summary}`);
      else toast.success(`Swept ${summary}`);
      await load();
    } catch (err) {
      // 409 means a sweep is already running somewhere in the cluster — that is
      // a real answer, not a failure, so say which it was.
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409) toast.error('A sweep is already running. Try again shortly.');
      else toast.error('Failed to run the hygiene sweep');
    } finally {
      setSweeping(false);
      setConfirmSweep(false);
    }
  }, [load]);

  // A busy hour is worth a visual nudge even below the email-alert threshold
  const hot = (stats?.lastHour ?? 0) >= 10;

  return (
    <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4" data-testid="admin-registration-panel">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-vox-text-primary flex items-center gap-2">
          <UserPlus size={14} /> Registrations
          {hot && <AlertTriangle size={13} className="text-vox-accent-warning" />}
        </h3>
        <button
          onClick={load}
          disabled={refreshing}
          className="text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm mb-3">
        <div>
          <p className="text-vox-text-muted">Last hour</p>
          <p className={hot ? 'text-vox-accent-warning font-semibold' : 'text-vox-text-primary'}>{stats?.lastHour ?? '—'}</p>
        </div>
        <div>
          <p className="text-vox-text-muted">Last 24h</p>
          <p className="text-vox-text-primary">{stats?.last24h ?? '—'}</p>
        </div>
        <div>
          <p className="text-vox-text-muted">Unverified accounts</p>
          <p className="text-vox-text-primary">{stats?.unverifiedTotal ?? '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {stats && stats.topRegisterIps.length > 0 && (
          <div>
            <p className="text-xs text-vox-text-muted mb-1.5">Top registering IPs (7 days)</p>
            <div className="space-y-1">
              {stats.topRegisterIps.map((row) => (
                <div key={row.ip} className="flex items-center justify-between text-xs">
                  <code className="font-mono bg-vox-bg-hover px-2 py-0.5 rounded text-vox-text-primary">{row.ip}</code>
                  <span className={row.registrations > 3 ? 'text-vox-accent-warning' : 'text-vox-text-muted'}>
                    {row.registrations} account{row.registrations === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {stats && stats.topDomains.length > 0 && (
          <div>
            <p className="text-xs text-vox-text-muted mb-1.5">Top email domains (7 days)</p>
            <div className="space-y-1">
              {stats.topDomains.map((row) => (
                <div key={row.domain} className="flex items-center justify-between text-xs">
                  <code className="font-mono bg-vox-bg-hover px-2 py-0.5 rounded text-vox-text-primary">{row.domain}</code>
                  <span className="text-vox-text-muted">
                    {row.registrations} account{row.registrations === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Unverified-account TTL sweep. It runs itself nightly at 04:30; this
          says when it last did and lets an operator not wait for that. */}
      <div className="mt-4 pt-3 border-t border-vox-border">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs">
            <p className="text-vox-text-muted mb-0.5">
              Unverified-account cleanup ({hygiene?.ttlDays ?? 7}-day TTL)
            </p>
            {hygiene?.lastRun ? (
              <p className="text-vox-text-primary">
                Last run {timeAgo(hygiene.lastRun.at)} ({hygiene.lastRun.trigger}) —
                {' '}deleted {hygiene.lastRun.deletedUsers} account{hygiene.lastRun.deletedUsers === 1 ? '' : 's'},
                {' '}{hygiene.lastRun.deletedAvatars} avatar{hygiene.lastRun.deletedAvatars === 1 ? '' : 's'},
                {' '}{hygiene.lastRun.deletedIpRecords} IP record{hygiene.lastRun.deletedIpRecords === 1 ? '' : 's'}
                {' '}in {hygiene.lastRun.durationMs}ms
              </p>
            ) : (
              <p className="text-vox-accent-warning">Never run on this deployment</p>
            )}
            {hygiene && (
              <p className="text-vox-text-muted mt-0.5">
                {hygiene.pendingDeletions} account{hygiene.pendingDeletions === 1 ? '' : 's'} queued for the next sweep
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runSweep(true)}
              disabled={sweeping}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-vox-border text-vox-text-secondary hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
              title="Report what would be deleted, without deleting it"
            >
              <Eye size={12} /> Dry run
            </button>
            <button
              onClick={() => setConfirmSweep(true)}
              disabled={sweeping || (hygiene?.pendingDeletions ?? 0) === 0}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-vox-border text-vox-text-secondary hover:text-vox-accent-danger hover:bg-vox-bg-hover transition-colors disabled:opacity-40"
              title="Run the nightly sweep now"
            >
              <Trash2 size={12} /> Run now
            </button>
          </div>
        </div>
      </div>

      {confirmSweep && hygiene && (
        <AdminConfirmModal
          title="Run unverified-account cleanup"
          message={`This permanently deletes ${hygiene.pendingDeletions} account${hygiene.pendingDeletions === 1 ? '' : 's'} that never verified their email address and are older than ${hygiene.ttlDays} days, along with their avatars. Accounts holding a role other than 'user', and any that own a server, are never touched. This is the same sweep that runs nightly at 04:30 — running it now only makes it happen sooner. This action is irreversible.`}
          confirmLabel="Run cleanup"
          danger
          onConfirm={() => runSweep(false)}
          onCancel={() => setConfirmSweep(false)}
        />
      )}
    </div>
  );
}
