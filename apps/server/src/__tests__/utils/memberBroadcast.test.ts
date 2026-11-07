import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockEmit, mockTo, mockIn, mockLocalIn, mockSocketsJoin, mockSocketsLeave, mockLocalSocketsJoin, mockLocalSocketsLeave,
  mockPrisma, mockFilterVisibleChannels, mockReplayVoiceState,
} = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockTo: vi.fn(),
  mockIn: vi.fn(),
  mockLocalIn: vi.fn(),
  mockSocketsJoin: vi.fn(),
  mockSocketsLeave: vi.fn(),
  mockLocalSocketsJoin: vi.fn(),
  mockLocalSocketsLeave: vi.fn(),
  mockFilterVisibleChannels: vi.fn(),
  mockReplayVoiceState: vi.fn(),
  mockPrisma: {
    channel: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
    local: { in: mockLocalIn },
  })),
}));

// The replay itself is voiceHandler's (covered there); here only that the join
// path asks for it, for the right rooms, and that its failure stays contained
vi.mock('../../websocket/voiceHandler', () => ({
  replayVoiceState: mockReplayVoiceState,
}));

vi.mock('../../utils/prisma', () => ({
  prisma: mockPrisma,
}));

// Visibility filtering logic itself is covered by permissionCalculator tests —
// here it defaults to pass-through and is overridden per-test to verify that
// join paths respect the filter result.
vi.mock('../../utils/permissionCalculator', () => ({
  filterVisibleChannels: mockFilterVisibleChannels,
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
  mockIn.mockReturnValue({ socketsJoin: mockSocketsJoin, socketsLeave: mockSocketsLeave });
  mockLocalIn.mockReturnValue({ socketsJoin: mockLocalSocketsJoin, socketsLeave: mockLocalSocketsLeave });
  mockPrisma.channel.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockReplayVoiceState.mockResolvedValue(undefined);
  // Default: every channel is visible (pass-through)
  mockFilterVisibleChannels.mockImplementation(
    async (_userId: string, _serverId: string, channels: { id: string }[]) => channels,
  );
}

const aliceRow = () => ({
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('memberBroadcast — joinServerRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('joins the user room (every socket of the user) to the server room: this node at once, then cluster-wide', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockLocalIn).toHaveBeenCalledWith('user:user-1');
    expect(mockIn).toHaveBeenCalledWith('user:user-1');
    expect(mockLocalSocketsJoin).toHaveBeenCalledWith(['server:server-1']);
    expect(mockSocketsJoin).toHaveBeenCalledWith(['server:server-1']);
  });

  it('joins the visible channel rooms in the SAME adapter operation as the server room', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([
      { id: 'ch-1' },
      { id: 'ch-2' },
      { id: 'ch-3' },
    ]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1' },
      select: { id: true, secure: true },
    });
    const rooms = ['server:server-1', 'channel:ch-1', 'channel:ch-2', 'channel:ch-3'];
    expect(mockLocalSocketsJoin).toHaveBeenCalledTimes(1);
    expect(mockLocalSocketsJoin).toHaveBeenCalledWith(rooms);
    expect(mockSocketsJoin).toHaveBeenCalledTimes(1);
    expect(mockSocketsJoin).toHaveBeenCalledWith(rooms);
  });

  it('applies the join to this node BEFORE publishing it (the Redis adapter only applies its own publish on the echo)', async () => {
    const order: string[] = [];
    mockLocalSocketsJoin.mockImplementation(() => { order.push('local'); });
    mockSocketsJoin.mockImplementation(() => { order.push('cluster'); });

    await joinServerRoom('user-1', 'server-1');

    expect(order).toEqual(['local', 'cluster']);
  });

  it('does NOT join rooms of channels the user cannot view', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([
      { id: 'ch-public' },
      { id: 'ch-private' },
    ]);
    // Visibility filter denies the private channel
    mockFilterVisibleChannels.mockResolvedValueOnce([{ id: 'ch-public' }]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockFilterVisibleChannels).toHaveBeenCalledWith(
      'user-1',
      'server-1',
      [{ id: 'ch-public' }, { id: 'ch-private' }],
    );
    for (const call of [mockSocketsJoin.mock.calls[0][0], mockLocalSocketsJoin.mock.calls[0][0]] as string[][]) {
      expect(call).toContain('channel:ch-public');
      expect(call).not.toContain('channel:ch-private');
    }
  });

  it('never fetches the sockets — a room operation cannot wait on an unresponsive peer node', async () => {
    // io.in(room).fetchSockets() waits for every node's reply and throws after
    // 5 s when one peer is down, which used to skip the broadcast entirely
    const fetchSockets = vi.fn();
    mockIn.mockReturnValue({ socketsJoin: mockSocketsJoin, socketsLeave: mockSocketsLeave, fetchSockets });
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await joinServerRoom('user-1', 'server-1');

    expect(fetchSockets).not.toHaveBeenCalled();
    expect(mockSocketsJoin).toHaveBeenCalledTimes(1);
  });

  it('does not emit any events (silent join)', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    // joinServerRoom should NOT broadcast — it's for the server creator
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockReplayVoiceState).not.toHaveBeenCalled();
  });

  it('queries ALL channels (text and voice — voice presence rooms need joining too)', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1' },
      select: { id: true, secure: true },
    });
  });

  it('handles server with no channels', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('user-1', 'server-1');

    // Only the server room
    expect(mockSocketsJoin).toHaveBeenCalledWith(['server:server-1']);
  });
});

