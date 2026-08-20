import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockRouter, mockSendTransport, mockRecvTransport, createFakeProducer, createFakeConsumer } = vi.hoisted(() => {
  let producerSeq = 0;
  let consumerSeq = 0;
  // producerId → kind, so fake consumers inherit the right kind
  const producerKinds = new Map<string, string>();

  /** Fake mediasoup Producer — kind/appData flow through like the real thing */
  const createFakeProducer = (kind: string, appData: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const producer: any = {
      id: `producer-${++producerSeq}`,
      kind,
      appData,
      paused: false,
      closed: false,
      on: vi.fn(),
    };
    producer.pause = vi.fn(() => { producer.paused = true; });
    producer.resume = vi.fn(() => { producer.paused = false; });
    producer.close = vi.fn(() => { producer.closed = true; });
    producerKinds.set(producer.id, kind);
    return producer;
  };

  /** Fake mediasoup Consumer — kind mirrors the source producer's kind */
  const createFakeConsumer = (producerId: string, kind?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const consumer: any = {
      id: `consumer-${++consumerSeq}`,
      producerId,
      kind: kind ?? producerKinds.get(producerId) ?? 'audio',
      rtpParameters: {},
      appData: {},
      paused: true,
      closed: false,
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    consumer.close = vi.fn(() => { consumer.closed = true; });
    return consumer;
  };

  const mockRouter = {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    canConsume: vi.fn().mockReturnValue(true),
  };
  const mockSendTransport = {
    id: 'send-transport-1',
    iceParameters: {},
    iceCandidates: [],
    dtlsParameters: {},
    closed: false,
    produce: vi.fn(),
    close: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    setMaxOutgoingBitrate: vi.fn().mockResolvedValue(undefined),
  };
  const mockRecvTransport = {
    id: 'recv-transport-1',
    iceParameters: {},
    iceCandidates: [],
    dtlsParameters: {},
    closed: false,
    consume: vi.fn(),
    close: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    setMaxOutgoingBitrate: vi.fn().mockResolvedValue(undefined),
  };
  return { mockRouter, mockSendTransport, mockRecvTransport, createFakeProducer, createFakeConsumer };
});

// Mock Prisma
vi.mock('../../utils/prisma', () => ({
  prisma: {
    channel: { findUnique: vi.fn() },
    serverMember: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

// Mock Redis
const mockVoiceRedis = vi.hoisted(() => ({
  multi: vi.fn().mockReturnValue({
    hSet: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    sAdd: vi.fn().mockReturnThis(),
    hDel: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    sRem: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnThis(),
    hGetAll: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  }),
  hSet: vi.fn().mockResolvedValue(1),
  hGetAll: vi.fn().mockResolvedValue({}),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  sRem: vi.fn().mockResolvedValue(1),
  sCard: vi.fn().mockResolvedValue(0),
  sMembers: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(null),
  exists: vi.fn().mockResolvedValue(0),
  eval: vi.fn().mockResolvedValue(1),
  // eslint-disable-next-line require-yield
  scanIterator: vi.fn().mockImplementation(async function* () { /* default: no keys */ }),
}));
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockVoiceRedis),
  NODE_ID: vi.fn().mockReturnValue('test-node-1'),
  isNodeAlive: vi.fn().mockResolvedValue(false),
  socketExistsInCluster: vi.fn().mockResolvedValue(false),
}));

// Mock the relay layer — routing decisions are tested here; the relay transport
// itself is covered by voiceRelay.test.ts. Defaults = single-node behavior.
const mockRelay = vi.hoisted(() => ({
  getRemoteSession: vi.fn().mockReturnValue(undefined),
  setRemoteSession: vi.fn(),
  clearRemoteSession: vi.fn(),
  relayVoiceEvent: vi.fn().mockResolvedValue(undefined),
  resolveOrClaimChannelOwner: vi.fn().mockResolvedValue('test-node-1'),
  dropShim: vi.fn(),
}));
vi.mock('../../websocket/voiceRelay', () => mockRelay);

// Mock rate limiter — always allow
vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

// Mock feature flags — voice enabled by default
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Mock permission calculator — allow by default
vi.mock('../../utils/permissionCalculator', () => ({
  hasChannelPermission: vi.fn().mockResolvedValue(true),
  hasServerPermission: vi.fn().mockResolvedValue(true),
  getHighestRolePosition: vi.fn().mockResolvedValue(Infinity),
  Permissions: { CONNECT: 1n << 14n },
}));

// Mock mediasoup manager — transports can produce/consume with fake objects
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getOrCreateRouter: vi.fn().mockResolvedValue(mockRouter),
  createWebRtcTransport: vi.fn().mockImplementation(() =>
    Promise.resolve({
      ...mockRecvTransport,
      id: `transport-${Math.random()}`,
      close: vi.fn(),
      setMaxOutgoingBitrate: vi.fn().mockResolvedValue(undefined),
      produce: vi.fn().mockImplementation(({ kind, appData }: { kind: string; appData: Record<string, unknown> }) =>
        Promise.resolve(createFakeProducer(kind, appData))),
      consume: vi.fn().mockImplementation(({ producerId }: { producerId: string }) =>
        Promise.resolve(createFakeConsumer(producerId))),
    }),
  ),
  releaseRouter: vi.fn(),
  releaseServerRouters: vi.fn(),
  getRouter: vi.fn().mockReturnValue(mockRouter),
}));

vi.mock('../../mediasoup/mediasoupConfig', () => ({
  RECV_TRANSPORT_MAX_BITRATE: 1500000,
  SCREEN_SHARE_RECV_MAX_BITRATE: 4000000,
}));

// Mock DM voice handler
vi.mock('../../websocket/dmVoiceHandler', () => ({
  leaveCurrentDMVoiceChannel: vi.fn().mockResolvedValue(undefined),
}));

// Mock serverLimits
vi.mock('../../utils/serverLimits', () => ({
  getEffectiveLimits: vi.fn().mockResolvedValue({
    maxChannelsPerServer: 20,
    maxVoiceUsersPerChannel: 12,
    maxCategoriesPerServer: 12,
    maxMembersPerServer: 0,
  }),
}));

import { handleVoiceEvents, leaveCurrentVoiceChannel, clearVoiceState, reapOrphanedRemoteParticipants, dispatchVoiceEvent, handleWorkerDeath, getVoiceDiagnostics, cleanupChannelVoice, cleanupServerVoice, evictUserFromChannelVoice, getVoiceStateForServers } from '../../websocket/voiceHandler';
import { prisma } from '../../utils/prisma';
import { socketRateLimit } from '../../middleware/rateLimiter';
import { isFeatureEnabled } from '../../utils/featureFlags';
import { getEffectiveLimits } from '../../utils/serverLimits';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSocket(userId = 'user-1', socketId = 'socket-1') {
  const handlers = new Map<string, Function>();
  const socket = {
    id: socketId,
    data: { userId, voiceChannelId: undefined as string | undefined },
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    rooms: new Set<string>(),
  };
  return { socket, handlers };
}

function createMockIO() {
  const emitFn = vi.fn();
  const socketsJoinFn = vi.fn();
  const socketsLeaveFn = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    in: vi.fn().mockReturnValue({ socketsJoin: socketsJoinFn, socketsLeave: socketsLeaveFn }),
    sockets: {
      sockets: new Map(),
    },
    _emit: emitFn,
    _socketsJoin: socketsJoinFn,
    _socketsLeave: socketsLeaveFn,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('voiceHandler — voice:join', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('rejects non-string channelId', async () => {
    const handler = handlers.get('voice:join')!;
    await handler(123); // not a string
    expect(socket.emit).not.toHaveBeenCalledWith('voice:error', expect.anything());
    // Should silently return due to isString check
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('emits error when voice feature is disabled', async () => {
    vi.mocked(isFeatureEnabled).mockReturnValueOnce(false);
    const handler = handlers.get('voice:join')!;
    await handler('channel-1');
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'Voice channels are currently disabled' });
  });

  it('emits error when channel not found', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce(null);
    const handler = handlers.get('voice:join')!;
    await handler('channel-1');
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'Voice channel not found.' });
  });

  it('emits error when channel is not voice type', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ serverId: 's1', type: 'text' } as any);
    const handler = handlers.get('voice:join')!;
    await handler('channel-1');
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'Voice channel not found.' });
  });

  it('emits error when user is not a server member', async () => {
    // TWO lookups: the routing wrapper's opacity check, then the handler's own
    vi.mocked(prisma.channel.findUnique)
      .mockResolvedValueOnce({ serverId: 's1', type: 'voice' } as any)
      .mockResolvedValueOnce({ serverId: 's1', type: 'voice' } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce(null);
    const handler = handlers.get('voice:join')!;
    await handler('channel-1');
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'You are not a member of this server.' });
  });

  it('does not emit full error when channel is empty (limit check requires existing users)', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ serverId: 's1', type: 'voice' } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'user-1', serverId: 's1' } as any);
    vi.mocked(getEffectiveLimits).mockResolvedValueOnce({
      maxChannelsPerServer: 20,
      maxVoiceUsersPerChannel: 1,
      maxCategoriesPerServer: 12,
      maxMembersPerServer: 0,
    });
    const handler = handlers.get('voice:join')!;
    await handler('channel-1');
    // With no existing users in the channel, the limit check is bypassed
    // (voiceChannelUsers.get(channelId) is undefined), so the "full" error is not emitted
    expect(socket.emit).not.toHaveBeenCalledWith('voice:error', { message: 'Voice channel is full' });
  });

  it('emits rate limited when rate limit exceeded', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:join')!;
    await handler('channel-1');
    // Should return early — no channel lookup
    expect(prisma.channel.findUnique).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — voice:transport:connect ACK callback', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('calls ackCallback with error when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const ackCallback = vi.fn();
    const handler = handlers.get('voice:transport:connect')!;
    await handler({ transportId: 'send-transport-1', dtlsParameters: {} }, ackCallback);
    expect(ackCallback).toHaveBeenCalledWith({ error: 'Rate limited' });
  });

  it('calls ackCallback with error when data is invalid', async () => {
    const ackCallback = vi.fn();
    const handler = handlers.get('voice:transport:connect')!;
    await handler({ transportId: '', dtlsParameters: {} }, ackCallback);
    expect(ackCallback).toHaveBeenCalledWith({ error: 'Invalid parameters' });
  });

  it('calls ackCallback with error when data has missing dtlsParameters', async () => {
    const ackCallback = vi.fn();
    const handler = handlers.get('voice:transport:connect')!;
    await handler({ transportId: 'send-transport-1', dtlsParameters: null }, ackCallback);
    expect(ackCallback).toHaveBeenCalledWith({ error: 'Invalid parameters' });
  });

  it('calls ackCallback with error when not in a voice channel', async () => {
    socket.data.voiceChannelId = undefined;
    const ackCallback = vi.fn();
    const handler = handlers.get('voice:transport:connect')!;
    await handler({ transportId: 'send-transport-1', dtlsParameters: { role: 'client' } }, ackCallback);
    expect(ackCallback).toHaveBeenCalledWith({ error: 'Not in a voice channel' });
  });

  it('calls ackCallback with error when user media state not found', async () => {
    socket.data.voiceChannelId = 'channel-999';
    const ackCallback = vi.fn();
    const handler = handlers.get('voice:transport:connect')!;
    await handler({ transportId: 'send-transport-1', dtlsParameters: { role: 'client' } }, ackCallback);
    expect(ackCallback).toHaveBeenCalledWith({ error: 'Voice state not found' });
  });

  it('calls ackCallback with error when transport not found', async () => {
    // Need to set up voice state by pretending user joined
    socket.data.voiceChannelId = 'channel-1';
    // There's no actual voice state in the Map for this test
    const ackCallback = vi.fn();
    const handler = handlers.get('voice:transport:connect')!;
    await handler({ transportId: 'nonexistent-transport', dtlsParameters: { role: 'client' } }, ackCallback);
    // The handler checks for voice state first, then transport — the error depends on
    // whether the user has voice state in the internal Map
    expect(ackCallback).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/not found/i) }),
    );
  });

  it('handles missing ackCallback gracefully (no crash)', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:transport:connect')!;
    // Should not throw when ackCallback is undefined
    await handler({ transportId: 'send-transport-1', dtlsParameters: {} }, undefined);
  });
});

