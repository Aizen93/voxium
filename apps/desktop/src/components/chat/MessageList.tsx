import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';

export function MessageList() {
  const { messages, hasMore, isLoading, fetchMessages, typingUsers, targetMessageId, clearTargetMessage } = useChatStore();
  const { activeChannelId, members } = useServerStore();
  const { user } = useAuthStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const fetchingRef = useRef(false); // local guard against concurrent scroll fetches

  const currentMember = members.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'owner' || currentMember?.role === 'admin';

  // Auto-scroll to bottom on new messages if near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Scroll to bottom on channel change
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
    fetchingRef.current = false;
  }, [activeChannelId]);

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

    // Check if near bottom
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;

    // Load more when scrolled to top — use local ref to prevent concurrent requests
    if (
      el.scrollTop < 50 &&
      hasMore &&
      !isLoading &&
      !fetchingRef.current &&
      activeChannelId &&
      messages.length > 0
    ) {
      fetchingRef.current = true;
      const oldestMessage = messages[0];
      const scrollHeightBefore = el.scrollHeight;

      fetchMessages(activeChannelId, oldestMessage.createdAt).finally(() => {
        fetchingRef.current = false;
        // Preserve scroll position after prepending messages
        requestAnimationFrame(() => {
          if (listRef.current) {
            const scrollHeightAfter = listRef.current.scrollHeight;
            listRef.current.scrollTop += scrollHeightAfter - scrollHeightBefore;
          }
        });
      });
    }
  }, [hasMore, isLoading, activeChannelId, messages, fetchMessages]);

  // Group messages by author for compact display
  const shouldShowHeader = (index: number) => {
    if (index === 0) return true;
    const prev = messages[index - 1];
    const curr = messages[index];
    // Replies always break grouping
    if (curr.replyToId) return true;
    if (prev.author.id !== curr.author.id) return true;
    // Show header if more than 5 minutes apart
    const timeDiff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return timeDiff > 5 * 60 * 1000;
  };

  const typingText = (() => {
    const names = Array.from(typingUsers.values());
    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} is typing...`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
    return `${names[0]} and ${names.length - 1} others are typing...`;
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
          <h4 className="text-2xl font-bold text-vox-text-primary">Welcome to the channel!</h4>
          <p className="text-sm text-vox-text-secondary">This is the beginning of the conversation.</p>
        </div>
      )}

      {messages.map((message, index) => {
        const showHeader = shouldShowHeader(index);
        const isOwn = message.author.id === user?.id;

        return (
          <MessageItem
            key={message.id}
            message={message}
            showHeader={showHeader}
            addTopMargin={showHeader && index > 0}
            isOwn={isOwn}
            canDelete={isOwn || isAdmin}
            channelId={activeChannelId!}
          />
        );
      })}

      {/* Typing indicator */}
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
