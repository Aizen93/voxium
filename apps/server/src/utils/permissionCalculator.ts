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

// ─── Secure channels ─────────────────────────────────────────────────────────
// Permissions inside a secure channel are MEMBERSHIP-derived, never role-
// derived: a ChannelMember row is the only thing that grants access, and its
// absence denies access to everyone — including the server owner and
// ADMINISTRATOR holders. Every code path below therefore checks `secure`
// BEFORE any owner/ADMINISTRATOR fast path. (Moderation without membership is
// deliberately limited to deleting the channel by id — routes/channels.ts.)

/** What every secure-channel member may do. */
export const SECURE_MEMBER_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.ADD_REACTIONS |
  Permissions.ATTACH_FILES;

/** The creator may additionally moderate messages. */
export const SECURE_CREATOR_PERMISSIONS =
  SECURE_MEMBER_PERMISSIONS | Permissions.MANAGE_MESSAGES;

/**
 * What every secure VOICE channel member may do (spec §21). Deliberately no
 * MUTE_MEMBERS / DEAFEN_MEMBERS / MOVE_MEMBERS — server-side moderation of an
 * E2E voice room is impossible by design, for the creator too.
 */
export const SECURE_VOICE_MEMBER_PERMISSIONS =
  Permissions.VIEW_CHANNEL | Permissions.CONNECT | Permissions.SPEAK;

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
  // One fetch covers the secure flag, the channel↔server binding, and the
  // owner bypass (replaces the old bare server fetch — no extra query).
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { secure: true, type: true, serverId: true, server: { select: { ownerId: true } } },
  });
  if (!channel || channel.serverId !== serverId) return 0n;

  // Secure channels: membership is the ONLY source of permissions. This must
  // stay ahead of the owner fast path — a non-member owner gets 0n. The
  // ServerMember check is defense in depth: leave/kick flows delete
  // ChannelMember rows, but a stale row must never outrank that.
  if (channel.secure) {
    const [member, serverMember] = await Promise.all([
      prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId } },
        select: { isCreator: true },
      }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId, serverId } },
        select: { userId: true },
      }),
    ]);
    if (!member || !serverMember) return 0n;
    if (channel.type === 'voice') return SECURE_VOICE_MEMBER_PERMISSIONS;
    return member.isCreator ? SECURE_CREATOR_PERMISSIONS : SECURE_MEMBER_PERMISSIONS;
  }

  if (channel.server.ownerId === userId) return ALL_PERMISSIONS;

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
export async function filterVisibleChannels<T extends { id: string; secure?: boolean }>(
  userId: string,
  serverId: string,
  channels: T[],
): Promise<T[]> {
  // Secure channels are visible iff the user is a ChannelMember — decided
  // BEFORE the owner/ADMINISTRATOR fast paths below, which only ever apply to
  // the plaintext partition. Callers that select channels without the `secure`
  // field fail open here, so every caller must include it.
  const secureIds = channels.filter((c) => c.secure).map((c) => c.id);
  let secureMemberships: Set<string> | null = null;
  if (secureIds.length > 0) {
    const rows = await prisma.channelMember.findMany({
      where: { userId, channelId: { in: secureIds } },
      select: { channelId: true },
    });
    secureMemberships = new Set(rows.map((r) => r.channelId));
  }
  const visibleSecure = (c: T) => (secureMemberships ? secureMemberships.has(c.id) : false);
  const plainChannels = channels.filter((c) => !c.secure);

  // Owner sees every plaintext channel
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });
  if (!server) return [];
  if (server.ownerId === userId) {
    return channels.filter((c) => (c.secure ? visibleSecure(c) : true));
  }

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

  // ADMINISTRATOR sees every plaintext channel — secure still needs membership
  if (base === ALL_PERMISSIONS) {
    return channels.filter((c) => (c.secure ? visibleSecure(c) : true));
  }

  // Fetch all channel overrides for the plaintext channels in one query
  const channelIds = plainChannels.map((c) => c.id);
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
    if (channel.secure) return visibleSecure(channel);

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

/**
 * Multi-server variant of filterVisibleChannels for the socket-connect hot
 * path. The old per-server loop cost ~4 queries PER SERVER on every connect —
 * a deploy reconnecting thousands of clients turned into a self-inflicted DB
 * stampede. This runs exactly 4 batched queries regardless of how many
 * servers/channels are involved (+1 only when secure channels are present).
 *
 * CALLER CONTRACT: the user must be a member of every server referenced by
 * `channels` (the connect flow derives them from the user's own memberships) —
 * membership is NOT re-verified here. Callers must also select the `secure`
 * field: without it, secure channels would be treated as plaintext and leak
 * into every member's rooms.
 */
