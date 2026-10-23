import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    disconnect: vi.fn(),
    connect: vi.fn(),
    connected: false,
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
  };
});
vi.mock('../../services/session', () => session);
vi.mock('../../services/tokenStorage', () => ({ getAccessToken: vi.fn(() => 'stored-token') }));

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

describe('services/socket — handshake refused for an expired token', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
  });

  it('renews the token and hands it to the manager for its next attempt', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockResolvedValueOnce('token-new');

    socket.fire('connect_error', new Error('Token expired'));
    await tick();

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: 'token-new' });
    // The manager is still retrying on its own: no forced reopen
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("'Invalid token' (an older server's word for the same expiry) renews too", async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-expired');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockResolvedValueOnce('token-new');

    socket.fire('connect_error', new Error('Invalid token'));
    await tick();

    expect(socket.auth).toEqual({ token: 'token-new' });
  });

  it('every other refusal (banned, unverified, consent, revoked) renews nothing', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];

    for (const message of ['Account banned', 'Email not verified', 'Consent required', 'Session invalidated']) {
      socket.fire('connect_error', new Error(message));
    }
    await tick();

    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('renews at most once per window: a server refusing even fresh tokens must not spend the refresh limiter', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    session.refreshAccessToken.mockResolvedValue('token-new');

    socket.fire('connect_error', new Error('Token expired'));
    socket.fire('connect_error', new Error('Token expired'));
    socket.fire('connect_error', new Error('Token expired'));
    await tick();

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);

    mod._resetSocketModuleForTests();
    socket.fire('connect_error', new Error('Token expired'));
    await tick();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('a renewal refused for good is left to the session module (it has ended the session); a transient one is logged', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    session.refreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('lost'));
    socket.fire('connect_error', new Error('Token expired'));
    await tick();
    expect(warn).not.toHaveBeenCalled();
    expect(socket.auth).toEqual({ token: 'token-1' });

    mod._resetSocketModuleForTests();
    session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));
    socket.fire('connect_error', new Error('Token expired'));
    await tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('renew'), 'Network Error');
    warn.mockRestore();
  });
});

describe('services/socket — a manager that gave up', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
  });

  it('reconnect_failed reports disconnected; connectSocket(token) then REOPENS the socket instead of only storing the token', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    const statuses: string[] = [];
    mod.onConnectionStatusChange((s) => statuses.push(s));

    socket.fireIo('reconnect_failed');
    expect(mod.getConnectionStatus()).toBe('disconnected');

    // The REST client renewed the token (a 401 retry on resume) and re-handshakes
    mod.connectSocket('token-new');

    expect(socket.auth).toEqual({ token: 'token-new' });
    // Open NOW: the manager's back-off and attempt count are gone with the
    // disconnect(), and connect() starts a fresh cycle if the open fails
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect.mock.invocationCallOrder[0]).toBeLessThan(socket.connect.mock.invocationCallOrder[0]);
    expect(statuses.at(-1)).toBe('connecting');
    expect(createdSockets).toHaveLength(1); // the same socket, its listeners intact
  });

  it('a renewal from the handshake path reopens a manager that gave up meanwhile', async () => {
    const mod = await freshSocketModule();
    mod.connectSocket('token-1');
    const socket = createdSockets[0];
    let finish!: (t: string) => void;
    session.refreshAccessToken.mockReturnValueOnce(new Promise<string>((r) => { finish = r; }));

    socket.fire('connect_error', new Error('Token expired'));
    socket.fireIo('reconnect_failed');
    finish('token-new');
    await tick();

    expect(socket.auth).toEqual({ token: 'token-new' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('while the manager is still retrying, connectSocket(token) only stores the token (never a reopen that would cut a running attempt)', async () => {
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
});

describe('services/socket — ensureSocketConnected (the window comes back)', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSockets.length = 0;
    session.refreshAccessToken.mockReset();
    session.getFreshAccessToken.mockReset();
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
