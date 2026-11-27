import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Channel, Message, ServerMember } from '@voxium/shared';

/**
 * The real MessageList over the real MessageItem (the other two files prove
 * each half with the other mocked): the toolbar of a row in a channel whose
 * bits are known carries Reply and the react control only for the bits held.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function VirtuosoStub(
    { data, itemContent, firstItemIndex = 0 }: { data: Message[]; itemContent: (index: number, item: Message) => ReactNode; firstItemIndex?: number },
    _ref: unknown,
  ) {
    void _ref;
    return <div>{data.map((m, i) => <div key={m.id}>{itemContent(firstItemIndex + i, m)}</div>)}</div>;
  }),
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
  editMessage: vi.fn(),
  editDMMessage: vi.fn(),
  setReplyingTo: vi.fn(),
  toggleReaction: vi.fn(),
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
    roles: [] as unknown[],
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
vi.mock('../../hooks/useMember', () => ({ useMember: () => undefined }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => <div data-testid="emoji-picker" /> }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span /> }));
vi.mock('../../components/common/UserHoverTarget', () => ({ UserHoverTarget: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('../../components/common/StaffBadge', () => ({ StaffBadge: () => null }));
vi.mock('../../components/common/SupporterBadge', () => ({ SupporterBadge: () => null }));
vi.mock('../../components/chat/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <span>{content}</span> }));
vi.mock('../../components/chat/AttachmentDisplay', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../components/chat/E2EAttachmentDisplay', () => ({ E2EAttachmentDisplay: () => null }));
vi.mock('../../components/chat/DeleteConfirmModal', () => ({ DeleteConfirmModal: () => null }));
vi.mock('../../components/chat/ReportModal', () => ({ ReportModal: () => null }));

import { MessageList } from '../../components/chat/MessageList';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';
import { resetChannelPermissionsCache } from '../../services/channelPermissionsCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchPerms = serverState.fetchEffectivePermissions as Mock;
let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => { root.render(<MessageList />); });
  // the permission answer lands through a chain of promises, not a timer:
  // more rounds than it needs today, so one more await in that chain does
  // not turn this into a test of how many rounds it takes
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}
const has = (label: string) => container.querySelector(`button[aria-label="${label}"]`) !== null;

beforeEach(() => {
  vi.clearAllMocks();
  resetServerPermissionsCache();
  resetChannelPermissionsCache();
  chatState.messages = [{
    id: 'm-alice', content: 'hello', type: 'user', channelId: 'ch-1', conversationId: null,
    author: { id: 'u-alice', username: 'alice', displayName: 'alice', avatarUrl: null }, mentions: [],
    createdAt: '2026-10-18T10:00:00.000Z', editedAt: null, reactions: [],
  } as Message];
  serverState.activeServerId = 'srv-1';
  serverState.activeChannelId = 'ch-1';
  serverState.channels = [{ id: 'ch-1', name: 'ch-1', type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z' } as Channel];
  serverState.members = [{ userId: 'me', serverId: 'srv-1', role: 'member', nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id: 'me', username: 'me', displayName: 'me', avatarUrl: null } } as unknown as ServerMember];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MessageList over the real MessageItem', () => {
  it('bits known without SEND_MESSAGES and ADD_REACTIONS: no Reply, no react control', async () => {
    fetchPerms.mockResolvedValue(Permissions.VIEW_CHANNEL.toString());
    await render();
    expect(container.querySelector('[data-message-id="m-alice"]')).not.toBeNull();
    expect(has('messageItem.reply')).toBe(false);
    expect(has('messageItem.addReaction')).toBe(false);
  });

  it('bits held: both are there', async () => {
    fetchPerms.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS).toString());
    await render();
    expect(has('messageItem.reply')).toBe(true);
    expect(has('messageItem.addReaction')).toBe(true);
  });
});
