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
// The Integrations tab counts its mounts: the copy-once token lives in its
// state, so a remount across a permission refetch would lose it
const tabCounts = vi.hoisted(() => ({ mount: 0, unmount: 0 }));
vi.mock('../../components/server/IntegrationsTab', async () => {
  const { useEffect } = await import('react');
  return {
    IntegrationsTab: () => {
      useEffect(() => { tabCounts.mount++; return () => { tabCounts.unmount++; }; }, []);
      return <div data-testid="integrations-tab" />;
    },
  };
});
vi.mock('../../components/server/JoinRequestsSection', () => ({ JoinRequestsSection: () => <div data-testid="join-requests" /> }));
vi.mock('../../components/server/BannedSection', () => ({ BannedSection: () => <div data-testid="banned-section" /> }));
vi.mock('../../components/server/MembersDirectory', () => ({ MembersDirectory: () => <div data-testid="members-directory" /> }));

import { api } from '../../services/api';
import { useServerStore } from '../../stores/serverStore';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';
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

const LIMITS_ANSWER = { maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 0, maxWebhooksPerServer: 0, maxSecureChannelsPerServer: 5 };

/** The API as the modal sees it: effective permissions + the join-request list (+ the Limits tab's read). */
function apiWith(permissions: bigint | Error, pending = 3) {
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/roles/permissions/effective')) {
      return permissions instanceof Error ? Promise.reject(permissions) : Promise.resolve({ data: { data: { permissions: permissions.toString() } } });
    }
    if (url.endsWith('/join-requests')) {
      return Promise.resolve({ data: { data: pending ? [request] : [], total: pending, hasMore: false } });
    }
    if (url.endsWith('/limits')) {
      return Promise.resolve({ data: { success: true, data: LIMITS_ANSWER } });
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
  tabCounts.mount = 0;
  tabCounts.unmount = 0;
  // The hook caches an answer per account, server and fingerprint: a test must never see the previous one's
  resetServerPermissionsCache();
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

  it('a role-only moderator never lands on General (a MANAGE_SERVER tab): no General tab, the modal opens on Members', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.KICK_MEMBERS, 0);
    await render();
    expect(container.textContent).not.toContain('serverSettings.tabs.general');
    expect(q('[data-testid="join-requests"]')).not.toBeNull();
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

describe('ServerSettingsModal — the Integrations tab (MANAGE_WEBHOOKS)', () => {
  /** The tab strip's labels, in order (the header's close button shares the strip's classes and has no text). */
  const tabLabels = () => [...container.querySelectorAll('.border-b.border-vox-border.px-6 > button')].map((b) => b.textContent).filter(Boolean);
  const tabButton = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const isActive = (el: Element | null | undefined) => !!el && el.className.includes('border-vox-accent-primary');

  it('a member holding only MANAGE_WEBHOOKS sees Integrations, lands on it, keeps Members and Limits, gets no General or Discovery', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS, 0);
    await render();
    expect(q('[data-testid="tab-integrations"]')).not.toBeNull();
    expect(isActive(q('[data-testid="tab-integrations"]'))).toBe(true);
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
    expect(tabLabels()).toEqual(['serverSettings.tabs.members', 'serverSettings.tabs.integrations', 'serverSettings.tabs.limits']);
    expect(q('[data-testid="tab-discovery"]')).toBeNull();
    expect(container.textContent).not.toContain('serverSettings.tabs.general');
    expect(container.textContent).not.toContain('serverSettings.tabs.roles');
    // and the read-only tabs still work from there
    await act(async () => { tabButton('serverSettings.tabs.members')!.click(); });
    expect(q('[data-testid="members-directory"]')).not.toBeNull();
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
  });

  it('MANAGE_SERVER (with webhooks) lands on General, Integrations visible after Discovery', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_SERVER | Permissions.MANAGE_WEBHOOKS, 0);
    await render();
    expect(isActive(tabButton('serverSettings.tabs.general'))).toBe(true);
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
    expect(tabLabels()).toEqual(['serverSettings.tabs.general', 'serverSettings.tabs.members', 'serverSettings.tabs.discovery', 'serverSettings.tabs.integrations', 'serverSettings.tabs.limits']);
    await act(async () => { q('[data-testid="tab-integrations"]')!.click(); });
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
  });

  it('MANAGE_SERVER alone gets no Integrations tab: the bit is its own', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_SERVER, 0);
    await render();
    expect(q('[data-testid="tab-integrations"]')).toBeNull();
  });

  it('webhooks plus moderation lands on Members (the moderation queue comes first), Integrations still one click away', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS | Permissions.KICK_MEMBERS, 0);
    await render();
    expect(q('[data-testid="join-requests"]')).not.toBeNull();
    expect(isActive(q('[data-testid="tab-integrations"]'))).toBe(false);
    expect(q('[data-testid="tab-integrations"]')).not.toBeNull();
  });

  it('webhooks plus roles lands on Members too', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS | Permissions.MANAGE_ROLES, 0);
    await render();
    expect(q('[data-testid="members-directory"]')).not.toBeNull();
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
  });

  it('a plain member sees no Integrations tab', async () => {
    apiWith(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES, 0);
    await render();
    expect(q('[data-testid="tab-integrations"]')).toBeNull();
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
  });

  it('the owner and ADMINISTRATOR get it without the bit', async () => {
    useServerStore.setState({ servers: [server('me')], members: [member('me', 'owner')] });
    apiWith(Permissions.VIEW_CHANNEL, 0);
    await render();
    expect(q('[data-testid="tab-integrations"]')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    useServerStore.setState({ servers: [server('owner-1')], members: [member('owner-1', 'owner'), member('me', 'member')] });
    apiWith(Permissions.ADMINISTRATOR, 0);
    await render();
    expect(q('[data-testid="tab-integrations"]')).not.toBeNull();
  });

  it('the Limits tab shows the webhook cap, and 0 reads as 0 (creation frozen), not "Unlimited"', async () => {
    apiWith(Permissions.VIEW_CHANNEL, 0);
    await render();
    await act(async () => { tabButton('serverSettings.tabs.limits')!.click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    const rows = [...container.querySelectorAll('.space-y-3 > div')];
    const webhookRow = rows.find((r) => r.textContent?.includes('serverSettings.limits.maxWebhooks'));
    expect(webhookRow).toBeDefined();
    expect(webhookRow!.textContent).toContain('serverSettings.limits.maxWebhooksDesc');
    expect(webhookRow!.querySelector('span')!.textContent).toBe('0');
    // secure channels have their own row, apart from the channel cap
    const secureRow = rows.find((r) => r.textContent?.includes('serverSettings.limits.maxSecureChannels'));
    expect(secureRow!.textContent).toContain('serverSettings.limits.maxSecureChannelsDesc');
    expect(secureRow!.querySelector('span')!.textContent).toBe('5');
    // the members row keeps its "Unlimited" reading of 0
    const membersRow = rows.find((r) => r.textContent?.includes('serverSettings.limits.maxMembers'));
    expect(membersRow!.querySelector('span')!.textContent).toBe('serverSettings.limits.unlimited');
  });
});

describe('ServerSettingsModal — a picked tab holds only while it is permitted', () => {
  const tabButton = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const role = (permissions: bigint) => ({
    id: 'r-1', serverId: 'srv-1', name: 'Helper', color: null, position: 1, permissions: permissions.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z',
  });
  const effectiveCalls = () => mockGet.mock.calls.filter(([url]) => String(url).includes('/roles/permissions/effective')).length;

  /** A live role edit: the viewer's role changes in the store, the server answers the new bits. */
  async function revokeTo(permissions: bigint) {
    apiWith(permissions, 0);
    await act(async () => {
      const edited = role(permissions);
      useServerStore.setState({ roles: [edited], members: [member('owner-1', 'owner'), { ...member('me', 'member'), roles: [edited] }] });
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

  it('Integrations open, MANAGE_WEBHOOKS revoked by a role edit: the permissions are refetched and the modal falls back to Members', async () => {
    const start = Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS | Permissions.KICK_MEMBERS;
    useServerStore.setState({ roles: [role(start)], members: [member('owner-1', 'owner'), { ...member('me', 'member'), roles: [role(start)] }] });
    apiWith(start, 0);
    await render();
    await act(async () => { q('[data-testid="tab-integrations"]')!.click(); });
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
    const before = effectiveCalls();

    await revokeTo(Permissions.VIEW_CHANNEL | Permissions.KICK_MEMBERS);
    expect(effectiveCalls()).toBe(before + 1);
    expect(q('[data-testid="tab-integrations"]')).toBeNull();
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
    expect(q('[data-testid="join-requests"]')).not.toBeNull();
  });

  it('Discovery open, MANAGE_SERVER revoked: back to the default tab, not a tab the strip no longer shows', async () => {
    const start = Permissions.VIEW_CHANNEL | Permissions.MANAGE_SERVER;
    useServerStore.setState({ roles: [role(start)], members: [member('owner-1', 'owner'), { ...member('me', 'member'), roles: [role(start)] }] });
    apiWith(start, 0);
    await render();
    await act(async () => { q('[data-testid="tab-discovery"]')!.click(); });
    expect(q('[data-testid="discovery-tab"]')).not.toBeNull();

    await revokeTo(Permissions.VIEW_CHANNEL);
    expect(q('[data-testid="discovery-tab"]')).toBeNull();
    expect(q('[data-testid="members-directory"]')).not.toBeNull();
  });

  it('Roles open, MANAGE_ROLES revoked: back to Members', async () => {
    const start = Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES;
    useServerStore.setState({ roles: [role(start)], members: [member('owner-1', 'owner'), { ...member('me', 'member'), roles: [role(start)] }] });
    apiWith(start, 0);
    await render();
    await act(async () => { tabButton('serverSettings.tabs.roles')!.click(); });
    expect(q('[data-testid="members-directory"]')).toBeNull();

    await revokeTo(Permissions.VIEW_CHANNEL);
    expect(tabButton('serverSettings.tabs.roles')).toBeUndefined();
    expect(q('[data-testid="members-directory"]')).not.toBeNull();
  });

  it('the read-only tabs (Members, Limits) stay picked whatever the bits', async () => {
    const start = Permissions.VIEW_CHANNEL | Permissions.MANAGE_SERVER;
    useServerStore.setState({ roles: [role(start)], members: [member('owner-1', 'owner'), { ...member('me', 'member'), roles: [role(start)] }] });
    apiWith(start, 0);
    await render();
    await act(async () => { tabButton('serverSettings.tabs.limits')!.click(); });
    await revokeTo(Permissions.VIEW_CHANNEL);
    expect(tabButton('serverSettings.tabs.limits')!.className).toContain('border-vox-accent-primary');
  });

  it('another server: the previous server\'s bits never keep Integrations open while the new answer is on its way', async () => {
    useServerStore.setState({ servers: [server('owner-1'), { ...server('owner-2'), id: 'srv-2', name: 'Other' }] });
    apiWith(Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS | Permissions.KICK_MEMBERS, 0);
    await render();
    await act(async () => { q('[data-testid="tab-integrations"]')!.click(); });
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();

    // srv-2's permissions are slow to answer
    let answer!: (v: unknown) => void;
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/roles/permissions/effective')) return new Promise((r) => { answer = r; });
      if (url.endsWith('/join-requests')) return Promise.resolve({ data: { data: [], total: 0, hasMore: false } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    await act(async () => { root.render(<ServerSettingsModal serverId="srv-2" onClose={() => {}} />); });
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-2/roles/permissions/effective');
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
    expect(q('[data-testid="tab-integrations"]')).toBeNull();

    // and when it lands without the bit, the picked tab is still not honoured
    await act(async () => { answer({ data: { data: { permissions: Permissions.VIEW_CHANNEL.toString() } } }); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
    expect(q('[data-testid="members-directory"]')).not.toBeNull();
  });

  it('a permitted pick survives a refetch that keeps the bit', async () => {
    const start = Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS | Permissions.KICK_MEMBERS;
    useServerStore.setState({ roles: [role(start)], members: [member('owner-1', 'owner'), { ...member('me', 'member'), roles: [role(start)] }] });
    apiWith(start, 0);
    await render();
    await act(async () => { q('[data-testid="tab-integrations"]')!.click(); });
    await revokeTo(start | Permissions.SEND_MESSAGES);
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
  });
});

describe('ServerSettingsModal — a live permission edit never remounts the open Integrations tab', () => {
  type RoleRow = import('@voxium/shared').Role;
  const role = (bits: bigint): RoleRow => ({
    id: 'r-hooks', serverId: 'srv-1', name: 'Integrators', color: null, position: 1, permissions: bits.toString(), isDefault: false, createdAt: '2026-10-01T00:00:00.000Z',
  } as unknown as RoleRow);
  const viewer = (r: RoleRow): ServerMember => ({ ...member('me', 'member'), roles: [r] } as ServerMember);

  /** The permissions GET answers `bits`; while `hold` is set, the answer waits until release() */
  function permissionsAnswering(bits: () => bigint, hold: { release: (() => void) | null; pending: boolean }) {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/roles/permissions/effective')) {
        const answer = { data: { data: { permissions: bits().toString() } } };
        if (!hold.pending) return Promise.resolve(answer);
        return new Promise((resolve) => { hold.release = () => resolve(answer); });
      }
      if (url.endsWith('/join-requests')) return Promise.resolve({ data: { data: [], total: 0, hasMore: false } });
      if (url.endsWith('/limits')) return Promise.resolve({ data: { success: true, data: LIMITS_ANSWER } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  }

  it('a role edit that KEEPS Manage Webhooks leaves the tab mounted while the refetch is in flight (the copy-once token survives)', async () => {
    let bits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS;
    const hold = { release: null as (() => void) | null, pending: false };
    permissionsAnswering(() => bits, hold);
    useServerStore.setState({ roles: [role(bits)], members: [member('owner-1', 'owner'), viewer(role(bits))] });
    await render();
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
    expect(tabCounts).toEqual({ mount: 1, unmount: 0 });

    // Another admin adds SEND_MESSAGES to the viewer's role: the fingerprint changes, the refetch is slow
    bits = bits | Permissions.SEND_MESSAGES;
    hold.pending = true;
    await act(async () => { useServerStore.setState({ roles: [role(bits)], members: [member('owner-1', 'owner'), viewer(role(bits))] }); });
    expect(q('[data-testid="integrations-tab"]'), 'still the Integrations tab while the answer is pending').not.toBeNull();
    expect(q('[data-testid="members-directory"]')).toBeNull();
    expect(tabCounts).toEqual({ mount: 1, unmount: 0 });

    await act(async () => { hold.release!(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
    expect(tabCounts).toEqual({ mount: 1, unmount: 0 });
  });

  it('a role edit that REVOKES Manage Webhooks closes the tab once the fresh answer lands, not before', async () => {
    let bits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS;
    const hold = { release: null as (() => void) | null, pending: false };
    permissionsAnswering(() => bits, hold);
    useServerStore.setState({ roles: [role(bits)], members: [member('owner-1', 'owner'), viewer(role(bits))] });
    await render();
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();

    bits = Permissions.VIEW_CHANNEL;
    hold.pending = true;
    await act(async () => { useServerStore.setState({ roles: [role(bits)], members: [member('owner-1', 'owner'), viewer(role(bits))] }); });
    expect(q('[data-testid="integrations-tab"]'), 'the stale answer holds until the server has spoken').not.toBeNull();

    await act(async () => { hold.release!(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-testid="integrations-tab"]')).toBeNull();
    expect(q('[data-testid="members-directory"]')).not.toBeNull();
    expect(tabCounts).toEqual({ mount: 1, unmount: 1 });
  });
});
