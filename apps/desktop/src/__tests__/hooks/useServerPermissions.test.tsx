import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Role, ServerMember } from '@voxium/shared';

/**
 * The viewer's effective permissions. An answer the server may have taken
 * back is never kept: a failed refetch drops it (controls that need the bits
 * hide), is tried once more after PERMISSIONS_RETRY_DELAY_MS, and a socket
 * reconnect asks again. The space's owner holds every bit regardless.
 */

const S = vi.hoisted(() => ({ fetchEffectivePermissions: vi.fn() }));
let members: ServerMember[] = [];
let roles: Role[] = [];
let servers: { id: string; ownerId: string }[] = [];
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, roles, servers, ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});

const sock = vi.hoisted(() => ({ callbacks: new Set<() => void>(), unsubscribed: 0 }));
vi.mock('../../services/socket', () => ({
  onSocketReconnect: (cb: () => void) => {
    sock.callbacks.add(cb);
    return () => { sock.callbacks.delete(cb); sock.unsubscribed++; };
  },
}));

import { PERMISSIONS_RETRY_DELAY_MS, resetServerPermissionsCache, useServerPermissions } from '../../hooks/useServerPermissions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const role = (permissions: bigint): Role =>
  ({ id: 'r1', serverId: 'srv', name: 'r1', color: null, position: 1, permissions: permissions.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' });
const me = (assigned: Role[]): ServerMember =>
  ({ userId: 'me', serverId: 'srv', role: 'member', nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: assigned,
    user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } } as unknown as ServerMember);

let container: HTMLDivElement;
let root: Root;
let seen: bigint | null = null;

function Probe() {
  seen = useServerPermissions('srv', 'me');
  return null;
}
async function settle() { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }
async function render() {
  await act(async () => { root.render(<Probe />); });
  await settle();
}
function grant(bits: bigint) {
  const r = role(bits);
  roles = [r];
  members = [me([r])];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetServerPermissionsCache();
  sock.callbacks.clear();
  sock.unsubscribed = 0;
  seen = null;
  servers = [{ id: 'srv', ownerId: 'someone-else' }];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useServerPermissions', () => {
  it('a granted bit shows; a role edit that revokes it while the refetch FAILS leaves no stale yes', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockResolvedValue(Permissions.KICK_MEMBERS.toString());
    await render();
    expect(seen).toBe(Permissions.KICK_MEMBERS);

    // The role loses the bit; the new fingerprint's fetch is refused
    grant(0n);
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await render();
    expect(seen).toBeNull();
  });

  it('a failed fetch is tried ONCE more after the delay, and a good answer then lands', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Permissions.KICK_MEMBERS.toString());
    await render();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(seen).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS - 1); });
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen).toBe(Permissions.KICK_MEMBERS);
  });

  it('when the retry fails too there is no third try', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS * 5); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen).toBeNull();
  });

  it('a socket reconnect asks again, and the new answer replaces the cached one', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockResolvedValue(Permissions.KICK_MEMBERS.toString());
    await render();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(sock.callbacks.size).toBe(1);

    S.fetchEffectivePermissions.mockResolvedValue(Permissions.MANAGE_ROLES.toString());
    await act(async () => { sock.callbacks.forEach((cb) => cb()); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen).toBe(Permissions.MANAGE_ROLES);
  });

  it('a reconnect whose refetch fails drops the answer too', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockResolvedValue(Permissions.KICK_MEMBERS.toString());
    await render();
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await act(async () => { sock.callbacks.forEach((cb) => cb()); });
    await settle();
    expect(seen).toBeNull();
  });

  it('unmounting cancels the pending retry and unsubscribes from the reconnect', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await render();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(sock.unsubscribed).toBeGreaterThan(0);
    expect(sock.callbacks.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS * 3); });
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it('a change of the inputs cancels the retry of the old ones', async () => {
    grant(Permissions.KICK_MEMBERS);
    S.fetchEffectivePermissions.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Permissions.MANAGE_ROLES.toString());
    await render();
    grant(Permissions.MANAGE_ROLES); // a new fingerprint: fetched at once
    await render();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS * 3); });
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen).toBe(Permissions.MANAGE_ROLES);
  });

  it('the owner of the space holds every bit at once and through every failure', async () => {
    servers = [{ id: 'srv', ownerId: 'me' }];
    grant(0n);
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await render();
    expect(seen).toBe(ALL_PERMISSIONS);
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS * 2); });
    expect(seen).toBe(ALL_PERMISSIONS);
  });

  it('an ex-owner does not keep every bit: once the space says someone else owns it, the answer of the server rules', async () => {
    servers = [{ id: 'srv', ownerId: 'me' }];
    grant(0n);
    S.fetchEffectivePermissions.mockResolvedValue('0');
    await render();
    expect(seen).toBe(ALL_PERMISSIONS);
    servers = [{ id: 'srv', ownerId: 'new-owner' }];
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    members = [{ ...me([role(0n)]), role: 'member' }];
    await render();
    expect(seen).not.toBe(ALL_PERMISSIONS);
  });
});
