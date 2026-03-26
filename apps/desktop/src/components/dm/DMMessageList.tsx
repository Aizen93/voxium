import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from '../chat/MessageItem';
import { Phone, ArrowDown } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';

interface Props {
  conversationId: string;
}

export function DMMessageList({ conversationId }: Props) {
  const { t } = useTranslation();
  const { messages, hasMore, isLoading, fetchDMMessages, typingUsers, targetMessageId, clearTargetMessage } = useChatStore();
  const { user } = useAuthStore();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const fetchingRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Scroll to bottom on conversation change
  useEffect(() => {
    fetchingRef.current = false;
    setShowScrollButton(false);
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
    });
  }, [conversationId]);

  // Scroll to target message (from search)
  useEffect(() => {
    if (!targetMessageId) return;
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;
    const idx = messages.findIndex((m) => m.id === targetMessageId);
    if (idx !== -1) {
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
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

  const handleStartReached = useCallback(() => {
    if (!hasMore || isLoading || fetchingRef.current || messages.length === 0) return;
    fetchingRef.current = true;
    const oldestMessage = messages[0];
    fetchDMMessages(conversationId, oldestMessage.createdAt).finally(() => {
      fetchingRef.current = false;
    });
  }, [hasMore, isLoading, conversationId, messages, fetchDMMessages]);

  const handleAtBottomChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom);
    setShowScrollButton(!bottom);
  }, []);

  const shouldShowHeader = (index: number) => {
    if (index === 0) return true;
    const prev = messages[index - 1];
    const curr = messages[index];
    if (curr.type === 'system' || prev.type === 'system') return true;
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
          className="h-full px-4 !overflow-x-hidden"
          followOutput={atBottom ? 'smooth' : false}
          startReached={handleStartReached}
          atBottomStateChange={handleAtBottomChange}
          atBottomThreshold={100}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          firstItemIndex={Math.max(0, 1000000 - messages.length)}
          initialTopMostItemIndex={messages.length - 1}
          itemContent={(index, message) => {
            const dataIndex = index - Math.max(0, 1000000 - messages.length);

            // System messages (call started/ended)
            if (message.type === 'system') {
              const date = new Date(message.createdAt);
              const timeStr = isToday(date)
                ? t('messageItem.todayAt', { time: format(date, 'h:mm a') })
                : isYesterday(date)
                  ? t('messageItem.yesterdayAt', { time: format(date, 'h:mm a') })
                  : format(date, 'MM/dd/yyyy h:mm a');

              return (
                <div className="my-3 flex items-center justify-center gap-2">
                  <div className="flex items-center gap-2 rounded-full bg-vox-bg-secondary px-4 py-1.5">
                    <Phone size={14} className="text-vox-text-muted" />
                    <span className="text-xs text-vox-text-secondary">{message.content}</span>
                    <span className="text-[10px] text-vox-text-muted">{timeStr}</span>
                  </div>
                </div>
              );
            }

            const showHeader = shouldShowHeader(dataIndex);
            const isOwn = message.author.id === user?.id;

            return (
              <MessageItem
                key={message.id}
                message={message}
                showHeader={showHeader}
                addTopMargin={showHeader && dataIndex > 0}
                isOwn={isOwn}
                canDelete={isOwn}
                channelId={undefined}
                conversationId={conversationId}
              />
            );
          }}
          components={{
            Header: () =>
              !hasMore && messages.length > 0 ? (
                <div className="mb-6 border-b border-vox-border pb-4 pt-4">
                  <h4 className="text-2xl font-bold text-vox-text-primary">{t('dm.beginningOfConversation')}</h4>
                  <p className="text-sm text-vox-text-secondary">{t('dm.conversationStart')}</p>
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
