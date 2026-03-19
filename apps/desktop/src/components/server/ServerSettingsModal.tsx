import { useState, useEffect } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { ImageUploadButton } from '../common/ImageUploadButton';
import { X, Lock, Unlock, Shield } from 'lucide-react';
import type { ServerMember, MemberRole, ResourceLimits } from '@voxium/shared';
import { Permissions, permissionsFromString, hasPermission } from '@voxium/shared';
import { RoleEditor } from './RoleEditor';
import axios from 'axios';
import { api } from '../../services/api';

interface Props {
  serverId: string;
  onClose: () => void;
}

type Tab = 'general' | 'members' | 'roles' | 'limits';

export function ServerSettingsModal({ serverId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('general');

  const { servers, roles, fetchEffectivePermissions } = useServerStore();
  const currentUser = useAuthStore((s) => s.user);
  const server = servers.find((s) => s.id === serverId);
  const isOwner = server?.ownerId === currentUser?.id;
  const [effectivePerms, setEffectivePerms] = useState<string | null>(null);

  useEffect(() => {
    fetchEffectivePermissions(serverId).then(setEffectivePerms).catch(() => {});
  }, [serverId, fetchEffectivePermissions]);

  const canManageRoles = isOwner || (effectivePerms !== null && hasPermission(permissionsFromString(effectivePerms), Permissions.MANAGE_ROLES));

  if (!server) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative flex w-full flex-col rounded-xl border border-vox-border bg-vox-bg-floating shadow-2xl animate-slide-up ${activeTab === 'roles' ? 'max-w-3xl' : 'max-w-lg'}`} style={{ maxHeight: '80vh' }}>
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
          {canManageRoles && (
            <button
              onClick={() => setActiveTab('roles')}
              className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === 'roles'
                  ? 'text-vox-text-primary border-vox-accent-primary'
                  : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
              }`}
            >
              Roles
            </button>
          )}
          <button
            onClick={() => setActiveTab('limits')}
            className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'limits'
                ? 'text-vox-text-primary border-vox-accent-primary'
                : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
            }`}
          >
            Limits
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'general' ? (
            <GeneralTab serverId={serverId} onClose={onClose} />
          ) : activeTab === 'members' ? (
            <MembersTab serverId={serverId} />
          ) : activeTab === 'roles' ? (
            <RoleEditor serverId={serverId} roles={roles} canManageRoles={canManageRoles} />
          ) : (
            <LimitsTab serverId={serverId} />
          )}
        </div>
      </div>
    </div>
  );
}

function GeneralTab({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const { servers, members, uploadServerIcon, updateServer, deleteServer, toggleInvitesLock } = useServerStore();
  const currentUser = useAuthStore((s) => s.user);
  const server = servers.find((s) => s.id === serverId);
  const currentMember = members.find((m) => m.userId === currentUser?.id);

  const [name, setName] = useState(server?.name || '');
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);

  if (!server) return null;

  const isOwner = server.ownerId === currentUser?.id;
  const isAdminOrOwner = currentMember?.role === 'owner' || currentMember?.role === 'admin';

  const handleToggleInvitesLock = async () => {
    setTogglingLock(true);
    try {
      await toggleInvitesLock(serverId, !server.invitesLocked);
      toast.success(server.invitesLocked ? 'Invites unlocked' : 'Invites locked');
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to toggle invites lock' : 'Failed to toggle invites lock');
    } finally {
      setTogglingLock(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (iconFile) {
        setUploading(true);
        try {
          await uploadServerIcon(serverId, iconFile);
          setIconFile(null);
        } catch (err) {
          toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to upload icon' : 'Failed to upload icon');
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
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to update server' : 'Failed to update server');
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
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to delete server' : 'Failed to delete server');
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

      {/* Invites Lock — owner or admin */}
      {isAdminOrOwner && (
        <div className="mt-6 border-t border-vox-border pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-vox-text-primary flex items-center gap-1.5">
                {server.invitesLocked ? <Lock size={14} /> : <Unlock size={14} />}
                Server Invites
              </h3>
              <p className="text-xs text-vox-text-muted mt-0.5">
                {server.invitesLocked
                  ? 'Invites are locked. No one can create or use invite links.'
                  : 'Invites are open. Members can create and share invite links.'}
              </p>
            </div>
            <button
              onClick={handleToggleInvitesLock}
              disabled={togglingLock}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                server.invitesLocked
                  ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                  : 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              }`}
            >
              {server.invitesLocked ? 'Unlock Invites' : 'Lock Invites'}
            </button>
          </div>
        </div>
      )}

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
  const { members, roles, assignMemberRoles } = useServerStore();
  const currentUser = useAuthStore((s) => s.user);
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const [confirmAction, setConfirmAction] = useState<{ type: 'kick' | 'transfer'; userId: string } | null>(null);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [savingRoles, setSavingRoles] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);

  const isOwner = currentMember?.role === 'owner';
  const isAdmin = currentMember?.role === 'admin';
  const canManageRoles = isOwner || isAdmin;
  const assignableRoles = roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  // Filter + sort members
  const filteredMembers = members.filter((m) => {
    if (search) {
      const q = search.toLowerCase();
      const nameMatch = (m.nickname || m.user.displayName).toLowerCase().includes(q);
      const usernameMatch = m.user.username.toLowerCase().includes(q);
      if (!nameMatch && !usernameMatch) return false;
    }
    if (roleFilter) {
      if (roleFilter === '_owner') return m.role === 'owner';
      if (roleFilter === '_admin') return m.role === 'admin';
      if (roleFilter === '_none') return !m.roles || m.roles.length === 0;
      return m.roles?.some((r) => r.id === roleFilter) ?? false;
    }
    return true;
  });

  // Sort: owner first, then by highest role position, then alphabetically
  const sortedMembers = [...filteredMembers].sort((a, b) => {
    const aLevel = a.role === 'owner' ? 999 : (a.roles?.reduce((max, r) => Math.max(max, r.position), 0) ?? 0);
    const bLevel = b.role === 'owner' ? 999 : (b.roles?.reduce((max, r) => Math.max(max, r.position), 0) ?? 0);
    if (aLevel !== bLevel) return bLevel - aLevel;
    return (a.nickname || a.user.displayName).localeCompare(b.nickname || b.user.displayName);
  });

  async function handleRoleChange(memberId: string, newRole: MemberRole) {
    try {
      await useServerStore.getState().updateMemberRole(serverId, memberId, newRole);
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to update role' : 'Failed to update role');
    }
  }

  async function handleKick(memberId: string) {
    try {
      await useServerStore.getState().kickMember(serverId, memberId);
      setConfirmAction(null);
      setExpandedMember(null);
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to kick member' : 'Failed to kick member');
    }
  }

  async function handleTransfer(targetUserId: string) {
    try {
      await useServerStore.getState().transferOwnership(serverId, targetUserId);
      setConfirmAction(null);
      setExpandedMember(null);
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to transfer ownership' : 'Failed to transfer ownership');
    }
  }

  async function handleToggleRole(memberId: string, roleId: string) {
    const member = members.find((m) => m.userId === memberId);
    if (!member) return;
    setSavingRoles(true);
    try {
      const currentRoleIds = new Set(member.roles?.map((r) => r.id) || []);
      const newRoleIds = currentRoleIds.has(roleId)
        ? [...currentRoleIds].filter((id) => id !== roleId)
        : [...currentRoleIds, roleId];
      await assignMemberRoles(serverId, memberId, newRoleIds);
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to update roles' : 'Failed to update roles');
    } finally {
      setSavingRoles(false);
    }
  }

  function canKickMember(member: ServerMember): boolean {
    if (!currentMember || member.userId === currentUser?.id) return false;
    if (!isOwner && !isAdmin) return false;
    return outranksRole(currentMember.role, member.role);
  }

  return (
    <div className="space-y-3">
      {/* Search + Filter bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-vox-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search members..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-primary pl-8 pr-3 py-1.5 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
          />
        </div>
        <select
          value={roleFilter ?? ''}
          onChange={(e) => setRoleFilter(e.target.value || null)}
          className="rounded-lg border border-vox-border bg-vox-bg-primary px-2 py-1.5 text-xs text-vox-text-secondary focus:outline-none focus:border-vox-accent-primary"
        >
          <option value="">All roles</option>
          <option value="_owner">Owners</option>
          <option value="_admin">Admins</option>
          {assignableRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
          <option value="_none">No roles</option>
        </select>
      </div>

      {/* Member count */}
      <p className="text-xs text-vox-text-muted">
        {filteredMembers.length} of {members.length} member{members.length !== 1 ? 's' : ''}
      </p>

      {/* Member list */}
      <div className="space-y-0.5">
        {sortedMembers.map((member) => {
          const isSelf = member.userId === currentUser?.id;
          const isExpanded = expandedMember === member.userId;
          const showPromote = isOwner && member.role === 'member' && !isSelf;
          const showDemote = isOwner && member.role === 'admin' && !isSelf;
          const showKick = canKickMember(member);
          const showTransfer = isOwner && !isSelf;
          const showRoleEdit = canManageRoles && !isSelf && member.role !== 'owner' && assignableRoles.length > 0;
          const hasActions = showPromote || showDemote || showKick || showTransfer || showRoleEdit;
          const isConfirmingKick = confirmAction?.type === 'kick' && confirmAction.userId === member.userId;
          const isConfirmingTransfer = confirmAction?.type === 'transfer' && confirmAction.userId === member.userId;

          return (
            <div key={member.userId} className="rounded-lg border border-transparent hover:border-vox-border transition-colors">
              {/* Main row */}
              <div
                className={`flex items-center gap-3 px-3 py-2 cursor-pointer rounded-lg transition-colors ${
                  isExpanded ? 'bg-vox-bg-hover' : 'hover:bg-vox-bg-hover/50'
                }`}
                onClick={() => {
                  if (!hasActions && !isSelf) return;
                  setExpandedMember(isExpanded ? null : member.userId);
                  setConfirmAction(null);
                }}
              >
                <Avatar avatarUrl={member.user.avatarUrl} displayName={member.user.displayName} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-vox-text-primary">
                      {member.nickname || member.user.displayName}
                    </span>
                    {member.nickname && (
                      <span className="text-xs text-vox-text-muted truncate">({member.user.displayName})</span>
                    )}
                    {isSelf && (
                      <span className="text-[10px] font-medium text-vox-accent-primary bg-vox-accent-primary/10 rounded px-1">you</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-xs text-vox-text-muted">@{member.user.username}</span>
                    <RoleBadge role={member.role} />
                  </div>
                </div>

                {/* Role pills (always visible) */}
                <div className="flex flex-wrap gap-1 shrink-0 max-w-[180px] justify-end">
                  {member.roles?.map((role) => (
                    <span
                      key={role.id}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        color: role.color || '#99aab5',
                        backgroundColor: (role.color || '#99aab5') + '18',
                        border: `1px solid ${(role.color || '#99aab5')}30`,
                      }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-current" />
                      {role.name}
                    </span>
                  ))}
                </div>

                {/* Expand indicator */}
                {hasActions && (
                  <svg
                    className={`h-4 w-4 text-vox-text-muted shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </div>

              {/* Expanded panel */}
              {isExpanded && hasActions && (
                <div className="px-3 pb-3 pt-1 space-y-3 border-t border-vox-border/50 mx-2">
                  {/* Role assignment */}
                  {showRoleEdit && (
                    <div>
                      <p className="text-[11px] font-semibold text-vox-text-muted uppercase tracking-wider mb-1.5">Assign Roles</p>
                      <div className="flex flex-wrap gap-1.5">
                        {assignableRoles.map((role) => {
                          const hasRole = member.roles?.some((r) => r.id === role.id) ?? false;
                          return (
                            <button
                              key={role.id}
                              onClick={(e) => { e.stopPropagation(); handleToggleRole(member.userId, role.id); }}
                              disabled={savingRoles}
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border transition-all disabled:opacity-50 ${
                                hasRole
                                  ? 'shadow-sm'
                                  : 'border-dashed border-vox-border text-vox-text-muted hover:border-vox-text-secondary hover:text-vox-text-secondary'
                              }`}
                              style={hasRole ? {
                                color: role.color || '#99aab5',
                                borderColor: (role.color || '#99aab5') + '60',
                                backgroundColor: (role.color || '#99aab5') + '18',
                              } : undefined}
                            >
                              {hasRole ? (
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                </svg>
                              )}
                              {role.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Promote / Demote */}
                  {(showPromote || showDemote) && (
                    <div className="flex items-center gap-2">
                      {showPromote && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRoleChange(member.userId, 'admin'); }}
                          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-vox-accent-primary hover:bg-vox-accent-primary/10 transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                          Promote to Admin
                        </button>
                      )}
                      {showDemote && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRoleChange(member.userId, 'member'); }}
                          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                          </svg>
                          Demote to Member
                        </button>
                      )}
                    </div>
                  )}

                  {/* Dangerous actions */}
                  {(showKick || showTransfer) && (
                    <div className="space-y-2 pt-1 border-t border-vox-border/30">
                      {/* Confirmation dialog */}
                      {isConfirmingKick && (
                        <div className="rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
                          <p className="text-xs text-vox-text-primary font-medium mb-1">
                            Kick {member.nickname || member.user.displayName}?
                          </p>
                          <p className="text-[11px] text-vox-text-muted mb-2.5">
                            They will be removed from the server and will need a new invite to rejoin.
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleKick(member.userId); }}
                              className="rounded-md bg-vox-accent-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-danger/80 transition-colors"
                            >
                              Kick
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction(null); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {isConfirmingTransfer && (
                        <div className="rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
                          <p className="text-xs text-vox-text-primary font-medium mb-1">
                            Transfer ownership to {member.nickname || member.user.displayName}?
                          </p>
                          <p className="text-[11px] text-vox-text-muted mb-2.5">
                            You will lose owner privileges and become an admin. This cannot be undone by you.
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleTransfer(member.userId); }}
                              className="rounded-md bg-vox-accent-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-danger/80 transition-colors"
                            >
                              Transfer
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction(null); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Action buttons (hidden when confirming) */}
                      {!isConfirmingKick && !isConfirmingTransfer && (
                        <div className="flex items-center gap-2">
                          {showKick && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: 'kick', userId: member.userId }); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
                            >
                              Kick member
                            </button>
                          )}
                          {showTransfer && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: 'transfer', userId: member.userId }); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-muted hover:bg-vox-bg-hover transition-colors"
                            >
                              Transfer ownership
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {sortedMembers.length === 0 && (
          <p className="text-center text-sm text-vox-text-muted py-8">
            {search || roleFilter ? 'No members match your search' : 'No members found'}
          </p>
        )}
      </div>
    </div>
  );
}

