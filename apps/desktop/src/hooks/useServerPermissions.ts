import { useEffect, useMemo, useState } from 'react';
import { permissionsFromString } from '@voxium/shared';
import type { Role, ServerMember } from '@voxium/shared';
import { useServerStore } from '../stores/serverStore';

/**
 * The viewer's effective SERVER permissions on the active server
 * (`GET /servers/:id/roles/permissions/effective`), or null until known.
 *
 * Custom roles carry permission bits the legacy `member.role` field knows
 * nothing about (a moderator with MANAGE_MESSAGES through a role is a plain
 * "member" there), so a UI gate on a bit must ask the server. Cached per
 * account, server and permission fingerprint: switching channels costs
 * nothing, and a live role edit (which changes the fingerprint) refetches.
 */

const cache = new Map<string, string>();
const CACHE_MAX = 64;

/** Forget every cached answer (logout: they are the leaving account's). */
export function resetServerPermissionsCache(): void {
  cache.clear();
}

/**
 * Everything that can change a member's effective server permissions: the
 * legacy role, the assigned role ids, and those roles' (and @everyone's)
 * bitmasks.
 */
export function permissionsFingerprint(member: Pick<ServerMember, 'role' | 'roles'> | undefined, roles: Role[]): string {
  const assigned = new Set((member?.roles ?? []).map((r) => r.id));
  const bits = roles
    .filter((r) => r.isDefault || assigned.has(r.id))
    .map((r) => `${r.id}:${r.permissions}`)
    .sort()
    .join('|');
  return `${member?.role ?? ''}|${bits}`;
}

export function useServerPermissions(serverId: string | null | undefined, userId: string | undefined): bigint | null {
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const fetchEffectivePermissions = useServerStore((s) => s.fetchEffectivePermissions);
  const member = userId ? members.find((m) => m.userId === userId) : undefined;
  const fingerprint = useMemo(() => permissionsFingerprint(member, roles), [member, roles]);
  const key = serverId && userId ? `${userId}|${serverId}|${fingerprint}` : null;

  // The answer, tagged with the key it is for: a stale one never applies to
  // another server or another set of roles
  const [answer, setAnswer] = useState<{ key: string; bits: string } | null>(null);

  useEffect(() => {
    if (!key || !serverId) return;
    if (cache.has(key)) return;
    let cancelled = false;
    fetchEffectivePermissions(serverId)
      .then((bits) => {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, bits);
        if (!cancelled) setAnswer({ key, bits });
      })
      .catch((err) => {
        console.warn('[Permissions] Failed to fetch effective permissions:', err instanceof Error ? err.message : err);
      });
    return () => { cancelled = true; };
  }, [key, serverId, fetchEffectivePermissions]);

  if (!key) return null;
  const bits = cache.get(key) ?? (answer?.key === key ? answer.bits : undefined);
  return bits === undefined ? null : permissionsFromString(bits);
}
