import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AdminServer } from '@voxium/shared';

/**
 * Server-list state for directory curation: the "listed only" filter reaches
 * the API as `listed=1`, and a curation PATCH updates the loaded row in place.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/socket', () => ({ getSocket: () => null, onSocketReconnect: () => () => {} }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useAdminStore } from '../../stores/adminStore';

function server(over: Partial<AdminServer>): AdminServer {
  return {
    id: 'srv', name: 'Server', iconUrl: null, ownerId: 'o', ownerUsername: 'owner', memberCount: 3, channelCount: 2, messageCount: 10,
    createdAt: '2026-10-01T00:00:00.000Z', description: null, tags: [], discoverable: true, discoveryListed: true, joinMode: 'approval',
    featuredAt: null, discoveryBlockedAt: null, invitesLocked: false, ownerBannedAt: null, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdminStore.setState({ servers: [], serversTotal: 0, serversPage: 1, serversSearch: '', serversListedOnly: false });
  api.get.mockResolvedValue({ data: { data: [], total: 0 } });
});

describe('adminStore — servers and directory curation', () => {
  it('fetchServers sends listed=1 only while the filter is on', async () => {
    api.get.mockResolvedValue({ data: { data: [server({ id: 'x' })], total: 20 } });
    await useAdminStore.getState().fetchServers(2);
    expect(api.get).toHaveBeenLastCalledWith('/admin/servers', { params: { page: 2, limit: 12, search: '' } });

    useAdminStore.getState().setServersListedOnly(true);
    useAdminStore.getState().setServersSearch('raid');
    await useAdminStore.getState().fetchServers(1);
    expect(api.get).toHaveBeenLastCalledWith('/admin/servers', { params: { page: 1, limit: 12, search: 'raid', listed: '1' } });

    useAdminStore.getState().setServersListedOnly(false);
    await useAdminStore.getState().fetchServers();
    expect(api.get).toHaveBeenLastCalledWith('/admin/servers', { params: { page: 1, limit: 12, search: 'raid' } });
  });

  it('a slower earlier fetch never paints over a newer one (Search vs "Listed only" overlap)', async () => {
    let resolveFirst!: (v: unknown) => void;
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const first = useAdminStore.getState().fetchServers(1);
    useAdminStore.getState().setServersListedOnly(true);
    api.get.mockResolvedValueOnce({ data: { data: [server({ id: 'listed-only' })], total: 1 } });
    await useAdminStore.getState().fetchServers(1);
    expect(useAdminStore.getState().servers.map((s) => s.id)).toEqual(['listed-only']);
    expect(useAdminStore.getState().loading).toBe(false);

    resolveFirst({ data: { data: [server({ id: 'stale' })], total: 5 } });
    await first;
    expect(useAdminStore.getState().servers.map((s) => s.id)).toEqual(['listed-only']);
    expect(useAdminStore.getState().serversTotal).toBe(1);
    expect(useAdminStore.getState().loading).toBe(false);
  });

  it('a refetch that lands past the end shows the last page that still has rows', async () => {
    useAdminStore.setState({ serversPage: 3 });
    api.get
      .mockResolvedValueOnce({ data: { data: [], total: 13 } })
      .mockResolvedValueOnce({ data: { data: [server({ id: 'p2' })], total: 13 } });
    await useAdminStore.getState().fetchServers();
    expect(api.get).toHaveBeenNthCalledWith(1, '/admin/servers', { params: { page: 3, limit: 12, search: '' } });
    expect(api.get).toHaveBeenNthCalledWith(2, '/admin/servers', { params: { page: 2, limit: 12, search: '' } });
    expect(useAdminStore.getState().serversPage).toBe(2);
    expect(useAdminStore.getState().servers.map((s) => s.id)).toEqual(['p2']);
    expect(useAdminStore.getState().loading).toBe(false);

    // an empty FIRST page is simply empty
    api.get.mockResolvedValueOnce({ data: { data: [], total: 0 } });
    await useAdminStore.getState().fetchServers(1);
    expect(useAdminStore.getState().servers).toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('setServerDiscovery PATCHes and patches the loaded row in place, leaving the others alone', async () => {
    useAdminStore.setState({ servers: [server({ id: 'a' }), server({ id: 'b' })] });
    const answer = { id: 'a', discoverable: true, discoveryListed: true, featuredAt: '2026-10-11T00:00:00.000Z', discoveryBlockedAt: null };
    api.patch.mockResolvedValue({ data: { success: true, data: answer } });

    const result = await useAdminStore.getState().setServerDiscovery('a', { featured: true });

    expect(api.patch).toHaveBeenCalledWith('/admin/servers/a/discovery', { featured: true });
    expect(result).toEqual(answer);
    const [a, b] = useAdminStore.getState().servers;
    expect(a.featuredAt).toBe('2026-10-11T00:00:00.000Z');
    expect(a.name).toBe('Server'); // the rest of the row survives
    expect(b.featuredAt).toBeNull();
    // no refetch: the list is patched, not reloaded
    expect(api.get).not.toHaveBeenCalled();
  });

  it('setServerDiscovery leaves the list untouched when the server is not loaded, and rethrows a refusal', async () => {
    useAdminStore.setState({ servers: [server({ id: 'a' })] });
    api.patch.mockResolvedValue({ data: { success: true, data: { id: 'zzz', discoverable: false, discoveryListed: false, featuredAt: null, discoveryBlockedAt: 'now' } } });
    await useAdminStore.getState().setServerDiscovery('zzz', { blocked: true });
    expect(useAdminStore.getState().servers[0].discoveryBlockedAt).toBeNull();

    api.patch.mockRejectedValueOnce(new Error('400'));
    await expect(useAdminStore.getState().setServerDiscovery('a', { featured: true })).rejects.toThrow('400');
  });

  it('fetchUserOwnedServers returns the rows with their directory state', async () => {
    const rows = [{ id: 's-1', name: 'Raid Night', iconUrl: null, memberCount: 2, members: [], description: 'EU', tags: ['gaming'], discoverable: true, discoveryListed: true, joinMode: 'open', featuredAt: null, discoveryBlockedAt: null, invitesLocked: false }];
    api.get.mockResolvedValueOnce({ data: { success: true, data: rows } });
    await expect(useAdminStore.getState().fetchUserOwnedServers('u-1')).resolves.toEqual(rows);
    expect(api.get).toHaveBeenCalledWith('/admin/users/u-1/owned-servers');
  });
});
