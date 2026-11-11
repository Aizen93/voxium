import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  // io.in(...) — the CLUSTER-WIDE operator: only the fallback may use it, and
  // its fetchSockets (which waits on every node) must never be called
  clusterIn: vi.fn(),
  clusterFetch: vi.fn(),
  clusterExcept: vi.fn(),
  clusterLeave: vi.fn(),
  // io.local.in(...) — this node's sockets
  localIn: vi.fn(),
  localFetch: vi.fn(),
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
  };
}

function resetMocks() {
  // reset, not clear: a once-queue a test left unconsumed must not leak
  vi.resetAllMocks();
  m.getIO.mockReturnValue({ in: m.clusterIn, to: m.to, local: { in: m.localIn, to: m.localTo } });
  m.clusterIn.mockReturnValue({ fetchSockets: m.clusterFetch, except: m.clusterExcept });
  m.clusterExcept.mockReturnValue({ socketsLeave: m.clusterLeave });
  // A peer that never answers: anything that awaited this would hang
  m.clusterFetch.mockReturnValue(new Promise(() => {}));
  m.localIn.mockReturnValue({ fetchSockets: m.localFetch });
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
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.localFetch.mockResolvedValueOnce([createMockSocket('user-1')]);
    m.prisma.channel.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(syncChannelVisibilityRooms('server-1')).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Visibility] Failed to resync this node\'s channel rooms for server server-1'), expect.any(Error));
    expect(m.publish).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
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

  // ── The fail-closed fallback ─────────────────────────────────────────────

  /** Run a resync whose every publish fails, through all the retries. */
  async function runUnconfirmed(opts?: { channelId?: string; userId?: string }) {
    vi.useFakeTimers();
    m.publish.mockRejectedValue(new Error('redis away'));
    const done = syncChannelVisibilityRooms('server-1', opts);
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await done;
  }

  it('still unconfirmed after every attempt: logged as an error, then every hidden room is left cluster-wide, voice participants spared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-pub', secure: false }, { id: 'ch-priv', secure: false }]);
    m.prisma.serverMember.findMany.mockResolvedValueOnce([{ userId: 'u-1' }, { userId: 'u-2' }, { userId: 'u-3' }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'u-1': ['ch-pub', 'ch-priv'], 'u-2': ['ch-pub'], 'u-3': [] }));

    await runUnconfirmed();

    expect(m.publish).toHaveBeenCalledTimes(RESYNC_PUBLISH_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(RESYNC_PUBLISH_ATTEMPTS - 1 + 1); // each retry, then the fallback's summary
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`not confirmed by every node after ${RESYNC_PUBLISH_ATTEMPTS} attempts (redis away): removing hidden channel rooms cluster-wide (fail closed)`));
    // The member list comes from the database, never from a socket snapshot
    expect(m.prisma.serverMember.findMany).toHaveBeenCalledWith({ where: { serverId: 'server-1' }, select: { userId: true } });
    expect(m.clusterFetch).not.toHaveBeenCalled();
    // One leave per channel, naming only the users it hides
    expect(m.clusterIn).toHaveBeenCalledTimes(2);
    expect(m.clusterIn).toHaveBeenCalledWith(['user:u-3']);
    expect(m.clusterIn).toHaveBeenCalledWith(['user:u-2', 'user:u-3']);
    expect(m.clusterExcept).toHaveBeenCalledWith('voice:ch-pub');
    expect(m.clusterExcept).toHaveBeenCalledWith('voice:ch-priv');
    expect(m.clusterLeave).toHaveBeenCalledWith('channel:ch-pub');
    expect(m.clusterLeave).toHaveBeenCalledWith('channel:ch-priv');
    const order = m.clusterIn.mock.invocationCallOrder;
    expect(m.clusterExcept.mock.invocationCallOrder[0]).toBeGreaterThan(order[0]);
  });

  it('the fallback of a member-scoped resync recomputes that member alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-priv', secure: false }]);
    m.filterForUsers.mockResolvedValueOnce(visibility({ 'user-9': [] }));

    await runUnconfirmed({ userId: 'user-9' });

    expect(m.prisma.serverMember.findMany).not.toHaveBeenCalled();
    expect(m.filterForUsers).toHaveBeenCalledWith(['user-9'], 'server-1', [{ id: 'ch-priv', secure: false }]);
    expect(m.clusterIn).toHaveBeenCalledWith(['user:user-9']);
    expect(m.clusterExcept).toHaveBeenCalledWith('voice:ch-priv');
    expect(m.clusterLeave).toHaveBeenCalledWith('channel:ch-priv');
  });

  it('the fallback of a channel-scoped resync reads only that channel, and leaves nothing a user may still view', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1', secure: false }]);
    m.prisma.serverMember.findMany.mockResolvedValueOnce([{ userId: 'u-1' }]);

    await runUnconfirmed({ channelId: 'ch-1' });

    expect(m.prisma.channel.findMany).toHaveBeenLastCalledWith({ where: { serverId: 'server-1', id: 'ch-1' }, select: { id: true, secure: true } });
    // Default visibility: u-1 sees ch-1 — the fallback revokes, it never joins
    expect(m.clusterIn).not.toHaveBeenCalled();
  });

  it('the fallback recomputes a big space in bounded batches', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.prisma.channel.findMany.mockResolvedValue([{ id: 'ch-1', secure: false }]);
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.localFetch.mockRejectedValueOnce(new Error('adapter gone'));

    expect(() => deliver(message({}))).not.toThrow();

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to resync this node\'s channel rooms for server server-1'), expect.any(Error)));
  });
});
