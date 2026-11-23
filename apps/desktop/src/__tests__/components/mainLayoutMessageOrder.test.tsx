import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '@voxium/shared';

/**
 * MainLayout's message handlers for secure channels and direct conversations
 * await the display gate before they reach the chat store, while a delete is
 * applied at once. Whatever order the decrypts finish in, the view ends with
 * what was sent last: a delete wins over a late insert or edit, the newest
 * edit is what is shown, rows stand in the order of the server's time, and a
 * decrypt that outlives a change of view, or the session, lands nowhere.
 *
 * MainLayout is mounted with its children and every service around it
 * replaced; the chat store is the real one. The fake socket hands back the
 * handlers MainLayout registers, and the gate answers when each test says so.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

const H = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  gate: [] as Array<{ row: Message; resolve: (shown: Message | null) => void }>,
  sounds: { message: vi.fn(), mention: vi.fn() },
  dm: {
    incrementDMUnread: vi.fn(),
    markConversationRead: vi.fn(),
    updateLastMessage: vi.fn(),
    forgetRemoval: vi.fn(),
    fetchConversations: vi.fn(async () => undefined),
    fetchConversationsFor: vi.fn(async () => undefined),
  },
  server: { incrementUnread: vi.fn(), markChannelRead: vi.fn() },
}));

/** The gate's answer for a row, held until the test releases it. */
function gated(row: Message): Promise<Message | null> {
  return new Promise((resolve) => H.gate.push({ row, resolve }));
}
vi.mock('../../services/e2e/channelCrypto', () => ({
  decryptChannelMessageForDisplay: vi.fn((row: Message) => gated(row)),
  decryptChannelMessagesForDisplay: vi.fn(async (rows: Message[]) => rows),
  prepareOutgoingChannelMessage: vi.fn(),
  cacheSentChannelPlaintext: vi.fn(),
}));
vi.mock('../../services/e2e/dmCrypto', () => ({
  decryptMessageForDisplay: vi.fn((row: Message) => gated(row)),
  decryptMessagesForDisplay: vi.fn(async (rows: Message[]) => rows),
  prepareOutgoingDM: vi.fn(),
  cacheSentPlaintext: vi.fn(),
}));
vi.mock('../../services/e2e/e2eService', () => ({ E2EPeerNotReadyError: class extends Error {} }));

vi.mock('../../services/socket', () => ({
  getSocket: () => ({
    connected: true,
    id: 'socket-1',
    on: (event: string, fn: (...args: unknown[]) => unknown) => { H.handlers.set(event, fn); },
    off: () => {},
    emit: () => {},
  }),
  getSocketGeneration: () => 1,
  onConnectionStatusChange: () => () => {},
}));
vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../services/notificationSounds', () => ({
  playJoinSound: vi.fn(), playLeaveSound: vi.fn(),
  playMessageSound: H.sounds.message, playMentionSound: H.sounds.mention,
}));
vi.mock('../../services/notifications', () => ({ initNotifications: vi.fn(), notify: vi.fn(async () => undefined) }));
vi.mock('../../services/audioAnalyser', () => ({ stopSpeakingDetection: vi.fn() }));
vi.mock('../../services/e2e/secureVoiceKeys', () => ({ handleInboundKey: vi.fn(), handleKeyRequest: vi.fn() }));
vi.mock('../../services/resume', () => ({ handleAppResume: vi.fn() }));
vi.mock('../../services/discoverySocketHandlers', () => ({ discoverySocketHandlers: {} }));
vi.mock('../../services/webhookSocketHandlers', () => ({
  handleMessageBulkDeleted: vi.fn(),
  handleWebhookMessagesDetached: vi.fn(),
  isPurgedWebhookMessage: vi.fn(() => false),
  withDetachedWebhookLabel: vi.fn((m: unknown) => m),
}));
vi.mock('../../services/dmReadOnly', () => ({ handleConversationReadOnly: vi.fn(), standsAsDeletedNow: () => false }));
vi.mock('../../services/dmClearedHistory', () => ({ readConversationRemovedNotice: () => null }));
vi.mock('../../hooks/usePushToTalk', () => ({ usePushToTalk: () => {} }));

