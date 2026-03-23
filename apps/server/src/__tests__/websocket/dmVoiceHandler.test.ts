import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock Prisma
vi.mock('../../utils/prisma', () => ({
  prisma: {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

// Mock Redis — store per-test overrides via a mockRedis object
const mockRedis = vi.hoisted(() => {
  const multiChain = {
    hSet: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    sAdd: vi.fn().mockReturnThis(),
    hDel: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    sRem: vi.fn().mockReturnThis(),
    hLen: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    multi: vi.fn().mockReturnValue(multiChain),
    _multiChain: multiChain,
    hSet: vi.fn().mockResolvedValue(1),
    hGet: vi.fn().mockResolvedValue(null),
    hGetAll: vi.fn().mockResolvedValue({}),
    hLen: vi.fn().mockResolvedValue(0),
    hDel: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    sAdd: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    sCard: vi.fn().mockResolvedValue(0),
    sMembers: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
  NODE_ID: vi.fn().mockReturnValue('test-node-1'),
}));

// Mock rate limiter — always allow by default
vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

// Mock feature flags — dm_voice enabled by default
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Mock voiceHandler's leaveCurrentVoiceChannel (server voice mutual exclusion)
vi.mock('../../websocket/voiceHandler', () => ({
  leaveCurrentVoiceChannel: vi.fn(),
}));

import { handleDMVoiceEvents, leaveCurrentDMVoiceChannel, getActiveDMCallCount, getTotalDMVoiceUsers } from '../../websocket/dmVoiceHandler';
import { prisma } from '../../utils/prisma';
import { socketRateLimit } from '../../middleware/rateLimiter';
import { isFeatureEnabled } from '../../utils/featureFlags';
import { leaveCurrentVoiceChannel } from '../../websocket/voiceHandler';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Reset all Redis mocks to clean defaults. Must be called in every beforeEach
 *  because vi.clearAllMocks() does NOT clear mockResolvedValue/mockReturnValue. */
function resetRedis() {
  // Reset multi chain
  mockRedis._multiChain.hSet.mockReset().mockReturnThis();
  mockRedis._multiChain.set.mockReset().mockReturnThis();
  mockRedis._multiChain.sAdd.mockReset().mockReturnThis();
  mockRedis._multiChain.hDel.mockReset().mockReturnThis();
  mockRedis._multiChain.del.mockReset().mockReturnThis();
  mockRedis._multiChain.sRem.mockReset().mockReturnThis();
  mockRedis._multiChain.hLen.mockReset().mockReturnThis();
  mockRedis._multiChain.exec.mockReset().mockResolvedValue([]);
  mockRedis.multi.mockReset().mockReturnValue(mockRedis._multiChain);

  // Reset individual commands
  mockRedis.hSet.mockReset().mockResolvedValue(1);
  mockRedis.hGet.mockReset().mockResolvedValue(null);
  mockRedis.hGetAll.mockReset().mockResolvedValue({});
  mockRedis.hLen.mockReset().mockResolvedValue(0);
  mockRedis.hDel.mockReset().mockResolvedValue(1);
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.get.mockReset().mockResolvedValue(null);
  mockRedis.del.mockReset().mockResolvedValue(1);
  mockRedis.sAdd.mockReset().mockResolvedValue(1);
  mockRedis.sRem.mockReset().mockResolvedValue(1);
  mockRedis.sCard.mockReset().mockResolvedValue(0);
  mockRedis.sMembers.mockReset().mockResolvedValue([]);
}

function createMockSocket(userId = 'user-1', socketId = 'socket-1') {
  const handlers = new Map<string, Function>();
  const socket = {
    id: socketId,
    data: { userId, dmCallConversationId: undefined as string | undefined },
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
  const fetchSocketsFn = vi.fn().mockResolvedValue([]);
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    in: vi.fn().mockReturnValue({ fetchSockets: fetchSocketsFn }),
    sockets: {
      sockets: new Map(),
    },
    _emit: emitFn,
    _fetchSockets: fetchSocketsFn,
  };
}

const mockUser = {
  id: 'user-1',
  username: 'testuser',
  displayName: 'Test User',
  avatarUrl: null,
};

const mockUser2 = {
  id: 'user-2',
  username: 'testuser2',
  displayName: 'Test User 2',
  avatarUrl: null,
};

const mockConversation = {
  user1Id: 'user-1',
  user2Id: 'user-2',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('dmVoiceHandler — handler registration', () => {
  it('registers all 8 expected event handlers', () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);

    const expectedEvents = [
      'dm:voice:join',
      'dm:voice:leave',
      'dm:voice:decline',
      'dm:voice:mute',
      'dm:voice:deaf',
      'dm:voice:speaking',
      'dm:voice:signal',
      'disconnecting',
    ];

    expect(handlers.size).toBe(expectedEvents.length);
    for (const event of expectedEvents) {
      expect(handlers.has(event)).toBe(true);
    }
  });
});

// ─── dm:voice:join ──────────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:join', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects non-string conversationId', async () => {
    const handler = handlers.get('dm:voice:join')!;
    await handler(123);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects empty string conversationId', async () => {
    const handler = handlers.get('dm:voice:join')!;
    await handler('');
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('emits error when dm_voice feature is disabled', async () => {
    vi.mocked(isFeatureEnabled).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');
    expect(socket.emit).toHaveBeenCalledWith('voice:error', { message: 'Voice calls are currently disabled' });
  });

  it('returns silently when conversation not found', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('returns silently when user is not a participant', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      user1Id: 'other-user-1',
      user2Id: 'other-user-2',
    } as any);
    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('leaves server voice channel before joining DM call (mutual exclusion)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    // After addDMVoiceUser, 1 user in call
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    expect(leaveCurrentVoiceChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user-1'
    );
  });

  it('joins dm voice room and sets socket data', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    // After addDMVoiceUser, first user in call
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    expect(socket.join).toHaveBeenCalledWith('dm:voice:conv-1');
    expect(socket.data.dmCallConversationId).toBe('conv-1');
  });

  it('emits dm:voice:offer when first user joins (caller)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    // 1 user in call (the joiner)
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    // Should emit offer to the dm room
    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:offer', expect.objectContaining({
      conversationId: 'conv-1',
      from: expect.objectContaining({ id: 'user-1' }),
    }));
    // Also emits joined to the caller directly
    expect(socket.emit).toHaveBeenCalledWith('dm:voice:joined', expect.objectContaining({
      conversationId: 'conv-1',
      user: expect.objectContaining({ id: 'user-1' }),
    }));
  });

  it('uses initial mute/deaf state from client', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: true }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1', { selfMute: true, selfDeaf: true });

    // Verify addDMVoiceUser was called via Redis multi with correct state
    expect(mockRedis._multiChain.hSet).toHaveBeenCalledWith(
      'dm:voice:users:conv-1',
      'user-1',
      JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: true })
    );
  });

  it('defaults mute/deaf to false when state not provided', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    expect(mockRedis._multiChain.hSet).toHaveBeenCalledWith(
      'dm:voice:users:conv-1',
      'user-1',
      JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false })
    );
  });

  it('emits dm:voice:joined to room when second user joins', async () => {
    // Set up as user-2 joining a call where user-1 already is
    const { socket: socket2, handlers: handlers2 } = createMockSocket('user-2', 'socket-2');
    const io2 = createMockIO();
    handleDMVoiceEvents(io2 as any, socket2 as any);

    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser2 as any);
    // 2 users in call after join
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });
    // For fetching existing users
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([mockUser] as any);

    const handler = handlers2.get('dm:voice:join')!;
    await handler('conv-1');

    // Should emit joined to the DM room
    expect(io2.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io2._emit).toHaveBeenCalledWith('dm:voice:joined', expect.objectContaining({
      conversationId: 'conv-1',
      user: expect.objectContaining({ id: 'user-2' }),
    }));
  });

  it('sends existing users to the second joiner', async () => {
    // Set up as user-2 joining a call where user-1 already is
    const { socket: socket2, handlers: handlers2 } = createMockSocket('user-2', 'socket-2');
    const io2 = createMockIO();
    handleDMVoiceEvents(io2 as any, socket2 as any);

    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser2 as any);
    // 2 users in call
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: false }),
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([mockUser] as any);

    const handler = handlers2.get('dm:voice:join')!;
    await handler('conv-1');

    // The second joiner should receive existing users as individual joined events
    expect(socket2.emit).toHaveBeenCalledWith('dm:voice:joined', expect.objectContaining({
      conversationId: 'conv-1',
      user: expect.objectContaining({
        id: 'user-1',
        selfMute: true,
        selfDeaf: false,
      }),
    }));
  });

  it('returns silently when user not found in DB', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    // Should not emit any voice events to the room
    expect(io._emit).not.toHaveBeenCalledWith('dm:voice:offer', expect.anything());
    expect(io._emit).not.toHaveBeenCalledWith('dm:voice:joined', expect.anything());
  });

  it('participant can join as user1Id', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      user1Id: 'user-1',
      user2Id: 'user-2',
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    expect(socket.join).toHaveBeenCalledWith('dm:voice:conv-1');
  });

  it('participant can join as user2Id', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      user1Id: 'user-2',
      user2Id: 'user-1',
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');

    expect(socket.join).toHaveBeenCalledWith('dm:voice:conv-1');
  });
});

