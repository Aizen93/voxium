import { ALL_PERMISSIONS, hasPermission } from '@voxium/shared';
import type { Role } from '@voxium/shared';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useServerPermissions } from './useServerPermissions';
import { highestRolePosition } from '../utils/memberActions';

/**
 * The signed-in viewer's server permissions in `serverId`, as the role and
 * override writes judge them: every bit for the space's owner, otherwise the
 * effective server permissions (`useServerPermissions`), or null while they
 * are not known yet.
 */
export function useViewerPermissions(serverId: string): bigint | null {
  const userId = useAuthStore((s) => s.user?.id);
  const ownerId = useServerStore((s) => s.servers.find((server) => server.id === serverId)?.ownerId);
  const bits = useServerPermissions(serverId, userId);
  if (userId !== undefined && ownerId === userId) return ALL_PERMISSIONS;
  return bits;
}

/**
 * Whether a role or override write by this viewer may turn `flag` ON: the
 * server refuses a write that turns on a bit its author does not hold (it
 * never refuses one that turns a bit off). Unknown bits (null) restrict
 * nothing: the server still decides.
 */
export function mayTurnOn(viewer: bigint | null, flag: bigint): boolean {
  return viewer === null || hasPermission(viewer, flag);
}

/**
 * The signed-in viewer's rank in `serverId`, as the role and override writes
 * judge it (`getHighestRolePosition` on the server, `highestRolePosition`
 * here): Infinity for the space's owner, otherwise the highest position
 * among their assigned roles (each read from the store's current role list),
 * 0 with none. Null while it is not known: nobody signed in, or no member
 * row of that space carrying its roles in the store.
 */
export function useViewerRolePosition(serverId: string): number | null {
  const userId = useAuthStore((s) => s.user?.id);
  const ownerId = useServerStore((s) => s.servers.find((server) => server.id === serverId)?.ownerId);
  const member = useServerStore((s) =>
    userId === undefined ? undefined : s.members.find((m) => m.userId === userId && m.serverId === serverId));
  const roles = useServerStore((s) => s.roles);
  if (userId === undefined) return null;
  if (ownerId === userId) return Infinity;
  if (!member?.roles) return null;
  return highestRolePosition(member, ownerId, roles);
}

/**
 * Whether a viewer of rank `viewerRank` may write `role`'s channel
 * overrides: the server refuses every override write on a role at or above
 * the viewer's highest one (the owner stands above every role), and never
 * on @everyone. An unknown rank (null) restricts nothing: the server still
 * decides.
 */
export function mayEditRoleOverrides(viewerRank: number | null, role: Pick<Role, 'position' | 'isDefault'>): boolean {
  return viewerRank === null || role.isDefault || role.position < viewerRank;
}

/**
 * Whether a viewer of rank `viewerRank` may edit or delete `role` itself:
 * the server refuses a role save and a role delete on a role at or above the
 * viewer's highest one, with no exemption for @everyone (a manager with no
 * role is refused on it). An unknown rank (null) restricts nothing.
 */
export function mayEditRole(viewerRank: number | null, role: Pick<Role, 'position'>): boolean {
  return viewerRank === null || role.position < viewerRank;
}

/**
 * Whether a viewer of rank `viewerRank` may create a role: the server places
 * a new role one position below its creator's highest one, beside any role
 * already there, and moves no existing role (the owner's goes on top); it
 * refuses a creator whose highest position is 0 (rank 0: no role, or only
 * roles at 0), who has no position below their own. An unknown rank (null)
 * restricts nothing.
 */
export function mayCreateRole(viewerRank: number | null): boolean {
  return viewerRank === null || viewerRank >= 1;
}
