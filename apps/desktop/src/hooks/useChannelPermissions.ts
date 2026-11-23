import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { onSocketReconnect } from '../services/socket';
import { ALL_PERMISSIONS, permissionsFromString } from '@voxium/shared';
import { useServerStore } from '../stores/serverStore';
import { isSecureChannelId } from '../utils/secureChannelGate';
import { PERMISSIONS_RETRY_DELAY_MS, permissionsFingerprint } from './useServerPermissions';
import {
  cachedChannelPermissions,
  channelPermissionsGeneration,
  dropChannelPermissionsKey,
  loadChannelPermissions,
  subscribeChannelPermissions,
} from '../services/channelPermissionsCache';

/**
 * The viewer's effective permissions in ONE channel of a space
 * (`GET /servers/:id/roles/permissions/effective?channelId=`), or null until
 * known. The server judges sending, attaching, pinging everyone and moderating
 * messages per channel, and a channel override can move each bit either way,
 * so a control on one of them asks for the CHANNEL's bits, not the space's
 * (hooks/useServerPermissions).
 *
 * The same rules as the space hook: the owner holds every bit at once without
 * a request; a failed fetch drops the answer kept so far, is tried once more
 * after PERMISSIONS_RETRY_DELAY_MS and again on a socket reconnect. A role or
 * membership change reaches the key through the fingerprint; an override
 * write, which the store does not hold, through the generation
 * (`invalidateChannelPermissions`, on `channel:permissions_updated`). The
 * cache and the request in flight are shared by every component asking.
 *
 * A SECURE channel is never asked: its permissions come from membership, the
 * answer is null there, and its controls follow their own rules.
 *
 * What an unknown answer means is the caller's: a control that only prevents a
 * refusal stays usable, one that offers a power stays hidden.
 */
export function useChannelPermissions(
  serverId: string | null | undefined,
  channelId: string | null | undefined,
  userId: string | undefined,
): bigint | null {
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const fetchEffectivePermissions = useServerStore((s) => s.fetchEffectivePermissions);
  const isOwner = useServerStore((s) => !!userId && s.servers.find((sv) => sv.id === serverId)?.ownerId === userId);
  const secure = useServerStore((s) => isSecureChannelId(channelId, s.channels));
  // The channel record must belong to THIS space. A space switch sets the new
  // space first while the channel list is still the old space's, and a channel
  // not in the store yet (just created, a deep link) is not known to be here:
  // no key, no request, until the record is.
  const inSpace = useServerStore((s) => s.channels.some((c) => c.id === channelId && c.serverId === serverId));
  const member = userId ? members.find((m) => m.userId === userId) : undefined;
  const fingerprint = useMemo(() => permissionsFingerprint(member, roles), [member, roles]);
  const generation = useSyncExternalStore(
    subscribeChannelPermissions,
    () => channelPermissionsGeneration(serverId),
  );
  const scope = serverId && channelId && userId ? `${userId}|${serverId}|${channelId}` : null;
  const key = scope && !secure && inSpace ? `${scope}|${generation}|${fingerprint}` : null;

  // Bumped when a request this instance asked for settles, so the component
  // renders and reads the cache, or after a failure shows nothing. A counter:
  // a value could equal the one before it and the render would be skipped,
  // leaving on screen what the failure was meant to clear
  const [, settled] = useReducer((n: number) => n + 1, 0);
  // What this instance last returned, whoever fetched it: kept in force while
  // a refetch under a new key (a role edit, a reconnect) is in flight, so an
  // instance that read the cache shows the same as the one that fetched
  const shown = useRef<{ scope: string; bits: string } | null>(null);
  // Bumped to ask the fetch effect to run again for the same key (a reconnect)
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!key || !scope || !serverId || !channelId) return;
    // The owner needs no answer (and loses nothing to a failed one)
    if (isOwner) return;
    if (cachedChannelPermissions(key) !== undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (isRetry: boolean) => {
      loadChannelPermissions(key, serverId, () => fetchEffectivePermissions(serverId, channelId))
        .then(() => {
          if (!cancelled) settled();
        })
        .catch((err) => {
          console.warn('[Permissions] Failed to fetch channel permissions:', err instanceof Error ? err.message : err);
          if (cancelled) return;
          shown.current = null;
          settled();
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
  }, [key, scope, serverId, channelId, fetchEffectivePermissions, isOwner, reload]);

  // After a reconnect the roles and overrides may have changed while the
  // socket was away: forget the answer and ask again
  useEffect(() => {
    if (!key) return;
    return onSocketReconnect(() => {
      dropChannelPermissionsKey(key);
      setReload((n) => n + 1);
    });
  }, [key]);

  if (!key || !scope) return null;
  if (isOwner) return ALL_PERMISSIONS;
  const cached = cachedChannelPermissions(key);
  if (cached !== undefined) {
    shown.current = { scope, bits: cached };
    return permissionsFromString(cached);
  }
  // Another channel's bits never stand in for this one
  if (shown.current && shown.current.scope === scope) return permissionsFromString(shown.current.bits);
  return null;
}