// ─── dm:voice:leave ─────────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:leave', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:leave')!;
    await handler('conv-1');
    // Should not attempt any cleanup
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('calls leaveCurrentDMVoiceChannel on leave', async () => {
    // User is in a call
    mockRedis.get.mockResolvedValueOnce('conv-1');
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:leave')!;
    await handler('conv-1');

    // leaveCurrentDMVoiceChannel checks Redis for user's current call
    expect(mockRedis.get).toHaveBeenCalledWith('dm:voice:call:user-1');
  });
});

// ─── dm:voice:decline ───────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:decline', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects non-string conversationId', async () => {
    const handler = handlers.get('dm:voice:decline')!;
    await handler(42);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects empty string conversationId', async () => {
    const handler = handlers.get('dm:voice:decline')!;
    await handler('');
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('returns silently when conversation not found', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');
    expect(io._emit).not.toHaveBeenCalled();
  });

  it('returns silently when user is not a participant', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      user1Id: 'other-user-1',
      user2Id: 'other-user-2',
    } as any);
    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');
    expect(io._emit).not.toHaveBeenCalled();
  });

  it('returns silently when no users in the call', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    // getDMVoiceUsers returns empty map
    mockRedis.hGetAll.mockResolvedValueOnce({});

    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');

    expect(io._emit).not.toHaveBeenCalled();
  });

  it('ends the call for all users when declined', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    // Caller is in the call
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');

    // Should emit left and ended events
    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:left', expect.objectContaining({ conversationId: 'conv-1' }));
    expect(io._emit).toHaveBeenCalledWith('dm:voice:ended', { conversationId: 'conv-1' });
  });

  it('cleans up Redis state for all users when declined', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');

    // removeDMVoiceUser is called for each user in the call via Redis multi
    expect(mockRedis._multiChain.hDel).toHaveBeenCalledWith('dm:voice:users:conv-1', 'user-2');
    expect(mockRedis._multiChain.del).toHaveBeenCalledWith('dm:voice:call:user-2');
  });

  it('participant can decline as user1Id', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      user1Id: 'user-1',
      user2Id: 'user-2',
    } as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');

    expect(io._emit).toHaveBeenCalledWith('dm:voice:ended', { conversationId: 'conv-1' });
  });

  it('participant can decline as user2Id', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      user1Id: 'user-2',
      user2Id: 'user-1',
    } as any);
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });

    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');

    expect(io._emit).toHaveBeenCalledWith('dm:voice:ended', { conversationId: 'conv-1' });
  });
});

