import { getRedis } from './redis';

// ─── Feature Flag Registry ──────────────────────────────────────────────────

export interface FeatureFlagDef {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
}

const DEFAULTS: Record<string, FeatureFlagDef> = {
  registration:    { name: 'registration',    label: 'User Registration',   description: 'Allow new users to create accounts',              enabled: true },
  invites:         { name: 'invites',         label: 'Server Invites',      description: 'Allow users to create and use server invites',     enabled: true },
  server_creation: { name: 'server_creation', label: 'Server Creation',     description: 'Allow users to create new servers',                enabled: true },
  voice:           { name: 'voice',           label: 'Voice Channels',      description: 'Allow users to join server voice channels',        enabled: true },
  dm_voice:        { name: 'dm_voice',        label: 'DM Voice Calls',      description: 'Allow users to start direct message voice calls',  enabled: true },
  support:         { name: 'support',         label: 'Support Tickets',     description: 'Allow users to open support tickets',              enabled: true },
};

const REDIS_KEY = 'feature:flags';

// In-memory cache
const overrides: Record<string, boolean> = {};

/** Load overrides from Redis on server startup */
export async function loadFeatureFlags(): Promise<void> {
  try {
    const redis = getRedis();
    const data = await redis.hGetAll(REDIS_KEY);
    for (const [name, value] of Object.entries(data)) {
      if (name in DEFAULTS) {
        overrides[name] = value === 'true';
      }
    }
  } catch (err) {
    console.error('[FeatureFlags] Failed to load from Redis, using defaults:', err);
  }
}

/** Check if a feature is enabled */
export function isFeatureEnabled(name: string): boolean {
  const def = DEFAULTS[name];
  if (!def) return true; // Unknown flags default to enabled
  if (name in overrides) return overrides[name];
  return def.enabled;
}

/** Get all feature flags with current state */
export function getAllFeatureFlags(): Array<FeatureFlagDef & { isCustom: boolean }> {
  return Object.values(DEFAULTS).map((def) => ({
    ...def,
    enabled: def.name in overrides ? overrides[def.name] : def.enabled,
    isCustom: def.name in overrides,
  }));
}

/** Update a feature flag */
export async function updateFeatureFlag(name: string, enabled: boolean): Promise<void> {
  if (!(name in DEFAULTS)) throw new Error(`Unknown feature flag: ${name}`);
  const redis = getRedis();
  await redis.hSet(REDIS_KEY, name, String(enabled));
  overrides[name] = enabled;
}

/** Reset a feature flag to default */
export async function resetFeatureFlag(name: string): Promise<void> {
  if (!(name in DEFAULTS)) throw new Error(`Unknown feature flag: ${name}`);
  const redis = getRedis();
  await redis.hDel(REDIS_KEY, name);
  delete overrides[name];
}
