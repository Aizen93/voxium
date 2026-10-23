import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks (variables referenced in vi.mock factories) ───────────────

const {
  mockSetUserOnline,
  mockSetUserOffline,
  mockIsUserOnline,
  mockReplayVoiceState,
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
    mockIsUserOnline: vi.fn().mockResolvedValue(false),
    mockReplayVoiceState: vi.fn().mockResolvedValue(undefined),
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
      conversationRead: {
        createMany: vi.fn(),
      },
      // Reached only once channel.findMany returns rows: the connect handler
      // then runs the real filterVisibleChannelsMulti over them.
      server: { findMany: vi.fn().mockResolvedValue([]) },
      role: { findMany: vi.fn().mockResolvedValue([]) },
      memberRole: { findMany: vi.fn().mockResolvedValue([]) },
      channelPermissionOverride: { findMany: vi.fn().mockResolvedValue([]) },
      channelMember: { findMany: vi.fn().mockResolvedValue([]) },
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
  isUserOnline: mockIsUserOnline,
  getRedisPubSub: mockGetRedisPubSub,
  getRedis: vi.fn().mockReturnValue({ ping: vi.fn() }),
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../middleware/rateLimiter', async (importOriginal) => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
  // normalizeIp is a pure helper with no store behind it
  normalizeIp: (await importOriginal<typeof import('../../middleware/rateLimiter')>()).normalizeIp,
}));

vi.mock('../../websocket/voiceHandler', () => ({
  handleVoiceEvents: vi.fn(),
  // The replay's shape is voiceHandler's (covered there); here only that the
  // connect handler asks for it, for the right servers and visible channels
  replayVoiceState: mockReplayVoiceState,
}));

vi.mock('../../websocket/dmVoiceHandler', () => ({
  handleDMVoiceEvents: vi.fn(),
}));

vi.mock('../../websocket/annotationHandler', () => ({
  handleAnnotationEvents: vi.fn(),
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

import { initSocketServer, getSocketIp } from '../../websocket/socketServer';
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

/** Extract the authentication middleware registered via io.use() */
function getAuthMiddleware(): Function {
  const useCalls = vi.mocked(mockIOInstance.use).mock.calls;
  if (useCalls.length === 0) throw new Error('No auth middleware registered');
  return useCalls[useCalls.length - 1][0];
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
      emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
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

    // The connection handler queries conversations ONCE — the same result is
    // used for auto-joining DM rooms AND the DM presence broadcast
    mockPrisma.conversation.findMany
      .mockResolvedValueOnce([{ id: 'conv-1' }, { id: 'conv-2' }]);

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

    // No conversations (single query serves rooms + presence)
    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

    await connectionHandler(socket);

    // toFn calls should not include any dm: rooms
    const dmPresenceCalls = toFn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('dm:')
    );
    expect(dmPresenceCalls).toHaveLength(0);

    httpServer.close();
  });

  it('writes online status via a guarded updateMany, never an unconditional update (write-amplification guard)', async () => {
    const { socket } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

    await connectionHandler(socket);

    // Reconnect churn / multi-device connects must skip the no-op write when
    // the row already says 'online' — the status filter makes it conditional
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', NOT: { status: 'online' } },
      data: { status: 'online' },
    });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();

    httpServer.close();
  });

  it('DM presence broadcast errors do not crash the connection handler', async () => {
    const { socket } = createMockSocket('user-1');
    const httpServer = http.createServer();

    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    // The single conversations query fails — the outer connection-setup
    // try/catch must absorb it without crashing the handler
    mockPrisma.conversation.findMany
      .mockRejectedValueOnce(new Error('DB connection lost'));

    // Should not throw — the error is caught internally via try/catch
    await expect(connectionHandler(socket)).resolves.not.toThrow();

    httpServer.close();
  });
});