describe('voiceHandler — voice:mute', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:mute')!;
    handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('applies a 120/min rate limit (P3)', () => {
    socket.data.voiceChannelId = 'ch-1';
    const handler = handlers.get('voice:mute')!;
    handler(true);
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'voice:mute', 120);
  });

  it('rejects non-boolean muted value', () => {
    const handler = handlers.get('voice:mute')!;
    handler('yes' as any); // not boolean
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when not in a voice channel', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:mute')!;
    handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — voice:deaf', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('applies a 120/min rate limit (P3)', () => {
    socket.data.voiceChannelId = 'ch-1';
    const handler = handlers.get('voice:deaf')!;
    handler(true);
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'voice:deaf', 120);
  });

  it('rejects non-boolean deafened value', () => {
    const handler = handlers.get('voice:deaf')!;
    handler(42 as any);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when not in a voice channel', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:deaf')!;
    handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — voice:speaking', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('rejects non-boolean speaking value', () => {
    const handler = handlers.get('voice:speaking')!;
    handler('true' as any);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when not in a voice channel', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:speaking')!;
    handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — voice:leave', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:leave')!;
    handler();
    expect(socket.leave).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — disconnecting cleanup', () => {
  it('registers a disconnecting handler', () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
    expect(handlers.has('disconnecting')).toBe(true);
  });

  it('disconnecting handler does not throw when not in a voice channel', () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    socket.data.voiceChannelId = undefined;
    handleVoiceEvents(io as any, socket as any);
    const handler = handlers.get('disconnecting')!;
    expect(() => handler()).not.toThrow();
  });
});

describe('voiceHandler — leaveCurrentVoiceChannel', () => {
  it('does nothing when voiceChannelId is undefined', () => {
    const { socket } = createMockSocket();
    const io = createMockIO();
    socket.data.voiceChannelId = undefined;
    leaveCurrentVoiceChannel(io as any, socket as any, 'user-1');
    expect(socket.leave).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — reconnect ownership (CRIT-1)', () => {
  // Uses distinct userIds/channels per test so the module-global voice map can't
  // cross-contaminate (findUserVoiceChannel searches by userId across all channels).
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({ serverId: 's1', type: 'voice' } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({ userId: 'x', serverId: 's1' } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'x', username: 'u', displayName: 'U', avatarUrl: null } as any);
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as any);
  });

  it('stale socket disconnect does NOT tear down a session a newer socket took over', async () => {
    // Original socket joins the channel.
    const c1 = createMockSocket('user-A', 'socket-A1');
    const io1 = createMockIO();
    handleVoiceEvents(io1 as any, c1.socket as any);
    await c1.handlers.get('voice:join')!('ch-A');

    // Reconnect: a new socket for the same user (re)joins, force-evicting the old session.
    const c2 = createMockSocket('user-A', 'socket-A2');
    const io2 = createMockIO();
    handleVoiceEvents(io2 as any, c2.socket as any);
    await c2.handlers.get('voice:join')!('ch-A');

    io1._emit.mockClear();

    // The old socket finally times out. Its stale disconnect must NOT remove user-A,
    // whose live session is now owned by socket-A2.
    await c1.handlers.get('disconnecting')!();
    expect(io1._emit).not.toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-A', userId: 'user-A' });
  });

  it('owning socket disconnect DOES tear down the session', async () => {
    const c1 = createMockSocket('user-B', 'socket-B1');
    const io1 = createMockIO();
    handleVoiceEvents(io1 as any, c1.socket as any);
    await c1.handlers.get('voice:join')!('ch-B');

    io1._emit.mockClear();
    await c1.handlers.get('disconnecting')!();
    expect(io1._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-B', userId: 'user-B' });
  });

  it('force-evict clears the old socket so its delayed disconnect is a no-op (no crash/leak)', async () => {
    // One shared io, as on a real node — both sockets live in io.sockets.sockets.
    const io = createMockIO();
    const c1 = createMockSocket('user-C', 'socket-C1');
    const c2 = createMockSocket('user-C', 'socket-C2');
    io.sockets.sockets.set('socket-C1', c1.socket);
    io.sockets.sockets.set('socket-C2', c2.socket);
    handleVoiceEvents(io as any, c1.socket as any);
    handleVoiceEvents(io as any, c2.socket as any);

    await c1.handlers.get('voice:join')!('ch-C');
    expect(c1.socket.data.voiceChannelId).toBe('ch-C');

    // Reconnect: the new socket (re)joins and force-evicts the old session.
    await c2.handlers.get('voice:join')!('ch-C');
    // The old socket's voice state must be cleared so its ping-timeout disconnect no-ops.
    expect(c1.socket.data.voiceChannelId).toBeUndefined();

    io._emit.mockClear();
    // The old socket finally disconnects — must NOT tear down the live session.
    await expect((async () => c1.handlers.get('disconnecting')!())()).resolves.not.toThrow();
    expect(io._emit).not.toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-C', userId: 'user-C' });
  });
});

