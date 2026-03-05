import { useEffect, useState } from 'react';
import { X, ArrowRightLeft, Trash2, AlertTriangle } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import type { OwnedServerInfo, ServerAction } from '../stores/adminStore';
import { toast } from '../stores/toastStore';

interface Props {
  userId: string;
  username: string;
  onSuccess: () => void;
  onCancel: () => void;
}

interface ServerRow {
  server: OwnedServerInfo;
  action: 'transfer' | 'delete';
  newOwnerId: string;
}

export function AdminDeleteUserModal({ userId, username, onSuccess, onCancel }: Props) {
  const { fetchUserOwnedServers, deleteUserWithTransfers } = useAdminStore();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<ServerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUserOwnedServers(userId)
      .then((servers) => {
        if (cancelled) return;
        setRows(
          servers.map((server) => {
            // Default to first admin member, or first member
            const defaultMember =
              server.members.find((m) => m.role === 'admin' || m.role === 'owner') ??
              server.members[0];
            return {
              server,
              action: server.members.length > 0 ? 'transfer' : 'delete',
              newOwnerId: defaultMember?.userId ?? '',
            };
          })
        );
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load owned servers');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [userId, fetchUserOwnedServers]);

  const updateRow = (index: number, patch: Partial<ServerRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const transferCount = rows.filter((r) => r.action === 'transfer').length;
  const deleteCount = rows.filter((r) => r.action === 'delete').length;

  const canSubmit = rows.every(
    (r) => r.action === 'delete' || (r.action === 'transfer' && r.newOwnerId)
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const serverActions: ServerAction[] = rows.map((r) => ({
        serverId: r.server.id,
        action: r.action,
        ...(r.action === 'transfer' ? { newOwnerId: r.newOwnerId } : {}),
      }));
      await deleteUserWithTransfers(userId, serverActions);
      toast.success('User deleted successfully');
      onSuccess();
    } catch {
      toast.error('Failed to delete user');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-2xl rounded-lg bg-vox-bg-secondary p-6 shadow-xl border border-vox-border max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-vox-text-primary">
            Delete {username}
          </h3>
          <button onClick={onCancel} className="text-vox-text-muted hover:text-vox-text-primary">
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
          </div>
        ) : error ? (
          <p className="text-sm text-vox-accent-danger py-4">{error}</p>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-4 p-3 rounded bg-vox-accent-warning/10 border border-vox-accent-warning/30">
              <AlertTriangle size={16} className="text-vox-accent-warning shrink-0" />
              <p className="text-xs text-vox-text-secondary">
                This user owns {rows.length} server(s). Choose what to do with each before deleting.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
              {rows.map((row, i) => (
                <div key={row.server.id} className="rounded-lg bg-vox-bg-hover border border-vox-border p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-sm font-medium text-vox-text-primary">{row.server.name}</p>
                      <p className="text-xs text-vox-text-muted">{row.server.memberCount} member(s)</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => updateRow(i, { action: 'transfer' })}
                        disabled={row.server.members.length === 0}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
                          row.action === 'transfer'
                            ? 'bg-vox-accent-primary/20 text-vox-accent-primary border border-vox-accent-primary/40'
                            : 'bg-vox-bg-secondary text-vox-text-muted hover:text-vox-text-primary border border-vox-border'
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                      >
                        <ArrowRightLeft size={12} /> Transfer
                      </button>
                      <button
                        onClick={() => updateRow(i, { action: 'delete' })}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
                          row.action === 'delete'
                            ? 'bg-vox-accent-danger/20 text-vox-accent-danger border border-vox-accent-danger/40'
                            : 'bg-vox-bg-secondary text-vox-text-muted hover:text-vox-text-primary border border-vox-border'
                        }`}
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    </div>
                  </div>

                  {row.action === 'transfer' && (
                    <div>
                      <label className="text-xs text-vox-text-muted mb-1 block">Transfer ownership to:</label>
                      <select
                        value={row.newOwnerId}
                        onChange={(e) => updateRow(i, { newOwnerId: e.target.value })}
                        className="w-full rounded-md bg-vox-bg-secondary border border-vox-border text-sm text-vox-text-primary px-3 py-1.5 focus:outline-none focus:border-vox-accent-primary"
                      >
                        {row.server.members.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName} (@{m.username}) — {m.role}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t border-vox-border">
              <p className="text-xs text-vox-text-muted mb-4">
                {transferCount > 0 && `Transfer ${transferCount} server(s)`}
                {transferCount > 0 && deleteCount > 0 && ', '}
                {deleteCount > 0 && `delete ${deleteCount} server(s)`}
                {' '} and permanently delete user "{username}".
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={onCancel}
                  className="px-4 py-2 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit || submitting}
                  className="px-4 py-2 text-sm rounded-md bg-vox-accent-danger text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Deleting...' : 'Confirm & Delete User'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
