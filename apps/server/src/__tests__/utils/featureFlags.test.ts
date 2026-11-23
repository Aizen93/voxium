import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

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

import { isFeatureEnabled, getAllFeatureFlags, type FeatureFlagName } from '../../utils/featureFlags';

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

  it('reads an unknown name as DISABLED, with one warning per name (#72)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Cast: an unregistered name is a type error, this is the runtime net under it
      const read = isFeatureEnabled as (name: string) => boolean;
      expect(read('nonexistent_feature')).toBe(false);
      expect(read('nonexistent_feature')).toBe(false);
      expect(read('webhook')).toBe(false);
      const said = warn.mock.calls.filter((c) => String(c[0]).startsWith('[FeatureFlags]'));
      expect(said).toHaveLength(2);
      expect(said.map((c) => String(c[0]))).toEqual([
        expect.stringContaining('"nonexistent_feature"'),
        expect.stringContaining('"webhook"'),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a name that is an Object.prototype member is unknown, not enabled (#72)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = isFeatureEnabled as (name: string) => boolean;
      for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
        expect(read(name)).toBe(false);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// The answer for every name with NO override stored, which is what a fresh
// self-hosted install has (nothing seeds feature:flags; no migration holds
// flags). Changing one of these switches the feature for every such install:
// it must be a deliberate edit of this table.
const DEFAULT_ANSWERS: Record<FeatureFlagName, boolean> = {
  registration: true,
  invites: true,
  server_creation: true,
  voice: true,
  dm_voice: true,
  support: true,
  community_funding: false,
  annotations_v2: true,
  server_discovery: true,
  webhooks: true,
  // OFF until the Privacy Policy has given its notice: an account deletion
  // deletes its conversations for both people, as before
  account_deletion_keeps_conversations: false,
  // OFF until the Privacy Policy has given its notice: an account deletion
  // deletes the reports filed by or about it, as before
  account_deletion_keeps_reports: false,
  // OFF (observe) until the reuse logs say enforcing would sign out almost
  // nobody: a reused refresh token is logged and the session kept
  refresh_reuse_revocation: false,
};

describe('featureFlags — the registered names and their defaults (#72)', () => {
  it('every registered name answers its default with no override loaded', () => {
    for (const [name, enabled] of Object.entries(DEFAULT_ANSWERS)) {
      expect(isFeatureEnabled(name as FeatureFlagName), name).toBe(enabled);
    }
  });

  it('the registry holds exactly these names, each entry named after its key', () => {
    const flags = getAllFeatureFlags();
    expect(flags.map((f) => f.name).sort()).toEqual(Object.keys(DEFAULT_ANSWERS).sort());
    for (const flag of flags) expect(flag.enabled).toBe(DEFAULT_ANSWERS[flag.name as FeatureFlagName]);
  });

  it('every name the server code asks for is registered (a source scan of isFeatureEnabled, requireFeature and the public list)', () => {
    const SRC = path.resolve(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'generated') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          files.push(full);
        }
      }
    };
    walk(SRC);

    const asked = new Set<string>();
    const nonLiteral: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(/\b(?:isFeatureEnabled|requireFeature)\(\s*'([^']+)'/g)) asked.add(m[1]);
      const publicList = /PUBLIC_FLAGS\s*=\s*\[([^\]]*)\]/.exec(source);
      if (publicList) for (const m of publicList[1].matchAll(/'([^']+)'/g)) asked.add(m[1]);
      // A call whose argument is not a literal escapes the scan above: only the
      // two definitions and the public-list loop may make one
      for (const m of source.matchAll(/\b(?:isFeatureEnabled|requireFeature)\(\s*([A-Za-z_][\w.]*)/g)) {
        nonLiteral.push(`${path.relative(SRC, file).replace(/\\/g, '/')}: ${m[1]}`);
      }
    }
    expect(nonLiteral.sort()).toEqual([
      'app.ts: name',
      'middleware/requireFeature.ts: name',
      'middleware/requireFeature.ts: name',
      'utils/featureFlags.ts: name',
    ]);
    expect(asked.size).toBeGreaterThanOrEqual(9);
    for (const name of asked) expect(Object.keys(DEFAULT_ANSWERS), `asked for "${name}"`).toContain(name);
  });
});

