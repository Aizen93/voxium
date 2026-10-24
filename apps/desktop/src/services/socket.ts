import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { getAccessToken, flushTokenStorage } from './tokenStorage';
import { getFreshAccessToken, refreshAccessToken, isAccessTokenFresh, SessionLostError } from './session';

const SOCKET_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

type VoxSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: VoxSocket | null = null;
let connecting = false;
let hasConnectedOnce = false;
let explicitlyDisconnected = true; // true until first connectSocket() call
// A handshake is on the wire — ours (connectSocket, a reopen) or one of the
// manager's own attempts. A reopen now would cut it, and a second one cut
// that: the window and the network coming back fire two resume events in a
// row, and on a slow link that kept the socket from ever connecting.
let handshakeInFlight = false;
const readyCallbacks: Array<() => void> = [];
const reconnectCallbacks: Array<() => void> = [];

/**
 * The handshake answers the server gives for an ACCESS token it will not
 * take but which a refresh can replace. 'Token expired' is what the server
 * says since the resume fix; 'Invalid token' is what an older server says for
 * the same expiry (and for a malformed token, where a refresh costs one
 * request and changes nothing).
 */
const REFRESHABLE_HANDSHAKE_ERRORS = new Set(['Token expired', 'Invalid token']);
/** The server could not verify the handshake (its database was unreachable):
 *  nothing wrong with the token, tried again after a growing wait. */
export const HANDSHAKE_UNAVAILABLE_ERROR = 'Authentication unavailable';
/** At most one refresh from the handshake path per this window: a server
 *  refusing even a fresh token must not spend the refresh limiter. */
export const HANDSHAKE_REFRESH_MIN_INTERVAL_MS = 30_000;
let lastHandshakeRefreshAt = 0;
/** The wait before the handshake is tried again after 'Authentication unavailable': doubles up to the max, reset on connect. */
export const HANDSHAKE_RETRY_MIN_MS = 2_000;
export const HANDSHAKE_RETRY_MAX_MS = 30_000;
let handshakeRetryDelay = HANDSHAKE_RETRY_MIN_MS;
let handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
  if (import.meta.env.DEV) console.log(`[WS] Status: ${prev} → ${status} (${statusListeners.size} listener(s))`);
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
 * Whether the socket.io manager has stopped for good. It does so when the
 * SERVER refuses the handshake (a middleware `next(err)`): the client
 * destroys the namespace socket's subscriptions and, that being the only
 * namespace, closes the manager with reconnection skipped — socket.io's
 * documented behaviour for a middleware error, verified on socket.io-client
 * 4.8.3, where `socket.active` reads false from then on. A transport failure
 * (server down, network gone) is the opposite case: the manager keeps
 * retrying with back-off, without limit (`reconnectionAttempts: Infinity`).
 * Setting `socket.auth` on a closed manager used to be the whole repair:
 * the token sat there, no attempt followed, "connection lost" until a reload.
 */
function managerIsClosed(s: VoxSocket): boolean {
  return !s.active;
}

/** The access token the socket's next (or last) handshake carries. */
function handshakeToken(s: VoxSocket): string | null {
  const auth: unknown = s.auth;
  if (typeof auth !== 'object' || auth === null) return null;
  const token = (auth as { token?: unknown }).token;
  return typeof token === 'string' ? token : null;
}

/**
 * Open the socket again with `token`, right now: after the server refused a
 * handshake (the manager is closed), or instead of the current back-off
 * wait. `disconnect()` on a socket that is not connected emits nothing: it
 * only drops the manager's pending timer and resets its back-off, so the
 * `connect()` that follows opens at once and, if that fails, starts a fresh
 * reconnection cycle.
 */
function reopen(s: VoxSocket, token: string): void {
  s.auth = { token };
  connecting = true;
  handshakeInFlight = true;
  setStatus('connecting');
  s.disconnect();
  s.connect();
}