describe('memberBroadcast — broadcastMemberJoined', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('joins the user room to the server room and the visible channel rooms', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);
    mockPrisma.user.findUnique.mockResolvedValueOnce(aliceRow());

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockIn).toHaveBeenCalledWith('user:user-1');
    expect(mockSocketsJoin).toHaveBeenCalledWith(['server:server-1', 'channel:ch-1']);
    expect(mockLocalSocketsJoin).toHaveBeenCalledWith(['server:server-1', 'channel:ch-1']);
  });

  it('replays the server\'s live voice occupancy to the new member, as a snapshot, for the channels they can view', async () => {
    // Every voice join/leave happened before the member's sockets were in the
    // rooms: without the replay the new member's sidebar shows the voice
    // channels empty until someone moves
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'vc-public' }, { id: 'vc-staff' }]);
    mockFilterVisibleChannels.mockResolvedValueOnce([{ id: 'vc-public' }]);
    const userRoom = { emit: vi.fn() };
    mockTo.mockImplementation((room: string) => (room === 'user:user-1' ? userRoom : { emit: mockEmit }));
    mockPrisma.user.findUnique.mockResolvedValueOnce(aliceRow());

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockReplayVoiceState).toHaveBeenCalledTimes(1);
    const [target, serverIds, visible, opts] = mockReplayVoiceState.mock.calls[0] as [unknown, string[], Set<string>, unknown];
    expect(target).toBe(userRoom);
    expect(serverIds).toEqual(['server-1']);
    expect([...visible]).toEqual(['vc-public']);
    expect(opts).toEqual({ source: 'connect' });
  });

  it('replays AFTER the rooms are joined, and still broadcasts member:joined when the replay fails', async () => {
    const order: string[] = [];
    mockSocketsJoin.mockImplementation(() => { order.push('rooms'); });
    mockReplayVoiceState.mockImplementation(async () => { order.push('replay'); throw new Error('redis down'); });
    mockPrisma.user.findUnique.mockResolvedValueOnce(aliceRow());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(broadcastMemberJoined('user-1', 'server-1')).resolves.toBeUndefined();

    expect(order).toEqual(['rooms', 'replay']);
    expect(mockEmit).toHaveBeenCalledWith('member:joined', expect.objectContaining({ serverId: 'server-1' }));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('broadcasts member:joined with correct user fields to the server room', async () => {
    const createdAt = new Date('2024-01-15T12:00:00.000Z');
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
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({ ...aliceRow(), bio: null });

    await broadcastMemberJoined('user-1', 'server-1');

    expect(mockEmit).toHaveBeenCalledWith(
      'member:joined',
      expect.objectContaining({
        user: expect.objectContaining({ bio: null }),
      }),
    );
  });

  it('does not broadcast if user is not found in DB', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    await broadcastMemberJoined('nonexistent-user', 'server-1');

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('fetches user with safe fields only (no email, no password)', async () => {
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

  it('serializes createdAt as ISO string', async () => {
    const date = new Date('2025-06-15T08:30:00.000Z');
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({ ...aliceRow(), createdAt: date });

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

  it('still joins the rooms even when user lookup returns null', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    await broadcastMemberJoined('user-1', 'server-1');

    // Room joins happen before the user lookup
    expect(mockSocketsJoin).toHaveBeenCalledWith(['server:server-1', 'channel:ch-1']);
    // But no broadcast
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('includes serverId in the broadcast payload', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({ ...aliceRow(), displayName: null, status: 'offline', role: 'admin' });

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

  it('removes the user room from the server room: this node at once, then cluster-wide', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockLocalIn).toHaveBeenCalledWith('user:user-1');
    expect(mockIn).toHaveBeenCalledWith('user:user-1');
    expect(mockLocalSocketsLeave).toHaveBeenCalledWith(['server:server-1']);
    expect(mockSocketsLeave).toHaveBeenCalledWith(['server:server-1']);
  });

  it('removes the user room from ALL channel rooms in the same operation', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([
      { id: 'ch-1' },
      { id: 'ch-2' },
    ]);

    await broadcastMemberLeft('user-1', 'server-1');

    const rooms = ['server:server-1', 'channel:ch-1', 'channel:ch-2'];
    expect(mockSocketsLeave).toHaveBeenCalledTimes(1);
    expect(mockSocketsLeave).toHaveBeenCalledWith(rooms);
    expect(mockLocalSocketsLeave).toHaveBeenCalledTimes(1);
    expect(mockLocalSocketsLeave).toHaveBeenCalledWith(rooms);
  });

  it('never fetches the sockets (see the join path)', async () => {
    const fetchSockets = vi.fn();
    mockIn.mockReturnValue({ socketsJoin: mockSocketsJoin, socketsLeave: mockSocketsLeave, fetchSockets });
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(fetchSockets).not.toHaveBeenCalled();
  });

  it('broadcasts member:left to the server room with userId and serverId', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockTo).toHaveBeenCalledWith('server:server-1');
    expect(mockEmit).toHaveBeenCalledWith('member:left', {
      serverId: 'server-1',
      userId: 'user-1',
    });
  });

  it('queries ALL channels for room removal (no visibility filter — a departed member must receive nothing)', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1' },
      select: { id: true },
    });
    expect(mockFilterVisibleChannels).not.toHaveBeenCalled();
  });

  it('leaves the rooms on THIS node BEFORE announcing the departure, so the departed member never hears it', async () => {
    const order: string[] = [];
    mockLocalSocketsLeave.mockImplementation(() => { order.push('local-leave'); });
    mockSocketsLeave.mockImplementation(() => { order.push('cluster-leave'); });
    mockEmit.mockImplementation(() => { order.push('emit'); });
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(order).toEqual(['local-leave', 'cluster-leave', 'emit']);
  });

  it('broadcasts to the correct server room with different server IDs', async () => {
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

  it('uses "user:{userId}" to address the user\'s sockets', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);

    await joinServerRoom('abc-123', 'server-1');

    expect(mockIn).toHaveBeenCalledWith('user:abc-123');
    expect(mockLocalIn).toHaveBeenCalledWith('user:abc-123');
  });

  it('uses "server:{serverId}" for the server room and "channel:{channelId}" for channel rooms', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'channel-abc' }]);

    await joinServerRoom('user-1', 'srv-xyz');

    expect(mockSocketsJoin).toHaveBeenCalledWith(['server:srv-xyz', 'channel:channel-abc']);
  });
});

