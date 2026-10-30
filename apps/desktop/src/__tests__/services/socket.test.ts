import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Fake socket.io-client ───────────────────────────────────────────────────
// Each io() call returns a fresh fake socket. Handlers registered via .on()
// are captured so tests can simulate 'connect' events manually.

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  connected: boolean;
  /** socket.io's "the manager will try again": false after a middleware refusal or a disconnect(), true again after connect(). */
  active: boolean;
  auth: Record<string, unknown>;
  id: string;
  onAny: ReturnType<typeof vi.fn>;
  onAnyOutgoing: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> };
  handlers: Map<string, (...args: unknown[]) => void>;
  ioHandlers: Map<string, (...args: unknown[]) => void>;
  fire: (event: string, ...args: unknown[]) => void;
  /** Fire a MANAGER event (socket.io.on): reconnect_attempt, reconnect_failed… */
  fireIo: (event: string, ...args: unknown[]) => void;
}

const createdSockets: FakeSocket[] = [];

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const ioHandlers = new Map<string, (...args: unknown[]) => void>();
  const socket: FakeSocket = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
      return socket;
    }),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(() => { socket.active = false; }),
    connect: vi.fn(() => { socket.active = true; }),
    connected: false,
    active: true,
    auth: {},
    id: 'fake',
    onAny: vi.fn(),
    onAnyOutgoing: vi.fn(),
    io: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => { ioHandlers.set(event, cb); }),
      removeAllListeners: vi.fn(),
    },
    handlers,
    ioHandlers,
    fire: (event: string, ...args: unknown[]) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`No handler registered for '${event}'`);
      handler(...args);
    },
    fireIo: (event: string, ...args: unknown[]) => {
      const handler = ioHandlers.get(event);
      if (!handler) throw new Error(`No manager handler registered for '${event}'`);
      handler(...args);
    },
  };
  return socket;
}

vi.mock('socket.io-client', () => ({
  io: vi.fn((_url: string, opts?: { auth?: Record<string, unknown> }) => {
    const s = makeFakeSocket();
    // The real socket keeps the auth it was created with until something sets it
    if (opts?.auth) s.auth = opts.auth;
    createdSockets.push(s);
    return s;
  }),
}));

// The session module (token renewal) is what the handshake and the resume
// paths lean on; a class so `instanceof SessionLostError` works across the
// module resets below
const session = vi.hoisted(() => {
  class SessionLostError extends Error {}
  return {
    SessionLostError,
    refreshAccessToken: vi.fn(),
    getFreshAccessToken: vi.fn(),
    isAccessTokenFresh: vi.fn(() => true),
  };
});
vi.mock('../../services/session', () => session);
const storage = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => 'stored-token' as string | null),
  flushTokenStorage: vi.fn(async () => {}),
}));
vi.mock('../../services/tokenStorage', () => storage);
// A server disconnect leaves any voice call (the 'disconnect' handler)
const voice = vi.hoisted(() => ({ activeChannelId: null as string | null, dmCallConversationId: null as string | null, leaveChannel: vi.fn(), leaveDMCall: vi.fn() }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => voice } }));
// force:logout signs out through the auth store
const authStoreMock = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => authStoreMock } }));

type SocketModule = typeof import('../../services/socket');

let lastModule: SocketModule | null = null;

/** The socket module, fresh after vi.resetModules(), with no random spread
 *  (every wait at its base) unless a test sets one. */
async function freshSocketModule(): Promise<SocketModule> {
  const mod = await import('../../services/socket');
  mod._setSocketRandomForTests(() => 0);
  lastModule = mod;
  return mod;
}

// A retry a test left scheduled must not fire into the next test's mocks
afterEach(() => {
  lastModule?.disconnectSocket();
  lastModule = null;
});

