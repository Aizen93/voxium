import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal Redis mock — getAllRateLimits and socketRateLimit never touch Redis,
// so the client getters can simply throw if anything reaches for them.
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn(() => { throw new Error('Redis not available in unit tests'); }),
  getRedisPubSub: vi.fn(() => { throw new Error('Redis not available in unit tests'); }),
  getRedisConfigSub: vi.fn(() => { throw new Error('Redis not available in unit tests'); }),
}));

import { socketRateLimit, getAllRateLimits, subnetOf, normalizeIp, consumeMailCap } from '../../middleware/rateLimiter';

describe('normalizeIp — one spelling of an address for every keyed control', () => {
  it.each([
    // [input, expected, why]
    ['203.0.113.7', '203.0.113.7', 'plain IPv4 is left alone'],
    ['::ffff:203.0.113.7', '203.0.113.7', 'IPv4-mapped, dotted'],
    ['::FFFF:203.0.113.7', '203.0.113.7', 'IPv4-mapped, UPPERCASE — the old strip was case-sensitive'],
    ['::ffff:cb00:7107', '203.0.113.7', 'IPv4-mapped, hex form — the old strip missed it entirely'],
    ['fe80::1%eth0', 'fe80::1', 'zone id would key a link-local address per NIC'],
    ['2001:DB8::1', '2001:db8::1', 'hex case is not part of the address'],
    ['unknown', 'unknown', 'non-addresses pass through untouched'],
    [')(*&^%', ')(*&^%', 'a stray % must not truncate garbage'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });
});

describe('subnetOf — the range key the slow-drip counters group by', () => {
  it('keeps the documented IPv4 /24 and IPv6 /48 behaviour', () => {
    expect(subnetOf('203.0.113.9')).toBe('203.0.113.0/24');
    expect(subnetOf('::ffff:203.0.113.9')).toBe('203.0.113.0/24');
    expect(subnetOf('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
  });

  it('passes through unparseable input rather than grouping strangers together', () => {
    expect(subnetOf('unknown')).toBe('unknown');
    expect(subnetOf('1.2.3')).toBe('1.2.3');
    // The old implementation decorated this with '::/48' because it merely
    // looked for a colon
    expect(subnetOf('a:b')).toBe('a:b');
  });

  // F7: the key was built by splitting the COMPRESSED text — '2001:db8::a'
  // splits to ['2001','db8','','a'], losing the third hextet. Addresses inside
  // one /48 landed in different buckets (doubling the daily budget), and with
  // hextets 2 and 3 both zero the key absorbed the interface id, degrading the
  // /48 limiter to per-address.
  it.each([
    ['2001:db8::a', '2001:db8:0:1::a'],
    ['2001:db8:1::a', '2001:db8:1:99::a'],
    ['2001::1', '2001::2'],
    ['2001::abcd:1', '2001:0:0:1::1'],
    ['fd00::1', 'fd00::2'],
    ['2001:DB8::1', '2001:db8:0:5::9'],
    ['203.0.113.7', '203.0.113.200'],
    ['::ffff:203.0.113.7', '::FFFF:cb00:71c8'],
  ])('groups %s and %s into one bucket', (a, b) => {
    expect(subnetOf(a)).toBe(subnetOf(b));
  });

  it.each([
    // Neighbouring /48s — grouping these together would let one customer site
    // spend its neighbour's budget
    ['2001:db8:1::1', '2001:db8:2::1'],
    ['2a01:e0a::5', '2a01:e0a:1:2::5'],
    ['203.0.113.7', '203.0.114.7'],
  ])('keeps %s and %s in separate buckets', (a, b) => {
    expect(subnetOf(a)).not.toBe(subnetOf(b));
  });
});

describe('consumeMailCap', () => {
  it('FAILS OPEN when the store is unreachable — a broken counter must not block verification mail', async () => {
    // The module-level getRedis mock throws, so limiter construction fails
    await expect(consumeMailCap('verifyMail', 'someone@example.com')).resolves.toBe(true);
    await expect(consumeMailCap('resetMail', 'someone@example.com')).resolves.toBe(true);
  });
});

describe('getAllRateLimits', () => {
  it('registers every abuse counter under the rl: prefix', () => {
    // The e2e fixture, clearUserRateLimits and the admin rate-limit API all
    // key off this prefix — a bare Redis counter is invisible to all three.
    for (const limit of getAllRateLimits()) {
      expect(limit.keyPrefix, `${limit.name} must live under rl:`).toMatch(/^rl:/);
    }
  });

  it('exposes the per-inbox mail caps and the registration attempt bucket as tunable rules', () => {
    const names = getAllRateLimits().map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(['verifyMail', 'resetMail', 'registerAttempt']));
    // blockDuration must stay 0 on the daily buckets: a block would push the
    // window past 24h and strand the inbox for longer than the cap intends.
    for (const name of ['verifyMail', 'resetMail', 'registerDaily', 'registerSubnet', 'registerAttempt']) {
      expect(getAllRateLimits().find((l) => l.name === name)!.blockDuration).toBe(0);
    }
  });
});

describe('getAllRateLimits (key types)', () => {
  it('includes the interact limiter keyed by userId (P2 — NAT-shared IP budgets)', () => {
    const limits = getAllRateLimits();
    const interact = limits.find((l) => l.name === 'interact');

    expect(interact).toBeDefined();
    expect(interact).toMatchObject({ name: 'interact', keyType: 'userId' });
  });

  it('keeps the general limiter keyed by ip', () => {
    const limits = getAllRateLimits();
    const general = limits.find((l) => l.name === 'general');

    expect(general).toBeDefined();
    expect(general).toMatchObject({ name: 'general', keyType: 'ip' });
  });
});

describe('socketRateLimit', () => {
  beforeEach(() => {
    // Use real timers by default; tests that manipulate time will use fake timers
    vi.useRealTimers();
  });

  it('allows events up to maxPerMinute', () => {
    const socket = {};
    const max = 5;

    for (let i = 0; i < max; i++) {
      expect(socketRateLimit(socket, 'test:event', max)).toBe(true);
    }
  });

  it('blocks after maxPerMinute is exceeded', () => {
    const socket = {};
    const max = 3;

    // Consume all allowed
    for (let i = 0; i < max; i++) {
      socketRateLimit(socket, 'test:event', max);
    }

    // Next call should be blocked
    expect(socketRateLimit(socket, 'test:event', max)).toBe(false);
  });

  it('tracks events independently per event name', () => {
    const socket = {};
    const max = 2;

    // Use up all "eventA" quota
    socketRateLimit(socket, 'eventA', max);
    socketRateLimit(socket, 'eventA', max);
    expect(socketRateLimit(socket, 'eventA', max)).toBe(false);

    // "eventB" should still be allowed
    expect(socketRateLimit(socket, 'eventB', max)).toBe(true);
    expect(socketRateLimit(socket, 'eventB', max)).toBe(true);
    expect(socketRateLimit(socket, 'eventB', max)).toBe(false);
  });

  it('tracks different sockets separately (WeakMap isolation)', () => {
    const socket1 = {};
    const socket2 = {};
    const max = 2;

    // Exhaust socket1 quota
    socketRateLimit(socket1, 'event', max);
    socketRateLimit(socket1, 'event', max);
    expect(socketRateLimit(socket1, 'event', max)).toBe(false);

    // socket2 should be unaffected
    expect(socketRateLimit(socket2, 'event', max)).toBe(true);
    expect(socketRateLimit(socket2, 'event', max)).toBe(true);
    expect(socketRateLimit(socket2, 'event', max)).toBe(false);
  });

  it('resets the bucket after the 60-second window', () => {
    vi.useFakeTimers();
    const socket = {};
    const max = 2;

    // Exhaust the limit
    socketRateLimit(socket, 'event', max);
    socketRateLimit(socket, 'event', max);
    expect(socketRateLimit(socket, 'event', max)).toBe(false);

    // Advance time past the 60-second window
    vi.advanceTimersByTime(61_000);

    // Should be allowed again
    expect(socketRateLimit(socket, 'event', max)).toBe(true);

    vi.useRealTimers();
  });

  it('returns true for first event with maxPerMinute of 1', () => {
    const socket = {};
    expect(socketRateLimit(socket, 'strict', 1)).toBe(true);
    expect(socketRateLimit(socket, 'strict', 1)).toBe(false);
  });
});
