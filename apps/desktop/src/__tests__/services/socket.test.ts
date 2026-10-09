import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Fake socket.io-client ───────────────────────────────────────────────────
// Each io() call returns a fresh fake socket. Handlers registered via .on()
// are captured so tests can simulate 'connect' events manually.

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connected: boolean;
  auth: Record<string, unknown>;
  id: string;
  onAny: ReturnType<typeof vi.fn>;
  onAnyOutgoing: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> };
  handlers: Map<string, (...args: unknown[]) => void>;
  fire: (event: string, ...args: unknown[]) => void;
}

const createdSockets: FakeSocket[] = [];

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket: FakeSocket = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
      return socket;
    }),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    auth: {},
    id: 'fake',
    onAny: vi.fn(),
    onAnyOutgoing: vi.fn(),
    io: { on: vi.fn(), removeAllListeners: vi.fn() },
    handlers,
    fire: (event: string, ...args: unknown[]) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`No handler registered for '${event}'`);
      handler(...args);
    },
  };
  return socket;
}

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const s = makeFakeSocket();
    createdSockets.push(s);
    return s;
  }),
}));

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
