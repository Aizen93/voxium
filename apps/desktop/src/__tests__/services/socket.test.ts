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

type SocketModule = typeof import('../../services/socket');

async function freshSocketModule(): Promise<SocketModule> {
  return import('../../services/socket');
}

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

  it('every other refusal (banned, unverified, consent, revoked) renews nothing and reopens nothing', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];

    for (const message of ['Account banned', 'Email not verified', 'Consent required', 'Session invalidated']) {
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

  it('a renewal refused for good is left to the session module (it has ended the session); a transient one is logged, nothing reopened', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    session.refreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('lost'));
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(warn).not.toHaveBeenCalled();
    expect(socket.auth).toEqual({ token: 'token-expired' });
    expect(socket.connect).not.toHaveBeenCalled();

    mod._resetSocketModuleForTests();
    session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));
    refuseHandshake(socket, 'Token expired');
    await tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('renew'), 'Network Error');
    expect(socket.connect).not.toHaveBeenCalled();
    warn.mockRestore();
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

  it('a transient renewal failure is logged and leaves the manager to its own retries', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    socket.fire('connect');
    socket.fire('disconnect', 'ping timeout');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    session.getFreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));

    await mod.ensureSocketConnected();

    expect(socket.connect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume'), 'Network Error');
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
