import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

import jwt from 'jsonwebtoken';
import {
  socketRateLimit, getAllRateLimits, subnetOf, normalizeIp, loginAccountKey, loginEmailDigest, totpAccountKey, verifiedBearerUserId,
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

  // Whole-word: `rateLimitTotpAccount` (the sign-in's per-account TOTP bucket,
  // keyed on the challenge token, mounted before any authenticate on purpose)
  // must not be read as the userId-keyed `rateLimitTotp`
  it.each(userKeyed.map(middlewareFor).filter((mw) => new RegExp(`\\b${mw}\\b`).test(source)))('%s comes after authenticate', (mw) => {
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


// ─── Issue 4: false 429s for ordinary use ────────────────────────────────────
//
// Every `keyType: 'ip'` bucket is shared by everyone behind one address. The
// general budget (100/min) was exceeded by three people navigating at once
// (one measured at 35–60 requests a minute), and sign-in counted successes
// too, at 5 a minute per address with a 5-minute block: a handful of testers
// signing in from one office locked the office out of the login page.

const TEST_SECRET = 'rate-limiter-test-secret';

/** A Redis client that exists but fails every command: RateLimiterRedis then
 *  falls back to its in-memory insurance limiter, which COUNTS — so these
 *  tests exercise the real budgets, not the fail-open path. */
const brokenRedis = { multi: () => { throw new Error('redis down'); } };

function fakeReq(ip: string, body: Record<string, unknown> = {}) {
  return { ip, socket: { remoteAddress: ip }, body, params: {}, headers: {} };
}

function fakeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    set(name: string, value: string) { res.headers[name] = value; return res; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    on(event: string, fn: () => void) { (listeners[event] ??= []).push(fn); return res; },
    /** The route answered: fire 'finish' with this status. */
    finish(code: number) { res.statusCode = code; for (const fn of listeners.finish ?? []) fn(); },
  };
  return res;
}

type Middleware = (req: never, res: never, next: () => void) => Promise<void>;

/** Run a limiter middleware; `passed` is whether it called next(). */
async function hit(mw: Middleware, req: ReturnType<typeof fakeReq>) {
  const res = fakeRes();
  let passed = false;
  await mw(req as never, res as never, () => { passed = true; });
  return { res, passed };
}

/** A request the route then answered with `status` (its refund, if any, has landed). */
async function hitAndAnswer(mw: Middleware, req: ReturnType<typeof fakeReq>, status: number) {
  const out = await hit(mw, req);
  if (out.passed) out.res.finish(status);
  await new Promise((r) => setImmediate(r)); // the refund is asynchronous
  return out;
}

/** A challenge token as the server mints one (authService.loginUser). */
function totpToken(userId: string, extra: Record<string, unknown> = {}, secret = TEST_SECRET): string {
  return jwt.sign({ userId, purpose: 'totp-verify', rememberMe: true, ...extra }, secret, { expiresIn: '5m' });
}

describe('the budgets a NAT shares (issue 4)', () => {
  const rows = Object.fromEntries(getAllRateLimits().map((l) => [l.name, l]));

  it('the general per-address budget is sized for a room of users, not one', () => {
    // ~35–60 requests a minute per active user (measured); at 100, three
    // people behind one NAT were refused ordinary reads
    expect(rows.general).toMatchObject({ keyType: 'ip', points: 1000, duration: 60, blockDuration: 0 });
  });

  it('sign-in counts failures per address, per network AND per account; only the address bucket blocks', () => {
    expect(rows.login).toMatchObject({ keyType: 'ip', points: 20, duration: 60, blockDuration: 300 });
    expect(rows.loginSubnet).toMatchObject({ keyType: 'ip', points: 60, duration: 60, blockDuration: 0, keyPrefix: 'rl:loginnet' });
    expect(rows.loginAccount).toMatchObject({ keyType: 'account', points: 10, duration: 900, blockDuration: 0, keyPrefix: 'rl:loginacct' });
  });

  it('the refresh, verify-email and registration-burst buckets no longer refuse a group behind one address', () => {
    expect(rows.refresh).toMatchObject({ keyType: 'ip', points: 60, duration: 60 });
    expect(rows.verifyEmail).toMatchObject({ keyType: 'ip', points: 20, duration: 900, blockDuration: 0 });
    expect(rows.register).toMatchObject({ keyType: 'ip', points: 5, duration: 60, blockDuration: 120 });
  });

  it('the registration DAILY budgets are untouched (the real bound on signup abuse)', () => {
    expect(rows.registerDaily).toMatchObject({ points: 5, duration: 86400 });
    expect(rows.registerAttempt).toMatchObject({ points: 30, duration: 86400 });
    expect(rows.registerAttemptSubnet).toMatchObject({ points: 300, duration: 86400 });
  });

  it('the routes the general budget alone used to bound got buckets of their own', () => {
    expect(rows.profileUpdate).toMatchObject({ keyType: 'userId', points: 10, duration: 60 });
    expect(rows.inviteUse).toMatchObject({ keyType: 'userId', points: 20, duration: 60 });
    expect(rows.dmOpen).toMatchObject({ keyType: 'userId', points: 30, duration: 60 });
    expect(rows.attachmentRead).toMatchObject({ keyType: 'ip', points: 300, duration: 60 });
  });

  it('every key prefix is still distinct', () => {
    const prefixes = getAllRateLimits().map((l) => l.keyPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('loginAccountKey / totpAccountKey — the account a sign-in is for', () => {
  const secretBefore = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = TEST_SECRET; });
  afterEach(() => { process.env.JWT_SECRET = secretBefore; });

  it('keys the password step on the account AND the network: an HMAC of the lowercased, trimmed e-mail, then the subnet', () => {
    const key = loginAccountKey('Alice@Example.com ', '203.0.113.0/24');
    expect(key).toMatch(/^e:[0-9a-f]{32}\|203\.0\.113\.0\/24$/);
    expect(key).not.toContain('alice');
    expect(loginAccountKey('alice@example.com', '203.0.113.0/24')).toBe(key);
    expect(loginAccountKey('alice@example.com', '198.51.100.0/24')).not.toBe(key); // another network: its own bucket
    expect(loginAccountKey('bob@example.com', '203.0.113.0/24')).not.toBe(key);
  });

  it('the e-mail digest is keyed off JWT_SECRET (a plain hash in Redis could be tested against candidate addresses)', () => {
    const a = loginEmailDigest('alice@example.com');
    process.env.JWT_SECRET = 'another-secret';
    expect(loginEmailDigest('alice@example.com')).not.toBe(a);
  });

  it('a body without a usable e-mail names no account (the caller is charged on its own address)', () => {
    for (const bad of [undefined, null, 42, '', '   ']) expect(loginAccountKey(bad, '203.0.113.0/24')).toBeNull();
  });

  it('keys the TOTP step on the userId of a challenge token whose signature VERIFIES, an expired one included', () => {
    expect(totpAccountKey(totpToken('clx1user'))).toBe('t:clx1user');
    const expired = jwt.sign({ userId: 'clx1user', purpose: 'totp-verify', exp: Math.floor(Date.now() / 1000) - 60 }, TEST_SECRET);
    expect(totpAccountKey(expired)).toBe('t:clx1user');
  });

  it('a FORGED token names no account: it used to pick any victim\'s bucket with nothing but their public userId', () => {
    const forged = jwt.sign({ userId: 'clxvictim', purpose: 'totp-verify' }, 'not-our-secret');
    expect(totpAccountKey(forged)).toBeNull();
    const payload = Buffer.from(JSON.stringify({ userId: 'clxvictim', purpose: 'totp-verify' })).toString('base64url');
    expect(totpAccountKey(`eyJhbGciOiJIUzI1NiJ9.${payload}.forged`)).toBeNull();
    // alg:none and a token of another purpose are refused too
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    expect(totpAccountKey(none)).toBeNull();
    expect(totpAccountKey(jwt.sign({ userId: 'clx1user', purpose: 'trusted-device' }, TEST_SECRET))).toBeNull();
  });

  it('anything that is not a token with a well-formed userId names no account', () => {
    for (const value of [undefined, 42, '', 'not.a-token', 'a.b', 'h.!!!.s', 'x'.repeat(5000)]) {
      expect(totpAccountKey(value)).toBeNull();
    }
    expect(totpAccountKey(jwt.sign({ userId: 'has spaces and <tags>', purpose: 'totp-verify' }, TEST_SECRET))).toBeNull();
  });
});

describe('sign-in limiters count FAILURES only (refund on a 2xx, and on a 429 from a later bucket)', () => {
  let mod: RateLimiterModule;
  const secretBefore = process.env.JWT_SECRET;
  beforeEach(async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    vi.mocked(getRedis).mockReturnValue(brokenRedis as never);
    mod = await freshRateLimiter();
  });
  afterEach(() => { process.env.JWT_SECRET = secretBefore; });

  it('a team signing in correctly from one address never spends the per-address budget', async () => {
    const req = () => fakeReq('203.0.113.10', { email: 'anyone@example.com', password: 'right' });
    for (let i = 0; i < 60; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLogin as Middleware, req(), 200);
      expect(passed, `sign-in #${i + 1}`).toBe(true);
    }
  });

  it('a TOTP step that answers 200 (password right, code pending) is refunded too', async () => {
    const req = () => fakeReq('203.0.113.11', { email: 'totp@example.com', password: 'right' });
    for (let i = 0; i < 30; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLogin as Middleware, req(), 200);
      expect(passed).toBe(true);
    }
  });

  it('20 failures from one address within a minute are refused on the 21st, with Retry-After and the common body, and the block holds', async () => {
    const req = () => fakeReq('203.0.113.12', { email: 'victim@example.com', password: 'wrong' });
    for (let i = 0; i < 20; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLogin as Middleware, req(), 401);
      expect(passed, `failure #${i + 1}`).toBe(true);
    }
    const refused = await hit(mod.rateLimitLogin as Middleware, req());
    expect(refused.passed).toBe(false);
    expect(refused.res.statusCode).toBe(429);
    expect(Number(refused.res.headers['Retry-After'])).toBeGreaterThan(60); // the 300 s block, not the 60 s window
    expect(refused.res.body).toEqual({ success: false, error: 'Too many requests. Please try again later.' });
    // a right password during the block is still refused: the block is per address
    const stillBlocked = await hit(mod.rateLimitLogin as Middleware, fakeReq('203.0.113.12', { email: 'other@example.com', password: 'right' }));
    expect(stillBlocked.passed).toBe(false);
  });

  it('a 429 answered by a LATER bucket refunds this one: a refused request never reached the password check', async () => {
    const req = () => fakeReq('203.0.113.15', { email: 'locked@example.com', password: 'wrong' });
    for (let i = 0; i < 40; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLogin as Middleware, req(), 429);
      expect(passed, `refused-later request #${i + 1}`).toBe(true);
    }
  });

  it('60 failures from one /24 within a minute refuse the 61st address of that network (IPv6 rotation inside a /48 is bounded the same way)', async () => {
    for (let i = 0; i < 60; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLoginSubnet as Middleware, fakeReq(`198.51.100.${i}`, { email: `u${i}@example.com`, password: 'wrong' }), 401);
      expect(passed, `failure #${i + 1}`).toBe(true);
    }
    expect((await hit(mod.rateLimitLoginSubnet as Middleware, fakeReq('198.51.100.200', { email: 'x@example.com', password: 'wrong' }))).passed).toBe(false);
    // a neighbouring /24 is untouched
    expect((await hit(mod.rateLimitLoginSubnet as Middleware, fakeReq('198.51.101.1', { email: 'x@example.com', password: 'wrong' }))).passed).toBe(true);
  });

  it('10 failed guesses at ONE account from ONE network within 15 minutes refuse the 11th; another network and another account are untouched', async () => {
    for (let i = 0; i < 10; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLoginAccount as Middleware, fakeReq(`198.51.100.${i}`, { email: 'Victim@Example.com', password: 'wrong' }), 401);
      expect(passed, `guess #${i + 1}`).toBe(true);
    }
    const eleventh = await hit(mod.rateLimitLoginAccount as Middleware, fakeReq('198.51.100.99', { email: 'victim@example.com ', password: 'wrong' }));
    expect(eleventh.passed).toBe(false);
    expect(eleventh.res.statusCode).toBe(429);
    expect(Number(eleventh.res.headers['Retry-After'])).toBeLessThanOrEqual(900); // the window, no block on top

    // the victim signing in from home (another network) is NOT locked out by a stranger's guesses
    expect((await hit(mod.rateLimitLoginAccount as Middleware, fakeReq('203.0.113.50', { email: 'victim@example.com', password: 'right' }))).passed).toBe(true);
    // and a bystander on the guessing network is untouched
    expect((await hit(mod.rateLimitLoginAccount as Middleware, fakeReq('198.51.100.99', { email: 'bystander@example.com', password: 'wrong' }))).passed).toBe(true);
  });

  it('the TOTP step keys the account on the VERIFIED challenge token, so a code cannot be walked from many addresses', async () => {
    const token = totpToken('clxvictim');
    for (let i = 0; i < 10; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitTotpAccount as Middleware, fakeReq(`198.51.${i}.1`, { totpToken: token, code: '000000' }), 401);
      expect(passed).toBe(true);
    }
    const eleventh = await hit(mod.rateLimitTotpAccount as Middleware, fakeReq('192.0.2.1', { totpToken: token, code: '000001' }));
    expect(eleventh.passed).toBe(false);
    expect(eleventh.res.statusCode).toBe(429);
  });

  it('forged challenge tokens are charged on the SENDER\'s address and never touch the victim\'s bucket', async () => {
    const forged = jwt.sign({ userId: 'clxvictim', purpose: 'totp-verify' }, 'not-our-secret');
    for (let i = 0; i < 10; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitTotpAccount as Middleware, fakeReq('192.0.2.66', { totpToken: forged, code: '000000' }), 401);
      expect(passed).toBe(true);
    }
    // the sender's own address bucket is spent...
    expect((await hit(mod.rateLimitTotpAccount as Middleware, fakeReq('192.0.2.66', { totpToken: forged, code: '000000' }))).passed).toBe(false);
    // ...the victim's real token is untouched
    expect((await hit(mod.rateLimitTotpAccount as Middleware, fakeReq('203.0.113.50', { totpToken: totpToken('clxvictim'), code: '123456' }))).passed).toBe(true);
  });

  it('a right answer on the account bucket is refunded as well', async () => {
    for (let i = 0; i < 30; i++) {
      const { passed } = await hitAndAnswer(mod.rateLimitLoginAccount as Middleware, fakeReq('203.0.113.13', { email: 'regular@example.com', password: 'right' }), 200);
      expect(passed).toBe(true);
    }
  });

  it('an aborted request (no finish) keeps its charge — the safe direction for a guessing counter', async () => {
    const req = () => fakeReq('203.0.113.14', { email: 'x@example.com', password: 'wrong' });
    for (let i = 0; i < 20; i++) {
      const { passed } = await hit(mod.rateLimitLogin as Middleware, req()); // never answered
      expect(passed).toBe(true);
    }
    expect((await hit(mod.rateLimitLogin as Middleware, req())).passed).toBe(false);
  });

  it('a key function that throws fails OPEN like a store error, never a 500', async () => {
    const mw = mod.rateLimitByKey('general', () => { throw new Error('bad key'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { passed } = await hit(mw as Middleware, fakeReq('203.0.113.1'));
    expect(passed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('general limiter error'), 'bad key');
  });
});

describe('rateLimitGeneral — ordinary navigation behind one NAT is not a false positive', () => {
  let mod: RateLimiterModule;
  beforeEach(async () => {
    vi.mocked(getRedis).mockReturnValue(brokenRedis as never);
    mod = await freshRateLimiter();
  });

  it('a room of 20 people each doing a measured session (login + screen, two servers, six channels, a reload ≈ 45 requests) within one minute all get through', async () => {
    const nat = '203.0.113.20';
    for (let user = 0; user < 20; user++) {
      for (let r = 0; r < 45; r++) {
        const { passed } = await hit(mod.rateLimitGeneral as Middleware, fakeReq(nat));
        expect(passed, `user ${user} request ${r}`).toBe(true);
      }
    }
  });

  it('one address spraying past the budget is still refused, with Retry-After and the common body', async () => {
    const ip = '203.0.113.21';
    for (let r = 0; r < 1000; r++) {
      expect((await hit(mod.rateLimitGeneral as Middleware, fakeReq(ip))).passed).toBe(true);
    }
    const refused = await hit(mod.rateLimitGeneral as Middleware, fakeReq(ip));
    expect(refused.passed).toBe(false);
    expect(refused.res.statusCode).toBe(429);
    expect(Number(refused.res.headers['Retry-After'])).toBeGreaterThan(0);
    expect(refused.res.body).toEqual({ success: false, error: 'Too many requests. Please try again later.' });
    // and a different address is untouched
    expect((await hit(mod.rateLimitGeneral as Middleware, fakeReq('203.0.113.22'))).passed).toBe(true);
  });
});

describe('clearUserRateLimits — the admin tool reaches the account buckets too', () => {
  const secretBefore = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = TEST_SECRET; });
  afterEach(() => { process.env.JWT_SECRET = secretBefore; });

  it('a user id clears its TOTP account bucket; an e-mail clears its password buckets on every network (found by scan)', async () => {
    const digest = loginEmailDigest('alice@example.com');
    const scanned = [`rl:loginacct:e:${digest}|203.0.113.0/24`, `rl:loginacct:e:${digest}|2001:db8:1::/48`];
    const del = vi.fn(async () => 1);
    const scanIterator = vi.fn(async function* () { yield scanned; });
    vi.mocked(getRedis).mockReturnValue({ del, scanIterator } as never);
    const mod = await freshRateLimiter();

    await mod.clearUserRateLimits('clx1user');
    expect(del).toHaveBeenCalledWith('rl:loginacct:t:clx1user');
    expect(scanIterator).not.toHaveBeenCalled();

    del.mockClear();
    const cleared = await mod.clearUserRateLimits('Alice@Example.com');
    expect(scanIterator).toHaveBeenCalledWith({ MATCH: `rl:loginacct:e:${digest}|*`, COUNT: 100 });
    for (const key of scanned) expect(del).toHaveBeenCalledWith(key);
    expect(cleared).toBeGreaterThan(0);
  });
});

