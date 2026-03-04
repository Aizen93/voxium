import { useEffect, useState } from 'react';
import { ArrowLeft, Ban, ShieldOff, Trash2, Globe } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';

interface Props {
  userId: string;
  onBack: () => void;
}

export function AdminUserDetail({ userId, onBack }: Props) {
  const { selectedUser, fetchUserDetail, banUser, unbanUser, deleteUser } = useAdminStore();
  const [confirmAction, setConfirmAction] = useState<'ban' | 'unban' | 'delete' | null>(null);
  const [banReason, setBanReason] = useState('');
  const [banIps, setBanIps] = useState(false);

  useEffect(() => {
    fetchUserDetail(userId);
  }, [userId, fetchUserDetail]);

  if (!selectedUser) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-vox-text-muted hover:text-vox-text-primary">
        <ArrowLeft size={16} /> Back to Users
      </button>

      {/* User Info */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-vox-text-primary">{selectedUser.displayName}</h2>
            <p className="text-sm text-vox-text-muted">@{selectedUser.username}</p>
            <p className="text-sm text-vox-text-secondary mt-1">{selectedUser.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded ${
              selectedUser.role === 'superadmin' ? 'bg-yellow-500/20 text-yellow-400' :
              selectedUser.role === 'admin' ? 'bg-vox-accent-primary/20 text-vox-accent-primary' :
              'bg-vox-bg-hover text-vox-text-muted'
            }`}>
              {selectedUser.role}
            </span>
            {selectedUser.bannedAt && (
              <span className="text-xs px-2 py-1 rounded bg-vox-accent-danger/20 text-vox-accent-danger">BANNED</span>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-vox-text-muted">Status</p>
            <p className="text-vox-text-primary">{selectedUser.status}</p>
          </div>
          <div>
            <p className="text-vox-text-muted">Joined</p>
            <p className="text-vox-text-primary">{new Date(selectedUser.createdAt).toLocaleDateString()}</p>
          </div>
          {selectedUser._count && (
            <>
              <div>
                <p className="text-vox-text-muted">Messages</p>
                <p className="text-vox-text-primary">{selectedUser._count.messages?.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-vox-text-muted">Servers</p>
                <p className="text-vox-text-primary">{selectedUser._count.memberships}</p>
              </div>
            </>
          )}
        </div>

        {selectedUser.bannedAt && (
          <div className="mt-4 p-3 rounded bg-vox-accent-danger/10 border border-vox-accent-danger/30">
            <p className="text-xs text-vox-accent-danger font-medium">Banned on {new Date(selectedUser.bannedAt).toLocaleString()}</p>
            {selectedUser.banReason && <p className="text-xs text-vox-text-secondary mt-1">Reason: {selectedUser.banReason}</p>}
          </div>
        )}

        {/* Actions */}
        {selectedUser.role !== 'superadmin' && (
          <div className="mt-6 flex gap-3">
            {selectedUser.bannedAt ? (
              <button
                onClick={() => setConfirmAction('unban')}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-vox-accent-success/20 text-vox-accent-success hover:bg-vox-accent-success/30"
              >
                <ShieldOff size={14} /> Unban
              </button>
            ) : (
              <button
                onClick={() => setConfirmAction('ban')}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-vox-accent-warning/20 text-vox-accent-warning hover:bg-vox-accent-warning/30"
              >
                <Ban size={14} /> Ban User
              </button>
            )}
            <button
              onClick={() => setConfirmAction('delete')}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30"
            >
              <Trash2 size={14} /> Delete User
            </button>
          </div>
        )}
      </div>

      {/* IP History */}
      {selectedUser.ipRecords && selectedUser.ipRecords.length > 0 && (
        <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
          <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
            <Globe size={14} /> IP History
          </h3>
          <div className="space-y-2">
            {selectedUser.ipRecords.map((record, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-1">
                <code className="text-vox-text-primary font-mono text-xs bg-vox-bg-hover px-2 py-0.5 rounded">{record.ip}</code>
                <span className="text-vox-text-muted text-xs">{new Date(record.lastSeenAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ban Modal */}
      {confirmAction === 'ban' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-lg bg-vox-bg-secondary p-6 shadow-xl border border-vox-border">
            <h3 className="text-lg font-semibold text-vox-text-primary mb-4">Ban {selectedUser.username}</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Ban reason (optional)"
                className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary px-3 py-2 placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
              />
              <label className="flex items-center gap-2 text-sm text-vox-text-secondary">
                <input type="checkbox" checked={banIps} onChange={(e) => setBanIps(e.target.checked)} className="rounded" />
                Also ban all known IP addresses
              </label>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setConfirmAction(null)} className="px-4 py-2 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary">Cancel</button>
              <button
                onClick={async () => {
                  try {
                    await banUser(selectedUser!.id, banReason || undefined, banIps);
                    toast.success('User banned');
                    setBanReason('');
                    setBanIps(false);
                    setConfirmAction(null);
                    fetchUserDetail(userId);
                  } catch { toast.error('Failed to ban user'); }
                }}
                className="px-4 py-2 text-sm rounded-md bg-vox-accent-danger text-white hover:bg-red-600"
              >
                Ban
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unban / Delete Confirm */}
      {confirmAction === 'unban' && (
        <AdminConfirmModal
          title="Unban User"
          message={`Remove ban from "${selectedUser.username}"?`}
          confirmLabel="Unban"
          danger={false}
          onConfirm={async () => {
            try {
              await unbanUser(selectedUser!.id);
              toast.success('User unbanned');
              fetchUserDetail(userId);
            } catch { toast.error('Failed to unban user'); }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {confirmAction === 'delete' && (
        <AdminConfirmModal
          title="Delete User"
          message={`Permanently delete "${selectedUser.username}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            try {
              await deleteUser(selectedUser!.id);
              toast.success('User deleted');
              onBack();
            } catch { toast.error('Failed to delete user'); }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