describe('voiceHandler — clearVoiceState (boot cleanup, multi-node aware)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceRedis.del.mockResolvedValue(1);
    mockVoiceRedis.sMembers.mockResolvedValue([]);
    mockVoiceRedis.get.mockResolvedValue(null);
    mockVoiceRedis.hGetAll.mockResolvedValue({});
    vi.mocked(redisIsNodeAlive).mockResolvedValue(false);
    // eslint-disable-next-line require-yield
    mockVoiceRedis.scanIterator.mockImplementation(async function* () { /* no keys */ });
  });

  it('reaps OWN channels but never touches a live peer node\'s mirror or persistent moderation keys', async () => {
    mockVoiceRedis.sMembers.mockResolvedValue(['ch-own', 'ch-peer']);
    mockVoiceRedis.get.mockImplementation((key: string) => {
      if (key === 'voice:channel:node:ch-own') return Promise.resolve('test-node-1');
      if (key === 'voice:channel:node:ch-peer') return Promise.resolve('peer-node');
      return Promise.resolve(null);
    });
    vi.mocked(redisIsNodeAlive).mockImplementation(async (nodeId: string) => nodeId === 'peer-node');
    mockVoiceRedis.hGetAll.mockImplementation((key: string) =>
      Promise.resolve(key === 'voice:channel:users:ch-own' ? { 'u-1': '{}' } : {}));

    await clearVoiceState();

    const chain = mockVoiceRedis.multi();
    // Own channel reaped, including the participant's reverse-lookup key
    expect(chain.del).toHaveBeenCalledWith('voice:channel:users:ch-own');
    expect(chain.del).toHaveBeenCalledWith('voice:screen:ch-own');
    expect(chain.del).toHaveBeenCalledWith('voice:user:u-1');
    expect(chain.sRem).toHaveBeenCalledWith('voice:active', 'ch-own');
    // Live peer's channel untouched
    expect(chain.del).not.toHaveBeenCalledWith('voice:channel:users:ch-peer');
    expect(chain.sRem).not.toHaveBeenCalledWith('voice:active', 'ch-peer');
    // Persistent moderation keys never deleted
    const allDeleted = [...chain.del.mock.calls, ...mockVoiceRedis.del.mock.calls].flat();
    expect(allDeleted.some((k) => String(k).includes('voice:server_muted') || String(k).includes('voice:server_deafened'))).toBe(false);
  });

  it('reaps channels owned by DEAD nodes and emits voice:user_left for each ghost', async () => {
    mockVoiceRedis.sMembers.mockResolvedValue(['ch-dead']);
    mockVoiceRedis.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'voice:channel:node:ch-dead' ? 'gone-node' : null));
    vi.mocked(redisIsNodeAlive).mockResolvedValue(false);
    mockVoiceRedis.hGetAll.mockImplementation((key: string) =>
      Promise.resolve(key === 'voice:channel:users:ch-dead' ? { 'u-9': '{}' } : {}));

    const io = createMockIO();
    await clearVoiceState(io as any);

    const chain = mockVoiceRedis.multi();
    expect(chain.del).toHaveBeenCalledWith('voice:channel:users:ch-dead');
    expect(io.to).toHaveBeenCalledWith('channel:ch-dead');
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-dead', userId: 'u-9' });
  });

  it('reaps orphaned voice:user keys pointing at channels no longer active', async () => {
    mockVoiceRedis.scanIterator.mockImplementation(async function* (opts: { MATCH?: string }) {
      if (opts?.MATCH === 'voice:user:*') yield ['voice:user:u-orphan'];
    });
    mockVoiceRedis.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'voice:user:u-orphan' ? 'ch-gone' : null));

    await clearVoiceState();

    expect(mockVoiceRedis.del).toHaveBeenCalledWith('voice:user:u-orphan');
  });

  it('preserves a voice:user key referencing a LIVE peer\'s channel created during our boot (TOCTOU guard)', async () => {
    mockVoiceRedis.scanIterator.mockImplementation(async function* (opts: { MATCH?: string }) {
      if (opts?.MATCH === 'voice:user:*') yield ['voice:user:u-fresh'];
    });
    mockVoiceRedis.get.mockImplementation((key: string) => {
      if (key === 'voice:user:u-fresh') return Promise.resolve('ch-fresh'); // not in our activeSet snapshot
      if (key === 'voice:channel:node:ch-fresh') return Promise.resolve('peer-node');
      return Promise.resolve(null);
    });
    vi.mocked(redisIsNodeAlive).mockImplementation(async (nodeId: string) => nodeId === 'peer-node');

    await clearVoiceState();

    expect(mockVoiceRedis.del).not.toHaveBeenCalledWith('voice:user:u-fresh');
  });

  it('is a no-op when there is nothing stale', async () => {
    await clearVoiceState();
    expect(mockVoiceRedis.del).not.toHaveBeenCalled();
    const chain = mockVoiceRedis.multi();
    expect(chain.exec).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — handler registration', () => {
  it('registers all 19 expected event handlers', () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);

    const expectedEvents = [
      'voice:join',
      'voice:leave',
      'voice:transport:connect',
      'voice:produce',
      'voice:producer:close',
      'voice:rtp_capabilities',
      'voice:consumer:resume',
      'voice:mute',
      'voice:deaf',
      'voice:speaking',
      'voice:server_mute',
      'voice:server_deafen',
      'voice:force_move',
      'voice:signal',
      'voice:e2e:key',
      'voice:e2e:key_request',
      'voice:screen_share:start',
      'voice:screen_share:stop',
      'disconnecting',
    ];

    expect(expectedEvents.length).toBe(19);
    expect(handlers.size).toBe(19);

    for (const event of expectedEvents) {
      expect(handlers.has(event)).toBe(true);
    }
  });
});

// ─── voice:server_mute ──────────────────────────────────────────────────────

describe('voiceHandler — voice:server_mute', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:server_mute')!;
    handler({ userId: 'user-2', muted: true });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects non-object payload', () => {
    const handler = handlers.get('voice:server_mute')!;
    handler('invalid');
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects payload with wrong types', () => {
    const handler = handlers.get('voice:server_mute')!;
    handler({ userId: 123, muted: 'yes' });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when actor not in a voice channel', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:server_mute')!;
    handler({ userId: 'user-2', muted: true });
    expect(io.to).not.toHaveBeenCalled();
  });
});

// ─── voice:server_deafen ────────────────────────────────────────────────────

describe('voiceHandler — voice:server_deafen', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:server_deafen')!;
    handler({ userId: 'user-2', deafened: true });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects non-object payload', () => {
    const handler = handlers.get('voice:server_deafen')!;
    handler(null);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects payload with wrong types', () => {
    const handler = handlers.get('voice:server_deafen')!;
    handler({ userId: 'user-2', deafened: 'true' });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when actor not in a voice channel', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:server_deafen')!;
    handler({ userId: 'user-2', deafened: true });
    expect(io.to).not.toHaveBeenCalled();
  });
});

// ─── voice:force_move ───────────────────────────────────────────────────────

describe('voiceHandler — voice:force_move', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('voice:force_move')!;
    handler({ userId: 'user-2', targetChannelId: 'ch-2' });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects non-object payload', () => {
    const handler = handlers.get('voice:force_move')!;
    handler(42);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects payload with wrong types', () => {
    const handler = handlers.get('voice:force_move')!;
    handler({ userId: 123, targetChannelId: true });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('does NOT require actor to be in a voice channel (cross-channel move)', async () => {
    // Actor is NOT in any voice channel
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:force_move')!;
    // The handler should still proceed (not return early) and emit voice:error
    // because the target user is not in any voice channel (voiceChannelUsers is empty)
    await handler({ userId: 'user-2', targetChannelId: 'ch-2' });
    // It should emit voice:error "User is not in a voice channel." for the target,
    // NOT silently return like mute/deaf do for actor-not-in-channel
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'User is not in a voice channel.' });
  });

  it('emits error when target user is not in any voice channel', async () => {
    // Actor can be in any state — force_move searches all channels for target
    socket.data.voiceChannelId = 'ch-1';
    const handler = handlers.get('voice:force_move')!;
    await handler({ userId: 'user-99', targetChannelId: 'ch-2' });
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'User is not in a voice channel.' });
  });
});

// ─── deafen-implies-mute ────────────────────────────────────────────────────

describe('voiceHandler — deafen-implies-mute (voice:deaf)', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when not in a voice channel (no crash)', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:deaf')!;
    handler(true);
    // Should not throw or emit
    expect(io.to).not.toHaveBeenCalled();
  });
});

// ─── server-muted blocks unmute ─────────────────────────────────────────────

describe('voiceHandler — server-muted blocks self-unmute (voice:mute)', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
  });

  it('returns early when not in a voice channel', () => {
    socket.data.voiceChannelId = undefined;
    const handler = handlers.get('voice:mute')!;
    // Trying to unmute
    handler(false);
    expect(io.to).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P1 regression tests — screen share protocol (HIGH-1), SPEAK bypass (HIGH-4),
// private-channel broadcasts (HIGH-8), server-deafen enforcement (HIGH-12)
// ═══════════════════════════════════════════════════════════════════════════

import { hasChannelPermission } from '../../utils/permissionCalculator';
import { createWebRtcTransport } from '../../mediasoup/mediasoupManager';
import { isNodeAlive as redisIsNodeAlive, socketExistsInCluster as redisSocketExists } from '../../utils/redis';

/** All transports created since the last vi.clearAllMocks(), in creation order:
 *  [A.send, A.recv, B.send, B.recv, ...] per join. */
async function getCreatedTransports() {
  return Promise.all(vi.mocked(createWebRtcTransport).mock.results.map((r) => r.value));
}

function mockJoinablePrisma() {
  vi.mocked(prisma.channel.findUnique).mockResolvedValue({ serverId: 's1', type: 'voice' } as any);
  vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({ userId: 'x', serverId: 's1' } as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'x', username: 'u', displayName: 'U', avatarUrl: null } as any);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as any);
}

describe('voiceHandler — voice:produce ACK contract (HIGH-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
  });

  it('acks an error when rate limited (never silent)', async () => {
    const { socket, handlers } = createMockSocket('prod-rl', 'sock-prod-rl');
    handleVoiceEvents(createMockIO() as any, socket as any);
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const ack = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack);
    expect(ack).toHaveBeenCalledWith({ error: 'Rate limited' });
  });

  it('acks an error on invalid parameters', async () => {
    const { socket, handlers } = createMockSocket('prod-inv', 'sock-prod-inv');
    handleVoiceEvents(createMockIO() as any, socket as any);
    const ack = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'weird', rtpParameters: {} }, ack);
    expect(ack).toHaveBeenCalledWith({ error: 'Invalid parameters' });
  });

  it('acks an error when not in a voice channel', async () => {
    const { socket, handlers } = createMockSocket('prod-noch', 'sock-prod-noch');
    handleVoiceEvents(createMockIO() as any, socket as any);
    const ack = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack);
    expect(ack).toHaveBeenCalledWith({ error: 'Not in a voice channel' });
  });

  it('acks the producerId on a successful mic produce', async () => {
    const { socket, handlers } = createMockSocket('prod-ok', 'sock-prod-ok');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-prod-ok');
    const ack = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack);
    expect(ack).toHaveBeenCalledWith({ producerId: expect.stringMatching(/^producer-/) });
  });

  it('acks an error (does NOT hang) when video is produced without an active screen share', async () => {
    const { socket, handlers } = createMockSocket('prod-vid', 'sock-prod-vid');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-prod-vid');
    const ack = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, ack);
    expect(ack).toHaveBeenCalledWith({ error: 'Not the active screen sharer' });
  });

  it('replaces an existing producer of the same type instead of leaking it', async () => {
    const { socket, handlers } = createMockSocket('prod-dup', 'sock-prod-dup');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-prod-dup');

    const ack1 = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack1);
    const ack2 = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack2);

    expect(ack2).toHaveBeenCalledWith({ producerId: expect.stringMatching(/^producer-/) });
    // The first mic producer was closed when the second replaced it
    const [sendTransport] = await getCreatedTransports();
    const firstProducer = await sendTransport.produce.mock.results[0].value;
    expect(firstProducer.close).toHaveBeenCalled();
  });

  it('pauses the mic producer at produce time when self-muted, but NOT screen audio', async () => {
    const { socket, handlers } = createMockSocket('prod-mute', 'sock-prod-mute');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-prod-mute', { selfMute: true, selfDeaf: false });

    // Mic while muted → paused immediately
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, vi.fn());
    const [sendTransport] = await getCreatedTransports();
    const micProducer = await sendTransport.produce.mock.results[0].value;
    expect(micProducer.pause).toHaveBeenCalled();

    // Claim the sharer slot, then produce screen audio → NOT paused despite mute
    handlers.get('voice:screen_share:start')!(vi.fn());
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } },
      vi.fn(),
    );
    const screenAudioProducer = await sendTransport.produce.mock.results[1].value;
    expect(screenAudioProducer.appData).toEqual({ type: 'screen-audio', userId: 'prod-mute' });
    expect(screenAudioProducer.pause).not.toHaveBeenCalled();
  });
});

