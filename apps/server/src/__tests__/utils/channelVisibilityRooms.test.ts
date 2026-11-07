import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockIn, mockTo, mockFetchSockets, mockPrisma, mockFilterForUsers, mockGetIO, mockVoiceStates, mockReplay } = vi.hoisted(() => {
  const mockFetchSockets = vi.fn();
  const mockIn = vi.fn();
  return {
    mockIn,
    mockTo: vi.fn(),
    mockFetchSockets,
    mockFilterForUsers: vi.fn(),
    mockGetIO: vi.fn(),
    mockVoiceStates: vi.fn(),
    mockReplay: vi.fn(),
    mockPrisma: {
      channel: { findMany: vi.fn() },
      serverMember: { findUnique: vi.fn() },
    },
  };
});

vi.mock('../../websocket/socketServer', () => ({
  getIO: mockGetIO,
}));

vi.mock('../../websocket/voiceHandler', () => ({
  getVoiceStateForServers: mockVoiceStates,
  replayVoiceState: mockReplay,
}));

vi.mock('../../utils/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../utils/permissionCalculator', () => ({
  filterVisibleChannelsForUsers: mockFilterForUsers,
}));

import { syncChannelVisibilityRooms } from '../../utils/channelVisibilityRooms';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSocket(userId: string, opts?: { voiceChannelId?: string; rooms?: string[] }) {
  return {
    data: { userId, voiceChannelId: opts?.voiceChannelId },
    // fetchSockets() serialises `rooms` onto every RemoteSocket; the real
    // shape always carries it, so the default mirrors a socket in no voice room
    rooms: new Set(opts?.rooms ?? [userId === 'any' ? '' : `user:${userId}`]),
    join: vi.fn(),
    leave: vi.fn(),
  };
}

function resetMocks() {
  vi.clearAllMocks();
  mockGetIO.mockReturnValue({ in: mockIn, to: mockTo });
  mockIn.mockReturnValue({ fetchSockets: mockFetchSockets });
  mockTo.mockImplementation((room: string) => ({ room, emit: vi.fn() }));
  mockFetchSockets.mockResolvedValue([]);
  // Default: nobody is in voice anywhere on the server
  mockVoiceStates.mockResolvedValue([]);
  mockReplay.mockResolvedValue(undefined);
  mockPrisma.channel.findMany.mockResolvedValue([]);
  mockPrisma.serverMember.findUnique.mockResolvedValue({ userId: 'any' });
  // Default: everyone sees every channel
  mockFilterForUsers.mockImplementation(
    async (userIds: string[], _sid: string, channels: { id: string }[]) =>
      new Map(userIds.map((u) => [u, new Set(channels.map((c) => c.id))])),
  );
}

