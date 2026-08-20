import { useCallback, useEffect, useState } from 'react';
import { UserPlus, RefreshCw, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';

interface RegistrationStats {
  lastHour: number;
  last24h: number;
  unverifiedTotal: number;
  topRegisterIps: Array<{ ip: string; registrations: number }>;
  topDomains: Array<{ domain: string; registrations: number }>;
}

/**
 * Registration-abuse triage panel (anti-bot Phase 4): volume over two
 * windows, the unverified backlog, and the IPs registering the most accounts
 * this week. REST + refresh button, per the admin conventions.
 */
export function AdminRegistrationPanel() {
  const [stats, setStats] = useState<RegistrationStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data } = await api.get('/admin/registration-stats');
      setStats(data.data);
    } catch (err) {
      console.error('Failed to load registration stats:', err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
    </div>
  );
}