describe('the routes carry their buckets', () => {
  const read = (file: string) => readFileSync(resolve(__dirname, `../../routes/${file}`), 'utf8');
  const routeLine = (source: string, router: string, method: string, path: string) =>
    source.split(/\r?\n/).find((l) => l.startsWith(`${router}.${method}('${path}'`)) ?? '';

  it('/login: address, network, then the account-and-network bucket keyed on the e-mail', () => {
    const line = routeLine(read('auth.ts'), 'authRouter', 'post', '/login');
    expect(line).toMatch(/rateLimitLogin, rateLimitLoginSubnet, rateLimitLoginAccount,/);
  });

  it('/totp/verify: address, network, then the account bucket keyed on the verified challenge token', () => {
    const line = routeLine(read('auth.ts'), 'authRouter', 'post', '/totp/verify');
    expect(line).toMatch(/rateLimitLogin, rateLimitLoginSubnet, rateLimitTotpAccount,/);
  });

  it('the routes the general budget alone used to bound carry a per-user bucket now', () => {
    expect(routeLine(read('users.ts'), 'userRouter', 'patch', '/me/profile')).toContain('rateLimitProfileUpdate');
    const invites = read('invites.ts');
    expect(routeLine(invites, 'inviteRouter', 'post', '/servers/:serverId')).toContain('rateLimitInviteUse');
    expect(routeLine(invites, 'inviteRouter', 'post', '/:code/join')).toContain('rateLimitInviteUse');
    expect(routeLine(invites, 'inviteRouter', 'get', '/:code')).toContain('rateLimitInviteUse');
    expect(routeLine(read('dm.ts'), 'dmRouter', 'post', '/')).toContain('rateLimitDmOpen');
    const friends = read('friends.ts');
    expect(routeLine(friends, 'friendRouter', 'post', '/:friendshipId/accept')).toContain('rateLimitFriendRequest');
    expect(routeLine(friends, 'friendRouter', 'delete', '/:friendshipId')).toContain('rateLimitFriendRequest');
    const servers = read('servers.ts');
    expect(routeLine(servers, 'serverRouter', 'post', '/')).toContain('rateLimitMemberManage');
    expect(routeLine(servers, 'serverRouter', 'post', '/:serverId/leave')).toContain('rateLimitMemberManage');
    expect(routeLine(servers, 'serverRouter', 'patch', '/:serverId')).toContain('rateLimitMemberManage');
    const channels = read('channels.ts');
    expect(routeLine(channels, 'channelRouter', 'post', '/')).toContain('rateLimitCategoryManage');
    expect(routeLine(channels, 'channelRouter', 'delete', '/:channelId')).toContain('rateLimitCategoryManage');
  });

  it('the public asset proxy has its own per-address bucket and no longer charges the general one twice', () => {
    const uploads = read('uploads.ts');
    expect(uploads).toContain('rateLimitAttachmentRead');
    expect(uploads).not.toMatch(/\brateLimitGeneral\b/);
  });
});

