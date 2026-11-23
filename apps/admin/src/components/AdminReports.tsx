import { useEffect, useCallback, useState } from 'react';
import { Flag, MessageSquare, User, Server as ServerIcon, Ban } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';
import { apiErrorMessage, isNotFound } from '../utils/apiError';
import type { Report } from '@voxium/shared';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  resolved: 'bg-green-500/20 text-green-400',
  dismissed: 'bg-gray-500/20 text-gray-400',
};

const TYPE_ICONS: Record<string, typeof MessageSquare> = {
  message: MessageSquare,
  user: User,
  server: ServerIcon,
};

/**
 * A report outlives an account that is deleted (the server keeps it for a
 * fixed period, then deletes it): its side of that account is null. The
 * reported side keeps the username the report was filed against.
 */
function reportedAccountDeleted(report: Report): boolean {
  return report.reportedUserId === null;
}

/** The day a kept report will be deleted, or null while none of its accounts is deleted. */
function expiryDate(report: Report): string | null {
  return report.expiresAt ? new Date(report.expiresAt).toLocaleDateString() : null;
}

/** A server report snapshots the listing as "name\n\ndescription": the first line names it. */
function listingName(report: Report): string {
  const first = report.messageContent?.split('\n')[0]?.trim();
  return first || 'this server';
}