describe('voiceHandler — SPEAK bypass via client appData (HIGH-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  it('treats claimed screen-audio from a NON-sharer as mic audio and enforces SPEAK', async () => {
    const { socket, handlers } = createMockSocket('bypass-1', 'sock-bypass-1');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-bypass-1'); // CONNECT check consumes one allow

    // Deny SPEAK for the produce
    vi.mocked(hasChannelPermission).mockResolvedValueOnce(false);
    const ack = vi.fn();
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } },
      ack,
    );
    expect(ack).toHaveBeenCalledWith({ error: 'You do not have permission to speak in this channel' });
  });

  it('stores server-derived appData — a non-sharer mic claim is forced to type "audio"', async () => {
    const { socket, handlers } = createMockSocket('bypass-2', 'sock-bypass-2');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-bypass-2');

    const ack = vi.fn();
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio', evil: 'field' } },
      ack,
    );
    expect(ack).toHaveBeenCalledWith({ producerId: expect.any(String) });
    const [sendTransport] = await getCreatedTransports();
    // Forced to 'audio' (silence-pausing + mute apply), client fields dropped
    expect(sendTransport.produce).toHaveBeenCalledWith(
      expect.objectContaining({ appData: { type: 'audio', userId: 'bypass-2' } }),
    );
  });

  it('allows screen audio WITHOUT a SPEAK check for the active sharer', async () => {
    const { socket, handlers } = createMockSocket('bypass-3', 'sock-bypass-3');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-bypass-3');
    handlers.get('voice:screen_share:start')!(vi.fn());

    // From here on, ANY permission check would fail — screen audio must not need one
    vi.mocked(hasChannelPermission).mockResolvedValue(false);
    const ack = vi.fn();
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } },
      ack,
    );
    expect(ack).toHaveBeenCalledWith({ producerId: expect.any(String) });
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });
});

describe('voiceHandler — screen share slot protocol (HIGH-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
  });

  it('start acks ok:true and broadcasts to the channel visibility room', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('ss-1', 'sock-ss-1');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-ss-1');

    const ack = vi.fn();
    handlers.get('voice:screen_share:start')!(ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(io.to).toHaveBeenCalledWith('channel:ch-ss-1');
    expect(io._emit).toHaveBeenCalledWith('voice:screen_share:start', { channelId: 'ch-ss-1', userId: 'ss-1' });
  });

  it('start acks ok:false when someone else is already sharing', async () => {
    const io = createMockIO();
    const a = createMockSocket('ss-2a', 'sock-ss-2a');
    const b = createMockSocket('ss-2b', 'sock-ss-2b');
    handleVoiceEvents(io as any, a.socket as any);
    handleVoiceEvents(io as any, b.socket as any);
    a.socket.data.voiceChannelId = 'ch-ss-2';
    b.socket.data.voiceChannelId = 'ch-ss-2';

    a.handlers.get('voice:screen_share:start')!(vi.fn());
    const ackB = vi.fn();
    b.handlers.get('voice:screen_share:start')!(ackB);
    expect(ackB).toHaveBeenCalledWith({ ok: false, error: 'Someone else is already sharing in this channel' });
  });

  it('re-claim by the same user is idempotent (retry after failed produce)', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('ss-3', 'sock-ss-3');
    handleVoiceEvents(io as any, socket as any);
    socket.data.voiceChannelId = 'ch-ss-3';

    handlers.get('voice:screen_share:start')!(vi.fn());
    const ack2 = vi.fn();
    handlers.get('voice:screen_share:start')!(ack2);
    expect(ack2).toHaveBeenCalledWith({ ok: true });
  });

  it('start acks ok:false when not in a voice channel', () => {
    const { socket, handlers } = createMockSocket('ss-4', 'sock-ss-4');
    handleVoiceEvents(createMockIO() as any, socket as any);
    const ack = vi.fn();
    handlers.get('voice:screen_share:start')!(ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Not in a voice channel' });
  });

  it('stop closes the sharer\'s screen producers server-side but leaves the mic producer', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('ss-5', 'sock-ss-5');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-ss-5');

    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, vi.fn());
    handlers.get('voice:screen_share:start')!(vi.fn());
    await handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, vi.fn());
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } }, vi.fn(),
    );

    const [sendTransport] = await getCreatedTransports();
    const mic = await sendTransport.produce.mock.results[0].value;
    const screenVideo = await sendTransport.produce.mock.results[1].value;
    const screenAudio = await sendTransport.produce.mock.results[2].value;

    handlers.get('voice:screen_share:stop')!();

    expect(screenVideo.close).toHaveBeenCalled();
    expect(screenAudio.close).toHaveBeenCalled();
    expect(mic.close).not.toHaveBeenCalled();
    expect(io._emit).toHaveBeenCalledWith('voice:screen_share:stop', { channelId: 'ch-ss-5', userId: 'ss-5' });
  });

  it('the SECOND screen share of a session works (share → stop → share)', async () => {
    const { socket, handlers } = createMockSocket('ss-6', 'sock-ss-6');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-ss-6');

    // First share: mic + screen video + screen audio (3 producers)
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, vi.fn());
    handlers.get('voice:screen_share:start')!(vi.fn());
    await handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, vi.fn());
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } }, vi.fn(),
    );
    handlers.get('voice:screen_share:stop')!();

    // Second share: previously hit the producer cap and never acked → client hang
    const startAck = vi.fn();
    handlers.get('voice:screen_share:start')!(startAck);
    expect(startAck).toHaveBeenCalledWith({ ok: true });

    const videoAck = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, videoAck);
    expect(videoAck).toHaveBeenCalledWith({ producerId: expect.any(String) });

    const audioAck = vi.fn();
    await handlers.get('voice:produce')!(
      { kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } }, audioAck,
    );
    expect(audioAck).toHaveBeenCalledWith({ producerId: expect.any(String) });
  });

  it('voice:producer:close closes only the named producer', async () => {
    const { socket, handlers } = createMockSocket('ss-7', 'sock-ss-7');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-ss-7');

    const micAck = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, micAck);
    handlers.get('voice:screen_share:start')!(vi.fn());
    const vidAck = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, vidAck);

    const videoProducerId = vidAck.mock.calls[0][0].producerId;
    handlers.get('voice:producer:close')!({ producerId: videoProducerId });

    const [sendTransport] = await getCreatedTransports();
    const mic = await sendTransport.produce.mock.results[0].value;
    const video = await sendTransport.produce.mock.results[1].value;
    expect(video.close).toHaveBeenCalled();
    expect(mic.close).not.toHaveBeenCalled();
  });

  it('voice:producer:close ignores producers not owned by this user session', async () => {
    const { socket, handlers } = createMockSocket('ss-8', 'sock-ss-8');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-ss-8');
    // Unknown producer id — must be a silent no-op, no crash
    expect(() => handlers.get('voice:producer:close')!({ producerId: 'not-mine' })).not.toThrow();
  });
});

