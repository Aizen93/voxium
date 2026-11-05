import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, forwardRef, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Channel, Message, MessageAuthor, ServerMember } from '@voxium/shared';

/**
 * Vertical space at the edge of anything Virtuoso measures must be padding or
 * contained, never a bare margin. Virtuoso sizes each row, the Header and the
 * Footer by their own box; a margin on (or collapsing out of) that box takes
 * room on screen the size tree never counts, and its follow-to-bottom then
 * stopped short by the sum of those margins: with several people talking,
 * the message just sent or received sat below the fold.
 *
 * jsdom has no layout, so this pins the classes that keep the margins inside:
 * `flow-root` on every message row (MessageItem keeps its `mt-4` between
 * author groups), and no vertical margin class on any other measured box. The
 * geometry itself is checked in the browser by tests/e2e/message-scroll.spec.ts.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

type StubProps = {
  data: Message[];
  itemContent: (index: number, item: Message) => ReactNode;
  firstItemIndex?: number;
  components?: { Header?: ComponentType; Footer?: ComponentType };
};

// Each slot stands for one box Virtuoso measures; the element rendered INTO
// the slot is the one whose margins would escape the measurement.
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function VirtuosoStub({ data, itemContent, firstItemIndex = 0, components = {} }: StubProps, _ref: unknown) {
    void _ref;
    const { Header, Footer } = components;
    return (
      <div>
        {Header && <div data-slot="header"><Header /></div>}
        {data.map((m, i) => <div key={m.id} data-slot="row" data-row-id={m.id}>{itemContent(firstItemIndex + i, m)}</div>)}
        {Footer && <div data-slot="footer"><Footer /></div>}
      </div>
    );
  }),
}));

// The real MessageItem's root carries mt-4 when it starts a group after
// another row: the stub keeps that margin so the test means something.
vi.mock('../../components/chat/MessageItem', () => ({
  MessageItem: ({ message, addTopMargin }: { message: Message; addTopMargin: boolean }) => (
    <div data-message-id={message.id} className={addTopMargin ? 'mt-4' : undefined} />
  ),
}));

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
import { DMMessageList } from '../../components/dm/DMMessageList';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A Tailwind class that puts a margin on the top or bottom edge (m-, my-, mt-, mb-, negative too). */
const VERTICAL_MARGIN_RE = /^-?m[ytb]?-/;
const verticalMargins = (el: Element) => Array.from(el.classList).filter((c) => VERTICAL_MARGIN_RE.test(c));

const T0 = Date.parse('2026-11-05T10:00:00.000Z');
// Alternating authors, a minute apart: every row after the first starts a group.
const conversation = (scope: { channelId: string | null; conversationId: string | null }): Message[] =>
  Array.from({ length: 6 }, (_, i): Message => {
    const author: MessageAuthor = { id: i % 2 ? 'me' : 'u-alice', username: i % 2 ? 'me' : 'alice', displayName: i % 2 ? 'Me' : 'Alice', avatarUrl: null };
    return {
      id: `m${i}`, content: `turn ${i}`, type: 'user', ...scope, author, mentions: [],
      createdAt: new Date(T0 + i * 60_000).toISOString(), editedAt: null, reactions: [],
    };
  });

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => { root.render(node); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}
const slots = (kind: string) => Array.from(container.querySelectorAll(`[data-slot="${kind}"]`));
/** The element a slot holds: the box whose own margins Virtuoso cannot see. */
const boxIn = (slot: Element) => {
  expect(slot.children, 'one root element per measured box').toHaveLength(1);
  return slot.children[0];
};

function expectMarginsContained() {
  const rows = slots('row');
  expect(rows.length).toBeGreaterThan(0);
  for (const slot of rows) {
    const box = boxIn(slot);
    expect(verticalMargins(box), `row ${slot.getAttribute('data-row-id')} has no margin of its own`).toEqual([]);
    // A row holding a MessageItem contains its group margin.
    if (box.querySelector('[data-message-id]')) {
      expect(box.classList.contains('flow-root'), `row ${slot.getAttribute('data-row-id')} is flow-root`).toBe(true);
    }
  }
  // The stub put the group margin in, so the pin above is not vacuous.
  expect(container.querySelectorAll('[data-message-id].mt-4').length).toBeGreaterThan(0);

  for (const kind of ['header', 'footer']) {
    const [slot] = slots(kind);
    expect(slot, `${kind} rendered`).toBeDefined();
    expect(verticalMargins(boxIn(slot)), `${kind} has no margin of its own`).toEqual([]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetServerPermissionsCache();
  chatState.hasMore = false;
  chatState.targetMessageId = null;
  serverState.activeServerId = 'srv-1';
  serverState.activeChannelId = 'ch-1';
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

describe('message lists keep vertical space inside what Virtuoso measures', () => {
  it('channel list: rows contain the group margin; the header and the footer carry none', async () => {
    chatState.messages = conversation({ channelId: 'ch-1', conversationId: null });
    await render(<MessageList />);
    expectMarginsContained();
  });

  it('DM list: rows contain the group margin; a call notice, the header and the footer carry none', async () => {
    const messages = conversation({ channelId: null, conversationId: 'dm-1' });
    messages.splice(3, 0, {
      ...messages[2], id: 'sys-1', type: 'system', content: 'Call started', author: messages[0].author,
    });
    chatState.messages = messages;
    await render(<DMMessageList conversationId="dm-1" />);

    const notice = slots('row').find((s) => s.getAttribute('data-row-id') === 'sys-1');
    expect(notice, 'the call notice is rendered as its own row').toBeDefined();
    expect(boxIn(notice!).querySelector('[data-message-id]')).toBeNull();
    expectMarginsContained();
  });
});