describe('services/socket', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
  });

  describe('onSocketReconnect survives logout → login (HIGH-13)', () => {
    it('fires reconnect callbacks registered before logout when the post-relogin socket reconnects', async () => {
      const mod = await freshSocketModule();

      // Session 1: connect and complete the first connect
      mod.connectSocket('token-1');
      expect(createdSockets).toHaveLength(1);
      const socket1 = createdSockets[0];
      socket1.fire('connect');

      // A module-level consumer (e.g. voiceStore re-join handler) registers
      const reconnectCb = vi.fn();
      mod.onSocketReconnect(reconnectCb);

      // Logout
      mod.disconnectSocket();
      expect(socket1.disconnect).toHaveBeenCalled();
      expect(socket1.removeAllListeners).toHaveBeenCalled();

      // Login again — a brand-new socket instance is created
      mod.connectSocket('token-2');
      expect(createdSockets).toHaveLength(2);
      const socket2 = createdSockets[1];

      // First connect of the NEW session — must NOT be treated as a reconnect
      socket2.fire('connect');
      expect(reconnectCb).not.toHaveBeenCalled();

      // A real network-drop reconnect in the new session — callback MUST fire
      socket2.fire('connect');
      expect(reconnectCb).toHaveBeenCalledTimes(1);
    });

    it('does not fire reconnect callbacks on the very first connect of a session', async () => {
      const mod = await freshSocketModule();

      const reconnectCb = vi.fn();
      mod.onSocketReconnect(reconnectCb);

      mod.connectSocket('token-1');
      createdSockets[0].fire('connect');

      expect(reconnectCb).not.toHaveBeenCalled();
    });
  });

  describe('onSocketReconnect unsubscribe', () => {
    it('stops the callback from firing on later reconnects', async () => {
      const mod = await freshSocketModule();

      mod.connectSocket('token-1');
      const socket = createdSockets[0];
      socket.fire('connect'); // first connect

      const reconnectCb = vi.fn();
      const unsubscribe = mod.onSocketReconnect(reconnectCb);

      socket.fire('connect'); // reconnect → fires
      expect(reconnectCb).toHaveBeenCalledTimes(1);

      unsubscribe();

      socket.fire('connect'); // another reconnect → must not fire again
      expect(reconnectCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('one-shot readyCallbacks', () => {
    it('queues a callback registered before connection and flushes it exactly once', async () => {
      const mod = await freshSocketModule();

      const readyCb = vi.fn();
      mod.onSocketReady(readyCb);
      expect(readyCb).not.toHaveBeenCalled();

      mod.connectSocket('token-1');
      const socket = createdSockets[0];
      expect(readyCb).not.toHaveBeenCalled();

      socket.fire('connect');
      expect(readyCb).toHaveBeenCalledTimes(1);

      // Reconnect must not re-fire a consumed one-shot callback
      socket.fire('connect');
      expect(readyCb).toHaveBeenCalledTimes(1);
    });

    it('fires immediately when the socket is already connected', async () => {
      const mod = await freshSocketModule();

      mod.connectSocket('token-1');
      const socket = createdSockets[0];
      socket.fire('connect');
      socket.connected = true;

      const readyCb = vi.fn();
      mod.onSocketReady(readyCb);
      expect(readyCb).toHaveBeenCalledTimes(1);
    });

    it('disconnectSocket clears queued ready callbacks', async () => {
      const mod = await freshSocketModule();

      // Queue a callback while disconnected
      const readyCb = vi.fn();
      mod.onSocketReady(readyCb);

      // Logout wipes the pending queue
      mod.disconnectSocket();

      // Next session connects — the stale callback must not fire
      mod.connectSocket('token-2');
      createdSockets[0].fire('connect');

      expect(readyCb).not.toHaveBeenCalled();
    });
  });
});

// ─── Recovery after a minimize: expired token, a manager that gave up ────────
// The access token lives 15 minutes. A window restored after longer used to
// have the socket retry its expired token until some REST call happened to
// refresh it — and once the manager had spent its attempts, nothing ever
// reconnected it: "connection lost" until a page reload.

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

/**
 * What a middleware refusal does on the real client (socket.io-client 4.8.3):
 * the namespace socket's subscriptions are destroyed and the manager closes
 * with reconnection skipped — `socket.active` is false and NO attempt
 * follows. A transport failure leaves `active` true and the manager retrying.
 */
function refuseHandshake(socket: FakeSocket, message: string): void {
  socket.active = false;
  socket.fire('connect_error', new Error(message));
}

describe('services/socket — handshake refused for an expired token', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
    session.isAccessTokenFresh.mockReset().mockReturnValue(true);
    storage.getAccessToken.mockReset().mockReturnValue('token-expired');
  });

  it('renews the token and REOPENS the socket with it: the refusal closed the manager, nothing else would reconnect', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockResolvedValueOnce('token-new');

    refuseHandshake(socket, 'Token expired');
    await tick();

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'token-new' });
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect.mock.invocationCallOrder[0]).toBeLessThan(socket.connect.mock.invocationCallOrder[0]);
    expect(mod.getConnectionStatus()).toBe('connecting');
    expect(createdSockets).toHaveLength(1); // the same socket, its listeners intact
  });

  it("'Invalid token' (an older server's word for the same expiry) renews and reopens too", async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockResolvedValueOnce('token-new');

    refuseHandshake(socket, 'Invalid token');
    await tick();

    expect(socket.auth).toEqual({ token: 'token-new' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects with the token another path stored meanwhile — no renewal of its own — when it differs from the refused one and is fresh', async () => {
    // A REST request renewed the token while this handshake was out; the
    // socket just uses it (otherwise two renewals per resume)
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    storage.getAccessToken.mockReturnValue('token-renewed-by-rest');

    refuseHandshake(socket, 'Token expired');
    await tick();

    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.auth).toEqual({ token: 'token-renewed-by-rest' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('a stored token that is the REFUSED one, or a different one that reads expired, is renewed instead', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    storage.getAccessToken.mockReturnValue('token-other-but-stale');
    session.isAccessTokenFresh.mockReturnValue(false);
    session.refreshAccessToken.mockResolvedValueOnce('token-new');

    refuseHandshake(socket, 'Token expired');
    await tick();

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'token-new' });
  });

  it("'Session invalidated' (a token of an older version) renews: the stored token of the current version is used when another path stored one", async () => {
    // Another tab or the caller's own password change stored the new pair
    const mod = await freshSocketModule();
    mod.connectSocket('token-old-version');
    const socket = createdSockets[0];
    storage.getAccessToken.mockReturnValue('token-current-version');

    refuseHandshake(socket, 'Session invalidated');
    await tick();

    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.auth).toEqual({ token: 'token-current-version' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it("'Session invalidated' with nothing newer stored: ONE refresh, and a refused one reopens nothing (the session module signs out)", async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-old-version');
    const socket = createdSockets[0];
    storage.getAccessToken.mockReturnValue('token-old-version');
    session.refreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    refuseHandshake(socket, 'Session invalidated');
    await tick();

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('every other refusal (banned, unverified, consent) renews nothing and reopens nothing', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];

    for (const message of ['Account banned', 'Email not verified', 'Consent required', 'User not found']) {
      refuseHandshake(socket, message);
    }
    await tick();

    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(mod.getConnectionStatus()).toBe('disconnected');
  });

  it('a TRANSPORT error (server down) is left to the manager: it keeps retrying on its own', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];

    socket.fire('connect_error', new Error('xhr poll error')); // active stays true
    await tick();

    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('renews at most once per window: a server refusing even fresh tokens must not spend the refresh limiter', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired'); // the stored token: nothing newer to fall back on
    const socket = createdSockets[0];
    session.refreshAccessToken.mockResolvedValue('token-new');

    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    // The renewed token is now the stored AND the refused one: refused again, it must be renewed again — but not within the window
    storage.getAccessToken.mockReturnValue('token-new');
    refuseHandshake(socket, 'Token expired');
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);

    mod._resetSocketModuleForTests();
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('a renewal refused for good is left to the session module (it has ended the session): nothing reopens, nothing is scheduled', async () => {
    vi.useFakeTimers();
    try {
      const mod = await freshSocketModule();
      mod.connectSocket('token-expired');
      const socket = createdSockets[0];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      session.refreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('lost'));
      refuseHandshake(socket, 'Token expired');
      await tick();
      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MAX_MS * 2);
      expect(warn).not.toHaveBeenCalled();
      expect(socket.auth).toEqual({ token: 'token-expired' });
      expect(socket.connect).not.toHaveBeenCalled();
      expect(session.getFreshAccessToken).not.toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a TRANSIENT renewal failure (the server restarting) is logged and the handshake is tried again after a wait — never a closed manager left closed', async () => {
    vi.useFakeTimers();
    try {
      const mod = await freshSocketModule();
      mod.connectSocket('token-expired');
      const socket = createdSockets[0];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));
      session.getFreshAccessToken.mockResolvedValueOnce('token-new');

      refuseHandshake(socket, 'Token expired');
      await tick();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('renew'), 'Network Error');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('The token could not be renewed; trying again in 2 s'));
      expect(socket.connect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
      await tick();
      expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
      expect(socket.auth).toEqual({ token: 'token-new' });
      expect(socket.connect).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an EXPIRED token refused again within the refresh window is retried after a growing wait (renewed by the resume path); a FRESH one refused again is not', async () => {
    vi.useFakeTimers();
    try {
      const mod = await freshSocketModule();
      mod.connectSocket('token-expired');
      const socket = createdSockets[0];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      session.refreshAccessToken.mockRejectedValue(new Error('Network Error'));
      session.getFreshAccessToken.mockRejectedValue(new Error('Network Error'));
      session.isAccessTokenFresh.mockReturnValue(false);

      // Renewal fails: retry in 2 s, through the resume path, whose renewal
      // fails too: it opens with the stored (expired) token
      refuseHandshake(socket, 'Token expired');
      await tick();
      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
      await tick();
      expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
      expect(socket.connect).toHaveBeenCalledTimes(1);
      expect(socket.auth).toEqual({ token: 'token-expired' });

      // Refused again inside the window: no second handshake renewal, but a retry in 4 s
      refuseHandshake(socket, 'Token expired');
      await tick();
      expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
      await tick();
      expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
      await tick();
      expect(session.getFreshAccessToken).toHaveBeenCalledTimes(2);
      expect(socket.connect).toHaveBeenCalledTimes(2);

      // A token refused while it still reads fresh, inside the window: nothing scheduled
      session.isAccessTokenFresh.mockReturnValue(true);
      refuseHandshake(socket, 'Token expired');
      await tick();
      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MAX_MS * 2);
      await tick();
      expect(session.getFreshAccessToken).toHaveBeenCalledTimes(2);
      expect(socket.connect).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen a socket that was logged out, replaced or connected while the renewal was out', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    let finish!: (t: string) => void;
    session.refreshAccessToken.mockReturnValueOnce(new Promise<string>((r) => { finish = r; }));

    refuseHandshake(socket, 'Token expired');
    mod.disconnectSocket();
    finish('token-new');
    await tick();

    expect(socket.connect).not.toHaveBeenCalled();
  });
});

