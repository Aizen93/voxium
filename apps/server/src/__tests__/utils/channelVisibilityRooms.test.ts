import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockIn, mockFetchSockets, mockPrisma, mockFilterVisibleChannels, mockGetIO } = vi.hoisted(() => {
  const mockFetchSockets = vi.fn();
  const mockIn = vi.fn();
  return {
    mockIn,
    mockFetchSockets,
    mockFilterVisibleChannels: vi.fn(),
    mockGetIO: vi.fn(),
    mockPrisma: {
      channel: { findMany: vi.fn() },
      serverMember: { findUnique: vi.fn() },
    },
  };
});

vi.mock('../../websocket/socketServer', () => ({
  getIO: mockGetIO,
}));

vi.mock('../../utils/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../utils/permissionCalculator', () => ({
  filterVisibleChannels: mockFilterVisibleChannels,
}));

import { syncChannelVisibilityRooms } from '../../utils/channelVisibilityRooms';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSocket(userId: string, opts?: { voiceChannelId?: string }) {
  return {
    data: { userId, voiceChannelId: opts?.voiceChannelId },
    join: vi.fn(),
    leave: vi.fn(),
  };
}

function resetMocks() {
  vi.clearAllMocks();
  mockGetIO.mockReturnValue({ in: mockIn });
  mockIn.mockReturnValue({ fetchSockets: mockFetchSockets });
  mockFetchSockets.mockResolvedValue([]);
  mockPrisma.channel.findMany.mockResolvedValue([]);
  mockPrisma.serverMember.findUnique.mockResolvedValue({ userId: 'any' });
  mockFilterVisibleChannels.mockImplementation(
    async (_uid: string, _sid: string, channels: { id: string }[]) => channels,
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('syncChannelVisibilityRooms', () => {
  beforeEach(resetMocks);

  it('joins visible channels and leaves non-visible ones for each member socket', async () => {
    const socket = createMockSocket('user-1');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-pub' }, { id: 'ch-priv' }]);
    mockFilterVisibleChannels.mockResolvedValueOnce([{ id: 'ch-pub' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(mockIn).toHaveBeenCalledWith('server:server-1');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-pub');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-priv');
    expect(socket.join).not.toHaveBeenCalledWith('channel:ch-priv');
  });

  it('scopes the channel query when channelId is given (override change)', async () => {
    const socket = createMockSocket('user-1');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1', { channelId: 'ch-1' });

    expect(mockPrisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1', id: 'ch-1' },
      select: { id: true, secure: true },
    });
  });

  it('fetches only the target user\'s sockets when userId is given (member role change)', async () => {
    const socket = createMockSocket('user-9');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);
    mockPrisma.serverMember.findUnique.mockResolvedValueOnce({ userId: 'user-9' });

    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });

    expect(mockIn).toHaveBeenCalledWith('user:user-9');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-1');
  });

  it('when scoped by userId and the user is no longer a member, leaves ALL channel rooms', async () => {
    const socket = createMockSocket('user-9');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }]);
    mockPrisma.serverMember.findUnique.mockResolvedValueOnce(null);

    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-1');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-2');
    expect(socket.join).not.toHaveBeenCalled();
    expect(mockFilterVisibleChannels).not.toHaveBeenCalled();
  });

  it('never removes a socket from the room of the voice channel it is actively in', async () => {
    const socket = createMockSocket('user-1', { voiceChannelId: 'ch-voice' });
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    // User lost visibility to BOTH channels
    mockFilterVisibleChannels.mockResolvedValueOnce([]);

    await syncChannelVisibilityRooms('server-1');

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-text');
    expect(socket.leave).not.toHaveBeenCalledWith('channel:ch-voice');
  });

  it('computes visibility once per user, applying to all their sockets (multi-device)', async () => {
    const s1 = createMockSocket('user-1');
    const s2 = createMockSocket('user-1');
    const s3 = createMockSocket('user-2');
    mockFetchSockets.mockResolvedValueOnce([s1, s2, s3]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(mockFilterVisibleChannels).toHaveBeenCalledTimes(2); // user-1, user-2
    for (const s of [s1, s2, s3]) {
      expect(s.join).toHaveBeenCalledWith('channel:ch-1');
    }
  });

  it('is a no-op when no sockets are connected', async () => {
    mockFetchSockets.mockResolvedValueOnce([]);

    await syncChannelVisibilityRooms('server-1');

    expect(mockPrisma.channel.findMany).not.toHaveBeenCalled();
  });

  it('skips sockets without a userId', async () => {
    const anonymous = { data: {}, join: vi.fn(), leave: vi.fn() };
    mockFetchSockets.mockResolvedValueOnce([anonymous]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(anonymous.join).not.toHaveBeenCalled();
    expect(anonymous.leave).not.toHaveBeenCalled();
  });

  it('never throws — errors are logged so the originating mutation still succeeds', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchSockets.mockRejectedValueOnce(new Error('adapter down'));

    await expect(syncChannelVisibilityRooms('server-1')).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
