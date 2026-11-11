import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  // io.in(...) — the CLUSTER-WIDE operator: only the fallback may use it, and
  // its fetchSockets (which waits on every node) must never be called
  clusterIn: vi.fn(),
  clusterFetch: vi.fn(),
  clusterExcept: vi.fn(),
  clusterLeave: vi.fn(),
  // io.in(users).socketsLeave(rooms) — the grouped text-channel leave
  clusterGroupLeave: vi.fn(),
  // io.local.in(...) — this node's sockets
  localIn: vi.fn(),
  localFetch: vi.fn(),
  // io.local.in(...).except(...).socketsLeave(...) — the fail-closed end of a channel's pass
  localExcept: vi.fn(),
  localLeave: vi.fn(),
  localTo: vi.fn(),
  to: vi.fn(),
  getIO: vi.fn(),
  filterForUsers: vi.fn(),
  voiceStates: vi.fn(),
  replay: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  liveNodeCounts: vi.fn(),
  prisma: {
    channel: { findMany: vi.fn() },
    serverMember: { findMany: vi.fn() },
  },
}));

vi.mock('../../websocket/socketServer', () => ({ getIO: m.getIO }));

vi.mock('../../websocket/voiceHandler', () => ({
  getVoiceStateForServers: m.voiceStates,
  replayVoiceState: m.replay,
}));

vi.mock('../../utils/prisma', () => ({ prisma: m.prisma }));

vi.mock('../../utils/permissionCalculator', () => ({
  filterVisibleChannelsForUsers: m.filterForUsers,
}));

vi.mock('../../utils/redis', () => ({
  getRedisPubSub: () => ({ pub: { publish: m.publish } }),
  getRedisConfigSub: () => ({ subscribe: m.subscribe }),
  liveNodeCounts: m.liveNodeCounts,
  NODE_ID: () => 'node-a',
}));

import {
  syncChannelVisibilityRooms,
  initChannelVisibilitySync,
  VISIBILITY_RESYNC_CHANNEL,
  RESYNC_PUBLISH_ATTEMPTS,
  RESYNC_RETRY_DELAYS_MS,
  RESYNC_PUBLISH_TIMEOUT_MS,
  LOCAL_PASS_MAX_WAIT_MS,
  LIVE_NODES_MEMO_MS,
  LOCAL_PASS_RETRY_DELAYS_MS,
  REQUEST_SPACES_MAX,
  visibilityRequestMark,
  resyncAfterJoins,
  resyncRequestedSince,
  _resetChannelVisibilityForTests,
} from '../../utils/channelVisibilityRooms';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSocket(userId: string, opts?: { voiceChannelId?: string; rooms?: string[] }) {
  return {
    data: { userId, voiceChannelId: opts?.voiceChannelId },
    // A local fetchSockets() returns the real sockets, whose `rooms` is this
    // node's live set; the default mirrors a socket in no voice room
    rooms: new Set(opts?.rooms ?? [userId === 'any' ? '' : `user:${userId}`]),
    join: vi.fn(),
    leave: vi.fn(),
    disconnect: vi.fn(),
  };
}

function resetMocks() {
  // reset, not clear: a once-queue a test left unconsumed must not leak
  vi.resetAllMocks();
  _resetChannelVisibilityForTests();
  m.getIO.mockReturnValue({ in: m.clusterIn, to: m.to, local: { in: m.localIn, to: m.localTo } });
  m.clusterIn.mockReturnValue({ fetchSockets: m.clusterFetch, except: m.clusterExcept, socketsLeave: m.clusterGroupLeave });
  m.clusterExcept.mockReturnValue({ socketsLeave: m.clusterLeave });
  // A peer that never answers: anything that awaited this would hang
  m.clusterFetch.mockReturnValue(new Promise(() => {}));
  m.localIn.mockReturnValue({ fetchSockets: m.localFetch, except: m.localExcept });
  m.localExcept.mockReturnValue({ socketsLeave: m.localLeave });
  m.localTo.mockImplementation((room: string) => ({ room, local: true, emit: vi.fn() }));
  m.to.mockImplementation((room: string) => ({ room, emit: vi.fn() }));
  m.localFetch.mockResolvedValue([]);
  // Default: nobody is in voice anywhere on the server
  m.voiceStates.mockResolvedValue([]);
  m.replay.mockResolvedValue(undefined);
  m.prisma.channel.findMany.mockResolvedValue([]);
  m.prisma.serverMember.findMany.mockResolvedValue([]);
  // Default: a sole node whose own subscriber receives the message
  m.publish.mockResolvedValue(1);
  m.liveNodeCounts.mockResolvedValue({ total: 1, peers: 0 });
  m.subscribe.mockResolvedValue(undefined);
  // Default: everyone sees every channel
  m.filterForUsers.mockImplementation(
    async (userIds: string[], _sid: string, channels: { id: string }[]) =>
      new Map(userIds.map((u) => [u, new Set(channels.map((c) => c.id))])),
  );
}

/** Build the userId → visible-channel-id-set map the batched helper returns. */
function visibility(map: Record<string, string[]>) {
  return new Map(Object.entries(map).map(([u, ids]) => [u, new Set(ids)]));
}

/** The resync messages this node published, parsed. */
function published(): Array<Record<string, unknown>> {
  return m.publish.mock.calls.map(([channel, payload]) => {
    expect(channel).toBe(VISIBILITY_RESYNC_CHANNEL);
    return JSON.parse(payload as string) as Record<string, unknown>;
  });
}

// ─── This node's sockets ────────────────────────────────────────────────────

