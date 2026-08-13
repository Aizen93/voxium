import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { X, Lock, Check, Search } from 'lucide-react';
import { E2E_LIMITS } from '@voxium/shared';
import { getTranslatedError } from '../../utils/serverErrors';

interface Props {
  serverId: string;
  onClose: () => void;
}

/**
 * Create an invite-only E2E-encrypted channel: name + multi-select member
 * picker over the already-loaded server member list. The creator is always a
 * member; invitees are capped at SECURE_CHANNEL_MEMBER_CAP - 1.
 */
export function SecureChannelCreateModal({ serverId, onClose }: Props) {
  const { t } = useTranslation();
  const { members, createSecureChannel, setActiveChannel } = useServerStore();
  const { user } = useAuthStore();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const maxInvitees = E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP - 1;

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => m.userId !== user?.id)
      .filter(
        (m) =>
          !q ||
          m.user.displayName.toLowerCase().includes(q) ||
          m.user.username.toLowerCase().includes(q) ||
          (m.nickname ?? '').toLowerCase().includes(q),
      );
  }, [members, user?.id, query]);

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        if (next.size >= maxInvitees) {
          toast.error(t('secureChannel.memberCapReached', { max: E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP }));
          return prev;
        }
        next.add(userId);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const channel = await createSecureChannel(serverId, name.trim(), [...selected]);
      toast.success(t('secureChannel.created'));
      // The sidebar entry arrives via the member-scoped socket event; jumping
      // to the channel immediately still works because the id is known.
      setActiveChannel(channel.id);
      onClose();
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.failedToCreate'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in" role="dialog" aria-modal="true">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-vox-border bg-vox-bg-secondary p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-bold text-vox-text-primary">
            <Lock size={18} className="text-vox-accent-primary" />
            {t('secureChannel.createTitle')}
          </h2>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>

        <p className="mb-4 text-sm text-vox-text-secondary">{t('secureChannel.createDescription')}</p>

        <input
          type="text"
          className="input mb-3 text-sm"
          placeholder={t('secureChannel.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          autoFocus
          data-testid="secure-channel-name"
        />

        {/* Member picker */}
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
          {t('secureChannel.inviteMembers', { count: selected.size, max: maxInvitees })}
        </label>
        <div className="relative mb-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-vox-text-muted" />
          <input
            type="text"
            className="input w-full pl-8 text-sm"
            placeholder={t('secureChannel.searchMembers')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="mb-4 min-h-24 flex-1 overflow-y-auto rounded-lg border border-vox-border">
          {candidates.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-vox-text-muted">{t('secureChannel.noMembersFound')}</p>
          )}
          {candidates.map((m) => {
            const isSelected = selected.has(m.userId);
            return (
              <button
                key={m.userId}
                onClick={() => toggle(m.userId)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-vox-bg-hover transition-colors"
                data-testid={`secure-invite-${m.user.username}`}
              >
                <Avatar avatarUrl={m.user.avatarUrl} displayName={m.user.displayName} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-vox-text-primary">{m.nickname || m.user.displayName}</div>
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
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="btn-primary flex-1 py-2 text-sm disabled:opacity-50"
            data-testid="secure-channel-create"
          >
            {creating ? t('secureChannel.creating') : t('secureChannel.create')}
          </button>
          <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
