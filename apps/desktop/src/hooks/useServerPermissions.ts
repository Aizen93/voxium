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
  const scope = serverId && userId ? `${userId}|${serverId}` : null;
  const key = scope ? `${scope}|${fingerprint}` : null;

  // The answer, tagged with the key it is for and the account+server it
  // belongs to. A different SERVER or ACCOUNT never sees it; a different
  // FINGERPRINT (a live role edit) keeps it in force while the refetch is in
  // flight: answering null for that one render would close every surface the
  // bits gate (the Integrations tab, with the copy-once token it may be
  // showing) although the viewer may well still hold the bit. A revoked bit
  // still closes them: the fresh answer lands within a round trip.
  const [answer, setAnswer] = useState<{ key: string; scope: string; bits: string } | null>(null);

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
        if (!cancelled) setAnswer({ key, scope: scope!, bits });
      })
      .catch((err) => {
        console.warn('[Permissions] Failed to fetch effective permissions:', err instanceof Error ? err.message : err);
      });
    return () => { cancelled = true; };
  }, [key, serverId, fetchEffectivePermissions]);

  if (!key || !scope) return null;
  const cached = cache.get(key);
  if (cached !== undefined) return permissionsFromString(cached);
  // A cache miss with a previous answer for the SAME account and server: the
  // fingerprint changed, the refetch is in flight; keep the last bits meanwhile
  if (answer && answer.scope === scope) return permissionsFromString(answer.bits);
  return null;
}
