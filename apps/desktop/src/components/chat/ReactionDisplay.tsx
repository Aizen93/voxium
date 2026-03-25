import { useState, useRef } from 'react';
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
}

export function ReactionDisplay({ reactions, messageId, channelId, conversationId }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const userId = useAuthStore((s) => s.user?.id);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  if (reactions.length === 0 && !showPicker) return null;

  const handleToggle = async (emoji: string) => {
    try {
      if (conversationId) {
        await useChatStore.getState().toggleDMReaction(conversationId, messageId, emoji);
      } else if (channelId) {
        await useChatStore.getState().toggleReaction(channelId, messageId, emoji);
      }
    } catch {
      toast.error('Failed to toggle reaction');
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
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors border ${
              isOwn
                ? 'border-vox-accent-primary/50 bg-vox-accent-primary/10 text-vox-text-primary'
                : 'border-vox-border bg-vox-bg-secondary text-vox-text-secondary hover:bg-vox-bg-hover'
            }`}
          >
            <span>{r.emoji}</span>
            <span>{r.count}</span>
          </button>
        );
      })}
      <button
        ref={addBtnRef}
        onClick={() => setShowPicker(!showPicker)}
        className="flex items-center justify-center rounded-full w-6 h-6 border border-vox-border bg-vox-bg-secondary text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
        title="Add reaction"
        aria-label="Add reaction"
      >
        <Plus size={12} />
      </button>
      {showPicker && (
        <EmojiPicker
          anchorRef={addBtnRef}
          onEmojiSelect={handlePickerSelect}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
