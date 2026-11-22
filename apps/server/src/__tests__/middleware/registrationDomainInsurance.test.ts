import { describe, it, expect, vi, afterEach } from 'vitest';

// The REAL limiter class, built by the production `getLimiter` (a
// RateLimiterRedis with an in-memory insurance limiter), over a fake store
// client that fails like an unreachable Redis. No Redis is touched.
const store = vi.hoisted(() => ({ down: true, evals: 0 }));
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn(() => {
    const counters = new Map<string, { v: number; exp: number }>();
    return {
      multi() {
        const ops: Array<[string, string]> = [];
        const m = {
          get(k: string) { ops.push(['get', k]); return m; },
          pTTL(k: string) { ops.push(['pttl', k]); return m; },
          async exec() {
            if (store.down) throw new Error('ECONNREFUSED');
            return ops.map(([op, k]) => {
              const e = counters.get(k);
              if (op === 'get') return e ? String(e.v) : null;
              return e ? e.exp - Date.now() : -2;
            });
          },
        };
        return m;
      },
      async eval(_script: string, { keys: [k], arguments: [points, seconds] }: { keys: string[]; arguments: string[] }) {
        store.evals++;
        if (store.down) throw new Error('ECONNREFUSED');
        let e = counters.get(k);
        if (!e || e.exp <= Date.now()) {
          e = { v: 0, exp: Date.now() + Number(seconds) * 1000 };
          counters.set(k, e);
        }
        e.v += Number(points);
        return [e.v, e.exp - Date.now()];
      },
    };
  }),
  getRedisPubSub: vi.fn(() => { throw new Error('not needed'); }),
  getRedisConfigSub: vi.fn(() => { throw new Error('not needed'); }),
}));

import { chargeDomainRegistration, domainRegistrationCap } from '../../middleware/rateLimiter';

describe('the domain budget over the production limiter (insurance limiter, store down)', () => {
  afterEach(() => { store.down = true; });

  it('the insurance limiter answers in this process: it charges, and the cap holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.down = true;
    const cap = domainRegistrationCap();
    for (let i = 0; i < cap; i++) {
      expect(await chargeDomainRegistration('insured.example'), `charge ${i + 1}`).toEqual({ allowed: true, charged: true, msBeforeNext: 0 });
    }
    const refused = await chargeDomainRegistration('insured.example');
    expect(refused.allowed).toBe(false);
    expect(refused.charged).toBe(false);
    expect(refused.msBeforeNext).toBeGreaterThan(0);
    // the error never reached the helper's own catch
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Domain budget charge failed'), expect.anything());
    warn.mockRestore();
  });

  it('a reachable store decides, and the insurance limiter holds nothing for that domain', async () => {
    store.down = false;
    const cap = domainRegistrationCap();
    for (let i = 0; i < cap; i++) expect((await chargeDomainRegistration('healthy.example')).allowed).toBe(true);
    expect((await chargeDomainRegistration('healthy.example')).allowed).toBe(false);
    expect(store.evals).toBeGreaterThan(0);
  });
});
