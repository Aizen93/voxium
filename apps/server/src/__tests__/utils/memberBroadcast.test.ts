import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockEmit, mockTo, mockIn, mockFetchSockets, mockPrisma } = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockTo = vi.fn();
  const mockFetchSockets = vi.fn();
  const mockIn = vi.fn();

  return {
    mockEmit,
    mockTo,
    mockIn,
    mockFetchSockets,
    mockPrisma: {
      channel: {
        findMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    },
  };
});

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
  })),
}));

vi.mock('../../utils/prisma', () => ({
  prisma: mockPrisma,
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import {
  broadcastMemberJoined,
  broadcastMemberLeft,
  joinServerRoom,
} from '../../utils/memberBroadcast';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Re-establish the mock return-value chains after vi.clearAllMocks() */
function resetMockChains() {
  mockTo.mockReturnValue({ emit: mockEmit });
  mockIn.mockReturnValue({ fetchSockets: mockFetchSockets });
  mockFetchSockets.mockResolvedValue([]);
  mockPrisma.channel.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue(null);
}

function createMockSocket(id = 'socket-1') {
  return {
    id,
    join: vi.fn(),
    leave: vi.fn(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('memberBroadcast — joinServerRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('joins the user socket to the server room', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockIn).toHaveBeenCalledWith('user:user-1');
    expect(socket.join).toHaveBeenCalledWith('server:server-1');
  });

  it('joins user socket to all text channel rooms', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([
      { id: 'ch-1' },
      { id: 'ch-2' },
      { id: 'ch-3' },
    ]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1', type: 'text' },
      select: { id: true },
    });
    expect(socket.join).toHaveBeenCalledWith('server:server-1');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-1');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-2');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-3');
    expect(socket.join).toHaveBeenCalledTimes(4); // server + 3 channels
  });

  it('joins ALL connected sockets of that user (multi-device)', async () => {
    const socket1 = createMockSocket('socket-1');
    const socket2 = createMockSocket('socket-2');
    const socket3 = createMockSocket('socket-3');
    mockFetchSockets.mockResolvedValueOnce([socket1, socket2, socket3]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await joinServerRoom('user-1', 'server-1');

    for (const s of [socket1, socket2, socket3]) {
      expect(s.join).toHaveBeenCalledWith('server:server-1');
      expect(s.join).toHaveBeenCalledWith('channel:ch-1');
    }
  });

  it('does not throw when user has no active sockets', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await expect(joinServerRoom('user-1', 'server-1')).resolves.not.toThrow();
  });

  it('does not emit any events (silent join)', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    // joinServerRoom should NOT broadcast — it's for the server creator
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('queries only text channels (not voice)', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1', type: 'text' },
      select: { id: true },
    });
  });

  it('handles server with no text channels', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    // Should only join the server room, no channel rooms
    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(socket.join).toHaveBeenCalledWith('server:server-1');
  });
});

