import { useEffect, useState } from 'react';
import { ArrowLeft, Ban, ShieldOff, Trash2, Globe, ShieldCheck, ShieldMinus, Heart, Sparkles, Crown } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useAdminStore } from '../stores/adminStore';
import { AdminConfirmModal } from './AdminConfirmModal';
import { AdminDeleteUserModal } from './AdminDeleteUserModal';
import { toast } from '../stores/toastStore';

interface Props {
  userId: string;
  onBack: () => void;
}

export function AdminUserDetail({ userId, onBack }: Props) {
  const { selectedUser, fetchUserDetail, banUser, unbanUser, deleteUser, updateUserRole, toggleSupporter } = useAdminStore();
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'superadmin';
  const [confirmAction, setConfirmAction] = useState<'ban' | 'unban' | 'delete' | 'deleteWithTransfer' | 'promote' | 'demote' | null>(null);
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
            {selectedUser.isSupporter && (
              <span className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                selectedUser.supporterTier === 'first' ? 'bg-amber-500/20 text-amber-400' :
                selectedUser.supporterTier === 'top' ? 'bg-purple-500/20 text-purple-400' :
                'bg-pink-500/20 text-pink-400'
              }`}>
                {selectedUser.supporterTier === 'first' ? <Sparkles size={10} /> :
                 selectedUser.supporterTier === 'top' ? <Crown size={10} /> :
                 <Heart size={10} />}
                {selectedUser.supporterTier === 'first' ? 'First Supporter' :
                 selectedUser.supporterTier === 'top' ? 'Top Supporter' :
                 'Supporter'}
              </span>
            )}
            {selectedUser.bannedAt && (
              <span className="text-xs px-2 py-1 rounded bg-vox-accent-danger/20 text-vox-accent-danger">BANNED</span>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
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
              <div>
                <p className="text-vox-text-muted">Owned Servers</p>
                <p className="text-vox-text-primary">{selectedUser._count.ownedServers ?? 0}</p>
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
          <div className="mt-6 flex flex-wrap gap-3">
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
              onClick={() => setConfirmAction(
                (selectedUser._count?.ownedServers ?? 0) > 0 ? 'deleteWithTransfer' : 'delete'
              )}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30"
            >
              <Trash2 size={14} /> Delete User
            </button>

            {isSuperAdmin && (
              selectedUser.role === 'admin' ? (
                <button
                  onClick={() => setConfirmAction('demote')}
                  className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-orange-500/20 text-orange-400 hover:bg-orange-500/30"
                >
                  <ShieldMinus size={14} /> Demote to User
                </button>
              ) : (
                <button
                  onClick={() => setConfirmAction('promote')}
                  className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-vox-accent-primary/20 text-vox-accent-primary hover:bg-vox-accent-primary/30"
                >
                  <ShieldCheck size={14} /> Promote to Admin
                </button>
              )
            )}

            <button
              onClick={async () => {
                try {
                  await toggleSupporter(selectedUser.id, !selectedUser.isSupporter);
                  await fetchUserDetail(selectedUser.id);
                  toast.success(selectedUser.isSupporter ? 'Supporter badge removed' : 'Supporter badge granted');
                } catch {
                  toast.error('Failed to update supporter status');
                }
              }}
              className={`flex items-center gap-2 px-4 py-2 text-sm rounded-md ${
                selectedUser.isSupporter
                  ? 'bg-pink-500/20 text-pink-400 hover:bg-pink-500/30'
                  : 'bg-vox-bg-tertiary text-vox-text-secondary hover:bg-vox-bg-hover'
              }`}
            >
              <Heart size={14} /> {selectedUser.isSupporter ? 'Remove Supporter' : 'Grant Supporter'}
            </button>

            {selectedUser.isSupporter && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-vox-text-muted">Tier:</span>
                {([
                  { value: null, label: 'Regular', icon: Heart, active: 'bg-pink-500/20 text-pink-400 ring-1 ring-pink-500/50' },
                  { value: 'first', label: 'First', icon: Sparkles, active: 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/50' },
                  { value: 'top', label: 'Top', icon: Crown, active: 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/50' },
                ] as const).map(({ value, label, icon: Icon, active }) => (
                  <button
                    key={label}
                    onClick={async () => {
                      try {
                        await toggleSupporter(selectedUser.id, true, value);
                        await fetchUserDetail(selectedUser.id);
                        toast.success(`Supporter tier set to ${label}`);
                      } catch {
                        toast.error('Failed to update supporter tier');
                      }
                    }}
                    className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
                      (selectedUser.supporterTier ?? null) === value
                        ? active
                        : 'bg-vox-bg-tertiary text-vox-text-muted hover:bg-vox-bg-hover'
                    }`}
                    title={`Set tier to ${label}`}
                  >
                    <Icon size={12} /> {label}
                  </button>
                ))}
              </div>
            )}
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

      {confirmAction === 'deleteWithTransfer' && (
        <AdminDeleteUserModal
          userId={selectedUser.id}
          username={selectedUser.username}
          onSuccess={() => {
            setConfirmAction(null);
            onBack();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {confirmAction === 'promote' && (
        <AdminConfirmModal
          title="Promote to Admin"
          message={`Promote "${selectedUser.username}" to admin? They will have full access to the admin dashboard.`}
          confirmLabel="Promote"
          danger={false}
          onConfirm={async () => {
            try {
              await updateUserRole(selectedUser!.id, 'admin');
              toast.success(`${selectedUser!.username} promoted to admin`);
              fetchUserDetail(userId);
            } catch { toast.error('Failed to promote user'); }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {confirmAction === 'demote' && (
        <AdminConfirmModal
          title="Demote to User"
          message={`Demote "${selectedUser.username}" to regular user? They will lose access to the admin dashboard.`}
          confirmLabel="Demote"
          onConfirm={async () => {
            try {
              await updateUserRole(selectedUser!.id, 'user');
              toast.success(`${selectedUser!.username} demoted to user`);
              fetchUserDetail(userId);
            } catch { toast.error('Failed to demote user'); }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
