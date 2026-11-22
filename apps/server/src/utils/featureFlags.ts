import { getRedis, getRedisPubSub, getRedisConfigSub } from './redis';
import { NotFoundError } from './errors';
import { describeCaughtErrorWithStack } from './loggableError';

// ─── Feature Flag Registry ──────────────────────────────────────────────────

export interface FeatureFlagDef {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
}

// THE list of flags and what each answers while no override is stored, which
// is every flag on a fresh install: nothing seeds the feature:flags hash and
// no migration holds a flag. A name not in it reads as disabled.
const DEFAULTS = {
  registration:    { name: 'registration',    label: 'User Registration',   description: 'Allow new users to create accounts',              enabled: true },
  invites:         { name: 'invites',         label: 'Server Invites',      description: 'Allow users to create and use server invites',     enabled: true },
  server_creation: { name: 'server_creation', label: 'Server Creation',     description: 'Allow users to create new servers',                enabled: true },
  voice:           { name: 'voice',           label: 'Voice Channels',      description: 'Allow users to join server voice channels',        enabled: true },
  dm_voice:        { name: 'dm_voice',        label: 'DM Voice Calls',      description: 'Allow users to start direct message voice calls',  enabled: true },
  support:         { name: 'support',         label: 'Support Tickets',     description: 'Allow users to open support tickets',              enabled: true },
  community_funding: { name: 'community_funding', label: 'Community Funding', description: 'Show the community funding section on the landing page', enabled: false },
  // Wire v2 of screen-share annotations (arrows, callouts, spotlight, vanishing
  // ink, moving strokes). OFF makes this node reject v2 ops AND stop
  // advertising annotationsVersion 2 on the share claim, so new clients hide
  // the tools instead of drawing things the server will refuse.
  annotations_v2:  { name: 'annotations_v2',  label: 'Annotations v2',      description: 'Arrows, callouts, spotlight, vanishing ink and stroke editing on screen shares', enabled: true },
  // The directory's kill switch. OFF: every /discovery route answers 403 and
  // the client shows its "turned off" state. Invites, bans and existing
  // memberships are unaffected; profiles and pending requests are kept.
  server_discovery: { name: 'server_discovery', label: 'Server Discovery',  description: 'Let users browse the public server directory and join or request to join from it', enabled: true },
  // The kill switch of a PUBLIC, UNAUTHENTICATED endpoint: OFF makes the
  // webhook execute route answer 403 for every webhook at once (and hides the
  // Integrations tab). Webhook rows and their posted messages are kept.
  webhooks:        { name: 'webhooks',        label: 'Incoming Webhooks',   description: 'Let servers receive messages from incoming webhooks (the public execute endpoint and the Integrations tab)', enabled: true },
  // What an account deletion does with the account's direct conversations
  // (utils/accountDeletion.ts, read once per deletion before its
  // transaction). OFF: each is deleted for both people, every message and
  // file in it, as before. ON: one the other person can still reach outlives
  // the account for them, read-only, with the deleted account's messages
  // reduced to placeholders. OFF until the Privacy Policy has given its
  // notice of the change.
  account_deletion_keeps_conversations: { name: 'account_deletion_keeps_conversations', label: 'Conversations Outlive Deleted Accounts', description: 'When an account is deleted, the other person keeps each direct conversation read-only, with the deleted account\'s messages reduced to placeholders (off: the conversation is deleted for both)', enabled: false },
  // What a renewal does with a refresh token that a renewal already replaced,
  // presented after the grace window, or an older one (services/
  // sessionService.ts, read at each such presentation). OFF (observe): the
  // reuse is logged and the session renewed as usual. ON (enforce): the
  // session is ended, its sockets with it, and the refresh refused. Sign-out,
  // expiry, the cap and token versions work the same either way. OFF until the
  // reuse logs show it would sign out almost no one.
  refresh_reuse_revocation: { name: 'refresh_reuse_revocation', label: 'Refresh Token Reuse Revocation', description: 'End a sign-in session when a refresh token it already replaced is presented again after the grace window (off: log the reuse and keep the session)', enabled: false },
} satisfies Record<string, FeatureFlagDef>;

/** A registered flag name: a misspelled one in isFeatureEnabled or requireFeature is a type error. */
export type FeatureFlagName = keyof typeof DEFAULTS;

