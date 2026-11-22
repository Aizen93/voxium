import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { getAccessToken } from './tokenStorage';
import { endSessionRenewals, navigateOnce, refreshAccessToken, sameSession, SessionLostError } from './session';

const SOCKET_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

type VoxSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: VoxSocket | null = null;
const reconnectCallbacks: Array<() => void> = [];
let hasConnectedOnce = false;

const RETRY_DELAY_MIN_MS = 2_000;
const RETRY_DELAY_MAX_MS = 30_000;
let retryDelayMs = RETRY_DELAY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let handshakeRenewing = false;

/**
 * A token a renewal gave for a refused handshake is not renewed for again
 * within this window (refused again, the handshake retries with back-off):
 * a server refusing even a fresh token must not spend the refresh limiter,
 * which every client behind one address shares. Once the window has passed,
 * one more renewal is allowed (the token may have expired meanwhile). The
 * desktop client's handshake path uses the same figure.
 */
export const HANDSHAKE_REFRESH_MIN_INTERVAL_MS = 30_000;
let renewedForHandshake: { token: string; at: number } | null = null;

/**
 * The longest wait before the socket reopens after a server disconnect: a
 * departing node disconnects every client it holds in the same instant, and
 * without a spread they would all renew and handshake at once.
 */
export const SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS = 5_000;
/**
 * A connection that stayed up this long resets the back-off of the reopen
 * after a server disconnect; a server that accepts the handshake and then
 * disconnects at once again and again is reopened ever more slowly (up to
 * the retry ceiling), never at the minimum for ever.
 */
export const STABLE_CONNECTION_MS = 60_000;
let serverDisconnects = 0;
let connectedAt = 0;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
// The server ended this socket's session for good (force:logout): the
// disconnect that follows is never reopened
let forceLoggedOut = false;
// [0, 1): the spread of the reopen wait; replaceable for tests
let random: () => number = Math.random;

const RENEW_MESSAGES = new Set(['Session invalidated', 'Token expired', 'Invalid token']);

/**
 * Handshake refusals that end the session for good, with the reason the
 * sign-in page shows for each: the same sentences the server sends with
 * force:logout when its own re-check after a handshake finds the account
 * banned or gone. 'Account banned' is also the answer to a banned address.
 */
const ENDING_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['Account banned', 'Your account has been banned'],
  ['User not found', 'Your account has been deleted'],
]);

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function clearReopenTimer() {
  if (reopenTimer) {
    clearTimeout(reopenTimer);
    reopenTimer = null;
  }
}

function resetHandshakeState() {
  clearRetryTimer();
  clearReopenTimer();
  retryDelayMs = RETRY_DELAY_MIN_MS;
  handshakeRenewing = false;
  renewedForHandshake = null;
  serverDisconnects = 0;
  connectedAt = 0;
  forceLoggedOut = false;
}

/** The access token the socket's next (or last) handshake carries. */
function handshakeToken(s: VoxSocket): string | null {
  const auth: unknown = s.auth;
  if (typeof auth !== 'object' || auth === null) return null;
  const token = (auth as { token?: unknown }).token;
  return typeof token === 'string' ? token : null;
}

/**
 * Open the socket again with `token`, now. A socket that is not connected
 * emits nothing on `disconnect()`: it only drops the manager's pending timer,
 * so the `connect()` that follows starts a fresh attempt.
 */
function reopen(s: VoxSocket, token: string) {
  s.auth = { token };
  s.disconnect();
  s.connect();
}

function scheduleRetry(s: VoxSocket) {
  if (retryTimer) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (socket !== s || s.connected || forceLoggedOut) return;
    const token = getAccessToken();
    if (token) reopen(s, token);
  }, delay);
}

/**
 * socket.io never reconnects by itself after the server disconnected a
 * socket, and the server does so on purpose when it expects the client back
 * (a deploy, a session ended on another device, its handshake re-check, a
 * password change): reopen after a spread wait, with the token stored THEN,
 * through the same reopen as the handshake path, so a refused token is
 * renewed by the usual rules. The wait grows while the server keeps
 * disconnecting soon after accepting (see STABLE_CONNECTION_MS).
 */
function scheduleServerDisconnectReopen(s: VoxSocket) {
  clearReopenTimer();
  if (connectedAt !== 0 && Date.now() - connectedAt >= STABLE_CONNECTION_MS) serverDisconnects = 0;
  const backoff = serverDisconnects === 0
    ? 0
    : Math.min(RETRY_DELAY_MIN_MS * 2 ** (serverDisconnects - 1), RETRY_DELAY_MAX_MS);
  serverDisconnects++;
  const delay = backoff + Math.floor(random() * SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS);
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    if (socket !== s || s.connected || forceLoggedOut) return;
    const token = getAccessToken();
    if (token) reopen(s, token);
  }, delay);
}

