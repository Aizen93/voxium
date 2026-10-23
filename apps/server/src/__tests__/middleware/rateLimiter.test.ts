import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getRedis } from '../../utils/redis';

// Minimal Redis mock — getAllRateLimits and socketRateLimit never touch Redis,
// so the client getters can simply throw if anything reaches for them. The
// mocks are hoisted so that every instance of the mocked module (each
// freshRateLimiter() below re-imports it) hands out the SAME functions: the
// `getRedis` imported here is the one every fresh limiter module calls.
const redisMock = vi.hoisted(() => {
  const unavailable = (): never => { throw new Error('Redis not available in unit tests'); };
  return {
    unavailable,
    getRedis: vi.fn(unavailable),
    getRedisPubSub: vi.fn(unavailable),
    getRedisConfigSub: vi.fn(unavailable),
  };
});
vi.mock('../../utils/redis', () => ({
  getRedis: redisMock.getRedis,
  getRedisPubSub: redisMock.getRedisPubSub,
  getRedisConfigSub: redisMock.getRedisConfigSub,
}));

import {
  socketRateLimit, getAllRateLimits, subnetOf, normalizeIp,
  rateLimitWebhookExecute, rateLimitWebhookExecuteIp, rateLimitWebhookManage, rateLimitWebhookRead, rateLimitByKey,
} from '../../middleware/rateLimiter';

/**
 * A fresh instance of the module under test. It caches one limiter per name
 * for its whole lifetime, built on whatever client getRedis returned at that
 * moment: a test that builds one on a working client would otherwise decide
 * what every later test gets (a cached limiter instead of a build failure, a
 * once-value nobody consumes), and the order the tests run in would matter.
 * Every test that builds a limiter does it on its own instance.
 */
async function freshRateLimiter() {
  vi.resetModules();
  return import('../../middleware/rateLimiter');
}
type RateLimiterModule = Awaited<ReturnType<typeof freshRateLimiter>>;

// Nothing one test arranges reaches the next, whatever order they run in: the
// store goes back to unreachable (an unconsumed once-value included), and a
// prototype or console spy a failed assertion skipped restoring is restored.
afterEach(() => {
  vi.mocked(getRedis).mockReset();
  vi.mocked(getRedis).mockImplementation(redisMock.unavailable);
  vi.restoreAllMocks();
});