/** An OWN key of the registry: `'constructor' in DEFAULTS` is true, and must not make a flag. */
function isKnownFlag(name: string): name is FeatureFlagName {
  return Object.hasOwn(DEFAULTS, name);
}

const REDIS_KEY = 'feature:flags';

// In-memory cache of the stored overrides, registered names only
const overrides = new Map<FeatureFlagName, boolean>();

// Unknown names already reported (a name comes from code, not from a
// request; bounded anyway)
const UNKNOWN_WARNED_MAX = 100;
const unknownWarned = new Set<string>();

const CONFIG_CHANNEL = 'config:feature_flags';

/** Load overrides from Redis on server startup and subscribe to cross-node updates. */
export async function loadFeatureFlags(): Promise<void> {
  try {
    const redis = getRedis();
    const data = await redis.hGetAll(REDIS_KEY);
    for (const [name, value] of Object.entries(data)) {
      if (isKnownFlag(name)) {
        overrides.set(name, value === 'true');
      }
    }
  } catch (err) {
    console.error('[FeatureFlags] Failed to load from Redis, using defaults:', describeCaughtErrorWithStack(err));
  }

  // Subscribe to config changes from other nodes
  try {
    const configSub = getRedisConfigSub();
    await configSub.subscribe(CONFIG_CHANNEL, (message) => {
      try {
        const { name, enabled, action } = JSON.parse(message);
        if (typeof name !== 'string' || !isKnownFlag(name)) return;
        if (action === 'reset') {
          overrides.delete(name);
        } else if (typeof enabled === 'boolean') {
          overrides.set(name, enabled);
        }
      } catch (err) {
        // Ignored, and said once per message: the channel and the error's
        // name, never the payload
        console.warn(`[FeatureFlags] Ignored a malformed message on ${CONFIG_CHANNEL} (${err instanceof Error ? err.name : typeof err})`);
      }
    });
  } catch (err) {
    console.error('[FeatureFlags] Failed to subscribe to config channel:', describeCaughtErrorWithStack(err));
  }
}

/**
 * Whether a feature is enabled: its stored override, else its default. A name
 * the registry does not hold reads as DISABLED, with one warning per name: a
 * kill switch spelled wrong must fail visibly, never stay on for good (the
 * type rules such a call out at compile time; this is the net under it).
 */
export function isFeatureEnabled(name: FeatureFlagName): boolean {
  if (!isKnownFlag(name)) {
    if (!unknownWarned.has(name) && unknownWarned.size < UNKNOWN_WARNED_MAX) {
      unknownWarned.add(name);
      console.warn(`[FeatureFlags] Unknown feature flag "${String(name)}" read as disabled`);
    }
    return false;
  }
  return overrides.get(name) ?? DEFAULTS[name].enabled;
}

/** Get all feature flags with current state */
export function getAllFeatureFlags(): Array<FeatureFlagDef & { isCustom: boolean }> {
  return Object.values(DEFAULTS).map((def: FeatureFlagDef) => {
    const override = isKnownFlag(def.name) ? overrides.get(def.name) : undefined;
    return { ...def, enabled: override ?? def.enabled, isCustom: override !== undefined };
  });
}

/** Update a feature flag and notify all nodes. A name the registry does not hold is a 404. */
export async function updateFeatureFlag(name: string, enabled: boolean): Promise<void> {
  if (!isKnownFlag(name)) throw new NotFoundError('Feature flag');
  const redis = getRedis();
  await redis.hSet(REDIS_KEY, name, String(enabled));
  overrides.set(name, enabled);
  // Notify other nodes
  const { pub } = getRedisPubSub();
  await pub.publish(CONFIG_CHANNEL, JSON.stringify({ name, enabled, action: 'set' }));
}

/** Reset a feature flag to default and notify all nodes. A name the registry does not hold is a 404. */
export async function resetFeatureFlag(name: string): Promise<void> {
  if (!isKnownFlag(name)) throw new NotFoundError('Feature flag');
  const redis = getRedis();
  await redis.hDel(REDIS_KEY, name);
  overrides.delete(name);
  // Notify other nodes
  const { pub } = getRedisPubSub();
  await pub.publish(CONFIG_CHANNEL, JSON.stringify({ name, action: 'reset' }));
}
