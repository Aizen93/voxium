import { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useServerStore, type ServerSettingsTab } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { ImageUploadButton } from '../common/ImageUploadButton';
import { X, Lock, Unlock } from 'lucide-react';
import type { ResourceLimits } from '@voxium/shared';
import { Permissions, permissionsFromString, hasPermission } from '@voxium/shared';
import { RoleEditor } from './RoleEditor';
import { DiscoveryTab } from './DiscoveryTab';
import { JoinRequestsSection } from './JoinRequestsSection';
import { BannedSection } from './BannedSection';
import { MembersDirectory } from './MembersDirectory';
import { api } from '../../services/api';
import { getTranslatedError } from '../../utils/serverErrors';

interface Props {
  serverId: string;
  onClose: () => void;
  /** Open on this tab (the People panel's "Browse all members" asks for Members). */
  initialTab?: ServerSettingsTab;
}

type Tab = ServerSettingsTab;

export function ServerSettingsModal({ serverId, onClose, initialTab }: Props) {
  const { t } = useTranslation();
  // No tab until the viewer picks one: the default is derived below from
  // what they may do (General is a MANAGE_SERVER tab; a role-only moderator
  // reaches the modal through the gear too and lands on Members).
  const [activeTab, setActiveTab] = useState<Tab | null>(initialTab ?? null);

  const { servers, roles, fetchEffectivePermissions, fetchJoinRequests } = useServerStore();
  const pendingRequests = useServerStore((s) => s.joinRequestCounts[serverId] ?? 0);
  const currentUser = useAuthStore((s) => s.user);
  const server = servers.find((s) => s.id === serverId);
  const isOwner = server?.ownerId === currentUser?.id;
  const [effectivePerms, setEffectivePerms] = useState<string | null>(null);

  useEffect(() => {
    fetchEffectivePermissions(serverId).then(setEffectivePerms).catch((err) => { console.warn('[ServerSettings] Failed to fetch permissions:', err); });
  }, [serverId, fetchEffectivePermissions]);

  const perms = effectivePerms !== null ? permissionsFromString(effectivePerms) : null;
  const canManageRoles = isOwner || (perms !== null && hasPermission(perms, Permissions.MANAGE_ROLES));
  // Discovery tab: MANAGE_SERVER. Join requests + Banned: KICK_MEMBERS ("Manage members").
  const canManageServer = isOwner || (perms !== null && hasPermission(perms, Permissions.MANAGE_SERVER));
  const canModerateMembers = isOwner || (perms !== null && hasPermission(perms, Permissions.KICK_MEMBERS));
  const tab: Tab = activeTab ?? (canManageServer ? 'general' : 'members');

  // The Members tab badge is fed by the socket events and by the list fetch;
  // until step 4 wires the events, and on the first open of a session, the
  // count is only known once the list has been fetched — do it as soon as
  // we know the viewer may moderate, not when they reach the tab.
  useEffect(() => {
    if (!canModerateMembers) return;
    fetchJoinRequests(serverId).catch((err) => { console.warn('[ServerSettings] Failed to fetch join requests:', err); });
  }, [serverId, canModerateMembers, fetchJoinRequests]);

  if (!server) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative flex w-full flex-col rounded-xl border border-vox-border bg-vox-bg-floating shadow-2xl animate-slide-up ${tab === 'roles' ? 'max-w-4xl' : 'max-w-2xl'}`} style={{ maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-vox-border px-6 py-4">
          <h2 className="text-lg font-bold text-vox-text-primary">{t('serverSettings.title')}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-vox-border px-6">
          {canManageServer && (
            <button
              onClick={() => setActiveTab('general')}
              className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === 'general'
                  ? 'text-vox-text-primary border-vox-accent-primary'
                  : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
              }`}
            >
              {t('serverSettings.tabs.general')}
            </button>
          )}
          <button
            onClick={() => setActiveTab('members')}
            className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === 'members'
                ? 'text-vox-text-primary border-vox-accent-primary'
                : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
            }`}
          >
            {t('serverSettings.tabs.members')}
            {canModerateMembers && pendingRequests > 0 && (
              <span
                className="ml-1.5 rounded-full bg-vox-accent-primary px-1.5 text-[10px] font-semibold text-vox-on-accent"
                aria-label={t('server.joinRequests.pending', { count: pendingRequests })}
                data-testid="members-tab-badge"
              >
                {pendingRequests}
              </span>
            )}
          </button>
          {canManageServer && (
            <button
              onClick={() => setActiveTab('discovery')}
              className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === 'discovery'
                  ? 'text-vox-text-primary border-vox-accent-primary'
                  : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
              }`}
              data-testid="tab-discovery"
            >
              {t('serverSettings.tabs.discovery')}
            </button>
          )}
          {canManageRoles && (
            <button
              onClick={() => setActiveTab('roles')}
              className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === 'roles'
                  ? 'text-vox-text-primary border-vox-accent-primary'
                  : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
              }`}
            >
              {t('serverSettings.tabs.roles')}
            </button>
          )}
          <button
            onClick={() => setActiveTab('limits')}
            className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === 'limits'
                ? 'text-vox-text-primary border-vox-accent-primary'
                : 'text-vox-text-muted border-transparent hover:text-vox-text-secondary'
            }`}
          >
            {t('serverSettings.tabs.limits')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'general' ? (
            <GeneralTab serverId={serverId} onClose={onClose} />
          ) : tab === 'members' ? (
            <MembersTab serverId={serverId} canModerateMembers={canModerateMembers} />
          ) : tab === 'discovery' ? (
            <DiscoveryTab key={serverId} serverId={serverId} onGoToGeneral={() => setActiveTab('general')} />
          ) : tab === 'roles' ? (
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
  const { t } = useTranslation();
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
      toast.success(server.invitesLocked ? t('serverSettings.general.invitesUnlocked') : t('serverSettings.general.invitesLockedSuccess'));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'serverSettings.general.failedToToggleLock'));
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
          toast.error(getTranslatedError(err, t, 'serverSettings.general.failedToUploadIcon'));
          setSaving(false);
          setUploading(false);
          return;
        }
        setUploading(false);
      }

      if (name.trim() && name.trim() !== server.name) {
        await updateServer(serverId, { name: name.trim() });
      }

      toast.success(t('serverSettings.general.serverUpdated'));
      onClose();
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'serverSettings.general.failedToUpdate'));
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
      toast.error(getTranslatedError(err, t, 'serverSettings.general.failedToDelete'));
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
          {t('serverSettings.general.serverName')}
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
        {saving ? t('settings.profile.saving') : t('settings.profile.saveChanges')}
      </button>

      {/* Invites Lock — owner or admin */}
      {isAdminOrOwner && (
        <div className="mt-6 border-t border-vox-border pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-vox-text-primary flex items-center gap-1.5">
                {server.invitesLocked ? <Lock size={14} /> : <Unlock size={14} />}
                {t('serverSettings.general.serverInvites')}
              </h3>
              <p className="text-xs text-vox-text-muted mt-0.5">
                {server.invitesLocked
                  ? t('serverSettings.general.invitesLocked')
                  : t('serverSettings.general.invitesOpen')}
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
              {server.invitesLocked ? t('serverSettings.general.unlockInvites') : t('serverSettings.general.lockInvites')}
            </button>
          </div>
        </div>
      )}

      {/* Secure channels — the opaque moderation surface: a count, and a
          delete-by-id lever fed by abuse reports. Deliberately NO listing —
          non-members (owner included) must learn nothing beyond the number. */}
      {isAdminOrOwner && <SecureChannelsSection serverId={serverId} />}

      {/* Danger Zone — owner only */}
      {isOwner && (
        <div className="mt-8 border-t border-vox-accent-danger/30 pt-6">
          <h3 className="text-sm font-semibold text-vox-accent-danger mb-1">{t('serverSettings.general.dangerZone')}</h3>
          <p className="text-xs text-vox-text-muted mb-3">
            {t('serverSettings.general.deleteWarning')}
          </p>

          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-lg border border-vox-accent-danger/50 px-4 py-2 text-sm font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
            >
              {t('serverSettings.general.deleteServer')}
            </button>
          ) : (
            <div className="space-y-3 rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
              <p className="text-xs text-vox-text-secondary">
                <Trans i18nKey="serverSettings.general.typeToConfirm" values={{ name: server.name }}>
                  Type <span className="font-semibold text-vox-text-primary">{'{{name}}'}</span> to confirm deletion.
                </Trans>
              </p>
              <input
                type="text"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder={t('serverSettings.general.serverNamePlaceholder')}
                className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-danger"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleteConfirmName !== server.name || deleting}
                  className="flex-1 rounded-lg bg-vox-accent-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-vox-accent-danger/80 transition-colors"
                >
                  {deleting ? t('serverSettings.general.deleting') : t('serverSettings.general.confirmDelete')}
                </button>
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); }}
                  className="rounded-lg border border-vox-border px-4 py-2 text-sm font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SecureChannelsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { fetchSecureChannelCount, deleteChannel } = useServerStore();
  const [count, setCount] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSecureChannelCount(serverId)
      .then((n) => { if (!cancelled) setCount(n); })
      .catch((err) => console.warn('[SecureChannel] Failed to fetch count:', err));
    return () => { cancelled = true; };
  }, [serverId, fetchSecureChannelCount]);

  const handleDeleteById = async () => {
    const id = deleteId.trim();
    if (!id || deleting) return;
    // This control is for SECURE channels reported for abuse. The server's
    // generic DELETE route would happily delete a plaintext channel too (the
    // caller has MANAGE_CHANNELS) — refuse ids that match a visible plaintext
    // channel so a mispasted id cannot silently destroy #general.
    const visible = useServerStore.getState().channels.find((c) => c.id === id);
    if (visible && !visible.secure) {
      toast.error(t('secureChannel.moderationNotSecure', { name: visible.name }));
      return;
    }
    setDeleting(true);
    try {
      await deleteChannel(serverId, id);
      toast.success(t('secureChannel.moderationDeleted'));
      setDeleteId('');
      setCount((c) => (c === null ? c : Math.max(0, c - 1)));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.moderationDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mt-6 border-t border-vox-border pt-6">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-vox-text-primary">
        <Lock size={14} />
        {t('secureChannel.moderationTitle')}
      </h3>
      <p className="mt-0.5 text-xs text-vox-text-muted">
        {count === null
          ? t('secureChannel.moderationLoading')
          : t('secureChannel.moderationCount', { count })}
      </p>
      <p className="mt-2 text-xs text-vox-text-muted">{t('secureChannel.moderationHint')}</p>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={deleteId}
          onChange={(e) => setDeleteId(e.target.value)}
          placeholder={t('secureChannel.moderationDeletePlaceholder')}
          className="flex-1 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-1.5 text-xs text-vox-text-primary focus:outline-none focus:border-vox-accent-danger"
          data-testid="secure-moderation-delete-id"
        />
        <button
          onClick={handleDeleteById}
          disabled={!deleteId.trim() || deleting}
          className="rounded-lg border border-vox-accent-danger/50 px-3 py-1.5 text-xs font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors disabled:opacity-50"
          data-testid="secure-moderation-delete"
        >
          {deleting ? t('serverSettings.general.deleting') : t('secureChannel.moderationDelete')}
        </button>
      </div>
    </div>
  );
}