export function AdminReports() {
  const {
    reports, reportsTotal, reportsPage, reportsFilter,
    fetchReports, setReportsFilter, resolveReport, dismissReport, setServerDiscovery,
    subscribeReports, unsubscribeReports,
  } = useAdminStore();

  const [resolveModal, setResolveModal] = useState<Report | null>(null);
  // The report the resolve dialog is open on, as the list holds it NOW: a
  // refresh while the dialog is open (its reported account deleted meanwhile)
  // shows in the dialog, and in what it sends
  const resolving = resolveModal ? (reports.find((r) => r.id === resolveModal.id) ?? resolveModal) : null;
  const [resolution, setResolution] = useState('');
  const [banOnResolve, setBanOnResolve] = useState(false);
  // The ban box ticked counts only while there is someone to ban: never a ban
  // of a deleted account, which the dialog then offers no box for and the
  // server refuses
  const banning = banOnResolve && resolving !== null && !reportedAccountDeleted(resolving);
  const [deleteOnResolve, setDeleteOnResolve] = useState(false);
  // The delete box ticked counts only while the report still names a message:
  // the link goes when the message does, the box goes with it, and neither the
  // label nor the request may then speak of a delete
  const deleting = deleteOnResolve && resolving !== null && resolving.type === 'message' && !!resolving.messageId;
  const [dismissModal, setDismissModal] = useState<Report | null>(null);
  // "Block from directory" shortcut on a server report: hides the listing
  // and stops the owner relisting; the report itself stays open.
  const [blockModal, setBlockModal] = useState<Report | null>(null);
  const blockServerId = blockModal?.serverId ?? null;
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
    if (!resolveModal || !resolving) return;
    // The store reports a failure itself and resolves false: the modal stays open for another try.
    const done = await resolveReport(resolveModal.id, {
      resolution: resolution || 'Resolved',
      ...(banning ? { action: 'ban' } : {}),
      ...(deleting ? { deleteMessage: true } : {}),
    });
    if (!done) return;
    setResolveModal(null);
    setResolution('');
    setBanOnResolve(false);
    setDeleteOnResolve(false);
  };

  const handleDismiss = async () => {
    if (!dismissModal) return;
    // The store reports a failure itself and resolves false: the modal stays open for another try.
    if (await dismissReport(dismissModal.id)) setDismissModal(null);
  };

  const columns = [
    { key: 'type', label: 'Type', width: '80px' },
    { key: 'reporter', label: 'Reporter', width: '120px' },
    { key: 'reported', label: 'Reported', width: '120px' },
    { key: 'reason', label: 'Reason' },
    { key: 'status', label: 'Status', width: '100px' },
    { key: 'created', label: 'Created', width: '140px' },
    { key: 'actions', label: 'Actions', width: '240px' },
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
      reporter: report.reporterId === null ? (
        <span className="text-xs italic text-vox-text-muted" data-testid="report-reporter-deleted">Deleted account</span>
      ) : (
        <span className="text-vox-text-primary text-xs font-medium">{report.reporterUsername}</span>
      ),
      reported: (
        <span className="text-vox-text-primary text-xs font-medium">
          {report.reportedUsername}
          {report.type === 'server' && (
            <span className="block text-[10px] font-normal text-vox-text-muted" data-testid="report-owner-label">server owner</span>
          )}
          {reportedAccountDeleted(report) && (
            <span className="block text-[10px] font-normal italic text-vox-text-muted" data-testid="report-reported-deleted">Deleted account</span>
          )}
        </span>
      ),
      reason: (
        <div>
          <span className="text-xs text-vox-text-secondary line-clamp-2">{report.reason}</span>
          {(report.type === 'message' || report.type === 'server') && report.messageContent && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpandedReport(expandedReport === report.id ? null : report.id); }}
              className="text-[10px] text-vox-accent-primary hover:underline mt-0.5"
              data-testid="report-toggle-content"
            >
              {report.type === 'server'
                ? (expandedReport === report.id ? 'Hide listing' : 'Show listing')
                : (expandedReport === report.id ? 'Hide message' : 'Show message')}
            </button>
          )}
          {expandedReport === report.id && report.messageContent && (
            <div
              className={`mt-1 p-2 rounded text-xs border ${
                report.contentSource === 'reporter'
                  ? 'bg-vox-accent-warning/10 border-vox-accent-warning/40 text-vox-text-secondary'
                  : 'bg-vox-bg-hover border-vox-border text-vox-text-muted'
              }`}
            >
              {report.contentSource === 'reporter' && (
                <div className="mb-1 font-medium text-vox-accent-warning">
                  Supplied by the reporter — this conversation is end-to-end encrypted, so the
                  server cannot verify this text against the stored message.
                </div>
              )}
              {report.type === 'server' && (
                <div className="mb-1 font-medium text-vox-text-secondary">
                  Listing as reported (name and description at the time)
                </div>
              )}
              <span className="whitespace-pre-wrap" data-testid="report-content">{report.messageContent}</span>
            </div>
          )}
        </div>
      ),
      status: (
        <div>
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[report.status] || ''}`}>
            {report.status}
          </span>
          {expiryDate(report) && (
            <span
              className="block mt-0.5 text-[10px] text-vox-text-muted"
              title="Kept after the deletion of an account it concerns, for a fixed period"
              data-testid="report-expires"
            >
              Will be deleted on {expiryDate(report)}
            </span>
          )}
        </div>
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
          {report.type === 'server' && report.serverId && (
            <button
              onClick={(e) => { e.stopPropagation(); setBlockModal(report); }}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 transition-colors"
              title="Block from directory"
              data-testid="report-block-server"
            >
              <Ban size={11} /> Block
            </button>
          )}
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
      {resolving && (
        <AdminConfirmModal
          title="Resolve Report"
          message={
            <div className="space-y-3">
              <p className="text-sm text-vox-text-secondary">
                {resolving.type === 'server' ? 'Server owner' : 'Reported user'}: <strong>{resolving.reportedUsername}</strong>
                {reportedAccountDeleted(resolving) && ' (deleted account)'}
              </p>
              <p className="text-sm text-vox-text-secondary">
                Reason: {resolving.reason}
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
              {resolving.type === 'message' && resolving.messageId && (
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
              {reportedAccountDeleted(resolving) ? (
                // A deleted account cannot be banned: no ban control at all,
                // and the reason in its place
                <p className="text-xs text-vox-text-muted" data-testid="report-ban-unavailable">
                  The reported account has been deleted, so there is no one to ban.
                  {expiryDate(resolving) && ` This report will be deleted on ${expiryDate(resolving)}.`}
                </p>
              ) : (
                <label className="flex items-center gap-2 text-xs text-vox-text-secondary">
                  <input
                    type="checkbox"
                    checked={banOnResolve}
                    onChange={(e) => setBanOnResolve(e.target.checked)}
                    className="rounded"
                  />
                  {resolving.type === 'server'
                    ? 'Ban the server owner (a platform ban also hides every server they own)'
                    : 'Ban reported user'}
                </label>
              )}
            </div>
          }
          confirmLabel={banning ? 'Resolve & Ban' : deleting ? 'Resolve & Delete' : 'Resolve'}
          variant={banning ? 'danger' : 'primary'}
          dismissible={false}
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

      {/* Block-from-directory shortcut (server reports) */}
      {blockModal && blockServerId && (
        <AdminConfirmModal
          title="Block from directory"
          message={`Hide "${listingName(blockModal)}" from Explore and stop its owner from relisting it until an admin unblocks it (Servers tab)? If it is featured it loses its Featured spot, which Unblock does not restore. The report stays open: resolve or dismiss it separately.`}
          confirmLabel="Block"
          onConfirm={async () => {
            try {
              await setServerDiscovery(blockServerId, { blocked: true });
              toast.success('Server blocked from the directory');
            } catch (err) {
              toast.error(isNotFound(err) ? 'That server no longer exists' : apiErrorMessage(err, 'Failed to block the server'));
            }
            setBlockModal(null);
          }}
          onCancel={() => setBlockModal(null)}
        />
      )}
    </div>
  );
}