describe('memberBroadcast — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChains();
  });

  it('broadcastMemberJoined handles many channels', async () => {
    const channels = Array.from({ length: 20 }, (_, i) => ({ id: `ch-${i}` }));
    mockPrisma.channel.findMany.mockResolvedValueOnce(channels);
    mockPrisma.user.findUnique.mockResolvedValueOnce(aliceRow());

    await broadcastMemberJoined('user-1', 'server-1');

    // 1 server room + 20 channel rooms, one operation (per scope)
    expect(mockSocketsJoin).toHaveBeenCalledTimes(1);
    expect(mockSocketsJoin.mock.calls[0][0]).toHaveLength(21);
  });

  it('broadcastMemberLeft handles many channels', async () => {
    const channels = Array.from({ length: 10 }, (_, i) => ({ id: `ch-${i}` }));
    mockPrisma.channel.findMany.mockResolvedValueOnce(channels);

    await broadcastMemberLeft('user-1', 'server-1');

    expect(mockSocketsLeave).toHaveBeenCalledTimes(1);
    expect(mockSocketsLeave.mock.calls[0][0]).toHaveLength(11);
  });

  it('broadcastMemberJoined with supporter tier casts types correctly', async () => {
    mockPrisma.channel.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      ...aliceRow(),
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
