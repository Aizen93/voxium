import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';

// Drive the real limiter logic against an in-memory store: RateLimiterMemory
// implements the same consume/reward/get contract, so the charge-then-refund
// handshake is exercised end to end without Redis.
vi.mock('rate-limiter-flexible', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rate-limiter-flexible')>();
  return { ...actual, RateLimiterRedis: actual.RateLimiterMemory };
});
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn(() => ({})),
  getRedisPubSub: vi.fn(() => { throw new Error('not needed'); }),
  getRedisConfigSub: vi.fn(() => { throw new Error('not needed'); }),
}));

import {
  chargeRegistrationBudgets,
  rateLimitRegisterAttempt,
  rateLimitRegisterAttemptSubnet,
  getSubnetRegistrationPressure,
  consumeMailCap,
  getAllRateLimits,
} from '../../middleware/rateLimiter';

const DAILY_CAP = getAllRateLimits().find((l) => l.name === 'registerDaily')!.points;
const SUBNET_CAP = getAllRateLimits().find((l) => l.name === 'registerSubnet')!.points;
const ATTEMPT_CAP = getAllRateLimits().find((l) => l.name === 'registerAttempt')!.points;
const ATTEMPT_SUBNET_CAP = getAllRateLimits().find((l) => l.name === 'registerAttemptSubnet')!.points;

