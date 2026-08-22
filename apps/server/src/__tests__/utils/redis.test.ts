import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the redis module to avoid real Redis connections
vi.mock('redis', () => ({
  createClient: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    connect: vi.fn().mockResolvedValue(undefined),
    duplicate: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
    }),
    sAdd: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    sIsMember: vi.fn().mockResolvedValue(1), // Redis 5 returns number, not boolean
    sMembers: vi.fn().mockResolvedValue([]),
    sCard: vi.fn().mockResolvedValue(0),
    hSet: vi.fn().mockResolvedValue(1),
    hGet: vi.fn().mockResolvedValue(null),
    hDel: vi.fn().mockResolvedValue(1),
    hGetAll: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue('PONG'),
    // eslint-disable-next-line require-yield
    scanIterator: vi.fn().mockImplementation(async function* () { /* default: no keys */ }),
  }),
}));

describe('utils/redis — lazy initialization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('importing does NOT read REDIS_URL or create a client', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    const { createClient } = await import('redis');
    vi.mocked(createClient).mockClear();

    const mod = await import('../../utils/redis');
    expect(mod).toBeDefined();
    expect(createClient).not.toHaveBeenCalled();

    if (saved !== undefined) process.env.REDIS_URL = saved;
  });

  it('NODE_ID() returns a string', async () => {
    const mod = await import('../../utils/redis');
    const nodeId = mod.NODE_ID();
    expect(typeof nodeId).toBe('string');
    expect(nodeId.length).toBeGreaterThan(0);
  });

  it('NODE_ID() returns the same value on repeated calls (cached)', async () => {
    const mod = await import('../../utils/redis');
    const id1 = mod.NODE_ID();
    const id2 = mod.NODE_ID();
    expect(id1).toBe(id2);
  });

  it('NODE_ID() uses process.env.NODE_ID when set', async () => {
    process.env.NODE_ID = 'custom-node-42';
    const mod = await import('../../utils/redis');
    expect(mod.NODE_ID()).toBe('custom-node-42');
    delete process.env.NODE_ID;
  });

  it('getRedis() throws before initRedis() is called', async () => {
    const mod = await import('../../utils/redis');
    expect(() => mod.getRedis()).toThrow('Redis not initialized. Call initRedis() first.');
  });

  it('getRedisPubSub() throws before initRedis() is called', async () => {
    const mod = await import('../../utils/redis');
    expect(() => mod.getRedisPubSub()).toThrow('Redis not initialized. Call initRedis() first.');
  });

  it('getRedisConfigSub() throws before initRedis() is called', async () => {
    const mod = await import('../../utils/redis');
    expect(() => mod.getRedisConfigSub()).toThrow('Redis not initialized. Call initRedis() first.');
  });

  it('getRedis() works after initRedis() is called', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    expect(() => mod.getRedis()).not.toThrow();
    const redis = mod.getRedis();
    expect(redis).toBeDefined();
  });

  it('initRedis() creates the Redis client with REDIS_URL from env', async () => {
    process.env.REDIS_URL = 'redis://test-host:6380';
    const { createClient } = await import('redis');
    vi.mocked(createClient).mockClear();

    const mod = await import('../../utils/redis');
    await mod.initRedis();

    expect(createClient).toHaveBeenCalledWith({
      url: 'redis://test-host:6380',
      socket: {
        reconnectStrategy: expect.any(Function),
        keepAlive: true,
        connectTimeout: 10000,
      },
    });
    delete process.env.REDIS_URL;
  });

  it('reconnectStrategy uses exponential backoff capped at 2000ms', async () => {
    const { createClient } = await import('redis');
    vi.mocked(createClient).mockClear();

    const mod = await import('../../utils/redis');
    await mod.initRedis();

    // Extract the reconnectStrategy from the createClient call
    const callArgs = vi.mocked(createClient).mock.calls[0][0] as { socket: { reconnectStrategy: (retries: number) => number } };
    const strategy = callArgs.socket.reconnectStrategy;

    // Exponential: retries * 50, capped at 2000
    expect(strategy(1)).toBe(50);
    expect(strategy(10)).toBe(500);
    expect(strategy(40)).toBe(2000);
    expect(strategy(100)).toBe(2000); // capped
  });
});

describe('utils/redis — isUserOnline returns boolean', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('isUserOnline() returns a boolean, not a number', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();

    // sIsMember mock returns 1 (number) — isUserOnline must wrap in Boolean()
    const result = await mod.isUserOnline('user-123');
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });

  it('isUserOnline() returns false when user is not online', async () => {
    // Override the mock to return 0 for this test
    const { createClient } = await import('redis');
    const mockClient = vi.mocked(createClient)();
    vi.mocked(mockClient.sIsMember).mockResolvedValueOnce(false);

    const mod = await import('../../utils/redis');
    await mod.initRedis();

    // Re-mock sIsMember to return 0 (falsy number)
    const redis = mod.getRedis();
    vi.mocked(redis.sIsMember).mockResolvedValueOnce(false);

    const result = await mod.isUserOnline('user-nonexistent');
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });
});

