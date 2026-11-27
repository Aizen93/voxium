import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Channel, Message, MessageAuthor, Role, ServerMember } from '@voxium/shared';

/**
 * Who gets a Delete button on other people's messages (webhook posts
 * included: MANAGE_MESSAGES is the ONLY way to remove one). The server
 * decides by the permission bit, so the list must too: a moderator whose
 * MANAGE_MESSAGES comes from a custom role is a plain "member" in the legacy
 * role field. Secure channels keep their own rule (the creator moderates).
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

// Virtuoso needs a real layout: render every row straight through itemContent
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function VirtuosoStub(
    { data, itemContent, firstItemIndex = 0 }: { data: Message[]; itemContent: (index: number, item: Message) => ReactNode; firstItemIndex?: number },
    _ref: unknown,
  ) {
    void _ref;
    return <div data-testid="virtuoso">{data.map((m, i) => <div key={m.id}>{itemContent(firstItemIndex + i, m)}</div>)}</div>;
  }),
}));

vi.mock('../../components/chat/MessageItem', () => ({
  MessageItem: ({ message, canDelete, isOwn, canReply, canReact }: { message: Message; canDelete: boolean; isOwn: boolean; canReply?: boolean; canReact?: boolean }) => (
    <div data-testid={`row-${message.id}`} data-can-delete={String(canDelete)} data-own={String(isOwn)} data-can-reply={String(canReply)} data-can-react={String(canReact)} />
  ),
}));

const chatState = vi.hoisted(() => ({
  messages: [] as Message[],
  hasMore: false,
  hasMoreAfter: false,
  isLoading: false,
  fetchMessages: () => Promise.resolve(),
  typingUsers: new Map<string, string>(),
  targetMessageId: null as string | null,
  clearTargetMessage: () => {},
}));
vi.mock('../../stores/chatStore', () => {
  const useChatStore = <T,>(sel?: (s: typeof chatState) => T) => (sel ? sel(chatState) : chatState);
  useChatStore.getState = () => chatState;
  return { useChatStore };
});

vi.mock('../../stores/authStore', () => {
  const state = { user: { id: 'me', username: 'me', displayName: 'Me' } };
  const useAuthStore = <T,>(sel?: (s: typeof state) => T) => (sel ? sel(state) : state);
  useAuthStore.getState = () => state;
  return { useAuthStore };
});

const { serverState } = vi.hoisted(() => ({
  serverState: {
    activeServerId: 'srv-1' as string | null,
    activeChannelId: 'ch-1' as string | null,
    members: [] as ServerMember[],
    roles: [] as Role[],
    channels: [] as Channel[],
    fetchEffectivePermissions: vi.fn(),
    servers: [] as { id: string; ownerId: string }[],
  },
}));
vi.mock('../../stores/serverStore', () => {
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) => (sel ? sel(serverState) : serverState);
  useServerStore.getState = () => serverState;
  return { useServerStore };
});

import { MessageList } from '../../components/chat/MessageList';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';
import { invalidateChannelPermissions, resetChannelPermissionsCache } from '../../services/channelPermissionsCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchPerms = serverState.fetchEffectivePermissions as Mock;

const channel = (id: string, extra: Partial<Channel> = {}): Channel => ({
  id, name: id, type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const member = (userId: string, role: ServerMember['role'], roles: Role[] = []): ServerMember =>
  ({ userId, serverId: 'srv-1', role, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles,
    user: { id: userId, username: userId, displayName: userId, avatarUrl: null } } as unknown as ServerMember);
const modRole: Role = { id: 'r-mod', serverId: 'srv-1', name: 'Moderator', color: null, position: 1, permissions: Permissions.MANAGE_MESSAGES.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' };

const author = (id: string, extra: Partial<MessageAuthor> = {}): MessageAuthor => ({ id, username: id, displayName: id, avatarUrl: null, ...extra });
const msg = (id: string, a: MessageAuthor, channelId = 'ch-1', extra: Partial<Message> = {}): Message => ({
  id, content: id, type: 'user', channelId, conversationId: null, author: a, mentions: [],
  createdAt: '2026-10-18T10:00:00.000Z', editedAt: null, reactions: [], ...extra,
});

const fromAlice = msg('m-alice', author('u-alice'));
const fromHook = msg('m-hook', author('webhook:wh-1', { displayName: 'CI', isWebhook: true }), 'ch-1', { webhookId: 'wh-1' });
const mine = msg('m-mine', author('me'));

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => { root.render(<MessageList />); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}
async function rerender() {
  await act(async () => { root.render(<MessageList key="same" />); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}
const canDelete = (id: string) => container.querySelector(`[data-testid="row-${id}"]`)?.getAttribute('data-can-delete');

beforeEach(() => {
  vi.clearAllMocks();
  resetServerPermissionsCache();
  resetChannelPermissionsCache();
  chatState.messages = [fromAlice, fromHook, mine];
  serverState.activeServerId = 'srv-1';
  serverState.activeChannelId = 'ch-1';
  serverState.channels = [channel('ch-1'), channel('ch-sec', { secure: true, createdById: 'u-creator' } as Partial<Channel>)];
  serverState.roles = [];
  serverState.servers = [];
  serverState.members = [member('me', 'member')];
  fetchPerms.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES).toString());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MessageList — Delete follows MANAGE_MESSAGES, not only the legacy role', () => {
  it('a plain "member" whose custom role grants MANAGE_MESSAGES gets Delete on others\' messages and on webhook posts', async () => {
    serverState.roles = [modRole];
    serverState.members = [member('me', 'member', [modRole])];
    fetchPerms.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.MANAGE_MESSAGES).toString());
    await render();
    expect(fetchPerms).toHaveBeenCalledWith('srv-1', 'ch-1');
    expect(canDelete('m-alice')).toBe('true');
    expect(canDelete('m-hook')).toBe('true');
    expect(canDelete('m-mine')).toBe('true');
  });

  it('without the bit: Delete only on the viewer\'s own message', async () => {
    await render();
    expect(fetchPerms).toHaveBeenCalledWith('srv-1', 'ch-1');
    expect(canDelete('m-alice')).toBe('false');
    expect(canDelete('m-hook')).toBe('false');
    expect(canDelete('m-mine')).toBe('true');
  });

  it('ADMINISTRATOR implies it', async () => {
    fetchPerms.mockResolvedValue(Permissions.ADMINISTRATOR.toString());
    await render();
    expect(canDelete('m-hook')).toBe('true');
  });

  it('a legacy owner or admin label without the bit gets no Delete: the permission bit decides, not the label', async () => {
    for (const legacy of ['owner', 'admin'] as const) {
      serverState.members = [member('me', legacy)];
      await render();
      expect(canDelete('m-alice')).toBe('false');
      expect(canDelete('m-hook')).toBe('false');
      expect(canDelete('m-mine')).toBe('true');
      act(() => root.unmount());
      root = createRoot(container);
      resetServerPermissionsCache();
      resetChannelPermissionsCache();
    }
  });

  it('the owner of the space (Server.ownerId) keeps Delete at once and asks nothing, so a failing route costs them nothing', async () => {
    serverState.servers = [{ id: 'srv-1', ownerId: 'me' }];
    fetchPerms.mockRejectedValue(new Error('offline'));
    await render();
    expect(canDelete('m-alice')).toBe('true');
    expect(canDelete('m-hook')).toBe('true');
    expect(fetchPerms).not.toHaveBeenCalled();
  });

  it('during a space switch (new space, channels of the old one) Delete stays hidden and nothing is asked', async () => {
    serverState.activeServerId = 'srv-2';
    await render();
    expect(canDelete('m-alice')).toBe('false');
    expect(fetchPerms).not.toHaveBeenCalled();
  });

  it('a failed fetch leaves a plain member without Delete (logged, never thrown)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPerms.mockRejectedValue(new Error('offline'));
    await render();
    expect(canDelete('m-alice')).toBe('false');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a SECURE channel keeps its rule: the creator moderates, MANAGE_MESSAGES on the server does not', async () => {
    fetchPerms.mockResolvedValue(Permissions.MANAGE_MESSAGES.toString());
    serverState.activeChannelId = 'ch-sec';
    chatState.messages = [msg('m-sec', author('u-alice'), 'ch-sec')];
    await render();
    expect(canDelete('m-sec')).toBe('false');
    // a secure channel's bits are never asked: membership decides
    expect(fetchPerms).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    serverState.channels = [channel('ch-sec', { secure: true, createdById: 'me' } as Partial<Channel>)];
    fetchPerms.mockResolvedValue('0');
    await render();
    expect(canDelete('m-sec')).toBe('true');
  });
});

const attr = (id: string, name: string) => container.querySelector(`[data-testid="row-${id}"]`)?.getAttribute(name);

describe('MessageList — Reply and reactions follow SEND_MESSAGES and ADD_REACTIONS of the channel', () => {
  it('held: both props true', async () => {
    fetchPerms.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS).toString());
    await render();
    expect(attr('m-alice', 'data-can-reply')).toBe('true');
    expect(attr('m-alice', 'data-can-react')).toBe('true');
  });

  it('known and denied: each prop follows its own bit', async () => {
    fetchPerms.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.ADD_REACTIONS).toString());
    await render();
    expect(attr('m-alice', 'data-can-reply')).toBe('false');
    expect(attr('m-alice', 'data-can-react')).toBe('true');
    act(() => root.unmount());
    root = createRoot(container);
    resetChannelPermissionsCache();
    fetchPerms.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES).toString());
    await render();
    expect(attr('m-mine', 'data-can-reply')).toBe('true');
    expect(attr('m-mine', 'data-can-react')).toBe('false');
  });

  it('ADMINISTRATOR holds both', async () => {
    fetchPerms.mockResolvedValue(Permissions.ADMINISTRATOR.toString());
    await render();
    expect(attr('m-alice', 'data-can-reply')).toBe('true');
    expect(attr('m-alice', 'data-can-react')).toBe('true');
  });

  it('not loaded yet: usable, never hidden', async () => {
    fetchPerms.mockReturnValue(new Promise(() => {}));
    await render();
    expect(attr('m-alice', 'data-can-reply')).toBe('true');
    expect(attr('m-alice', 'data-can-react')).toBe('true');
  });

  it('a failed fetch stays usable (logged, never thrown)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPerms.mockRejectedValue(new Error('offline'));
    await render();
    expect(attr('m-alice', 'data-can-reply')).toBe('true');
    expect(attr('m-alice', 'data-can-react')).toBe('true');
    warn.mockRestore();
  });

  it('a secure channel asks nothing and keeps both', async () => {
    serverState.activeChannelId = 'ch-sec';
    chatState.messages = [msg('m-sec', author('u-alice'), 'ch-sec')];
    await render();
    expect(fetchPerms).not.toHaveBeenCalled();
    expect(attr('m-sec', 'data-can-reply')).toBe('true');
    expect(attr('m-sec', 'data-can-react')).toBe('true');
  });

  it('an override write that takes the bits away removes the controls', async () => {
    fetchPerms.mockResolvedValue((Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS).toString());
    await render();
    expect(attr('m-alice', 'data-can-reply')).toBe('true');
    fetchPerms.mockResolvedValue('0');
    await act(async () => { invalidateChannelPermissions('srv-1'); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(attr('m-alice', 'data-can-reply')).toBe('false');
    expect(attr('m-alice', 'data-can-react')).toBe('false');
  });
});

describe('MessageList — the effective permissions are cached per server and fingerprint', () => {
  it('a channel switch asks for the new channel (an override can differ there); coming back costs no request', async () => {
    // ch-1 grants MANAGE_MESSAGES, ch-2 has an override taking it away
    fetchPerms.mockImplementation((_s: string, ch: string) =>
      Promise.resolve(ch === 'ch-1' ? Permissions.MANAGE_MESSAGES.toString() : '0'));
    await render();
    expect(fetchPerms).toHaveBeenCalledTimes(1);
    expect(canDelete('m-alice')).toBe('true');
    serverState.activeChannelId = 'ch-2';
    serverState.channels = [...serverState.channels, channel('ch-2')];
    chatState.messages = [msg('m-2', author('u-alice'), 'ch-2')];
    await rerender();
    expect(fetchPerms).toHaveBeenCalledTimes(2);
    expect(fetchPerms).toHaveBeenLastCalledWith('srv-1', 'ch-2');
    expect(canDelete('m-2')).toBe('false');
    serverState.activeChannelId = 'ch-1';
    chatState.messages = [fromAlice];
    await rerender();
    expect(fetchPerms).toHaveBeenCalledTimes(2);
    expect(canDelete('m-alice')).toBe('true');
  });

  it('an override that GRANTS the bit in one channel shows Delete there although the space level lacks it', async () => {
    fetchPerms.mockImplementation((_s: string, ch: string) =>
      Promise.resolve(ch === 'ch-1' ? (Permissions.VIEW_CHANNEL | Permissions.MANAGE_MESSAGES).toString() : Permissions.VIEW_CHANNEL.toString()));
    await render();
    expect(canDelete('m-alice')).toBe('true');
  });

  it('an override write (channel:permissions_updated) refetches: a bit taken away hides Delete', async () => {
    fetchPerms.mockResolvedValue(Permissions.MANAGE_MESSAGES.toString());
    await render();
    expect(canDelete('m-alice')).toBe('true');
    fetchPerms.mockResolvedValue('0');
    await act(async () => { invalidateChannelPermissions('srv-1'); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchPerms).toHaveBeenCalledTimes(2);
    expect(canDelete('m-alice')).toBe('false');
  });

  it('a live role change (new fingerprint) refetches: a revoked bit takes Delete away', async () => {
    serverState.roles = [modRole];
    serverState.members = [member('me', 'member', [modRole])];
    fetchPerms.mockResolvedValue(Permissions.MANAGE_MESSAGES.toString());
    await render();
    expect(canDelete('m-alice')).toBe('true');

    // the role loses MANAGE_MESSAGES: the store's role object changes
    const demoted = { ...modRole, permissions: '0' };
    serverState.roles = [demoted];
    serverState.members = [member('me', 'member', [demoted])];
    fetchPerms.mockResolvedValue('0');
    await rerender();
    expect(fetchPerms).toHaveBeenCalledTimes(2);
    expect(canDelete('m-alice')).toBe('false');
  });

  it('another server is asked separately, and one server\'s bits never apply to the other', async () => {
    fetchPerms.mockResolvedValue(Permissions.MANAGE_MESSAGES.toString());
    await render();
    expect(canDelete('m-alice')).toBe('true');

    let answer!: (bits: string) => void;
    fetchPerms.mockImplementation(() => new Promise<string>((r) => { answer = r; }));
    serverState.activeServerId = 'srv-2';
    serverState.activeChannelId = 'ch-9';
    serverState.channels = [channel('ch-9', { serverId: 'srv-2' })];
    chatState.messages = [msg('m-9', author('u-alice'), 'ch-9')];
    await rerender();
    expect(fetchPerms).toHaveBeenLastCalledWith('srv-2', 'ch-9');
    // srv-2's answer is not in yet: srv-1's MANAGE_MESSAGES does not carry over
    expect(canDelete('m-9')).toBe('false');
    await act(async () => { answer('0'); });
    expect(canDelete('m-9')).toBe('false');
  });
});