describe('services/socket — a manager the server closed, and connectSocket(token)', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
    session.isAccessTokenFresh.mockReset().mockReturnValue(true);
    storage.getAccessToken.mockReset().mockReturnValue('stored-token');
  });

  it('after a refusal, connectSocket(token) REOPENS the socket instead of only storing the token (the 401 retry on resume)', async () => {
    const mod = await freshSocketModule();
    storage.getAccessToken.mockReturnValue('token-1');
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error')); // the handshake path's own renewal failed
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(mod.getConnectionStatus()).toBe('disconnected');
    expect(socket.connect).not.toHaveBeenCalled();

    // The REST client renewed the token (a 401 retry) and re-handshakes
    mod.connectSocket('token-new');

    expect(socket.auth).toEqual({ token: 'token-new' });
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(mod.getConnectionStatus()).toBe('connecting');
    expect(createdSockets).toHaveLength(1);
    warn.mockRestore();
  });

  it('while the manager is retrying on its own (a transport drop), connectSocket(token) only stores the token: never a reopen that would cut a running attempt', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'transport close');

    mod.connectSocket('token-new');

    expect(socket.auth).toEqual({ token: 'token-new' });
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('never gives up on a transport failure: the manager is created with unlimited attempts', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');

    const { io } = await import('socket.io-client');
    const opts = vi.mocked(io).mock.calls[0][1] as { reconnectionAttempts?: number; reconnection?: boolean };
    expect(opts.reconnection).toBe(true);
    expect(opts.reconnectionAttempts).toBe(Infinity);
  });
});

