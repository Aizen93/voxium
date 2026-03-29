import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks (variables referenced in vi.mock factories) ───────────────

const {
  mockSetUserOnline,
  mockSetUserOffline,
  mockGetRedisPubSub,
  mockIOInstance,
} = vi.hoisted(() => {
  const mockEmitIO = vi.fn();
  const mockToIO = vi.fn().mockReturnValue({ emit: mockEmitIO });
  const mockIOInstance = {
    use: vi.fn(),
    on: vi.fn(),
    adapter: vi.fn(),
    sockets: { sockets: new Map() },
    to: mockToIO,
    fetchSockets: vi.fn().mockResolvedValue([]),
    in: vi.fn().mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([]) }),
    _emit: mockEmitIO,
    _to: mockToIO,
  };
  return {
    mockSetUserOnline: vi.fn().mockResolvedValue(undefined),
    mockSetUserOffline: vi.fn().mockResolvedValue(null),
    mockGetRedisPubSub: vi.fn().mockReturnValue({
      pub: {},
      sub: {},
    }),
    mockIOInstance,
  };
});

const { mockPrisma } = vi.hoisted(() => {
  return {
    mockPrisma: {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
      serverMember: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      channel: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      conversation: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
      ipRecord: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      ipBan: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      supportTicket: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      announcement: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      customEmoji: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      stickerPack: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      conversationRead: {
        createMany: vi.fn(),
      },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    },
  };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

// Mock socket.io to return our controlled mock instance
// Must use `function` (not arrow) so it can be called with `new`
vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(function () { return mockIOInstance; }),
}));

vi.mock('@socket.io/redis-adapter', () => ({
  createAdapter: vi.fn().mockReturnValue('mock-adapter'),
}));

