import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { trustsProxy } from '../../utils/trustProxy';

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
    expect(src('app.ts')).toMatch(/if \(trustsProxy\(\)\) \{\s*\n\s*req\.app\.set\('trust proxy', 1\)/);
  });
});
