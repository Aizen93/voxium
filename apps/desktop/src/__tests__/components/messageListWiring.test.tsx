import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Channel, Message, MessageAuthor, ServerMember } from '@voxium/shared';

/**
 * Which rows of the mounted MessageList carry a header (avatar + name), read
 * off what it hands each MessageItem. A webhook's author id is not who posted:
 * one webhook may post under a new name per message and every deleted webhook
 * shares `webhook:deleted`, so folding those rows would hide the name a post
 * went out under. The rule itself is unit-tested in utils/messageGrouping;
 * this pins that the list actually applies it, row by row.
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
  MessageItem: ({ message, showHeader }: { message: Message; showHeader: boolean }) => (
    <div data-testid={`row-${message.id}`} data-show-header={String(showHeader)} />
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
    roles: [],
    channels: [] as Channel[],
    fetchEffectivePermissions: vi.fn(),
  },
}));
vi.mock('../../stores/serverStore', () => {
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) => (sel ? sel(serverState) : serverState);
  useServerStore.getState = () => serverState;
  return { useServerStore };
});

import { MessageList } from '../../components/chat/MessageList';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';
import { MESSAGE_GROUP_WINDOW_MS } from '../../utils/messageGrouping';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const msg = (id: string, author: MessageAuthor, offsetMs: number, extra: Partial<Message> = {}): Message => ({
  id, content: id, type: 'user', channelId: 'ch-1', conversationId: null, author, mentions: [],
  createdAt: at(offsetMs), editedAt: null, reactions: [], ...extra,
});
const human = (id: string, userId: string, offsetMs: number) =>
  msg(id, { id: userId, username: userId, displayName: userId, avatarUrl: null }, offsetMs);
/** A webhook row as the server shapes it: the per-message name is the author's name. */
const hook = (id: string, webhookId: string | null, name: string, offsetMs: number) => msg(
  id,
  { id: `webhook:${webhookId ?? 'deleted'}`, username: name, displayName: name, avatarUrl: null, isWebhook: true },
  offsetMs,
  { webhookId, webhookName: name },
);

let container: HTMLDivElement;
let root: Root;

async function renderList(messages: Message[]) {
  chatState.messages = messages;
  await act(async () => { root.render(<MessageList />); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}
/** `data-show-header` of every row, in display order, keyed by message id. */
const headers = () => Object.fromEntries(
  Array.from(container.querySelectorAll('[data-testid^="row-"]')).map((row) => [
    row.getAttribute('data-testid')!.slice('row-'.length),
    row.getAttribute('data-show-header') === 'true',
  ]),
);

beforeEach(() => {
  vi.clearAllMocks();
  resetServerPermissionsCache();
  serverState.activeServerId = 'srv-1';
  serverState.activeChannelId = 'ch-1';
  serverState.channels = [{ id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z' }];
  serverState.members = [];
  serverState.fetchEffectivePermissions.mockResolvedValue((Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES).toString());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MessageList — which rows get a header', () => {
  it('one webhook posting under a different name per message: every post gets a header', async () => {
    await renderList([
      hook('h1', 'wh-1', 'CI', 0),
      hook('h2', 'wh-1', 'Deploy bot', 30_000),
      hook('h3', 'wh-1', 'CI', 60_000),
    ]);
    expect(headers()).toEqual({ h1: true, h2: true, h3: true });
  });

  it('one webhook under one name folds like a person would (the name is the key, not "webhook" itself)', async () => {
    await renderList([hook('h1', 'wh-1', 'CI', 0), hook('h2', 'wh-1', 'CI', 30_000)]);
    expect(headers()).toEqual({ h1: true, h2: false });
  });

  it('one person posting twice within the grouping window shares one header; past the window, a new one', async () => {
    await renderList([
      human('a1', 'u-alice', 0),
      human('a2', 'u-alice', 60_000),
      human('a3', 'u-alice', 60_000 + MESSAGE_GROUP_WINDOW_MS + 1),
    ]);
    expect(headers()).toEqual({ a1: true, a2: false, a3: true });
  });

  it('a webhook post right after a person\'s gets a header, and so does the person after it', async () => {
    await renderList([
      human('a1', 'u-alice', 0),
      hook('h1', 'wh-1', 'CI', 10_000),
      human('a2', 'u-alice', 20_000),
    ]);
    expect(headers()).toEqual({ a1: true, h1: true, a2: true });
  });

  it('two different deleted webhooks (both `webhook:deleted`) never fold into one', async () => {
    await renderList([
      hook('d1', null, 'Old CI', 0),
      hook('d2', null, 'Old Deploys', 10_000),
    ]);
    const [first, second] = chatState.messages;
    expect(first.author.id).toBe('webhook:deleted');
    expect(second.author.id).toBe('webhook:deleted');
    expect(headers()).toEqual({ d1: true, d2: true });
  });
});
