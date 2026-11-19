import { Permissions, hasPermission } from '@voxium/shared';
import type { Role, ServerMember } from '@voxium/shared';

/**
 * Which moderation controls the viewer is shown for another member, decided
 * by the rules the server enforces for each action (never by the legacy
 * `ServerMember.role` string, which authorises nothing):
 *
 * - the permission BIT the route or socket handler checks, at the level it
 *   checks it (space level, or the voice channel's for mute and deafen);
 * - the role-position rule (`getHighestRolePosition`, server): the space's
 *   owner counts as Infinity, everyone else as their highest assigned role
 *   (0 with none), and the actor must be strictly above the target.
 *
 * Pure functions: the server stays the authority and answers 403 for
 * anything a stale client lets through; this only keeps the UI from showing
 * controls that cannot work, and from hiding ones that can.
 */

export interface ModerationContext {
  actorId: string;
  /** The space's owner (Server.ownerId): a target who is the owner stands above everyone. */
  ownerId: string | null | undefined;
  /** The viewer's effective permission bits, or null while unknown (everything false). */
  bits: bigint | null;
  /** Infinity for the space's owner, else the viewer's highest assigned role position (0 with none). */
  actorPosition: number;
  /** The space's roles: the position of a role is read from here, so a live role edit counts. */
  roles: Role[];
}

/** A member as far as these rules go. */
export type MemberRef = Pick<ServerMember, 'userId'> & { roles?: Pick<Role, 'id' | 'position' | 'isDefault'>[] };

/**
 * `getHighestRolePosition` on the client: Infinity for the owner, else the
 * highest position among the member's assigned (non-@everyone) roles, 0 with
 * none. A role's position is read from `roles` (the space's current list)
 * and falls back to the copy on the member row.
 */
export function highestRolePosition(member: MemberRef | undefined, ownerId: string | null | undefined, roles: Role[]): number {
  if (!member) return 0;
  if (ownerId && member.userId === ownerId) return Infinity;
  const byId = new Map(roles.map((r) => [r.id, r]));
  let highest = 0;
  for (const assigned of member.roles ?? []) {
    const role = byId.get(assigned.id) ?? assigned;
    if (role.isDefault) continue;
    if (role.position > highest) highest = role.position;
  }
  return highest;
}

export function buildModerationContext(args: {
  actorId: string;
  actor: MemberRef | undefined;
  ownerId: string | null | undefined;
  bits: bigint | null;
  roles: Role[];
}): ModerationContext {
  return {
    actorId: args.actorId,
    ownerId: args.ownerId,
    bits: args.bits,
    actorPosition: highestRolePosition(args.actor ?? { userId: args.actorId }, args.ownerId, args.roles),
    roles: args.roles,
  };
}

/** The viewer holds `flag` in `bits` (default: their space-level bits); ADMINISTRATOR holds every one. */
export function holds(ctx: ModerationContext, flag: bigint, bits: bigint | null = ctx.bits): boolean {
  return bits !== null && hasPermission(bits, flag);
}

/** The same test for a bare bit set, null while unknown. */
export function hasEffective(bits: bigint | null | undefined, flag: bigint): boolean {
  return bits !== null && bits !== undefined && hasPermission(bits, flag);
}

/** Another member the viewer stands strictly above in the role order. */
function mayActOn(ctx: ModerationContext, target: MemberRef): boolean {
  if (target.userId === ctx.actorId) return false;
  return ctx.actorPosition > highestRolePosition(target, ctx.ownerId, ctx.roles);
}

export interface MemberRules {
  /** Remove and ban: KICK_MEMBERS, and the viewer outranks the target (`POST …/kick`). */
  canKick(target: MemberRef): boolean;
  /** Assign roles: MANAGE_ROLES, the target is not the owner and ranks below the viewer; the owner may also edit their own (`PATCH …/roles/members/:id`). */
  canAssignRoles(target: MemberRef): boolean;
  /** The roles the viewer may put on someone: below their own position, never @everyone. */
  assignableRoles(): Role[];
  /** Another member's nickname: MANAGE_NICKNAMES and the viewer outranks them. */
  canSetNickname(target: MemberRef): boolean;
  /** The viewer's own nickname: CHANGE_NICKNAME. */
  canChangeOwnNickname(): boolean;
  /** Server mute / deafen: the bit is read at the VOICE CHANNEL level (`channelBits`), then the rank rule. */
  canServerMute(target: MemberRef, channelBits: bigint | null): boolean;
  canServerDeafen(target: MemberRef, channelBits: bigint | null): boolean;
  /** Move to another voice channel: MOVE_MEMBERS at space level, then the rank rule. */
  canMove(target: MemberRef): boolean;
}

export function memberRules(ctx: ModerationContext): MemberRules {
  return {
    canKick: (t) => holds(ctx, Permissions.KICK_MEMBERS) && mayActOn(ctx, t),
    // The server lets the OWNER assign their own roles (a member below the
    // owner never passes the rank rule against themselves)
    canAssignRoles: (t) => holds(ctx, Permissions.MANAGE_ROLES)
      && (t.userId === ctx.actorId ? !!ctx.ownerId && ctx.ownerId === ctx.actorId : mayActOn(ctx, t)),
    assignableRoles: () =>
      ctx.roles
        .filter((r) => !r.isDefault && r.position < ctx.actorPosition)
        .sort((a, b) => b.position - a.position),
    canSetNickname: (t) => holds(ctx, Permissions.MANAGE_NICKNAMES) && mayActOn(ctx, t),
    canChangeOwnNickname: () => holds(ctx, Permissions.CHANGE_NICKNAME),
    canServerMute: (t, channelBits) => holds(ctx, Permissions.MUTE_MEMBERS, channelBits) && mayActOn(ctx, t),
    canServerDeafen: (t, channelBits) => holds(ctx, Permissions.DEAFEN_MEMBERS, channelBits) && mayActOn(ctx, t),
    canMove: (t) => holds(ctx, Permissions.MOVE_MEMBERS) && mayActOn(ctx, t),
  };
}
