import { useEffect, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import type { AuditAction } from '@voxium/shared';

const ACTION_LABELS: Record<AuditAction, string> = {
  'user.ban': 'User Banned',
  'user.unban': 'User Unbanned',
  'user.delete': 'User Deleted',
  'user.role_change': 'Role Changed',
  'server.delete': 'Server Deleted',
  'ip_ban.create': 'IP Banned',
  'ip_ban.delete': 'IP Ban Removed',
  'storage.file_delete': 'File Deleted',
  'storage.cleanup_orphans': 'Orphan Cleanup',
  'announcement.create': 'Announcement Created',
  'announcement.publish': 'Announcement Published',
  'announcement.delete': 'Announcement Deleted',
  'report.resolve': 'Report Resolved',
  'report.dismiss': 'Report Dismissed',
  'support.claim': 'Ticket Claimed',
  'support.close': 'Ticket Closed',
  'ratelimit.update': 'Rate Limit Updated',
  'ratelimit.reset': 'Rate Limit Reset',
  'ratelimit.clear_user': 'User Rate Limits Cleared',
};

const ACTION_COLORS: Record<string, string> = {
  'user.ban': 'bg-red-500/20 text-red-400',
  'user.unban': 'bg-green-500/20 text-green-400',
  'user.delete': 'bg-red-500/20 text-red-400',
  'user.role_change': 'bg-blue-500/20 text-blue-400',
  'server.delete': 'bg-red-500/20 text-red-400',
  'ip_ban.create': 'bg-orange-500/20 text-orange-400',
  'ip_ban.delete': 'bg-green-500/20 text-green-400',
  'storage.file_delete': 'bg-yellow-500/20 text-yellow-400',
  'storage.cleanup_orphans': 'bg-yellow-500/20 text-yellow-400',
  'announcement.create': 'bg-purple-500/20 text-purple-400',
  'announcement.publish': 'bg-green-500/20 text-green-400',
  'announcement.delete': 'bg-red-500/20 text-red-400',
  'report.resolve': 'bg-green-500/20 text-green-400',
  'report.dismiss': 'bg-gray-500/20 text-gray-400',
  'support.claim': 'bg-blue-500/20 text-blue-400',
  'support.close': 'bg-gray-500/20 text-gray-400',
  'ratelimit.update': 'bg-orange-500/20 text-orange-400',
  'ratelimit.reset': 'bg-yellow-500/20 text-yellow-400',
  'ratelimit.clear_user': 'bg-cyan-500/20 text-cyan-400',
};

function formatMetadata(action: AuditAction, metadata: Record<string, unknown> | null): string {
  if (!metadata) return '';
  switch (action) {
    case 'user.ban': {
      const parts: string[] = [];
      if (metadata.reason) parts.push(`Reason: ${metadata.reason}`);
      if (metadata.ipsBanned) parts.push(`${metadata.ipsBanned} IP(s) banned`);
      return parts.join(' | ');
    }
    case 'user.unban':
      return metadata.ipsReleased ? `${metadata.ipsReleased} IP(s) released` : '';
    case 'user.delete':
      if (metadata.serverActions && Array.isArray(metadata.serverActions)) {
        return `Servers: ${(metadata.serverActions as Array<{ action: string }>).map((a) => a.action).join(', ')}`;
      }
      return '';
    case 'user.role_change':
      return `${metadata.username}: ${metadata.oldRole} -> ${metadata.newRole}`;
    case 'server.delete':
      return metadata.serverName ? `"${metadata.serverName}"` : '';
    case 'ip_ban.create':
      return metadata.reason ? `Reason: ${metadata.reason}` : '';
    case 'storage.cleanup_orphans':
      return `Found: ${metadata.found}, Deleted: ${metadata.deleted}`;
    default:
      return '';
  }
}

const ALL_ACTIONS: AuditAction[] = [
  'user.ban', 'user.unban', 'user.delete', 'user.role_change',
  'server.delete',
  'ip_ban.create', 'ip_ban.delete',
  'storage.file_delete', 'storage.cleanup_orphans',
  'announcement.create', 'announcement.publish', 'announcement.delete',
  'report.resolve', 'report.dismiss',
  'support.claim', 'support.close',
  'ratelimit.update', 'ratelimit.reset', 'ratelimit.clear_user',
];

export function AdminAuditLog() {
  const {
    auditLogs, auditLogsTotal, auditLogsPage, auditLogsFilter, auditLogsSearch,
    fetchAuditLogs, setAuditLogsFilter, setAuditLogsSearch,
  } = useAdminStore();

  useEffect(() => {
    fetchAuditLogs(1);
  }, [fetchAuditLogs]);

  const handleFilterChange = useCallback((filter: string) => {
    setAuditLogsFilter(filter);
    useAdminStore.getState().fetchAuditLogs(1);
  }, [setAuditLogsFilter]);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    fetchAuditLogs(1);
  }, [fetchAuditLogs]);

  const columns = [
    { key: 'action', label: 'Action', width: '160px' },
    { key: 'actor', label: 'Actor', width: '140px' },
    { key: 'target', label: 'Target', width: '180px' },
    { key: 'details', label: 'Details' },
    { key: 'time', label: 'Time', width: '160px' },
  ];

  const rows = auditLogs.map((log) => ({
    action: (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[log.action] || 'bg-gray-500/20 text-gray-400'}`}>
        {ACTION_LABELS[log.action] || log.action}
      </span>
    ),
    actor: (
      <span className="text-vox-text-primary font-medium">
        {log.actorUsername || <span className="text-vox-text-muted italic">Deleted</span>}
      </span>
    ),
    target: log.targetType ? (
      <span>
        <span className="text-vox-text-muted text-xs">{log.targetType}:</span>{' '}
        <code className="text-xs bg-vox-bg-hover px-1 py-0.5 rounded font-mono">{log.targetId}</code>
      </span>
    ) : (
      <span className="text-vox-text-muted">-</span>
    ),
    details: (
      <span className="text-xs text-vox-text-muted">
        {formatMetadata(log.action, log.metadata) || '-'}
      </span>
    ),
    time: (
      <span className="text-xs">{new Date(log.createdAt).toLocaleString()}</span>
    ),
  }));

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-vox-text-primary">Audit Log</h2>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-vox-text-muted" />
          <input
            type="text"
            value={auditLogsSearch}
            onChange={(e) => setAuditLogsSearch(e.target.value)}
            placeholder="Search actor or target..."
            className="w-full pl-9 pr-3 py-1.5 text-sm rounded-md bg-vox-bg-hover border border-vox-border text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
          />
        </form>

        <select
          value={auditLogsFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-md bg-vox-bg-hover border border-vox-border text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
        >
          <option value="">All Actions</option>
          {ALL_ACTIONS.map((a) => (
            <option key={a} value={a}>{ACTION_LABELS[a]}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
        <AdminTable
          columns={columns}
          rows={rows}
          page={auditLogsPage}
          total={auditLogsTotal}
          onPageChange={(p) => fetchAuditLogs(p)}
        />
      </div>
    </div>
  );
}
