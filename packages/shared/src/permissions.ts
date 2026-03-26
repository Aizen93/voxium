// ─── Permission Bitmask Flags ────────────────────────────────────────────────
// Stored as string (decimal) in DB, computed as bigint in application layer.
// Each permission is a single bit in a bitmask.

export const Permissions = {
  // General
  VIEW_CHANNEL:       1n << 0n,
  MANAGE_CHANNELS:    1n << 1n,
  MANAGE_CATEGORIES:  1n << 2n,
  MANAGE_SERVER:      1n << 3n,
  MANAGE_ROLES:       1n << 4n,

  // Membership
  CREATE_INVITES:     1n << 5n,
  KICK_MEMBERS:       1n << 6n,
  MANAGE_NICKNAMES:   1n << 7n,
  CHANGE_NICKNAME:    1n << 8n,

  // Text
  SEND_MESSAGES:      1n << 9n,
  MANAGE_MESSAGES:    1n << 10n,
  ATTACH_FILES:       1n << 11n,
  ADD_REACTIONS:      1n << 12n,
  MENTION_EVERYONE:   1n << 13n,

  // Voice
  CONNECT:            1n << 14n,
  SPEAK:              1n << 15n,
  MUTE_MEMBERS:       1n << 16n,
  DEAFEN_MEMBERS:     1n << 17n,
  MOVE_MEMBERS:       1n << 18n,

  // Special
  ADMINISTRATOR:      1n << 19n,
} as const;

export type PermissionFlag = (typeof Permissions)[keyof typeof Permissions];

/** All permission flags OR'd together */
export const ALL_PERMISSIONS = Object.values(Permissions).reduce((acc, p) => acc | p, 0n);

/** Default permissions for the @everyone role (new servers).
 * Basics only — no file uploads, invites, or nickname changes.
 * Admins can grant additional permissions via custom roles. */
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.ADD_REACTIONS |
  Permissions.CONNECT |
  Permissions.SPEAK;

/** Default permissions for an "Admin" role created during migration */
export const DEFAULT_ADMIN_PERMISSIONS =
  DEFAULT_EVERYONE_PERMISSIONS |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_CATEGORIES |
  Permissions.MANAGE_ROLES |
  Permissions.CREATE_INVITES |
  Permissions.KICK_MEMBERS |
  Permissions.MANAGE_NICKNAMES |
  Permissions.CHANGE_NICKNAME |
  Permissions.MANAGE_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.MENTION_EVERYONE |
  Permissions.MUTE_MEMBERS |
  Permissions.DEAFEN_MEMBERS |
  Permissions.MOVE_MEMBERS;

// ─── Permission Utility Functions ────────────────────────────────────────────

