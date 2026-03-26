import { prisma } from './prisma';
import {
  permissionsFromString,
  computeBasePermissions,
  computeChannelPermissions,
  ALL_PERMISSIONS,
  hasPermission as hasFlag,
  Permissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@voxium/shared';

/**
 * Compute effective base permissions for a user in a server (no channel overrides).
 * Owner always gets ALL_PERMISSIONS.
 */
export async function computeServerPermissions(
  userId: string,
  serverId: string,
): Promise<bigint> {
  // Check if user is server owner (bypass)
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });
  if (!server) return 0n;
  if (server.ownerId === userId) return ALL_PERMISSIONS;

  // Verify user is a member — non-members get no permissions
  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { userId: true },
  });
  if (!membership) return 0n;

  // Get @everyone role
  const everyoneRole = await prisma.role.findFirst({
    where: { serverId, isDefault: true },
    select: { permissions: true },
  });
  const everyonePerms = everyoneRole
    ? permissionsFromString(everyoneRole.permissions)
    : DEFAULT_EVERYONE_PERMISSIONS;

  // Get user's assigned roles
  const memberRoles = await prisma.memberRole.findMany({
    where: { userId, serverId },
    include: { role: { select: { permissions: true } } },
  });
  const rolePerms = memberRoles.map((mr) => permissionsFromString(mr.role.permissions));

  return computeBasePermissions(everyonePerms, rolePerms);
}

/**
 * Compute effective permissions for a user in a specific channel.
 * Applies channel-level overrides on top of base server permissions.
 *
 * Optimized: fetches @everyone role (with id + permissions), user's member roles,
 * and channel overrides in a single parallel batch to avoid redundant queries
 * with computeServerPermissions.
 */
export async function computeUserChannelPermissions(
  userId: string,
  channelId: string,
  serverId: string,
): Promise<bigint> {
  // Check if user is server owner (bypass)
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });
  if (!server) return 0n;
  if (server.ownerId === userId) return ALL_PERMISSIONS;

  // Verify membership
  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { userId: true },
  });
  if (!membership) return 0n;

  // Fetch all needed data in parallel
  const [everyoneRole, memberRoles, overrides] = await Promise.all([
    prisma.role.findFirst({
      where: { serverId, isDefault: true },
      select: { id: true, permissions: true },
    }),
    prisma.memberRole.findMany({
      where: { userId, serverId },
      include: { role: { select: { permissions: true } } },
    }),
    prisma.channelPermissionOverride.findMany({
      where: { channelId },
    }),
  ]);

  // Compute base permissions
  const everyonePerms = everyoneRole
    ? permissionsFromString(everyoneRole.permissions)
    : DEFAULT_EVERYONE_PERMISSIONS;
  const rolePerms = memberRoles.map((mr) => permissionsFromString(mr.role.permissions));
  const base = computeBasePermissions(everyonePerms, rolePerms);

  // ADMINISTRATOR bypasses channel overrides
  if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;

  // Build channel override maps
  const userRoleIds = new Set(memberRoles.map((mr) => mr.roleId));
  let everyoneOverride: { allow: bigint; deny: bigint } | null = null;
  const roleOverrides: { allow: bigint; deny: bigint }[] = [];

  for (const o of overrides) {
    const allow = permissionsFromString(o.allow);
    const deny = permissionsFromString(o.deny);
    if (everyoneRole && o.roleId === everyoneRole.id) {
      everyoneOverride = { allow, deny };
    } else if (userRoleIds.has(o.roleId)) {
      roleOverrides.push({ allow, deny });
    }
  }

  return computeChannelPermissions(base, everyoneOverride, roleOverrides);
}

/**
 * Check if a user has a specific permission in a server (base level).
 */
export async function hasServerPermission(
  userId: string,
  serverId: string,
  permission: bigint,
): Promise<boolean> {
  const perms = await computeServerPermissions(userId, serverId);
  return hasFlag(perms, permission);
}

/**
 * Check if a user has a specific permission in a channel.
 */