vi.mock('../../stores/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: { id: 'me' } as { id: string } | null })) };
});
vi.mock('../../stores/serverStore', async () => {
  const { create } = await import('zustand');
  return {
    useServerStore: create(() => ({
      activeServerId: 'srv' as string | null,
      activeChannelId: 'sec' as string | null,
      channels: [{ id: 'sec', serverId: 'srv', secure: true }, { id: 'sec-2', serverId: 'srv', secure: true }, { id: 'plain', serverId: 'srv', secure: false }],
      members: [],
      secureChannelMembers: {},
      fetchServers: vi.fn(),
      fetchPeople: vi.fn(),
      incrementUnread: H.server.incrementUnread,
      markChannelRead: H.server.markChannelRead,
    })),
  };
});
vi.mock('../../stores/dmStore', async () => {
  const { create } = await import('zustand');
  return {
    useDMStore: create(() => ({
      activeConversationId: null as string | null,
      conversations: [{ id: 'c-1' }, { id: 'c-2' }] as Array<{ id: string }>,
      ...H.dm,
    })),
    isConversationReadOnly: () => false,
  };
});
vi.mock('../../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  return {
    useVoiceStore: create(() => ({
      screenSharingUserId: null, screenShareViewMode: 'inline', activeChannelId: null, setLocalUserId: vi.fn(),
    })),
    teardownSecureVoice: vi.fn(),
  };
});
vi.mock('../../stores/e2eStore', () => ({ useE2EStore: { getState: () => ({ initialize: vi.fn(async () => undefined) }) } }));
vi.mock('../../stores/friendStore', async () => {
  const { create } = await import('zustand');
  return { useFriendStore: create(() => ({ showFriendsView: false, fetchFriends: vi.fn() })) };
});
vi.mock('../../stores/supportStore', async () => {
  const { create } = await import('zustand');
  return { useSupportStore: create(() => ({ showSupportView: false, fetchTicket: vi.fn() })) };
});
vi.mock('../../stores/settingsStore', async () => {
  const { create } = await import('zustand');
  return { useSettingsStore: create(() => ({ isSettingsOpen: false, enableNotificationSounds: true, enableDesktopNotifications: false })) };
});
vi.mock('../../stores/announcementStore', () => ({ useAnnouncementStore: { getState: () => ({}) } }));
vi.mock('../../stores/annotationStore', () => ({ useAnnotationStore: { getState: () => ({}) } }));
vi.mock('../../stores/annotationLiveStore', () => ({ useAnnotationLiveStore: { getState: () => ({}) } }));

vi.mock('../../components/server/SpacesStrip', () => ({ SpacesStrip: () => null }));
vi.mock('../../components/channel/ChannelSidebar', () => ({ ChannelSidebar: () => null }));
vi.mock('../../components/chat/ChatArea', () => ({ ChatArea: () => null }));
vi.mock('../../components/server/MemberSidebar', () => ({ MemberSidebar: () => null }));
vi.mock('../../components/settings/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('../../components/layout/ConnectionBanner', () => ({ ConnectionBanner: () => null }));
vi.mock('../../components/dm/DMList', () => ({ DMList: () => null }));
vi.mock('../../components/dm/DMChatArea', () => ({ DMChatArea: () => null }));
vi.mock('../../components/dm/IncomingCallModal', () => ({ IncomingCallModal: () => null }));
vi.mock('../../components/friends/FriendsView', () => ({ FriendsView: () => null }));
vi.mock('../../components/dm/SupportTicketView', () => ({ SupportTicketView: () => null }));
vi.mock('../../components/search/SearchModal', () => ({ SearchModal: () => null }));
vi.mock('../../components/layout/UserCard', () => ({ UserCard: () => null }));
vi.mock('../../components/voice/ScreenShareViewer', () => ({ ScreenShareViewer: () => null }));
vi.mock('../../components/voice/ScreenShareFloating', () => ({ ScreenShareFloating: () => null }));
vi.mock('../../components/layout/AnnouncementBanner', () => ({ AnnouncementBanner: () => null }));
vi.mock('../../components/voice/SharePreflightModal', () => ({ SharePreflightModal: () => null }));

import { MainLayout } from '../../components/layout/MainLayout';
import { useChatStore, channelView, conversationView, type ChatViewScope } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../services/api';
import { isPurgedWebhookMessage, withDetachedWebhookLabel } from '../../services/webhookSocketHandlers';
import { decryptMessagesForDisplay } from '../../services/e2e/dmCrypto';
import { deletedMessageRow, refusedRow } from '../../services/e2e/displayGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const peer = { id: 'u-peer', username: 'peer', displayName: 'Peer', avatarUrl: null };
const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;
const EDIT = '2026-11-20T10:30:00.000Z';

/** A row as the server sends it: ciphertext under the peer's name. */
function wire(scope: 'channel' | 'dm', id: string, over: Partial<Message> = {}): Message {
  return {
    id, type: 'user', content: '{"v":1,"e":"megolm1","sid":"c2lk","b":"Y2lwaGVy"}', encrypted: true,
    channelId: scope === 'channel' ? 'sec' : null, conversationId: scope === 'dm' ? 'c-1' : null,
    author: peer, createdAt: at(1), editedAt: null, reactions: [], attachments: [], mentions: [], replyTo: null,
    ...over,
  } as Message;
}
/** What the gate answers when it opens a row: its text. */
const opened = (row: Message, text: string): Message => ({ ...row, content: text });

/** Waits until the handlers have handed `count` rows to the gate (each first awaits a dynamic import). */
async function gateCalls(count: number): Promise<void> {
  // generous: other suites may share the machine, and each handler first awaits a dynamic import
  await vi.waitFor(() => expect(H.gate).toHaveLength(count), { timeout: 10_000, interval: 5 });
}
/** Releases the gate call of row `id` (the `n`-th one of it) with `shown`, and lets its handler finish. */
async function answer(id: string, shown: Message | null, pending: Promise<unknown>, n = 0): Promise<void> {
  const calls = H.gate.filter((c) => c.row.id === id);
  calls[n].resolve(shown);
  await act(async () => { await pending; });
}

const fire = (event: string, payload: unknown): Promise<unknown> => {
  const handler = H.handlers.get(event);
  if (!handler) throw new Error(`${event} is not registered`);
  return Promise.resolve(handler(payload));
};
const shown = () => useChatStore.getState().messages;
const texts = () => shown().map((m) => `${m.id}:${m.content}`);

let container: HTMLDivElement;
let root: Root;

// The mocked stores hold only what MainLayout reads: their setters are typed
// against the real stores, so the partial states are cast once, here.
function signIn(userId: string) {
  useAuthStore.setState({ user: { id: userId } } as never);
}
function setConversations(ids: string[], activeConversationId?: string | null) {
  useDMStore.setState({
    conversations: ids.map((id) => ({ id })),
    ...(activeConversationId !== undefined && { activeConversationId }),
  } as never);
}
/** The person moves to the channel: nothing in the chat store changes until its view fetches. */
function navigateToChannel(channelId = 'sec') {
  useServerStore.setState({ activeServerId: 'srv', activeChannelId: channelId });
}
/** The person moves to the conversation: the same. */
function navigateToConversation(conversationId = 'c-1') {
  useServerStore.setState({ activeServerId: null });
  useDMStore.setState({ activeConversationId: conversationId });
}
/** The channel on screen, its view open in the chat store (as its fetch records it). */
function viewChannel(channelId = 'sec') {
  navigateToChannel(channelId);
  useChatStore.setState({ viewScope: channelView(channelId) });
}
/** The conversation on screen, its view open in the chat store. */
function viewConversation(conversationId = 'c-1') {
  navigateToConversation(conversationId);
  useChatStore.setState({ viewScope: conversationView(conversationId) });
}
/** The view's own fetch of its newest page, through the real store (the page goes through the gate mocks). */
async function loadChannel(channelId: string, rows: Message[]): Promise<void> {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { data: rows, hasMore: false } });
  await act(async () => { await useChatStore.getState().fetchMessages(channelId); });
}
async function loadConversation(conversationId: string, rows: Message[]): Promise<void> {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { data: rows, hasMore: false } });
  await act(async () => { await useChatStore.getState().fetchDMMessages(conversationId); });
}