// ─── dm:voice:mute ──────────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:mute', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:mute')!;
    await handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects non-boolean muted value', async () => {
    const handler = handlers.get('dm:voice:mute')!;
    await handler('yes');
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects number muted value', async () => {
    const handler = handlers.get('dm:voice:mute')!;
    await handler(1);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when not in a DM call (no dmCallConversationId)', async () => {
    socket.data.dmCallConversationId = undefined;
    const handler = handlers.get('dm:voice:mute')!;
    await handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when user state not found in Redis', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(null);
    const handler = handlers.get('dm:voice:mute')!;
    await handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('updates mute state in Redis and emits state_update', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false })
    );

    const handler = handlers.get('dm:voice:mute')!;
    await handler(true);

    // Should update Redis
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      'dm:voice:users:conv-1',
      'user-1',
      JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: false })
    );

    // Should emit state update to the dm room
    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:state_update', {
      conversationId: 'conv-1',
      userId: 'user-1',
      selfMute: true,
      selfDeaf: false,
    });
  });

  it('unmutes by setting selfMute to false', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: false })
    );

    const handler = handlers.get('dm:voice:mute')!;
    await handler(false);

    expect(mockRedis.hSet).toHaveBeenCalledWith(
      'dm:voice:users:conv-1',
      'user-1',
      JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false })
    );

    expect(io._emit).toHaveBeenCalledWith('dm:voice:state_update', {
      conversationId: 'conv-1',
      userId: 'user-1',
      selfMute: false,
      selfDeaf: false,
    });
  });

  it('preserves selfDeaf state when toggling mute', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: true })
    );

    const handler = handlers.get('dm:voice:mute')!;
    await handler(true);

    expect(io._emit).toHaveBeenCalledWith('dm:voice:state_update', {
      conversationId: 'conv-1',
      userId: 'user-1',
      selfMute: true,
      selfDeaf: true,
    });
  });
});