function reqFor(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

/** Response double that can replay its 'finish' listeners with a status code. */
function resSpy() {
  const listeners: Array<() => void> = [];
  const json = vi.fn();
  const res = {
    statusCode: 200,
    set: vi.fn(),
    status: vi.fn((code: number) => { res.statusCode = code; return { json }; }),
    on: vi.fn((event: string, cb: () => void) => { if (event === 'finish') listeners.push(cb); }),
  } as unknown as Response & { statusCode: number };
  return {
    res,
    json,
    /** Replay Express's 'finish' with the outcome the handler produced. */
    async finish(statusCode: number) {
      res.statusCode = statusCode;
      for (const cb of listeners) cb();
      await Promise.resolve(); // the refunds are fire-and-forget
      await Promise.resolve();
    },
  };
}

/** Run the middleware; returns whether it passed the request through. */
async function charge(ip: string) {
  const spy = resSpy();
  const next = vi.fn();
  await chargeRegistrationBudgets(reqFor(ip), spy.res, next);
  return { ...spy, allowed: next.mock.calls.length === 1 };
}

/** A full request that ends in `status`. */
async function attempt(ip: string, status: number) {
  const r = await charge(ip);
  if (r.allowed) await r.finish(status);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registration daily/subnet budgets', () => {
  it('charges a successful registration and refuses once the cap is spent', async () => {
    const ip = '198.51.100.20';
    for (let i = 0; i < DAILY_CAP; i++) {
      expect((await attempt(ip, 201)).allowed).toBe(true);
    }

    const blocked = await charge(ip);
    expect(blocked.allowed).toBe(false);
    // Byte-identical to the ordinary limiter's rejection so a client cannot
    // tell the two apart
    expect(blocked.json).toHaveBeenCalledWith({
      success: false,
      error: 'Too many requests. Please try again later.',
    });
    expect(blocked.res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  // F2: as plain consuming middleware every 400 charged the bucket — a user who
  // hit taken-username → taken-email → expired challenge burned 3 of 5 daily
  // points, and 20 throwaway POSTs from any address in a target org's /24
  // locked that whole range out of signup for a day.
  it('REFUNDS a failed attempt, so fumbling costs nothing', async () => {
    const ip = '198.51.100.21';
    for (let i = 0; i < DAILY_CAP * 3; i++) {
      expect((await attempt(ip, 409)).allowed).toBe(true);
    }
    // Budget untouched: a full run of successes still fits afterwards
    for (let i = 0; i < DAILY_CAP; i++) {
      expect((await attempt(ip, 201)).allowed).toBe(true);
    }
    expect((await charge(ip)).allowed).toBe(false);
  });

  it('refunds the OTHER bucket when one of the two rejects', async () => {
    // Subnet exhausted by NEIGHBOURS (the per-IP cap is smaller, so it has to
    // be several addresses); this one has spent nothing of its own
    for (let i = 0; i < SUBNET_CAP; i++) {
      await attempt(`203.0.50.${1 + Math.floor(i / DAILY_CAP)}`, 201);
    }

    const victim = '203.0.50.99';
    expect((await charge(victim)).allowed).toBe(false);
    // registerDaily was charged before registerSubnet rejected — if it stayed
    // charged, being caught behind a noisy neighbour would silently cost the
    // victim their own per-IP points too
    expect(await getSubnetRegistrationPressure(reqFor(victim))).toBe(SUBNET_CAP);
  });

  // The reason this is middleware and not a read-then-charge-later split: a
  // read is not a reservation. With the charge deferred to after the create,
  // a concurrent burst all reads the same pre-burst count and all passes.
  it('holds the cap under a CONCURRENT burst, not just a serial one', async () => {
    const ip = '2001:db8:beef::1';
    const results = await Promise.all(
      Array.from({ length: DAILY_CAP * 10 }, () => charge(ip)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(DAILY_CAP);
  });

  it('keys IPv4-mapped and dotted forms identically', async () => {
    // The two halves used to disagree about '::ffff:' — and it failed OPEN, so
    // no happy-path test would have caught it
    const dotted = '198.51.100.30';
    for (let i = 0; i < DAILY_CAP; i++) await attempt(dotted, 201);

    expect((await charge('::ffff:198.51.100.30')).allowed).toBe(false);
    expect((await charge('::FFFF:198.51.100.30')).allowed).toBe(false);
  });

  it('charges the /48 bucket, so every address inside it shares one budget', async () => {
    for (let i = 0; i < SUBNET_CAP; i++) {
      await attempt(`2001:db8:77::${1 + Math.floor(i / DAILY_CAP)}`, 201);
    }

    expect((await charge('2001:db8:77:beef::9')).allowed).toBe(false); // same /48
    expect((await charge('2001:db8:78::1')).allowed).toBe(true);       // a different one
  });

  it('feeds PoW difficulty from SUCCESSFUL registrations, so a fumbling neighbour costs nobody CPU', async () => {
    const ip = '2001:db8:99::5';
    expect(await getSubnetRegistrationPressure(reqFor(ip))).toBe(0);

    await attempt(ip, 400); // refunded
    await attempt(ip, 201);
    await attempt(ip, 201);

    expect(await getSubnetRegistrationPressure(reqFor(ip))).toBe(2);
  });
});

// Since the daily budgets refund every failure, they no longer bound a prober:
// a 409 on a random username means the EMAIL exists, so registration is an
// account-existence oracle and something has to charge failed attempts. These
// two buckets are that something, and neither is ever refunded.
describe('never-refunded registration attempt buckets', () => {
  /** The attempt chain as mounted on POST /register: per address, then per range. */
  async function attemptChain(ip: string) {
    const spy = resSpy();
    let passed = 0;
    const next = () => { passed++; };
    await rateLimitRegisterAttempt(reqFor(ip), spy.res, next as never);
    if (passed === 1) await rateLimitRegisterAttemptSubnet(reqFor(ip), spy.res, next as never);
    return { ...spy, allowed: passed === 2 };
  }

  it('charges a FAILED attempt and never gives it back', async () => {
    const ip = '198.51.100.40';
    // Every one of these ends 409 — the daily budgets refund them, these do not
    for (let i = 0; i < ATTEMPT_CAP; i++) {
      expect((await attemptChain(ip)).allowed).toBe(true);
    }

    const blocked = await attemptChain(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.json).toHaveBeenCalledWith({
      success: false,
      error: 'Too many requests. Please try again later.',
    });
    expect(blocked.res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('bounds probing per RANGE, so rotating addresses inside a /24 buys nothing', async () => {
    // The whole point: per-address alone is not a bound. 254 addresses x the
    // per-address cap is thousands of confirmed probes a day out of one /24,
    // and a routed IPv6 /64 makes rotation free.
    const addressesNeeded = Math.ceil(ATTEMPT_SUBNET_CAP / ATTEMPT_CAP);
    let spent = 0;
    for (let host = 1; host <= addressesNeeded && spent < ATTEMPT_SUBNET_CAP; host++) {
      for (let i = 0; i < ATTEMPT_CAP && spent < ATTEMPT_SUBNET_CAP; i++, spent++) {
        expect((await attemptChain(`203.0.60.${host}`)).allowed).toBe(true);
      }
    }

    // A previously untouched address in the same /24 is refused on the range
    expect((await attemptChain('203.0.60.200')).allowed).toBe(false);
    // ...while a different /24 is unaffected
    expect((await attemptChain('203.0.61.1')).allowed).toBe(true);
  });

  it('groups IPv6 by /48, the allocation an attacker actually rotates inside', async () => {
    const addressesNeeded = Math.ceil(ATTEMPT_SUBNET_CAP / ATTEMPT_CAP);
    let spent = 0;
    for (let host = 1; host <= addressesNeeded && spent < ATTEMPT_SUBNET_CAP; host++) {
      for (let i = 0; i < ATTEMPT_CAP && spent < ATTEMPT_SUBNET_CAP; i++, spent++) {
        await attemptChain(`2001:db8:41:${host}::1`);
      }
    }

    expect((await attemptChain('2001:db8:41:ffff::9')).allowed).toBe(false); // same /48
    expect((await attemptChain('2001:db8:42::1')).allowed).toBe(true);       // a different one
  });

  it('is actually MOUNTED on POST /register', () => {
    // auth.test.ts stubs every limiter to a passthrough, so nothing in the
    // route suite would notice either of these being dropped from the chain —
    // and they are the only thing charging a failed attempt now.
    const source = readFileSync(resolve(__dirname, '../../routes/auth.ts'), 'utf8');
    const chain = /authRouter\.post\(\s*'\/register',([^)]*?)async/s.exec(source)?.[1] ?? '';
    expect(chain).toContain('rateLimitRegisterAttempt,');
    expect(chain).toContain('rateLimitRegisterAttemptSubnet,');
  });

  it('lives under rl:, so the e2e fixture, clearUserRateLimits and the admin API all reach it', async () => {
    // A bare counter here would survive the per-test sweep and kill CI on the
    // sixth spec that registers, and no operator could raise it in an incident.
    for (const name of ['registerAttempt', 'registerAttemptSubnet']) {
      const def = getAllRateLimits().find((l) => l.name === name);
      expect(def, `${name} must be registered in DEFAULTS`).toBeDefined();
      expect(def!.keyPrefix).toMatch(/^rl:/);
    }
  });
});

describe('per-inbox mail caps', () => {
  it('allows exactly the configured number of sends per canonical inbox, then refuses', async () => {
    const cap = getAllRateLimits().find((l) => l.name === 'verifyMail')!.points;
    const inbox = 'jdoe@gmail.com';

    for (let i = 0; i < cap; i++) {
      expect(await consumeMailCap('verifyMail', inbox)).toBe(true);
    }
    expect(await consumeMailCap('verifyMail', inbox)).toBe(false);
  });

  it('isolates inboxes, and the verification and reset caps from each other', async () => {
    const cap = getAllRateLimits().find((l) => l.name === 'resetMail')!.points;
    for (let i = 0; i < cap + 1; i++) await consumeMailCap('resetMail', 'victim@example.com');

    expect(await consumeMailCap('resetMail', 'someone-else@example.com')).toBe(true);
    // Exhausting reset mail must not stop a legitimate verification resend
    expect(await consumeMailCap('verifyMail', 'victim@example.com')).toBe(true);
  });
});
