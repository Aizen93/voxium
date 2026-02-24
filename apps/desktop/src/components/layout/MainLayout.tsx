import { useEffect, useRef } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { getSocket, getSocketGeneration, onConnectionStatusChange } from '../../services/socket';
import { ServerSidebar } from '../server/ServerSidebar';
import { ChannelSidebar } from '../channel/ChannelSidebar';
import { ChatArea } from '../chat/ChatArea';
import { MemberSidebar } from '../server/MemberSidebar';
import { VoicePanel } from '../voice/VoicePanel';
import { SettingsModal } from '../settings/SettingsModal';
import { ConnectionBanner } from './ConnectionBanner';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePushToTalk } from '../../hooks/usePushToTalk';

export function MainLayout() {
  const { fetchServers, activeServerId } = useServerStore();
  const { user } = useAuthStore();
  const isSettingsOpen = useSettingsStore((s) => s.isSettingsOpen);
  usePushToTalk();
  const attachedGeneration = useRef(-1);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Set local user ID in voice store
  useEffect(() => {
    if (user?.id) {
      useVoiceStore.getState().setLocalUserId(user.id);
    }
  }, [user?.id]);

  // Fetch servers on mount
  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Set up WebSocket event listeners with proper function references
  useEffect(() => {
    // Store function references so cleanup actually works
    const handlers = {
      messageNew: (message: any) => useChatStore.getState().addMessage(message),
      messageUpdate: (message: any) => useChatStore.getState().updateMessage(message),
      messageDelete: ({ messageId }: any) => useChatStore.getState().deleteMessage(messageId),
      typingStart: ({ userId, username }: any) => {
        const currentUser = useAuthStore.getState().user;
        if (userId !== currentUser?.id) {
          useChatStore.getState().setTypingUser(userId, username);
        }
      },
      typingStop: ({ userId }: any) => useChatStore.getState().removeTypingUser(userId),
      presenceUpdate: ({ userId, status }: any) => useServerStore.getState().updateMemberStatus(userId, status),
      voiceChannelUsers: ({ channelId, users: voiceUsers }: any) => {
        useVoiceStore.getState().setChannelUsers(channelId, voiceUsers);
      },
      voiceUserJoined: ({ channelId, user: voiceUser }: any) => {
        useVoiceStore.getState().addUserToChannel(channelId, voiceUser);
      },
      voiceUserLeft: ({ channelId, userId }: any) => {
        useVoiceStore.getState().removeUserFromChannel(channelId, userId);
      },
      voiceStateUpdate: ({ channelId, userId, selfMute, selfDeaf }: any) => {
        useVoiceStore.getState().updateUserState(channelId, userId, selfMute, selfDeaf);
      },
      voiceSpeaking: ({ channelId, userId, speaking }: any) => {
        useVoiceStore.getState().setUserSpeaking(channelId, userId, speaking);
      },
      voiceSignal: ({ from, signal }: any) => {
        useVoiceStore.getState().handleSignal(from, signal);
      },
      memberJoined: ({ serverId, user }: any) => {
        useServerStore.getState().addMember(serverId, user);
      },
      memberLeft: ({ serverId, userId }: any) => {
        useServerStore.getState().removeMember(serverId, userId);
      },
      channelCreated: (channel: any) => {
        useServerStore.getState().addChannel(channel);
      },
      channelDeleted: ({ channelId, serverId }: any) => {
        useServerStore.getState().removeChannel(channelId, serverId);
      },
    };

    const eventMap: Array<[string, (...args: any[]) => void]> = [
      ['message:new', handlers.messageNew],
      ['message:update', handlers.messageUpdate],
      ['message:delete', handlers.messageDelete],
      ['typing:start', handlers.typingStart],
      ['typing:stop', handlers.typingStop],
      ['presence:update', handlers.presenceUpdate],
      ['voice:channel_users', handlers.voiceChannelUsers],
      ['voice:user_joined', handlers.voiceUserJoined],
      ['voice:user_left', handlers.voiceUserLeft],
      ['voice:state_update', handlers.voiceStateUpdate],
      ['voice:speaking', handlers.voiceSpeaking],
      ['voice:signal', handlers.voiceSignal],
      ['member:joined', handlers.memberJoined],
      ['member:left', handlers.memberLeft],
      ['channel:created', handlers.channelCreated],
      ['channel:deleted', handlers.channelDeleted],
    ];

    /**
     * Idempotent: removes then re-adds all listeners on the given socket.
     * Tracks socket generation so we know if the socket instance changed.
     */
    function ensureListeners(socket: any) {
      const gen = getSocketGeneration();
      if (attachedGeneration.current === gen) return; // same socket, already attached

      // Remove from whatever socket previously had them (no-op if wrong instance)
      for (const [event, handler] of eventMap) {
        socket.off(event, handler);
      }

      // Attach fresh
      for (const [event, handler] of eventMap) {
        socket.on(event, handler);
      }

      attachedGeneration.current = gen;
      console.log('[MainLayout] Listeners attached (generation', gen + ')');
    }

    function detachListeners(socket: any) {
      for (const [event, handler] of eventMap) {
        socket.off(event, handler);
      }
      attachedGeneration.current = -1;
    }

    /**
     * Called on every connect/reconnect. Ensures listeners are attached
     * and stale data is re-fetched. Deduplicates via socket.id.
     */
    let handledSocketId: string | undefined;

    function handleConnected() {
      const socket = getSocket();
      if (!socket?.connected) return;
      // Deduplicate: only process each connection once
      if (socket.id === handledSocketId) return;
      handledSocketId = socket.id;

      console.log(`[MainLayout] Connection established (id=${socket.id}) — attaching listeners & re-fetching`);
      ensureListeners(socket);

      // Re-fetch servers and members (presence may have changed)
      useServerStore.getState().fetchServers();
      const serverId = useServerStore.getState().activeServerId;
      if (serverId) {
        useServerStore.getState().fetchMembers(serverId);
      }
    }

    // Mechanism 1: Direct listener on the socket object
    const socket = getSocket();
    if (socket) {
      socket.on('connect', handleConnected);

      if (socket.connected) {
        handledSocketId = socket.id;
        ensureListeners(socket);
      }
    }

    // Mechanism 2: Status change listener (fires even if socket was replaced)
    const unsubStatus = onConnectionStatusChange((status) => {
      if (status !== 'connected') return;

      // Ensure direct listener is on the current socket
      const currentSocket = getSocket();
      if (currentSocket && currentSocket !== socket) {
        currentSocket.on('connect', handleConnected);
      }

      handleConnected();
    });

    cleanupRef.current = () => {
      const s = getSocket();
      if (s) {
        s.off('connect', handleConnected);
        detachListeners(s);
      }
      if (socket && socket !== s) socket.off('connect', handleConnected);
      unsubStatus();
    };

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [user?.id]);

  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <div className="flex flex-1 min-h-0">
        <ServerSidebar />
        {activeServerId && <ChannelSidebar />}
        <div className="flex flex-1 flex-col overflow-hidden">
          {activeServerId ? <ChatArea /> : <WelcomeScreen />}
        </div>
        {activeServerId && <MemberSidebar />}
        <VoicePanel />
        {isSettingsOpen && <SettingsModal />}
      </div>
    </div>
  );
}

function WelcomeScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-vox-bg-primary">
      <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-vox-bg-secondary">
          <svg className="h-12 w-12 text-vox-accent-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-vox-text-primary">Welcome to Voxium</h2>
        <p className="max-w-md text-vox-text-secondary">
          Select a server from the sidebar to start chatting, or create a new one to get started.
        </p>
      </div>
    </div>
  );
}