/** Build the userId → visible-channel-id-set map the batched helper returns. */
function visibility(map: Record<string, string[]>) {
  return new Map(Object.entries(map).map(([u, ids]) => [u, new Set(ids)]));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('syncChannelVisibilityRooms', () => {
  beforeEach(resetMocks);

  it('joins visible channels and leaves non-visible ones for each member socket', async () => {
    const socket = createMockSocket('user-1');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-pub' }, { id: 'ch-priv' }]);
    mockFilterForUsers.mockResolvedValueOnce(visibility({ 'user-1': ['ch-pub'] }));

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
    // Membership is re-verified INSIDE the batch now: a non-member comes back
    // with an empty visible set rather than costing a separate query
    mockFilterForUsers.mockResolvedValueOnce(visibility({ 'user-9': [] }));

    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-1');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-2');
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('never removes a socket from the room of the voice channel it is actively in', async () => {
    const socket = createMockSocket('user-1', { voiceChannelId: 'ch-voice' });
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    // User lost visibility to BOTH channels
    mockFilterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-text');
    expect(socket.leave).not.toHaveBeenCalledWith('channel:ch-voice');
  });

  // A participant whose channel's Router lives on ANOTHER node never gets
  // socket.data.voiceChannelId on their home socket — that field is written
  // on the owner node's shim and is, on the home node, the local-vs-relayed
  // discriminator that must stay unset. The shim's join does put the real
  // socket in voice:{id} (io.in(socketId).socketsJoin), and fetchSockets()
  // serialises rooms onto the RemoteSocket, so room membership is the
  // node-independent signal. The old guard cut relayed participants off from
  // channel:{id} — where every voice presence event is broadcast — mid-call.
  it('keeps a CROSS-NODE voice participant (voice room, no data.voiceChannelId) in the channel room', async () => {
    const relayed = createMockSocket('user-1', { rooms: ['user:user-1', 'voice:ch-voice', 'channel:ch-voice'] });
    mockFetchSockets.mockResolvedValueOnce([relayed]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    mockFilterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(relayed.data.voiceChannelId).toBeUndefined();
    expect(relayed.leave).toHaveBeenCalledWith('channel:ch-text');
    expect(relayed.leave).not.toHaveBeenCalledWith('channel:ch-voice');
  });

  it('still leaves the channel room of a voice channel the socket is NOT in, by either signal', async () => {
    const bystander = createMockSocket('user-1', { rooms: ['user:user-1', 'voice:ch-other'] });
    mockFetchSockets.mockResolvedValueOnce([bystander]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    mockFilterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(bystander.leave).toHaveBeenCalledWith('channel:ch-voice');
  });

  it('computes visibility once per user, applying to all their sockets (multi-device)', async () => {
    const s1 = createMockSocket('user-1');
    const s2 = createMockSocket('user-1');
    const s3 = createMockSocket('user-2');
    mockFetchSockets.mockResolvedValueOnce([s1, s2, s3]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    // F6: ONE batched recompute covering both users, not one call per user —
    // the per-user loop fired 4-5 sequential queries each and a single role
    // edit on a large server turned into ~20k of them.
    expect(mockFilterForUsers).toHaveBeenCalledTimes(1);
    expect(mockFilterForUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['user-1', 'user-2']), 'server-1', [{ id: 'ch-1' }],
    );
    for (const s of [s1, s2, s3]) {
      expect(s.join).toHaveBeenCalledWith('channel:ch-1');
    }
  });

  it('stays at ONE batched recompute regardless of how many users are connected', async () => {
    const sockets = Array.from({ length: 120 }, (_, i) => createMockSocket(`user-${i}`));
    mockFetchSockets.mockResolvedValueOnce(sockets);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(mockFilterForUsers).toHaveBeenCalledTimes(1);
    expect(mockFilterForUsers.mock.calls[0][0]).toHaveLength(120);
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

  // ── Voice occupancy replay on a gained room ──────────────────────────────
  //
  // A socket that ENTERS a channel room here missed every voice event in it,
  // like one that just connected: the occupants are replayed as a snapshot.

  const occupied = (channelId: string) => [{ channelId, serverId: 'server-1', userIds: ['u-9'], userStates: new Map() }];

  it('replays the occupants of an OCCUPIED channel a socket just gained, as a connect-style snapshot to the user room', async () => {
    const socket = createMockSocket('user-1');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    mockVoiceStates.mockResolvedValueOnce(occupied('ch-voice'));

    await syncChannelVisibilityRooms('server-1');

    expect(mockVoiceStates).toHaveBeenCalledWith(['server-1']);
    expect(socket.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(mockTo).toHaveBeenCalledWith('user:user-1');
    expect(mockReplay).toHaveBeenCalledTimes(1);
    expect(mockReplay).toHaveBeenCalledWith(expect.objectContaining({ room: 'user:user-1' }), ['server-1'], new Set(['ch-voice']), { source: 'connect' });
  });

  it('does not replay to a socket ALREADY in the room, nor for an affected channel nobody is in', async () => {
    const already = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-voice'] });
    const fresh = createMockSocket('user-2');
    mockFetchSockets.mockResolvedValueOnce([already, fresh]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-empty' }]);
    mockVoiceStates.mockResolvedValueOnce(occupied('ch-voice'));

    await syncChannelVisibilityRooms('server-1');

    // Both are (re)joined; only the socket that ENTERED the occupied room is replayed
    expect(already.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(fresh.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(mockReplay).toHaveBeenCalledTimes(1);
    expect(mockReplay).toHaveBeenCalledWith(expect.objectContaining({ room: 'user:user-2' }), ['server-1'], new Set(['ch-voice']), { source: 'connect' });
  });

  it('a socket that only LOST visibility is never replayed', async () => {
    const socket = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-voice'] });
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    mockVoiceStates.mockResolvedValueOnce(occupied('ch-voice'));
    mockFilterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-voice');
    expect(mockReplay).not.toHaveBeenCalled();
  });

  it('with nobody in voice: ONE occupancy read and no replay at all — a role edit on a big server stays one round trip', async () => {
    const sockets = Array.from({ length: 40 }, (_, i) => createMockSocket(`user-${i}`));
    mockFetchSockets.mockResolvedValueOnce(sockets);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(mockVoiceStates).toHaveBeenCalledTimes(1);
    expect(mockReplay).not.toHaveBeenCalled();
    for (const s of sockets) expect(s.join).toHaveBeenCalledWith('channel:ch-1');
  });

  it('a failing occupancy read or replay is logged; the rooms are still synced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = createMockSocket('user-1');
    mockFetchSockets.mockResolvedValueOnce([socket]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    mockVoiceStates.mockRejectedValueOnce(new Error('redis away'));

    await syncChannelVisibilityRooms('server-1');

    expect(socket.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(mockReplay).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[Visibility] Could not read voice occupancy for the replay:', 'redis away');

    const socket2 = createMockSocket('user-2');
    mockFetchSockets.mockResolvedValueOnce([socket2]);
    mockPrisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    mockVoiceStates.mockResolvedValueOnce(occupied('ch-voice'));
    mockReplay.mockRejectedValueOnce(new Error('emit failed'));

    await syncChannelVisibilityRooms('server-1');

    expect(socket2.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(warn).toHaveBeenCalledWith('[Visibility] Could not replay voice occupancy to', 'user-2', '(the rooms are joined):', 'emit failed');
    warn.mockRestore();
  });
});