function clearHandshakeRetry(): void {
  if (handshakeRetryTimer !== null) {
    clearTimeout(handshakeRetryTimer);
    handshakeRetryTimer = null;
  }
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

  // A socket that wasn't explicitly disconnected keeps its event listeners
  // (consumers attached them): never torn down. If its manager is retrying
  // on its own (a transport failure), it only needs the token for its next
  // attempt; a manager the SERVER's refusal closed is reopened.
  if (socket && !explicitlyDisconnected) {
    if (managerIsClosed(socket)) reopen(socket, token);
    else socket.auth = { token };
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
  handshakeInFlight = true;
  socketGeneration++;
  setStatus('connecting');

  const s: VoxSocket = io(SOCKET_URL, {
    auth: { token },
    transports: ['polling', 'websocket'],
    reconnection: true,
    // Never give up on a transport failure: a server down for ten minutes
    // used to exhaust the budget, and a visible window then stayed on
    // "connection lost" until something else reopened the socket. The
    // back-off caps at 10 s, and a hidden page's throttled timers stretch it
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  socket = s;

  // Debug logging — only in development
  if (import.meta.env.DEV) {
    const NOISY_EVENTS = new Set([
      'pong:latency', 'ping:latency',
      'voice:speaking', 'dm:voice:speaking',
      'voice:signal', 'dm:voice:signal',
      'voice:annotation:ops', 'voice:annotation:live',
    ]);

    s.onAny((event: string, ...args: unknown[]) => {
      if (NOISY_EVENTS.has(event)) return;
      console.log(`[WS] ← ${event}`, args.length > 0 ? JSON.stringify(args[0]).slice(0, 120) : '');
    });

    s.onAnyOutgoing((event: string, ...args: unknown[]) => {
      if (NOISY_EVENTS.has(event)) return;
      console.log(`[WS] → ${event}`, args.length > 0 ? JSON.stringify(args[0]).slice(0, 120) : '');
    });
  }

  s.on('connect', () => {
    connecting = false;
    handshakeInFlight = false;
    handshakeRetryDelay = HANDSHAKE_RETRY_MIN_MS;
    clearHandshakeRetry();
    setStatus('connected');
    if (import.meta.env.DEV) console.log('[WS] Connected, socket id:', s.id);

    if (!hasConnectedOnce) {
      // First connect — flush one-shot ready callbacks only
      hasConnectedOnce = true;
      const cbs = readyCallbacks.splice(0);
      cbs.forEach((fn) => fn());
    } else {
      // Actual reconnect — fire reconnect callbacks
      // (ready callbacks were already consumed on first connect)
      if (import.meta.env.DEV) console.log('[WS] Reconnect detected — firing reconnect callbacks');
      reconnectCallbacks.forEach((fn) => fn());
    }
  });

  s.on('force:logout', (data) => {
    if (import.meta.env.DEV) console.log('[WS] Force logout received:', data?.reason);
    const reason = data?.reason;
    const toLogin = () => {
      window.location.href = reason ? `/login?reason=${encodeURIComponent(reason)}` : '/login';
    };
    import('../stores/authStore')
      .then(async ({ useAuthStore }) => {
        useAuthStore.getState().logout();
        // The reload must not outrun the persisted clear of the tokens (the
        // desktop app writes them to the OS credential store over IPC), or
        // the next launch restores the session this logout just ended
        await flushTokenStorage();
        toLogin();
      })
      .catch((err: unknown) => {
        // The server ended this session: the login page is where to be
        // even when the local clean-up failed
        console.error('[WS] Forced logout could not clean up locally:', err instanceof Error ? err.message : err);
        toLogin();
      });
  });

  s.on('disconnect', (reason) => {
    if (import.meta.env.DEV) console.log('[WS] Disconnected:', reason);
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

  s.io.on('reconnect_attempt', (attempt) => {
    handshakeInFlight = true;
    setStatus('connecting');
    if (import.meta.env.DEV) console.log(`[WS] Reconnection attempt ${attempt}`);

    // Refresh auth token on each reconnect attempt
    // so we don't use an expired token
    const freshToken = getAccessToken();
    if (freshToken) {
      s.auth = { token: freshToken };
    }
  });

  s.io.on('reconnect', () => {
    if (import.meta.env.DEV) console.log('[WS] Reconnected successfully');
    // 'connect' event will fire and handle callbacks
  });

  s.on('connect_error', (err) => {
    console.error('[WS] Connection error:', err.message);
    handshakeInFlight = false;
    connecting = false;
    setStatus('disconnected');
    // A transport error: the manager retries on its own. A refusal by the
    // server closed the manager (see managerIsClosed), so what follows is
    // ours: an ACCESS token it will not take is replaced and the socket
    // reopened; a server that could not verify anything is tried again
    // later; every other refusal (banned, unverified, consent, revoked) is
    // final until the user acts.
    if (REFRESHABLE_HANDSHAKE_ERRORS.has(err.message)) {
      void refreshForHandshake(s);
    } else if (err.message === HANDSHAKE_UNAVAILABLE_ERROR) {
      scheduleHandshakeRetry(s);
    }
  });

  return s;
}

/**
 * The server refused the ACCESS token the handshake carried. Reconnect with
 * one it will take: the stored token when something else (a REST request)
 * renewed it since that attempt left, otherwise a renewal — at most one per
 * window; a server refusing even fresh tokens must not spend the refresh
 * limiter. The manager closed on the refusal, so the reconnect is ours.
 */
async function refreshForHandshake(s: VoxSocket): Promise<void> {
  const refused = handshakeToken(s);
  try {
    const stored = getAccessToken();
    let token = stored && stored !== refused && isAccessTokenFresh(stored) ? stored : null;
    if (token === null) {
      const now = Date.now();
      if (now - lastHandshakeRefreshAt < HANDSHAKE_REFRESH_MIN_INTERVAL_MS) return;
      lastHandshakeRefreshAt = now;
      token = await refreshAccessToken();
    }
    if (socket !== s || explicitlyDisconnected || s.connected) return;
    reopen(s, token);
  } catch (err) {
    // A refused refresh has ended the session already (services/session.ts);
    // a transient failure leaves the socket to the next resume or 401 retry
    if (!(err instanceof SessionLostError)) {
      console.warn('[WS] Could not renew the token for the handshake:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * The server could not verify the handshake (its database was unreachable).
 * Try again after a growing wait: the manager closed on the refusal, so
 * nothing else would, and a database blip during a reconnect storm must not
 * strand every client until its window is minimized and restored.
 */
function scheduleHandshakeRetry(s: VoxSocket): void {
  clearHandshakeRetry();
  const delay = handshakeRetryDelay;
  handshakeRetryDelay = Math.min(handshakeRetryDelay * 2, HANDSHAKE_RETRY_MAX_MS);
  console.warn(`[WS] The server could not verify the session; trying again in ${Math.round(delay / 1000)} s`);
  handshakeRetryTimer = setTimeout(() => {
    handshakeRetryTimer = null;
    if (socket !== s || explicitlyDisconnected || s.connected) return;
    void ensureSocketConnected();
  }, delay);
}

/**
 * Make sure the socket is connected or connecting, NOW — called when the
 * window is restored or the network comes back. A socket already connected
 * is left alone. Otherwise the access token is renewed if it has expired (a
 * long minimize outlives it), and the socket reopens at once: a manager the
 * server closed is revived, one sitting in a back-off wait does not wait it
 * out. A handshake already on the wire is left to land (it gets the live
 * token for the attempt after it, should it fail). A missing session (no
 * token) is a no-op; a refused renewal has ended the session already.
 */
export async function ensureSocketConnected(): Promise<void> {
  const s = socket;
  if (!s || explicitlyDisconnected || s.connected) return;
  let token: string | null;
  try {
    token = await getFreshAccessToken();
  } catch (err) {
    if (!(err instanceof SessionLostError)) {
      console.warn('[WS] Could not renew the token on resume:', err instanceof Error ? err.message : err);
    }
    return;
  }
  if (!token) return;
  // The socket may have connected on its own while the token was renewed
  if (socket !== s || s.connected || explicitlyDisconnected) return;
  if (handshakeInFlight) {
    s.auth = { token };
    return;
  }
  reopen(s, token);
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
  handshakeInFlight = false;
  hasConnectedOnce = false;
  explicitlyDisconnected = true;
  clearHandshakeRetry();
  handshakeRetryDelay = HANDSHAKE_RETRY_MIN_MS;
  readyCallbacks.length = 0;
  // Reconnect callbacks are NOT cleared: they are registered once at module
  // import (e.g. voiceStore's re-join handler) and must survive logout→login.
  // Clearing them here meant any network drop in a post-relogin session
  // reconnected the socket but never re-emitted voice:join — UI said
  // "Connected" with dead audio. Scoped consumers unsubscribe via the
  // function returned by onSocketReconnect().
  setStatus('disconnected');
}

/** @internal tests: the handshake refresh rate guard */
export function _resetSocketModuleForTests(): void {
  lastHandshakeRefreshAt = 0;
}