export async function hasChannelPermission(
  userId: string,
  channelId: string,
  serverId: string,
  permission: bigint,
): Promise<boolean> {
  const perms = await computeUserChannelPermissions(userId, channelId, serverId);
  return hasFlag(perms, permission);
}

/**
 * Get the highest role position for a user in a server.
 * Used for role hierarchy enforcement.
 * Owner returns Infinity.
 */
export async function getHighestRolePosition(
  userId: string,
  serverId: string,
): Promise<number> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });
  if (server?.ownerId === userId) return Infinity;

  const memberRoles = await prisma.memberRole.findMany({
    where: { userId, serverId },
    include: { role: { select: { position: true } } },
  });

  if (memberRoles.length === 0) return 0; // only @everyone (position 0)

  return Math.max(...memberRoles.map((mr) => mr.role.position));
}

/**
 * Get formatted effective permissions for API response.
 */
export async function getEffectivePermissions(
  userId: string,
  serverId: string,
  channelId?: string,
): Promise<{ permissions: string; source: 'owner' | 'computed' }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });

  if (server?.ownerId === userId) {
    return { permissions: permissionsToString(ALL_PERMISSIONS), source: 'owner' };
  }

  const perms = channelId
    ? await computeUserChannelPermissions(userId, channelId, serverId)
    : await computeServerPermissions(userId, serverId);

  return { permissions: permissionsToString(perms), source: 'computed' };
}

/**
 * Filter a list of channels to only those the user can view.
 * Optimized: fetches permissions data once and computes per-channel in memory.
 */
export async function filterVisibleChannels<T extends { id: string }>(
  userId: string,
  serverId: string,
  channels: T[],
): Promise<T[]> {
  // Owner sees everything
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });
  if (!server) return [];
  if (server.ownerId === userId) return channels;

  // Fetch base permission data
  const [everyoneRole, memberRoles] = await Promise.all([
    prisma.role.findFirst({
      where: { serverId, isDefault: true },
      select: { id: true, permissions: true },
    }),
    prisma.memberRole.findMany({
      where: { userId, serverId },
      include: { role: { select: { id: true, permissions: true } } },
    }),
  ]);

  const everyonePerms = everyoneRole
    ? permissionsFromString(everyoneRole.permissions)
    : DEFAULT_EVERYONE_PERMISSIONS;
  const rolePerms = memberRoles.map((mr) => permissionsFromString(mr.role.permissions));
  const base = computeBasePermissions(everyonePerms, rolePerms);

  // ADMINISTRATOR or ALL_PERMISSIONS sees everything
  if (base === ALL_PERMISSIONS) return channels;

  // Fetch all channel overrides for all these channels in one query
  const channelIds = channels.map((c) => c.id);
  const allOverrides = await prisma.channelPermissionOverride.findMany({
    where: { channelId: { in: channelIds } },
  });

  // Group overrides by channel
  const overridesByChannel = new Map<string, typeof allOverrides>();
  for (const o of allOverrides) {
    const list = overridesByChannel.get(o.channelId) || [];
    list.push(o);
    overridesByChannel.set(o.channelId, list);
  }

  const userRoleIds = new Set(memberRoles.map((mr) => mr.roleId));

  return channels.filter((channel) => {
    const overrides = overridesByChannel.get(channel.id) || [];

    let everyoneOverride: { allow: bigint; deny: bigint } | null = null;
    const roleOverrides: { allow: bigint; deny: bigint }[] = [];

    for (const o of overrides) {
      const allow = permissionsFromString(o.allow);
      const deny = permissionsFromString(o.deny);
      if (everyoneRole && o.roleId === everyoneRole.id) {
        everyoneOverride = { allow, deny };
      } else if (userRoleIds.has(o.roleId)) {
        roleOverrides.push({ allow, deny });
      }
    }

    const perms = computeChannelPermissions(base, everyoneOverride, roleOverrides);
    return hasFlag(perms, Permissions.VIEW_CHANNEL);
  });
}

// Re-export Permissions for convenient use in route guards
export { Permissions, hasFlag as hasPermission };