describe('voiceHandler — screen-share annotation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
  });

  it('share start AND stop both delete the annotation scene key (fresh share ⇒ fresh scene)', async () => {
    const { socket, handlers } = createMockSocket('ann-1', 'sock-ann-1');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-ann-1');

    handlers.get('voice:screen_share:start')!(vi.fn());
    expect(mockVoiceRedis.del).toHaveBeenCalledWith('voice:annotations:ch-ann-1');

    mockVoiceRedis.del.mockClear();
    handlers.get('voice:screen_share:stop')!();
    expect(mockVoiceRedis.del).toHaveBeenCalledWith('voice:annotations:ch-ann-1');
  });

  it('an idempotent SAME-USER re-claim preserves the annotation scene (rev-desync guard)', async () => {
    const { socket, handlers } = createMockSocket('ann-6', 'sock-ann-6');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-ann-6');

    handlers.get('voice:screen_share:start')!(vi.fn()); // fresh claim — wipes
    mockVoiceRedis.del.mockClear();

    // Retry after a failed produce (documented idempotent path) — the
    // in-progress scene and its rev counter MUST survive
    const ack = vi.fn();
    handlers.get('voice:screen_share:start')!(ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(mockVoiceRedis.del).not.toHaveBeenCalledWith('voice:annotations:ch-ann-6');
  });

  it('the sharer leaving voice deletes the annotation scene key', async () => {
    const { socket, handlers } = createMockSocket('ann-2', 'sock-ann-2');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-ann-2');
    handlers.get('voice:screen_share:start')!(vi.fn());

    mockVoiceRedis.del.mockClear();
    await handlers.get('voice:leave')!();
    expect(mockVoiceRedis.del).toHaveBeenCalledWith('voice:annotations:ch-ann-2');
  });

  it('voice:join hydrates a late joiner with the stored annotation scene', async () => {
    const io = createMockIO();
    const a = createMockSocket('ann-3a', 'sock-ann-3a');
    handleVoiceEvents(io as any, a.socket as any);
    await a.handlers.get('voice:join')!('ch-ann-3');
    a.handlers.get('voice:screen_share:start')!(vi.fn());

    const scene = { objects: [{ id: 's1', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] }] };
    mockVoiceRedis.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'voice:annotations:ch-ann-3'
        ? JSON.stringify({ rev: 7, sharerUserId: 'ann-3a', scene })
        : null),
    );

    const b = createMockSocket('ann-3b', 'sock-ann-3b');
    handleVoiceEvents(io as any, b.socket as any);
    await b.handlers.get('voice:join')!('ch-ann-3');

    expect(b.socket.emit).toHaveBeenCalledWith('voice:screen_share:state', { channelId: 'ch-ann-3', sharingUserId: 'ann-3a' });
    expect(b.socket.emit).toHaveBeenCalledWith('voice:annotation:state', {
      channelId: 'ch-ann-3', sharingUserId: 'ann-3a', rev: 7, scene,
    });
  });

  it('voice:join does NOT hydrate a stale scene attributed to a DIFFERENT sharer (handoff race)', async () => {
    const io = createMockIO();
    const a = createMockSocket('ann-7a', 'sock-ann-7a');
    handleVoiceEvents(io as any, a.socket as any);
    await a.handlers.get('voice:join')!('ch-ann-7');
    a.handlers.get('voice:screen_share:start')!(vi.fn());

    // Previous sharer's scene still in Redis (fire-and-forget DEL not landed)
    mockVoiceRedis.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'voice:annotations:ch-ann-7'
        ? JSON.stringify({ rev: 9, sharerUserId: 'previous-sharer', scene: { objects: [] } })
        : null),
    );

    const b = createMockSocket('ann-7b', 'sock-ann-7b');
    handleVoiceEvents(io as any, b.socket as any);
    await b.handlers.get('voice:join')!('ch-ann-7');

    const annotationEmits = b.socket.emit.mock.calls.filter(([event]) => event === 'voice:annotation:state');
    expect(annotationEmits).toHaveLength(0);
  });

  it('voice:join does NOT emit annotation state when no scene is stored', async () => {
    const io = createMockIO();
    const a = createMockSocket('ann-4a', 'sock-ann-4a');
    handleVoiceEvents(io as any, a.socket as any);
    await a.handlers.get('voice:join')!('ch-ann-4');
    a.handlers.get('voice:screen_share:start')!(vi.fn());

    const b = createMockSocket('ann-4b', 'sock-ann-4b');
    handleVoiceEvents(io as any, b.socket as any);
    await b.handlers.get('voice:join')!('ch-ann-4');

    const annotationEmits = b.socket.emit.mock.calls.filter(([event]) => event === 'voice:annotation:state');
    expect(annotationEmits).toHaveLength(0);
  });

  it('cleanupServerVoice deletes the annotation scene key for every reaped channel', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('ann-5', 'sock-ann-5');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-ann-5');

    mockVoiceRedis.del.mockClear();
    cleanupServerVoice(io as any, 's1');
    expect(mockVoiceRedis.del).toHaveBeenCalledWith('voice:annotations:ch-ann-5');
  });
});

describe('voiceHandler — private channel broadcasts (HIGH-8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  it('voice:user_joined broadcasts to the channel room, NOT the server room', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('h8-1', 'sock-h8-1');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-h8-1');

    expect(io.to).toHaveBeenCalledWith('channel:ch-h8-1');
    expect(io.to).not.toHaveBeenCalledWith('server:s1');
    expect(io._emit).toHaveBeenCalledWith('voice:user_joined', expect.objectContaining({ channelId: 'ch-h8-1' }));
  });

  it('the joining socket enters the channel visibility room', async () => {
    const { socket, handlers } = createMockSocket('h8-2', 'sock-h8-2');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-h8-2');
    expect(socket.join).toHaveBeenCalledWith('voice:ch-h8-2');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-h8-2');
  });

  it('voice:speaking broadcasts to the channel room, NOT the server room', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('h8-3', 'sock-h8-3');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-h8-3');
    io.to.mockClear();
    io._emit.mockClear();

    handlers.get('voice:speaking')!(true);
    expect(io.to).toHaveBeenCalledWith('channel:ch-h8-3');
    expect(io.to).not.toHaveBeenCalledWith('server:s1');
    expect(io._emit).toHaveBeenCalledWith('voice:speaking', { channelId: 'ch-h8-3', userId: 'h8-3', speaking: true });
  });

  it('voice:user_left broadcasts to the channel room on leave', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('h8-4', 'sock-h8-4');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-h8-4');
    io.to.mockClear();
    io._emit.mockClear();

    handlers.get('voice:leave')!();
    expect(io.to).toHaveBeenCalledWith('channel:ch-h8-4');
    expect(io.to).not.toHaveBeenCalledWith('server:s1');
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-h8-4', userId: 'h8-4' });
  });

  it('a CONNECT-without-VIEW participant is removed from the visibility room on leave', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('h8-5', 'sock-h8-5');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-h8-5'); // CONNECT allowed (default mock)

    // The post-leave VIEW re-check denies — socket must leave the channel room
    vi.mocked(hasChannelPermission).mockResolvedValueOnce(false);
    handlers.get('voice:leave')!();
    await new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget check

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-h8-5');
  });

  it('a VIEW-permitted member KEEPS the visibility room subscription after leaving voice', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('h8-6', 'sock-h8-6');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-h8-6');

    handlers.get('voice:leave')!(); // VIEW re-check passes (default mock: true)
    await new Promise((r) => setTimeout(r, 0));

    expect(socket.leave).toHaveBeenCalledWith('voice:ch-h8-6');
    expect(socket.leave).not.toHaveBeenCalledWith('channel:ch-h8-6');
  });
});

describe('voiceHandler — server-deafen enforcement (HIGH-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  async function setupTwoUsersWithConsumer() {
    const io = createMockIO();
    const a = createMockSocket('h12-A', 'sock-h12-A');
    const b = createMockSocket('h12-B', 'sock-h12-B');
    io.sockets.sockets.set('sock-h12-A', a.socket);
    io.sockets.sockets.set('sock-h12-B', b.socket);
    handleVoiceEvents(io as any, a.socket as any);
    handleVoiceEvents(io as any, b.socket as any);

    await a.handlers.get('voice:join')!('ch-h12');
    await b.handlers.get('voice:join')!('ch-h12');
    await b.handlers.get('voice:rtp_capabilities')!({ rtpCapabilities: { codecs: [] } });
    // A produces mic → server creates an audio consumer for B, announced via
    // io.to(B's socketId) (cross-node-safe emit)
    await a.handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, vi.fn());

    expect(io.to).toHaveBeenCalledWith('sock-h12-B');
    const newConsumerCall = io._emit.mock.calls.find((c: unknown[]) => c[0] === 'voice:new_consumer');
    expect(newConsumerCall).toBeTruthy();
    const consumerId = (newConsumerCall![1] as { id: string }).id;

    const transports = await getCreatedTransports();
    const bRecv = transports[3]; // A.send, A.recv, B.send, B.recv
    const consumer = await bRecv.consume.mock.results[0].value;

    return { io, a, b, consumerId, consumer };
  }

  it('pauses the target\'s audio consumers server-side and blocks their resume while deafened', async () => {
    const { a, b, consumerId, consumer } = await setupTwoUsersWithConsumer();

    // A (moderator) server-deafens B
    await a.handlers.get('voice:server_deafen')!({ userId: 'h12-B', deafened: true });
    expect(consumer.pause).toHaveBeenCalled();

    // A modified client trying to resume its consumer is blocked server-side
    consumer.resume.mockClear();
    await b.handlers.get('voice:consumer:resume')!({ consumerId });
    expect(consumer.resume).not.toHaveBeenCalled();
  });

  it('resumes the target\'s audio consumers on un-deafen', async () => {
    const { a, consumer } = await setupTwoUsersWithConsumer();

    await a.handlers.get('voice:server_deafen')!({ userId: 'h12-B', deafened: true });
    consumer.resume.mockClear();
    await a.handlers.get('voice:server_deafen')!({ userId: 'h12-B', deafened: false });
    expect(consumer.resume).toHaveBeenCalled();
  });

  it('normal consumer:resume works when not deafened', async () => {
    const { b, consumerId, consumer } = await setupTwoUsersWithConsumer();
    consumer.resume.mockClear();
    await b.handlers.get('voice:consumer:resume')!({ consumerId });
    expect(consumer.resume).toHaveBeenCalled();
  });
});

