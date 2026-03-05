import { useEffect, useCallback, useState } from 'react';
import { Flag, MessageSquare, User } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import type { Report } from '@voxium/shared';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  resolved: 'bg-green-500/20 text-green-400',
  dismissed: 'bg-gray-500/20 text-gray-400',
};

const TYPE_ICONS: Record<string, typeof MessageSquare> = {
  message: MessageSquare,
  user: User,
};

export function AdminReports() {
  const {
    reports, reportsTotal, reportsPage, reportsFilter,
    fetchReports, setReportsFilter, resolveReport, dismissReport,
    subscribeReports, unsubscribeReports,
  } = useAdminStore();

  const [resolveModal, setResolveModal] = useState<Report | null>(null);
  const [resolution, setResolution] = useState('');
  const [banOnResolve, setBanOnResolve] = useState(false);
  const [deleteOnResolve, setDeleteOnResolve] = useState(false);
  const [dismissModal, setDismissModal] = useState<Report | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);

  useEffect(() => {
    fetchReports(1);
    subscribeReports();
    return () => unsubscribeReports();
  }, [fetchReports, subscribeReports, unsubscribeReports]);

  const handleFilterChange = useCallback((filter: string) => {
    setReportsFilter(filter);
    useAdminStore.getState().fetchReports(1);
  }, [setReportsFilter]);

  const handleResolve = async () => {
    if (!resolveModal) return;
    try {
      await resolveReport(resolveModal.id, {
        resolution: resolution || 'Resolved',
        ...(banOnResolve ? { action: 'ban' } : {}),
        ...(deleteOnResolve ? { deleteMessage: true } : {}),
      });
      setResolveModal(null);
      setResolution('');
      setBanOnResolve(false);
      setDeleteOnResolve(false);
    } catch {
      // Error handled by store
    }
  };

  const handleDismiss = async () => {
    if (!dismissModal) return;
    try {
      await dismissReport(dismissModal.id);
      setDismissModal(null);
    } catch {
      // Error handled by store
    }
  };

  const columns = [
    { key: 'type', label: 'Type', width: '80px' },
    { key: 'reporter', label: 'Reporter', width: '120px' },
    { key: 'reported', label: 'Reported', width: '120px' },
    { key: 'reason', label: 'Reason' },
    { key: 'status', label: 'Status', width: '100px' },
    { key: 'created', label: 'Created', width: '140px' },
    { key: 'actions', label: 'Actions', width: '180px' },
  ];

  const rows = reports.map((report) => {
    const TypeIcon = TYPE_ICONS[report.type] || Flag;
    return {
      type: (
        <span className="inline-flex items-center gap-1 text-xs text-vox-text-secondary">
          <TypeIcon size={12} />
          {report.type}
        </span>
      ),
      reporter: (
        <span className="text-vox-text-primary text-xs font-medium">{report.reporterUsername}</span>
      ),
      reported: (
        <span className="text-vox-text-primary text-xs font-medium">{report.reportedUsername}</span>
      ),
      reason: (
        <div>
          <span className="text-xs text-vox-text-secondary line-clamp-2">{report.reason}</span>
          {report.type === 'message' && report.messageContent && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpandedReport(expandedReport === report.id ? null : report.id); }}
              className="text-[10px] text-vox-accent-primary hover:underline mt-0.5"
            >
              {expandedReport === report.id ? 'Hide message' : 'Show message'}
            </button>
          )}
          {expandedReport === report.id && report.messageContent && (
            <div className="mt-1 p-2 rounded bg-vox-bg-hover text-xs text-vox-text-muted border border-vox-border">
              {report.messageContent}
            </div>
          )}
        </div>
      ),
      status: (
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[report.status] || ''}`}>
          {report.status}
        </span>
      ),
      created: (
        <span className="text-xs">{new Date(report.createdAt).toLocaleString()}</span>
      ),
      actions: report.status === 'pending' ? (
        <div className="flex gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); setResolveModal(report); }}
            className="px-2 py-1 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
          >
            Resolve
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setDismissModal(report); }}
            className="px-2 py-1 text-xs rounded bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 transition-colors"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <span className="text-xs text-vox-text-muted">
          {report.resolvedByUsername ? `By ${report.resolvedByUsername}` : '-'}
        </span>
      ),
    };
  });

  const FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'dismissed', label: 'Dismissed' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-vox-text-primary flex items-center gap-2">
          <Flag size={20} />
          Moderation Queue
        </h2>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => handleFilterChange(f.value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              reportsFilter === f.value
                ? 'bg-vox-accent-primary/20 text-vox-accent-primary'
                : 'text-vox-text-secondary hover:bg-vox-bg-hover hover:text-vox-text-primary'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
        <AdminTable
          columns={columns}
          rows={rows}
          page={reportsPage}
          total={reportsTotal}
          onPageChange={(p) => fetchReports(p)}
        />
      </div>

      {/* Resolve Modal */}
      {resolveModal && (
        <AdminConfirmModal
          title="Resolve Report"
          message={
            <div className="space-y-3">
              <p className="text-sm text-vox-text-secondary">
                Reported user: <strong>{resolveModal.reportedUsername}</strong>
              </p>
              <p className="text-sm text-vox-text-secondary">
                Reason: {resolveModal.reason}
              </p>
              <div>
                <label className="block text-xs text-vox-text-muted mb-1">Resolution note</label>
                <textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="w-full resize-none rounded-md border border-vox-border bg-vox-bg-hover px-3 py-2 text-sm text-vox-text-primary focus:border-vox-accent-primary focus:outline-none"
                  rows={2}
                  placeholder="Describe the resolution..."
                />
              </div>
              {resolveModal.type === 'message' && resolveModal.messageId && (
                <label className="flex items-center gap-2 text-xs text-vox-text-secondary">
                  <input
                    type="checkbox"
                    checked={deleteOnResolve}
                    onChange={(e) => setDeleteOnResolve(e.target.checked)}
                    className="rounded"
                  />
                  Delete reported message
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-vox-text-secondary">
                <input
                  type="checkbox"
                  checked={banOnResolve}
                  onChange={(e) => setBanOnResolve(e.target.checked)}
                  className="rounded"
                />
                Ban reported user
              </label>
            </div>
          }
          confirmLabel={banOnResolve ? 'Resolve & Ban' : deleteOnResolve ? 'Resolve & Delete' : 'Resolve'}
          variant={banOnResolve ? 'danger' : 'primary'}
          onConfirm={handleResolve}
          onCancel={() => { setResolveModal(null); setResolution(''); setBanOnResolve(false); setDeleteOnResolve(false); }}
        />
      )}

      {/* Dismiss Modal */}
      {dismissModal && (
        <AdminConfirmModal
          title="Dismiss Report"
          message={`Dismiss report against ${dismissModal.reportedUsername}? This marks it as reviewed but takes no action.`}
          confirmLabel="Dismiss"
          variant="primary"
          onConfirm={handleDismiss}
          onCancel={() => setDismissModal(null)}
        />
      )}
    </div>
  );
}