// ─── dm:voice:deaf ──────────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:deaf', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:deaf')!;
    await handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects non-boolean deafened value', async () => {
    const handler = handlers.get('dm:voice:deaf')!;
    await handler('true');
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects number deafened value', async () => {
    const handler = handlers.get('dm:voice:deaf')!;
    await handler(0);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when not in a DM call', async () => {
    socket.data.dmCallConversationId = undefined;
    const handler = handlers.get('dm:voice:deaf')!;
    await handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when user state not found in Redis', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(null);
    const handler = handlers.get('dm:voice:deaf')!;
    await handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('updates deaf state in Redis and emits state_update', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false })
    );

    const handler = handlers.get('dm:voice:deaf')!;
    await handler(true);

    expect(mockRedis.hSet).toHaveBeenCalledWith(
      'dm:voice:users:conv-1',
      'user-1',
      JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: true })
    );

    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:state_update', {
      conversationId: 'conv-1',
      userId: 'user-1',
      selfMute: false,
      selfDeaf: true,
    });
  });

  it('undeafens by setting selfDeaf to false', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: true })
    );

    const handler = handlers.get('dm:voice:deaf')!;
    await handler(false);

    expect(mockRedis.hSet).toHaveBeenCalledWith(
      'dm:voice:users:conv-1',
      'user-1',
      JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: false })
    );

    expect(io._emit).toHaveBeenCalledWith('dm:voice:state_update', {
      conversationId: 'conv-1',
      userId: 'user-1',
      selfMute: true,
      selfDeaf: false,
    });
  });

  it('preserves selfMute state when toggling deaf', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-1', selfMute: true, selfDeaf: false })
    );

    const handler = handlers.get('dm:voice:deaf')!;
    await handler(true);

    expect(io._emit).toHaveBeenCalledWith('dm:voice:state_update', {
      conversationId: 'conv-1',
      userId: 'user-1',
      selfMute: true,
      selfDeaf: true,
    });
  });
});

