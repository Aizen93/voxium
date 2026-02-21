import { useEffect, useRef } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { getSocket } from '../../services/socket';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { Hash } from 'lucide-react';

export function ChatArea() {
  const { channels, activeChannelId } = useServerStore();
  const { fetchMessages, clearMessages } = useChatStore();
  const prevChannelRef = useRef<string | null>(null);

  const activeChannel = channels.find((c) => c.id === activeChannelId);

  // Join/leave socket channel rooms and fetch messages when channel changes
  useEffect(() => {
    if (!activeChannelId || activeChannelId === prevChannelRef.current) return;

    const socket = getSocket();

    // Leave previous channel room
    if (prevChannelRef.current && socket) {
      console.log('[Chat] Leaving channel room:', prevChannelRef.current);
      socket.emit('channel:leave', prevChannelRef.current);
    }

    prevChannelRef.current = activeChannelId;

    // Join new channel room
    if (socket) {
      console.log('[Chat] Joining channel room:', activeChannelId);
      socket.emit('channel:join', activeChannelId);
    }

    clearMessages();
    fetchMessages(activeChannelId);
  }, [activeChannelId, clearMessages, fetchMessages]);

  // Re-join channel room on socket reconnection
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleReconnect = () => {
      if (prevChannelRef.current) {
        console.log('[Chat] Reconnected, re-joining channel room:', prevChannelRef.current);
        socket.emit('channel:join', prevChannelRef.current);
      }
    };

    socket.on('connect', handleReconnect);
    return () => {
      socket.off('connect', handleReconnect);
      if (prevChannelRef.current && socket) {
        socket.emit('channel:leave', prevChannelRef.current);
      }
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
        <h3 className="text-sm font-semibold text-vox-text-primary">{activeChannel.name}</h3>
      </div>

      {/* Messages */}
      <MessageList />

      {/* Input */}
      <MessageInput channelId={activeChannel.id} channelName={activeChannel.name} />
    </div>
  );
}
