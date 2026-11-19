import { ALL_PERMISSIONS, hasPermission } from '@voxium/shared';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useServerPermissions } from './useServerPermissions';

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
