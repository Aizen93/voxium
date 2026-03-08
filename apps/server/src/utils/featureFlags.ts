import { getRedis, getRedisPubSub, getRedisConfigSub } from './redis';

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

const CONFIG_CHANNEL = 'config:feature_flags';

/** Load overrides from Redis on server startup and subscribe to cross-node updates. */
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

  // Subscribe to config changes from other nodes
  try {
    const configSub = getRedisConfigSub();
    await configSub.subscribe(CONFIG_CHANNEL, (message) => {
      try {
        const { name, enabled, action } = JSON.parse(message);
        if (action === 'reset') {
          delete overrides[name];
        } else if (name in DEFAULTS) {
          overrides[name] = enabled;
        }
      } catch { /* ignore malformed messages */ }
    });
  } catch (err) {
    console.error('[FeatureFlags] Failed to subscribe to config channel:', err);
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

/** Update a feature flag and notify all nodes. */
export async function updateFeatureFlag(name: string, enabled: boolean): Promise<void> {
  if (!(name in DEFAULTS)) throw new Error(`Unknown feature flag: ${name}`);
  const redis = getRedis();
  await redis.hSet(REDIS_KEY, name, String(enabled));
  overrides[name] = enabled;
  // Notify other nodes
  const { pub } = getRedisPubSub();
  await pub.publish(CONFIG_CHANNEL, JSON.stringify({ name, enabled, action: 'set' }));
}

/** Reset a feature flag to default and notify all nodes. */
export async function resetFeatureFlag(name: string): Promise<void> {
  if (!(name in DEFAULTS)) throw new Error(`Unknown feature flag: ${name}`);
  const redis = getRedis();
  await redis.hDel(REDIS_KEY, name);
  delete overrides[name];
  // Notify other nodes
  const { pub } = getRedisPubSub();
  await pub.publish(CONFIG_CHANNEL, JSON.stringify({ name, action: 'reset' }));
}
