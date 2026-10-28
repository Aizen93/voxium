import { useMemo, useState } from 'react';
import { memberMatches } from '../../hooks/useMemberSearch';
import { useMemberDirectory } from '../../hooks/useMemberDirectory';
import { MemberDirectoryFooter } from './MemberDirectoryFooter';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { ServerMember } from '@voxium/shared';
import { E2E_LIMITS } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { X, Lock, Check, Search } from 'lucide-react';
import { isSecureVoiceSupported } from '../../services/e2e/voiceFrameTransform';
import { getTranslatedError } from '../../utils/serverErrors';

const secureVoiceSupported = isSecureVoiceSupported();

interface Props {
  serverId: string;
  onClose: () => void;
}

/**
 * Create an invite-only E2E-encrypted channel.
 *
 * Two columns: the channel (type, name) on the left, the people on the right,
 * because the people are the hard part of this dialog. Whoever is selected is
 * shown as a removable chip above the search box, so "who did I pick" is
 * always on screen whatever the list below is scrolled or filtered to; the
 * list itself fills the dialog's height and highlights the selected rows. The
 * creator is always a member; invitees are capped at
 * SECURE_CHANNEL_MEMBER_CAP - 1.
 */
export function SecureChannelCreateModal({ serverId, onClose }: Props) {
  const { t } = useTranslation();
  const { members, createSecureChannel, setActiveChannel } = useServerStore();
  const { user } = useAuthStore();
  const [name, setName] = useState('');
  const [channelType, setChannelType] = useState<'text' | 'voice'>('text');
  const [query, setQuery] = useState('');
  // The rows, not just the ids: a member picked from a server-side search on
  // a big server may not be in the client's member slice, and the chip needs
  // their name and avatar.
  const [selected, setSelected] = useState<Map<string, ServerMember>>(new Map());
  const [creating, setCreating] = useState(false);

  const maxInvitees = E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP - 1;

  // The directory, paged: everyone in the space, filtered server-side by the
  // search text. The rows the client holds (the People slice: online only on
  // a big server) show while the first page loads, and if the directory fails.
  const directory = useMemberDirectory(serverId, query);
  const candidates = useMemo(
    () => (directory.rows ?? members.filter((m) => memberMatches(m, query))).filter((m) => m.userId !== user?.id),
    [members, directory.rows, user?.id, query],
  );

  const displayName = (m: ServerMember) => m.nickname || m.user.displayName;

  const toggle = (m: ServerMember) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(m.userId)) {
        next.delete(m.userId);
      } else {
        if (next.size >= maxInvitees) {
          toast.error(t('secureChannel.memberCapReached', { max: E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP }));
          return prev;
        }
        next.set(m.userId, m);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const channel = await createSecureChannel(serverId, name.trim(), [...selected.keys()], channelType);
      toast.success(t('secureChannel.created'));
      // The sidebar entry arrives via the member-scoped socket event; jumping
      // to a TEXT channel immediately still works because the id is known.
      // Voice channels are joined explicitly from the sidebar instead.
      if (channelType === 'text') setActiveChannel(channel.id);
      onClose();
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.failedToCreate'));
    } finally {
      setCreating(false);
    }
  };

  const sectionLabel = 'text-xs font-semibold uppercase tracking-wide text-vox-text-secondary';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="secure-channel-create-title"
    >
      <div
        className="flex h-[min(640px,90vh)] w-full max-w-3xl flex-col rounded-2xl border border-vox-border bg-vox-bg-secondary shadow-2xl animate-slide-up"
        data-testid="secure-channel-create-modal"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 pt-6">
          <div className="min-w-0">
            <h2 id="secure-channel-create-title" className="flex items-center gap-2 text-xl font-bold text-vox-text-primary">
              <Lock size={18} className="shrink-0 text-vox-accent-primary" />
              {t('secureChannel.createTitle')}
            </h2>
            <p className="mt-1 max-w-[64ch] text-sm text-vox-text-secondary">{t('secureChannel.createDescription')}</p>
          </div>
          <button onClick={onClose} className="shrink-0 text-vox-text-muted transition-colors hover:text-vox-text-primary" aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>

        {/* Body: the channel on the left, the people on the right */}
        <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] gap-6 px-6 py-5" data-testid="secure-channel-create-body">
          <div className="flex min-h-0 flex-col gap-4" data-testid="secure-channel-create-channel">
            <div>
              <div className="mb-2 flex gap-2" data-testid="secure-channel-type-choice">
                <button
                  onClick={() => setChannelType('text')}
                  className={channelType === 'text' ? 'btn-primary flex-1 py-1.5 text-xs' : 'btn-ghost flex-1 py-1.5 text-xs'}
                  data-testid="secure-type-text"
                >
                  {t('channel.text')}
                </button>
                <button
                  onClick={() => setChannelType('voice')}
                  disabled={!secureVoiceSupported}
                  title={secureVoiceSupported ? undefined : t('secureVoice.unsupported')}
                  className={channelType === 'voice' ? 'btn-primary flex-1 py-1.5 text-xs' : 'btn-ghost flex-1 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50'}
                  data-testid="secure-type-voice"
                >
                  {t('channel.voiceType')}
                </button>
              </div>
              {channelType === 'voice' && (
                <p className="text-xs text-vox-text-muted">{t('secureVoice.createHint')}</p>
              )}
            </div>

            <div>
              <label htmlFor="secure-channel-name" className={clsx(sectionLabel, 'mb-1.5 block')}>
                {t('secureChannel.renameLabel')}
              </label>
              <input
                id="secure-channel-name"
                type="text"
                className="input text-sm"
                placeholder={t('secureChannel.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
                data-testid="secure-channel-name"
              />
            </div>

            {/* Who is picked: under the name, always on screen, each chip
                removes its member. The box scrolls on its own, so the whole
                right column stays the search and the list. */}
            <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-dashed border-vox-border px-2.5 py-2" data-testid="secure-selected">
              <div className="mb-1 text-[11px] font-medium text-vox-text-muted">
                {t('secureChannel.selectedMembers', { count: selected.size })}
              </div>
              {selected.size === 0 ? (
                <p className="text-xs text-vox-text-muted" data-testid="secure-selected-empty">{t('secureChannel.noneSelected')}</p>
              ) : (
                <div className="flex min-h-0 flex-1 flex-wrap content-start items-start gap-1.5 overflow-y-auto">
                  {[...selected.values()].map((m) => (
                    <button
                      key={m.userId}
                      type="button"
                      onClick={() => toggle(m)}
                      className="group flex items-center gap-1.5 rounded-full border border-vox-border bg-vox-bg-tertiary py-0.5 pl-0.5 pr-2 text-[12.5px] text-vox-text-primary transition-colors hover:border-vox-accent-danger hover:text-vox-accent-danger"
                      aria-label={t('secureChannel.removeFromInvite', { name: displayName(m) })}
                      title={t('secureChannel.removeFromInvite', { name: displayName(m) })}
                      data-testid={`secure-selected-${m.user.username}`}
                    >
                      <Avatar avatarUrl={m.user.avatarUrl} displayName={m.user.displayName} size="xs" />
                      <span className="max-w-[140px] truncate">{displayName(m)}</span>
                      <X size={12} className="shrink-0 text-vox-text-muted group-hover:text-vox-accent-danger" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Member picker: the whole column is the search and the list */}
          <div className="flex min-h-0 flex-col" data-testid="secure-channel-create-people">
            <div className={clsx(sectionLabel, 'mb-2')}>
              {t('secureChannel.inviteMembers', { count: selected.size, max: maxInvitees })}
            </div>

            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-vox-text-muted" />
              <input
                type="text"
                className="input w-full pl-8 text-sm"
                placeholder={t('secureChannel.searchMembers')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="secure-member-search"
              />
            </div>

            {/* The list fills the rest of the dialog; selected rows are highlighted */}
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-vox-border" data-testid="secure-candidates">
              {candidates.length === 0 && (
                <p className="px-3 py-4 text-center text-sm text-vox-text-muted">{t('secureChannel.noMembersFound')}</p>
              )}
              {candidates.map((m) => {
                const isSelected = selected.has(m.userId);
                return (
                  <button
                    key={m.userId}
                    type="button"
                    onClick={() => toggle(m)}
                    aria-pressed={isSelected}
                    className={clsx(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                      isSelected ? 'bg-vox-accent-tint' : 'hover:bg-vox-bg-hover'
                    )}
                    data-testid={`secure-invite-${m.user.username}`}
                  >
                    <Avatar avatarUrl={m.user.avatarUrl} displayName={m.user.displayName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-vox-text-primary">{displayName(m)}</div>
                      <div className="truncate text-xs text-vox-text-muted">@{m.user.username}</div>
                    </div>
                    <span
                      className={
                        isSelected
                          ? 'flex h-5 w-5 items-center justify-center rounded-md bg-vox-accent-primary text-white'
                          : 'h-5 w-5 rounded-md border border-vox-border'
                      }
                    >
                      {isSelected && <Check size={13} />}
                    </span>
                  </button>
                );
              })}
              <MemberDirectoryFooter directory={directory} shown={candidates.length} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-vox-border px-6 py-4">
          <button onClick={onClose} className="btn-ghost px-5 py-2 text-sm">
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="btn-primary px-6 py-2 text-sm disabled:opacity-50"
            data-testid="secure-channel-create"
          >
            {creating ? t('secureChannel.creating') : t('secureChannel.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