describe('voiceHandler — multi-node routing (HIGH-15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
    mockRelay.getRemoteSession.mockReturnValue(undefined);
    mockRelay.resolveOrClaimChannelOwner.mockResolvedValue('test-node-1');
  });

  it('voice:join executes locally when this node owns (or claims) the channel', async () => {
    const { socket, handlers } = createMockSocket('mn-1', 'sock-mn-1');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-mn-1');

    expect(mockRelay.relayVoiceEvent).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalledWith('voice:ch-mn-1'); // local join ran
  });

  it('voice:join relays to a remote owner and records the remote session (no local mediasoup work)', async () => {
    mockRelay.resolveOrClaimChannelOwner.mockResolvedValue('peer-node');
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ serverId: 's1', type: 'voice', secure: false } as any);
    const { socket, handlers } = createMockSocket('mn-2', 'sock-mn-2');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-mn-2', { selfMute: true, selfDeaf: false });

    expect(mockRelay.setRemoteSession).toHaveBeenCalledWith('sock-mn-2', {
      userId: 'mn-2', channelId: 'ch-mn-2', ownerNodeId: 'peer-node',
    });
    expect(mockRelay.relayVoiceEvent).toHaveBeenCalledWith(
      'peer-node', 'voice:join', socket, ['ch-mn-2', { selfMute: true, selfDeaf: false }],
      expect.any(Function), // internal relay ACK — guards against a dead owner
    );
    // The wrapper reads the channel ONCE, to decide whether opacity applies —
    // a secure channel has to be authorized before the owner claim and the
    // force-leave, or those side effects become the oracle themselves. For a
    // plaintext channel it does no membership work: the OWNER validates.
    expect(prisma.channel.findUnique).toHaveBeenCalledTimes(1);
    expect(hasChannelPermission).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalledWith('voice:ch-mn-2');
  });

  it('a failed/timed-out relayed join surfaces voice:error and clears the session (no silent hang)', async () => {
    mockRelay.resolveOrClaimChannelOwner.mockResolvedValue('peer-node');
    const { socket, handlers } = createMockSocket('mn-2b', 'sock-mn-2b');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-mn-2b');

    const joinAck = mockRelay.relayVoiceEvent.mock.calls[0][4] as (r: unknown) => void;
    mockRelay.getRemoteSession.mockReturnValue({ userId: 'mn-2b', channelId: 'ch-mn-2b', ownerNodeId: 'peer-node' });
    joinAck({ error: 'Voice node timeout' });

    expect(mockRelay.clearRemoteSession).toHaveBeenCalledWith('sock-mn-2b');
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'Voice server unavailable. Please try again later.' });
  });

  it('a successful relayed join ACK leaves the session intact', async () => {
    mockRelay.resolveOrClaimChannelOwner.mockResolvedValue('peer-node');
    const { socket, handlers } = createMockSocket('mn-2c', 'sock-mn-2c');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('ch-mn-2c');

    const joinAck = mockRelay.relayVoiceEvent.mock.calls[0][4] as (r: unknown) => void;
    joinAck({ ok: true });

    expect(mockRelay.clearRemoteSession).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:error', expect.anything());
  });

  it('session-routed events relay to the owner when the session is remote', async () => {
    mockRelay.getRemoteSession.mockReturnValue({ userId: 'mn-3', channelId: 'ch-r', ownerNodeId: 'peer-node' });
    const { socket, handlers } = createMockSocket('mn-3', 'sock-mn-3');
    handleVoiceEvents(createMockIO() as any, socket as any);

    handlers.get('voice:mute')!(true);

    expect(mockRelay.relayVoiceEvent).toHaveBeenCalledWith('peer-node', 'voice:mute', socket, [true], undefined);
  });

  it('forwards the client ACK callback for ack-carrying events', async () => {
    mockRelay.getRemoteSession.mockReturnValue({ userId: 'mn-4', channelId: 'ch-r', ownerNodeId: 'peer-node' });
    const { socket, handlers } = createMockSocket('mn-4', 'sock-mn-4');
    handleVoiceEvents(createMockIO() as any, socket as any);

    const ack = vi.fn();
    handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack);

    expect(mockRelay.relayVoiceEvent).toHaveBeenCalledWith(
      'peer-node', 'voice:produce', socket, [{ kind: 'audio', rtpParameters: {} }], ack,
    );
  });

  it('a LOCAL session always runs in place even if a stale remote session record exists', async () => {
    mockRelay.getRemoteSession.mockReturnValue({ userId: 'mn-5', channelId: 'ch-r', ownerNodeId: 'peer-node' });
    const { socket, handlers } = createMockSocket('mn-5', 'sock-mn-5');
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);
    socket.data.voiceChannelId = 'ch-local';

    handlers.get('voice:mute')!(true);

    expect(mockRelay.relayVoiceEvent).not.toHaveBeenCalled();
  });

  it('disconnecting relays the disconnect to the owner instead of tearing down locally', async () => {
    mockRelay.getRemoteSession.mockReturnValue({ userId: 'mn-6', channelId: 'ch-r', ownerNodeId: 'peer-node' });
    const { socket, handlers } = createMockSocket('mn-6', 'sock-mn-6');
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);

    handlers.get('disconnecting')!();

    expect(mockRelay.relayVoiceEvent).toHaveBeenCalledWith('peer-node', 'disconnecting', socket, []);
    expect(mockRelay.clearRemoteSession).toHaveBeenCalledWith('sock-mn-6');
    expect(io._emit).not.toHaveBeenCalledWith('voice:user_left', expect.anything());
  });

  it('voice:force_move relays to the node owning the TARGET\'s channel', async () => {
    mockVoiceRedis.get.mockImplementation((key: string) => {
      if (key === 'voice:user:target-x') return Promise.resolve('ch-t');
      if (key === 'voice:channel:node:ch-t') return Promise.resolve('peer-node');
      return Promise.resolve(null);
    });
    const { socket, handlers } = createMockSocket('mn-7', 'sock-mn-7');
    handleVoiceEvents(createMockIO() as any, socket as any);

    await handlers.get('voice:force_move')!({ userId: 'target-x', targetChannelId: 'ch-dest' });

    expect(mockRelay.relayVoiceEvent).toHaveBeenCalledWith(
      'peer-node', 'voice:force_move', socket, [{ userId: 'target-x', targetChannelId: 'ch-dest' }],
    );
    // Local handler must NOT run (it would emit 'User is not in a voice channel.')
    expect(socket.emit).not.toHaveBeenCalledWith('voice:error', expect.anything());
    mockVoiceRedis.get.mockResolvedValue(null);
  });

  it('emits voice:error when ownership resolution fails (never a silent hang)', async () => {
    mockRelay.resolveOrClaimChannelOwner.mockRejectedValueOnce(new Error('redis down'));
    const { socket, handlers } = createMockSocket('mn-8', 'sock-mn-8');
    handleVoiceEvents(createMockIO() as any, socket as any);

    await handlers.get('voice:join')!('ch-mn-8');

    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'Voice server unavailable. Please try again later.' });
    expect(mockRelay.relayVoiceEvent).not.toHaveBeenCalled();
  });

  it('switching channels ends a previous remote session on its old owner', async () => {
    mockRelay.getRemoteSession.mockReturnValue({ userId: 'mn-9', channelId: 'ch-old', ownerNodeId: 'old-owner' });
    mockRelay.resolveOrClaimChannelOwner.mockResolvedValue('test-node-1'); // new channel is local
    const { socket, handlers } = createMockSocket('mn-9', 'sock-mn-9');
    handleVoiceEvents(createMockIO() as any, socket as any);

    await handlers.get('voice:join')!('ch-new');

    expect(mockRelay.relayVoiceEvent).toHaveBeenCalledWith('old-owner', 'voice:leave', socket, []);
    expect(mockRelay.clearRemoteSession).toHaveBeenCalledWith('sock-mn-9');
  });
});

describe('voiceHandler — dispatchVoiceEvent (owner side, HIGH-15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  it('auto-acks internal-ACK events (voice:join) on completion so the home node can detect dead owners', async () => {
    const io = createMockIO();
    const shim = {
      id: 'shim-da-1', data: { userId: 'da-1' },
      emit: vi.fn(), join: vi.fn(), leave: vi.fn(),
    };
    const ack = vi.fn();
    await dispatchVoiceEvent(io as any, shim as any, 'voice:join', ['ch-da-1', null], ack);

    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(shim.data).toMatchObject({ voiceChannelId: 'ch-da-1' }); // shim.data persisted the join
    // Clean up the session
    await dispatchVoiceEvent(io as any, shim as any, 'voice:leave', []);
  });

  it('passes client-facing ACKs INTO the handler (produce acks itself, never double-acks)', async () => {
    const io = createMockIO();
    const shim = {
      id: 'shim-da-2', data: { userId: 'da-2' },
      emit: vi.fn(), join: vi.fn(), leave: vi.fn(),
    };
    const ack = vi.fn();
    // No session on this node → the produce handler acks its own error
    await dispatchVoiceEvent(io as any, shim as any, 'voice:produce', [{ kind: 'audio', rtpParameters: {} }], ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ error: 'Not in a voice channel' });
  });
});

describe('voiceHandler — reapOrphanedRemoteParticipants (HIGH-15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
    mockRelay.getRemoteSession.mockReturnValue(undefined);
    mockRelay.resolveOrClaimChannelOwner.mockResolvedValue('test-node-1');
    vi.mocked(redisSocketExists).mockResolvedValue(false);
  });

  it('tears down sessions whose socket is gone cluster-wide', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('orph-1', 'sock-orph-1');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-orph-1');
    io._emit.mockClear();

    // Socket is neither local (not in io.sockets.sockets) nor anywhere else
    await reapOrphanedRemoteParticipants(io as any);

    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-orph-1', userId: 'orph-1' });
  });

  it('leaves locally-connected sockets untouched', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('orph-2', 'sock-orph-2');
    io.sockets.sockets.set('sock-orph-2', socket);
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-orph-2');
    io._emit.mockClear();

    await reapOrphanedRemoteParticipants(io as any);

    expect(io._emit).not.toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-orph-2', userId: 'orph-2' });
    // Clean up for other tests
    handlers.get('voice:leave')!();
  });

  it('leaves sessions whose socket exists elsewhere in the cluster untouched', async () => {
    vi.mocked(redisSocketExists).mockResolvedValue(true);
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('orph-3', 'sock-orph-3');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-orph-3');
    io._emit.mockClear();

    await reapOrphanedRemoteParticipants(io as any);

    expect(io._emit).not.toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-orph-3', userId: 'orph-3' });
    // Clean up for other tests
    socket.data.voiceChannelId = 'ch-orph-3';
    handlers.get('voice:leave')!();
  });
});

describe('voiceHandler — screen-share recv bitrate lift (HIGH-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  it('raises the viewer\'s recv-transport cap when a video consumer is created', async () => {
    const io = createMockIO();
    const a = createMockSocket('br-A', 'sock-br-A');
    const b = createMockSocket('br-B', 'sock-br-B');
    io.sockets.sockets.set('sock-br-A', a.socket);
    io.sockets.sockets.set('sock-br-B', b.socket);
    handleVoiceEvents(io as any, a.socket as any);
    handleVoiceEvents(io as any, b.socket as any);

    await a.handlers.get('voice:join')!('ch-br');
    await b.handlers.get('voice:join')!('ch-br');
    await b.handlers.get('voice:rtp_capabilities')!({ rtpCapabilities: { codecs: [] } });

    // A shares screen (video producer) → B consumes video → cap lifted
    a.handlers.get('voice:screen_share:start')!(vi.fn());
    await a.handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, vi.fn());

    const transports = await getCreatedTransports();
    const bRecv = transports[3];
    expect(bRecv.setMaxOutgoingBitrate).toHaveBeenCalledWith(4000000);
  });
});

