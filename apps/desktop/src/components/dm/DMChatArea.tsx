import { useEffect, useRef, useCallback, useState } from 'react';
import { useDMStore } from '../../stores/dmStore';
import { useChatStore } from '../../stores/chatStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { getSocket, onConnectionStatusChange } from '../../services/socket';
import { api } from '../../services/api';
import { DMMessageList } from './DMMessageList';
import { DMCallPanel } from './DMCallPanel';
import { MessageInput } from '../chat/MessageInput';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { Phone, PhoneOff, Search } from 'lucide-react';
import { SearchModal } from '../search/SearchModal';
import { clsx } from 'clsx';
import type { UserStatus } from '@voxium/shared';

const STATUS_COLORS: Record<UserStatus, string> = {
  online: 'bg-vox-accent-success',
  idle: 'bg-vox-accent-warning',
  dnd: 'bg-vox-accent-danger',
  offline: 'bg-vox-text-muted',
};

export function DMChatArea() {
  const { activeConversationId, conversations } = useDMStore();
  const participantStatuses = useDMStore((s) => s.participantStatuses);
  const fetchDMMessages = useChatStore((s) => s.fetchDMMessages);
  const prevConvRef = useRef<string | null>(null);

  const [showSearch, setShowSearch] = useState(false);
  const dmCallConversationId = useVoiceStore((s) => s.dmCallConversationId);
  const conversation = conversations.find((c) => c.id === activeConversationId);
  const isInCall = dmCallConversationId === activeConversationId;

  const participantId = conversation?.participant.id;
  const participantStatus: UserStatus = participantId
    ? participantStatuses[participantId] || 'offline'
    : 'offline';

  const handleStartCall = useCallback(() => {
    if (activeConversationId) {
      useVoiceStore.getState().joinDMCall(activeConversationId);
    }
  }, [activeConversationId]);

  const handleEndCall = useCallback(() => {
    useVoiceStore.getState().leaveDMCall();
  }, []);

  const joinAndFetch = useCallback(
    (conversationId: string) => {
      const socket = getSocket();
      if (socket) {
        socket.emit('dm:join', conversationId);
      }
      fetchDMMessages(conversationId);
      // Ensure unread is cleared and server is notified — covers reconnect scenarios
      // where dm:unread:init may restore stale counts from a previously failed markConversationRead
      useDMStore.getState().clearDMUnread(conversationId);
      useDMStore.getState().markConversationRead(conversationId);
    },
    [fetchDMMessages]
  );

  // Join DM room and fetch messages when conversation changes
  useEffect(() => {
    if (!activeConversationId || activeConversationId === prevConvRef.current) return;

    prevConvRef.current = activeConversationId;
    joinAndFetch(activeConversationId);
  }, [activeConversationId, joinAndFetch]);

  // Fetch initial participant status
  useEffect(() => {
    if (!participantId) return;
    api.get(`/users/${participantId}`).then(({ data }) => {
      if (data.data?.status) {
        useDMStore.getState().updateParticipantStatus(participantId, data.data.status);
      }
    }).catch(() => {});
  }, [participantId]);

  // Re-join on reconnect
  useEffect(() => {
    let handledSocketId: string | undefined;

    function handleReconnect() {
      const socket = getSocket();
      if (!socket?.connected) return;
      if (socket.id === handledSocketId) return;
      handledSocketId = socket.id;

      const convId = prevConvRef.current;
      if (!convId) return;

      joinAndFetch(convId);
    }

    const socket = getSocket();
    if (socket) {
      socket.on('connect', handleReconnect);
      if (socket.connected) {
        handledSocketId = socket.id;
        if (prevConvRef.current) {
          socket.emit('dm:join', prevConvRef.current);
        }
      }
    }

    const unsubStatus = onConnectionStatusChange((status) => {
      if (status !== 'connected') return;
      const currentSocket = getSocket();
      if (currentSocket && currentSocket !== socket) {
        currentSocket.on('connect', handleReconnect);
      }
      handleReconnect();
    });

    return () => {
      const s = getSocket();
      if (s) s.off('connect', handleReconnect);
      if (socket && socket !== s) socket.off('connect', handleReconnect);
      unsubStatus();
    };
  }, [joinAndFetch]);

  useEffect(() => {
    return () => {
      prevConvRef.current = null;
    };
  }, []);

  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-vox-chat">
        <p className="text-vox-text-muted">Select a conversation</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-vox-chat">
      {/* DM Header */}
      <div className="flex h-12 items-center gap-2 border-b border-vox-border px-4 shadow-sm">
        <UserHoverTarget userId={conversation.participant.id} className="shrink-0 cursor-pointer">
          <div className="relative">
            <Avatar
              avatarUrl={conversation.participant.avatarUrl}
              displayName={conversation.participant.displayName}
              size="sm"
            />
            <div className={clsx(
              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-vox-bg-primary',
              STATUS_COLORS[participantStatus]
            )} />
          </div>
        </UserHoverTarget>
        <UserHoverTarget userId={conversation.participant.id} className="flex-1 min-w-0 cursor-pointer">
          <h3 className="text-sm font-semibold text-vox-text-primary hover:underline truncate">
            {conversation.participant.displayName}
          </h3>
        </UserHoverTarget>
        <button
          onClick={() => setShowSearch(true)}
          className="rounded-md p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
          title="Search Messages (Ctrl+K)"
        >
          <Search size={18} />
        </button>
        {isInCall ? (
          <button
            onClick={handleEndCall}
            className="rounded-md p-1.5 text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
            title="End Call"
          >
            <PhoneOff size={18} />
          </button>
        ) : (
          <button
            onClick={handleStartCall}
            className="rounded-md p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            title="Start Voice Call"
          >
            <Phone size={18} />
          </button>
        )}
      </div>

      {/* Active Call Panel */}
      {isInCall && <DMCallPanel />}

      {/* Messages */}
      <DMMessageList conversationId={conversation.id} />

      {/* Input */}
      <MessageInput
        conversationId={conversation.id}
        placeholderName={conversation.participant.displayName}
      />

      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          conversationId={conversation.id}
          participantName={conversation.participant.displayName}
        />
      )}
    </div>
  );
}
