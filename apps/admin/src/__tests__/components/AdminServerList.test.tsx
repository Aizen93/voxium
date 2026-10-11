import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AxiosError } from 'axios';
import type { AdminServer } from '@voxium/shared';

/**
 * Directory curation from the admin server list: the Directory column, the
 * "Listed only" filter, and Feature / Unfeature / Block / Unblock through the
 * confirm modal — with the server's own refusal shown when it says no.
 */

const store = vi.hoisted(() => ({
  servers: [] as AdminServer[],
  serversTotal: 0,
  serversPage: 1,
  serversSearch: '',
  serversListedOnly: false,
  loading: false,
  fetchServers: vi.fn(),
  setServersSearch: vi.fn(),
  setServersListedOnly: vi.fn(),
  setServerDiscovery: vi.fn(),
  deleteServer: vi.fn(),
  globalLimits: null,
  serverLimits: null,
  serverLimitsServerId: null,
  fetchGlobalLimits: vi.fn(),
  updateGlobalLimits: vi.fn(),
  fetchServerLimits: vi.fn(),
  updateServerLimits: vi.fn(),
  resetServerLimits: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminServerList } from '../../components/AdminServerList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function server(over: Partial<AdminServer>): AdminServer {
  return {
    id: 'srv', name: 'Server', iconUrl: null, ownerId: 'o', ownerUsername: 'owner', memberCount: 3, channelCount: 2, messageCount: 10,
    createdAt: '2026-10-01T00:00:00.000Z', description: null, tags: [], discoverable: true, discoveryListed: true, joinMode: 'approval',
    featuredAt: null, discoveryBlockedAt: null, invitesLocked: false, ...over,
  };
}
const LISTED = server({ id: 'listed', name: 'Raid Night', joinMode: 'open' });
const FEATURED = server({ id: 'featured', name: 'Lingua Lounge', featuredAt: '2026-10-10T00:00:00.000Z' });
const BLOCKED = server({ id: 'blocked', name: 'Spam Hub', discoverable: false, discoveryListed: false, discoveryBlockedAt: '2026-10-10T00:00:00.000Z' });
const LOCKED = server({ id: 'locked', name: 'Private Club', discoveryListed: false, invitesLocked: true });

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const rowOf = (id: string) => qa('tbody tr').find((tr) => tr.textContent?.includes(store.servers.find((s) => s.id === id)!.name))!;
const buttonByText = (text: string) => qa('button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

async function render() {
  await act(async () => { root.render(<AdminServerList />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.servers = [LISTED, FEATURED, BLOCKED, LOCKED];
  store.serversTotal = 4;
  store.serversListedOnly = false;
  store.setServerDiscovery.mockResolvedValue({ id: 'x', discoverable: true, discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminServerList — directory column and curation', () => {
  it('shows a Directory column with the chips and join mode of every row', async () => {
    await render();
    expect(store.fetchServers).toHaveBeenCalledWith(1);
    expect(rowOf('listed').querySelector('[data-testid="directory-chip-listed"]')).not.toBeNull();
    expect(rowOf('listed').querySelector('[data-testid="directory-join-mode"]')!.textContent).toBe('open join');
    expect(rowOf('featured').querySelector('[data-testid="directory-chip-featured"]')).not.toBeNull();
    expect(rowOf('blocked').querySelector('[data-testid="directory-chip-blocked"]')).not.toBeNull();
    expect(rowOf('locked').querySelector('[data-testid="directory-chip-hidden-invites-locked"]')).not.toBeNull();
  });

  it('Feature is only offered on a listed server; the disabled button says why', async () => {
    await render();
    const onListed = rowOf('listed').querySelector('[data-testid="server-feature"]') as HTMLButtonElement;
    expect(onListed.disabled).toBe(false);
    expect(onListed.title).toBe('Feature in Explore');
    const onLocked = rowOf('locked').querySelector('[data-testid="server-feature"]') as HTMLButtonElement;
    expect(onLocked.disabled).toBe(true);
    expect(onLocked.title).toBe('Only listed servers can be featured');
    // a blocked server cannot be featured either (it is not listed)
    expect((rowOf('blocked').querySelector('[data-testid="server-feature"]') as HTMLButtonElement).disabled).toBe(true);
    // a featured server offers Unfeature instead
    expect(rowOf('featured').querySelector('[data-testid="server-unfeature"]')).not.toBeNull();
    expect(rowOf('featured').querySelector('[data-testid="server-feature"]')).toBeNull();
  });

  it('Feature → confirm names the server → PATCH { featured: true } → toast', async () => {
    await render();
    await act(async () => { (rowOf('listed').querySelector('[data-testid="server-feature"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('Feature in Explore');
    expect(document.body.textContent).toContain('"Raid Night"');
    await act(async () => { buttonByText('Feature').click(); });
    expect(store.setServerDiscovery).toHaveBeenCalledWith('listed', { featured: true });
    expect(toast.success).toHaveBeenCalledWith('Server featured');
    expect(buttonByText('Feature')).toBeUndefined();
    // the list is not "listed only": no refetch beyond the initial one
    expect(store.fetchServers).toHaveBeenCalledTimes(1);
  });

  it('Unfeature, Block and Unblock send their patches', async () => {
    await render();
    await act(async () => { (rowOf('featured').querySelector('[data-testid="server-unfeature"]') as HTMLButtonElement).click(); });
    await act(async () => { buttonByText('Unfeature').click(); });
    expect(store.setServerDiscovery).toHaveBeenLastCalledWith('featured', { featured: false });

    await act(async () => { (rowOf('listed').querySelector('[data-testid="server-block"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('Block from directory');
    await act(async () => { buttonByText('Block').click(); });
    expect(store.setServerDiscovery).toHaveBeenLastCalledWith('listed', { blocked: true });
    expect(toast.success).toHaveBeenLastCalledWith('Server blocked from the directory');

    await act(async () => { (rowOf('blocked').querySelector('[data-testid="server-unblock"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('does not relist by itself');
    await act(async () => { buttonByText('Unblock').click(); });
    expect(store.setServerDiscovery).toHaveBeenLastCalledWith('blocked', { blocked: false });
  });

  it('a refusal shows the server’s own reason, and the modal closes', async () => {
    store.setServerDiscovery.mockRejectedValueOnce(new AxiosError('Request failed', '400', undefined, undefined, {
      status: 400, statusText: 'Bad Request', headers: {}, config: {} as never, data: { success: false, error: 'Only listed servers can be featured' },
    }));
    await render();
    await act(async () => { (rowOf('listed').querySelector('[data-testid="server-feature"]') as HTMLButtonElement).click(); });
    await act(async () => { buttonByText('Feature').click(); });
    expect(toast.error).toHaveBeenCalledWith('Only listed servers can be featured');
    expect(toast.success).not.toHaveBeenCalled();
    expect(buttonByText('Feature')).toBeUndefined();

    // a bare failure falls back to a generic message
    store.setServerDiscovery.mockRejectedValueOnce(new Error('network'));
    await act(async () => { (rowOf('listed').querySelector('[data-testid="server-block"]') as HTMLButtonElement).click(); });
    await act(async () => { buttonByText('Block').click(); });
    expect(toast.error).toHaveBeenLastCalledWith('Failed to update the directory state');
  });

  it('"Listed only" sets the filter and refetches the first page; a curation then refetches too', async () => {
    await render();
    const box = q('[data-testid="servers-listed-only"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => { box.click(); });
    expect(store.setServersListedOnly).toHaveBeenCalledWith(true);
    expect(store.fetchServers).toHaveBeenLastCalledWith(1);

    store.serversListedOnly = true;
    await act(async () => { root.render(<AdminServerList />); });
    await act(async () => { (rowOf('listed').querySelector('[data-testid="server-block"]') as HTMLButtonElement).click(); });
    const calls = store.fetchServers.mock.calls.length;
    await act(async () => { buttonByText('Block').click(); });
    // a blocked server no longer belongs on a "listed only" page
    expect(store.fetchServers.mock.calls.length).toBe(calls + 1);
  });
});
