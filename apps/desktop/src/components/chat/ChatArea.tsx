import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { getSocket, onConnectionStatusChange } from '../../services/socket';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SearchModal } from '../search/SearchModal';
import { SearchField } from '../search/SearchField';

export function ChatArea() {
  const { t } = useTranslation();
  const { channels, activeChannelId, activeServerId } = useServerStore();
  const [showSearch, setShowSearch] = useState(false);
  const { fetchMessages, clearMessages } = useChatStore();
  const prevChannelRef = useRef<string | null>(null);
  // The chat store records no view (a clear: every writer then drops what it
  // brings) or another one than this channel's. This view's own fetch
  // records the channel as it starts, failed or aborted later or not.
  const viewElsewhere = useChatStore((s) => {
    const scope = s.viewScope;
    if (scope === null) return true;
    return !!scope && (scope.kind !== 'channel' || scope.id !== activeChannelId);
  });

  const activeChannel = channels.find((c) => c.id === activeChannelId);

  /**
   * Ensure the current channel room is joined and messages are loaded.
   * Called on channel switch, socket reconnect, and initial ready.
   */
  const joinAndFetch = useCallback(
    (channelId: string) => {
      const socket = getSocket();
      if (socket) {
        socket.emit('channel:join', channelId);
      }
      clearMessages();
      fetchMessages(channelId);
      // Ensure unread is cleared and server is notified — covers reconnect scenarios
      // where unread:init may restore stale counts from a previously failed markChannelRead
      useServerStore.getState().clearUnread(channelId);
      useServerStore.getState().markChannelRead(channelId);
    },
    [clearMessages, fetchMessages]
  );

  // Join socket channel room and fetch messages when channel changes, and
  // when the chat store stops recording this channel's view while it stays
  // on screen (a clear with the channel unchanged): loaded again as on a
  // change, or its history would be gone and its live messages dropped
  useEffect(() => {
    if (!activeChannelId) {
      // No channel is open (a space without a text channel, the open channel
      // deleted): nothing is the loaded channel any more, so the next
      // selection loads, also when it is the channel that was open before,
      // and a reconnect re-joins nothing meanwhile.
      prevChannelRef.current = null;
      return;
    }
    // the open channel, its view recorded: nothing to load (a re-render, the
    // same channel selected again)
    if (activeChannelId === prevChannelRef.current && !viewElsewhere) return;

    prevChannelRef.current = activeChannelId;

    // Join new channel room and fetch messages
    // (auto-subscription on connect covers existing channels; this handles
    // channels created after the socket connected)
    joinAndFetch(activeChannelId);
  }, [activeChannelId, viewElsewhere, joinAndFetch]);

  // On any (re)connection: re-join channel room and re-fetch messages.
  // Uses DUAL mechanism for maximum reliability:
  //  1. Direct socket.on('connect') listener (most reliable for same socket instance)
  //  2. onConnectionStatusChange (catches socket replacement and initial connect)
  // Deduplication via handledSocketId prevents double-fetch.
  useEffect(() => {
    let handledSocketId: string | undefined;

    function handleReconnect() {
      const socket = getSocket();
      if (!socket?.connected) return;
      // Deduplicate: only process each connection once (both mechanisms may fire)
      if (socket.id === handledSocketId) return;
      handledSocketId = socket.id;

      const channelId = prevChannelRef.current;
      if (!channelId) return;

      if (import.meta.env.DEV) console.log(`[Chat] Socket (re)connected (id=${socket.id}) — re-joining channel: ${channelId}`);
      joinAndFetch(channelId);
    }

    // Mechanism 1: Direct listener on the socket object
    const socket = getSocket();
    if (socket) {
      socket.on('connect', handleReconnect);

      if (socket.connected) {
        // Already connected — mark as handled, ensure room is joined
        handledSocketId = socket.id;
        if (prevChannelRef.current) {
          if (import.meta.env.DEV) console.log('[Chat] Socket already connected on mount — ensuring channel:join');
          socket.emit('channel:join', prevChannelRef.current);
        }
      }
    }

    // Mechanism 2: Status change listener (fires even if socket object was replaced)
    const unsubStatus = onConnectionStatusChange((status) => {
      if (status !== 'connected') return;

      // Also ensure direct listener is on the current socket
      const currentSocket = getSocket();
      if (currentSocket && currentSocket !== socket) {
        currentSocket.on('connect', handleReconnect);
      }

      handleReconnect();
    });

    return () => {
      // Clean up direct listener from any socket we attached to
      const s = getSocket();
      if (s) s.off('connect', handleReconnect);
      if (socket && socket !== s) socket.off('connect', handleReconnect);
      unsubStatus();
    };
  }, [joinAndFetch]);

  // Track channel ref on unmount (no room leave needed — auto-subscription persists)
  useEffect(() => {
    return () => {
      prevChannelRef.current = null;
    };
  }, []);

  if (!activeChannel || activeChannel.type !== 'text') {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-vox-chat">
        <p className="text-vox-text-muted">{t('chat.selectChannel')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-vox-chat">
      {/* Channel Header */}
      <div className="flex h-[54px] flex-none items-center gap-2.5 border-b border-vox-border px-5">
        <span aria-hidden className="font-mono text-[15px] leading-none text-vox-accent-primary">#</span>
        <h3 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-vox-text-primary">{activeChannel.name}</h3>
        <SearchField onOpen={() => setShowSearch(true)} label={t('chat.searchMessages')} className="ml-auto" />
      </div>

      {/* Messages */}
      <MessageList />

      {/* Input */}
      <MessageInput channelId={activeChannel.id} channelName={activeChannel.name} />

      {showSearch && activeServerId && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          serverId={activeServerId}
          channels={channels}
        />
      )}
    </div>
  );
}
