import { Permissions, hasPermission } from '@voxium/shared';

/**
 * Which effective permissions give a member something to do in Server
 * settings: MANAGE_SERVER (General, Discovery), KICK_MEMBERS (join requests
 * and bans in Members), MANAGE_ROLES (Roles). The owner and legacy admins
 * open it regardless; this is the rule for everyone else, so a role-only
 * moderator is not locked out of the sections the tab gates on their bit.
 */
export const SERVER_SETTINGS_PERMISSIONS = [Permissions.MANAGE_SERVER, Permissions.KICK_MEMBERS, Permissions.MANAGE_ROLES] as const;

export function canOpenServerSettings(effective: bigint): boolean {
  return SERVER_SETTINGS_PERMISSIONS.some((bit) => hasPermission(effective, bit));
}
