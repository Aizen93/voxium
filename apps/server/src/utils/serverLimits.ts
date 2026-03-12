import { prisma } from './prisma';
import { LIMITS } from '@voxium/shared';
import type { ResourceLimits } from '@voxium/shared';

// Hardcoded defaults (fallback if no GlobalConfig row exists)
const DEFAULTS: ResourceLimits = {
  maxChannelsPerServer: LIMITS.MAX_CHANNELS_PER_SERVER,
  maxVoiceUsersPerChannel: LIMITS.MAX_VOICE_USERS_PER_CHANNEL,
  maxCategoriesPerServer: LIMITS.MAX_CATEGORIES_PER_SERVER,
  maxMembersPerServer: 0, // unlimited
};

/**
 * Get the global config row, creating it with defaults if it doesn't exist.
 */
export async function getGlobalLimits(): Promise<ResourceLimits> {
  const config = await prisma.globalConfig.upsert({
    where: { id: 'global' },
    create: { id: 'global' },
    update: {},
  });
  return {
    maxChannelsPerServer: config.maxChannelsPerServer,
    maxVoiceUsersPerChannel: config.maxVoiceUsersPerChannel,
    maxCategoriesPerServer: config.maxCategoriesPerServer,
    maxMembersPerServer: config.maxMembersPerServer,
  };
}

/**
 * Resolve effective limits for a server.
 * Priority: server override > global config > hardcoded defaults.
 */
export async function getEffectiveLimits(serverId: string): Promise<ResourceLimits> {
  const [globalConfig, serverLimits] = await Promise.all([
    prisma.globalConfig.findUnique({ where: { id: 'global' } }),
    prisma.serverLimits.findUnique({ where: { serverId } }),
  ]);

  const global: ResourceLimits = globalConfig
    ? {
        maxChannelsPerServer: globalConfig.maxChannelsPerServer,
        maxVoiceUsersPerChannel: globalConfig.maxVoiceUsersPerChannel,
        maxCategoriesPerServer: globalConfig.maxCategoriesPerServer,
        maxMembersPerServer: globalConfig.maxMembersPerServer,
      }
    : DEFAULTS;

  if (!serverLimits) return global;

  return {
    maxChannelsPerServer: serverLimits.maxChannelsPerServer ?? global.maxChannelsPerServer,
    maxVoiceUsersPerChannel: serverLimits.maxVoiceUsersPerChannel ?? global.maxVoiceUsersPerChannel,
    maxCategoriesPerServer: serverLimits.maxCategoriesPerServer ?? global.maxCategoriesPerServer,
    maxMembersPerServer: serverLimits.maxMembersPerServer ?? global.maxMembersPerServer,
  };
}