function LimitsTab({ serverId }: { serverId: string }) {
  const [limits, setLimits] = useState<ResourceLimits | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/servers/${serverId}/limits`);
        if (!cancelled) setLimits(data.data);
      } catch {
        if (!cancelled) toast.error('Failed to load server limits');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [serverId]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
      </div>
    );
  }

  if (!limits) return null;

  const items = [
    { label: 'Max Channels', value: limits.maxChannelsPerServer, description: 'Maximum text + voice channels in this server' },
    { label: 'Max Voice Users per Channel', value: limits.maxVoiceUsersPerChannel, description: 'Maximum users that can join a single voice channel' },
    { label: 'Max Categories', value: limits.maxCategoriesPerServer, description: 'Maximum channel categories in this server' },
    { label: 'Max Members', value: limits.maxMembersPerServer, description: 'Maximum members that can join this server', formatZero: 'Unlimited' },
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-vox-text-muted">
        Resource limits for this server. These are configured by platform administrators.
      </p>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between rounded-lg bg-vox-bg-secondary border border-vox-border px-4 py-3">
            <div>
              <p className="text-sm font-medium text-vox-text-primary">{item.label}</p>
              <p className="text-xs text-vox-text-muted">{item.description}</p>
            </div>
            <span className="text-lg font-bold text-vox-accent-primary">
              {item.formatZero && item.value === 0 ? item.formatZero : item.value}
            </span>
          </div>
        ))}
      </div>
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