describe('syncChannelVisibilityRooms — this node\'s sockets', () => {
  beforeEach(resetMocks);

  it('joins visible channels and leaves non-visible ones for each member socket', async () => {
    const socket = createMockSocket('user-1');
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-pub' }, { id: 'ch-priv' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-1': ['ch-pub'] }));

    await syncChannelVisibilityRooms('server-1');

    expect(m.localIn).toHaveBeenCalledWith('server:server-1');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-pub');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-priv');
    expect(socket.join).not.toHaveBeenCalledWith('channel:ch-priv');
  });

  // Issue #71: the cluster-wide snapshot waited for every node's reply and
  // rejected after 5 s when one peer did not answer; the catch skipped the
  // resync everywhere, so the revoked member kept the room. Here the
  // cluster-wide fetch never settles: the old code hung on it (and with the
  // adapter's timeout, failed open); this node now never asks for it.
  it('removes a revoked member from the room on this node even when a peer never answers a cluster snapshot', async () => {
    const revoked = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-priv'] });
    m.localFetch.mockResolvedValueOnce([revoked]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-priv' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(revoked.leave).toHaveBeenCalledWith('channel:ch-priv');
    expect(m.clusterFetch).not.toHaveBeenCalled();
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('scopes the channel query when channelId is given (override change)', async () => {
    const socket = createMockSocket('user-1');
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1', { channelId: 'ch-1' });

    expect(m.prisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'server-1', id: 'ch-1' },
      select: { id: true, secure: true },
    });
  });

  it('fetches only the target user\'s sockets on this node when userId is given (member role change)', async () => {
    const socket = createMockSocket('user-9');
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });

    expect(m.localIn).toHaveBeenCalledWith('user:user-9');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-1');
  });

  it('when scoped by userId and the user is no longer a member, leaves ALL channel rooms', async () => {
    const socket = createMockSocket('user-9');
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }]);
    // Membership is re-verified INSIDE the batch: a non-member comes back
    // with an empty visible set rather than costing a separate query
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-9': [] }));

    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-1');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-2');
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('never removes a socket from the room of the voice channel it is actively in', async () => {
    const socket = createMockSocket('user-1', { voiceChannelId: 'ch-voice', rooms: ['user:user-1', 'voice:ch-voice', 'channel:ch-voice'] });
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    // User lost visibility to BOTH channels
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-text');
    expect(socket.leave).not.toHaveBeenCalledWith('channel:ch-voice');
  });

  // A participant whose channel's Router lives on ANOTHER node never gets
  // socket.data.voiceChannelId on their home socket — that field is written
  // on the owner node's shim and is, on the home node, the local-vs-relayed
  // discriminator that must stay unset. The shim's join does put the real
  // socket in voice:{id} (io.in(socketId).socketsJoin, applied by the adapter
  // on the home node), and the home node is the one resyncing that socket.
  it('keeps a CROSS-NODE voice participant (voice room, no data.voiceChannelId) in the channel room', async () => {
    const relayed = createMockSocket('user-1', { rooms: ['user:user-1', 'voice:ch-voice', 'channel:ch-voice'] });
    m.localFetch.mockResolvedValueOnce([relayed]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(relayed.data.voiceChannelId).toBeUndefined();
    expect(relayed.leave).toHaveBeenCalledWith('channel:ch-text');
    expect(relayed.leave).not.toHaveBeenCalledWith('channel:ch-voice');
  });

  it('still leaves the channel room of a voice channel the socket is NOT in, by either signal', async () => {
    const bystander = createMockSocket('user-1', { rooms: ['user:user-1', 'voice:ch-other'] });
    m.localFetch.mockResolvedValueOnce([bystander]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(bystander.leave).toHaveBeenCalledWith('channel:ch-voice');
  });

  it('computes visibility once per user, applying to all their sockets (multi-device)', async () => {
    const s1 = createMockSocket('user-1');
    const s2 = createMockSocket('user-1');
    const s3 = createMockSocket('user-2');
    m.localFetch.mockResolvedValueOnce([s1, s2, s3]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    // F6: ONE batched recompute covering both users, not one call per user —
    // the per-user loop fired 4-5 sequential queries each and a single role
    // edit on a large server turned into ~20k of them.
    expect(m.filterForUsers).toHaveBeenCalledTimes(1);
    expect(m.filterForUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['user-1', 'user-2']), 'server-1', [{ id: 'ch-1' }],
    );
    for (const s of [s1, s2, s3]) {
      expect(s.join).toHaveBeenCalledWith('channel:ch-1');
    }
  });

  it('stays at ONE batched recompute regardless of how many users are connected', async () => {
    const sockets = Array.from({ length: 120 }, (_, i) => createMockSocket(`user-${i}`));
    m.localFetch.mockResolvedValueOnce(sockets);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(m.filterForUsers).toHaveBeenCalledTimes(1);
    expect(m.filterForUsers.mock.calls[0][0]).toHaveLength(120);
  });

  it('with no socket on this node: no local work, and the peers are still told', async () => {
    m.localFetch.mockResolvedValueOnce([]);

    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });

    expect(m.prisma.channel.findMany).not.toHaveBeenCalled();
    // The member may well be connected to ANOTHER node: the early return of
    // the local pass must never skip the fan-out
    expect(published()).toEqual([expect.objectContaining({ serverId: 'server-1', userId: 'user-9' })]);
  });

  it('skips sockets without a userId', async () => {
    const anonymous = { data: {}, join: vi.fn(), leave: vi.fn() };
    m.localFetch.mockResolvedValueOnce([anonymous]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(anonymous.join).not.toHaveBeenCalled();
    expect(anonymous.leave).not.toHaveBeenCalled();
  });

  it('never throws — a local failure is logged and the peers are still told', async () => {
    vi.useFakeTimers(); // the failure queues a repeat: keep it inside this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      m.localFetch.mockResolvedValueOnce([createMockSocket('user-1')]);
      m.prisma.channel.findMany.mockRejectedValueOnce(new Error('db down'));

      await expect(syncChannelVisibilityRooms('server-1')).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Visibility] Failed to resync this node\'s channel rooms for server server-1'), expect.any(Error));
      expect(m.publish).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      consoleSpy.mockRestore();
      warn.mockRestore();
    }
  });

  // ── Ordering of overlapping passes on one node ───────────────────────────

  it('runs one server\'s passes on this node one after another: a slow earlier pass cannot re-join a member a later pass removed', async () => {
    const socket = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-priv'] });
    m.localFetch.mockResolvedValue([socket]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-priv' }]);
    // The space-wide pass read the member's roles before they were taken away, and is slow
    let releaseFirst!: (visible: Map<string, Set<string>>) => void;
    m.filterForUsers
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(visibility({ 'user-1': [] }));

    const first = syncChannelVisibilityRooms('server-order');
    const second = syncChannelVisibilityRooms('server-order', { userId: 'user-1' });
    await vi.waitFor(() => expect(m.filterForUsers).toHaveBeenCalledTimes(1));
    // The later pass has not even looked at this node's sockets yet
    expect(m.localFetch).toHaveBeenCalledTimes(1);

    releaseFirst(visibility({ 'user-1': ['ch-priv'] }));
    await Promise.all([first, second]);

    expect(m.localFetch).toHaveBeenCalledTimes(2);
    expect(socket.join).toHaveBeenCalledWith('channel:ch-priv');
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-priv');
    // The later pass has the last word: the revocation stands
    expect(socket.leave.mock.invocationCallOrder[0]).toBeGreaterThan(socket.join.mock.invocationCallOrder[0]);
  });

  it('a pass for another server is not held behind a slow one', async () => {
    m.localFetch.mockResolvedValue([createMockSocket('user-1')]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
    m.filterForUsers.mockImplementationOnce(() => new Promise(() => {}));

    void syncChannelVisibilityRooms('server-stuck-a');
    await vi.waitFor(() => expect(m.filterForUsers).toHaveBeenCalledTimes(1));
    await syncChannelVisibilityRooms('server-free');

    expect(m.filterForUsers).toHaveBeenCalledTimes(2);
    expect(m.filterForUsers).toHaveBeenLastCalledWith(['user-1'], 'server-free', [{ id: 'ch-1' }]);
  });

  it('a pass stuck for LOCAL_PASS_MAX_WAIT_MS no longer holds the next one for its server (logged)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      m.localFetch.mockResolvedValue([createMockSocket('user-1')]);
      m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
      m.filterForUsers.mockImplementationOnce(() => new Promise(() => {}));

      void syncChannelVisibilityRooms('server-stuck-b');
      await vi.advanceTimersByTimeAsync(0);
      const next = syncChannelVisibilityRooms('server-stuck-b');
      await vi.advanceTimersByTimeAsync(LOCAL_PASS_MAX_WAIT_MS - 1);
      expect(m.filterForUsers).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await next;

      expect(m.filterForUsers).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`previous resync of server server-stuck-b on this node is still running after ${LOCAL_PASS_MAX_WAIT_MS} ms`));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  // Review of #71: the waited-out pass read the database before the one that
  // ran past it, and its late joins undid that pass's revocation.
  // The bound used to run from the moment a pass was QUEUED: behind two
  // healthy 20 s passes, the third gave up at 30 s on the second, which had
  // started at 20 s, and that pass's joins were dropped as "overtaken".
  it('a backlog of healthy passes runs in order: the bound counts from the predecessor\'s start, not from the queueing', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = createMockSocket('user-1');
      m.localFetch.mockResolvedValue([socket]);
      m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
      const startedAt: number[] = [];
      m.filterForUsers.mockImplementation(() => {
        startedAt.push(Date.now());
        return new Promise((resolve) => setTimeout(() => resolve(visibility({ 'user-1': ['ch-1'] })), 20_000));
      });
      const t0 = Date.now();

      const runs = [syncChannelVisibilityRooms('server-busy'), syncChannelVisibilityRooms('server-busy'), syncChannelVisibilityRooms('server-busy')];
      await vi.advanceTimersByTimeAsync(70_000);
      await Promise.all(runs);

      expect(startedAt.map((at) => at - t0)).toEqual([0, 20_000, 40_000]);
      expect(socket.join).toHaveBeenCalledTimes(3);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('still running'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('applied its leaves only'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('a pass that was waited out applies its leaves only when it finally finishes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-a', 'channel:ch-b'] });
      m.localFetch.mockResolvedValue([socket]);
      m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-a' }, { id: 'ch-b' }]);
      let releaseStale!: (visible: Map<string, Set<string>>) => void;
      // Every read after the stale one sees the revocation (the fresh pass
      // queued after the stale one finishes reads it too)
      m.filterForUsers.mockResolvedValue(visibility({ 'user-1': [] }));
      m.filterForUsers.mockImplementationOnce(() => new Promise((resolve) => { releaseStale = resolve; }));

      const stale = syncChannelVisibilityRooms('server-stuck-c');
      await vi.advanceTimersByTimeAsync(0);
      const fresh = syncChannelVisibilityRooms('server-stuck-c', { userId: 'user-1' });
      await vi.advanceTimersByTimeAsync(LOCAL_PASS_MAX_WAIT_MS);
      await fresh;
      expect(socket.leave).toHaveBeenCalledWith('channel:ch-a');

      // The stale read: ch-a still visible, ch-b hidden
      releaseStale(visibility({ 'user-1': ['ch-a'] }));
      await stale;

      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.leave).toHaveBeenCalledWith('channel:ch-b');
      expect(warn).toHaveBeenCalledWith('[Visibility] A resync of server server-stuck-c overtaken on this node applied its leaves only (1 join(s) skipped)');
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.join).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  // Review of #71: an overtaken pass was never queued again, so a grant its
  // late leaves undid stayed undone until the member opened the channel or
  // reconnected (for a voice channel, only a reconnect).
  it('an overtaken pass, once finished, queues a fresh pass of its scope that gives back what its late leaves took', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = createMockSocket('user-1', { rooms: ['user:user-1'] });
      m.localFetch.mockResolvedValue([socket]);
      m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-a' }]);
      let releaseStale!: (visible: Map<string, Set<string>>) => void;
      // The truth after the stale read: ch-a granted
      m.filterForUsers.mockResolvedValue(visibility({ 'user-1': ['ch-a'] }));
      m.filterForUsers.mockImplementationOnce(() => new Promise((resolve) => { releaseStale = resolve; }));

      const stale = syncChannelVisibilityRooms('server-stuck-d');
      await vi.advanceTimersByTimeAsync(0);
      const grant = syncChannelVisibilityRooms('server-stuck-d', { userId: 'user-1' });
      await vi.advanceTimersByTimeAsync(LOCAL_PASS_MAX_WAIT_MS);
      await grant;
      expect(socket.join).toHaveBeenCalledTimes(1);

      // The stale read, from before the grant: its late leave undoes it
      releaseStale(visibility({ 'user-1': [] }));
      await stale;
      await vi.advanceTimersByTimeAsync(0);

      expect(socket.leave).toHaveBeenCalledWith('channel:ch-a');
      expect(warn).toHaveBeenCalledWith('[Visibility] An overtaken resync of server server-stuck-d on this node finished late; a fresh pass of its scope is queued');
      expect(m.filterForUsers).toHaveBeenCalledTimes(3);
      expect(m.localIn).toHaveBeenLastCalledWith('server:server-stuck-d');
      expect(socket.join).toHaveBeenCalledTimes(2);
      expect(socket.join.mock.invocationCallOrder[1]).toBeGreaterThan(socket.leave.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  // ── Voice occupancy replay on a gained room ──────────────────────────────
  //
  // A socket that ENTERS a channel room here missed every voice event in it,
  // like one that just connected: the occupants are replayed as a snapshot.

  const occupied = (channelId: string) => [{ channelId, serverId: 'server-1', userIds: ['u-9'], userStates: new Map() }];

  it('replays the occupants of an OCCUPIED channel a socket just gained, as a connect-style snapshot to THIS node\'s sockets of the user', async () => {
    const socket = createMockSocket('user-1');
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-text' }]);
    m.voiceStates.mockResolvedValueOnce(occupied('ch-voice'));

    await syncChannelVisibilityRooms('server-1');

    expect(m.voiceStates).toHaveBeenCalledWith(['server-1']);
    expect(socket.join).toHaveBeenCalledWith('channel:ch-voice');
    // Every node replays to its own sockets: a cluster-wide emit would reach
    // the user's sockets on the other nodes once per node
    expect(m.localTo).toHaveBeenCalledWith('user:user-1');
    expect(m.to).not.toHaveBeenCalled();
    expect(m.replay).toHaveBeenCalledTimes(1);
    expect(m.replay).toHaveBeenCalledWith(expect.objectContaining({ room: 'user:user-1', local: true }), ['server-1'], new Set(['ch-voice']), { source: 'connect' });
  });

  it('does not replay to a socket ALREADY in the room, nor for an affected channel nobody is in', async () => {
    const already = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-voice'] });
    const fresh = createMockSocket('user-2');
    m.localFetch.mockResolvedValueOnce([already, fresh]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }, { id: 'ch-empty' }]);
    m.voiceStates.mockResolvedValueOnce(occupied('ch-voice'));

    await syncChannelVisibilityRooms('server-1');

    // Both are (re)joined; only the socket that ENTERED the occupied room is replayed
    expect(already.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(fresh.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(m.replay).toHaveBeenCalledTimes(1);
    expect(m.replay).toHaveBeenCalledWith(expect.objectContaining({ room: 'user:user-2' }), ['server-1'], new Set(['ch-voice']), { source: 'connect' });
  });

  it('a socket that only LOST visibility is never replayed', async () => {
    const socket = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-voice'] });
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    m.voiceStates.mockResolvedValueOnce(occupied('ch-voice'));
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-voice');
    expect(m.replay).not.toHaveBeenCalled();
  });

  it('with nobody in voice: ONE occupancy read and no replay at all — a role edit on a big server stays one round trip', async () => {
    const sockets = Array.from({ length: 40 }, (_, i) => createMockSocket(`user-${i}`));
    m.localFetch.mockResolvedValueOnce(sockets);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }]);

    await syncChannelVisibilityRooms('server-1');

    expect(m.voiceStates).toHaveBeenCalledTimes(1);
    expect(m.replay).not.toHaveBeenCalled();
    for (const s of sockets) expect(s.join).toHaveBeenCalledWith('channel:ch-1');
  });

  it('a failing occupancy read or replay is logged; the rooms are still synced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = createMockSocket('user-1');
    m.localFetch.mockResolvedValueOnce([socket]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    m.voiceStates.mockRejectedValueOnce(new Error('redis away'));

    await syncChannelVisibilityRooms('server-1');

    expect(socket.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(m.replay).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[Visibility] Could not read voice occupancy for the replay:', 'redis away');

    const socket2 = createMockSocket('user-2');
    m.localFetch.mockResolvedValueOnce([socket2]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-voice' }]);
    m.voiceStates.mockResolvedValueOnce(occupied('ch-voice'));
    m.replay.mockRejectedValueOnce(new Error('emit failed'));

    await syncChannelVisibilityRooms('server-1');

    expect(socket2.join).toHaveBeenCalledWith('channel:ch-voice');
    expect(warn).toHaveBeenCalledWith('[Visibility] Could not replay voice occupancy to', 'user-2', '(the rooms are joined):', 'emit failed');
    warn.mockRestore();
  });
});

