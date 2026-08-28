import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerStore, NO_SECURE_MEMBERS } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { X, Lock, UserPlus, UserMinus, Crown } from 'lucide-react';
import { E2E_LIMITS } from '@voxium/shared';
import { getTranslatedError } from '../../utils/serverErrors';

interface Props {
  serverId: string;
  channelId: string;
  channelName: string;
  onClose: () => void;
}

/**
 * Member management for a secure channel. Everyone sees the list; only the
 * creator gets the invite picker and remove buttons (the server enforces the
 * same rule — this is presentation, not authorization).
 */
export function SecureChannelMembersModal({ serverId, channelId, channelName, onClose }: Props) {
  const { t } = useTranslation();
  const {
    members: serverMembers,
    fetchSecureChannelMembers,
    inviteSecureChannelMember,
    removeSecureChannelMember,
    renameSecureChannel,
  } = useServerStore();
  const channelMembers = useServerStore((s) => s.secureChannelMembers[channelId] ?? NO_SECURE_MEMBERS);
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [showInvitePicker, setShowInvitePicker] = useState(false);
  const [name, setName] = useState(channelName);
  const [renaming, setRenaming] = useState(false);

  const handleRename = async () => {
    const next = name.trim();
    if (!next || next === channelName || renaming) return;
    setRenaming(true);
    try {
      await renameSecureChannel(serverId, channelId, next);
      toast.success(t('secureChannel.renamed'));
      // Sidebar entry updates via the channel:updated event to the channel room
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.failedToRename'));
      setName(channelName);
    } finally {
      setRenaming(false);
    }
  };

  useEffect(() => {
    fetchSecureChannelMembers(serverId, channelId)
      .then(() => setLoading(false))
      .catch((err: unknown) => {
        setError(getTranslatedError(err, t, 'secureChannel.failedToLoadMembers'));
        setLoading(false);
      });
  }, [serverId, channelId, fetchSecureChannelMembers, t]);

  const isCreator = channelMembers.some((m) => m.userId === user?.id && m.isCreator);
  const memberIds = useMemo(() => new Set(channelMembers.map((m) => m.userId)), [channelMembers]);
  const invitable = useMemo(
    () => serverMembers.filter((m) => !memberIds.has(m.userId)),
    [serverMembers, memberIds],
  );
  const atCap = channelMembers.length >= E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP;

  const handleInvite = async (userId: string) => {
    setBusyUserId(userId);
    try {
      await inviteSecureChannelMember(serverId, channelId, userId);
      toast.success(t('secureChannel.memberInvited'));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.failedToInvite'));
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (userId: string) => {
    setBusyUserId(userId);
    try {
      await removeSecureChannelMember(serverId, channelId, userId);
      toast.success(t('secureChannel.memberRemoved'));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.failedToRemove'));
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in" role="dialog" aria-modal="true">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-vox-border bg-vox-bg-secondary p-6 shadow-2xl animate-slide-up">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex min-w-0 items-center gap-2 text-xl font-bold text-vox-text-primary">
            <Lock size={18} className="shrink-0 text-vox-accent-primary" />
            <span className="truncate">{channelName}</span>
          </h2>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {isCreator && (
              <div className="mb-4">
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                  {t('secureChannel.renameLabel')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input flex-1 text-sm"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                    data-testid="secure-rename-input"
                  />
                  <button
                    onClick={handleRename}
                    disabled={!name.trim() || name.trim() === channelName || renaming}
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                    data-testid="secure-rename-save"
                  >
                    {renaming ? t('secureChannel.renaming') : t('secureChannel.rename')}
                  </button>
                </div>
              </div>
            )}
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
              {t('secureChannel.membersCount', {
                count: channelMembers.length,
                max: E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP,
              })}
            </label>
            <div className="mb-3 max-h-64 overflow-y-auto rounded-lg border border-vox-border" data-testid="secure-members-list">
              {channelMembers.map((m) => (
                <div key={m.userId} className="flex items-center gap-2.5 px-3 py-2">
                  <Avatar avatarUrl={m.user.avatarUrl} displayName={m.user.displayName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm text-vox-text-primary">
                      {m.user.displayName}
                      {m.isCreator && <Crown size={12} className="shrink-0 text-vox-accent-warning" />}
                    </div>
                    <div className="truncate text-xs text-vox-text-muted">@{m.user.username}</div>
                  </div>
                  {isCreator && !m.isCreator && (
                    <button
                      onClick={() => handleRemove(m.userId)}
                      disabled={busyUserId === m.userId}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors disabled:opacity-50"
                      title={t('secureChannel.removeMember')}
                    >
                      <UserMinus size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {isCreator && !showInvitePicker && (
              <button
                onClick={() => setShowInvitePicker(true)}
                disabled={atCap}
                className="btn-ghost flex items-center justify-center gap-1.5 py-2 text-sm disabled:opacity-50"
                data-testid="secure-invite-open"
              >
                <UserPlus size={15} />
                {atCap
                  ? t('secureChannel.memberCapReached', { max: E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP })
                  : t('secureChannel.inviteMember')}
              </button>
            )}

            {isCreator && showInvitePicker && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-vox-border">
                {invitable.length === 0 && (
                  <p className="px-3 py-4 text-center text-sm text-vox-text-muted">{t('secureChannel.noMembersFound')}</p>
                )}
                {invitable.map((m) => (
                  <button
                    key={m.userId}
                    onClick={() => handleInvite(m.userId)}
                    disabled={busyUserId === m.userId || atCap}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
                    data-testid={`secure-invite-${m.user.username}`}
                  >
                    <Avatar avatarUrl={m.user.avatarUrl} displayName={m.user.displayName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-vox-text-primary">{m.nickname || m.user.displayName}</div>
                      <div className="truncate text-xs text-vox-text-muted">@{m.user.username}</div>
                    </div>
                    <UserPlus size={14} className="text-vox-text-muted" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
