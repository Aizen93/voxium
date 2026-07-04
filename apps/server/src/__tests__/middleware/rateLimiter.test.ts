import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal Redis mock — getAllRateLimits and socketRateLimit never touch Redis,
// so the client getters can simply throw if anything reaches for them.
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn(() => { throw new Error('Redis not available in unit tests'); }),
  getRedisPubSub: vi.fn(() => { throw new Error('Redis not available in unit tests'); }),
  getRedisConfigSub: vi.fn(() => { throw new Error('Redis not available in unit tests'); }),
}));

import { socketRateLimit, getAllRateLimits } from '../../middleware/rateLimiter';

describe('getAllRateLimits', () => {
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