describe('memberBroadcast — broadcastMemberJoined', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('joins the user socket to server room and text channel rooms', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      bio: 'Hello',
      status: 'online',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
      createdAt: new Date('2024-01-15T00:00:00.000Z'),
    });

    await broadcastMemberJoined('user-1', 'server-1');

    expect(socket.join).toHaveBeenCalledWith('server:server-1');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-1');
  });

  it('broadcasts member:joined with correct user fields to the server room', async () => {
    const createdAt = new Date('2024-01-15T12:00:00.000Z');
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: 'avatars/user-1.png',
      bio: 'Hi there',
      status: 'online',
      role: 'user',
      isSupporter: true,
      supporterTier: 'gold',
      createdAt,
    });

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockTo).toHaveBeenCalledWith('server:server-1');
    expect(mockEmit).toHaveBeenCalledWith('member:joined', {
      serverId: 'server-1',
      user: {
        id: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        avatarUrl: 'avatars/user-1.png',
        bio: 'Hi there',
        status: 'online',
        role: 'user',
        isSupporter: true,
        supporterTier: 'gold',
        createdAt: createdAt.toISOString(),
      },
    });
  });

  it('converts null bio to null in the broadcast payload', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      bio: null,
      status: 'online',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
      createdAt: new Date('2024-01-15T00:00:00.000Z'),
    });

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockEmit).toHaveBeenCalledWith(
      'member:joined',
      expect.objectContaining({
        user: expect.objectContaining({ bio: null }),
      }),
    );
  });

  it('does not broadcast if user is not found in DB', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    await broadcastMemberJoined('nonexistent-user', 'server-1');

    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('fetches user with safe fields only (no email, no password)', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        status: true,
        role: true,
        isSupporter: true,
        supporterTier: true,
        createdAt: true,
      },
    });
  });

  it('joins ALL connected sockets for multi-device before broadcasting', async () => {
    const socket1 = createMockSocket('socket-1');
    const socket2 = createMockSocket('socket-2');
    mockFetchSockets.mockResolvedValueOnce([socket1, socket2]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      bio: null,
      status: 'online',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
      createdAt: new Date('2024-01-15T00:00:00.000Z'),
    });

    await broadcastMemberJoined('user-1', 'server-1');

    for (const s of [socket1, socket2]) {
      expect(s.join).toHaveBeenCalledWith('server:server-1');
      expect(s.join).toHaveBeenCalledWith('channel:ch-1');
      expect(s.join).toHaveBeenCalledWith('channel:ch-2');
    }

    // Also verify broadcast happened
    expect(mockEmit).toHaveBeenCalledWith('member:joined', expect.any(Object));
  });

  it('serializes createdAt as ISO string', async () => {
    const date = new Date('2025-06-15T08:30:00.000Z');
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      bio: null,
      status: 'online',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
      createdAt: date,
    });

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockEmit).toHaveBeenCalledWith(
      'member:joined',
      expect.objectContaining({
        user: expect.objectContaining({
          createdAt: '2025-06-15T08:30:00.000Z',
        }),
      }),
    );
  });

  it('still joins socket rooms even when user lookup returns null', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    await broadcastMemberJoined('user-1', 'server-1');

    // Socket room joins happen before the user lookup
    expect(socket.join).toHaveBeenCalledWith('server:server-1');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-1');

    // But no broadcast
    expect(mockTo).not.toHaveBeenCalled();
  });

  it('handles user with no active sockets but still broadcasts', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      bio: null,
      status: 'online',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
      createdAt: new Date('2024-01-15T00:00:00.000Z'),
    });

    await broadcastMemberJoined('user-1', 'server-1');

    // Still broadcasts even though user has no sockets (e.g. API-only join)
    expect(mockTo).toHaveBeenCalledWith('server:server-1');
    expect(mockEmit).toHaveBeenCalledWith('member:joined', expect.any(Object));
  });

  it('includes serverId in the broadcast payload', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: null,
      avatarUrl: null,
      bio: null,
      status: 'offline',
      role: 'admin',
      isSupporter: false,
      supporterTier: null,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    await broadcastMemberJoined('user-1', 'server-42');

    expect(mockEmit).toHaveBeenCalledWith(
      'member:joined',
      expect.objectContaining({ serverId: 'server-42' }),
    );
  });
});

