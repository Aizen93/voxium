import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, forwardRef, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Channel, Message, MessageAuthor } from '@voxium/shared';

/**
 * The chat store places a row where the server's time puts it, so a message
 * whose decrypt ended late lands BEFORE a newer one already shown. What the
 * two lists do with such an insert, read off the props they hand Virtuoso:
 * an insert in the middle is neither a prepend (the window start stays, the
 * list is not remounted) nor a new last row (no forced follow to the bottom,
 * even for one's own message: only a new LAST row of one's own forces it);
 * one landing before every row shown, with the rest kept, is a prepend.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

type VirtuosoProps = {
  data: Message[];
  itemContent: (index: number, item: Message) => ReactNode;
  firstItemIndex?: number;
  followOutput?: (atBottom: boolean) => unknown;
};
const V = vi.hoisted(() => ({ last: null as VirtuosoProps | null, mounts: 0 }));
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function VirtuosoStub(props: VirtuosoProps, _ref: unknown) {
    void _ref;
    useEffect(() => { V.mounts += 1; }, []);
    V.last = props;
    return <div>{props.data.map((m, i) => <div key={m.id}>{props.itemContent((props.firstItemIndex ?? 0) + i, m)}</div>)}</div>;
  }),
}));
vi.mock('../../components/chat/MessageItem', () => ({ MessageItem: () => null }));
vi.mock('../../components/dm/DeletedParticipant', () => ({ DeletedMessageRow: () => null }));

const chatState = vi.hoisted(() => ({
  messages: [] as Message[],
  hasMore: false,
  hasMoreAfter: false,
  isLoading: false,
  fetchMessages: () => Promise.resolve(),
  fetchDMMessages: () => Promise.resolve(),
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
    members: [],
    roles: [],
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
import { DMMessageList } from '../../components/dm/DMMessageList';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const me: MessageAuthor = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null };
const peer: MessageAuthor = { id: 'u-peer', username: 'peer', displayName: 'Peer', avatarUrl: null };
const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;
const row = (id: string, minute: number, author = peer): Message => ({
  id, content: id, type: 'user', channelId: 'ch-1', conversationId: 'c-1', author, mentions: [],
  createdAt: at(minute), editedAt: null, reactions: [],
});

let container: HTMLDivElement;
let root: Root;

const LISTS = [
  { name: 'MessageList', render: () => <MessageList /> },
  { name: 'DMMessageList', render: () => <DMMessageList conversationId="c-1" /> },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetServerPermissionsCache();
  V.last = null;
  V.mounts = 0;
  serverState.channels = [{ id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z' }];
  serverState.fetchEffectivePermissions.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES).toString());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

for (const list of LISTS) {
  describe(`${list.name}: a row the store places before a newer one`, () => {
    async function show(messages: Message[]) {
      chatState.messages = messages;
      await act(async () => { root.render(list.render()); });
      for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    }

    it('an insert in the middle keeps the window start and the list, and follows only a reader already at the bottom', async () => {
      await show([row('m1', 1), row('m3', 3)]);
      const start = V.last!.firstItemIndex;
      const mounts = V.mounts;

      await show([row('m1', 1), row('m2', 2), row('m3', 3)]);

      expect(V.last!.firstItemIndex).toBe(start);
      expect(V.mounts).toBe(mounts);
      expect(V.last!.followOutput!(false)).toBe(false);
      expect(V.last!.followOutput!(true)).toBe('smooth');
    });

    it('one\'s own message landing in the middle forces no follow; one landing last does', async () => {
      await show([row('m1', 1), row('m3', 3)]);
      await show([row('m1', 1), row('mine', 2, me), row('m3', 3)]);
      expect(V.last!.followOutput!(false)).toBe(false);

      await show([row('m1', 1), row('mine', 2, me), row('m3', 3), row('mine-2', 4, me)]);
      expect(V.last!.followOutput!(false)).toBe('auto');
    });

    it('an insert before every row shown, the rest kept, is a prepend: the window start moves by one, no remount', async () => {
      await show([row('m2', 2), row('m3', 3)]);
      const start = V.last!.firstItemIndex!;
      const mounts = V.mounts;

      await show([row('m1', 1), row('m2', 2), row('m3', 3)]);

      expect(V.last!.firstItemIndex).toBe(start - 1);
      expect(V.mounts).toBe(mounts);
    });
  });
}
