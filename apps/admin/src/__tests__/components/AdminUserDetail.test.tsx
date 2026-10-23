import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OwnedServerInfo } from '../../stores/adminStore';

/**
 * The owned-servers panel of the user detail: what each server the user
 * owns shows in Explore (description, tags) and whether it is there.
 */

const store = vi.hoisted(() => ({
  selectedUser: null as Record<string, unknown> | null,
  fetchUserDetail: vi.fn(),
  fetchUserOwnedServers: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUserRole: vi.fn(),
  toggleSupporter: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } }) => unknown) => selector({ user: { role: 'admin' } }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminUserDetail } from '../../components/AdminUserDetail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = {
  id: 'u-1', username: 'owner1', displayName: 'Owner One', email: 'o@example.com', role: 'user', status: 'offline',
  createdAt: '2026-10-01T00:00:00.000Z', emailVerified: true, emailVerifiedAt: null, bannedAt: null, banReason: null,
  isSupporter: false, supporterTier: null, _count: { messages: 0, memberships: 2, ownedServers: 2 }, ipRecords: [],
};
function owned(over: Partial<OwnedServerInfo>): OwnedServerInfo {
  return {
    id: 's', name: 'Server', iconUrl: null, memberCount: 1, members: [], description: null, tags: [], discoverable: true,
    discoveryListed: true, joinMode: 'approval', featuredAt: null, discoveryBlockedAt: null, invitesLocked: false, ownerBannedAt: null, ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];

async function render() {
  await act(async () => { root.render(<AdminUserDetail userId="u-1" onBack={() => {}} />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.selectedUser = USER;
  store.fetchUserOwnedServers.mockResolvedValue([
    owned({ id: 's-1', name: 'Raid Night', memberCount: 12, description: 'EU evenings, no drama.', tags: ['gaming', 'esports'], joinMode: 'open' }),
    owned({ id: 's-2', name: 'Quiet Corner', memberCount: 1, discoverable: false, discoveryListed: false }),
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminUserDetail — owned servers', () => {
  it('lists each owned server with its member count, directory chips, description and tags', async () => {
    await render();
    expect(store.fetchUserOwnedServers).toHaveBeenCalledWith('u-1');
    expect(q('[data-testid="owned-servers-panel"]')).not.toBeNull();
    const rows = qa('[data-testid="owned-server-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Raid Night');
    expect(rows[0].textContent).toContain('12 members');
    expect(rows[0].querySelector('[data-testid="directory-chip-listed"]')).not.toBeNull();
    expect(rows[0].querySelector('[data-testid="directory-join-mode"]')!.textContent).toBe('open join');
    expect(rows[0].querySelector('[data-testid="owned-server-description"]')!.textContent).toBe('EU evenings, no drama.');
    expect(rows[0].querySelector('[data-testid="owned-server-tags"]')!.textContent).toBe('gamingesports');

    expect(rows[1].textContent).toContain('1 member');
    expect(rows[1].querySelector('[data-testid="directory-chip-hidden"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-testid="owned-server-description"]')!.textContent).toBe('No description');
    expect(rows[1].querySelector('[data-testid="owned-server-tags"]')).toBeNull();
  });

  it('reloads the panel after a ban and after an unban (the owner ban is a listing input)', async () => {
    store.banUser.mockResolvedValue(undefined);
    store.unbanUser.mockResolvedValue(undefined);
    await render();
    expect(store.fetchUserOwnedServers).toHaveBeenCalledTimes(1);
    const buttonByText = (text: string) => qa('button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
    await act(async () => { buttonByText('Ban User').click(); });
    store.fetchUserOwnedServers.mockResolvedValue([owned({ id: 's-1', name: 'Raid Night', discoveryListed: false, ownerBannedAt: '2026-10-11T00:00:00.000Z' })]);
    await act(async () => { buttonByText('Ban').click(); });
    expect(store.banUser).toHaveBeenCalledWith('u-1', undefined, false);
    expect(store.fetchUserOwnedServers).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="directory-chip-hidden-owner-banned"]')).not.toBeNull();

    store.selectedUser = { ...USER, bannedAt: '2026-10-11T00:00:00.000Z' };
    await act(async () => { root.render(<AdminUserDetail userId="u-1" onBack={() => {}} />); });
    await act(async () => { buttonByText('Unban').click(); });
    store.fetchUserOwnedServers.mockResolvedValue([owned({ id: 's-1', name: 'Raid Night' })]);
    await act(async () => { qa('.fixed button').find((b) => b.textContent?.trim() === 'Unban')!.click(); });
    expect(store.unbanUser).toHaveBeenCalledWith('u-1');
    expect(store.fetchUserOwnedServers).toHaveBeenCalledTimes(3);
    expect(q('[data-testid="directory-chip-listed"]')).not.toBeNull();
  });

  it('shows no panel when the user owns nothing', async () => {
    store.fetchUserOwnedServers.mockResolvedValue([]);
    await render();
    expect(q('[data-testid="owned-servers-panel"]')).toBeNull();
  });

  it('a failed load is reported, not swallowed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.fetchUserOwnedServers.mockRejectedValue(new Error('boom'));
    await render();
    expect(toast.error).toHaveBeenCalledWith('Failed to load owned servers');
    // the message only, never the error object (an axios one carries the request headers)
    expect(spy).toHaveBeenCalledWith('Failed to load owned servers:', 'boom');
    expect(q('[data-testid="owned-servers-panel"]')).toBeNull();
    spy.mockRestore();
  });
});