// ─── The fan-out to the other nodes ─────────────────────────────────────────

describe('syncChannelVisibilityRooms — telling the other nodes', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['server-wide (role permission edit, role delete)', undefined, { serverId: 'server-1' }],
    ['one channel (override change)', { channelId: 'ch-1' }, { serverId: 'server-1', channelId: 'ch-1' }],
    ['one member (role assignment, ownership transfer)', { userId: 'user-9' }, { serverId: 'server-1', userId: 'user-9' }],
  ])('publishes the scope once, tagged with a request id and this node, when every live node received it: %s', async (_label, opts, scope) => {
    await syncChannelVisibilityRooms('server-1', opts);

    const [message] = published();
    expect(m.publish).toHaveBeenCalledTimes(1);
    expect(message).toEqual({ ...scope, id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), fromNode: 'node-a' });
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('gives every request its own id', async () => {
    await syncChannelVisibilityRooms('server-1');
    await syncChannelVisibilityRooms('server-1');

    const [a, b] = published();
    expect(a.id).not.toBe(b.id);
  });

  it('a receiver count below the live nodes is retried with the SAME message, and stops once every node has it', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Two nodes are live; the peer's subscriber is reconnecting at the first publish
    m.liveNodeCounts.mockResolvedValue({ total: 2, peers: 1 });
    m.publish.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS[0]);
    await done;

    expect(m.publish).toHaveBeenCalledTimes(2);
    expect(m.publish.mock.calls[1][1]).toBe(m.publish.mock.calls[0][1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempt 1/4: 1 subscriber(s) received it, 2 node(s) are live'));
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('a rejected publish is retried after each documented delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.publish
      .mockRejectedValueOnce(new Error('Socket closed unexpectedly'))
      .mockRejectedValueOnce(new Error('Socket closed unexpectedly'))
      .mockResolvedValueOnce(1);

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(m.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS[0] - 1);
    expect(m.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS[1]);
    expect(m.publish).toHaveBeenCalledTimes(3);
    await done;

    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('a publish Redis never answers (offline queue) counts as failed after the timeout, and the next attempt goes out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.publish.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(1);

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_PUBLISH_TIMEOUT_MS + RESYNC_RETRY_DELAYS_MS[0]);
    await done;

    expect(m.publish).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`no answer from Redis within ${RESYNC_PUBLISH_TIMEOUT_MS} ms`));
  });

  it('a failing heartbeat count fails the attempt like a failed publish', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.liveNodeCounts.mockRejectedValueOnce(new Error('scan failed'));

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS[0]);
    await done;

    expect(m.publish).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempt 1/4: scan failed'));
  });

  // ── What counts as confirmed ─────────────────────────────────────────────

  /** One confirmed resync, which leaves `expected` in the count's cache. */
  async function primeCount(peers: number) {
    m.liveNodeCounts.mockResolvedValueOnce({ total: peers + 1, peers });
    m.publish.mockResolvedValueOnce(peers + 1);
    await syncChannelVisibilityRooms('server-0');
    vi.clearAllMocks();
    m.liveNodeCounts.mockResolvedValue({ total: peers + 1, peers });
    m.publish.mockResolvedValue(peers + 1);
  }

  // Review of #71: `received >= expected` read a surplus as "everyone and
  // then some". A node booted inside the cached count (or shutting down after
  // deleting its heartbeat) receives too, and can hide a node that missed it.
  it('more receivers than the cached count is checked against a fresh count, and retried when a node is still missing', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await primeCount(1); // cached: 2 nodes
    // Now 4 nodes are live; 3 received it (one subscriber reconnecting)
    m.liveNodeCounts.mockResolvedValue({ total: 4, peers: 3 });
    m.publish.mockResolvedValueOnce(3).mockResolvedValueOnce(4);

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS[0]);
    await done;

    expect(m.publish).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempt 1/4: 3 subscriber(s) received it, 4 node(s) are live'));
  });

  it('a surplus the fresh count explains (a node that just booted) is confirmed at once', async () => {
    await primeCount(1); // cached: 2 nodes
    m.liveNodeCounts.mockResolvedValue({ total: 3, peers: 2 });
    m.publish.mockResolvedValueOnce(3);

    await syncChannelVisibilityRooms('server-1');

    expect(m.publish).toHaveBeenCalledTimes(1);
    expect(m.liveNodeCounts).toHaveBeenCalledTimes(1);
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('more receivers than even the fresh count (a node shutting down, heartbeat already deleted) is retried', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.liveNodeCounts.mockResolvedValue({ total: 2, peers: 1 });
    m.publish.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS[0]);
    await done;

    expect(m.publish).toHaveBeenCalledTimes(2);
  });

  it('one receiver fewer right after a node stopped cleanly is confirmed by the fresh count, with no retry and no fallback', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await primeCount(1); // cached: 2 nodes
    // The peer stopped and deleted its heartbeat: one node, one receiver
    m.liveNodeCounts.mockResolvedValue({ total: 1, peers: 0 });
    m.publish.mockResolvedValue(1);

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await done;

    expect(m.publish).toHaveBeenCalledTimes(1);
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  // ── The live-node count (a SCAN over the whole keyspace) ─────────────────

  it('counts the live nodes once for the resyncs of a few seconds, and again after LIVE_NODES_MEMO_MS', async () => {
    vi.useFakeTimers();

    await syncChannelVisibilityRooms('server-1');
    await syncChannelVisibilityRooms('server-1', { userId: 'user-9' });
    expect(m.liveNodeCounts).toHaveBeenCalledTimes(1);
    expect(m.publish).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(LIVE_NODES_MEMO_MS);
    await syncChannelVisibilityRooms('server-1');
    expect(m.liveNodeCounts).toHaveBeenCalledTimes(2);
  });

  it('resyncs started together share one count', async () => {
    await Promise.all([syncChannelVisibilityRooms('server-1'), syncChannelVisibilityRooms('server-2')]);

    expect(m.liveNodeCounts).toHaveBeenCalledTimes(1);
    expect(m.publish).toHaveBeenCalledTimes(2);
  });

  it('a slow count an attempt gave up on is the one the next attempt awaits, never a second scan', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.liveNodeCounts.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ total: 1, peers: 0 }), RESYNC_PUBLISH_TIMEOUT_MS + RESYNC_RETRY_DELAYS_MS[0] + 100);
    }));

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_PUBLISH_TIMEOUT_MS + RESYNC_RETRY_DELAYS_MS[0] + 100);
    await done;

    expect(m.publish).toHaveBeenCalledTimes(2);
    expect(m.liveNodeCounts).toHaveBeenCalledTimes(1);
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  // ── The fail-closed fallback ─────────────────────────────────────────────

  /** Run a resync whose every publish fails, through all the retries. */
  async function runUnconfirmed(opts?: { channelId?: string; userId?: string }) {
    vi.useFakeTimers();
    m.publish.mockRejectedValue(new Error('redis away'));
    const done = syncChannelVisibilityRooms('server-1', opts);
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await done;
  }

  const text = (id: string) => ({ id, secure: false, type: 'text' });
  const voice = (id: string) => ({ id, secure: false, type: 'voice' });

  it('still unconfirmed after every attempt: logged as an error, then every hidden room is left cluster-wide, voice participants spared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([text('ch-pub'), text('ch-priv'), voice('ch-v')]);
    m.prisma.serverMember.findMany.mockResolvedValueOnce([{ userId: 'u-1' }, { userId: 'u-2' }, { userId: 'u-3' }, { userId: 'u-4' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'u-1': ['ch-pub', 'ch-priv', 'ch-v'], 'u-2': ['ch-pub', 'ch-v'], 'u-3': [], 'u-4': [] }));

    await runUnconfirmed();

    expect(m.publish).toHaveBeenCalledTimes(RESYNC_PUBLISH_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(RESYNC_PUBLISH_ATTEMPTS - 1 + 1); // each retry, then the fallback's summary
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`not confirmed by every node after ${RESYNC_PUBLISH_ATTEMPTS} attempts (redis away): removing hidden channel rooms cluster-wide (fail closed)`));
    // The member list comes from the database, never from a socket snapshot
    expect(m.prisma.serverMember.findMany).toHaveBeenCalledWith({ where: { serverId: 'server-1' }, select: { userId: true } });
    expect(m.clusterFetch).not.toHaveBeenCalled();
    // TEXT: one leave per set of hidden channels, naming the users who hide exactly that set
    expect(m.clusterIn).toHaveBeenCalledWith(['user:u-2']);
    expect(m.clusterGroupLeave).toHaveBeenCalledWith(['channel:ch-priv']);
    expect(m.clusterIn).toHaveBeenCalledWith(['user:u-3', 'user:u-4']);
    expect(m.clusterGroupLeave).toHaveBeenCalledWith(['channel:ch-pub', 'channel:ch-priv']);
    expect(m.clusterGroupLeave).toHaveBeenCalledTimes(2);
    // VOICE: one leave per channel, sparing its own voice room
    expect(m.clusterIn).toHaveBeenCalledWith(['user:u-3', 'user:u-4']);
    expect(m.clusterExcept).toHaveBeenCalledTimes(1);
    expect(m.clusterExcept).toHaveBeenCalledWith('voice:ch-v');
    expect(m.clusterLeave).toHaveBeenCalledWith('channel:ch-v');
    expect(m.clusterIn).toHaveBeenCalledTimes(3);
  });

  // Review of #71: one leave per channel per batch made a 10 000-member space
  // with 200 channels publish up to 4000 messages, about 66 MB to every node,
  // on the path taken when a node has just died.
  it('the leave count follows the space\'s visibility profiles, not its channel count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const textIds = ['t1', 't2', 't3', 't4', 't5', 't6'];
    m.prisma.channel.findMany.mockResolvedValue([...textIds.map(text), voice('v1'), voice('v2')]);
    m.prisma.serverMember.findMany.mockResolvedValueOnce(Array.from({ length: 1200 }, (_, i) => ({ userId: `u-${i}` })));
    // Four profiles in every batch: sees all; hides t1, t2 and v1; hides t1; hides everything
    const hiddenBy = [[], ['t1', 't2', 'v1'], ['t1'], [...textIds, 'v1', 'v2']];
    const all = [...textIds, 'v1', 'v2'];
    m.filterForUsers.mockImplementation(async (userIds: string[]) => visibility(Object.fromEntries(userIds.map((u) => {
      const hidden = hiddenBy[Number(u.slice(2)) % 4];
      return [u, all.filter((c) => !hidden.includes(c))];
    }))));

    await runUnconfirmed();

    // Per batch of 500: 3 text sets + 2 voice channels hidden from someone =
    // 5, times 3 batches. One leave per channel per batch would be 8 × 3 = 24.
    expect(m.filterForUsers).toHaveBeenCalledTimes(3);
    expect(m.clusterGroupLeave).toHaveBeenCalledTimes(9);
    expect(m.clusterLeave).toHaveBeenCalledTimes(6);
    expect(m.clusterIn).toHaveBeenCalledTimes(15);
    expect(m.clusterGroupLeave).toHaveBeenCalledWith(textIds.map((id) => `channel:${id}`));
    expect(m.clusterGroupLeave).toHaveBeenCalledWith(['channel:t1', 'channel:t2']);
    expect(m.clusterGroupLeave).toHaveBeenCalledWith(['channel:t1']);
    // Each leave names only its users: per batch the three text sets (125
    // users each), then v1 (two profiles) and v2 (one); the last batch is 200
    expect(m.clusterIn.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([
      125, 125, 125, 250, 125,
      125, 125, 125, 250, 125,
      50, 50, 50, 100, 50,
    ]);
  });

  it('the fallback of a member-scoped resync recomputes that member alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([text('ch-priv'), voice('ch-v')]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-9': [] }));

    await runUnconfirmed({ userId: 'user-9' });

    expect(m.prisma.serverMember.findMany).not.toHaveBeenCalled();
    expect(m.filterForUsers).toHaveBeenCalledWith(['user-9'], 'server-1', [text('ch-priv'), voice('ch-v')]);
    expect(m.clusterIn).toHaveBeenCalledWith(['user:user-9']);
    expect(m.clusterGroupLeave).toHaveBeenCalledWith(['channel:ch-priv']);
    expect(m.clusterExcept).toHaveBeenCalledWith('voice:ch-v');
    expect(m.clusterLeave).toHaveBeenCalledWith('channel:ch-v');
  });

  it('the fallback of a channel-scoped resync reads only that channel, and leaves nothing a user may still view', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([text('ch-1')]);
    m.prisma.serverMember.findMany.mockResolvedValueOnce([{ userId: 'u-1' }]);

    await runUnconfirmed({ channelId: 'ch-1' });

    expect(m.prisma.channel.findMany).toHaveBeenLastCalledWith({ where: { serverId: 'server-1', id: 'ch-1' }, select: { id: true, secure: true, type: true } });
    // Default visibility: u-1 sees ch-1 — the fallback revokes, it never joins
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('the fallback recomputes a big space in bounded batches', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([text('ch-1')]);
    m.prisma.serverMember.findMany.mockResolvedValueOnce(Array.from({ length: 1200 }, (_, i) => ({ userId: `u-${i}` })));
    m.filterForUsers.mockImplementation(async (userIds: string[]) => visibility(Object.fromEntries(userIds.map((u) => [u, []]))));

    await runUnconfirmed();

    expect(m.filterForUsers.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([500, 500, 200]);
    expect(m.clusterIn.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([500, 500, 200]);
  });

  it('a failing fallback is logged, never thrown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No socket on this node, so the only channel read is the fallback's
    m.prisma.channel.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(runUnconfirmed()).resolves.toBeUndefined();

    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('Fail-closed fallback for server server-1 failed; revoked members on unconfirmed nodes keep their rooms until they reconnect'),
      expect.any(Error),
    );
  });
});

