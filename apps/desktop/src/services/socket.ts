import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { getAccessToken } from './tokenStorage';

const SOCKET_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

type VoxSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: VoxSocket | null = null;
let connecting = false;
let hasConnectedOnce = false;
let explicitlyDisconnected = true; // true until first connectSocket() call
const readyCallbacks: Array<() => void> = [];
const reconnectCallbacks: Array<() => void> = [];

/**
 * Monotonically increasing ID to track socket instance changes.
 * Consumers can compare this to know if the socket was replaced.
 */
let socketGeneration = 0;

/**
 * Observable connection state for UI indicators
 */
type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
type StatusListener = (status: ConnectionStatus) => void;
const statusListeners = new Set<StatusListener>();
let currentStatus: ConnectionStatus = 'disconnected';

function setStatus(status: ConnectionStatus) {
  if (currentStatus === status) return;
  const prev = currentStatus;
  currentStatus = status;
  console.log(`[WS] Status: ${prev} → ${status} (${statusListeners.size} listener(s))`);
  statusListeners.forEach((fn) => fn(status));
}

export function getConnectionStatus(): ConnectionStatus {
  return currentStatus;
}

export function onConnectionStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Connect to the WebSocket server.
 * Safe to call multiple times — deduplicates concurrent calls.
 */
export function connectSocket(token: string): VoxSocket {
  // Already connected with a live socket
  if (socket?.connected) {
    setStatus('connected');
    return socket;
  }

  // Already in the process of connecting — return existing socket instance
  if (socket && connecting) return socket;

  // If Socket.IO is auto-reconnecting (socket exists but wasn't explicitly
  // disconnected), just update the auth token and let it continue.
  // Tearing it down would destroy all event listeners attached by consumers.
  if (socket && !explicitlyDisconnected) {
    socket.auth = { token };
    return socket;
  }

  // Tear down any stale explicitly-disconnected socket before creating a new one
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  explicitlyDisconnected = false;
  connecting = true;
  socketGeneration++;
  setStatus('connecting');

  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  // Debug logging — only in development
  if (import.meta.env.DEV) {
    const NOISY_EVENTS = new Set([
      'pong:latency', 'ping:latency',
      'voice:speaking', 'dm:voice:speaking',
      'voice:signal', 'dm:voice:signal',
    ]);

    socket.onAny((event: string, ...args: any[]) => {
      if (NOISY_EVENTS.has(event)) return;
      console.log(`[WS] ← ${event}`, args.length > 0 ? JSON.stringify(args[0]).slice(0, 120) : '');
    });

    socket.onAnyOutgoing((event: string, ...args: any[]) => {
      if (NOISY_EVENTS.has(event)) return;
      console.log(`[WS] → ${event}`, args.length > 0 ? JSON.stringify(args[0]).slice(0, 120) : '');
    });
  }

  socket.on('connect', () => {
    connecting = false;
    setStatus('connected');
    console.log('[WS] Connected, socket id:', socket!.id);

    if (!hasConnectedOnce) {
      // First connect — flush one-shot ready callbacks only
      hasConnectedOnce = true;
      const cbs = readyCallbacks.splice(0);
      cbs.forEach((fn) => fn());
    } else {
      // Actual reconnect — fire reconnect callbacks
      // (ready callbacks were already consumed on first connect)
      console.log('[WS] Reconnect detected — firing reconnect callbacks');
      reconnectCallbacks.forEach((fn) => fn());
    }
  });

  socket.on('force:logout', (data) => {
    console.log('[WS] Force logout received:', data?.reason);
    import('../stores/authStore').then(({ useAuthStore }) => {
      useAuthStore.getState().logout();
      const reason = data?.reason;
      window.location.href = reason ? `/login?reason=${encodeURIComponent(reason)}` : '/login';
    });
  });

  socket.on('disconnect', (reason) => {
    console.log('[WS] Disconnected:', reason);
    setStatus('disconnected');

    // Only fully leave voice when the server explicitly kicks us.
    // For transient disconnects (transport close, ping timeout), keep voice
    // state intact so the onSocketReconnect handler can re-join seamlessly.
    if (reason === 'io server disconnect') {
      import('../stores/voiceStore').then(({ useVoiceStore }) => {
        const voiceState = useVoiceStore.getState();
        if (voiceState.activeChannelId) {
          voiceState.leaveChannel();
        }
        if (voiceState.dmCallConversationId) {
          voiceState.leaveDMCall();
        }
      });
    }
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    setStatus('connecting');
    console.log(`[WS] Reconnection attempt ${attempt}`);

    // Refresh auth token on each reconnect attempt
    // so we don't use an expired token
    const freshToken = getAccessToken();
    if (freshToken && socket) {
      socket.auth = { token: freshToken };
    }
  });

  socket.io.on('reconnect', () => {
    console.log('[WS] Reconnected successfully');
    // 'connect' event will fire and handle callbacks
  });

  socket.io.on('reconnect_failed', () => {
    console.error('[WS] Reconnection failed after all attempts');
    setStatus('disconnected');
  });

  socket.on('connect_error', (err) => {
    console.error('[WS] Connection error:', err.message);
    connecting = false;
    setStatus('disconnected');
  });

  return socket;
}

export function getSocket(): VoxSocket | null {
  return socket;
}

/**
 * Returns a generation counter that increments every time a new socket
 * instance is created. Use this to detect if the socket was replaced.
 */
export function getSocketGeneration(): number {
  return socketGeneration;
}

/**
 * Register a callback to run when the socket first becomes ready.
 * If already connected, fires immediately. One-shot — removed after firing.
 */
export function onSocketReady(callback: () => void) {
  if (socket?.connected) {
    callback();
  } else {
    readyCallbacks.push(callback);
  }
}

/**
 * Register a callback to run on every (re)connect.
 * Use this for re-joining rooms, re-fetching stale data, etc.
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
  connecting = false;
  hasConnectedOnce = false;
  explicitlyDisconnected = true;
  readyCallbacks.length = 0;
  reconnectCallbacks.length = 0;
  setStatus('disconnected');
}