// ─── Node heartbeat & cluster liveness (multi-node) ──────────────────────────

describe('utils/redis — node heartbeat & cluster liveness', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ID = 'hb-node-1';
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.NODE_ID;
  });

  it('startNodeHeartbeat sets the liveness key with a TTL and refreshes it on an interval', async () => {
    vi.useFakeTimers();
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    vi.mocked(client.set).mockClear();

    await mod.startNodeHeartbeat();
    expect(client.set).toHaveBeenCalledWith('node:alive:hb-node-1', expect.any(String), { EX: 30 });

    vi.mocked(client.set).mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.set).toHaveBeenCalledWith('node:alive:hb-node-1', expect.any(String), { EX: 30 });

    await mod.stopNodeHeartbeat();
  });

  it('stopNodeHeartbeat deletes the liveness key so peers reap promptly on graceful shutdown', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();

    await mod.startNodeHeartbeat();
    vi.mocked(client.del).mockClear();
    await mod.stopNodeHeartbeat();

    expect(client.del).toHaveBeenCalledWith('node:alive:hb-node-1');
  });

  it('isNodeAlive reflects heartbeat key existence', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();

    vi.mocked(client.exists).mockResolvedValueOnce(1);
    expect(await mod.isNodeAlive('peer-a')).toBe(true);
    vi.mocked(client.exists).mockResolvedValueOnce(0);
    expect(await mod.isNodeAlive('peer-b')).toBe(false);
  });

  it('anyOtherNodeAlive ignores this node\'s own heartbeat key', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();

    vi.mocked(client.scanIterator).mockImplementation(async function* () {
      yield ['node:alive:hb-node-1']; // only ourselves
    });
    expect(await mod.anyOtherNodeAlive()).toBe(false);

    vi.mocked(client.scanIterator).mockImplementation(async function* () {
      yield ['node:alive:hb-node-1', 'node:alive:peer-x'];
    });
    expect(await mod.anyOtherNodeAlive()).toBe(true);

    // Restore the shared mock's default for subsequent tests
    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
  });
});

// ─── clearPresenceState (multi-node aware) ───────────────────────────────────

