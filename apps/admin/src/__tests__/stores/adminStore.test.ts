import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import type { AdminServer, AdminWebhook } from '@voxium/shared';

/**
 * Server-list state for directory curation: the "listed only" filter reaches
 * the API as `listed=1`, and a curation PATCH updates the loaded row in place.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/socket', () => ({ getSocket: () => null, onSocketReconnect: () => () => {} }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useAdminStore } from '../../stores/adminStore';
import { toast } from '../../stores/toastStore';

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

describe('adminStore — server webhooks (moderation)', () => {
  const WH: AdminWebhook = {
    id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
    adminDisabledAt: null, creatorRemovedAt: null,
    createdBy: null, createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: null, lastRotatedAt: null, lastRotatedBy: null, channelName: 'general',
  };
  const refusal = (status: number, error: string) => new AxiosError('Request failed', String(status), undefined, undefined, {
    status, statusText: '', headers: {}, config: {} as never, data: { success: false, error },
  });

  beforeEach(() => {
    useAdminStore.setState({ serverWebhooks: [], serverWebhooksServerId: null, serverWebhooksLoading: false, serverWebhooksError: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('fetchServerWebhooks GETs the server list and stores it', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: [WH], total: 1 } });
    await useAdminStore.getState().fetchServerWebhooks('srv-1');
    expect(api.get).toHaveBeenCalledWith('/admin/servers/srv-1/webhooks');
    const s = useAdminStore.getState();
    expect(s.serverWebhooks).toEqual([WH]);
    expect(s.serverWebhooksServerId).toBe('srv-1');
    expect(s.serverWebhooksLoading).toBe(false);
    expect(s.serverWebhooksError).toBe(false);
  });

  it('opening another server clears the previous rows at once; a refetch of the same keeps them', async () => {
    useAdminStore.setState({ serverWebhooks: [WH], serverWebhooksServerId: 'srv-1' });
    let resolve!: (v: unknown) => void;
    api.get.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = useAdminStore.getState().fetchServerWebhooks('srv-1');
    expect(useAdminStore.getState().serverWebhooks).toEqual([WH]);
    expect(useAdminStore.getState().serverWebhooksLoading).toBe(true);
    resolve({ data: { data: [WH], total: 1 } });
    await pending;

    api.get.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const other = useAdminStore.getState().fetchServerWebhooks('srv-2');
    expect(useAdminStore.getState().serverWebhooks).toEqual([]);
    expect(useAdminStore.getState().serverWebhooksServerId).toBe('srv-2');
    resolve({ data: { data: [], total: 0 } });
    await other;
  });

  it('a slower earlier answer never paints over a newer one', async () => {
    let resolveFirst!: (v: unknown) => void;
    api.get.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const first = useAdminStore.getState().fetchServerWebhooks('srv-1');
    api.get.mockResolvedValueOnce({ data: { data: [{ ...WH, id: 'wh-new', serverId: 'srv-2' }], total: 1 } });
    await useAdminStore.getState().fetchServerWebhooks('srv-2');
    resolveFirst({ data: { data: [WH], total: 1 } });
    await first;
    expect(useAdminStore.getState().serverWebhooks.map((w) => w.id)).toEqual(['wh-new']);
    expect(useAdminStore.getState().serverWebhooksServerId).toBe('srv-2');
    expect(useAdminStore.getState().serverWebhooksLoading).toBe(false);
  });

  it('a failed fetch flags the error and toasts the server reason (or a generic one)', async () => {
    api.get.mockRejectedValueOnce(refusal(404, 'Server not found'));
    await useAdminStore.getState().fetchServerWebhooks('gone');
    expect(useAdminStore.getState().serverWebhooksError).toBe(true);
    expect(useAdminStore.getState().serverWebhooksLoading).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Server not found');

    api.get.mockRejectedValueOnce(new Error('network'));
    await useAdminStore.getState().fetchServerWebhooks('gone');
    expect(toast.error).toHaveBeenLastCalledWith('Failed to load webhooks');

    // the next success clears the flag
    api.get.mockResolvedValueOnce({ data: { data: [], total: 0 } });
    await useAdminStore.getState().fetchServerWebhooks('gone');
    expect(useAdminStore.getState().serverWebhooksError).toBe(false);
  });

  it('setServerWebhookEnabled PATCHes /admin/webhooks/:id, toasts, then refetches the open list', async () => {
    useAdminStore.setState({ serverWebhooks: [WH], serverWebhooksServerId: 'srv-1' });
    api.patch.mockResolvedValue({ data: { success: true, data: { ...WH, enabled: false } } });
    api.get.mockResolvedValue({ data: { data: [{ ...WH, enabled: false }], total: 1 } });

    await useAdminStore.getState().setServerWebhookEnabled('wh-1', false);
    expect(api.patch).toHaveBeenCalledWith('/admin/webhooks/wh-1', { enabled: false });
    expect(toast.success).toHaveBeenCalledWith('Webhook disabled');
    expect(api.get).toHaveBeenCalledWith('/admin/servers/srv-1/webhooks');
    expect(useAdminStore.getState().serverWebhooks[0].enabled).toBe(false);

    await useAdminStore.getState().setServerWebhookEnabled('wh-1', true);
    expect(api.patch).toHaveBeenLastCalledWith('/admin/webhooks/wh-1', { enabled: true });
    expect(toast.success).toHaveBeenLastCalledWith('Webhook enabled');
  });

  it('a refused toggle toasts the reason and still refetches (the row may be gone)', async () => {
    useAdminStore.setState({ serverWebhooks: [WH], serverWebhooksServerId: 'srv-1' });
    api.patch.mockRejectedValueOnce(refusal(404, 'Webhook not found'));
    api.get.mockResolvedValueOnce({ data: { data: [], total: 0 } });
    await expect(useAdminStore.getState().setServerWebhookEnabled('wh-1', false)).resolves.toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith('Webhook not found');
    expect(toast.success).not.toHaveBeenCalled();
    expect(useAdminStore.getState().serverWebhooks).toEqual([]);

    api.patch.mockRejectedValueOnce(new Error('network'));
    await useAdminStore.getState().setServerWebhookEnabled('wh-1', false);
    expect(toast.error).toHaveBeenLastCalledWith('Failed to update the webhook');
  });

  it('deleteServerWebhook sends ?purge=1 only when purging, toasts the count, refetches', async () => {
    useAdminStore.setState({ serverWebhooks: [WH], serverWebhooksServerId: 'srv-1' });
    api.delete.mockResolvedValueOnce({ data: { success: true, data: { deletedMessages: 0 } } });
    await useAdminStore.getState().deleteServerWebhook('wh-1', false);
    expect(api.delete).toHaveBeenLastCalledWith('/admin/webhooks/wh-1');
    expect(toast.success).toHaveBeenLastCalledWith('Webhook deleted');
    expect(api.get).toHaveBeenLastCalledWith('/admin/servers/srv-1/webhooks');

    api.delete.mockResolvedValueOnce({ data: { success: true, data: { deletedMessages: 3 } } });
    await useAdminStore.getState().deleteServerWebhook('wh-1', true);
    expect(api.delete).toHaveBeenLastCalledWith('/admin/webhooks/wh-1?purge=1');
    expect(toast.success).toHaveBeenLastCalledWith('Webhook deleted with 3 messages');

    api.delete.mockResolvedValueOnce({ data: { success: true, data: { deletedMessages: 1 } } });
    await useAdminStore.getState().deleteServerWebhook('wh-1', true);
    expect(toast.success).toHaveBeenLastCalledWith('Webhook deleted with 1 message');
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('a failed delete toasts the reason and refetches', async () => {
    useAdminStore.setState({ serverWebhooks: [WH], serverWebhooksServerId: 'srv-1' });
    api.delete.mockRejectedValueOnce(refusal(404, 'Webhook not found'));
    await useAdminStore.getState().deleteServerWebhook('wh-1', true);
    expect(toast.error).toHaveBeenCalledWith('Webhook not found');
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledWith('/admin/servers/srv-1/webhooks');

    api.delete.mockRejectedValueOnce(new Error('network'));
    await useAdminStore.getState().deleteServerWebhook('wh-1', false);
    expect(toast.error).toHaveBeenLastCalledWith('Failed to delete the webhook');
  });
});

describe('adminStore — a failed request logs a sentence, never the request', () => {
  // An axios error carries its request config, and the admin's token rides in
  // its headers: what reaches the console must be text, never that object.
  const config: InternalAxiosRequestConfig = { headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }) };
  const serverRefusal = () => new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', config, undefined, {
    status: 500, statusText: '', headers: {}, config, data: { success: false, error: 'Internal server error' },
  });
  const networkFailure = () => new AxiosError('Network Error', 'ERR_NETWORK', config);
  // Not an Error at all, yet holding the same config: the fallback must not print it either
  const bareObject = () => ({ config, response: { status: 500, config } });

  beforeEach(() => {
    useAdminStore.setState({ serverWebhooksServerId: null });
  });

  const SITES = [
    { label: 'Failed to fetch users:', method: 'get', run: () => useAdminStore.getState().fetchUsers(1) },
    { label: 'Failed to fetch servers:', method: 'get', run: () => useAdminStore.getState().fetchServers(1) },
    { label: 'Failed to fetch server webhooks:', method: 'get', run: () => useAdminStore.getState().fetchServerWebhooks('srv-1') },
    { label: 'Failed to update webhook:', method: 'patch', run: () => useAdminStore.getState().setServerWebhookEnabled('wh-1', false) },
    { label: 'Failed to delete webhook:', method: 'delete', run: () => useAdminStore.getState().deleteServerWebhook('wh-1', false) },
    { label: '[Admin] Failed to fetch infrastructure servers:', method: 'get', run: () => useAdminStore.getState().fetchInfraServers() },
  ] as const;

  it.each(SITES)('$label logs the reason as a string without the Bearer token', async ({ label, method, run }) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    api[method].mockRejectedValueOnce(serverRefusal());
    await run();
    expect(spy).toHaveBeenLastCalledWith(label, 'Internal server error');

    api[method].mockRejectedValueOnce(networkFailure());
    await run();
    expect(spy).toHaveBeenLastCalledWith(label, 'Network Error');

    api[method].mockRejectedValueOnce(bareObject());
    await run();
    expect(spy).toHaveBeenLastCalledWith(label, expect.any(String));

    expect(spy).toHaveBeenCalledTimes(3);
    for (const args of spy.mock.calls) {
      for (const arg of args) {
        expect(typeof arg).toBe('string');
        expect(arg).not.toContain('Bearer');
        expect(arg).not.toContain('SECRET');
      }
    }
  });
});
