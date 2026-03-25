import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';
import { ArrowDown } from 'lucide-react';

export function MessageList() {
  const { t } = useTranslation();
  const { messages, hasMore, isLoading, fetchMessages, typingUsers, targetMessageId, clearTargetMessage } = useChatStore();
  const { activeChannelId, members } = useServerStore();
  const { user } = useAuthStore();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const fetchingRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const currentMember = members.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'owner' || currentMember?.role === 'admin';

  // Scroll to bottom on channel change
  useEffect(() => {
    fetchingRef.current = false;
    setShowScrollButton(false);
    // Small delay to let Virtuoso render
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
    });
  }, [activeChannelId]);

  // Scroll to target message (from search)
  useEffect(() => {
    if (!targetMessageId) return;
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;
    const idx = messages.findIndex((m) => m.id === targetMessageId);
    if (idx !== -1) {
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
      // Highlight after scroll
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${targetMessageId}"]`);
        if (el) {
          el.classList.add('bg-vox-accent-primary/10');
          highlightTimer = setTimeout(() => el.classList.remove('bg-vox-accent-primary/10'), 2000);
        }
      });
    }
    clearTargetMessage();
    return () => {
      if (highlightTimer) clearTimeout(highlightTimer);
    };
  }, [targetMessageId, clearTargetMessage, messages]);

  // Load older messages when scrolled to top
  const handleStartReached = useCallback(() => {
    if (!hasMore || isLoading || fetchingRef.current || !activeChannelId || messages.length === 0) return;
    fetchingRef.current = true;
    const oldestMessage = messages[0];
    fetchMessages(activeChannelId, oldestMessage.createdAt).finally(() => {
      fetchingRef.current = false;
    });
  }, [hasMore, isLoading, activeChannelId, messages, fetchMessages]);

  const handleAtBottomChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom);
    setShowScrollButton(!bottom);
  }, []);

  // Group messages by author for compact display
  const shouldShowHeader = (index: number) => {
    if (index === 0) return true;
    const prev = messages[index - 1];
    const curr = messages[index];
    if (curr.replyToId) return true;
    if (prev.author.id !== curr.author.id) return true;
    const timeDiff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return timeDiff > 5 * 60 * 1000;
  };

  const typingText = (() => {
    const names = Array.from(typingUsers.values());
    if (names.length === 0) return null;
    if (names.length === 1) return t('chat.typing', { user: names[0] });
    if (names.length === 2) return t('chat.typingTwo', { user1: names[0], user2: names[1] });
    return t('chat.typingMany', { user: names[0], count: names.length - 1 });
  })();

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      {isLoading && messages.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
        </div>
      )}

      {messages.length > 0 && (
        <Virtuoso
          ref={virtuosoRef}
          data={messages}
          className="h-full px-4"
          followOutput={atBottom ? 'smooth' : false}
          startReached={handleStartReached}
          atBottomStateChange={handleAtBottomChange}
          atBottomThreshold={100}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          firstItemIndex={Math.max(0, 1000000 - messages.length)}
          initialTopMostItemIndex={messages.length - 1}
          itemContent={(index, message) => {
            const dataIndex = index - Math.max(0, 1000000 - messages.length);
            const showHeader = shouldShowHeader(dataIndex);
            const isOwn = message.author.id === user?.id;

            return (
              <MessageItem
                key={message.id}
                message={message}
                showHeader={showHeader}
                addTopMargin={showHeader && dataIndex > 0}
                isOwn={isOwn}
                canDelete={isOwn || isAdmin}
                channelId={activeChannelId!}
              />
            );
          }}
          components={{
            Header: () =>
              !hasMore && messages.length > 0 ? (
                <div className="mb-6 border-b border-vox-border pb-4 pt-4">
                  <h4 className="text-2xl font-bold text-vox-text-primary">Welcome to the channel!</h4>
                  <p className="text-sm text-vox-text-secondary">This is the beginning of the conversation.</p>
                </div>
              ) : null,
            Footer: () =>
              typingText ? (
                <div className="flex items-center gap-2 px-4 py-1">
                  <div className="flex gap-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-xs text-vox-text-muted">{typingText}</span>
                </div>
              ) : null,
          }}
        />
      )}

      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-vox-bg-tertiary text-vox-text-secondary shadow-lg hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}