// ─── A receiving node ───────────────────────────────────────────────────────

describe('a node receiving a peer\'s resync request', () => {
  let deliver: (raw: string) => void;
  let seq = 0;
  const message = (fields: Record<string, unknown>) => JSON.stringify({ id: `req-${++seq}`, fromNode: 'node-b', serverId: 'server-1', ...fields });

  beforeEach(async () => {
    resetMocks();
    await initChannelVisibilitySync();
    deliver = m.subscribe.mock.calls[0][1] as (raw: string) => void;
  });
  afterEach(() => vi.restoreAllMocks());

  it('subscribes to the resync channel', () => {
    expect(m.subscribe).toHaveBeenCalledWith(VISIBILITY_RESYNC_CHANNEL, expect.any(Function));
  });

  it.each([
    ['the space', {}, 'server:server-1', { where: { serverId: 'server-1' } }],
    ['one member', { userId: 'user-9' }, 'user:user-9', { where: { serverId: 'server-1' } }],
    ['one channel', { channelId: 'ch-1' }, 'server:server-1', { where: { serverId: 'server-1', id: 'ch-1' } }],
  ])('resyncs ITS OWN sockets for the scope (%s), and publishes nothing back', async (_label, fields, room, channelQuery) => {
    const revoked = createMockSocket('user-9', { rooms: ['user:user-9', 'channel:ch-1'] });
    m.localFetch.mockResolvedValueOnce([revoked]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-9': [] }));

    deliver(message(fields));

    await vi.waitFor(() => expect(revoked.leave).toHaveBeenCalledWith('channel:ch-1'));
    expect(m.localIn).toHaveBeenCalledWith(room);
    expect(m.prisma.channel.findMany).toHaveBeenCalledWith({ ...channelQuery, select: { id: true, secure: true } });
    expect(m.clusterFetch).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('keeps an active voice participant in its channel room', async () => {
    const participant = createMockSocket('user-9', { rooms: ['user:user-9', 'voice:ch-1', 'channel:ch-1'] });
    m.localFetch.mockResolvedValueOnce([participant]);
    m.prisma.channel.findMany.mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-9': [] }));

    deliver(message({}));

    await vi.waitFor(() => expect(participant.leave).toHaveBeenCalledWith('channel:ch-2'));
    expect(participant.leave).not.toHaveBeenCalledWith('channel:ch-1');
  });

  it('ignores its own request (the originator already resynced its sockets)', async () => {
    deliver(JSON.stringify({ id: 'own-1', fromNode: 'node-a', serverId: 'server-1' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(m.localIn).not.toHaveBeenCalled();
  });

  it('applies a retried request (same id) once', async () => {
    const raw = message({});
    deliver(raw);
    deliver(raw);
    await vi.waitFor(() => expect(m.localIn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(m.localIn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not JSON', '{nope', 'not JSON'],
    ['not an object', '"server-1"', 'invalid shape'],
    ['no id', JSON.stringify({ fromNode: 'node-b', serverId: 'server-1' }), 'invalid shape'],
    ['a server id that is not an id', JSON.stringify({ id: 'r-1', fromNode: 'node-b', serverId: 'server:1' }), 'invalid shape'],
    ['a channel id of the wrong type', JSON.stringify({ id: 'r-2', fromNode: 'node-b', serverId: 's-1', channelId: 7 }), 'invalid shape'],
    ['a user id that is not an id', JSON.stringify({ id: 'r-3', fromNode: 'node-b', serverId: 's-1', userId: '../x' }), 'invalid shape'],
    ['no origin node', JSON.stringify({ id: 'r-4', serverId: 's-1' }), 'invalid shape'],
  ])('ignores a message with %s, with a warning', async (_label, raw, why) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    deliver(raw);
    await new Promise((r) => setTimeout(r, 0));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(why), ...(why === 'not JSON' ? [expect.anything()] : []));
    expect(m.localIn).not.toHaveBeenCalled();
  });

  it('a failing local pass on the receiving node is logged, never thrown', async () => {
    vi.useFakeTimers(); // the failure queues a repeat: keep it inside this test
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      m.localFetch.mockRejectedValueOnce(new Error('adapter gone'));

      expect(() => deliver(message({}))).not.toThrow();

      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to resync this node\'s channel rooms for server server-1'), expect.any(Error)));
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── A join that raced a resync ─────────────────────────────────────────────

describe('a join that raced a resync (connection handler, channel:join)', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('with no resync request since the mark, nothing is queued: one comparison, no query', async () => {
    const mark = visibilityRequestMark();

    resyncAfterJoins(mark, 'user-1', ['server-1', 'server-2']);
    await new Promise((r) => setTimeout(r, 0));

    expect(m.localIn).not.toHaveBeenCalled();
    expect(m.prisma.channel.findMany).not.toHaveBeenCalled();
  });

  // The race of the review: the joining code read visibility, the revocation
  // committed and its pass ran BEFORE the join (nothing to remove yet), then
  // the join applied the stale read and the member stayed in the room.
  it('the revocation whose pass ran between the read and the join is applied again after the join', async () => {
    const socket = createMockSocket('user-1');
    m.localFetch.mockResolvedValue([socket]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-priv' }]);
    m.filterForUsers.mockResolvedValue(visibility({ 'user-1': [] }));

    const mark = visibilityRequestMark();                         // before the joining code's read
    await syncChannelVisibilityRooms('server-1', { userId: 'user-1' }); // the revocation's pass
    socket.join('channel:ch-priv');                               // the stale join
    resyncAfterJoins(mark, 'user-1', ['server-1', 'server-2']);
    await vi.waitFor(() => expect(m.filterForUsers).toHaveBeenCalledTimes(2));

    const leaves = socket.leave.mock.invocationCallOrder;
    expect(leaves).toHaveLength(2);
    expect(leaves[1]).toBeGreaterThan(socket.join.mock.invocationCallOrder[0]);
    expect(m.localIn).toHaveBeenLastCalledWith('user:user-1');
    // Only the space that had a request is re-checked
    expect(m.filterForUsers.mock.calls.map((c) => c[1])).toEqual(['server-1', 'server-1']);
  });

  it('a peer\'s request counts like this node\'s own', async () => {
    await initChannelVisibilitySync();
    const deliver = m.subscribe.mock.calls[0][1] as (raw: string) => void;
    const mark = visibilityRequestMark();
    deliver(JSON.stringify({ id: 'raced-1', fromNode: 'node-b', serverId: 'server-1' }));
    await vi.waitFor(() => expect(m.localIn).toHaveBeenCalledWith('server:server-1'));

    resyncAfterJoins(mark, 'user-1', ['server-1']);

    await vi.waitFor(() => expect(m.localIn).toHaveBeenCalledWith('user:user-1'));
  });

  it('after a channel:join, the re-check covers that channel only', async () => {
    m.localFetch.mockResolvedValue([createMockSocket('user-1')]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-new' }]);
    const mark = visibilityRequestMark();
    await syncChannelVisibilityRooms('server-1');

    resyncAfterJoins(mark, 'user-1', ['server-1'], 'ch-new');

    await vi.waitFor(() => expect(m.prisma.channel.findMany).toHaveBeenLastCalledWith({ where: { serverId: 'server-1', id: 'ch-new' }, select: { id: true, secure: true } }));
    expect(m.localIn).toHaveBeenLastCalledWith('user:user-1');
  });

  it('a request for another space is no reason to re-check this one, and a mark taken after the request is no reason either', async () => {
    const before = visibilityRequestMark();
    await syncChannelVisibilityRooms('server-9');
    const after = visibilityRequestMark();
    m.localIn.mockClear();

    resyncAfterJoins(before, 'user-1', ['server-1']);
    resyncAfterJoins(after, 'user-1', ['server-9']);
    await new Promise((r) => setTimeout(r, 0));

    expect(m.localIn).not.toHaveBeenCalled();
  });

  it('resyncRequestedSince answers, per space, whether a request came in since the mark (for adapter-wide joins)', async () => {
    const before = visibilityRequestMark();
    expect(resyncRequestedSince(before, 'server-1')).toBe(false);
    await syncChannelVisibilityRooms('server-1');
    const after = visibilityRequestMark();

    expect(resyncRequestedSince(before, 'server-1')).toBe(true);
    expect(resyncRequestedSince(before, 'server-2')).toBe(false);
    expect(resyncRequestedSince(after, 'server-1')).toBe(false);
  });

  it('a space forgotten past REQUEST_SPACES_MAX reads as requested to a mark older than it was forgotten', async () => {
    await initChannelVisibilitySync();
    const deliver = m.subscribe.mock.calls[0][1] as (raw: string) => void;
    const old = visibilityRequestMark();
    for (let i = 0; i <= REQUEST_SPACES_MAX; i++) {
      deliver(JSON.stringify({ id: `many-${i}`, fromNode: 'node-b', serverId: `sp-${i}` }));
    }
    const recent = visibilityRequestMark();
    await vi.waitFor(() => expect(m.localIn).toHaveBeenCalledTimes(REQUEST_SPACES_MAX + 1));
    m.localIn.mockClear();

    // sp-0 is no longer listed: a mark from before it must still re-check it
    resyncAfterJoins(old, 'user-1', ['sp-0']);
    resyncAfterJoins(recent, 'user-1', ['sp-0']);
    await vi.waitFor(() => expect(m.localIn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(m.localIn).toHaveBeenCalledTimes(1);
    expect(m.localIn).toHaveBeenCalledWith('user:user-1');
  });
});

// ─── A pass that fails ──────────────────────────────────────────────────────

describe('a local pass that fails is queued again', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const poolTimeout = () => new Error('Timed out fetching a new connection from the connection pool');
  const ATTEMPTS = LOCAL_PASS_RETRY_DELAYS_MS.length + 1;
  const ALL_DELAYS = LOCAL_PASS_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

  // Review of #71 (owner's decision): seconds for a pool timeout, minutes for
  // a database restart, then each scope's own end
  it('is queued again after 1 s, 5 s, 30 s and 2 min, each failure logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    revokedMember();
    m.filterForUsers.mockRejectedValue(poolTimeout());

    await syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(ALL_DELAYS);

    expect(LOCAL_PASS_RETRY_DELAYS_MS).toEqual([1000, 5000, 30_000, 120_000]);
    expect(m.filterForUsers).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls.map((c) => c[0]).filter((line) => String(line).includes('queued again'))).toEqual([
      '[Visibility] Resync of server server-1 on this node failed (attempt 1/5); queued again in 1000 ms',
      '[Visibility] Resync of server server-1 on this node failed (attempt 2/5); queued again in 5000 ms',
      '[Visibility] Resync of server server-1 on this node failed (attempt 3/5); queued again in 30000 ms',
      '[Visibility] Resync of server server-1 on this node failed (attempt 4/5); queued again in 120000 ms',
    ]);
  });

  /** A member who lost the private channel, still in its room on this node. */
  function revokedMember() {
    const socket = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-priv'] });
    m.localFetch.mockResolvedValue([socket]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-priv' }]);
    return socket;
  }

  // Issue #71, review: the publish proves the request was DELIVERED, not
  // applied. A node whose pool timed out once logged it and kept the revoked
  // member in the room, although every node had confirmed the publish.
  it('on the node that made the change: queued again after the first delay, and the revocation then applies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const socket = revokedMember();
    m.filterForUsers.mockRejectedValueOnce(poolTimeout()).mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1', { userId: 'user-1' });
    expect(socket.leave).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`[Visibility] Resync of server server-1 on this node failed (attempt 1/${ATTEMPTS}); queued again in ${LOCAL_PASS_RETRY_DELAYS_MS[0]} ms`);

    await vi.advanceTimersByTimeAsync(LOCAL_PASS_RETRY_DELAYS_MS[0] - 1);
    expect(m.filterForUsers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(m.filterForUsers).toHaveBeenCalledTimes(2);
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-priv');
    // The publish went out once: the repeat is this node's own business
    expect(m.publish).toHaveBeenCalledTimes(1);
  });

  it('on a node that received the request: the same', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await initChannelVisibilitySync();
    const deliver = m.subscribe.mock.calls[0][1] as (raw: string) => void;
    const socket = revokedMember();
    m.filterForUsers.mockRejectedValueOnce(poolTimeout()).mockResolvedValueOnce(visibility({ 'user-1': [] }));

    deliver(JSON.stringify({ id: 'failing-1', fromNode: 'node-b', serverId: 'server-1' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LOCAL_PASS_RETRY_DELAYS_MS[0]);

    expect(socket.leave).toHaveBeenCalledWith('channel:ch-priv');
  });

  it('a second failure is queued again after the second delay', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const socket = revokedMember();
    m.filterForUsers
      .mockRejectedValueOnce(poolTimeout())
      .mockRejectedValueOnce(poolTimeout())
      .mockResolvedValueOnce(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(LOCAL_PASS_RETRY_DELAYS_MS[0]);
    expect(m.filterForUsers).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(`[Visibility] Resync of server server-1 on this node failed (attempt 2/${ATTEMPTS}); queued again in ${LOCAL_PASS_RETRY_DELAYS_MS[1]} ms`);
    await vi.advanceTimersByTimeAsync(LOCAL_PASS_RETRY_DELAYS_MS[1] - 1);
    expect(m.filterForUsers).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(m.filterForUsers).toHaveBeenCalledTimes(3);
    expect(socket.leave).toHaveBeenCalledWith('channel:ch-priv');
  });

  it('the last failure of ONE MEMBER\'s pass disconnects their sockets on this node, except one in a voice call (fail closed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const idle = createMockSocket('user-1', { rooms: ['user:user-1', 'channel:ch-priv'] });
    const inCall = createMockSocket('user-1', { rooms: ['user:user-1', 'voice:ch-v', 'channel:ch-v'] });
    m.localFetch.mockResolvedValue([idle, inCall]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-priv' }]);
    m.filterForUsers.mockRejectedValue(poolTimeout());

    await syncChannelVisibilityRooms('server-1', { userId: 'user-1' });
    await vi.advanceTimersByTimeAsync(ALL_DELAYS);

    expect(m.filterForUsers).toHaveBeenCalledTimes(ATTEMPTS);
    expect(idle.disconnect).toHaveBeenCalledWith(true);
    expect(inCall.disconnect).not.toHaveBeenCalled();
    expect(m.localIn).toHaveBeenLastCalledWith('user:user-1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`Resync of member user-1 in server server-1 on this node failed ${ATTEMPTS} times: disconnected 1 of their socket(s)`));

    // And it stops there
    await vi.advanceTimersByTimeAsync(600_000);
    expect(m.filterForUsers).toHaveBeenCalledTimes(ATTEMPTS);
  });

  // Review of #71: a re-check after a channel:join (one channel of one member)
  // ended in the member-wide disconnect, so an unrelated request plus a
  // database blip disconnected a member whose access had never changed.
  it('the last failure of a re-check of one member\'s channel takes that one room away, disconnecting nobody', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const socket = revokedMember();
    m.filterForUsers.mockRejectedValue(poolTimeout());
    const mark = visibilityRequestMark();
    await syncChannelVisibilityRooms('server-1', { channelId: 'ch-other' }); // an unrelated request

    resyncAfterJoins(mark, 'user-1', ['server-1'], 'ch-priv');
    await vi.advanceTimersByTimeAsync(ALL_DELAYS);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(m.localIn).toHaveBeenCalledWith('user:user-1');
    expect(m.localExcept).toHaveBeenCalledWith('voice:ch-priv');
    expect(m.localLeave).toHaveBeenCalledWith('channel:ch-priv');
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`Resync of channel ch-priv in server server-1 on this node failed ${ATTEMPTS} times: member user-1's sockets on this node left its room`));
  });

  it('the last failure of a channel\'s pass takes the channel\'s room from every socket of the space on this node, its voice participants kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const socket = revokedMember();
    m.filterForUsers.mockRejectedValue(poolTimeout());

    await syncChannelVisibilityRooms('server-1', { channelId: 'ch-priv' });
    await vi.advanceTimersByTimeAsync(ALL_DELAYS);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(m.localIn).toHaveBeenLastCalledWith('server:server-1');
    expect(m.localExcept).toHaveBeenCalledWith('voice:ch-priv');
    expect(m.localLeave).toHaveBeenCalledWith('channel:ch-priv');
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`Resync of channel ch-priv in server server-1 on this node failed ${ATTEMPTS} times: every socket of the space on this node left its room`));
  });

  // Review of #71: every socket of a reconnect storm queued its own re-check
  it('a member pass that has not started absorbs the next ones for that member and space: one pass, not one per socket', async () => {
    const socket = createMockSocket('user-1');
    m.localFetch.mockResolvedValue([socket]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
    let releaseFirst!: (visible: Map<string, Set<string>>) => void;
    m.filterForUsers.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));

    const mark = visibilityRequestMark();
    const first = syncChannelVisibilityRooms('server-1'); // runs, and holds the queue
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) resyncAfterJoins(mark, 'user-1', ['server-1']);
    resyncAfterJoins(mark, 'user-2', ['server-1']); // another member: a pass of its own
    releaseFirst(visibility({ 'user-1': ['ch-1'] }));
    await first;
    await vi.advanceTimersByTimeAsync(0);

    expect(m.localIn.mock.calls.map((c) => c[0])).toEqual(['server:server-1', 'user:user-1', 'user:user-2']);
  });

  it('two channels of one member waiting together widen to the member\'s whole space', async () => {
    m.localFetch.mockResolvedValue([createMockSocket('user-1')]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
    let releaseFirst!: (visible: Map<string, Set<string>>) => void;
    m.filterForUsers.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));

    const mark = visibilityRequestMark();
    const first = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(0);
    resyncAfterJoins(mark, 'user-1', ['server-1'], 'ch-a');
    resyncAfterJoins(mark, 'user-1', ['server-1'], 'ch-b');
    releaseFirst(visibility({ 'user-1': ['ch-1'] }));
    await first;
    await vi.advanceTimersByTimeAsync(0);

    expect(m.prisma.channel.findMany).toHaveBeenCalledTimes(2);
    expect(m.prisma.channel.findMany).toHaveBeenLastCalledWith({ where: { serverId: 'server-1' }, select: { id: true, secure: true } });
  });

  // Review of #71: the socket spared for its call kept EVERY room, so a
  // member who lost #staff while in a call kept receiving #staff.
  it('a socket kept for its voice call keeps only its call\'s channel room', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inCall = createMockSocket('user-1', { rooms: ['inCall-socket', 'user:user-1', 'server:server-1', 'voice:ch-v', 'channel:ch-v', 'channel:ch-staff', 'channel:ch-other-space', 'dm:conv-1'] });
    m.localFetch.mockResolvedValue([inCall]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-staff' }]);
    m.filterForUsers.mockRejectedValue(poolTimeout());

    await syncChannelVisibilityRooms('server-1', { userId: 'user-1' });
    await vi.advanceTimersByTimeAsync(LOCAL_PASS_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    expect(inCall.disconnect).not.toHaveBeenCalled();
    expect(inCall.leave.mock.calls.map((c) => c[0]).sort()).toEqual(['channel:ch-other-space', 'channel:ch-staff']);
  });

  // Review of #71: `dm:voice:{id}` does not start with `voice:`, so a socket
  // in a DM call was disconnected, and its `disconnecting` handler ended the call.
  it('a socket in a DM call is kept too, and keeps no channel room', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inDmCall = createMockSocket('user-1', { rooms: ['user:user-1', 'dm:conv-1', 'dm:voice:conv-1', 'channel:ch-staff', 'channel:ch-pub'] });
    m.localFetch.mockResolvedValue([inDmCall]);
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-staff' }]);
    m.filterForUsers.mockRejectedValue(poolTimeout());

    await syncChannelVisibilityRooms('server-1', { userId: 'user-1' });
    await vi.advanceTimersByTimeAsync(LOCAL_PASS_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    expect(inDmCall.disconnect).not.toHaveBeenCalled();
    expect(inDmCall.leave.mock.calls.map((c) => c[0]).sort()).toEqual(['channel:ch-pub', 'channel:ch-staff']);
  });

  it('the last failure of a space-wide pass gives up, logged as an error, disconnecting nobody', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const socket = revokedMember();
    m.filterForUsers.mockRejectedValue(poolTimeout());

    await syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(ALL_DELAYS + 600_000);

    expect(m.filterForUsers).toHaveBeenCalledTimes(ATTEMPTS);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(m.localLeave).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`Resync of server server-1 on this node failed ${ATTEMPTS} times; giving up`));
  });

  it('a pass that applied is never repeated', async () => {
    const socket = revokedMember();
    m.filterForUsers.mockResolvedValue(visibility({ 'user-1': [] }));

    await syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(m.filterForUsers).toHaveBeenCalledTimes(1);
    expect(socket.leave).toHaveBeenCalledTimes(1);
  });
});