describe('utils/redis — clearPresenceState (multi-node aware)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ID = 'hb-node-1';
  });

  afterEach(() => {
    delete process.env.NODE_ID;
  });

  function makeDb() {
    return { user: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
  }

  it('performs the full wipe when this is the sole node', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    vi.mocked(client.sMembers).mockResolvedValueOnce(['u-1']);
    vi.mocked(client.del).mockClear();

    const db = makeDb();
    await mod.clearPresenceState(db);

    expect(client.del).toHaveBeenCalledWith(['user:sockets:u-1']);
    expect(client.del).toHaveBeenCalledWith(['online_users', 'socket:users']);
    expect(db.user.updateMany).toHaveBeenCalledWith({ where: { status: 'online' }, data: { status: 'offline' } });
  });

  it('with live peers: reaps only cluster-dead sockets and never wipes global presence keys', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();

    // A peer node is alive
    vi.mocked(client.scanIterator).mockImplementation(async function* () {
      yield ['node:alive:hb-node-1', 'node:alive:peer-x'];
    });
    // Two registered sockets: one dead cluster-wide, one alive on the peer
    vi.mocked(client.hGetAll).mockResolvedValueOnce({ 's-dead': 'u-dead', 's-live': 'u-live' });
    // setUserOffline internals for the dead socket
    vi.mocked(client.hGet).mockResolvedValue('u-dead');
    vi.mocked(client.sCard).mockResolvedValue(0);
    vi.mocked(client.del).mockClear();

    const io = {
      in: vi.fn((room: string) => ({
        fetchSockets: vi.fn().mockResolvedValue(room === 's-live' ? [{}] : []),
      })),
    };

    const db = makeDb();
    await mod.clearPresenceState(db, io);

    // Dead socket reaped, its user marked offline in DB (scoped, not global)
    expect(client.hDel).toHaveBeenCalledWith('socket:users', 's-dead');
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { status: 'online', id: { in: ['u-dead'] } },
      data: { status: 'offline' },
    });
    // Live peer socket untouched; NO global wipe
    expect(client.hDel).not.toHaveBeenCalledWith('socket:users', 's-live');
    expect(client.del).not.toHaveBeenCalledWith(['online_users', 'socket:users']);

    // Restore the shared mock's default for subsequent tests
    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGet).mockResolvedValue(null);
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  // ── F9: ONE adapter round trip for the whole sweep ────────────────────────

  /** io whose adapter answers allRooms() with `rooms`, or rejects.
   *  `serverCount` mirrors the real adapter's PUBSUB NUMSUB probe; omit it to
   *  model an adapter that does not expose one. */
  function ioWithAdapter(rooms: string[] | Error, serverCount?: number) {
    const fetchSockets = vi.fn().mockResolvedValue([]);
    const allRooms = vi.fn(() =>
      rooms instanceof Error ? Promise.reject(rooms) : Promise.resolve(new Set(rooms)));
    const adapter: Record<string, unknown> = { allRooms };
    if (serverCount !== undefined) adapter.serverCount = vi.fn().mockResolvedValue(serverCount);
    return {
      in: vi.fn(() => ({ fetchSockets })),
      of: vi.fn(() => ({ adapter })),
      _allRooms: allRooms,
      _fetchSockets: fetchSockets,
    };
  }

  async function peersAliveWith(client: ReturnType<typeof import('../../utils/redis').getRedis>, sockets: Record<string, string>) {
    vi.mocked(client.scanIterator).mockImplementation(async function* () {
      yield ['node:alive:hb-node-1', 'node:alive:peer-x'];
    });
    // mockReset (not Once): a test that returns EARLY would otherwise leave a
    // queued value for the next one to consume
    vi.mocked(client.hGetAll).mockReset();
    vi.mocked(client.hGetAll).mockResolvedValue(sockets);
    vi.mocked(client.hDel).mockClear();
  }

  it('takes ONE adapter snapshot instead of a cluster round trip per socket', async () => {
    // socket:users is the GLOBAL hash, so the old loop probed every LIVE socket
    // on every peer too — tens of thousands of serial lookups before listen(),
    // each able to sit out the adapter's full 5s timeout.
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-dead': 'u-dead', 's-live': 'u-live', 's-live-2': 'u-live-2' });
    vi.mocked(client.hGet).mockResolvedValue('u-dead');
    vi.mocked(client.sCard).mockResolvedValue(0);

    const io = ioWithAdapter(['s-live', 's-live-2', 'user:u-live', 'server:srv-1']);
    await mod.clearPresenceState(makeDb(), io);

    expect(io._allRooms).toHaveBeenCalledTimes(1);
    expect(io._fetchSockets).not.toHaveBeenCalled();
    expect(client.hDel).toHaveBeenCalledWith('socket:users', 's-dead');
    expect(client.hDel).not.toHaveBeenCalledWith('socket:users', 's-live');
    expect(client.hDel).not.toHaveBeenCalledWith('socket:users', 's-live-2');

    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGet).mockResolvedValue(null);
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  it('reaps NOTHING when the snapshot times out — a partial answer marks live users offline', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-a': 'u-a', 's-b': 'u-b' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const db = makeDb();
    await mod.clearPresenceState(db, ioWithAdapter(new Error('timeout reached while waiting for allRooms response')));

    expect(client.hDel).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  // The adapter's OTHER way of returning a partial answer, and the dangerous
  // one because it does not announce itself: @socket.io/redis-adapter resolves
  // allRooms() with this node's OWN rooms whenever PUBSUB NUMSUB reports <= 1
  // subscriber. At boot, before server.listen(), that set is EMPTY — so it
  // reads as "every socket in the cluster is dead".
  it('reaps NOTHING when the adapter sees no cluster but peers are alive', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-a': 'u-a', 's-b': 'u-b' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Exactly the short-circuit shape: one subscriber, and an empty room set
    const io = ioWithAdapter([], 1);
    const db = makeDb();
    const result = await mod.clearPresenceState(db, io);

    expect(client.hDel).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    // Refused before it even asked — the answer could only have been local
    expect(io._allRooms).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    // REPORTED, not silent. Refusing leaves real stale state behind and nothing
    // else reaps presence, so the caller has to know in order to retry once the
    // ambiguous heartbeat has had time to expire. NODE_ID defaults to a fresh
    // random id per process, so a hard-killed node is a peer to its own
    // replacement and every SIGKILL restart of a sole node lands here.
    expect(result).toEqual({ skipped: true });

    warn.mockRestore();
    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  it('accepts the snapshot once the adapter can actually see the cluster', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-live': 'u-live', 's-dead': 'u-dead' });
    vi.mocked(client.hGet).mockImplementation(async (_key, field) =>
      (field === 's-dead' ? 'u-dead' : 'u-live'));
    vi.mocked(client.sCard).mockResolvedValue(0);

    const io = ioWithAdapter(['s-live', 'user:u-live'], 2);
    const db = makeDb();
    const result = await mod.clearPresenceState(db, io);

    expect(result).toEqual({ skipped: false });
    expect(io._allRooms).toHaveBeenCalledTimes(1);
    expect(client.hDel).toHaveBeenCalledWith('socket:users', 's-dead');
    expect(client.hDel).not.toHaveBeenCalledWith('socket:users', 's-live');

    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGet).mockResolvedValue(null);
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  // The guard has to compare the two oracles, not test "more than just me":
  // allRooms() resolves after numSub-1 replies without learning WHICH nodes
  // answered, so on three nodes with one peer's subscriber mid-reconnect it
  // returns the other peer's rooms plus our own and calls that complete.
  it('refuses a snapshot that cannot include every live peer (3 nodes, adapter sees 2)', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-on-silent-peer': 'u-a' });
    vi.mocked(client.scanIterator).mockImplementation(async function* () {
      yield ['node:alive:hb-node-1', 'node:alive:peer-x', 'node:alive:peer-y'];
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const io = ioWithAdapter(['s-somewhere-else'], 2);
    const db = makeDb();
    const result = await mod.clearPresenceState(db, io);

    expect(result).toEqual({ skipped: true });
    expect(io._allRooms).not.toHaveBeenCalled();
    expect(client.hDel).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();

    warn.mockRestore();
    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  // The deferred retry of a refused sweep fires after server.listen(), once
  // the corpse heartbeat it waited out has expired — so the node now reads as
  // sole, and re-deriving the mode from the heartbeats would select the full
  // wipe against every client that connected in the meantime.
  it('allowFullWipe:false takes the scoped path as the sole node and spares connected sockets', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-ghost': 'u-ghost', 's-live': 'u-live' });
    // No peers: only our own heartbeat
    vi.mocked(client.scanIterator).mockImplementation(async function* () {
      yield ['node:alive:hb-node-1'];
    });
    vi.mocked(client.hGet).mockImplementation(async (_key, field) =>
      (field === 's-ghost' ? 'u-ghost' : 'u-live'));
    vi.mocked(client.sCard).mockResolvedValue(0);
    vi.mocked(client.sMembers).mockClear();
    vi.mocked(client.del).mockClear();

    // Sole node after listen(): the adapter answers with its own rooms, which
    // IS the cluster's liveness set now. serverCount = 1 must not refuse it —
    // there is no peer whose rooms could be missing.
    const io = ioWithAdapter(['s-live', 'user:u-live'], 1);
    const db = makeDb();
    const result = await mod.clearPresenceState(db, io, { allowFullWipe: false });

    expect(result).toEqual({ skipped: false });
    expect(io._allRooms).toHaveBeenCalledTimes(1);
    expect(client.hDel).toHaveBeenCalledWith('socket:users', 's-ghost');
    expect(client.hDel).not.toHaveBeenCalledWith('socket:users', 's-live');
    // No global wipe, and the DB reset is scoped to the reaped users
    expect(client.del).not.toHaveBeenCalledWith(['online_users', 'socket:users']);
    expect(client.sMembers).not.toHaveBeenCalledWith('online_users');
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { status: 'online', id: { in: ['u-ghost'] } },
      data: { status: 'offline' },
    });
    expect(db.user.updateMany).not.toHaveBeenCalledWith({ where: { status: 'online' }, data: { status: 'offline' } });

    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGet).mockResolvedValue(null);
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  it('reads socket:users BEFORE snapshotting liveness', async () => {
    // Snapshot first and a socket that connects between the two is absent from
    // the snapshot but present in the hash — reaped while its user is online.
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, {});

    const order: string[] = [];
    vi.mocked(client.hGetAll).mockImplementation(async () => { order.push('hash'); return {}; });
    const io = ioWithAdapter([]);
    io._allRooms.mockImplementation(async () => { order.push('snapshot'); return new Set<string>(); });

    await mod.clearPresenceState(makeDb(), io);

    expect(order).toEqual(['hash', 'snapshot']);

    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGetAll).mockReset();
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });

  it('falls back to per-socket lookups when the adapter cannot answer at all', async () => {
    const mod = await import('../../utils/redis');
    await mod.initRedis();
    const client = mod.getRedis();
    await peersAliveWith(client, { 's-dead': 'u-dead' });
    vi.mocked(client.hGet).mockResolvedValue('u-dead');
    vi.mocked(client.sCard).mockResolvedValue(0);

    const io = { in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) };
    await mod.clearPresenceState(makeDb(), io);

    expect(io.in).toHaveBeenCalledWith('s-dead');
    expect(client.hDel).toHaveBeenCalledWith('socket:users', 's-dead');

    // eslint-disable-next-line require-yield
    vi.mocked(client.scanIterator).mockImplementation(async function* () { /* none */ });
    vi.mocked(client.hGet).mockResolvedValue(null);
    vi.mocked(client.hGetAll).mockResolvedValue({});
  });
});