describe("services/socket — 'Authentication unavailable' (the server could not verify the handshake)", () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    vi.useFakeTimers();
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset().mockResolvedValue('token-live');
    session.isAccessTokenFresh.mockReset().mockReturnValue(true);
    storage.getAccessToken.mockReset().mockReturnValue('stored-token');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the pending promise chain of a timer callback settle under fake timers. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('tries the handshake again after a wait that doubles up to the cap, with a live token — no renewal, no sign-out', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(session.refreshAccessToken).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
    await flush();
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'token-live' });

    // Still unavailable: twice the wait this time
    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
    await flush();
    expect(socket.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS);
    await flush();
    expect(socket.connect).toHaveBeenCalledTimes(2);

    // ... and never longer than the cap
    for (let i = 0; i < 6; i++) {
      refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
      await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MAX_MS);
      await flush();
    }
    expect(socket.connect).toHaveBeenCalledTimes(8);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trying again in 30 s'));
    warn.mockRestore();
  });

  it('a connect resets the wait; a logout cancels the pending retry', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR); // the wait is 4 s now
    socket.fire('connect'); // ... and back to 2 s, the pending retry dropped
    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MAX_MS);
    await flush();
    expect(socket.connect).not.toHaveBeenCalled();

    socket.connected = false;
    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('trying again in 2 s'));
    mod.disconnectSocket();
    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MAX_MS);
    await flush();
    expect(socket.connect).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the wait is spread down to half of it, so the clients of one outage do not come back in step', async () => {
    const mod = await freshSocketModule();
    mod._setSocketRandomForTests(() => 0.5); // three quarters of the base wait
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MIN_MS * 0.75 - 1);
    await flush();
    expect(socket.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(socket.connect).toHaveBeenCalledTimes(1);

    // The base still doubles: 4 s spread to 3 s
    refuseHandshake(socket, mod.HANDSHAKE_UNAVAILABLE_ERROR);
    await vi.advanceTimersByTimeAsync(2_999);
    await flush();
    expect(socket.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(socket.connect).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('services/socket — ensureSocketConnected (the window comes back)', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
    session.isAccessTokenFresh.mockReset().mockReturnValue(true);
    storage.getAccessToken.mockReset().mockReturnValue('stored-token');
  });

  it('is a no-op while connected', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.connected = true;

    await mod.ensureSocketConnected();

    expect(session.getFreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('reopens a dropped socket at once with a LIVE token (renewed if the stored one expired while the window was away)', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');
    session.getFreshAccessToken.mockResolvedValueOnce('token-live');

    await mod.ensureSocketConnected();

    expect(socket.auth).toEqual({ token: 'token-live' });
    // Not left to the back-off timer the browser throttled: disconnect() drops
    // the wait, connect() opens now
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(mod.getConnectionStatus()).toBe('connecting');
  });

  it('revives a manager the server closed (an expired token refused while the window was away)', async () => {
    const mod = await freshSocketModule();
    storage.getAccessToken.mockReturnValue('token-1');
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error')); // the handshake path could not renew then
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(socket.connect).not.toHaveBeenCalled();
    session.getFreshAccessToken.mockResolvedValueOnce('token-live');

    await mod.ensureSocketConnected();

    expect(socket.auth).toEqual({ token: 'token-live' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('leaves a handshake already on the wire alone — the window and the network come back as TWO events — and hands it the live token for the attempt after', async () => {
    // Reopening every time kept a slow link from ever connecting: each reopen
    // cut the handshake the previous one had started
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');
    session.getFreshAccessToken.mockResolvedValue('token-live');

    await mod.ensureSocketConnected(); // visibilitychange: reopened
    await mod.ensureSocketConnected(); // online, a moment later: the reopen's handshake is out
    await mod.ensureSocketConnected();

    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'token-live' });

    // The manager's own attempt counts the same
    socket.fire('connect_error', new Error('xhr poll error')); // the reopen failed: the manager takes over
    socket.fireIo('reconnect_attempt', 1);
    await mod.ensureSocketConnected();
    expect(socket.connect).toHaveBeenCalledTimes(1);

    // ... and once that attempt failed, the next resume reopens again
    socket.fire('connect_error', new Error('xhr poll error'));
    await mod.ensureSocketConnected();
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a session (no token), when the renewal was refused for good, or after a logout', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');

    session.getFreshAccessToken.mockResolvedValueOnce(null);
    await mod.ensureSocketConnected();
    expect(socket.connect).not.toHaveBeenCalled();

    session.getFreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('lost'));
    await mod.ensureSocketConnected();
    expect(socket.connect).not.toHaveBeenCalled();

    mod.disconnectSocket();
    session.getFreshAccessToken.mockResolvedValueOnce('token-live');
    await mod.ensureSocketConnected();
    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(2); // not asked after the logout
  });

  it('a transient renewal failure is logged and the socket opens with the STORED token: a closed manager would otherwise never retry', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    session.getFreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));

    await mod.ensureSocketConnected();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume'), 'Network Error');
    expect(socket.auth).toEqual({ token: 'stored-token' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(mod.getConnectionStatus()).toBe('connecting');
    warn.mockRestore();
  });

  it('a transient renewal failure with no stored token (signed out meanwhile) opens nothing', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    session.getFreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));
    storage.getAccessToken.mockReturnValue(null);

    await mod.ensureSocketConnected();

    expect(socket.connect).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not reopen a socket that connected on its own while the token was being renewed', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');
    session.getFreshAccessToken.mockImplementationOnce(async () => {
      socket.connected = true;
      socket.fire('connect');
      return 'token-live';
    });

    await mod.ensureSocketConnected();

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });
});