describe('voiceHandler — ghost guard on leave during persisted-mute read (MED-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  it('a user disconnecting DURING the voice:join Redis read is not broadcast as joined', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('med6-u', 'sock-med6');
    handleVoiceEvents(io as any, socket as any);

    // Park the join on the persisted server-mute/deafen Redis read: capture the
    // resolvers so the leave can run in the gap before they resolve.
    const resolvers: Array<(v: string | null) => void> = [];
    mockVoiceRedis.get.mockImplementation((key: string) => {
      if (key.startsWith('voice:server_muted') || key.startsWith('voice:server_deafened')) {
        return new Promise<string | null>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve(null);
    });

    const joinPromise = handlers.get('voice:join')!('ch-med6');
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks up to the parked read
    expect(resolvers.length).toBe(2); // sanity: join is parked on the mute+deafen gets

    // The user leaves while the join is still awaiting Redis
    handlers.get('voice:leave')!();

    io._emit.mockClear();
    const chain = mockVoiceRedis.multi();
    chain.hSet.mockClear();

    for (const resolve of resolvers) resolve(null);
    await joinPromise;

    // The aborted join must not broadcast the ghost or mirror it to Redis
    expect(io._emit).not.toHaveBeenCalledWith('voice:user_joined', expect.anything());
    expect(chain.hSet).not.toHaveBeenCalled();

    mockVoiceRedis.get.mockResolvedValue(null);
  });
});

describe('voiceHandler — worker death eviction (MED-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    vi.mocked(hasChannelPermission).mockResolvedValue(true);
  });

  it('evicts participants, tells each socket to rejoin, and broadcasts voice:user_left', async () => {
    const io = createMockIO();
    (io as any).in = vi.fn().mockReturnValue({ socketsJoin: vi.fn(), socketsLeave: vi.fn() });
    const { socket, handlers } = createMockSocket('med7-u', 'sock-med7');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-med7');

    io.to.mockClear();
    io._emit.mockClear();

    handleWorkerDeath(io as any, ['ch-med7']);

    // The participant's socket is told to rejoin...
    expect(io.to).toHaveBeenCalledWith('sock-med7');
    expect(io._emit).toHaveBeenCalledWith('voice:error', { message: expect.stringContaining('rejoin') });
    // ...and the channel sees them leave
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-med7', userId: 'med7-u' });
  });

  it('a second handleWorkerDeath for the same channel is a no-op', async () => {
    const io = createMockIO();
    (io as any).in = vi.fn().mockReturnValue({ socketsJoin: vi.fn(), socketsLeave: vi.fn() });
    const { socket, handlers } = createMockSocket('med7-v', 'sock-med7-v');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('ch-med7-b');

    handleWorkerDeath(io as any, ['ch-med7-b']);
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-med7-b', userId: 'med7-v' });

    io._emit.mockClear();
    handleWorkerDeath(io as any, ['ch-med7-b']);
    expect(io._emit).not.toHaveBeenCalledWith('voice:user_left', expect.anything());
  });
});

// ─── Secure voice channels (spec §21) ───────────────────────────────────────

function mockJoinableSecurePrisma(serverId = 'ssec') {
  vi.mocked(prisma.channel.findUnique).mockResolvedValue({ serverId, type: 'voice', secure: true } as any);
  vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({ userId: 'x', serverId } as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'x', username: 'u', displayName: 'U', avatarUrl: null } as any);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as any);
}

const DEVICE = 'device-aaaa1111';
const EPOCH = 'epochAAAA0001';

describe('voiceHandler — secure voice channels (spec §21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJoinableSecurePrisma();
  });

  it('join stores a valid deviceId and broadcasts it on voice:user_joined', async () => {
    const { socket, handlers } = createMockSocket('sv-1', 'sock-sv-1');
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);

    await handlers.get('voice:join')!('sec-a', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    expect(io._emit).toHaveBeenCalledWith('voice:user_joined', expect.objectContaining({
      channelId: 'sec-a',
      user: expect.objectContaining({ deviceId: DEVICE }),
    }));
    // Mirrored to Redis so cross-node replays carry the routing hint too
    expect(mockVoiceRedis.multi().hSet).toHaveBeenCalledWith(
      'voice:channel:users:sec-a', 'sv-1', expect.stringContaining('"e2eDeviceId":"' + DEVICE + '"'),
    );
  });

  it('REFUSES a secure join with a malformed E2E announcement, and ignores deviceId on plaintext channels', async () => {
    const { socket, handlers } = createMockSocket('sv-2', 'sock-sv-2');
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);

    // A secure voice channel has no plaintext mode: a participant nobody can
    // key must not be admitted at all.
    await handlers.get('voice:join')!('sec-b', { selfMute: false, selfDeaf: false, deviceId: 'bad device!!', epoch: EPOCH });
    expect(io._emit.mock.calls.find((c: unknown[]) => c[0] === 'voice:user_joined')).toBeUndefined();
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'This voice channel requires end-to-end encryption support.' });

    // Same when the epoch is missing entirely (an un-updated client)
    vi.clearAllMocks();
    mockJoinableSecurePrisma();
    const { socket: s0, handlers: h0 } = createMockSocket('sv-2b', 'sock-sv-2b');
    const io0 = createMockIO();
    handleVoiceEvents(io0 as any, s0 as any);
    await h0.get('voice:join')!('sec-b2', { selfMute: false, selfDeaf: false, deviceId: DEVICE });
    expect(io0._emit.mock.calls.find((c: unknown[]) => c[0] === 'voice:user_joined')).toBeUndefined();

    // Plaintext channel: a well-formed deviceId is still not honored
    vi.clearAllMocks();
    mockJoinablePrisma();
    const { socket: s2, handlers: h2 } = createMockSocket('sv-3', 'sock-sv-3');
    const io2 = createMockIO();
    handleVoiceEvents(io2 as any, s2 as any);
    await h2.get('voice:join')!('plain-b', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });
    const joined2 = io2._emit.mock.calls.find((c: unknown[]) => c[0] === 'voice:user_joined');
    expect((joined2![1] as { user: Record<string, unknown> }).user.deviceId).toBeUndefined();
  });

  it('rejects video AND claimed screen-audio producers (audio-only v1)', async () => {
    const { socket, handlers } = createMockSocket('sv-4', 'sock-sv-4');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('sec-c', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    const ack1 = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'video', rtpParameters: {} }, ack1);
    expect(ack1).toHaveBeenCalledWith({ error: 'Screen sharing is not available in secure voice channels' });

    const ack2 = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } }, ack2);
    expect(ack2).toHaveBeenCalledWith({ error: 'Screen sharing is not available in secure voice channels' });

    // Plain mic audio still works
    const ack3 = vi.fn();
    await handlers.get('voice:produce')!({ kind: 'audio', rtpParameters: {} }, ack3);
    expect(ack3).toHaveBeenCalledWith({ producerId: expect.any(String) });
  });

  it('rejects the screen-share slot claim', async () => {
    const { socket, handlers } = createMockSocket('sv-5', 'sock-sv-5');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('sec-d', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    const cb = vi.fn();
    handlers.get('voice:screen_share:start')!(cb);
    expect(cb).toHaveBeenCalledWith({ ok: false, error: 'Screen sharing is not available in secure voice channels' });
  });

  it('force_move out of a secure channel is refused with the opacity-preserving error', async () => {
    const { socket, handlers } = createMockSocket('sv-6', 'sock-sv-6');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('sec-e', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    const { socket: actor, handlers: actorHandlers } = createMockSocket('sv-mod', 'sock-sv-mod');
    handleVoiceEvents(createMockIO() as any, actor as any);
    await actorHandlers.get('voice:force_move')!({ userId: 'sv-6', targetChannelId: 'anywhere' });

    // Same message a moderator gets for a user in NO channel — no oracle
    expect(actor.emit).toHaveBeenCalledWith('voice:error', { message: 'User is not in a voice channel.' });
  });

  it('force_move INTO a secure channel is refused like a nonexistent target', async () => {
    // Target user sits in a PLAINTEXT channel
    vi.clearAllMocks();
    mockJoinablePrisma();
    const { socket, handlers } = createMockSocket('sv-7', 'sock-sv-7');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('plain-e');

    // The move target resolves to a SECURE voice channel
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({ serverId: 's1', type: 'voice', secure: true } as any);
    const { socket: actor, handlers: actorHandlers } = createMockSocket('sv-mod2', 'sock-sv-mod2');
    handleVoiceEvents(createMockIO() as any, actor as any);
    await actorHandlers.get('voice:force_move')!({ userId: 'sv-7', targetChannelId: 'sec-target' });

    expect(actor.emit).toHaveBeenCalledWith('voice:error', { message: 'Invalid target voice channel.' });
  });

  it('voice:e2e:key relays opaque envelopes between co-participants only', async () => {
    const io = createMockIO();
    const { socket: a, handlers: ha } = createMockSocket('sv-ka', 'sock-sv-ka');
    handleVoiceEvents(io as any, a as any);
    await ha.get('voice:join')!('sec-k', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    mockJoinableSecurePrisma();
    const { socket: b, handlers: hb } = createMockSocket('sv-kb', 'sock-sv-kb');
    handleVoiceEvents(io as any, b as any);
    await hb.get('voice:join')!('sec-k', { selfMute: false, selfDeaf: false, deviceId: 'device-bbbb2222', epoch: 'epochBBBB0001' });

    io.to.mockClear();
    io._emit.mockClear();

    const envelope = '{"v":1,"e":"olm1","t":0,"b":"Zg"}';
    ha.get('voice:e2e:key')!({ to: 'sv-kb', envelope });

    expect(io.to).toHaveBeenCalledWith('sock-sv-kb');
    expect(io._emit).toHaveBeenCalledWith('voice:e2e:key', {
      channelId: 'sec-k',
      from: 'sv-ka',
      fromDeviceId: DEVICE,
      envelope,
    });

    // Gating: non-participant target, self-target, non-envelope shape,
    // oversized payload — all dropped without relay
    io._emit.mockClear();
    ha.get('voice:e2e:key')!({ to: 'stranger', envelope });
    ha.get('voice:e2e:key')!({ to: 'sv-ka', envelope });
    ha.get('voice:e2e:key')!({ to: 'sv-kb', envelope: '{"type":"plaintext"}' });
    ha.get('voice:e2e:key')!({ to: 'sv-kb', envelope: '{"v":1,"e":"olm1"' + 'x'.repeat(20000) });
    ha.get('voice:e2e:key')!({ to: 'sv-kb', envelope: 42 });
    expect(io._emit).not.toHaveBeenCalled();

    // key_request relays with the same co-presence gate
    hb.get('voice:e2e:key_request')!({ to: 'sv-ka' });
    expect(io._emit).toHaveBeenCalledWith('voice:e2e:key_request', { channelId: 'sec-k', from: 'sv-kb' });
    io._emit.mockClear();
    hb.get('voice:e2e:key_request')!({ to: 'nobody' });
    expect(io._emit).not.toHaveBeenCalled();
  });

  it('voice:e2e:key never relays from a PLAINTEXT channel', async () => {
    vi.clearAllMocks();
    mockJoinablePrisma();
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('sv-kp', 'sock-sv-kp');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('plain-k');

    io._emit.mockClear();
    handlers.get('voice:e2e:key')!({ to: 'anyone', envelope: '{"v":1,"e":"olm1","t":0,"b":"Zg"}' });
    expect(io._emit).not.toHaveBeenCalled();
  });

  it('getVoiceDiagnostics is BLIND to secure channels (admin opacity)', async () => {
    const { socket, handlers } = createMockSocket('sv-8', 'sock-sv-8');
    handleVoiceEvents(createMockIO() as any, socket as any);
    await handlers.get('voice:join')!('sec-diag', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    mockJoinablePrisma();
    const { socket: s2, handlers: h2 } = createMockSocket('sv-9', 'sock-sv-9');
    handleVoiceEvents(createMockIO() as any, s2 as any);
    await h2.get('voice:join')!('plain-diag');

    const diag = getVoiceDiagnostics();
    const ids = diag.map((d) => d.channelId);
    expect(ids).toContain('plain-diag');
    expect(ids).not.toContain('sec-diag');
  });

  it('evictUserFromChannelVoice tears down one member; cleanupChannelVoice empties the channel', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('sv-ev', 'sock-sv-ev');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('sec-ev', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    evictUserFromChannelVoice(io as any, 'sec-ev', 'sv-ev');
    expect(io.to).toHaveBeenCalledWith('sock-sv-ev');
    expect(io._emit).toHaveBeenCalledWith('voice:error', { message: 'You have been disconnected from this voice channel.' });
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'sec-ev', userId: 'sv-ev' });

    // Rejoin, then delete the whole channel
    mockJoinableSecurePrisma();
    const { socket: s2, handlers: h2 } = createMockSocket('sv-ev2', 'sock-sv-ev2');
    handleVoiceEvents(io as any, s2 as any);
    await h2.get('voice:join')!('sec-ev2', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    io._emit.mockClear();
    cleanupChannelVoice(io as any, 'sec-ev2');
    expect(io._emit).toHaveBeenCalledWith('voice:error', { message: 'This voice channel no longer exists.' });
    expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'sec-ev2', userId: 'sv-ev2' });
    // Idempotent on an already-empty channel
    cleanupChannelVoice(io as any, 'sec-ev2');
  });

  it('eviction CLEARS the evicted local socket so it cannot keep acting on the channel', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('sv-ev3', 'sock-sv-ev3');
    io.sockets.sockets.set('sock-sv-ev3', socket); // local participant
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('sec-ev3', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });
    expect(socket.data.voiceChannelId).toBe('sec-ev3');

    evictUserFromChannelVoice(io as any, 'sec-ev3', 'sv-ev3');

    // Left set, the routed-event wrapper would keep running handlers for a
    // channel this member was removed from (speaking/key_request injection).
    expect(socket.data.voiceChannelId).toBeUndefined();
  });

  it('announces the E2E epoch to peers and mirrors it (recipient-session binding)', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('sv-ep', 'sock-sv-ep');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('sec-ep', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: EPOCH });

    const joined = io._emit.mock.calls.find((c) => c[0] === 'voice:user_joined');
    expect(joined?.[1].user).toMatchObject({ deviceId: DEVICE, epoch: EPOCH });
  });

  it('strips a malformed epoch rather than relaying it', async () => {
    const io = createMockIO();
    const { socket, handlers } = createMockSocket('sv-ep2', 'sock-sv-ep2');
    handleVoiceEvents(io as any, socket as any);
    await handlers.get('voice:join')!('sec-ep2', { selfMute: false, selfDeaf: false, deviceId: DEVICE, epoch: 'no' });

    const joined = io._emit.mock.calls.find((c) => c[0] === 'voice:user_joined');
    expect(joined?.[1].user.epoch).toBeUndefined();
  });
});

