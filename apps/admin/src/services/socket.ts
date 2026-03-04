import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { getAccessToken } from './tokenStorage';

const SOCKET_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

type VoxSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: VoxSocket | null = null;
const reconnectCallbacks: Array<() => void> = [];
let hasConnectedOnce = false;

export function connectSocket(token: string): VoxSocket {
  if (socket?.connected) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  hasConnectedOnce = false;

  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  socket.on('connect', () => {
    if (!hasConnectedOnce) {
      hasConnectedOnce = true;
    } else {
      reconnectCallbacks.forEach((fn) => fn());
    }
  });

  socket.on('force:logout', (data) => {
    import('../stores/authStore').then(({ useAuthStore }) => {
      useAuthStore.getState().logout();
      const reason = data?.reason;
      window.location.href = reason ? `/login?reason=${encodeURIComponent(reason)}` : '/login';
    });
  });

  socket.io.on('reconnect_attempt', () => {
    const freshToken = getAccessToken();
    if (freshToken && socket) {
      socket.auth = { token: freshToken };
    }
  });

  return socket;
}

export function getSocket(): VoxSocket | null {
  return socket;
}

/**
 * Register a callback to run on every reconnect.
 * Returns an unsubscribe function.
 */
export function onSocketReconnect(callback: () => void): () => void {
  reconnectCallbacks.push(callback);
  return () => {
    const idx = reconnectCallbacks.indexOf(callback);
    if (idx !== -1) reconnectCallbacks.splice(idx, 1);
  };
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  hasConnectedOnce = false;
  reconnectCallbacks.length = 0;
}