/** Check if a bitmask contains a specific permission */
export function hasPermission(permissions: bigint, flag: bigint): boolean {
  // ADMINISTRATOR bypasses all checks
  if ((permissions & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return true;
  return (permissions & flag) === flag;
}

/** Combine multiple permission bitmasks via OR */
export function combinePermissions(...perms: bigint[]): bigint {
  return perms.reduce((acc, p) => acc | p, 0n);
}

/** Convert permission bigint to string for DB/JSON storage */
export function permissionsToString(permissions: bigint): string {
  return permissions.toString();
}

/** Convert string from DB/JSON to permission bigint. Rejects negatives and masks to valid bits. */
export function permissionsFromString(str: string): bigint {
  try {
    const val = BigInt(str);
    if (val < 0n) return 0n;
    return val & ALL_PERMISSIONS;
  } catch {
    return 0n;
  }
}

/**
 * Compute effective permissions for a user in a server (base, before channel overrides).
 *
 * Resolution:
 * 1. Start with @everyone role permissions
 * 2. OR together all permissions from user's additional roles
 * 3. If ADMINISTRATOR is set, return ALL_PERMISSIONS
 */
export function computeBasePermissions(
  everyonePermissions: bigint,
  rolePermissions: bigint[],
): bigint {
  let permissions = everyonePermissions;
  for (const rp of rolePermissions) {
    permissions |= rp;
  }
  if ((permissions & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }
  return permissions;
}

/**
 * Apply channel-level permission overrides.
 *
 * Resolution (Discord-style):
 * 1. Start with base permissions
 * 2. Apply @everyone channel override (deny removes, allow adds)
 * 3. For all user's roles, aggregate their channel overrides (OR all allows, OR all denies)
 * 4. Apply aggregated role overrides (deny removes, allow adds)
 *
 * @param basePermissions - result of computeBasePermissions()
 * @param everyoneOverride - { allow, deny } for @everyone role on this channel (or null)
 * @param roleOverrides - array of { allow, deny } for each of the user's assigned roles
 */
export function computeChannelPermissions(
  basePermissions: bigint,
  everyoneOverride: { allow: bigint; deny: bigint } | null,
  roleOverrides: { allow: bigint; deny: bigint }[],
): bigint {
  // ADMINISTRATOR bypasses channel overrides
  if ((basePermissions & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  let permissions = basePermissions;

  // Apply @everyone override first
  if (everyoneOverride) {
    permissions &= ~everyoneOverride.deny;
    permissions |= everyoneOverride.allow;
  }

  // Aggregate role overrides
  let aggregatedAllow = 0n;
  let aggregatedDeny = 0n;
  for (const override of roleOverrides) {
    aggregatedAllow |= override.allow;
    aggregatedDeny |= override.deny;
  }

  // Apply aggregated role overrides (allow wins over deny at same level)
  permissions &= ~aggregatedDeny;
  permissions |= aggregatedAllow;

  return permissions;
}

// ─── Permission Labels (for UI) ──────────────────────────────────────────────

export interface PermissionInfo {
  flag: bigint;
  key: string;
  name: string;
  description: string;
  category: 'general' | 'membership' | 'text' | 'voice' | 'special';
}

export const PERMISSION_LIST: PermissionInfo[] = [
  // General
  { flag: Permissions.VIEW_CHANNEL, key: 'VIEW_CHANNEL', name: 'View Channels', description: 'Allows members to view text and voice channels', category: 'general' },
  { flag: Permissions.MANAGE_CHANNELS, key: 'MANAGE_CHANNELS', name: 'Manage Channels', description: 'Allows members to create, edit, and delete channels', category: 'general' },
  { flag: Permissions.MANAGE_CATEGORIES, key: 'MANAGE_CATEGORIES', name: 'Manage Categories', description: 'Allows members to create, edit, and delete categories', category: 'general' },
  { flag: Permissions.MANAGE_SERVER, key: 'MANAGE_SERVER', name: 'Manage Server', description: 'Allows members to edit server name, icon, and settings', category: 'general' },
  { flag: Permissions.MANAGE_ROLES, key: 'MANAGE_ROLES', name: 'Manage Roles', description: 'Allows members to create, edit, and delete roles below their own', category: 'general' },
  // Membership
  { flag: Permissions.CREATE_INVITES, key: 'CREATE_INVITES', name: 'Create Invites', description: 'Allows members to create server invite links', category: 'membership' },
  { flag: Permissions.KICK_MEMBERS, key: 'KICK_MEMBERS', name: 'Kick Members', description: 'Allows members to kick other members with lower roles', category: 'membership' },
  { flag: Permissions.MANAGE_NICKNAMES, key: 'MANAGE_NICKNAMES', name: 'Manage Nicknames', description: 'Allows members to change other members\' display names', category: 'membership' },
  { flag: Permissions.CHANGE_NICKNAME, key: 'CHANGE_NICKNAME', name: 'Change Nickname', description: 'Allows members to change their own display name', category: 'membership' },
  // Text
  { flag: Permissions.SEND_MESSAGES, key: 'SEND_MESSAGES', name: 'Send Messages', description: 'Allows members to send messages in text channels', category: 'text' },
  { flag: Permissions.MANAGE_MESSAGES, key: 'MANAGE_MESSAGES', name: 'Manage Messages', description: 'Allows members to delete messages from other members', category: 'text' },
  { flag: Permissions.ATTACH_FILES, key: 'ATTACH_FILES', name: 'Attach Files', description: 'Allows members to upload file attachments', category: 'text' },
  { flag: Permissions.ADD_REACTIONS, key: 'ADD_REACTIONS', name: 'Add Reactions', description: 'Allows members to add reactions to messages', category: 'text' },
  { flag: Permissions.MENTION_EVERYONE, key: 'MENTION_EVERYONE', name: 'Mention Everyone', description: 'Allows members to use @everyone mentions', category: 'text' },
  // Voice
  { flag: Permissions.CONNECT, key: 'CONNECT', name: 'Connect', description: 'Allows members to join voice channels', category: 'voice' },
  { flag: Permissions.SPEAK, key: 'SPEAK', name: 'Speak', description: 'Allows members to speak in voice channels', category: 'voice' },
  { flag: Permissions.MUTE_MEMBERS, key: 'MUTE_MEMBERS', name: 'Mute Members', description: 'Allows members to mute other members in voice', category: 'voice' },
  { flag: Permissions.DEAFEN_MEMBERS, key: 'DEAFEN_MEMBERS', name: 'Deafen Members', description: 'Allows members to deafen other members in voice', category: 'voice' },
  { flag: Permissions.MOVE_MEMBERS, key: 'MOVE_MEMBERS', name: 'Move Members', description: 'Allows members to move other members between voice channels', category: 'voice' },
  // Special
  { flag: Permissions.ADMINISTRATOR, key: 'ADMINISTRATOR', name: 'Administrator', description: 'Grants all permissions and bypasses all channel overrides', category: 'special' },
];

// Role color regex — used by validators
export const ROLE_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