// ─── The general budget is per USER once signed in ──────────────────────────
//
// No per-address budget fits a company of several hundred people behind one
// egress address. A request whose bearer verifies is charged on its user
// (`generalUser`); everything else on its address (`general`).

/** An access token as authService mints one. */
function accessToken(userId: string, extra: Record<string, unknown> = {}, secret = TEST_SECRET): string {
  return jwt.sign({ userId, username: 'u', role: 'user', tokenVersion: 0, ...extra }, secret, { expiresIn: '15m' });
}

function authedReq(ip: string, token: string) {
  return { ...fakeReq(ip), headers: { authorization: `Bearer ${token}` } };
}

describe('verifiedBearerUserId — who a request is from, before authenticate runs', () => {
  const secretBefore = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = TEST_SECRET; });
  afterEach(() => { process.env.JWT_SECRET = secretBefore; });

  it('names the user of a bearer whose signature verifies — an expired one included (the route answers it 401, the budget is still that user\'s)', () => {
    expect(verifiedBearerUserId(authedReq('203.0.113.1', accessToken('clxalice')) as never)).toBe('clxalice');
    const expired = jwt.sign({ userId: 'clxalice', exp: Math.floor(Date.now() / 1000) - 60 }, TEST_SECRET);
    expect(verifiedBearerUserId(authedReq('203.0.113.1', expired) as never)).toBe('clxalice');
  });

  it('names nobody for a forged, malformed or missing bearer, or a token with a purpose (TOTP challenge, trusted device)', () => {
    expect(verifiedBearerUserId(authedReq('203.0.113.1', accessToken('clxalice', {}, 'not-our-secret')) as never)).toBeNull();
    expect(verifiedBearerUserId(authedReq('203.0.113.1', 'garbage') as never)).toBeNull();
    expect(verifiedBearerUserId(authedReq('203.0.113.1', 'x'.repeat(5000)) as never)).toBeNull();
    expect(verifiedBearerUserId({ ...fakeReq('203.0.113.1'), headers: { authorization: 'Basic abc' } } as never)).toBeNull();
    expect(verifiedBearerUserId(fakeReq('203.0.113.1') as never)).toBeNull();
    expect(verifiedBearerUserId(authedReq('203.0.113.1', accessToken('clxalice', { purpose: 'totp-verify' })) as never)).toBeNull();
    expect(verifiedBearerUserId(authedReq('203.0.113.1', jwt.sign({ userId: 'has spaces' }, TEST_SECRET)) as never)).toBeNull();
  });

  it('is memoised per request (the key function and the chooser both ask)', () => {
    const req = authedReq('203.0.113.1', accessToken('clxalice'));
    const verify = vi.spyOn(jwt, 'verify');
    expect(verifiedBearerUserId(req as never)).toBe('clxalice');
    expect(verifiedBearerUserId(req as never)).toBe('clxalice');
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimitGeneral — per user once signed in, per address otherwise', () => {
  let mod: RateLimiterModule;
  const secretBefore = process.env.JWT_SECRET;
  beforeEach(async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    vi.mocked(getRedis).mockReturnValue(brokenRedis as never);
    mod = await freshRateLimiter();
  });
  afterEach(() => { process.env.JWT_SECRET = secretBefore; });

  it('registers the per-user row next to the per-address one', () => {
    const rows = Object.fromEntries(mod.getAllRateLimits().map((l) => [l.name, l]));
    expect(rows.general).toMatchObject({ keyType: 'ip', points: 1000, duration: 60 });
    expect(rows.generalUser).toMatchObject({ keyType: 'userId', points: 600, duration: 60, blockDuration: 0, keyPrefix: 'rl:generaluser' });
  });

  it('a company of 500 behind ONE address, every one of them doing a full measured session within the same minute, is never refused', async () => {
    const egress = '203.0.113.100';
    for (let person = 0; person < 500; person++) {
      const token = accessToken(`clxemployee${person}`);
      for (let r = 0; r < 56; r++) {
        const { passed } = await hit(mod.rateLimitGeneral as Middleware, authedReq(egress, token));
        expect(passed, `employee ${person} request ${r}`).toBe(true);
      }
    }
    // ...and their anonymous requests (one sign-in each) fit the address bucket too
    for (let person = 0; person < 500; person++) {
      expect((await hit(mod.rateLimitGeneral as Middleware, fakeReq(egress))).passed).toBe(true);
    }
  });

  it('one signed-in user spraying is held to the per-user budget; a colleague on the same address is untouched', async () => {
    const egress = '203.0.113.101';
    const spammer = accessToken('clxspammer');
    for (let r = 0; r < 600; r++) {
      expect((await hit(mod.rateLimitGeneral as Middleware, authedReq(egress, spammer))).passed).toBe(true);
    }
    const refused = await hit(mod.rateLimitGeneral as Middleware, authedReq(egress, spammer));
    expect(refused.passed).toBe(false);
    expect(refused.res.statusCode).toBe(429);
    expect(refused.res.body).toEqual({ success: false, error: 'Too many requests. Please try again later.' });

    expect((await hit(mod.rateLimitGeneral as Middleware, authedReq(egress, accessToken('clxcolleague')))).passed).toBe(true);
    expect((await hit(mod.rateLimitGeneral as Middleware, fakeReq(egress))).passed).toBe(true);
  });

  it('a forged bearer buys no budget of its own: it is charged on the address like any anonymous request', async () => {
    const ip = '203.0.113.102';
    const forged = accessToken('clxvictim', {}, 'not-our-secret');
    for (let r = 0; r < 1000; r++) {
      expect((await hit(mod.rateLimitGeneral as Middleware, authedReq(ip, forged))).passed).toBe(true);
    }
    expect((await hit(mod.rateLimitGeneral as Middleware, authedReq(ip, forged))).passed).toBe(false);
    expect((await hit(mod.rateLimitGeneral as Middleware, fakeReq(ip))).passed).toBe(false); // the same address bucket
    // the real user whose id was forged is untouched
    expect((await hit(mod.rateLimitGeneral as Middleware, authedReq(ip, accessToken('clxvictim')))).passed).toBe(true);
  });

  it('the same user from two addresses spends ONE budget (it is the account, not the device, that is bounded)', async () => {
    const token = accessToken('clxroaming');
    for (let r = 0; r < 300; r++) expect((await hit(mod.rateLimitGeneral as Middleware, authedReq('203.0.113.103', token))).passed).toBe(true);
    for (let r = 0; r < 300; r++) expect((await hit(mod.rateLimitGeneral as Middleware, authedReq('198.51.100.7', token))).passed).toBe(true);
    expect((await hit(mod.rateLimitGeneral as Middleware, authedReq('192.0.2.9', token))).passed).toBe(false);
  });

  it('no route mounts rateLimitGeneral a second time (the api level charges it once; support used to charge its users twice)', () => {
    const routesDir = resolve(__dirname, '../../routes');
    // A route file that IMPORTS it mounts it (the webhook routers only mention it in comments)
    const importsGeneral = /import\s*\{[^}]*\brateLimitGeneral\b[^}]*\}\s*from\s*'\.\.\/middleware\/rateLimiter'/;
    const offenders = readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => importsGeneral.test(readFileSync(resolve(routesDir, f), 'utf8')));
    expect(offenders).toEqual([]);
    const support = readFileSync(resolve(routesDir, 'support.ts'), 'utf8');
    expect(support.split(/\r?\n/).find((l) => l.startsWith("supportRouter.post('/open'"))).toContain('rateLimitSupport');
  });
});
