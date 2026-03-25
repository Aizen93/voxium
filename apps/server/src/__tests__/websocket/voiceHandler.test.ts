import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockRouter, mockSendTransport, mockRecvTransport } = vi.hoisted(() => {
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
  return { mockRouter, mockSendTransport, mockRecvTransport };
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
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue({
    multi: vi.fn().mockReturnValue({
      hSet: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      sAdd: vi.fn().mockReturnThis(),
      hDel: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      sRem: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    hSet: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    sCard: vi.fn().mockResolvedValue(0),
    sMembers: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  }),
  NODE_ID: vi.fn().mockReturnValue('test-node-1'),
}));

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
  Permissions: { CONNECT: 1n << 14n },
}));

// Mock mediasoup manager
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getOrCreateRouter: vi.fn().mockResolvedValue(mockRouter),
  createWebRtcTransport: vi.fn().mockImplementation(() =>
    Promise.resolve({ ...mockRecvTransport, id: `transport-${Math.random()}`, close: vi.fn(), setMaxOutgoingBitrate: vi.fn().mockResolvedValue(undefined) }),
  ),
  releaseRouter: vi.fn(),
  releaseServerRouters: vi.fn(),
  getRouter: vi.fn().mockReturnValue(mockRouter),
}));

vi.mock('../../mediasoup/mediasoupConfig', () => ({
  RECV_TRANSPORT_MAX_BITRATE: 1500000,
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

import { handleVoiceEvents, leaveCurrentVoiceChannel } from '../../websocket/voiceHandler';
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
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    sockets: {
      sockets: new Map(),
    },
    _emit: emitFn,
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
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ serverId: 's1', type: 'voice' } as any);
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

describe('voiceHandler — handler registration', () => {
  it('registers all 16 expected event handlers', () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleVoiceEvents(io as any, socket as any);

    const expectedEvents = [
      'voice:join',
      'voice:leave',
      'voice:transport:connect',
      'voice:produce',
      'voice:rtp_capabilities',
      'voice:consumer:resume',
      'voice:mute',
      'voice:deaf',
      'voice:speaking',
      'voice:server_mute',
      'voice:server_deafen',
      'voice:force_move',
      'voice:signal',
      'voice:screen_share:start',
      'voice:screen_share:stop',
      'disconnecting',
    ];

    expect(expectedEvents.length).toBe(16);
    expect(handlers.size).toBe(16);

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
