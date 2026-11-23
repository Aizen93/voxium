import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { UserX, Ban } from 'lucide-react';
import { clsx } from 'clsx';
import { formatMessageStamp } from '../../utils/formatDate';

/**
 * What a direct conversation shows where the other side's account was deleted
 * (utils/dmParticipant.ts): a neutral avatar (no image, no initial, no
 * presence), the read-only notice in place of the composer, and the quiet
 * line that stands for each of that account's messages. Never the server's
 * strings for the placeholder: every word here is localised.
 */

const AVATAR_SIZES = {
  sm: 'h-8 w-8 rounded-[10px]',
  md: 'h-10 w-10 rounded-xl',
} as const;

/** The deleted account's avatar: one neutral icon, never an image or an initial. */
export function DeletedUserAvatar({ size = 'md', className }: { size?: keyof typeof AVATAR_SIZES; className?: string }) {
  return (
    <div
      data-testid="deleted-user-avatar"
      aria-hidden
      className={clsx(
        'flex shrink-0 items-center justify-center bg-vox-bg-tertiary text-vox-text-muted',
        AVATAR_SIZES[size],
        className,
      )}
    >
      <UserX size={size === 'sm' ? 15 : 18} />
    </div>
  );
}

/** In place of the composer: why nothing can be written here. */
export function ReadOnlyConversationNotice() {
  const { t } = useTranslation();
  return (
    <div className="px-4 pb-4 pt-1">
      <div
        role="status"
        data-testid="dm-read-only-notice"
        className="flex items-center gap-2 rounded-2xl border border-vox-border bg-vox-bg-secondary px-4 py-3 text-[13px] text-vox-text-secondary"
      >
        <Ban size={15} className="shrink-0 text-vox-text-muted" aria-hidden />
        <span>{t('dm.deletedParticipant.readOnlyNotice')}</span>
      </div>
    </div>
  );
}

function rowTime(dateStr: string, t: TFunction): string {
  return formatMessageStamp(dateStr, t);
}

/**
 * A deleted account's message: "Message deleted" and its time, nothing else —
 * no author link, no hover toolbar, no action. Vertical space is padding: the
 * list measures this box (the row-spacing rule of the message lists).
 */
export function DeletedMessageRow({ messageId, createdAt }: { messageId: string; createdAt: string }) {
  const { t } = useTranslation();
  const time = rowTime(createdAt, t);
  return (
    <div
      // the row's id like every message row: a quote of it scrolls here
      data-message-id={messageId}
      data-testid="deleted-message-row"
      className="flex items-center gap-2 px-2.5 py-1 pl-[60px] text-[13px] italic text-vox-text-muted"
    >
      <span>{t('dm.deletedParticipant.messageDeleted')}</span>
      {time && <span className="font-mono text-[10.5px] not-italic text-vox-text-muted/80">{time}</span>}
    </div>
  );
}
