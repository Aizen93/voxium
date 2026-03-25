import { useTranslation } from 'react-i18next';
import { Avatar } from '../common/Avatar';
import { useFriendStore } from '../../stores/friendStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { MessageSquare, Check, X, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { Friendship } from '@voxium/shared';

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-vox-accent-success',
  idle: 'bg-vox-accent-warning',
  dnd: 'bg-vox-accent-danger',
  offline: 'bg-vox-text-muted',
};

interface Props {
  friendship: Friendship;
  variant: 'accepted' | 'incoming' | 'outgoing';
}

export function FriendListItem({ friendship, variant }: Props) {
  const { t } = useTranslation();
  const { user } = friendship;
  const status = user.status || 'offline';

  const handleMessage = async () => {
    try {
      const conversationId = await useDMStore.getState().openDM(user.id);
      useServerStore.setState({ activeServerId: null, activeChannelId: null });
      useFriendStore.getState().setShowFriendsView(false);
      useDMStore.getState().setActiveConversation(conversationId);
    } catch {
      toast.error(t('friends.failedToOpenConversation'));
    }
  };

  const handleAccept = async () => {
    try {
      await useFriendStore.getState().acceptRequest(friendship.id);
    } catch {
      toast.error(t('friends.failedToAccept'));
    }
  };

  const handleRemove = async () => {
    try {
      await useFriendStore.getState().removeFriendship(friendship.id);
    } catch {
      toast.error(t('friends.failedToRemove'));
    }
  };

  return (
    <div className="group flex items-center gap-3 rounded-md px-3 py-2 hover:bg-vox-bg-hover transition-colors">
      {/* Avatar with status dot */}
      <div className="relative shrink-0">
        <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />
        <div
          className={clsx(
            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-vox-bg-secondary',
            STATUS_COLORS[status]
          )}
        />
      </div>

      {/* Name + username */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-vox-text-primary">
          {user.displayName}
        </p>
        <p className="truncate text-xs text-vox-text-muted">
          @{user.username}
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex shrink-0 items-center gap-1">
        {variant === 'accepted' && (
          <>
            <button
              onClick={handleMessage}
              className="rounded-full p-1.5 text-vox-text-muted hover:bg-vox-bg-active hover:text-vox-text-primary transition-colors"
              title={t('friends.message')}
              aria-label={t('friends.message')}
            >
              <MessageSquare size={16} />
            </button>
            <button
              onClick={handleRemove}
              className="rounded-full p-1.5 text-vox-text-muted opacity-0 group-hover:opacity-100 hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger transition-all"
              title={t('friends.removeFriend')}
              aria-label={t('friends.removeFriend')}
            >
              <Trash2 size={16} />
            </button>
          </>
        )}

        {variant === 'incoming' && (
          <>
            <button
              onClick={handleAccept}
              className="rounded-full p-1.5 text-vox-text-muted hover:bg-vox-accent-success/20 hover:text-vox-accent-success transition-colors"
              title={t('friends.accept')}
              aria-label={t('friends.accept')}
            >
              <Check size={16} />
            </button>
            <button
              onClick={handleRemove}
              className="rounded-full p-1.5 text-vox-text-muted hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger transition-colors"
              title={t('friends.decline')}
              aria-label={t('friends.decline')}
            >
              <X size={16} />
            </button>
          </>
        )}

        {variant === 'outgoing' && (
          <button
            onClick={handleRemove}
            className="rounded-full p-1.5 text-vox-text-muted hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger transition-colors"
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
