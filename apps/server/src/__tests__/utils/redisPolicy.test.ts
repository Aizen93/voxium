import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkRedisEvictionPolicy, type RedisConfigReader } from '../../utils/redisPolicy';

// The startup look at Redis's eviction settings: one log line, a warning when
// Redis may drop the state the server keeps there, and never a throw (a
// managed Redis may refuse CONFIG, and an evicting Redis still serves).

function reader(answer: Record<string, string> | Error): RedisConfigReader & { configGet: ReturnType<typeof vi.fn> } {
  return {
    configGet: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkRedisEvictionPolicy', () => {
  it('asks for both settings in one CONFIG GET with one pattern (Redis before 7 takes a single parameter)', async () => {
    const redis = reader({ maxmemory: '268435456', 'maxmemory-policy': 'noeviction', 'maxmemory-samples': '5' });
    await expect(checkRedisEvictionPolicy(redis)).resolves.toBe('noeviction');
    expect(redis.configGet).toHaveBeenCalledTimes(1);
    expect(redis.configGet).toHaveBeenCalledWith('maxmemory*');
  });

  it('is quiet about noeviction: one info line, no warning', async () => {
    await expect(checkRedisEvictionPolicy(reader({ maxmemory: '268435456', 'maxmemory-policy': 'noeviction' }))).resolves.toBe('noeviction');
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('noeviction');
  });

  it.each(['allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl'])(
    'warns about %s with a memory limit, and names the fix',
    async (policy) => {
      await expect(checkRedisEvictionPolicy(reader({ maxmemory: '268435456', 'maxmemory-policy': policy }))).resolves.toBe('evicting');
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(`maxmemory-policy is ${policy}`);
      expect(line).toContain('Set maxmemory-policy noeviction');
    },
  );

  it('does not warn when no memory limit is set (nothing is evicted whatever the policy)', async () => {
    await expect(checkRedisEvictionPolicy(reader({ maxmemory: '0', 'maxmemory-policy': 'allkeys-lru' }))).resolves.toBe('no-limit');
    expect(warn).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain('No maxmemory limit');
  });

  it('warns and goes on when CONFIG is refused (a managed Redis may not allow it)', async () => {
    const redis = reader(new Error("ERR unknown command 'CONFIG'"));
    await expect(checkRedisEvictionPolicy(redis)).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain("ERR unknown command 'CONFIG'");
    expect(warn.mock.calls[0].join(' ')).toContain('noeviction');
  });

  it('treats an answer without the two settings as unreadable', async () => {
    await expect(checkRedisEvictionPolicy(reader({}))).resolves.toBe('unknown');
    await expect(checkRedisEvictionPolicy(reader({ maxmemory: 'lots', 'maxmemory-policy': 'noeviction' }))).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('the server runs the check right after connecting to Redis', () => {
  it('index.ts awaits it on the client initRedis returned, before anything else uses Redis', () => {
    const index = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
    const connect = index.indexOf('const redis = await initRedis();');
    const check = index.indexOf('await checkRedisEvictionPolicy(redis);');
    const heartbeat = index.indexOf('await startNodeHeartbeat();');
    expect(connect).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(connect);
    expect(check).toBeLessThan(heartbeat);
  });
});