// ─── §19 opacity on voice:join (F14) ────────────────────────────────────────

describe('voiceHandler — secure voice channel join is opaque to non-members', () => {
  const NOT_FOUND = { message: 'Voice channel not found.' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers a non-SERVER-member exactly like a nonexistent channel', async () => {
    const { socket, handlers } = createMockSocket('probe-1', 'sock-probe-1');
    handleVoiceEvents(createMockIO() as any, socket as any);
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ serverId: 's1', type: 'voice', secure: true } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce(null);

    await handlers.get('voice:join')!('sec-hidden');

    expect(socket.emit).toHaveBeenCalledWith('voice:error', NOT_FOUND);
  });

  it('answers a server member who is not a CHANNEL member exactly like a nonexistent channel', async () => {
    const { socket, handlers } = createMockSocket('probe-2', 'sock-probe-2');
    handleVoiceEvents(createMockIO() as any, socket as any);
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ serverId: 's1', type: 'voice', secure: true } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'probe-2', serverId: 's1' } as any);
    // computeUserChannelPermissions returns 0n for a non-ChannelMember of a
    // secure channel, ahead of the owner/ADMINISTRATOR fast paths
    vi.mocked(hasChannelPermission).mockResolvedValueOnce(false);

    await handlers.get('voice:join')!('sec-hidden');

    expect(socket.emit).toHaveBeenCalledWith('voice:error', NOT_FOUND);
    // The oracle was the message string — nothing else distinguishes the two
    expect(socket.emit).not.toHaveBeenCalledWith('voice:error', { message: 'You do not have permission to join this voice channel.' });
  });

  it('keeps the informative messages for NON-secure voice channels', async () => {
    const { socket, handlers } = createMockSocket('probe-3', 'sock-probe-3');
    handleVoiceEvents(createMockIO() as any, socket as any);
    vi.mocked(prisma.channel.findUnique)
      .mockResolvedValueOnce({ serverId: 's1', type: 'voice', secure: false } as any)
      .mockResolvedValueOnce({ serverId: 's1', type: 'voice', secure: false } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'probe-3', serverId: 's1' } as any);
    vi.mocked(hasChannelPermission).mockResolvedValueOnce(false);

    await handlers.get('voice:join')!('open-vc');

    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'You do not have permission to join this voice channel.' });
  });
});

// ─── Connect-time replay carries the E2E routing hints (F3) ─────────────────

describe('voiceHandler — getVoiceStateForServers', () => {
  /** Drive the two pipelined exec() calls: channel→server, then the user hashes. */
  function mockMirror(channelId: string, serverId: string, users: Record<string, string>) {
    mockVoiceRedis.sMembers.mockResolvedValueOnce([channelId]);
    const chain = mockVoiceRedis.multi();
    chain.exec.mockResolvedValueOnce([serverId]).mockResolvedValueOnce([users]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries e2eDeviceId/e2eEpoch through the round trip', async () => {
    // Dropping these made every occupant trip the client's "joined without an
    // E2E device/epoch" branch on reconnect, which deletes their buffered keys
    // and never re-vets them (spec §21).
    mockMirror('sec-vc', 'srv-1', {
      'u-1': JSON.stringify({
        selfMute: true, selfDeaf: false, nodeId: 'n1',
        e2eDeviceId: 'device-aaaa1111', e2eEpoch: 'epochAAAA0001',
      }),
    });

    const [state] = await getVoiceStateForServers(['srv-1']);

    expect(state.userStates.get('u-1')).toMatchObject({
      selfMute: true,
      selfDeaf: false,
      serverMuted: false,
      serverDeafened: false,
      e2eDeviceId: 'device-aaaa1111',
      e2eEpoch: 'epochAAAA0001',
    });
  });

  it('skips a malformed mirror entry instead of throwing', async () => {
    // The unguarded JSON.parse here aborted the REST of connection setup for
    // every user connecting to that server — unread counts, DM presence, the
    // status:'online' write — on one bad hash value.
    mockMirror('vc', 'srv-1', {
      'u-bad': 'not json at all',
      'u-good': JSON.stringify({ selfMute: false, selfDeaf: false }),
    });

    const [state] = await getVoiceStateForServers(['srv-1']);

    expect(state.userIds).toEqual(['u-good']);
    expect(state.userStates.has('u-bad')).toBe(false);
  });

  it('drops a channel whose entries are ALL unparseable rather than replaying an empty one', async () => {
    mockMirror('vc', 'srv-1', { 'u-bad': '{{{' });

    await expect(getVoiceStateForServers(['srv-1'])).resolves.toEqual([]);
  });
});