function MembersTab({ serverId, canModerateMembers }: { serverId: string; canModerateMembers: boolean }) {
  return (
    <div className="space-y-3">
      {/* Moderation: join requests to decide, bans to lift (KICK_MEMBERS) */}
      {canModerateMembers && (
        <>
          <JoinRequestsSection serverId={serverId} />
          <BannedSection serverId={serverId} />
        </>
      )}

      {/* Everyone: the server-paged directory */}
      <MembersDirectory serverId={serverId} />
    </div>
  );
}

function LimitsTab({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [limits, setLimits] = useState<ResourceLimits | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/servers/${serverId}/limits`);
        if (!cancelled) setLimits(data.data);
      } catch {
        if (!cancelled) toast.error(t('serverSettings.limits.failedToLoad'));
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
    { label: t('serverSettings.limits.maxChannels'), value: limits.maxChannelsPerServer, description: t('serverSettings.limits.maxChannelsDesc') },
    { label: t('serverSettings.limits.maxVoiceUsers'), value: limits.maxVoiceUsersPerChannel, description: t('serverSettings.limits.maxVoiceUsersDesc') },
    { label: t('serverSettings.limits.maxCategories'), value: limits.maxCategoriesPerServer, description: t('serverSettings.limits.maxCategoriesDesc') },
    { label: t('serverSettings.limits.maxMembers'), value: limits.maxMembersPerServer, description: t('serverSettings.limits.maxMembersDesc'), formatZero: t('serverSettings.limits.unlimited') },
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-vox-text-muted">
        {t('serverSettings.limits.description')}
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