// ─── dm:voice:speaking ──────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:speaking', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:speaking')!;
    handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects non-boolean speaking value', () => {
    const handler = handlers.get('dm:voice:speaking')!;
    handler('speaking');
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects number speaking value', () => {
    const handler = handlers.get('dm:voice:speaking')!;
    handler(1);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns early when not in a DM call', () => {
    socket.data.dmCallConversationId = undefined;
    const handler = handlers.get('dm:voice:speaking')!;
    handler(true);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('emits speaking event to DM room', () => {
    socket.data.dmCallConversationId = 'conv-1';
    const handler = handlers.get('dm:voice:speaking')!;
    handler(true);

    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:speaking', {
      conversationId: 'conv-1',
      userId: 'user-1',
      speaking: true,
    });
  });

  it('emits not-speaking event', () => {
    socket.data.dmCallConversationId = 'conv-1';
    const handler = handlers.get('dm:voice:speaking')!;
    handler(false);

    expect(io._emit).toHaveBeenCalledWith('dm:voice:speaking', {
      conversationId: 'conv-1',
      userId: 'user-1',
      speaking: false,
    });
  });
});

// ─── dm:voice:signal ────────────────────────────────────────────────────────

describe('dmVoiceHandler — dm:voice:signal', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: 'user-2', signal: { type: 'offer' } });
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('rejects null data', async () => {
    const handler = handlers.get('dm:voice:signal')!;
    await handler(null);
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('rejects non-object data', async () => {
    const handler = handlers.get('dm:voice:signal')!;
    await handler('invalid');
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('rejects data with non-string "to" field', async () => {
    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: 123, signal: {} });
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('rejects data with empty "to" field', async () => {
    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: '', signal: {} });
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('rejects signal payload exceeding 64KB', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    const handler = handlers.get('dm:voice:signal')!;
    // Create a string > 64KB
    const largeSignal = 'x'.repeat(65537);
    await handler({ to: 'user-2', signal: largeSignal });
    // Should return before looking up target in Redis
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('returns early when not in a DM call', async () => {
    socket.data.dmCallConversationId = undefined;
    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: 'user-2', signal: { type: 'offer' } });
    expect(mockRedis.hGet).not.toHaveBeenCalled();
  });

  it('relays signal to target user via their socketId', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false })
    );

    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: 'user-2', signal: { type: 'offer', sdp: 'test-sdp' } });

    // Should look up target's state in Redis
    expect(mockRedis.hGet).toHaveBeenCalledWith('dm:voice:users:conv-1', 'user-2');

    // Should relay to target's socketId
    expect(io.to).toHaveBeenCalledWith('socket-2');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:signal', {
      from: 'user-1',
      signal: { type: 'offer', sdp: 'test-sdp' },
    });
  });

  it('does nothing when target user is not in the call', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(null);

    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: 'user-2', signal: { type: 'offer' } });

    // Should look up but not emit
    expect(mockRedis.hGet).toHaveBeenCalledWith('dm:voice:users:conv-1', 'user-2');
    expect(io._emit).not.toHaveBeenCalled();
  });

  it('accepts signal payload just under 64KB', async () => {
    socket.data.dmCallConversationId = 'conv-1';
    mockRedis.hGet.mockResolvedValueOnce(
      JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false })
    );

    const handler = handlers.get('dm:voice:signal')!;
    // Create a string exactly at the limit boundary (JSON.stringify adds quotes, so content must be smaller)
    const signalContent = 'x'.repeat(65530);
    await handler({ to: 'user-2', signal: signalContent });

    // Should successfully relay
    expect(io.to).toHaveBeenCalledWith('socket-2');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:signal', {
      from: 'user-1',
      signal: signalContent,
    });
  });
});

// ─── disconnecting ──────────────────────────────────────────────────────────