export async function filterVisibleChannelsMulti<
  T extends { id: string; serverId: string; secure?: boolean },
>(userId: string, channels: T[]): Promise<T[]> {
  if (channels.length === 0) return [];
  const serverIds = [...new Set(channels.map((c) => c.serverId))];
  const secureIds = channels.filter((c) => c.secure).map((c) => c.id);
  const plainIds = channels.filter((c) => !c.secure).map((c) => c.id);

  const [servers, everyoneRoles, memberRoles, allOverrides, secureRows] = await Promise.all([
    prisma.server.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, ownerId: true },
    }),
    prisma.role.findMany({
      where: { serverId: { in: serverIds }, isDefault: true },
      select: { id: true, serverId: true, permissions: true },
    }),
    prisma.memberRole.findMany({
      where: { userId, serverId: { in: serverIds } },
      include: { role: { select: { permissions: true } } },
    }),
    prisma.channelPermissionOverride.findMany({
      where: { channelId: { in: plainIds } },
    }),
    secureIds.length > 0
      ? prisma.channelMember.findMany({
          where: { userId, channelId: { in: secureIds } },
          select: { channelId: true },
        })
      : Promise.resolve([]),
  ]);
  const secureMemberships = new Set(secureRows.map((r) => r.channelId));

  const ownerByServer = new Map(servers.map((s) => [s.id, s.ownerId]));
  const everyoneByServer = new Map(everyoneRoles.map((r) => [r.serverId, r]));
  const rolesByServer = new Map<string, typeof memberRoles>();
  for (const mr of memberRoles) {
    const list = rolesByServer.get(mr.serverId) || [];
    list.push(mr);
    rolesByServer.set(mr.serverId, list);
  }
  const overridesByChannel = new Map<string, typeof allOverrides>();
  for (const o of allOverrides) {
    const list = overridesByChannel.get(o.channelId) || [];
    list.push(o);
    overridesByChannel.set(o.channelId, list);
  }

  // Base permissions computed once per server (same math as filterVisibleChannels)
  const baseByServer = new Map<string, bigint>();
  const userRoleIdsByServer = new Map<string, Set<string>>();
  for (const serverId of serverIds) {
    const serverRoles = rolesByServer.get(serverId) || [];
    userRoleIdsByServer.set(serverId, new Set(serverRoles.map((mr) => mr.roleId)));
    if (!ownerByServer.has(serverId)) {
      baseByServer.set(serverId, 0n); // server deleted mid-connect
      continue;
    }
    if (ownerByServer.get(serverId) === userId) {
      baseByServer.set(serverId, ALL_PERMISSIONS);
      continue;
    }
    const everyoneRole = everyoneByServer.get(serverId);
    const everyonePerms = everyoneRole
      ? permissionsFromString(everyoneRole.permissions)
      : DEFAULT_EVERYONE_PERMISSIONS;
    const rolePerms = serverRoles.map((mr) => permissionsFromString(mr.role.permissions));
    baseByServer.set(serverId, computeBasePermissions(everyonePerms, rolePerms));
  }

  return channels.filter((channel) => {
    // Secure channels: membership only — ahead of the owner/ADMIN fast paths.
    if (channel.secure) return secureMemberships.has(channel.id);

    if (ownerByServer.get(channel.serverId) === userId) return true;
    const base = baseByServer.get(channel.serverId) ?? 0n;
    if (base === ALL_PERMISSIONS) return true; // ADMINISTRATOR sees everything

    const everyoneRole = everyoneByServer.get(channel.serverId);
    const userRoleIds = userRoleIdsByServer.get(channel.serverId) ?? new Set<string>();
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

/**
 * Multi-USER variant: which of `channels` each of `userIds` can view, in a
 * FIXED number of queries regardless of how many users are involved.
 *
 * `filterVisibleChannelsMulti` batches across SERVERS for one user — every one
 * of its queries filters on `userId` — so calling it per user in a loop still
 * costs 4-5 round trips each. That is what made a single `PATCH /roles/:id`
 * on a large server fan out ~20k sequential queries: `syncChannelVisibilityRooms`
 * awaited `filterVisibleChannels` once per connected member, uncapped, while
 * the role-manage limiter happily allowed 20 such edits a minute.
 *
 * Returns userId → set of visible channel ids. Users with no entry in the
 * membership data still get an (empty) set, so callers can treat a missing
 * channel as "leave the room" without a second lookup.
 *
 * Membership IS verified here (unlike `filterVisibleChannelsMulti`, whose
 * caller contract assumes it): the sockets this feeds come from a room, not
 * from a membership query, and a member who just left must lose their rooms.
 */
export async function filterVisibleChannelsForUsers<T extends { id: string; secure?: boolean }>(
  userIds: string[],
  serverId: string,
  channels: T[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>(userIds.map((id) => [id, new Set<string>()]));
  if (userIds.length === 0 || channels.length === 0) return result;

  const secureIds = channels.filter((c) => c.secure).map((c) => c.id);
  const plainIds = channels.filter((c) => !c.secure).map((c) => c.id);

  const [server, everyoneRole, memberRoles, overrides, members, secureRows] = await Promise.all([
    prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
    prisma.role.findFirst({ where: { serverId, isDefault: true }, select: { id: true, permissions: true } }),
    prisma.memberRole.findMany({
      where: { serverId, userId: { in: userIds } },
      select: { userId: true, roleId: true, role: { select: { permissions: true } } },
    }),
    plainIds.length > 0
      ? prisma.channelPermissionOverride.findMany({ where: { channelId: { in: plainIds } } })
      : Promise.resolve([]),
    prisma.serverMember.findMany({
      where: { serverId, userId: { in: userIds } },
      select: { userId: true },
    }),
    secureIds.length > 0
      ? prisma.channelMember.findMany({
          where: { channelId: { in: secureIds }, userId: { in: userIds } },
          select: { channelId: true, userId: true },
        })
      : Promise.resolve([]),
  ]);
  if (!server) return result; // server deleted mid-flight — nobody sees anything

  const memberSet = new Set(members.map((m) => m.userId));
  const secureByUser = new Map<string, Set<string>>();
  for (const row of secureRows) {
    let set = secureByUser.get(row.userId);
    if (!set) secureByUser.set(row.userId, (set = new Set()));
    set.add(row.channelId);
  }
  const rolesByUser = new Map<string, typeof memberRoles>();
  for (const mr of memberRoles) {
    const list = rolesByUser.get(mr.userId) || [];
    list.push(mr);
    rolesByUser.set(mr.userId, list);
  }
  const overridesByChannel = new Map<string, typeof overrides>();
  for (const o of overrides) {
    const list = overridesByChannel.get(o.channelId) || [];
    list.push(o);
    overridesByChannel.set(o.channelId, list);
  }
  const everyonePerms = everyoneRole
    ? permissionsFromString(everyoneRole.permissions)
    : DEFAULT_EVERYONE_PERMISSIONS;

  for (const userId of userIds) {
    const visible = result.get(userId)!;
    // Secure channels are membership-only and are decided BEFORE the
    // owner/ADMINISTRATOR fast paths — a non-member owner sees nothing.
    const secureMemberships = secureByUser.get(userId);
    if (secureMemberships) for (const id of secureMemberships) visible.add(id);

    if (!memberSet.has(userId)) continue; // no longer a member: plaintext all denied
    if (server.ownerId === userId) {
      for (const c of channels) if (!c.secure) visible.add(c.id);
      continue;
    }

    const userRoles = rolesByUser.get(userId) || [];
    const base = computeBasePermissions(everyonePerms, userRoles.map((mr) => permissionsFromString(mr.role.permissions)));
    if (base === ALL_PERMISSIONS) { // ADMINISTRATOR
      for (const c of channels) if (!c.secure) visible.add(c.id);
      continue;
    }

    const userRoleIds = new Set(userRoles.map((mr) => mr.roleId));
    for (const channel of channels) {
      if (channel.secure) continue;
      let everyoneOverride: { allow: bigint; deny: bigint } | null = null;
      const roleOverrides: { allow: bigint; deny: bigint }[] = [];
      for (const o of overridesByChannel.get(channel.id) || []) {
        const allow = permissionsFromString(o.allow);
        const deny = permissionsFromString(o.deny);
        if (everyoneRole && o.roleId === everyoneRole.id) everyoneOverride = { allow, deny };
        else if (userRoleIds.has(o.roleId)) roleOverrides.push({ allow, deny });
      }
      if (hasFlag(computeChannelPermissions(base, everyoneOverride, roleOverrides), Permissions.VIEW_CHANNEL)) {
        visible.add(channel.id);
      }
    }
  }

  return result;
}

// Re-export Permissions for convenient use in route guards
export { Permissions, hasFlag as hasPermission };