describe('memberBroadcast — broadcastMemberLeft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('removes the user socket from the server room', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockIn).toHaveBeenCalledWith('user:user-1');
    expect(socket.leave).toHaveBeenCalledWith('server:server-1');
  });

  it('removes the user socket from all text channel rooms', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([
      { id: 'ch-1' },
      { id: 'ch-2' },
    ]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(socket.leave).toHaveBeenCalledWith('server:server-1');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-1');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-2');
    expect(socket.leave).toHaveBeenCalledTimes(3); // server + 2 channels
  });

  it('removes ALL connected sockets of the user (multi-device)', async () => {
    const socket1 = createMockSocket('socket-1');
    const socket2 = createMockSocket('socket-2');
    mockFetchSockets.mockResolvedValueOnce([socket1, socket2]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await broadcastMemberLeft('user-1', 'server-1');

    for (const s of [socket1, socket2]) {
      expect(s.leave).toHaveBeenCalledWith('server:server-1');
      expect(s.leave).toHaveBeenCalledWith('channel:ch-1');
    }
  });

  it('broadcasts member:left to the server room with userId and serverId', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockTo).toHaveBeenCalledWith('server:server-1');
    expect(mockEmit).toHaveBeenCalledWith('member:left', {
      serverId: 'server-1',
      userId: 'user-1',
    });
  });

  it('broadcasts member:left even when user has no active sockets', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    // Broadcast should still happen even if user has no sockets
    expect(mockTo).toHaveBeenCalledWith('server:server-1');
    expect(mockEmit).toHaveBeenCalledWith('member:left', {
      serverId: 'server-1',
      userId: 'user-1',
    });
  });

  it('queries only text channels for room removal', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1', type: 'text' },
      select: { id: true },
    });
  });

  it('handles server with no text channels — only leaves server room', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(socket.leave).toHaveBeenCalledTimes(1);
    expect(socket.leave).toHaveBeenCalledWith('server:server-1');
  });

  it('broadcasts to the correct server room with different server IDs', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-99', 'server-42');

    expect(mockTo).toHaveBeenCalledWith('server:server-42');
    expect(mockEmit).toHaveBeenCalledWith('member:left', {
      serverId: 'server-42',
      userId: 'user-99',
    });
  });
});

describe('memberBroadcast — room naming conventions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('uses "user:{userId}" for fetching sockets', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('abc-123', 'server-1');

    expect(mockIn).toHaveBeenCalledWith('user:abc-123');
  });

  it('uses "server:{serverId}" for server room', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'srv-xyz');

    expect(socket.join).toHaveBeenCalledWith('server:srv-xyz');
  });

  it('uses "channel:{channelId}" for channel rooms', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'channel-abc' }]);

    await joinServerRoom('user-1', 'server-1');

    expect(socket.join).toHaveBeenCalledWith('channel:channel-abc');
  });
});

describe('memberBroadcast — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('broadcastMemberJoined handles many text channels', async () => {
    const socket = createMockSocket();
    mockFetchSockets.mockResolvedValueOnce([socket]);

    const channels = Array.from({ length: 20 }, (_, i) => ({ id: `ch-${i}` }));
    mockPrisma.channel.findMany.mockResolvedValueOnce(channels);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: null,
      avatarUrl: null,
      bio: null,
      status: 'online',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
      createdAt: new Date(),
    });

    await broadcastMemberJoined('user-1', 'server-1');

    // 1 server room + 20 channel rooms
    expect(socket.join).toHaveBeenCalledTimes(21);
  });

  it('broadcastMemberLeft handles many sockets and many channels', async () => {
    const sockets = Array.from({ length: 5 }, (_, i) => createMockSocket(`socket-${i}`));
    mockFetchSockets.mockResolvedValueOnce(sockets);

    const channels = Array.from({ length: 10 }, (_, i) => ({ id: `ch-${i}` }));
    mockPrisma.channel.findMany.mockResolvedValueOnce(channels);

    await broadcastMemberLeft('user-1', 'server-1');

    // Each socket leaves server room + 10 channels = 11 leave calls per socket
    for (const s of sockets) {
      expect(s.leave).toHaveBeenCalledTimes(11);
    }
  });

  it('broadcastMemberJoined with supporter tier casts types correctly', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice Pro',
      avatarUrl: 'avatars/user-1.png',
      bio: null,
      status: 'dnd',
      role: 'admin',
      isSupporter: true,
      supporterTier: 'diamond',
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
    });

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockEmit).toHaveBeenCalledWith(
      'member:joined',
      expect.objectContaining({
        user: expect.objectContaining({
          status: 'dnd',
          role: 'admin',
          supporterTier: 'diamond',
        }),
      }),
    );
  });
});
