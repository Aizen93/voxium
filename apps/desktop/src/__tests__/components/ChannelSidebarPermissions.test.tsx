import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Role, ServerMember } from '@voxium/shared';

/**
 * Channel and category management in the sidebar follows the viewer's
 * EFFECTIVE permission bits (the ones the server checks per action), not the
 * legacy member.role label: MANAGE_CHANNELS for channel delete, reorder and
 * "create a channel in this category", MANAGE_CATEGORIES for category delete,
 * reorder and "create category", MANAGE_ROLES for a channel's permission
 * overrides. A role edit that moves a bit changes what is shown with no role
 * reassigned.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const S = vi.hoisted(() => ({ fetchEffectivePermissions: vi.fn(), setActiveChannel: vi.fn(), clearMessages: vi.fn(), fetchMessages: vi.fn() }));
// Every useSortable call, to read the `disabled` flag each row and category is given
const sortables = vi.hoisted(() => ({ calls: [] as { id: string; disabled?: boolean }[] }));
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    useSortable: (args: { id: string; disabled?: boolean }) => {
      sortables.calls.push({ id: args.id, disabled: args.disabled });
      return actual.useSortable(args as never);
    },
  };
});
let occupants: { id: string; displayName: string; avatarUrl: null; selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean; speaking: boolean }[] = [];

let members: ServerMember[] = [];
let roles: Role[] = [];
let ownerId = 'someone-else';
const channels = [
  { id: 'c-text', name: 'general', type: 'text', serverId: 'srv1', position: 0, categoryId: 'cat1' },
  { id: 'c-voice', name: 'lounge', type: 'voice', serverId: 'srv1', position: 1, categoryId: null },
];
const categories = [{ id: 'cat1', name: 'Text', serverId: 'srv1', position: 0 }];
const noop = vi.fn();

vi.mock('../../stores/serverStore', () => {
  const state = () => ({
    channels,
    categories,
    activeChannelId: null,
    setActiveChannel: S.setActiveChannel,
    activeServerId: 'srv1',
    servers: [{ id: 'srv1', name: 'Testers', ownerId }],
    createChannel: noop,
    deleteChannel: noop,
    createCategory: noop,
    deleteCategory: noop,
    members,
    people: { full: true, truncated: false, onlineCount: 0, memberCount: 0, loaded: true },
    ensureMembers: noop,
    roles,
    unreadCounts: {},
    reorderCategories: noop,
    reorderChannels: noop,
    fetchEffectivePermissions: S.fetchEffectivePermissions,
    leaveSecureChannel: noop,
    secureChannelMembers: {},
  });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore, NO_SECURE_MEMBERS: [] };
});
vi.mock('../../stores/voiceStore', () => {
  const state = () => ({ joinChannel: noop, activeChannelId: null, channelUsers: new Map(occupants.length ? [['c-voice', occupants]] : []) });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useVoiceStore.getState = state;
  return { useVoiceStore };
});
vi.mock('../../stores/chatStore', () => {
  const state = () => ({ clearMessages: S.clearMessages, fetchMessages: S.fetchMessages });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useChatStore.getState = state;
  return { useChatStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components/voice/VoicePanel', () => ({ VoicePanel: () => null }));
vi.mock('../../components/voice/DMVoicePanel', () => ({ DMVoicePanel: () => null }));
vi.mock('../../components/server/InviteModal', () => ({ InviteModal: () => null }));
vi.mock('../../components/server/ServerSettingsModal', () => ({ ServerSettingsModal: () => null }));
vi.mock('../../components/server/ChannelPermissionsEditor', () => ({ ChannelPermissionsEditor: () => null }));
vi.mock('../../components/server/MemberContextMenu', () => ({ MemberContextMenu: () => null }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { ChannelSidebar } from '../../components/channel/ChannelSidebar';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const role = (id: string, permissions: bigint): Role => ({
  id, serverId: 'srv1', name: id, color: null, position: 1, permissions: permissions.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z',
});
const meWith = (legacy: ServerMember['role'], ...assigned: Role[]): ServerMember =>
  ({ userId: 'me', serverId: 'srv1', role: legacy, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: assigned,
    user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } } as unknown as ServerMember);

let container: HTMLDivElement;
let root: Root;
let bits: bigint;

async function render() {
  await act(async () => { root.render(<ChannelSidebar />); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
/** The viewer holds `granted` through one custom role; the legacy label is whatever the test says. */
function viewer(granted: bigint, legacy: ServerMember['role'] = 'member') {
  const r = role('r1', granted);
  roles = [r];
  members = [meWith(legacy, r)];
  bits = granted;
}
const count = (label: string) => document.body.querySelectorAll(`[aria-label="${label}"]`).length;
const has = (text: string) => Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent === text);
const createCategoryRow = () => document.body.querySelector('[data-testid="create-category-open"]');
const openChannelMenu = async () => {
  const name = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('general'))!;
  await act(async () => { name.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
};
const menuButtons = () => Array.from(document.body.querySelectorAll('.fixed button')).map((b) => b.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  resetServerPermissionsCache();
  ownerId = 'someone-else';
  sortables.calls.length = 0;
  occupants = [];
  S.fetchEffectivePermissions.mockImplementation(() => Promise.resolve(bits.toString()));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelSidebar — management controls follow the effective permissions', () => {
  it('a legacy "admin" or "owner" label without the bits sees no management control at all', async () => {
    for (const legacy of ['admin', 'owner'] as const) {
      viewer(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES, legacy);
      resetServerPermissionsCache();
      await render();
      expect(count('channel.deleteChannel'), legacy).toBe(0);
      expect(count('channel.deleteCategory'), legacy).toBe(0);
      expect(count('channel.createChannel'), legacy).toBe(0);
      expect(count('channel.serverSettings'), legacy).toBe(0);
      expect(createCategoryRow(), legacy).toBeNull();
      await openChannelMenu();
      expect(menuButtons(), legacy).toEqual([]);
    }
  });

  it('MANAGE_CHANNELS alone: channel delete, "create channel" in a category and the channel menu\'s delete; no category control', async () => {
    viewer(Permissions.MANAGE_CHANNELS);
    await render();
    expect(count('channel.deleteChannel')).toBe(2); // the text and the voice channel
    expect(count('channel.createChannel')).toBe(1);
    expect(count('channel.deleteCategory')).toBe(0);
    expect(createCategoryRow()).toBeNull();
    await openChannelMenu();
    expect(has('channel.deleteChannel')).toBe(true);
    expect(has('channel.editPermissions')).toBe(false);
  });

  it('MANAGE_CATEGORIES alone: category delete and "create category"; no channel control', async () => {
    viewer(Permissions.MANAGE_CATEGORIES);
    await render();
    expect(count('channel.deleteCategory')).toBe(1);
    expect(createCategoryRow()).not.toBeNull();
    expect(count('channel.deleteChannel')).toBe(0);
    expect(count('channel.createChannel')).toBe(0);
    await openChannelMenu();
    expect(menuButtons()).toEqual([]);
  });

  it('MANAGE_ROLES alone: only "Edit permissions" in the channel menu (and the settings gear)', async () => {
    viewer(Permissions.MANAGE_ROLES);
    await render();
    expect(count('channel.serverSettings')).toBe(1);
    expect(count('channel.deleteChannel')).toBe(0);
    await openChannelMenu();
    expect(has('channel.editPermissions')).toBe(true);
    expect(has('channel.deleteChannel')).toBe(false);
  });

  it('every bit (the owner\'s answer): everything is shown', async () => {
    viewer(ALL_PERMISSIONS);
    await render();
    expect(count('channel.deleteChannel')).toBe(2);
    expect(count('channel.deleteCategory')).toBe(1);
    expect(count('channel.createChannel')).toBe(1);
    expect(createCategoryRow()).not.toBeNull();
    expect(count('channel.serverSettings')).toBe(1);
  });

  it('the owner of the space (Server.ownerId) has every control at once, and keeps them when the permissions fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ownerId = 'me';
    viewer(0n, 'member'); // the label says nothing; ownership comes from the space
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await render();
    expect(count('channel.deleteChannel')).toBe(2);
    expect(count('channel.deleteCategory')).toBe(1);
    expect(createCategoryRow()).not.toBeNull();
    expect(count('channel.serverSettings')).toBe(1);
    warn.mockRestore();
  });

  it('a role edit that grants MANAGE_CHANNELS changes what is shown with no role reassigned', async () => {
    viewer(Permissions.VIEW_CHANNEL);
    await render();
    expect(count('channel.deleteChannel')).toBe(0);
    const before = members[0].roles;
    // Another admin edits the role the viewer already holds
    roles = [role('r1', Permissions.VIEW_CHANNEL | Permissions.MANAGE_CHANNELS)];
    bits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_CHANNELS;
    await render();
    expect(count('channel.deleteChannel')).toBe(2);
    expect(members[0].roles).toBe(before);
    // ...and taking it away closes them again
    roles = [role('r1', Permissions.VIEW_CHANNEL)];
    bits = Permissions.VIEW_CHANNEL;
    await render();
    expect(count('channel.deleteChannel')).toBe(0);
  });
});