describe('services/socket — reconnectSocketAfterCredentialChange (the server revoked every session after a password change)', () => {
  // What a server-side disconnect(true) does on the real client: the socket
  // and the manager close for good ('io server disconnect'), nothing retries
  function serverDisconnect(socket: FakeSocket): void {
    socket.connected = false;
    socket.active = false;
    socket.fire('disconnect', 'io server disconnect');
  }
  const macrotask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    createdSockets.length = 0;
    storage.getAccessToken.mockReset().mockReturnValue('access-new');
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
    session.isAccessTokenFresh.mockReset().mockReturnValue(true);
    voice.activeChannelId = null;
    voice.dmCallConversationId = null;
  });

  it('the disconnect landed FIRST (manager closed): nothing reopens with the old token; the answer reopens with the new one', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    // What the resume path would send: the old token has not expired
    storage.getAccessToken.mockReturnValue('access-old');
    session.getFreshAccessToken.mockResolvedValue('access-old');
    const end = mod.beginCredentialChange();
    serverDisconnect(socket);
    await macrotask();
    await tick();
    expect(session.getFreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();

    storage.getAccessToken.mockReturnValue('access-new');
    session.getFreshAccessToken.mockResolvedValue('access-new');
    mod.reconnectSocketAfterCredentialChange('access-new');
    end();
    await tick();

    expect(socket.auth).toEqual({ token: 'access-new' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(session.getFreshAccessToken).not.toHaveBeenCalled(); // the answer's reopen replaced the held one
    expect(mod.getConnectionStatus()).toBe('connecting');
    expect(createdSockets).toHaveLength(1);
  });

  it('a held disconnect with no reopen from the answer (lost, or no token pair) is reopened through the resume path when the change ends', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    session.getFreshAccessToken.mockResolvedValue('access-old');
    const end = mod.beginCredentialChange();
    serverDisconnect(socket);
    await macrotask();
    expect(socket.connect).not.toHaveBeenCalled();

    end();
    end(); // idempotent
    await tick();

    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('a change that ends without a server disconnect (a wrong current password) holds nothing: a later server disconnect reopens as usual', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    session.getFreshAccessToken.mockResolvedValue('access-old');

    mod.beginCredentialChange()();
    await tick();
    expect(session.getFreshAccessToken).not.toHaveBeenCalled();

    serverDisconnect(socket);
    await macrotask();
    await tick();
    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('the answer landed FIRST (still connected): reopens now — connectSocket alone would be a no-op on a connected socket', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');

    mod.connectSocket('access-new');
    expect(socket.connect).not.toHaveBeenCalled();

    mod.reconnectSocketAfterCredentialChange('access-new');

    expect(socket.auth).toEqual({ token: 'access-new' });
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(mod.getConnectionStatus()).toBe('connecting');
  });

  it('a server disconnect landing AFTER the reopen (another node\'s copy) is repaired once, with the stored token', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    mod.reconnectSocketAfterCredentialChange('access-new');
    socket.connected = true;
    socket.fire('connect');
    expect(socket.connect).toHaveBeenCalledTimes(1);

    serverDisconnect(socket);
    await macrotask();

    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(socket.auth).toEqual({ token: 'access-new' });
    expect(session.getFreshAccessToken).not.toHaveBeenCalled();

    // The window's direct repair runs once: a later server disconnect goes
    // through the resume path
    session.getFreshAccessToken.mockResolvedValueOnce('access-new');
    socket.connected = true;
    socket.fire('connect');
    serverDisconnect(socket);
    await macrotask();
    await tick();
    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(3);
  });

  it('a server disconnect after the window is not repaired by the window: it goes through the resume path', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    mod.reconnectSocketAfterCredentialChange('access-new');
    socket.connected = true;
    socket.fire('connect');

    clock.mockReturnValue(now + mod.REVOCATION_REOPEN_WINDOW_MS + 1);
    session.getFreshAccessToken.mockResolvedValueOnce(null); // e.g. signed out meanwhile
    serverDisconnect(socket);
    await macrotask();
    await tick();
    clock.mockRestore();

    // Not the window's reopen with the stored token: the resume path was asked
    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('a server disconnect without force:logout (a demotion) reopens through the resume path with the stored token', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    voice.activeChannelId = 'vc-1';
    session.getFreshAccessToken.mockResolvedValueOnce('access-old');

    serverDisconnect(socket);
    // Never from inside the manager's own close
    expect(session.getFreshAccessToken).not.toHaveBeenCalled();
    await macrotask();
    await tick();

    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.auth).toEqual({ token: 'access-old' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(mod.getConnectionStatus()).toBe('connecting');
    expect(createdSockets).toHaveLength(1);
    // The call the server tore down is still left
    expect(voice.leaveChannel).toHaveBeenCalled();
  });

  it('a revoked session (password changed on another device): the reopen is refused, ONE refresh is refused, nothing reopens again', async () => {
    const mod = await freshSocketModule();
    storage.getAccessToken.mockReturnValue('access-old');
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    // The old-version token has not expired: the resume path sends it as is
    session.getFreshAccessToken.mockResolvedValue('access-old');
    session.refreshAccessToken.mockRejectedValue(new session.SessionLostError('refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    serverDisconnect(socket);
    await macrotask();
    await tick();
    expect(socket.connect).toHaveBeenCalledTimes(1);

    refuseHandshake(socket, 'Session invalidated');
    await tick();
    await macrotask();

    // services/session.ts ends the session on that refusal (handleSessionLost)
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('no reconnect after force:logout (a ban, an account deletion)', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    session.getFreshAccessToken.mockResolvedValue('access-old');
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true, configurable: true });

    try {
      socket.fire('force:logout', { reason: 'banned' });
      serverDisconnect(socket);
      await macrotask();
      await tick();
      await macrotask();

      expect(authStoreMock.logout).toHaveBeenCalledTimes(1);
      expect(session.getFreshAccessToken).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();
      expect(window.location.href).toBe('/login?reason=banned');
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
    }
  });

  it('a session the server ends right after admitting it (banned or deleted during the handshake) signs out with the reason and never reopens', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    session.getFreshAccessToken.mockResolvedValue('access-old');
    authStoreMock.logout.mockClear();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true, configurable: true });

    try {
      // The connection handler's re-check: force:logout, then disconnect(true)
      socket.connected = true;
      socket.fire('connect');
      socket.fire('force:logout', { reason: 'Your account has been deleted' });
      serverDisconnect(socket);
      await macrotask();
      await tick();
      await macrotask();

      expect(authStoreMock.logout).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe('/login?reason=Your%20account%20has%20been%20deleted');
      expect(session.getFreshAccessToken).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
    }
  });

  it('the resume reopen is skipped when the user logged out before it ran', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    session.getFreshAccessToken.mockResolvedValue('access-old');

    serverDisconnect(socket);
    mod.disconnectSocket();
    socket.connect.mockClear();
    await macrotask();
    await tick();

    expect(session.getFreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('the repair is skipped when the session ended meanwhile (no token, or logged out)', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    mod.reconnectSocketAfterCredentialChange('access-new');
    storage.getAccessToken.mockReturnValue(null);

    serverDisconnect(socket);
    await macrotask();

    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('still leaves the voice call the server tore down', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    voice.activeChannelId = 'vc-1';
    mod.reconnectSocketAfterCredentialChange('access-new');

    serverDisconnect(socket);
    await macrotask();

    expect(voice.leaveChannel).toHaveBeenCalled();
  });

  it('is a no-op without a socket and after a logout', async () => {
    const mod = await freshSocketModule();
    mod.reconnectSocketAfterCredentialChange('access-new');
    expect(createdSockets).toHaveLength(0);

    mod.connectSocket('access-old');
    const socket = createdSockets[0];
    mod.disconnectSocket();
    socket.connect.mockClear();
    mod.reconnectSocketAfterCredentialChange('access-new');
    expect(socket.connect).not.toHaveBeenCalled();
    expect(createdSockets).toHaveLength(1);
  });
});

describe('services/socket — a node going away (deploy, shutdown): spread reopen, expired tokens, a server still down', () => {
  function serverDisconnect(socket: FakeSocket): void {
    socket.connected = false;
    socket.active = false;
    socket.fire('disconnect', 'io server disconnect');
  }

  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    vi.useFakeTimers();
    storage.getAccessToken.mockReset().mockReturnValue('access-expired');
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
    session.isAccessTokenFresh.mockReset().mockReturnValue(false);
    voice.activeChannelId = null;
    voice.dmCallConversationId = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function connected(mod: SocketModule): Promise<FakeSocket> {
    mod.connectSocket('access-expired');
    const socket = createdSockets[0];
    socket.connected = true;
    socket.fire('connect');
    return socket;
  }

  it('the generic reopen waits a random share of SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS, not 0 for everyone at once', async () => {
    const mod = await freshSocketModule();
    mod._setSocketRandomForTests(() => 0.6);
    const socket = await connected(mod);
    session.getFreshAccessToken.mockResolvedValue('access-live');

    serverDisconnect(socket);
    await vi.advanceTimersByTimeAsync(mod.SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS * 0.6 - 1);
    expect(session.getFreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'access-live' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('the repair after this client\'s own credential change stays IMMEDIATE, whatever the spread', async () => {
    const mod = await freshSocketModule();
    mod._setSocketRandomForTests(() => 0.99);
    const socket = await connected(mod);
    storage.getAccessToken.mockReturnValue('access-new');
    mod.reconnectSocketAfterCredentialChange('access-new');
    expect(socket.connect).toHaveBeenCalledTimes(1);

    socket.connected = true;
    socket.fire('connect');
    serverDisconnect(socket); // another node's copy of the revocation
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(socket.auth).toEqual({ token: 'access-new' });
    expect(session.getFreshAccessToken).not.toHaveBeenCalled();
  });

  it('the token expired and the server is still down: the renewal fails, the socket opens with the stored token anyway, and recovers on the \'Token expired\' refusal once the server is back', async () => {
    const mod = await freshSocketModule();
    const socket = await connected(mod);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    session.getFreshAccessToken.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 502'), { isAxiosError: true }));

    serverDisconnect(socket);
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    // Opened with the stored token: the manager's own back-off runs while the server is away
    expect(socket.auth).toEqual({ token: 'access-expired' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    socket.fire('connect_error', new Error('xhr poll error')); // transport: the manager retries alone
    await tick();
    expect(session.refreshAccessToken).not.toHaveBeenCalled();

    // Back: the expired token is refused, ONE renewal, reopened with its answer
    session.refreshAccessToken.mockResolvedValueOnce('access-renewed');
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'access-renewed' });
    expect(socket.connect).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    error.mockRestore();
  });

  it('a refused renewal after the disconnect opens nothing (the session module has signed out once)', async () => {
    const mod = await freshSocketModule();
    const socket = await connected(mod);
    session.getFreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('refused'));

    serverDisconnect(socket);
    await vi.advanceTimersByTimeAsync(mod.HANDSHAKE_RETRY_MAX_MS * 2);
    await tick();

    expect(session.getFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('no reconnect after force:logout, whatever the spread', async () => {
    const mod = await freshSocketModule();
    mod._setSocketRandomForTests(() => 0.5);
    const socket = await connected(mod);
    session.getFreshAccessToken.mockResolvedValue('access-live');
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true, configurable: true });
    try {
      socket.fire('force:logout', { reason: 'banned' });
      serverDisconnect(socket);
      await vi.advanceTimersByTimeAsync(mod.SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS);
      await tick();

      expect(session.getFreshAccessToken).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
    }
  });
});

describe('services/socket — every inbound event bumps the request generation (issue 4)', () => {
  // services/api.ts coalesces identical GETs in flight; a GET the stores issue
  // BECAUSE of a socket event must not join one issued before it
  it('registers an onAny handler that bumps requestGeneration', async () => {
    const { requestGeneration } = await import('../../services/requestGeneration');
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const s = createdSockets[createdSockets.length - 1];
    const handlers = s.onAny.mock.calls.map((c) => c[0] as (event: string, ...args: unknown[]) => void);
    expect(handlers.length).toBeGreaterThan(0);

    const before = requestGeneration();
    for (const handler of handlers) handler('message:new', { id: 'm1' });
    expect(requestGeneration()).toBeGreaterThan(before);
  });
});