describe('dmVoiceHandler — disconnecting cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();
  });

  it('registers a disconnecting handler', () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
    expect(handlers.has('disconnecting')).toBe(true);
  });

  it('calls leaveCurrentDMVoiceChannel on disconnect', async () => {
    mockRedis.get.mockResolvedValueOnce('conv-1');
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);

    const handler = handlers.get('disconnecting')!;
    await handler();

    // Should attempt to look up user's current call
    expect(mockRedis.get).toHaveBeenCalledWith('dm:voice:call:user-1');
  });

  it('does not throw when user is not in a DM call', async () => {
    const { socket, handlers } = createMockSocket();
    const io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);

    const handler = handlers.get('disconnecting')!;
    // Should not throw
    await expect(handler()).resolves.toBeUndefined();
  });
});

// ─── leaveCurrentDMVoiceChannel ─────────────────────────────────────────────

describe('dmVoiceHandler — leaveCurrentDMVoiceChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();
  });

  it('does nothing when user has no active DM call', async () => {
    const { socket } = createMockSocket();
    const io = createMockIO();

    await leaveCurrentDMVoiceChannel(io as any, socket as any, 'user-1');

    expect(socket.leave).not.toHaveBeenCalled();
    expect(io._emit).not.toHaveBeenCalled();
  });

  it('removes user from call, leaves socket room, and clears socket data', async () => {
    mockRedis.get.mockResolvedValueOnce('conv-1');
    // Users before removal — only the leaving user, simplest case
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const { socket } = createMockSocket();
    socket.data.dmCallConversationId = 'conv-1';
    const io = createMockIO();

    await leaveCurrentDMVoiceChannel(io as any, socket as any, 'user-1');

    expect(socket.leave).toHaveBeenCalledWith('dm:voice:conv-1');
    expect(socket.data.dmCallConversationId).toBeUndefined();
  });

  it('emits dm:voice:left and dm:voice:ended', async () => {
    mockRedis.get.mockResolvedValueOnce('conv-1');
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    const { socket } = createMockSocket();
    const io = createMockIO();

    await leaveCurrentDMVoiceChannel(io as any, socket as any, 'user-1');

    expect(io.to).toHaveBeenCalledWith('dm:conv-1');
    expect(io._emit).toHaveBeenCalledWith('dm:voice:left', { conversationId: 'conv-1', userId: 'user-1' });
    expect(io._emit).toHaveBeenCalledWith('dm:voice:ended', { conversationId: 'conv-1' });
  });

  it('cleans up remaining users when the leaving user exits (1-on-1 call ends)', async () => {
    mockRedis.get.mockResolvedValueOnce('conv-1');
    // Both users in call before leave
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
      'user-2': JSON.stringify({ socketId: 'socket-2', selfMute: false, selfDeaf: false }),
    });

    const mockRemoteSocket = { leave: vi.fn() };
    const { socket } = createMockSocket();
    const io = createMockIO();
    // io.in('user:user-2').fetchSockets() returns the remote socket
    io.in.mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([mockRemoteSocket]) });

    await leaveCurrentDMVoiceChannel(io as any, socket as any, 'user-1');

    // Should clean up user-2 via fetchSockets
    expect(io.in).toHaveBeenCalledWith('user:user-2');
    expect(mockRemoteSocket.leave).toHaveBeenCalledWith('dm:voice:conv-1');

    // Should remove user-2 from Redis (via multi)
    expect(mockRedis._multiChain.hDel).toHaveBeenCalledWith('dm:voice:users:conv-1', 'user-2');
    expect(mockRedis._multiChain.del).toHaveBeenCalledWith('dm:voice:call:user-2');
  });

  it('creates a system message for call ended', async () => {
    mockRedis.get.mockResolvedValueOnce('conv-1');
    mockRedis.hGetAll.mockResolvedValueOnce({
      'user-1': JSON.stringify({ socketId: 'socket-1', selfMute: false, selfDeaf: false }),
    });

    vi.mocked(prisma.message.create).mockResolvedValueOnce({
      id: 'msg-1',
      content: 'Voice call ended',
      type: 'system',
      channelId: null,
      conversationId: 'conv-1',
      authorId: 'user-1',
      author: mockUser,
      createdAt: new Date('2026-01-01'),
      editedAt: null,
    } as any);
    vi.mocked(prisma.conversation.update).mockResolvedValueOnce({} as any);

    const { socket } = createMockSocket();
    const io = createMockIO();

    await leaveCurrentDMVoiceChannel(io as any, socket as any, 'user-1');

    // Wait for async system message creation
    await vi.waitFor(() => {
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: 'Voice call ended',
            type: 'system',
            conversationId: 'conv-1',
            authorId: 'user-1',
          }),
        })
      );
    });
  });
});