describe('ChannelSidebar — drag and drop, the occupied voice card and the secure-channel button follow their bits', () => {
  const user = { id: 'u1', displayName: 'Una', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false };
  const lastDisabled = (id: string) => [...sortables.calls].reverse().find((c) => c.id === id)?.disabled;
  const card = () => document.body.querySelector('[data-testid="voice-channel-card"]') as HTMLElement;
  const textRow = () => Array.from(document.body.querySelectorAll('button'))
    .find((b) => b.textContent?.includes('general'))!.closest('.group') as HTMLElement;
  const categoryHeader = () => (document.body.querySelector('[data-testid="category-header"]') as HTMLElement).parentElement as HTMLElement;
  const grip = (el: HTMLElement) => el.querySelector('button.cursor-grab');

  it('MANAGE_CHANNELS: channels sort and show their handles and delete (the occupied card too), the category does not', async () => {
    occupants = [user];
    viewer(Permissions.MANAGE_CHANNELS);
    await render();
    expect(lastDisabled('ch-c-text')).toBe(false);
    expect(lastDisabled('ch-c-voice')).toBe(false);
    expect(lastDisabled('cat-cat1')).toBe(true);
    expect(grip(textRow())).not.toBeNull();
    expect(grip(card())).not.toBeNull();
    expect(card().querySelector('[aria-label="channel.deleteChannel"]')).not.toBeNull();
    expect(grip(categoryHeader())).toBeNull();
  });

  it('MANAGE_CATEGORIES: the category sorts and shows its handle, no channel does', async () => {
    occupants = [user];
    viewer(Permissions.MANAGE_CATEGORIES);
    await render();
    expect(lastDisabled('cat-cat1')).toBe(false);
    expect(lastDisabled('ch-c-text')).toBe(true);
    expect(lastDisabled('ch-c-voice')).toBe(true);
    expect(grip(categoryHeader())).not.toBeNull();
    expect(grip(textRow())).toBeNull();
    expect(grip(card())).toBeNull();
    expect(card().querySelector('[aria-label="channel.deleteChannel"]')).toBeNull();
  });

  it('neither bit (a legacy admin label does not help): nothing sorts and no handle shows', async () => {
    occupants = [user];
    viewer(Permissions.VIEW_CHANNEL, 'admin');
    await render();
    for (const id of ['ch-c-text', 'ch-c-voice', 'cat-cat1']) expect(lastDisabled(id), id).toBe(true);
    expect(document.body.querySelectorAll('button.cursor-grab')).toHaveLength(0);
    expect(card().querySelector('[aria-label="channel.deleteChannel"]')).toBeNull();
  });

  it('the create button of secure channels follows CREATE_SECURE_CHANNELS alone', async () => {
    const button = () => document.body.querySelector('[data-testid="secure-channel-create-open"]');
    viewer(Permissions.CREATE_SECURE_CHANNELS);
    await render();
    expect(button()).not.toBeNull();
    viewer(ALL_PERMISSIONS & ~Permissions.CREATE_SECURE_CHANNELS & ~Permissions.ADMINISTRATOR, 'admin');
    resetServerPermissionsCache();
    await render();
    expect(button()).toBeNull();
    expect(document.body.querySelector('[data-testid="secure-channels-section"]')).toBeNull();
  });
});

describe('ChannelSidebar — selecting a text channel', () => {
  it('only selects it: the chat view owns the clear and the fetch', async () => {
    viewer(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES);
    await render();
    const name = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('general'))!;
    await act(async () => { name.click(); });
    expect(S.setActiveChannel).toHaveBeenCalledWith('c-text');
    expect(S.clearMessages).not.toHaveBeenCalled();
    expect(S.fetchMessages).not.toHaveBeenCalled();
  });
});
