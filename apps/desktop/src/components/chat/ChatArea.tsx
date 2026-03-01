import { useEffect, useRef, useCallback, useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { getSocket, onConnectionStatusChange } from '../../services/socket';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SearchModal } from '../search/SearchModal';
import { Hash, Search } from 'lucide-react';

export function ChatArea() {
  const { channels, activeChannelId, activeServerId } = useServerStore();
  const [showSearch, setShowSearch] = useState(false);
  const { fetchMessages, clearMessages } = useChatStore();
  const prevChannelRef = useRef<string | null>(null);

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
    },
    [clearMessages, fetchMessages]
  );

  // Join socket channel room and fetch messages when channel changes
  useEffect(() => {
    if (!activeChannelId || activeChannelId === prevChannelRef.current) return;

    prevChannelRef.current = activeChannelId;

    // Join new channel room and fetch messages
    // (auto-subscription on connect covers existing channels; this handles
    // channels created after the socket connected)
    joinAndFetch(activeChannelId);
  }, [activeChannelId, joinAndFetch]);

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

      console.log(`[Chat] Socket (re)connected (id=${socket.id}) — re-joining channel: ${channelId}`);
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
          console.log('[Chat] Socket already connected on mount — ensuring channel:join');
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
        <p className="text-vox-text-muted">Select a text channel to start chatting</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-vox-chat">
      {/* Channel Header */}
      <div className="flex h-12 items-center gap-2 border-b border-vox-border px-4 shadow-sm">
        <Hash size={18} className="text-vox-text-muted" />
        <h3 className="flex-1 text-sm font-semibold text-vox-text-primary">{activeChannel.name}</h3>
        <button
          onClick={() => setShowSearch(true)}
          className="rounded-md p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
          title="Search Messages (Ctrl+K)"
        >
          <Search size={18} />
        </button>
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
