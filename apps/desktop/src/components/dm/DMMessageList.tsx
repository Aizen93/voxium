import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from '../chat/MessageItem';
import { Phone } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';

interface Props {
  conversationId: string;
}

export function DMMessageList({ conversationId }: Props) {
  const { messages, hasMore, isLoading, fetchDMMessages, typingUsers, targetMessageId, clearTargetMessage } = useChatStore();
  const { user } = useAuthStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const fetchingRef = useRef(false);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
    fetchingRef.current = false;
  }, [conversationId]);

  // Scroll to target message (from search)
  useEffect(() => {
    if (!targetMessageId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-message-id="${targetMessageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('bg-vox-accent-primary/10');
        setTimeout(() => el.classList.remove('bg-vox-accent-primary/10'), 2000);
      }
      clearTargetMessage();
    });
  }, [targetMessageId, clearTargetMessage]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;

    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;

    if (
      el.scrollTop < 50 &&
      hasMore &&
      !isLoading &&
      !fetchingRef.current &&
      messages.length > 0
    ) {
      fetchingRef.current = true;
      const oldestMessage = messages[0];
      const scrollHeightBefore = el.scrollHeight;

      fetchDMMessages(conversationId, oldestMessage.createdAt).finally(() => {
        fetchingRef.current = false;
        requestAnimationFrame(() => {
          if (listRef.current) {
            const scrollHeightAfter = listRef.current.scrollHeight;
            listRef.current.scrollTop += scrollHeightAfter - scrollHeightBefore;
          }
        });
      });
    }
  }, [hasMore, isLoading, conversationId, messages, fetchDMMessages]);

  const shouldShowHeader = (index: number) => {
    if (index === 0) return true;
    const prev = messages[index - 1];
    const curr = messages[index];
    // System messages always break grouping
    if (curr.type === 'system' || prev.type === 'system') return true;
    // Replies always break grouping
    if (curr.replyToId) return true;
    if (prev.author.id !== curr.author.id) return true;
    const timeDiff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return timeDiff > 5 * 60 * 1000;
  };

  const typingText = (() => {
    const names = Array.from(typingUsers.values());
    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} is typing...`;
    return `${names.join(' and ')} are typing...`;
  })();

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
    >
      {isLoading && messages.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
        </div>
      )}

      {!hasMore && messages.length > 0 && (
        <div className="mb-6 border-b border-vox-border pb-4">
          <h4 className="text-2xl font-bold text-vox-text-primary">Beginning of conversation</h4>
          <p className="text-sm text-vox-text-secondary">This is the start of your direct message history.</p>
        </div>
      )}

      {messages.map((message, index) => {
        // System messages (call started/ended)
        if (message.type === 'system') {
          const date = new Date(message.createdAt);
          const timeStr = isToday(date)
            ? `Today at ${format(date, 'h:mm a')}`
            : isYesterday(date)
              ? `Yesterday at ${format(date, 'h:mm a')}`
              : format(date, 'MM/dd/yyyy h:mm a');

          return (
            <div key={message.id} className="my-3 flex items-center justify-center gap-2">
              <div className="flex items-center gap-2 rounded-full bg-vox-bg-secondary px-4 py-1.5">
                <Phone size={14} className="text-vox-text-muted" />
                <span className="text-xs text-vox-text-secondary">{message.content}</span>
                <span className="text-[10px] text-vox-text-muted">{timeStr}</span>
              </div>
            </div>
          );
        }

        const showHeader = shouldShowHeader(index);
        const isOwn = message.author.id === user?.id;

        return (
          <MessageItem
            key={message.id}
            message={message}
            showHeader={showHeader}
            addTopMargin={showHeader && index > 0}
            isOwn={isOwn}
            canDelete={isOwn}
            channelId={undefined}
            conversationId={conversationId}
          />
        );
      })}

      {typingText && (
        <div className="flex items-center gap-2 px-4 py-1">
          <div className="flex gap-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-xs text-vox-text-muted">{typingText}</span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