describe('featureFlags — overrides from Redis and other nodes use registered names only (#72)', () => {
  beforeEach(() => { vi.resetModules(); });

  async function freshFlags(stored: Record<string, string>) {
    const redis = await import('../../utils/redis');
    let onMessage: ((message: string) => void) | undefined;
    const client = {
      hGetAll: vi.fn().mockResolvedValue(stored),
      hSet: vi.fn().mockResolvedValue(1),
      hDel: vi.fn().mockResolvedValue(1),
    };
    vi.mocked(redis.getRedis).mockReturnValue(client as never);
    vi.mocked(redis.getRedisConfigSub).mockReturnValue({
      subscribe: vi.fn().mockImplementation(async (_channel: string, cb: (message: string) => void) => { onMessage = cb; }),
    } as never);
    const flags = await import('../../utils/featureFlags');
    await flags.loadFeatureFlags();
    return { flags, client, publish: (message: object) => onMessage!(JSON.stringify(message)), publishRaw: (message: string) => onMessage!(message) };
  }

  it('applies a stored override of a registered name, ignores stored entries under any other name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { flags } = await freshFlags({ voice: 'false', constructor: 'true', toString: 'false', unknown_flag: 'true' });
      expect(flags.isFeatureEnabled('voice')).toBe(false);
      const read = flags.isFeatureEnabled as (name: string) => boolean;
      expect(read('constructor')).toBe(false);
      expect(read('unknown_flag')).toBe(false);
      expect(flags.getAllFeatureFlags().map((f) => f.name)).not.toContain('constructor');
      expect(flags.getAllFeatureFlags().find((f) => f.name === 'voice')).toMatchObject({ enabled: false, isCustom: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('a message from another node changes a registered name only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { flags, publish } = await freshFlags({});
      publish({ name: 'webhooks', enabled: false, action: 'set' });
      expect(flags.isFeatureEnabled('webhooks')).toBe(false);
      publish({ name: 'webhooks', action: 'reset' });
      expect(flags.isFeatureEnabled('webhooks')).toBe(true);
      publish({ name: 'constructor', enabled: true, action: 'set' });
      expect((flags.isFeatureEnabled as (name: string) => boolean)('constructor')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a malformed message changes nothing and is logged once per message, without its payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { flags, publishRaw } = await freshFlags({});
      publishRaw('{not json SECRETPAYLOAD');
      publishRaw('null');
      expect(flags.isFeatureEnabled('voice')).toBe(true);
      const said = warn.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith('[FeatureFlags]'));
      expect(said).toEqual([
        '[FeatureFlags] Ignored a malformed message on config:feature_flags (SyntaxError)',
        '[FeatureFlags] Ignored a malformed message on config:feature_flags (TypeError)',
      ]);
      expect(said.join(' ')).not.toContain('SECRETPAYLOAD');
    } finally {
      warn.mockRestore();
    }
  });

  it('update and reset refuse a name that is not registered, an Object.prototype member included, writing nothing', async () => {
    const { flags, client } = await freshFlags({});
    for (const name of ['constructor', '__proto__', 'nope']) {
      await expect(flags.updateFeatureFlag(name, true)).rejects.toMatchObject({ statusCode: 404, message: 'Feature flag not found' });
      await expect(flags.resetFeatureFlag(name)).rejects.toMatchObject({ statusCode: 404, message: 'Feature flag not found' });
    }
    expect(client.hSet).not.toHaveBeenCalled();
    expect(client.hDel).not.toHaveBeenCalled();
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

  it('registers the webhooks kill switch, enabled by default', () => {
    const flag = getAllFeatureFlags().find((f) => f.name === 'webhooks');
    expect(flag).toMatchObject({ name: 'webhooks', label: 'Incoming Webhooks', enabled: true, isCustom: false });
    expect(flag!.description).toMatch(/incoming webhooks/i);
    expect(isFeatureEnabled('webhooks')).toBe(true);
  });

  it('community_funding is disabled by default', () => {
    const flags = getAllFeatureFlags();
    const cf = flags.find((f) => f.name === 'community_funding');
    expect(cf).toBeDefined();
    expect(cf!.enabled).toBe(false);
  });
});
