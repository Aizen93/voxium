import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue({
    hGetAll: vi.fn().mockResolvedValue({}),
    hSet: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
  }),
  getRedisPubSub: vi.fn().mockReturnValue({
    pub: { publish: vi.fn().mockResolvedValue(1) },
  }),
  getRedisConfigSub: vi.fn().mockReturnValue({
    subscribe: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { isFeatureEnabled, getAllFeatureFlags } from '../../utils/featureFlags';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('featureFlags — isFeatureEnabled', () => {
  it('returns true by default for known flags', () => {
    // Default enabled flags
    expect(isFeatureEnabled('voice')).toBe(true);
    expect(isFeatureEnabled('registration')).toBe(true);
    expect(isFeatureEnabled('invites')).toBe(true);
    expect(isFeatureEnabled('server_creation')).toBe(true);
    expect(isFeatureEnabled('dm_voice')).toBe(true);
    expect(isFeatureEnabled('support')).toBe(true);
  });

  it('returns false for community_funding (disabled by default)', () => {
    expect(isFeatureEnabled('community_funding')).toBe(false);
  });

  it('returns true for unknown flags (defensive default)', () => {
    expect(isFeatureEnabled('nonexistent_feature')).toBe(true);
    expect(isFeatureEnabled('random_flag_xyz')).toBe(true);
  });
});

describe('featureFlags — getAllFeatureFlags', () => {
  it('returns all defined flags with current state', () => {
    const flags = getAllFeatureFlags();

    expect(flags.length).toBeGreaterThan(0);

    // All entries should have expected shape
    for (const flag of flags) {
      expect(flag).toHaveProperty('name');
      expect(flag).toHaveProperty('label');
      expect(flag).toHaveProperty('description');
      expect(flag).toHaveProperty('enabled');
      expect(flag).toHaveProperty('isCustom');
      expect(typeof flag.name).toBe('string');
      expect(typeof flag.enabled).toBe('boolean');
      expect(typeof flag.isCustom).toBe('boolean');
    }
  });

  it('includes known flags', () => {
    const flags = getAllFeatureFlags();
    const names = flags.map((f) => f.name);

    expect(names).toContain('voice');
    expect(names).toContain('registration');
    expect(names).toContain('invites');
    expect(names).toContain('server_creation');
    expect(names).toContain('dm_voice');
    expect(names).toContain('support');
    expect(names).toContain('community_funding');
  });

  it('flags without overrides have isCustom: false', () => {
    const flags = getAllFeatureFlags();
    // Since no overrides are loaded (mock returns empty), all should be default
    for (const flag of flags) {
      expect(flag.isCustom).toBe(false);
    }
  });

  it('community_funding is disabled by default', () => {
    const flags = getAllFeatureFlags();
    const cf = flags.find((f) => f.name === 'community_funding');
    expect(cf).toBeDefined();
    expect(cf!.enabled).toBe(false);
  });
});