/**
 * The server ended this socket's session for good (force:logout, a handshake
 * refused for a banned or deleted account): this tab signs out without a
 * server call. When the storage holds another session (a sign-in in another
 * tab), that one is not this tab's to clear: the page reloads onto it instead.
 */
function endedByServer(s: VoxSocket, reason: string | undefined) {
  // Before anything asynchronous: the disconnect follows at once, and from
  // here no renewal in flight stores tokens and no request that comes back
  // 401 renews, retries or navigates, so the navigation below (and its
  // reason) is the first one of this page
  forceLoggedOut = true;
  clearRetryTimer();
  clearReopenTimer();
  endSessionRenewals();
  const sessionToken = handshakeToken(s);
  const toLogin = () => {
    navigateOnce(reason ? `/login?reason=${encodeURIComponent(reason)}` : '/login');
  };
  import('../stores/authStore')
    .then(({ useAuthStore }) => {
      if (useAuthStore.getState().endSessionLocally(sessionToken)) toLogin();
      else navigateOnce('/');
    })
    .catch((err: unknown) => {
      // The server ended this session: the sign-in page is where to be even
      // when the local clean-up could not run
      console.error('[Socket] Forced sign-out could not clean up locally:', describe(err));
      toLogin();
    });
}

function handleConnectError(s: VoxSocket, err: Error) {
  const message = err.message;
  const endingReason = ENDING_REFUSALS.get(message);
  if (endingReason !== undefined) {
    if (!forceLoggedOut) endedByServer(s, endingReason);
    return;
  }
  if (message === 'Authentication unavailable') {
    // The server could not check; nothing is wrong with the token
    scheduleRetry(s);
    return;
  }
  if (!RENEW_MESSAGES.has(message) || handshakeRenewing) return;

  const refused = handshakeToken(s);
  const stored = getAccessToken();
  // Renewed meanwhile (a request, another handshake, another tab): use that token
  if (stored && stored !== refused) {
    reopen(s, stored);
    return;
  }
  if (
    refused !== null
    && renewedForHandshake !== null
    && refused === renewedForHandshake.token
    && Date.now() - renewedForHandshake.at < HANDSHAKE_REFRESH_MIN_INTERVAL_MS
  ) {
    scheduleRetry(s);
    return;
  }
  handshakeRenewing = true;
  refreshAccessToken()
    .then((token) => {
      if (socket !== s) return;
      renewedForHandshake = { token, at: Date.now() };
      reopen(s, token);
    })
    .catch((e: unknown) => {
      // A refused renewal already sent the person to the sign-in page; any
      // other failure keeps the session and tries again later
      if (e instanceof SessionLostError) return;
      console.warn('[Socket] Token renewal failed:', describe(e));
      if (socket === s) scheduleRetry(s);
    })
    .finally(() => {
      handshakeRenewing = false;
    });
}

export function connectSocket(token: string): VoxSocket {
  if (socket?.connected) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  hasConnectedOnce = false;
  resetHandshakeState();

  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  const created = socket;
  socket.on('connect_error', (err) => handleConnectError(created, err));

  socket.on('connect', () => {
    retryDelayMs = RETRY_DELAY_MIN_MS;
    renewedForHandshake = null;
    connectedAt = Date.now();
    clearRetryTimer();
    if (!hasConnectedOnce) {
      hasConnectedOnce = true;
    } else {
      reconnectCallbacks.forEach((fn) => fn());
    }
  });

  socket.on('disconnect', (reason) => {
    // A transport loss is the manager's to retry; a disconnect by the server
    // is ours, unless it ended the session first
    if (reason !== 'io server disconnect' || forceLoggedOut || socket !== created) return;
    scheduleServerDisconnectReopen(created);
  });

  socket.on('force:logout', (data) => {
    const reason = data?.reason;
    endedByServer(created, typeof reason === 'string' && reason !== '' ? reason : undefined);
  });

  socket.io.on('reconnect_attempt', () => {
    const freshToken = getAccessToken();
    if (freshToken && socket) {
      socket.auth = { token: freshToken };
    }
  });

  return socket;
}

/**
 * Another tab stored a pair. A socket handshaken under another session (a
 * sign-in in that tab) is reopened with the stored token, so it follows the
 * session the requests now carry; one of the same session (a renewal there)
 * is left alone, its next reconnect reads the stored token anyway.
 */
export function followStoredSession(): void {
  const s = socket;
  if (!s || forceLoggedOut) return;
  const stored = getAccessToken();
  if (!stored) return;
  const current = handshakeToken(s);
  if (current !== null && sameSession(current, stored)) return;
  clearRetryTimer();
  clearReopenTimer();
  reopen(s, stored);
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
  resetHandshakeState();
  reconnectCallbacks.length = 0;
}

/** @internal tests: a deterministic spread of the reopen wait */
export function _setSocketRandomForTests(fn: () => number): void {
  random = fn;
}
