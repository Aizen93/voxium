import { useEffect, useMemo, useState } from 'react';
import { onSocketReconnect } from '../services/socket';
import { ALL_PERMISSIONS, permissionsFromString } from '@voxium/shared';
import type { Role, ServerMember } from '@voxium/shared';
import { useServerStore } from '../stores/serverStore';

/**
 * The viewer's effective SERVER permissions on the active server
 * (`GET /servers/:id/roles/permissions/effective`), or null until known
 * (every permission at once for the space's owner, from `Server.ownerId`).
 *
 * Custom roles carry permission bits the legacy `member.role` field knows
 * nothing about (a moderator with MANAGE_MESSAGES through a role is a plain
 * "member" there), so a UI gate on a bit must ask the server. Cached per
 * account, server and permission fingerprint: switching channels costs
 * nothing, and a live role edit (which changes the fingerprint) refetches.
 */

const cache = new Map<string, string>();
const CACHE_MAX = 64;

/** How long a failed fetch waits before its one retry. */
export const PERMISSIONS_RETRY_DELAY_MS = 3000;

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
  // The space's owner holds every permission, as the server computes it
  // (computeServerPermissions): the owner needs neither to wait for the
  // answer nor to lose their controls to a failed fetch
  const isOwner = useServerStore((s) => !!userId && s.servers.find((sv) => sv.id === serverId)?.ownerId === userId);
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

  // Bumped to ask the fetch effect to run again for the same key (a reconnect)
  const [reload, setReload] = useState(0);

  // A failed fetch drops the answer kept for the same account and space: the
  // server may have taken that bit back, so a control that needs it hides
  // rather than stay on a stale yes. It is tried once more after a short
  // delay; a reconnect (below) asks again too.
  useEffect(() => {
    if (!key || !serverId) return;
    if (cache.has(key)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (isRetry: boolean) => {
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
          if (cancelled) return;
          setAnswer(null);
          if (!isRetry) {
            timer = setTimeout(() => { timer = undefined; run(true); }, PERMISSIONS_RETRY_DELAY_MS);
          }
        });
    };
    run(false);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, serverId, fetchEffectivePermissions, reload]);

  // After a reconnect the roles may have changed while the socket was away:
  // forget the cached answer and ask again
  useEffect(() => {
    if (!key) return;
    return onSocketReconnect(() => {
      cache.delete(key);
      setReload((n) => n + 1);
    });
  }, [key]);

  if (!key || !scope) return null;
  if (isOwner) return ALL_PERMISSIONS;
  const cached = cache.get(key);
  if (cached !== undefined) return permissionsFromString(cached);
  // A cache miss with a previous answer for the SAME account and server: the
  // fingerprint changed, the refetch is in flight; keep the last bits meanwhile
  if (answer && answer.scope === scope) return permissionsFromString(answer.bits);
  return null;
}
