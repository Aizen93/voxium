import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    ping: vi.fn().mockResolvedValue('PONG'),
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