describe('socketServer — auth middleware gates on consent (CNIL/GDPR)', () => {
  const savedJwtSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
  });
  afterEach(() => {
    if (savedJwtSecret !== undefined) process.env.JWT_SECRET = savedJwtSecret; else delete process.env.JWT_SECRET;
  });

  async function handshake(userRow: Record<string, unknown>) {
    mockPrisma.user.findUnique.mockResolvedValue(userRow);
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const { socket } = createMockSocket('user-1');
    const next = vi.fn();
    await getAuthMiddleware()(socket, next);
    httpServer.close();
    return next;
  }

  it('refuses a live session to an account that has not accepted the legal documents — the same gate as requireConsent on REST', async () => {
    const next = await handshake({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: null, privacyAcceptedAt: null });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Consent required' }));
  });

  it('admits an account that has accepted both', async () => {
    const next = await handshake({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0) });
    expect(next).toHaveBeenCalledWith();
  });

  it('still refuses an unverified email first', async () => {
    const next = await handshake({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false, termsAcceptedAt: null, privacyAcceptedAt: null });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Email not verified' }));
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
      emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
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

    // Set up for connection phase (single conversations query)
    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

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

    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

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

    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

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

    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

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

    mockPrisma.conversation.findMany.mockResolvedValueOnce([]);

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

// ─── Connect-time voice replay (F3) ─────────────────────────────────────────

describe('socketServer — voice occupancy replay on connect', () => {
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    mockPrisma.user.findUnique.mockResolvedValue({
      bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);
    mockPrisma.channel.findMany.mockResolvedValue([
      { id: 'sec-vc', serverId: 'srv-1', type: 'voice', secure: true },
    ]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  afterEach(() => {
    if (savedJwtSecret !== undefined) process.env.JWT_SECRET = savedJwtSecret;
    else delete process.env.JWT_SECRET;
  });

  it('replays to the socket itself, for every server the user is in, with ONLY the channels they can view', async () => {
    // A secure channel's visibility is membership-derived: without the row it
    // is (correctly) outside the replay set, so its occupants never leak
    const { socket } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();
    mockPrisma.channelMember.findMany.mockResolvedValue([]);

    await connectionHandler(socket);

    expect(mockReplayVoiceState).toHaveBeenCalledTimes(1);
    const [target, serverIds, visible] = mockReplayVoiceState.mock.calls[0] as [unknown, string[], Set<string>];
    expect(target).toBe(socket);
    expect(serverIds).toEqual(['srv-1']);
    expect([...visible]).toEqual([]);

    httpServer.close();
  });

  it('a secure voice channel the user is a member of IS in the replay set', async () => {
    const { socket } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();
    mockPrisma.channelMember.findMany.mockResolvedValue([{ channelId: 'sec-vc' }]);

    await connectionHandler(socket);

    const visible = mockReplayVoiceState.mock.calls[0][2] as Set<string>;
    expect([...visible]).toEqual(['sec-vc']);

    httpServer.close();
  });

  it('replays right after the channel rooms are joined, before the unread counts', async () => {
    // The later the replay, the wider the window for a leave to land before
    // it; everything after the room joins reaches the socket live anyway
    const order: string[] = [];
    const { socket } = createMockSocket('user-1');
    socket.join.mockImplementation((room: string) => { order.push(`join:${room}`); });
    mockReplayVoiceState.mockImplementationOnce(async () => { order.push('replay'); });
    mockPrisma.$queryRawUnsafe.mockImplementation(async () => { order.push('unread'); return []; });
    mockPrisma.channel.findMany.mockResolvedValue([{ id: 'tc', serverId: 'srv-1', type: 'text', secure: false }]);
    mockPrisma.server.findMany.mockResolvedValue([{ id: 'srv-1', ownerId: 'user-1' }]);
    const httpServer = http.createServer();
    initSocketServer(httpServer);

    await getConnectionHandler()(socket);

    expect(order.indexOf('join:channel:tc')).toBeLessThan(order.indexOf('replay'));
    expect(order.indexOf('replay')).toBeLessThan(order.indexOf('unread'));

    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    httpServer.close();
  });

  it('a replay failure does not take the DM rooms or the presence broadcast with it', async () => {
    const { socket, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    mockReplayVoiceState.mockRejectedValueOnce(new Error('redis down'));
    mockPrisma.conversation.findMany.mockResolvedValue([{ id: 'conv-1' }]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getConnectionHandler()(socket);

    expect(socket.join).toHaveBeenCalledWith('dm:conv-1');
    expect(toFn).toHaveBeenCalledWith('server:srv-1');
    expect(toFn).toHaveBeenCalledWith('dm:conv-1');
    error.mockRestore();
    httpServer.close();
  });
});

// ─── Presence registration vs. a disconnect during the setup ────────────────
//
// A socket that drops while its connection setup is still running used to
// leave its user online for good: the unregistration ran before the
// registration had landed (nothing to remove), and the DB column was written
// 'online' at the very END of the setup, after the disconnect had already
// written 'offline'.

describe('socketServer — presence registration vs. disconnect race', () => {
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    mockPrisma.user.findUnique.mockResolvedValue({
      bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([{ id: 'conv-1' }]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    mockSetUserOnline.mockResolvedValue(undefined);
    mockSetUserOffline.mockResolvedValue(null);
    mockIsUserOnline.mockResolvedValue(false);
    mockReplayVoiceState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (savedJwtSecret !== undefined) process.env.JWT_SECRET = savedJwtSecret;
    else delete process.env.JWT_SECRET;
  });

  it('a disconnect during the setup WAITS for the registration before unregistering', async () => {
    const { socket, handlers } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    let finishOnline!: () => void;
    mockSetUserOnline.mockReturnValueOnce(new Promise<void>((r) => { finishOnline = r; }));

    const setup = getConnectionHandler()(socket);
    // The socket drops before Redis answered the registration
    const teardown = handlers.get('disconnecting')!();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetUserOffline).not.toHaveBeenCalled();

    finishOnline();
    await Promise.all([setup, teardown]);

    // Unregistered AFTER the registration landed: the socket is found and removed
    expect(mockSetUserOffline).toHaveBeenCalledWith('socket-user-1');
    expect(mockSetUserOnline.mock.invocationCallOrder[0]).toBeLessThan(mockSetUserOffline.mock.invocationCallOrder[0]);
    httpServer.close();
  });

  it('a failed registration still lets the disconnect handler run (never a hang)', async () => {
    const { socket, handlers } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    mockSetUserOnline.mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getConnectionHandler()(socket);
    await expect(handlers.get('disconnecting')!()).resolves.toBeUndefined();

    expect(mockSetUserOffline).toHaveBeenCalledWith('socket-user-1');
    error.mockRestore();
    httpServer.close();
  });

  it('writes the DB column online right after the Redis registration, before any other query', async () => {
    const order: string[] = [];
    mockSetUserOnline.mockImplementationOnce(async () => { order.push('redis-online'); });
    mockPrisma.user.updateMany.mockImplementation(async (args: { data: { status: string } }) => { order.push(`db-${args.data.status}`); return { count: 1 }; });
    mockPrisma.serverMember.findMany.mockImplementationOnce(async () => { order.push('memberships'); return [{ serverId: 'srv-1' }]; });
    const { socket } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);

    await getConnectionHandler()(socket);

    expect(order.slice(0, 3)).toEqual(['redis-online', 'db-online', 'memberships']);
    httpServer.close();
  });

  it('does NOT announce a socket online that disconnected during the setup', async () => {
    const { socket, toFn } = createMockSocket('user-1');
    socket.disconnected = false;
    // The socket drops while the channel rooms are being computed
    mockPrisma.channel.findMany.mockImplementationOnce(async () => { socket.disconnected = true; return []; });
    const httpServer = http.createServer();
    initSocketServer(httpServer);

    await getConnectionHandler()(socket);

    // Registered (its own disconnect handler unwinds it) but never announced
    expect(mockSetUserOnline).toHaveBeenCalled();
    expect(toFn).not.toHaveBeenCalledWith('server:srv-1');
    expect(toFn).not.toHaveBeenCalledWith('dm:conv-1');
    httpServer.close();
  });

  it('control: a socket that stays connected IS announced online to its servers and DMs', async () => {
    const { socket, toFn, emitFn } = createMockSocket('user-1');
    socket.disconnected = false;
    const httpServer = http.createServer();
    initSocketServer(httpServer);

    await getConnectionHandler()(socket);

    expect(toFn).toHaveBeenCalledWith('server:srv-1');
    expect(toFn).toHaveBeenCalledWith('dm:conv-1');
    expect(emitFn).toHaveBeenCalledWith('presence:update', { userId: 'user-1', status: 'online' });
    httpServer.close();
  });

  it('a disconnect whose user reconnected meanwhile writes and announces NOTHING offline', async () => {
    // A page reload under load: the old socket's teardown and the new socket's
    // setup run in parallel. The teardown re-checks Redis as late as it can
    // (after its own queries); if the user is online again, the new
    // connection's online write and broadcast are the truth and an offline
    // one landing after them would show a connected user as offline.
    const { socket, handlers, toFn } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    await getConnectionHandler()(socket);

    mockSetUserOffline.mockResolvedValueOnce({ userId: 'user-1', fullyOffline: true });
    mockIsUserOnline.mockResolvedValueOnce(true);
    mockPrisma.user.updateMany.mockClear();
    toFn.mockClear();

    await handlers.get('disconnecting')!();

    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(toFn).not.toHaveBeenCalled();
    // Checked AFTER the room queries, so the window after it is as small as it can be
    expect(mockPrisma.serverMember.findMany.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(mockIsUserOnline.mock.invocationCallOrder[0]);
    httpServer.close();
  });

  it('control: a disconnect whose user stayed offline writes and announces offline', async () => {
    const { socket, handlers, toFn, emitFn } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    await getConnectionHandler()(socket);

    mockSetUserOffline.mockResolvedValueOnce({ userId: 'user-1', fullyOffline: true });
    mockIsUserOnline.mockResolvedValueOnce(false);
    mockPrisma.user.updateMany.mockClear();
    toFn.mockClear();

    await handlers.get('disconnecting')!();

    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', NOT: { status: 'offline' } },
      data: { status: 'offline' },
    });
    expect(toFn).toHaveBeenCalledWith('server:srv-1');
    expect(emitFn).toHaveBeenCalledWith('presence:update', { userId: 'user-1', status: 'offline' });
    httpServer.close();
  });

  it('one failing setup step does not abandon the rest: a dead channel query still leaves the DM rooms joined and presence announced', async () => {
    const { socket, toFn } = createMockSocket('user-1');
    socket.disconnected = false;
    mockPrisma.channel.findMany.mockRejectedValueOnce(new Error('db hiccup'));
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getConnectionHandler()(socket);

    expect(socket.join).toHaveBeenCalledWith('server:srv-1');
    expect(socket.join).toHaveBeenCalledWith('dm:conv-1');
    expect(mockReplayVoiceState).toHaveBeenCalled();
    expect(toFn).toHaveBeenCalledWith('server:srv-1');
    expect(toFn).toHaveBeenCalledWith('dm:conv-1');
    expect(mockPrisma.announcement.findMany).toHaveBeenCalled();
    error.mockRestore();
    httpServer.close();
  });
});

// ─── Connect-time unread counts (webhook rows have no author) ───────────────

describe('socketServer — unread:init / dm:unread:init count authorless rows', () => {
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    mockPrisma.user.findUnique.mockResolvedValue({
      bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    mockPrisma.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);
    mockPrisma.channel.findMany.mockResolvedValue([
      { id: 'tc', serverId: 'srv-1', type: 'text', secure: false },
    ]);
    // Owner fast path: the plaintext text channel is visible
    mockPrisma.server.findMany.mockResolvedValue([{ id: 'srv-1', ownerId: 'user-1' }]);
    mockPrisma.conversation.findMany.mockResolvedValue([{ id: 'conv-1' }]);
    mockPrisma.ipBan.findUnique.mockResolvedValue(null);
    mockPrisma.ipRecord.upsert.mockResolvedValue({});
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.announcement.findMany.mockResolvedValue([]);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes('m.channel_id = c.id')
        ? [{ channel_id: 'tc', server_id: 'srv-1', cnt: 3 }]
        : [{ conversation_id: 'conv-1', cnt: 2 }]);
  });

  afterEach(() => {
    if (savedJwtSecret !== undefined) process.env.JWT_SECRET = savedJwtSecret;
    else delete process.env.JWT_SECRET;
    mockPrisma.$queryRawUnsafe.mockReset();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  it('excludes only the viewer as author with IS DISTINCT FROM, so a NULL-author webhook row still counts', async () => {
    // `m.author_id != $1` is NULL for author_id NULL, which drops every
    // webhook-posted row from the reconnect count while the live message:new
    // handler counts it: the badge would shrink on every reconnect.
    const { socket, emitFn } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    await connectionHandler(socket);

    const calls = mockPrisma.$queryRawUnsafe.mock.calls as unknown[][];
    const channelSql = calls.map((c) => c[0] as string).find((q) => q.includes('m.channel_id = c.id'));
    const dmSql = calls.map((c) => c[0] as string).find((q) => q.includes('m.conversation_id = conv.id'));
    expect(channelSql).toBeDefined();
    expect(dmSql).toBeDefined();
    for (const sql of [channelSql!, dmSql!]) {
      expect(sql).toMatch(/AND m\.author_id IS DISTINCT FROM \$1/);
      expect(sql).not.toMatch(/author_id\s*!=/);
      expect(sql).not.toMatch(/author_id\s*<>/);
    }
    // the viewer is still the excluded author
    const channelCall = calls.find((c) => c[0] === channelSql)!;
    expect(channelCall[1]).toBe('user-1');
    expect(channelCall[2]).toEqual(['tc']);

    expect(emitFn).toHaveBeenCalledWith('unread:init', {
      unreads: [{ channelId: 'tc', serverId: 'srv-1', count: 3 }],
    });
    expect(emitFn).toHaveBeenCalledWith('dm:unread:init', {
      unreads: [{ conversationId: 'conv-1', count: 2 }],
    });

    httpServer.close();
  });
});

// ─── Which address the socket surface believes it is talking to ─────────────

describe('getSocketIp', () => {
  const handshake = (address: string, xff?: string | string[]) => ({
    handshake: { address, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } },
  });
  let prevEnv: string | undefined;
  let prevTrust: string | undefined;

  let prevHops: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.NODE_ENV; prevTrust = process.env.TRUST_PROXY; prevHops = process.env.TRUST_PROXY_HOPS;
    delete process.env.TRUST_PROXY; delete process.env.TRUST_PROXY_HOPS;
  });
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
    if (prevTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prevTrust;
    if (prevHops === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = prevHops;
  });

  it('takes the LAST forwarded hop, the only one a trusted proxy wrote', () => {
    process.env.NODE_ENV = 'production';
    // nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for`, i.e.
    // "$http_x_forwarded_for, $remote_addr" — the client owns everything left
    // of the last comma. Reading the FIRST entry let a banned client name the
    // address the IpBan lookup queries, on the one surface that can evict an
    // already-authenticated session.
    expect(getSocketIp(handshake('10.0.0.5', '10.0.0.1, 203.0.113.7'))).toBe('203.0.113.7');
  });

  it('ignores a spoofed single-entry header in favour of the proxy-appended one', () => {
    process.env.NODE_ENV = 'production';
    expect(getSocketIp(handshake('10.0.0.5', '198.51.100.99, 203.0.113.7'))).toBe('203.0.113.7');
  });

  it('agrees with the REST controls about IPv4-mapped and uppercase forms', () => {
    process.env.NODE_ENV = 'production';
    // Two keyed controls that disagree about an address fail OPEN
    expect(getSocketIp(handshake('x', '10.0.0.1, ::ffff:203.0.113.7'))).toBe('203.0.113.7');
    expect(getSocketIp(handshake('x', '10.0.0.1, ::FFFF:203.0.113.7'))).toBe('203.0.113.7');
    expect(getSocketIp(handshake('x', '10.0.0.1, 2001:DB8::1'))).toBe('2001:db8::1');
  });

  it('handles a repeated header, which arrives as an array', () => {
    process.env.NODE_ENV = 'production';
    expect(getSocketIp(handshake('10.0.0.5', ['10.0.0.1', '203.0.113.7']))).toBe('203.0.113.7');
  });

  it('ignores the header entirely outside production, where no proxy is trusted', () => {
    process.env.NODE_ENV = 'development';
    expect(getSocketIp(handshake('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9');
  });

  // Express trusts the proxy on TRUST_PROXY=true too (app.ts) — the documented
  // knob for "behind nginx" outside the Docker image. Gating the socket side on
  // NODE_ENV alone left such a deploy with REST bans keyed on real client IPs
  // and socket bans keyed on nginx's address: two keyed controls disagreeing
  // about an address, which fails open.
  it('honours TRUST_PROXY=true outside production, exactly like Express does', () => {
    process.env.NODE_ENV = 'staging';
    process.env.TRUST_PROXY = 'true';
    expect(getSocketIp(handshake('10.0.0.5', '198.51.100.99, 203.0.113.7'))).toBe('203.0.113.7');
  });

  it('does not trust the header on any other TRUST_PROXY value', () => {
    process.env.NODE_ENV = 'staging';
    process.env.TRUST_PROXY = '1';
    expect(getSocketIp(handshake('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9');
  });

  it('falls back to the socket address when the header is absent or empty', () => {
    process.env.NODE_ENV = 'production';
    expect(getSocketIp(handshake('::ffff:203.0.113.9'))).toBe('203.0.113.9');
    expect(getSocketIp(handshake('203.0.113.9', '  '))).toBe('203.0.113.9');
    expect(getSocketIp(handshake(''))).toBeUndefined();
  });

  // A load balancer in front of nginx appends nginx's address as the LAST
  // entry; with TRUST_PROXY_HOPS=2 both surfaces step over it. Without the
  // setting, every caller would be keyed on nginx's address — one bucket.
  it('steps over TRUST_PROXY_HOPS trusted entries from the right', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY_HOPS = '2';
    expect(getSocketIp(handshake('10.0.1.5', 'spoofed, 203.0.113.7, 10.0.1.10'))).toBe('203.0.113.7');
    // Chain shorter than the hop count → leftmost entry, like Express
    expect(getSocketIp(handshake('10.0.1.5', '203.0.113.7'))).toBe('203.0.113.7');
    expect(getSocketIp(handshake('10.0.1.5', ['203.0.113.7', '10.0.1.10']))).toBe('203.0.113.7');
  });

  it('treats an invalid TRUST_PROXY_HOPS as 1', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY_HOPS = 'lots';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getSocketIp(handshake('10.0.0.5', '198.51.100.99, 203.0.113.7'))).toBe('203.0.113.7');
    warn.mockRestore();
  });
});
