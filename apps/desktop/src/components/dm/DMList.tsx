import { useEffect } from 'react';
import { useDMStore } from '../../stores/dmStore';
import { useChatStore } from '../../stores/chatStore';
import { Avatar } from '../common/Avatar';
import { MessageSquare } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';

export function DMList() {
  const { conversations, activeConversationId, isLoading, fetchConversations, setActiveConversation, dmUnreadCounts } = useDMStore();

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const handleOpenConversation = (conversationId: string) => {
    useChatStore.getState().clearMessages();
    setActiveConversation(conversationId);
  };

  return (
    <div className="flex h-full w-60 flex-col bg-vox-channel">
      {/* Header */}
      <div className="flex h-12 items-center gap-2 border-b border-vox-border px-4 shadow-sm">
        <MessageSquare size={16} className="text-vox-text-muted" />
        <h2 className="text-sm font-semibold text-vox-text-primary">Direct Messages</h2>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {isLoading && conversations.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
          </div>
        )}

        {!isLoading && conversations.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 px-2 text-center">
            <MessageSquare size={24} className="text-vox-text-muted" />
            <p className="text-xs text-vox-text-muted">
              No conversations yet. Click a member in any server to start one.
            </p>
          </div>
        )}

        {conversations.map((conv) => {
          const unread = dmUnreadCounts[conv.id] || 0;
          const isActive = activeConversationId === conv.id;

          return (
            <button
              key={conv.id}
              onClick={() => handleOpenConversation(conv.id)}
              className={clsx(
                'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                isActive
                  ? 'bg-vox-bg-active text-vox-text-primary'
                  : unread > 0
                    ? 'text-vox-text-primary hover:bg-vox-bg-hover'
                    : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
              )}
            >
              <Avatar
                avatarUrl={conv.participant.avatarUrl}
                displayName={conv.participant.displayName}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <span className={clsx(
                  'block truncate text-sm',
                  isActive ? 'font-medium' : unread > 0 ? 'font-semibold' : ''
                )}>
                  {conv.participant.displayName}
                </span>
                {conv.lastMessage && (
                  <p className="truncate text-[11px] text-vox-text-muted">
                    {conv.lastMessage.content}
                  </p>
                )}
              </div>
              {unread > 0 && (
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-vox-accent-primary px-1 text-[10px] font-bold text-white shrink-0">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
