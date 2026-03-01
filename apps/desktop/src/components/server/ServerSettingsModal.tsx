import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { ImageUploadButton } from '../common/ImageUploadButton';
import { X } from 'lucide-react';
import type { ServerMember, MemberRole } from '@voxium/shared';

interface Props {
  serverId: string;
  onClose: () => void;
}

type Tab = 'general' | 'members';

export function ServerSettingsModal({ serverId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('general');

  const { servers } = useServerStore();
  const server = servers.find((s) => s.id === serverId);
  if (!server) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex w-full max-w-lg flex-col rounded-xl border border-vox-border bg-vox-bg-floating shadow-2xl animate-slide-up" style={{ maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-vox-border px-6 py-4">
          <h2 className="text-lg font-bold text-vox-text-primary">Server Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-vox-border px-6">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'general'
                ? 'text-vox-text-primary border-vox-accent-primary'
                : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('members')}
            className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'members'
                ? 'text-vox-text-primary border-vox-accent-primary'
                : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
            }`}
          >
            Members
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'general' ? (
            <GeneralTab serverId={serverId} onClose={onClose} />
          ) : (
            <MembersTab serverId={serverId} />
          )}
        </div>
      </div>
    </div>
  );
}

function GeneralTab({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const { servers, uploadServerIcon, updateServer, deleteServer } = useServerStore();
  const currentUser = useAuthStore((s) => s.user);
  const server = servers.find((s) => s.id === serverId);

  const [name, setName] = useState(server?.name || '');
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (!server) return null;

  const isOwner = server.ownerId === currentUser?.id;

  const handleSave = async () => {
    setSaving(true);
    try {
      if (iconFile) {
        setUploading(true);
        try {
          await uploadServerIcon(serverId, iconFile);
          setIconFile(null);
        } catch (err: any) {
          toast.error(err.response?.data?.error || 'Failed to upload icon');
          setSaving(false);
          setUploading(false);
          return;
        }
        setUploading(false);
      }

      if (name.trim() && name.trim() !== server.name) {
        await updateServer(serverId, { name: name.trim() });
      }

      toast.success('Server updated');
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update server');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = (name.trim() && name.trim() !== server.name) || iconFile !== null;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteServer(serverId);
      onClose();
      // No toast here — the server:deleted socket event shows one for all clients (including the owner)
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete server');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      {/* Icon */}
      <div className="flex flex-col items-center gap-3 mb-6">
        <ImageUploadButton
          currentImageUrl={server.iconUrl}
          displayName={server.name}
          onFileChange={setIconFile}
          uploading={uploading}
          variant="edit"
        />
      </div>

      {/* Name */}
      <div className="mb-6">
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          Server Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
        />
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={!hasChanges || saving}
        className="btn-primary w-full disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>

      {/* Danger Zone — owner only */}
      {isOwner && (
        <div className="mt-8 border-t border-vox-accent-danger/30 pt-6">
          <h3 className="text-sm font-semibold text-vox-accent-danger mb-1">Danger Zone</h3>
          <p className="text-xs text-vox-text-muted mb-3">
            Deleting a server is permanent and cannot be undone. All channels, messages, and members will be removed.
          </p>

          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-lg border border-vox-accent-danger/50 px-4 py-2 text-sm font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
            >
              Delete Server
            </button>
          ) : (
            <div className="space-y-3 rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
              <p className="text-xs text-vox-text-secondary">
                Type <span className="font-semibold text-vox-text-primary">{server.name}</span> to confirm deletion.
              </p>
              <input
                type="text"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder="Server name"
                className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-danger"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleteConfirmName !== server.name || deleting}
                  className="flex-1 rounded-lg bg-vox-accent-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-vox-accent-danger/80 transition-colors"
                >
                  {deleting ? 'Deleting...' : 'Confirm Delete'}
                </button>
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); }}
                  className="rounded-lg border border-vox-border px-4 py-2 text-sm font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function MembersTab({ serverId }: { serverId: string }) {
  const { members, servers } = useServerStore();
  const currentUser = useAuthStore((s) => s.user);
  const server = servers.find((s) => s.id === serverId);
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const [confirmAction, setConfirmAction] = useState<{ type: 'kick' | 'transfer'; userId: string } | null>(null);

  const isOwner = currentMember?.role === 'owner';
  const isAdmin = currentMember?.role === 'admin';

  const owners = members.filter((m) => m.role === 'owner');
  const admins = members.filter((m) => m.role === 'admin');
  const regularMembers = members.filter((m) => m.role === 'member');
  const sortedMembers = [...owners, ...admins, ...regularMembers];

  async function handleRoleChange(memberId: string, newRole: MemberRole) {
    try {
      await useServerStore.getState().updateMemberRole(serverId, memberId, newRole);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update role');
    }
  }

  async function handleKick(memberId: string) {
    if (!confirmAction || confirmAction.type !== 'kick' || confirmAction.userId !== memberId) {
      setConfirmAction({ type: 'kick', userId: memberId });
      return;
    }
    try {
      await useServerStore.getState().kickMember(serverId, memberId);
      setConfirmAction(null);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to kick member');
    }
  }

  async function handleTransfer(targetUserId: string) {
    if (!confirmAction || confirmAction.type !== 'transfer' || confirmAction.userId !== targetUserId) {
      setConfirmAction({ type: 'transfer', userId: targetUserId });
      return;
    }
    try {
      await useServerStore.getState().transferOwnership(serverId, targetUserId);
      setConfirmAction(null);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to transfer ownership');
    }
  }

  function canKickMember(member: ServerMember): boolean {
    if (!currentMember || member.userId === currentUser?.id) return false;
    if (!isOwner && !isAdmin) return false;
    return outranksRole(currentMember.role, member.role);
  }

  return (
    <div className="space-y-1">
      {sortedMembers.map((member) => {
        const isSelf = member.userId === currentUser?.id;
        const showPromote = isOwner && member.role === 'member' && !isSelf;
        const showDemote = isOwner && member.role === 'admin' && !isSelf;
        const showKick = canKickMember(member);
        const showTransfer = isOwner && !isSelf;
        const isConfirmingKick = confirmAction?.type === 'kick' && confirmAction.userId === member.userId;
        const isConfirmingTransfer = confirmAction?.type === 'transfer' && confirmAction.userId === member.userId;

        return (
          <div
            key={member.userId}
            className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-vox-bg-hover transition-colors"
          >
            <Avatar avatarUrl={member.user.avatarUrl} displayName={member.user.displayName} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-vox-text-primary">
                  {member.user.displayName}
                </span>
                <RoleBadge role={member.role} />
              </div>
              <span className="text-xs text-vox-text-muted">@{member.user.username}</span>
            </div>

            {/* Actions */}
            {(showPromote || showDemote || showKick || showTransfer) && (
              <div className="flex items-center gap-1.5 shrink-0">
                {showPromote && (
                  <button
                    onClick={() => handleRoleChange(member.userId, 'admin')}
                    className="rounded px-2 py-1 text-xs font-medium text-vox-accent-primary hover:bg-vox-accent-primary/10 transition-colors"
                    title="Promote to Admin"
                  >
                    Promote
                  </button>
                )}
                {showDemote && (
                  <button
                    onClick={() => handleRoleChange(member.userId, 'member')}
                    className="rounded px-2 py-1 text-xs font-medium text-vox-text-muted hover:bg-vox-bg-hover transition-colors"
                    title="Demote to Member"
                  >
                    Demote
                  </button>
                )}
                {showKick && (
                  <button
                    onClick={() => handleKick(member.userId)}
                    className="rounded px-2 py-1 text-xs font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
                    title="Kick"
                  >
                    {isConfirmingKick ? 'Confirm?' : 'Kick'}
                  </button>
                )}
                {showTransfer && (
                  <button
                    onClick={() => handleTransfer(member.userId)}
                    className="rounded px-2 py-1 text-xs font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
                    title="Transfer Ownership"
                  >
                    {isConfirmingTransfer ? 'Confirm?' : 'Transfer'}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoleBadge({ role }: { role: MemberRole }) {
  if (role === 'owner') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-yellow-500/20 text-yellow-400" title="Owner">
        <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        Owner
      </span>
    );
  }
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-vox-accent-primary/20 text-vox-accent-primary" title="Admin">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        Admin
      </span>
    );
  }
  return null;
}

function outranksRole(actor: MemberRole, target: MemberRole): boolean {
  const levels: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };
  return levels[actor] > levels[target];
}
