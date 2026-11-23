import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getTranslatedError } from '../../utils/serverErrors';
import { Plus } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { EmojiPicker } from '../common/EmojiPicker';
import type { ReactionGroup } from '@voxium/shared';

interface Props {
  reactions: ReactionGroup[];
  messageId: string;
  channelId?: string;
  conversationId?: string;
  /** A read-only DM (the other side's account was deleted): the reactions are shown, never toggled or added. */
  readOnly?: boolean;
}

export function ReactionDisplay({ reactions, messageId, channelId, conversationId, readOnly = false }: Props) {
  const { t } = useTranslation();
  const [showPicker, setShowPicker] = useState(false);
  const userId = useAuthStore((s) => s.user?.id);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  // the add control goes away (read-only, or no ADD_REACTIONS): its picker
  // state goes with it, so it does not reopen when the control comes back
  useEffect(() => {
    if (readOnly) setShowPicker(false);
  }, [readOnly]);

  if (reactions.length === 0 && (!showPicker || readOnly)) return null;

  const handleToggle = async (emoji: string) => {
    if (readOnly) return;
    try {
      if (conversationId) {
        await useChatStore.getState().toggleDMReaction(conversationId, messageId, emoji);
      } else if (channelId) {
        await useChatStore.getState().toggleReaction(channelId, messageId, emoji);
      }
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'messageItem.failedToToggleReaction'));
    }
  };

  const handlePickerSelect = (emoji: string) => {
    handleToggle(emoji);
    setShowPicker(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 pl-[52px] mt-1">
      {reactions.map((r) => {
        const isOwn = userId ? r.userIds.includes(userId) : false;
        return (
          <button
            key={r.emoji}
            onClick={() => handleToggle(r.emoji)}
            disabled={readOnly}
            className={`flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors disabled:cursor-default ${
              isOwn
                ? 'border-vox-accent-primary/40 bg-vox-accent-tint text-vox-text-primary'
                : 'border-vox-border bg-vox-bg-hover text-vox-text-secondary hover:border-vox-border-strong'
            }`}
          >
            <span>{r.emoji}</span>
            <span className="font-mono text-[11px]">{r.count}</span>
          </button>
        );
      })}
      {!readOnly && (
        <button
          ref={addBtnRef}
          onClick={() => setShowPicker(!showPicker)}
          className="flex h-[26px] w-[30px] items-center justify-center rounded-full border border-dashed border-vox-border-strong text-vox-text-muted hover:border-vox-text-muted hover:text-vox-text-primary transition-colors"
          title={t('messageItem.addReaction')}
          aria-label={t('messageItem.addReaction')}
        >
          <Plus size={12} />
        </button>
      )}
      {!readOnly && showPicker && (
        <EmojiPicker
          anchorRef={addBtnRef}
          onEmojiSelect={handlePickerSelect}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