beforeEach(async () => {
  vi.clearAllMocks();
  H.gate.length = 0;
  H.handlers.clear();
  signIn('me');
  useServerStore.setState({ activeServerId: 'srv', activeChannelId: 'sec' });
  setConversations(['c-1', 'c-2'], null);
  useChatStore.getState().clearMessages();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<MainLayout />); });
  expect(H.handlers.has('message:new')).toBe(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const PATHS: Array<{
  name: string; scope: 'channel' | 'dm'; chat: ChatViewScope; view: () => void; reload: (rows: Message[]) => Promise<void>;
  added: string; edited: string; deleted: string; where: Record<string, string>;
}> = [
  {
    name: 'a secure channel', scope: 'channel', chat: channelView('sec'), view: () => viewChannel(),
    reload: (rows) => loadChannel('sec', rows),
    added: 'message:new', edited: 'message:update', deleted: 'message:delete', where: { channelId: 'sec' },
  },
  {
    name: 'a direct conversation', scope: 'dm', chat: conversationView('c-1'), view: () => viewConversation(),
    reload: (rows) => loadConversation('c-1', rows),
    added: 'dm:message:new', edited: 'dm:message:update', deleted: 'dm:message:delete', where: { conversationId: 'c-1' },
  },
];

for (const path of PATHS) {
  describe(`${path.name}: the view ends with what was sent last`, () => {
    beforeEach(() => path.view());

    it('a delete that arrives while the insert is still decrypting wins: the row never shows', async () => {
      const m1 = wire(path.scope, 'm1');
      const inserting = fire(path.added, m1);
      await gateCalls(1);
      await fire(path.deleted, { messageId: 'm1', ...path.where });
      await answer('m1', opened(m1, 'hello'), inserting);

      expect(shown()).toEqual([]);
      // no news of it either
      expect(H.sounds.mention).not.toHaveBeenCalled();
    });

    it('a delete that arrives while an edit is still decrypting wins too', async () => {
      const m1 = wire(path.scope, 'm1');
      useChatStore.getState().addMessage(opened(m1, 'hello'), path.chat);
      const editing = fire(path.edited, wire(path.scope, 'm1', { editedAt: EDIT }));
      await gateCalls(1);
      await fire(path.deleted, { messageId: 'm1', ...path.where });
      await answer('m1', opened(wire(path.scope, 'm1', { editedAt: EDIT }), 'edited'), editing);

      expect(shown()).toEqual([]);
    });

    it('an edit that arrives while the insert is still decrypting is what the row shows', async () => {
      const m1 = wire(path.scope, 'm1');
      const edit = wire(path.scope, 'm1', { editedAt: EDIT });
      const inserting = fire(path.added, m1);
      const editing = fire(path.edited, edit);
      await gateCalls(2);
      // the edit's decrypt ends first, the insert's after it
      await answer('m1', opened(edit, 'edited'), editing, 1);
      await answer('m1', opened(m1, 'original'), inserting, 0);

      expect(texts()).toEqual(['m1:edited']);
    });

    it('an insert whose decrypt ends after a newer edit was shown does not put the older text back', async () => {
      const m1 = wire(path.scope, 'm1');
      useChatStore.getState().addMessage(opened(m1, 'original'), path.chat);
      // the same message delivered again (a second socket), then edited
      const again = fire(path.added, m1);
      const editing = fire(path.edited, wire(path.scope, 'm1', { editedAt: EDIT }));
      await gateCalls(2);
      await answer('m1', opened(wire(path.scope, 'm1', { editedAt: EDIT }), 'edited'), editing, 1);
      await answer('m1', opened(m1, 'original'), again, 0);

      expect(texts()).toEqual(['m1:edited']);
    });

    it('two inserts whose decrypts end in the other order stand in the order of their time', async () => {
      const m1 = wire(path.scope, 'm1', { createdAt: at(1) });
      const m2 = wire(path.scope, 'm2', { createdAt: at(2) });
      const first = fire(path.added, m1);
      const second = fire(path.added, m2);
      await gateCalls(2);
      // m2 is answered from the cache at once, m1 needs a real decrypt
      await answer('m2', opened(m2, 'two'), second);
      await answer('m1', opened(m1, 'one'), first);

      expect(texts()).toEqual(['m1:one', 'm2:two']);
    });

    it('a decrypt that ends after the view moved to the other kind of view lands in neither (the scope is read after the await)', async () => {
      const m1 = wire(path.scope, 'm1');
      const inserting = fire(path.added, m1);
      const editing = fire(path.edited, wire(path.scope, 'm1', { editedAt: EDIT }));
      await gateCalls(2);
      // the person goes from the space to the conversations, or back: nothing
      // clears the chat store on that move until the other view fetches
      if (path.scope === 'channel') navigateToConversation('c-2'); else navigateToChannel('sec-2');
      await answer('m1', opened(m1, 'hello'), inserting, 0);
      await answer('m1', opened(wire(path.scope, 'm1', { editedAt: EDIT }), 'edited'), editing, 1);

      expect(shown()).toEqual([]);
      // and nothing of it waits for that view either
      if (path.scope === 'channel') navigateToChannel(); else navigateToConversation();
      useChatStore.getState().addMessage(opened(m1, 'from the page'), path.chat);
      expect(texts()).toEqual(['m1:from the page']);
    });

    it('a decrypt that ends after the view went away and came back lands nowhere: the new view fetched after it', async () => {
      const m1 = wire(path.scope, 'm1');
      const inserting = fire(path.added, m1);
      const editing = fire(path.edited, wire(path.scope, 'm1', { editedAt: EDIT }));
      await gateCalls(2);
      // away and back: the same scope on screen, a new view of it, loaded
      // (the epoch alone decides here: the scope is the view's again)
      useChatStore.getState().clearMessages();
      await path.reload([]);
      await answer('m1', opened(m1, 'hello'), inserting, 0);
      await answer('m1', opened(wire(path.scope, 'm1', { editedAt: EDIT }), 'edited'), editing, 1);

      expect(shown()).toEqual([]);
    });

    it('an edit whose decrypt ends after a reload of the same view leaves the reloaded row as the page brought it', async () => {
      const m1 = wire(path.scope, 'm1');
      const shownFirst = opened(m1, 'original');
      await path.reload([shownFirst]);
      const editing = fire(path.edited, wire(path.scope, 'm1', { editedAt: EDIT }));
      await gateCalls(1);
      // a reconnect of the view: cleared, the same page again
      useChatStore.getState().clearMessages();
      const reloaded = opened(m1, 'original');
      await path.reload([reloaded]);
      await answer('m1', opened(wire(path.scope, 'm1', { editedAt: EDIT }), 'edited'), editing);

      expect(shown()).toEqual([reloaded]);
      expect(shown()[0]).toBe(reloaded);
    });

    it('a decrypt that ends after the session did is dropped', async () => {
      const m1 = wire(path.scope, 'm1');
      const inserting = fire(path.added, m1);
      await gateCalls(1);
      signIn('someone-else');
      await answer('m1', opened(m1, 'hello'), inserting);
      // and a gate that answers nothing (the session ended under it) adds nothing
      signIn('me');
      const again = fire(path.added, wire(path.scope, 'm2'));
      await gateCalls(2);
      await answer('m2', null, again);

      expect(shown()).toEqual([]);
    });
  });
}

describe('a secure channel: the mention of a row the view does not show plays no sound', () => {
  it('a mention whose row was deleted while it decrypted is silent; one that lands is heard', async () => {
    viewChannel();
    const mention = (id: string) => wire('channel', id, { mentions: [{ id: 'me', username: 'me', displayName: 'Me' }] } as Partial<Message>);
    const deleted = fire('message:new', mention('m1'));
    await gateCalls(1);
    await fire('message:delete', { messageId: 'm1', channelId: 'sec' });
    await answer('m1', opened(mention('m1'), 'hey @me'), deleted);
    expect(H.sounds.mention).not.toHaveBeenCalled();

    const kept = fire('message:new', mention('m2'));
    await gateCalls(2);
    await answer('m2', opened(mention('m2'), 'hey @me'), kept);
    expect(H.sounds.mention).toHaveBeenCalledTimes(1);
  });
});

describe('a direct conversation: the view on screen is read after every await', () => {
  it('a first message of a conversation not listed yet, while the person moved to another one, is counted as unread there, not shown', async () => {
    viewConversation('c-1');
    setConversations(['c-2']);
    let listed!: () => void;
    H.dm.fetchConversationsFor.mockImplementationOnce(() => new Promise<undefined>((resolve) => { listed = () => resolve(undefined); }));
    const m1 = wire('dm', 'm1');
    const inserting = fire('dm:message:new', m1);
    await gateCalls(1);
    H.gate[0].resolve(opened(m1, 'hello'));
    await vi.waitFor(() => expect(H.dm.fetchConversationsFor).toHaveBeenCalled(), { timeout: 10_000, interval: 5 });
    // the list is on its way; the person opens another conversation meanwhile
    setConversations(['c-1', 'c-2'], 'c-2');
    await act(async () => { listed(); await inserting; });

    expect(shown()).toEqual([]);
    expect(H.dm.incrementDMUnread).toHaveBeenCalledWith('c-1');
    expect(H.sounds.message).toHaveBeenCalledTimes(1);
  });
});

describe('the chat store takes nothing for another channel or conversation than its rows belong to', () => {
  // The one state where the handlers' own view checks and the store's disagree:
  // the screen shows one scope while the store still records the other (the
  // view on screen has not fetched yet). A handler passes the scope its event
  // names; the store compares it with the one it recorded.

  it('the conversation on screen, the channel recorded: a DM insert, edit, deleted row, delete and reaction change nothing', async () => {
    navigateToChannel();
    const held = opened(wire('channel', 'X'), 'channel words');
    await loadChannel('sec', [held]);
    navigateToConversation('c-1');
    const before = shown();
    expect(before).toEqual([held]);

    const inserting = fire('dm:message:new', wire('dm', 'Y'));
    const editing = fire('dm:message:update', wire('dm', 'X', { editedAt: EDIT }));
    const replacing = fire('dm:message:new', wire('dm', 'X', { type: 'deleted' as Message['type'] }));
    await gateCalls(3);
    await answer('Y', opened(wire('dm', 'Y'), 'a new message'), inserting);
    await answer('X', opened(wire('dm', 'X', { editedAt: EDIT }), 'their edit'), editing, 0);
    await answer('X', deletedMessageRow(wire('dm', 'X'), 'c-1'), replacing, 1);
    await fire('dm:message:reaction_update', { messageId: 'X', conversationId: 'c-1', reactions: [{ emoji: '👍', count: 1, userIds: ['u-peer'] }] });
    await fire('dm:message:delete', { messageId: 'X', conversationId: 'c-1' });

    expect(shown()).toBe(before);
  });

  it('the channel on screen, the conversation recorded: a channel insert, edit, delete and reaction change nothing', async () => {
    navigateToConversation('c-1');
    const held = opened(wire('dm', 'X'), 'their words');
    await loadConversation('c-1', [held]);
    navigateToChannel('sec');
    const before = shown();
    expect(before).toEqual([held]);

    const inserting = fire('message:new', wire('channel', 'Y'));
    const editing = fire('message:update', wire('channel', 'X', { editedAt: EDIT }));
    await gateCalls(2);
    await answer('Y', opened(wire('channel', 'Y'), 'a new message'), inserting);
    await answer('X', opened(wire('channel', 'X', { editedAt: EDIT }), 'channel edit'), editing);
    await fire('message:reaction_update', { messageId: 'X', channelId: 'sec', reactions: [{ emoji: '👍', count: 1, userIds: ['u-peer'] }] });
    await fire('message:delete', { messageId: 'X', channelId: 'sec' });

    expect(shown()).toBe(before);
  });

  it('a secure channel\'s row on screen never stands in the conversation opened next with no clear (X7)', async () => {
    navigateToChannel();
    await loadChannel('sec', [opened(wire('channel', 'X', { editedAt: EDIT }), 'channel words')]);
    // the strip's avatar: the conversation already active behind the space, nothing cleared
    navigateToConversation('c-1');
    const answered = [refusedRow(wire('dm', 'X'))];
    vi.mocked(decryptMessagesForDisplay).mockImplementationOnce(async () => answered);
    await loadConversation('c-1', [wire('dm', 'X')]);

    expect(shown()).toEqual(answered);
    expect(shown()[0]).toBe(answered[0]);
  });

  it('an edit a secure channel kept for a row it did not show never reaches the conversation opened next (X8)', async () => {
    navigateToChannel();
    await loadChannel('sec', [opened(wire('channel', 'a1'), 'shown')]);
    const editing = fire('message:update', wire('channel', 'X', { editedAt: EDIT }));
    await gateCalls(1);
    await answer('X', opened(wire('channel', 'X', { editedAt: EDIT }), 'channel edit'), editing);
    navigateToConversation('c-1');
    const answered = [refusedRow(wire('dm', 'X'))];
    vi.mocked(decryptMessagesForDisplay).mockImplementationOnce(async () => answered);
    await loadConversation('c-1', [wire('dm', 'X')]);

    expect(shown()).toEqual(answered);
    expect(shown()[0]).toBe(answered[0]);
  });

  it('a plaintext channel\'s edit, which no gate saw, never shows in the encrypted conversation opened next (X9)', async () => {
    navigateToChannel('plain');
    const plain = (id: string, over: Partial<Message> = {}) =>
      ({ ...wire('channel', id, over), channelId: 'plain', encrypted: false, content: `text of ${id}` }) as Message;
    await loadChannel('plain', [plain('a1')]);
    await fire('message:update', { ...plain('X', { editedAt: EDIT }), content: 'words the peer never wrote' });
    expect(H.gate).toHaveLength(0);
    navigateToConversation('c-1');
    const answered = [refusedRow(wire('dm', 'X'))];
    vi.mocked(decryptMessagesForDisplay).mockImplementationOnce(async () => answered);
    await loadConversation('c-1', [wire('dm', 'X')]);

    expect(shown()).toEqual(answered);
    expect(shown().some((m) => m.content === 'words the peer never wrote')).toBe(false);
  });
});

describe('a direct conversation: a deleted account\'s row lands in the view it was gated for only', () => {
  it('a reload of the same conversation while its decrypt ran: the reloaded row stands', async () => {
    viewConversation('c-1');
    await loadConversation('c-1', [opened(wire('dm', 'X'), 'their words')]);
    const replacing = fire('dm:message:new', wire('dm', 'X', { type: 'deleted' as Message['type'] }));
    await gateCalls(1);
    useChatStore.getState().clearMessages();
    const reloaded = opened(wire('dm', 'X'), 'their words');
    await loadConversation('c-1', [reloaded]);
    await answer('X', deletedMessageRow(wire('dm', 'X'), 'c-1'), replacing);

    expect(shown()).toEqual([reloaded]);
    expect(shown()[0]).toBe(reloaded);
  });

  it('the same view: it replaces the row with its id', async () => {
    viewConversation('c-1');
    await loadConversation('c-1', [opened(wire('dm', 'X'), 'their words')]);
    const replacing = fire('dm:message:new', wire('dm', 'X', { type: 'deleted' as Message['type'] }));
    await gateCalls(1);
    const placeholder = deletedMessageRow(wire('dm', 'X'), 'c-1');
    await answer('X', placeholder, replacing);

    expect(shown()).toEqual([placeholder]);
  });
});

describe('a row the view does not show arms no mark-read', () => {
  afterEach(() => { vi.useRealTimers(); });

  for (const path of PATHS) {
    it(`${path.name}: a row deleted while it decrypted is not marked read; one that lands is`, async () => {
      path.view();
      const markRead = path.scope === 'dm' ? H.dm.markConversationRead : H.server.markChannelRead;
      const deleted = fire(path.added, wire(path.scope, 'm1'));
      await gateCalls(1);
      await fire(path.deleted, { messageId: 'm1', ...path.where });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      markRead.mockClear();
      await answer('m1', opened(wire(path.scope, 'm1'), 'hello'), deleted);
      vi.advanceTimersByTime(5_000);
      expect(markRead).not.toHaveBeenCalled();
      vi.useRealTimers();

      const kept = fire(path.added, wire(path.scope, 'm2'));
      await gateCalls(2);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await answer('m2', opened(wire(path.scope, 'm2'), 'hello'), kept);
      vi.advanceTimersByTime(5_000);
      expect(markRead).toHaveBeenCalledTimes(1);
    });
  }
});

describe('a row the view shows after the call is news, as when it lands', () => {
  afterEach(() => { vi.useRealTimers(); });
  const mention = (id: string) => wire('channel', id, { mentions: [{ id: 'me', username: 'me', displayName: 'Me' }] } as Partial<Message>);

  it('a secure channel: a mention whose row a page brought in first sounds once and arms the mark-read timer (X6)', async () => {
    viewChannel();
    const inserting = fire('message:new', mention('m1'));
    await gateCalls(1);
    // the page's copy lands while the insert is still decrypting
    await loadChannel('sec', [opened(mention('m1'), 'hey @me')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.server.markChannelRead.mockClear();
    await answer('m1', opened(mention('m1'), 'hey @me'), inserting);

    expect(texts()).toEqual(['m1:hey @me']);
    expect(H.sounds.mention).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(H.server.markChannelRead).toHaveBeenCalledTimes(1);
    expect(H.server.incrementUnread).not.toHaveBeenCalled();
  });

  it('a secure channel: a mention whose decrypt outlives a reload of its channel, whose page shows it, sounds once and arms the timer (E2)', async () => {
    viewChannel();
    const inserting = fire('message:new', mention('m1'));
    await gateCalls(1);
    // a reconnect of the channel: cleared, loaded again, the message in its page
    act(() => useChatStore.getState().clearMessages());
    const fromThePage = opened(mention('m1'), 'hey @me');
    await loadChannel('sec', [fromThePage]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.server.markChannelRead.mockClear();
    await answer('m1', opened(mention('m1'), 'hey @me (the gated copy)'), inserting);

    // nothing of the copy gated for the earlier view applies
    expect(shown()).toEqual([fromThePage]);
    expect(H.sounds.mention).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(H.server.markChannelRead).toHaveBeenCalledTimes(1);
  });

  it('a direct conversation: a row a page brought in first arms the mark-read timer, and counts no unread', async () => {
    viewConversation();
    const inserting = fire('dm:message:new', wire('dm', 'm1'));
    await gateCalls(1);
    await loadConversation('c-1', [opened(wire('dm', 'm1'), 'hello')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.dm.markConversationRead.mockClear();
    await answer('m1', opened(wire('dm', 'm1'), 'hello'), inserting);

    expect(texts()).toEqual(['m1:hello']);
    vi.advanceTimersByTime(2_000);
    expect(H.dm.markConversationRead).toHaveBeenCalledTimes(1);
    expect(H.dm.incrementDMUnread).not.toHaveBeenCalled();
    expect(H.sounds.message).not.toHaveBeenCalled();
  });

  it('a mention deleted while it decrypted sounds nothing and arms nothing', async () => {
    viewChannel();
    const inserting = fire('message:new', mention('m1'));
    await gateCalls(1);
    await fire('message:delete', { messageId: 'm1', channelId: 'sec' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.server.markChannelRead.mockClear();
    await answer('m1', opened(mention('m1'), 'hey @me'), inserting);

    expect(shown()).toEqual([]);
    expect(H.sounds.mention).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(H.server.markChannelRead).not.toHaveBeenCalled();
    expect(H.server.incrementUnread).not.toHaveBeenCalled();
  });

  it('the channel selected while the store holds another scope\'s view (a share fills the chat panel): its message is not shown and is news like another channel\'s', async () => {
    navigateToChannel();
    // the conversation's fetch recorded it; no view of the channel is loaded
    await loadConversation('c-1', [opened(wire('dm', 'X'), 'their words')]);
    const before = shown();
    const inserting = fire('message:new', { ...mention('m1'), serverId: 'srv' });
    await gateCalls(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.server.markChannelRead.mockClear();
    await answer('m1', opened(mention('m1'), 'hey @me'), inserting);

    expect(shown()).toBe(before);
    expect(H.server.incrementUnread).toHaveBeenCalledTimes(1);
    expect(H.server.incrementUnread).toHaveBeenCalledWith('sec', 'srv');
    expect(H.sounds.mention).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(H.server.markChannelRead).not.toHaveBeenCalled();
  });

  it('the channel selected while the store records no view at all: the same', async () => {
    navigateToChannel();
    act(() => useChatStore.getState().clearMessages());
    const inserting = fire('message:new', { ...mention('m1'), serverId: 'srv' });
    await gateCalls(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.server.markChannelRead.mockClear();
    await answer('m1', opened(mention('m1'), 'hey @me'), inserting);

    expect(shown()).toEqual([]);
    expect(H.server.incrementUnread).toHaveBeenCalledWith('sec', 'srv');
    expect(H.sounds.mention).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(H.server.markChannelRead).not.toHaveBeenCalled();
  });

  it('one\'s own message in a channel selected with no view of it loaded is no news', async () => {
    navigateToChannel();
    act(() => useChatStore.getState().clearMessages());
    const own = { ...wire('channel', 'm1'), serverId: 'srv', author: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } } as unknown as Message;
    const inserting = fire('message:new', own);
    await gateCalls(1);
    await answer('m1', opened(own, 'mine'), inserting);

    expect(H.server.incrementUnread).not.toHaveBeenCalled();
    expect(H.sounds.mention).not.toHaveBeenCalled();
    expect(H.sounds.message).not.toHaveBeenCalled();
  });

  it('the conversation on screen while the store holds another scope\'s view: the same', async () => {
    navigateToConversation('c-1');
    // the channel's fetch recorded it; the conversation's view has not fetched yet
    await loadChannel('sec', [opened(wire('channel', 'X'), 'channel words')]);
    const before = shown();
    const inserting = fire('dm:message:new', wire('dm', 'm1'));
    await gateCalls(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.dm.markConversationRead.mockClear();
    await answer('m1', opened(wire('dm', 'm1'), 'hello'), inserting);

    expect(shown()).toBe(before);
    vi.advanceTimersByTime(2_000);
    expect(H.dm.markConversationRead).not.toHaveBeenCalled();
    expect(H.dm.incrementDMUnread).not.toHaveBeenCalled();
    expect(H.sounds.message).not.toHaveBeenCalled();
  });
});

describe('a reaction for the scope on screen is applied', () => {
  for (const path of PATHS) {
    it(`${path.name}: the reaction lands on the row shown`, async () => {
      path.view();
      await path.reload([opened(wire(path.scope, 'X'), 'words')]);
      const reactions = [{ emoji: '👍', count: 1, userIds: ['u-peer'] }];
      await fire(path.scope === 'dm' ? 'dm:message:reaction_update' : 'message:reaction_update', { messageId: 'X', ...path.where, reactions });

      expect(shown()[0].reactions).toEqual(reactions);
    });
  }
});

describe('a delivery of a webhook purged a moment ago', () => {
  const plain = (id: string, webhookId: string | null): Message => ({
    id, type: 'user', content: 'late', encrypted: false, channelId: 'ch-1', conversationId: null, serverId: 'srv',
    author: { id: webhookId ? `webhook:${webhookId}` : 'u-other', username: 'bot', displayName: 'bot', avatarUrl: null, isWebhook: !!webhookId },
    webhookId, createdAt: at(1), editedAt: null, reactions: [], attachments: [], mentions: [], replyTo: null,
  } as unknown as Message);

  afterEach(() => { vi.mocked(isPurgedWebhookMessage).mockReturnValue(false); });

  it('is neither shown, counted nor heard: its message:new is dropped before anything reads it; another sender is not', async () => {
    viewChannel('ch-1');
    vi.mocked(isPurgedWebhookMessage).mockImplementation((m) => m?.webhookId === 'wh-purged');

    await act(async () => { await fire('message:new', plain('late', 'wh-purged')); });
    expect(shown()).toEqual([]);
    expect(H.server.incrementUnread).not.toHaveBeenCalled();

    await act(async () => { await fire('message:new', plain('kept', 'wh-live')); });
    expect(shown().map((m) => m.id)).toEqual(['kept']);
  });

  it('in a channel NOT on screen it is not counted as unread either', async () => {
    navigateToChannel('ch-other');
    vi.mocked(isPurgedWebhookMessage).mockReturnValue(true);
    await act(async () => { await fire('message:new', plain('late', 'wh-purged')); });
    expect(H.server.incrementUnread).not.toHaveBeenCalled();

    vi.mocked(isPurgedWebhookMessage).mockReturnValue(false);
    await act(async () => { await fire('message:new', plain('live', 'wh-live')); });
    expect(H.server.incrementUnread).toHaveBeenCalledWith('ch-1', 'srv');
  });
});

describe('a delivery of a webhook deleted without purge a moment ago', () => {
  it('is shown, with the deleted webhook\'s label, as the server serves it at the next fetch', async () => {
    viewChannel('ch-1');
    vi.mocked(withDetachedWebhookLabel).mockImplementation(((m: Message) => (m.webhookId === 'wh-gone'
      ? { ...m, webhookId: null, author: { ...m.author, id: 'webhook:deleted' } }
      : m)) as never);
    const row = (id: string, webhookId: string) => ({
      id, type: 'user', content: 'late', encrypted: false, channelId: 'ch-1', conversationId: null, serverId: 'srv',
      author: { id: `webhook:${webhookId}`, username: 'bot', displayName: 'bot', avatarUrl: null, isWebhook: true },
      webhookId, createdAt: at(1), editedAt: null, reactions: [], attachments: [], mentions: [], replyTo: null,
    }) as unknown as Message;

    await act(async () => { await fire('message:new', row('late', 'wh-gone')); });
    await act(async () => { await fire('message:new', row('live', 'wh-live')); });

    const byId = (id: string) => shown().find((m) => m.id === id)!;
    expect(byId('late')).toMatchObject({ webhookId: null, author: { id: 'webhook:deleted' } });
    expect(byId('live')).toMatchObject({ webhookId: 'wh-live', author: { id: 'webhook:wh-live' } });
    vi.mocked(withDetachedWebhookLabel).mockImplementation(((m: unknown) => m) as never);
  });
});
