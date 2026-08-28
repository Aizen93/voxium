import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { trustsProxy, trustedProxyHops, forwardedClientAddress, DEFAULT_TRUSTED_PROXY_HOPS, MAX_TRUSTED_PROXY_HOPS } from '../../utils/trustProxy';

describe('trustsProxy — one answer for Express and the socket handshake', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.NODE_ENV = process.env.NODE_ENV;
    saved.TRUST_PROXY = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
  });
  afterEach(() => {
    for (const k of ['NODE_ENV', 'TRUST_PROXY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it.each([
    ['production', undefined, true],
    ['production', 'false', true],
    ['development', 'true', true],
    ['staging', 'true', true],
    ['development', undefined, false],
    ['development', '1', false],
    ['test', 'TRUE', false],
  ])('NODE_ENV=%s TRUST_PROXY=%s → %s', (env, trust, expected) => {
    process.env.NODE_ENV = env;
    if (trust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = trust;
    expect(trustsProxy()).toBe(expected);
  });

  // The two surfaces that key IpBan lookups on "the caller's address" must
  // consult the SAME predicate; a private copy in either is how they drifted
  // apart (socket side on NODE_ENV only) and failed open on TRUST_PROXY=true.
  it('is the predicate both app.ts and socketServer.ts use', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../../', rel), 'utf8');
    for (const file of ['app.ts', 'websocket/socketServer.ts']) {
      const text = src(file);
      expect(text, file).toMatch(/trustsProxy\(\)/);
      expect(text, file).not.toMatch(/process\.env\.TRUST_PROXY/);
    }
    // The socket-side parse is the one that drifted; it must not gate the
    // header on NODE_ENV on its own again (app.ts keeps NODE_ENV for HSTS and
    // log format, which are not address decisions).
    expect(src('websocket/socketServer.ts')).not.toMatch(/NODE_ENV/);
    expect(src('app.ts')).toMatch(/if \(trustsProxy\(\)\) \{\s*\n\s*req\.app\.set\('trust proxy', trustedProxyHops\(\)\)/);
    // The socket side must take its hop count from the same helper, never
    // re-derive "the last entry" on its own.
    expect(src('websocket/socketServer.ts')).toMatch(/forwardedClientAddress\(/);
    expect(src('websocket/socketServer.ts')).not.toMatch(/hops\[hops\.length - 1\]/);
  });
});

// ─── TRUST_PROXY_HOPS ───────────────────────────────────────────────────────
//
// One nginx is one hop. An OVH Load Balancer in front of it is two — and at
// `trust proxy: 1` every user on the internet then collapses into ONE
// rate-limit bucket keyed on nginx's address. The count has to move with the
// topology, on BOTH surfaces at once.

describe('trustedProxyHops', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TRUST_PROXY_HOPS; delete process.env.TRUST_PROXY_HOPS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = saved;
    vi.restoreAllMocks();
  });

  it('defaults to 1 — one nginx', () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
    expect(trustedProxyHops()).toBe(1);
    process.env.TRUST_PROXY_HOPS = '';
    expect(trustedProxyHops()).toBe(1);
    process.env.TRUST_PROXY_HOPS = '   ';
    expect(trustedProxyHops()).toBe(1);
  });

  it('reads a valid integer, re-reading when the value changes', () => {
    process.env.TRUST_PROXY_HOPS = '2';
    expect(trustedProxyHops()).toBe(2);
    process.env.TRUST_PROXY_HOPS = ' 3 ';
    expect(trustedProxyHops()).toBe(3);
    process.env.TRUST_PROXY_HOPS = String(MAX_TRUSTED_PROXY_HOPS);
    expect(trustedProxyHops()).toBe(MAX_TRUSTED_PROXY_HOPS);
  });

  it.each(['0', '-1', '1.5', 'two', 'true', String(MAX_TRUSTED_PROXY_HOPS + 1)])('falls back to 1 on %s, warning once per distinct value', (v) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TRUST_PROXY_HOPS = v;
    expect(trustedProxyHops()).toBe(1);
    expect(trustedProxyHops()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('forwardedClientAddress — the Express rule, shared with the socket handshake', () => {
  it('N=1 takes the last entry, the one the single trusted proxy appended', () => {
    expect(forwardedClientAddress('1.1.1.1, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(forwardedClientAddress('203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('N=2 skips the last entry (nginx, written by the load balancer) and takes the one before it', () => {
    expect(forwardedClientAddress('spoofed, 203.0.113.7, 10.0.1.10', 2)).toBe('203.0.113.7');
  });

  it('a chain shorter than N yields its leftmost entry, exactly like proxy-addr', () => {
    expect(forwardedClientAddress('203.0.113.7', 2)).toBe('203.0.113.7');
    expect(forwardedClientAddress('203.0.113.7, 10.0.1.10', 5)).toBe('203.0.113.7');
  });

  it('trims entries, ignores empties, and is undefined for an empty chain', () => {
    expect(forwardedClientAddress(' 1.1.1.1 ,, 203.0.113.7 ', 1)).toBe('203.0.113.7');
    expect(forwardedClientAddress('', 1)).toBeUndefined();
    expect(forwardedClientAddress(' , ', 1)).toBeUndefined();
  });

  // The property that matters: for every chain and hop count, the socket
  // surface names the SAME caller Express does. Two keyed controls that
  // disagree about an address fail open.
  it.each([1, 2, 3])('agrees with Express req.ip at trust proxy = %i', async (hops) => {
    const app = express();
    app.set('trust proxy', hops);
    app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });

    const chains = ['203.0.113.7', '198.51.100.99, 203.0.113.7', '192.0.2.1, 198.51.100.99, 203.0.113.7, 10.0.1.10', '203.0.113.7, 10.0.1.10, 10.0.1.9, 10.0.1.8'];
    for (const chain of chains) {
      const res = await request(app).get('/ip').set('X-Forwarded-For', chain);
      // supertest connects over loopback, so Express's chain is [127.0.0.1, ...XFF] —
      // the loopback peer is the first trusted hop, as nginx would be in production.
      expect(forwardedClientAddress(chain, hops), `${chain} @ ${hops}`).toBe(res.body.ip);
    }
  });
});
