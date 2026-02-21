import { useEffect, useRef } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { getSocket, onSocketReady } from '../../services/socket';
import { ServerSidebar } from '../server/ServerSidebar';
import { ChannelSidebar } from '../channel/ChannelSidebar';
import { ChatArea } from '../chat/ChatArea';
import { MemberSidebar } from '../server/MemberSidebar';
import { VoicePanel } from '../voice/VoicePanel';
import { SettingsModal } from '../settings/SettingsModal';
import { useSettingsStore } from '../../stores/settingsStore';

export function MainLayout() {
  const { fetchServers, activeServerId } = useServerStore();
  const { user } = useAuthStore();
  const isSettingsOpen = useSettingsStore((s) => s.isSettingsOpen);
  const listenersSetUp = useRef(false);

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

  // Set up WebSocket event listeners
  useEffect(() => {
    function setupListeners() {
      const socket = getSocket();
      if (!socket || listenersSetUp.current) return;
      listenersSetUp.current = true;

      console.log('[WS] Setting up event listeners');

      // ─── Chat events ──────────────────────────────────────────
      socket.on('message:new', (message) => {
        useChatStore.getState().addMessage(message);
      });

      socket.on('message:update', (message) => {
        useChatStore.getState().updateMessage(message);
      });

      socket.on('message:delete', ({ messageId }) => {
        useChatStore.getState().deleteMessage(messageId);
      });

      socket.on('typing:start', ({ userId, username }) => {
        const currentUser = useAuthStore.getState().user;
        if (userId !== currentUser?.id) {
          useChatStore.getState().setTypingUser(userId, username);
        }
      });

      socket.on('typing:stop', ({ userId }) => {
        useChatStore.getState().removeTypingUser(userId);
      });

      // ─── Presence events ─────────────────────────────────────
      socket.on('presence:update', ({ userId, status }) => {
        useServerStore.getState().updateMemberStatus(userId, status);
      });

      // ─── Voice events (server-wide) ───────────────────────────
      socket.on('voice:channel_users', ({ channelId, users: voiceUsers }) => {
        console.log('[WS] voice:channel_users:', channelId, voiceUsers.length);
        useVoiceStore.getState().setChannelUsers(channelId, voiceUsers);
      });

      socket.on('voice:user_joined', ({ channelId, user: voiceUser }) => {
        console.log('[WS] voice:user_joined:', voiceUser.displayName, 'in', channelId);
        useVoiceStore.getState().addUserToChannel(channelId, voiceUser);
      });

      socket.on('voice:user_left', ({ channelId, userId }) => {
        console.log('[WS] voice:user_left:', userId, 'from', channelId);
        useVoiceStore.getState().removeUserFromChannel(channelId, userId);
      });

      socket.on('voice:state_update', ({ channelId, userId, selfMute, selfDeaf }) => {
        useVoiceStore.getState().updateUserState(channelId, userId, selfMute, selfDeaf);
      });

      socket.on('voice:speaking', ({ channelId, userId, speaking }) => {
        useVoiceStore.getState().setUserSpeaking(channelId, userId, speaking);
      });

      socket.on('voice:signal', ({ from, signal }) => {
        console.log('[WS] voice:signal from:', from);
        useVoiceStore.getState().handleSignal(from, signal);
      });
    }

    const socket = getSocket();
    if (socket?.connected) {
      setupListeners();
    } else {
      onSocketReady(setupListeners);
    }

    return () => {
      const socket = getSocket();
      if (socket) {
        socket.off('message:new');
        socket.off('message:update');
        socket.off('message:delete');
        socket.off('typing:start');
        socket.off('typing:stop');
        socket.off('presence:update');
        socket.off('voice:channel_users');
        socket.off('voice:user_joined');
        socket.off('voice:user_left');
        socket.off('voice:state_update');
        socket.off('voice:speaking');
        socket.off('voice:signal');
      }
      listenersSetUp.current = false;
    };
  }, [user?.id]);

  return (
    <div className="flex h-full">
      <ServerSidebar />
      {activeServerId && <ChannelSidebar />}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeServerId ? <ChatArea /> : <WelcomeScreen />}
      </div>
      {activeServerId && <MemberSidebar />}
      <VoicePanel />
      {isSettingsOpen && <SettingsModal />}
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