// ─── getActiveDMCallCount ───────────────────────────────────────────────────

describe('dmVoiceHandler — getActiveDMCallCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();
  });

  it('returns count from Redis sCard', async () => {
    mockRedis.sCard.mockResolvedValueOnce(5);
    const count = await getActiveDMCallCount();
    expect(count).toBe(5);
    expect(mockRedis.sCard).toHaveBeenCalledWith('dm:voice:active');
  });

  it('returns 0 when no active calls', async () => {
    const count = await getActiveDMCallCount();
    expect(count).toBe(0);
  });
});

// ─── getTotalDMVoiceUsers ───────────────────────────────────────────────────

describe('dmVoiceHandler — getTotalDMVoiceUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();
  });

  it('returns 0 when no active conversations', async () => {
    const count = await getTotalDMVoiceUsers();
    expect(count).toBe(0);
    expect(mockRedis.sMembers).toHaveBeenCalledWith('dm:voice:active');
  });

  it('sums user counts across active conversations', async () => {
    mockRedis.sMembers.mockResolvedValueOnce(['conv-1', 'conv-2']);
    mockRedis._multiChain.exec.mockResolvedValueOnce([2, 2]);

    const count = await getTotalDMVoiceUsers();
    expect(count).toBe(4);
  });

  it('handles non-number results in pipeline', async () => {
    mockRedis.sMembers.mockResolvedValueOnce(['conv-1']);
    mockRedis._multiChain.exec.mockResolvedValueOnce([null]);

    const count = await getTotalDMVoiceUsers();
    expect(count).toBe(0);
  });
});

// ─── Rate limiting ──────────────────────────────────────────────────────────

describe('dmVoiceHandler — rate limiting', () => {
  let socket: ReturnType<typeof createMockSocket>['socket'];
  let handlers: ReturnType<typeof createMockSocket>['handlers'];
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedis();

    const created = createMockSocket();
    socket = created.socket;
    handlers = created.handlers;
    io = createMockIO();
    handleDMVoiceEvents(io as any, socket as any);
  });

  it('dm:voice:join uses rate limit of 10 per minute', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:join')!;
    await handler('conv-1');
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:join', 10);
  });

  it('dm:voice:leave uses rate limit of 30 per minute', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:leave')!;
    await handler('conv-1');
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:leave', 30);
  });

  it('dm:voice:decline uses rate limit of 10 per minute', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:decline')!;
    await handler('conv-1');
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:decline', 10);
  });

  it('dm:voice:mute uses rate limit of 30 per minute', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:mute')!;
    await handler(true);
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:mute', 30);
  });

  it('dm:voice:deaf uses rate limit of 30 per minute', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:deaf')!;
    await handler(true);
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:deaf', 30);
  });

  it('dm:voice:speaking uses rate limit of 120 per minute', () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:speaking')!;
    handler(true);
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:speaking', 120);
  });

  it('dm:voice:signal uses rate limit of 300 per minute', async () => {
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const handler = handlers.get('dm:voice:signal')!;
    await handler({ to: 'user-2', signal: {} });
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'dm:voice:signal', 300);
  });
});
