import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';

const SOCKET_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let onConnectCallback: (() => void) | null = null;

export function connectSocket(token: string): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket?.connected) return socket;

  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('[WS] Connected, socket id:', socket!.id);
    if (onConnectCallback) onConnectCallback();
  });

  socket.on('disconnect', (reason) => {
    console.log('[WS] Disconnected:', reason);
    // Reset local voice state so stale data doesn't persist (lazy import to avoid circular deps)
    import('../stores/voiceStore').then(({ useVoiceStore }) => {
      const voiceState = useVoiceStore.getState();
      if (voiceState.activeChannelId) {
        voiceState.leaveChannel();
      }
    });
  });

  socket.on('connect_error', (err) => {
    console.error('[WS] Connection error:', err.message);
  });

  return socket;
}

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> | null {
  return socket;
}

export function onSocketReady(callback: () => void) {
  if (socket?.connected) {
    callback();
  } else {
    onConnectCallback = callback;
  }
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    onConnectCallback = null;
  }
}