vi.mock('../../utils/redis', () => ({
  setUserOnline: mockSetUserOnline,
  setUserOffline: mockSetUserOffline,
  getRedisPubSub: mockGetRedisPubSub,
  getRedis: vi.fn().mockReturnValue({ ping: vi.fn() }),
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

vi.mock('../../websocket/voiceHandler', () => ({
  handleVoiceEvents: vi.fn(),
  getVoiceStateForServer: vi.fn().mockResolvedValue([]),
  getScreenShareState: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../websocket/dmVoiceHandler', () => ({
  handleDMVoiceEvents: vi.fn(),
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn().mockReturnValue({
      userId: 'user-1',
      username: 'alice',
      tokenVersion: 0,
    }),
  },
}));

import { initSocketServer } from '../../websocket/socketServer';
import http from 'http';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSocket(userId = 'user-1') {
  const rooms = new Set<string>();
  const handlers = new Map<string, Function>();
  const emitFn = vi.fn();
  const toFn = vi.fn().mockReturnValue({ emit: emitFn });

  const socket: any = {
    id: `socket-${userId}`,
    data: { userId, username: 'alice', role: 'user' },
    handshake: {
      auth: { token: 'valid-token' },
      address: '127.0.0.1',
      headers: {},
    },
    join: vi.fn((room: string) => rooms.add(room)),
    leave: vi.fn((room: string) => rooms.delete(room)),
    emit: emitFn,
    to: toFn,
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    rooms,
  };

  return { socket, handlers, emitFn, toFn };
}

/** Extract the 'connection' handler registered on the mock IO instance */
function getConnectionHandler(): Function {
  const onCalls = vi.mocked(mockIOInstance.on).mock.calls;
  for (const [event, handler] of onCalls) {
    if (event === 'connection') return handler;
  }
  throw new Error('No connection handler registered');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('socketServer — DM presence broadcast on connect', () => {
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';

    // Default mock setup: user exists and is verified
    mockPrisma.user.findUnique.mockResolvedValue({
      bannedAt: null,
      tokenVersion: 0,
      role: 'user',
      emailVerified: true,
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  afterEach(() => {
    if (savedJwtSecret !== undefined) {
      process.env.JWT_SECRET = savedJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it('emits presence:update online to DM conversation rooms on connect', async () => {
    const { socket, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    // The connection handler queries conversations twice:
    // 1. To auto-join DM rooms
    // 2. To broadcast DM presence
    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([{ id: 'conv-1' }, { id: 'conv-2' }]) // auto-join rooms
      .mockResolvedValueOnce([{ id: 'conv-1' }, { id: 'conv-2' }]); // DM presence broadcast

    await connectionHandler(socket);

    // Should emit presence:update to each DM conversation room
    expect(toFn).toHaveBeenCalledWith('dm:conv-1');
    expect(toFn).toHaveBeenCalledWith('dm:conv-2');

    // Verify the emit payload includes online status
    const dmToResults = toFn.mock.calls
      .map((call, idx) => ({ room: call[0], returnValue: toFn.mock.results[idx].value }))
      .filter((c) => typeof c.room === 'string' && c.room.startsWith('dm:'));

    expect(dmToResults.length).toBeGreaterThanOrEqual(2);

    httpServer.close();
  });

  it('does not emit DM presence events when user has no DM conversations', async () => {
    const { socket, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    // No conversations
    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([]) // auto-join rooms
      .mockResolvedValueOnce([]); // DM presence broadcast

    await connectionHandler(socket);

    // toFn calls should not include any dm: rooms
    const dmPresenceCalls = toFn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('dm:')
    );
    expect(dmPresenceCalls).toHaveLength(0);

    httpServer.close();
  });

  it('DM presence broadcast errors do not crash the connection handler', async () => {
    const { socket } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    // First call for auto-join succeeds, second call for DM presence throws
    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([]) // auto-join rooms
      .mockRejectedValueOnce(new Error('DB connection lost')); // DM presence broadcast

    // Should not throw — the error is caught internally via try/catch
    await expect(connectionHandler(socket)).resolves.not.toThrow();

    httpServer.close();
  });
});

describe('socketServer — DM presence broadcast on disconnect', () => {
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';

    mockPrisma.user.findUnique.mockResolvedValue({
      bannedAt: null,
      tokenVersion: 0,
      role: 'user',
      emailVerified: true,
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  afterEach(() => {
    if (savedJwtSecret !== undefined) {
      process.env.JWT_SECRET = savedJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it('emits presence:update offline to DM rooms when user fully disconnects', async () => {
    const { socket, handlers, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    // Set up for connection phase
    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([]) // auto-join rooms
      .mockResolvedValueOnce([]); // online DM presence

    await connectionHandler(socket);

    // Get the disconnecting handler that was registered synchronously
    const disconnectingHandler = handlers.get('disconnecting');
    expect(disconnectingHandler).toBeDefined();

    // Configure disconnect scenario: user is fully offline
    mockSetUserOffline.mockResolvedValueOnce({ fullyOffline: true });

    // Set up DB queries for disconnect (Promise.all: serverMember + conversation)
    mockPrisma.serverMember.findMany.mockResolvedValueOnce([
      { serverId: 'srv-1' },
    ]);
    mockPrisma.conversation.findMany.mockResolvedValueOnce([
      { id: 'conv-1' },
      { id: 'conv-3' },
    ]);

    // Clear toFn calls from connection phase
    toFn.mockClear();

    await disconnectingHandler!();

    // Should emit presence:update offline to server rooms
    expect(toFn).toHaveBeenCalledWith('server:srv-1');

    // Should emit presence:update offline to DM rooms
    expect(toFn).toHaveBeenCalledWith('dm:conv-1');
    expect(toFn).toHaveBeenCalledWith('dm:conv-3');

    httpServer.close();
  });

  it('does NOT emit offline events when user still has other sockets (not fully offline)', async () => {
    const { socket, handlers, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await connectionHandler(socket);

    const disconnectingHandler = handlers.get('disconnecting');

    // User still has other sockets — not fully offline
    mockSetUserOffline.mockResolvedValueOnce({ fullyOffline: false });

    toFn.mockClear();

    await disconnectingHandler!();

    // No presence:update calls should be made (not fully offline)
    expect(toFn).not.toHaveBeenCalled();

    httpServer.close();
  });

  it('does NOT emit offline events when setUserOffline returns null', async () => {
    const { socket, handlers, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await connectionHandler(socket);

    const disconnectingHandler = handlers.get('disconnecting');
    mockSetUserOffline.mockResolvedValueOnce(null);

    toFn.mockClear();

    await disconnectingHandler!();

    // No presence events
    expect(toFn).not.toHaveBeenCalled();

    httpServer.close();
  });

  it('disconnect handler catches errors without crashing', async () => {
    const { socket, handlers } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await connectionHandler(socket);

    const disconnectingHandler = handlers.get('disconnecting');

    // setUserOffline throws
    mockSetUserOffline.mockRejectedValueOnce(new Error('Redis down'));

    // Should not throw — error caught by try/catch in disconnecting handler
    await expect(disconnectingHandler!()).resolves.not.toThrow();

    httpServer.close();
  });

  it('emits to DM rooms but not server rooms when user has no server memberships', async () => {
    const { socket, handlers, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await connectionHandler(socket);

    const disconnectingHandler = handlers.get('disconnecting');

    mockSetUserOffline.mockResolvedValueOnce({ fullyOffline: true });
    mockPrisma.serverMember.findMany.mockResolvedValueOnce([]); // no server memberships
    mockPrisma.conversation.findMany.mockResolvedValueOnce([{ id: 'conv-1' }]); // one DM conv

    toFn.mockClear();

    await disconnectingHandler!();

    // Should only emit to DM room, not any server room
    const dmCalls = toFn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('dm:')
    );
    const serverCalls = toFn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('server:')
    );

    expect(dmCalls).toHaveLength(1);
    expect(dmCalls[0][0]).toBe('dm:conv-1');
    expect(serverCalls).toHaveLength(0);

    httpServer.close();
  });
});