describe('normalizeIp — one spelling of an address for every keyed control', () => {
  it.each([
    // [input, expected, why]
    ['203.0.113.7', '203.0.113.7', 'plain IPv4 is left alone'],
    ['::ffff:203.0.113.7', '203.0.113.7', 'IPv4-mapped, dotted'],
    ['::FFFF:203.0.113.7', '203.0.113.7', 'IPv4-mapped, UPPERCASE — the old strip was case-sensitive'],
    ['::ffff:cb00:7107', '203.0.113.7', 'IPv4-mapped, hex form — the old strip missed it entirely'],
    ['fe80::1%eth0', 'fe80::1', 'zone id would key a link-local address per NIC'],
    ['2001:DB8::1', '2001:db8::1', 'hex case is not part of the address'],
    // IpBan.ip is an exact-match unique column and every reader queries the
    // normalized form, so a ban an operator typed in any OTHER spelling was a
    // row nothing ever hit. The output is the RFC 5952 text form — what the OS
    // hands Node for a remote address — so writers and readers converge.
    ['2001:db8:0:0:0:0:0:1', '2001:db8::1', 'expanded spelling'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1', 'leading zeros'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1', 'the FIRST of two equal zero runs is compressed'],
    ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::1', 'the LONGEST zero run is compressed'],
    ['2001:db8:0:1:2:3:4:5', '2001:db8:0:1:2:3:4:5', 'a single zero hextet is never collapsed'],
    ['::1', '::1', 'loopback keeps its shape'],
    ['::', '::', 'the unspecified address keeps its shape'],
    ['fe80::1', 'fe80::1', 'an already-canonical address is unchanged'],
    ['unknown', 'unknown', 'non-addresses pass through untouched'],
    [')(*&^%', ')(*&^%', 'a stray % must not truncate garbage'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it('is idempotent — normalizing an already-normalized address is a no-op', () => {
    for (const ip of ['2001:db8::1:0:0:1', '203.0.113.7', 'fe80::1', '2001:db8:0:1::1', '::']) {
      expect(normalizeIp(normalizeIp(ip))).toBe(normalizeIp(ip));
    }
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
    const { consumeMailCap } = await freshRateLimiter();
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

describe('incoming-webhook limiters', () => {
  const byName = (name: string) => getAllRateLimits().find((l) => l.name === name);

  it('registers the four webhook rows under rl: with their key types and budgets', () => {
    expect(byName('webhookExecute')).toMatchObject({
      keyPrefix: 'rl:whexec', points: 30, duration: 60, blockDuration: 0, keyType: 'webhook', label: 'Webhook Execute (per webhook)',
    });
    expect(byName('webhookExecuteIp')).toMatchObject({
      keyPrefix: 'rl:whexecip', points: 1200, duration: 60, blockDuration: 0, keyType: 'ip', label: 'Webhook Execute (per IP)',
    });
    expect(byName('webhookManage')).toMatchObject({
      keyPrefix: 'rl:whmanage', points: 30, duration: 3600, blockDuration: 0, keyType: 'userId', label: 'Webhook Manage',
    });
    expect(byName('webhookRead')).toMatchObject({
      keyPrefix: 'rl:whread', points: 60, duration: 60, blockDuration: 0, keyType: 'userId', label: 'Webhook Read',
    });
  });

  it('keeps every key prefix distinct (two rows on one prefix would share a bucket)', () => {
    const prefixes = getAllRateLimits().map((l) => l.keyPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('exports the four middlewares and the generic rateLimitByKey factory', () => {
    for (const mw of [rateLimitWebhookExecute, rateLimitWebhookExecuteIp, rateLimitWebhookManage, rateLimitWebhookRead]) {
      expect(typeof mw).toBe('function');
      expect(mw.length).toBe(3); // (req, res, next)
    }
    expect(typeof rateLimitByKey).toBe('function');
    expect(typeof rateLimitByKey('webhookExecute', () => 'k')).toBe('function');
  });

  it('fails OPEN like every other limiter when the store is unreachable (the module-level Redis mock throws)', async () => {
    const rl = await freshRateLimiter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = { params: { webhookId: 'wh-1' }, ip: '203.0.113.7', socket: {} } as any;
    const res = { set: vi.fn(), status: vi.fn(() => ({ json: vi.fn() })) } as any;
    for (const mw of [rl.rateLimitWebhookExecuteIp, rl.rateLimitWebhookExecute]) {
      const next = vi.fn();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }
    expect(res.status).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('refundRateLimit — give a charged point back, fail-open', () => {
  let rl: RateLimiterModule;
  beforeEach(async () => {
    rl = await freshRateLimiter();
  });

  it("rewards ONE point of the named limiter's bucket for the key", async () => {
    // A store client the limiter can be built on (the module-level mock throws)
    vi.mocked(getRedis).mockReturnValueOnce({} as ReturnType<typeof getRedis>);
    const seen: Array<{ prefix: string; key: string; points: unknown }> = [];
    const reward = vi.spyOn(RateLimiterRedis.prototype, 'reward').mockImplementation(async function (this: RateLimiterRedis, key, points) {
      seen.push({ prefix: this.keyPrefix, key: String(key), points });
      return undefined as never;
    });

    await expect(rl.refundRateLimit('webhookExecute', 'wh-1')).resolves.toBeUndefined();

    // no points argument: the limiter's default, one point
    expect(seen).toEqual([{ prefix: 'rl:whexec', key: 'wh-1', points: undefined }]);
    reward.mockRestore();
  });

  it('swallows a store error with a warning, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reward = vi.spyOn(RateLimiterRedis.prototype, 'reward').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // A limiter built on a store whose reward fails (this test's own module
    // has built none yet, so webhookRead is created here, on this client)
    vi.mocked(getRedis).mockReturnValueOnce({} as ReturnType<typeof getRedis>);
    await expect(rl.refundRateLimit('webhookRead', 'user-1')).resolves.toBeUndefined();
    expect(reward).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[RateLimit] webhookRead refund failed:', 'ECONNREFUSED');

    // No store at all (the module-level mock throws while building the limiter)
    await expect(rl.refundRateLimit('webhookExecuteIp', '203.0.113.7')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[RateLimit] webhookExecuteIp refund failed:', 'Redis not available in unit tests');

    // An unknown limiter name is a warning too, not a throw
    await expect(rl.refundRateLimit('noSuchLimiter', 'k')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[RateLimit] noSuchLimiter refund failed:', 'Unknown rate limiter: noSuchLimiter');
    reward.mockRestore();
    warn.mockRestore();
  });
});

describe('incoming-webhook limiters — the bucket each one charges, and its KEY', () => {
  const TOKEN = 'SECRET-TOKEN-zM9vYmFy';
  let rl: RateLimiterModule;
  let seen: Array<{ prefix: string; key: string }>;
  let consume: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rl = await freshRateLimiter();
    // A store client the limiters can be built on (the module-level mock throws)
    vi.mocked(getRedis).mockImplementation(() => ({}) as ReturnType<typeof getRedis>);
    seen = [];
    consume = vi.spyOn(RateLimiterRedis.prototype, 'consume').mockImplementation(async function (this: RateLimiterRedis, key) {
      seen.push({ prefix: this.keyPrefix, key: String(key) });
      return {} as never;
    });
  });

  afterEach(() => {
    consume.mockRestore();
  });

  /** One request carrying every key a limiter could wrongly pick: the URL's
   *  webhook id AND token, an address, a user. */
  function executeRequest(extra: Record<string, unknown> = {}) {
    return { params: { webhookId: 'wh-1', token: TOKEN }, ip: '203.0.113.7', socket: {}, ...extra } as any;
  }

  async function charge(mw: (req: any, res: any, next: any) => Promise<void>, req: any) {
    const res = { set: vi.fn(), status: vi.fn(() => ({ json: vi.fn() })) } as any;
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  }

  it('rateLimitWebhookExecute charges rl:whexec keyed on the webhook id: never the IP, never the token', async () => {
    await charge(rl.rateLimitWebhookExecute, executeRequest());

    expect(seen).toEqual([{ prefix: 'rl:whexec', key: 'wh-1' }]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it('rateLimitWebhookExecuteIp charges rl:whexecip keyed on the (normalised) address: never the id, never the token', async () => {
    await charge(rl.rateLimitWebhookExecuteIp, executeRequest());
    await charge(rl.rateLimitWebhookExecuteIp, executeRequest({ ip: '::FFFF:203.0.113.7' }));

    expect(seen).toEqual([
      { prefix: 'rl:whexecip', key: '203.0.113.7' },
      { prefix: 'rl:whexecip', key: '203.0.113.7' },
    ]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it('rateLimitWebhookManage and rateLimitWebhookRead charge rl:whmanage / rl:whread keyed on the user id', async () => {
    const req = executeRequest({ params: { serverId: 'srv-1', webhookId: 'wh-1', token: TOKEN }, user: { userId: 'user-9' } });

    await charge(rl.rateLimitWebhookManage, req);
    await charge(rl.rateLimitWebhookRead, req);

    expect(seen).toEqual([
      { prefix: 'rl:whmanage', key: 'user-9' },
      { prefix: 'rl:whread', key: 'user-9' },
    ]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
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

// ─── Middleware order on userId-keyed limiters ──────────────────────────────

describe('userId-keyed limiters sit AFTER authenticate on every auth route', () => {
  // byUserId falls back to req.ip when there is no req.user yet. A limiter
  // listed before authenticate therefore keys on the address — one bucket
  // for everyone behind a NAT — and the load test found it: the 11th account
  // to accept the legal documents from one IP was refused, and the deletion
  // bucket would have BLOCKED a whole office for 15 minutes on one person's
  // typos. Read the route file rather than mount it: this is about the
  // order of the argument list, which a request-level test cannot see.
  const source = readFileSync(resolve(__dirname, '../../routes/auth.ts'), 'utf8');
  const userKeyed = getAllRateLimits().filter((l) => l.keyType === 'userId').map((l) => l.name);
  const middlewareFor = (name: string) => `rateLimit${name[0].toUpperCase()}${name.slice(1)}`;

  it('covers the limiters this test is about', () => {
    expect(userKeyed).toEqual(expect.arrayContaining(['consent', 'deleteAccount', 'resendVerification']));
  });

  it.each(userKeyed.map(middlewareFor).filter((mw) => source.includes(mw)))('%s comes after authenticate', (mw) => {
    const routes = source
      .split(/\r?\n/)
      .filter((line) => /^authRouter\.[a-z]+\(/.test(line) && new RegExp(`\\b${mw}\\b`).test(line));
    expect(routes.length, `${mw} is imported but mounted on no route`).toBeGreaterThan(0);
    for (const line of routes) {
      const auth = line.indexOf('authenticate');
      const lim = line.indexOf(mw);
      expect(auth, `${line.trim()} — no authenticate`).toBeGreaterThan(-1);
      expect(auth, `${line.trim()} — limiter before authenticate`).toBeLessThan(lim);
    }
  });
});
