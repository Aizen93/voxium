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
  getVoiceStateForServer: vi.fn().mockResolvedValue([]),
  getVoiceStateForServers: vi.fn().mockResolvedValue([]),
  getScreenShareState: vi.fn().mockResolvedValue(null),
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

import { getVoiceStateForServers } from '../../websocket/voiceHandler';

describe('socketServer — voice:channel_users replay on connect', () => {
  const savedJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    mockPrisma.user.findUnique.mockResolvedValue({
      bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true,
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

  it('forwards e2eDeviceId/e2eEpoch as deviceId/epoch, matching the voice:join replay shape', async () => {
    // F3: this replay dropped both fields, so a client that reconnected during
    // a secure voice call excluded every occupant from keying for the rest of
    // the call — silent, and only reachable on reconnect.
    const { socket, emitFn } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    // Secure channel visibility is membership-derived — without this row the
    // replay is (correctly) filtered out before it is ever emitted
    mockPrisma.channelMember.findMany.mockResolvedValue([{ channelId: 'sec-vc' }]);
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'peer-1', username: 'peer', displayName: 'Peer', avatarUrl: null },
    ]);
    vi.mocked(getVoiceStateForServers).mockResolvedValueOnce([{
      channelId: 'sec-vc',
      serverId: 'srv-1',
      userIds: ['peer-1'],
      userStates: new Map([['peer-1', {
        selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false,
        e2eDeviceId: 'device-aaaa1111', e2eEpoch: 'epochAAAA0001',
      }]]),
    }] as never);

    await connectionHandler(socket);

    const replay = emitFn.mock.calls.find((c) => c[0] === 'voice:channel_users');
    expect(replay?.[1].users[0]).toMatchObject({
      id: 'peer-1',
      deviceId: 'device-aaaa1111',
      epoch: 'epochAAAA0001',
    });

    httpServer.close();
  });

  it('omits the keys entirely for a plaintext channel, rather than sending undefined', async () => {
    // Conditional spread, exactly like voiceHandler's replay — a present-but-
    // undefined key would read as "announced no device" on the client
    const { socket, emitFn } = createMockSocket('user-1');
    const httpServer = http.createServer();
    initSocketServer(httpServer);
    const connectionHandler = getConnectionHandler();

    mockPrisma.channel.findMany.mockResolvedValue([
      { id: 'vc', serverId: 'srv-1', type: 'voice', secure: false },
    ]);
    mockPrisma.server.findMany.mockResolvedValue([{ id: 'srv-1', ownerId: 'user-1' }]);
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'peer-1', username: 'peer', displayName: 'Peer', avatarUrl: null },
    ]);
    vi.mocked(getVoiceStateForServers).mockResolvedValueOnce([{
      channelId: 'vc',
      serverId: 'srv-1',
      userIds: ['peer-1'],
      userStates: new Map([['peer-1', {
        selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false,
      }]]),
    }] as never);

    await connectionHandler(socket);

    const replay = emitFn.mock.calls.find((c) => c[0] === 'voice:channel_users');
    expect(replay?.[1].users[0]).not.toHaveProperty('deviceId');
    expect(replay?.[1].users[0]).not.toHaveProperty('epoch');

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

  beforeEach(() => { prevEnv = process.env.NODE_ENV; prevTrust = process.env.TRUST_PROXY; delete process.env.TRUST_PROXY; });
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
    if (prevTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prevTrust;
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
});
