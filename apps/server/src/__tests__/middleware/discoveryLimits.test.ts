import { describe, it, expect, vi } from 'vitest';

// The two directory limiter rows live in the shared table so the admin Rate
// Limits panel can tune them and the e2e fixture clears them (rl:* prefix).

vi.mock('../../utils/redis', () => ({
  getRedis: () => ({}),
  getRedisPubSub: () => ({ pub: {}, sub: {} }),
  getRedisConfigSub: () => ({}),
}));

import { getAllRateLimits, rateLimitDiscoveryBrowse, rateLimitDiscoveryJoin } from '../../middleware/rateLimiter';
import { getAllFeatureFlags, isFeatureEnabled } from '../../utils/featureFlags';

describe('server discovery limiter rows', () => {
  it('discoveryBrowse: 60 per minute per user; discoveryJoin: 10 per hour per user; both under rl:', () => {
    const rows = getAllRateLimits();
    const browse = rows.find((r) => r.name === 'discoveryBrowse')!;
    const join = rows.find((r) => r.name === 'discoveryJoin')!;
    expect(browse).toMatchObject({ points: 60, duration: 60, blockDuration: 0, keyType: 'userId' });
    expect(join).toMatchObject({ points: 10, duration: 3600, blockDuration: 0, keyType: 'userId' });
    expect(browse.keyPrefix).toMatch(/^rl:/);
    expect(join.keyPrefix).toMatch(/^rl:/);
    expect(new Set(rows.map((r) => r.keyPrefix)).size).toBe(rows.length);
    expect(typeof rateLimitDiscoveryBrowse).toBe('function');
    expect(typeof rateLimitDiscoveryJoin).toBe('function');
  });
});

describe('server_discovery feature flag', () => {
  it('is registered and ON by default', () => {
    const flag = getAllFeatureFlags().find((f) => f.name === 'server_discovery')!;
    expect(flag).toMatchObject({ enabled: true, isCustom: false });
    expect(isFeatureEnabled('server_discovery')).toBe(true);
  });
});
