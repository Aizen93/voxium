import { useState, useRef, type KeyboardEvent } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { getSocket } from '../../services/socket';
import { toast } from '../../stores/toastStore';
import { EmojiPicker } from '../common/EmojiPicker';
import { PlusCircle, Smile, Send } from 'lucide-react';

interface Props {
  channelId?: string;
  conversationId?: string;
  channelName?: string;
  placeholderName?: string;
}

export function MessageInput({ channelId, conversationId, channelName, placeholderName }: Props) {
  const { sendMessage, sendDMMessage } = useChatStore();
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  const handleTyping = () => {
    const socket = getSocket();
    if (!socket) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      if (conversationId) {
        socket.emit('dm:typing:start', conversationId);
      } else if (channelId) {
        socket.emit('typing:start', channelId);
      }
    }

    // Reset the typing timeout
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      if (conversationId) {
        socket.emit('dm:typing:stop', conversationId);
      } else if (channelId) {
        socket.emit('typing:stop', channelId);
      }
    }, 2000);
  };

  const handleSend = async () => {
    const trimmed = content.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    try {
      if (conversationId) {
        await sendDMMessage(conversationId, trimmed);
      } else if (channelId) {
        await sendMessage(channelId, trimmed);
      }
      setContent('');
      isTypingRef.current = false;
    } catch {
      toast.error('Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-vox-border px-4 py-3">
      <div className="flex items-end gap-2 rounded-xl bg-vox-bg-floating border border-vox-border px-3 py-2">
        <button className="mb-0.5 text-vox-text-muted hover:text-vox-text-primary transition-colors">
          <PlusCircle size={20} />
        </button>

        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); handleTyping(); }}
          onKeyDown={handleKeyDown}
          placeholder={conversationId ? `Message @${placeholderName}` : `Message #${channelName}`}
          className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-vox-text-primary
                     placeholder:text-vox-text-muted focus:outline-none"
          rows={1}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = `${Math.min(target.scrollHeight, 144)}px`;
          }}
        />

        <button
          ref={emojiBtnRef}
          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
          className="mb-0.5 text-vox-text-muted hover:text-vox-text-primary transition-colors"
        >
          <Smile size={20} />
        </button>
        {showEmojiPicker && (
          <EmojiPicker
            anchorRef={emojiBtnRef}
            onEmojiSelect={(emoji) => {
              setContent((prev) => prev + emoji);
              setShowEmojiPicker(false);
            }}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}

        {content.trim() && (
          <button
            onClick={handleSend}
            disabled={isSending}
            className="mb-0.5 text-vox-accent-primary hover:text-vox-accent-hover transition-colors disabled:opacity-50"
          >
            <Send size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
