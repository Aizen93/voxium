import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Server, ServerMember } from '@voxium/shared';

/**
 * Server settings: which tabs a viewer gets is decided by their EFFECTIVE
 * permissions (owner short-circuits), and the Members tab badge must show
 * the pending join-request count on open — the count is only known once the
 * list is fetched, and the fetch must not wait for the tab to be visited.
 * Runs the REAL serverStore over a mocked API so the badge follows the fetch.
 */

const t = (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }), Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey };
});
vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } }));
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me', username: 'me', displayName: 'Me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
// Children with their own fetches or heavy deps are stubbed: this test is
// about the modal's gating and badge.
vi.mock('../../components/common/ImageUploadButton', () => ({ ImageUploadButton: () => null }));
vi.mock('../../components/server/RoleEditor', () => ({ RoleEditor: () => null }));
vi.mock('../../components/server/DiscoveryTab', () => ({ DiscoveryTab: () => <div data-testid="discovery-tab" /> }));
vi.mock('../../components/server/JoinRequestsSection', () => ({ JoinRequestsSection: () => <div data-testid="join-requests" /> }));
vi.mock('../../components/server/BannedSection', () => ({ BannedSection: () => <div data-testid="banned-section" /> }));

import { api } from '../../services/api';
import { useServerStore } from '../../stores/serverStore';
import { ServerSettingsModal } from '../../components/server/ServerSettingsModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGet = api.get as unknown as Mock;

const server = (ownerId: string): Server => ({
  id: 'srv-1', name: 'Makhtofi Raiders', iconUrl: null, invitesLocked: false, ownerId, createdAt: '2026-01-01T00:00:00.000Z',
  description: null, tags: [], discoverable: true, joinMode: 'approval',
});
const member = (userId: string, role: ServerMember['role']): ServerMember =>
  ({ userId, serverId: 'srv-1', role, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id: userId, username: userId, displayName: userId, avatarUrl: null } } as unknown as ServerMember);
const request = { id: 'r-1', serverId: 'srv-1', userId: 'u-2', message: null, status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: { id: 'u-2', username: 'bob', displayName: 'Bob', avatarUrl: null } };

/** The API as the modal sees it: effective permissions + the join-request list. */
function apiWith(permissions: bigint | Error, pending = 3) {
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/roles/permissions/effective')) {
      return permissions instanceof Error ? Promise.reject(permissions) : Promise.resolve({ data: { data: { permissions: permissions.toString() } } });
    }
    if (url.endsWith('/join-requests')) {
      return Promise.resolve({ data: { data: pending ? [request] : [], total: pending, hasMore: false } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}
const joinRequestCalls = () => mockGet.mock.calls.filter(([url]) => String(url).endsWith('/join-requests')).length;

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;

async function render() {
  await act(async () => { root.render(<ServerSettingsModal serverId="srv-1" onClose={() => {}} />); });
  // permissions resolve → effect fetches the list → store update → badge
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({
    servers: [server('owner-1')], members: [member('owner-1', 'owner'), member('me', 'member')], roles: [],
    joinRequestCounts: {}, joinRequests: [], joinRequestsServerId: null, bans: [], bansServerId: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ServerSettingsModal — gating and the Members badge', () => {
  it('a role-only moderator (KICK_MEMBERS): no Discovery tab, the join requests are fetched on open, the badge shows the total', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.KICK_MEMBERS, 3);
    await render();
    expect(q('[data-testid="tab-discovery"]')).toBeNull();
    expect(joinRequestCalls()).toBe(1);
    const badge = q('[data-testid="members-tab-badge"]')!;
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('server.joinRequests.pending:3');
  });

  it('MANAGE_SERVER alone: the Discovery tab shows, nothing is fetched for the badge and none is rendered', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_SERVER, 3);
    await render();
    expect(q('[data-testid="tab-discovery"]')).not.toBeNull();
    expect(joinRequestCalls()).toBe(0);
    expect(q('[data-testid="members-tab-badge"]')).toBeNull();
  });

  it('the owner gets both without a permission bit, and no badge when nothing is pending', async () => {
    useServerStore.setState({ servers: [server('me')], members: [member('me', 'owner')] });
    apiWith(Permissions.VIEW_CHANNEL, 0);
    await render();
    expect(q('[data-testid="tab-discovery"]')).not.toBeNull();
    expect(joinRequestCalls()).toBe(1);
    expect(q('[data-testid="members-tab-badge"]')).toBeNull();
  });

  it('a failed permission fetch leaves a plain member with neither, logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiWith(new Error('network'), 3);
    await render();
    expect(q('[data-testid="tab-discovery"]')).toBeNull();
    expect(q('[data-testid="members-tab-badge"]')).toBeNull();
    expect(joinRequestCalls()).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed join-request fetch leaves the modal usable (logged)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockImplementation((url: string) =>
      url.includes('/roles/permissions/effective')
        ? Promise.resolve({ data: { data: { permissions: Permissions.KICK_MEMBERS.toString() } } })
        : Promise.reject(new Error('boom')));
    await render();
    expect(q('[data-testid="members-tab-badge"]')).toBeNull();
    expect(container.textContent).toContain('serverSettings.tabs.members');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
