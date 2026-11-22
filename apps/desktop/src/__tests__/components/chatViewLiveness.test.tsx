import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '@voxium/shared';

/**
 * The view on screen fetches whenever the chat store does not record its
 * channel or conversation, and the store keeps a space's channel view when a
 * conversation kept open behind the space is left. Otherwise a channel stays
 * on screen with no scope recorded and no fetch coming, and every live
 * message for it is dropped. And it fetches no more than before: once per
 * change, reconnect or jump, never in a loop.
 *
 * The real chat store, DM store, ChatArea and DMChatArea; MainLayout's socket
 * handlers for the live messages; everything else replaced. A request counted
 * here is a request for a channel's or a conversation's messages.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

const H = vi.hoisted(() => ({
  handlers: new Map<string, Set<(...args: unknown[]) => unknown>>(),
  socketId: 'socket-1',
  sounds: { message: vi.fn(), mention: vi.fn() },
  server: { incrementUnread: vi.fn(), markChannelRead: vi.fn(), clearUnread: vi.fn() },
  /** Each request for messages, as `channel:<id>` / `dm:<id>`, with `around` when it is one. */
  requests: [] as string[],
  /** What a request for messages answers: a page, or a promise the test settles. */
  answer: (url: string): unknown => {
    void url;
    return Promise.resolve({ data: { data: [], hasMore: false } });
  },
}));

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      const channel = /^\/channels\/([^/]+)\/messages\?(.*)$/.exec(url);
      const dm = /^\/dm\/([^/]+)\/messages\?(.*)$/.exec(url);
      const match = channel ?? dm;
      if (!match) return Promise.resolve({ data: { data: {} } });
      H.requests.push(`${channel ? 'channel' : 'dm'}:${match[1]}${match[2].startsWith('around=') ? ':around' : ''}`);
      return H.answer(url);
    }),
    post: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  },
}));
vi.mock('../../services/socket', () => ({
  getSocket: () => ({
    connected: true,
    get id() { return H.socketId; },
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      const set = H.handlers.get(event) ?? new Set();
      set.add(fn);
      H.handlers.set(event, set);
    },
    off: (event: string, fn: (...args: unknown[]) => unknown) => { H.handlers.get(event)?.delete(fn); },
    emit: () => {},
  }),
  getSocketGeneration: () => 1,
  onConnectionStatusChange: () => () => {},
}));
// the gates answer the row as it came (the store and the views are what is tested)
vi.mock('../../services/e2e/channelCrypto', () => ({
  decryptChannelMessageForDisplay: vi.fn(async (row: Message) => row),
  decryptChannelMessagesForDisplay: vi.fn(async (rows: Message[]) => rows),
  prepareOutgoingChannelMessage: vi.fn(),
  cacheSentChannelPlaintext: vi.fn(),
}));
vi.mock('../../services/e2e/dmCrypto', () => ({
  decryptMessageForDisplay: vi.fn(async (row: Message) => row),
  decryptMessagesForDisplay: vi.fn(async (rows: Message[]) => rows),
  prepareOutgoingDM: vi.fn(),
  cacheSentPlaintext: vi.fn(),
  resolveEncryptedPreview: vi.fn(async () => null),
}));
vi.mock('../../services/e2e/e2eService', () => ({ E2EPeerNotReadyError: class extends Error {} }));
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
vi.mock('../../services/webhookSocketHandlers', () => ({ handleMessageBulkDeleted: vi.fn() }));
vi.mock('../../services/dmReadOnly', () => ({
  handleConversationReadOnly: vi.fn(), standsAsDeletedNow: () => false,
  applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn(),
}));
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
      activeChannelId: 'a' as string | null,
      channels: [
        { id: 'a', serverId: 'srv', type: 'text', name: 'a', secure: false },
        { id: 'b', serverId: 'srv', type: 'text', name: 'b', secure: false },
      ],
      members: [],
      secureChannelMembers: {},
      fetchServers: vi.fn(),
      fetchPeople: vi.fn(),
      incrementUnread: H.server.incrementUnread,
      markChannelRead: H.server.markChannelRead,
      clearUnread: H.server.clearUnread,
    })),
  };
});
vi.mock('../../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  return {
    useVoiceStore: create(() => ({
      screenSharingUserId: null, screenShareViewMode: 'inline', activeChannelId: null, dmCallConversationId: null,
      setLocalUserId: vi.fn(), joinDMCall: vi.fn(), leaveDMCall: vi.fn(),
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

// the two message lists show the rows the chat store holds, nothing else
vi.mock('../../components/chat/MessageList', async () => {
  const { useChatStore: chat } = await import('../../stores/chatStore');
  return {
    MessageList: () => <ul>{chat((s) => s.messages).map((m) => <li key={m.id} data-message-id={m.id}>{m.content}</li>)}</ul>,
  };
});
vi.mock('../../components/dm/DMMessageList', async () => {
  const { useChatStore: chat } = await import('../../stores/chatStore');
  return {
    DMMessageList: () => <ul>{chat((s) => s.messages).map((m) => <li key={m.id} data-message-id={m.id}>{m.content}</li>)}</ul>,
  };
});
vi.mock('../../components/chat/MessageInput', () => ({ MessageInput: () => null }));
vi.mock('../../components/search/SearchModal', () => ({ SearchModal: () => null }));
vi.mock('../../components/search/SearchField', () => ({ SearchField: () => null }));
vi.mock('../../components/dm/DMCallPanel', () => ({ DMCallPanel: () => null }));
vi.mock('../../components/dm/E2EControls', () => ({ E2EControls: () => null }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../components/common/UserHoverTarget', () => ({ UserHoverTarget: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../components/server/SpacesStrip', () => ({ SpacesStrip: () => null }));
vi.mock('../../components/channel/ChannelSidebar', () => ({ ChannelSidebar: () => null }));
vi.mock('../../components/server/MemberSidebar', () => ({ MemberSidebar: () => null }));
vi.mock('../../components/settings/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('../../components/layout/ConnectionBanner', () => ({ ConnectionBanner: () => null }));
vi.mock('../../components/dm/DMList', () => ({ DMList: () => null }));
vi.mock('../../components/dm/IncomingCallModal', () => ({ IncomingCallModal: () => null }));
vi.mock('../../components/friends/FriendsView', () => ({ FriendsView: () => null }));
vi.mock('../../components/dm/SupportTicketView', () => ({ SupportTicketView: () => null }));
vi.mock('../../components/layout/UserCard', () => ({ UserCard: () => null }));
vi.mock('../../components/voice/ScreenShareViewer', () => ({ ScreenShareViewer: () => null }));
vi.mock('../../components/voice/ScreenShareFloating', () => ({ ScreenShareFloating: () => null }));
vi.mock('../../components/layout/AnnouncementBanner', () => ({ AnnouncementBanner: () => null }));
vi.mock('../../components/voice/SharePreflightModal', () => ({ SharePreflightModal: () => null }));

import { MainLayout } from '../../components/layout/MainLayout';
import { ChatArea } from '../../components/chat/ChatArea';
import { DMChatArea } from '../../components/dm/DMChatArea';
import { useChatStore, channelView, conversationView, resetChatViewState } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import type { Conversation } from '@voxium/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const peer = { id: 'u-peer', username: 'peer', displayName: 'Peer', avatarUrl: null };
const T0 = '2026-11-20T10:00:00.000Z';

function row(id: string, over: Partial<Message> = {}): Message {
  return {
    id, type: 'user', content: `text of ${id}`, encrypted: false, channelId: 'a', conversationId: null,
    author: peer, createdAt: T0, editedAt: null, reactions: [], attachments: [], mentions: [], replyTo: null,
    ...over,
  } as Message;
}
const dmRow = (id: string, over: Partial<Message> = {}) => row(id, { channelId: null, conversationId: 'c-1', encrypted: true, ...over });
const conversation = (id: string): Conversation => ({
  id, user1Id: 'me', user2Id: peer.id, participant: peer, lastMessage: null,
  encryptedAt: T0, createdAt: T0,
} as Conversation);
/** The pages each scope answers with. */
const pages: Record<string, Message[]> = {};
const page = (rows: Message[]) => Promise.resolve({ data: { data: rows, hasMore: false, hasMoreAfter: false } });

/** What the list on screen shows, by id. */
const onScreen = () => [...container.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id'));
/** Until every promise reaction queued so far (a fetch's answer and its gate) has run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const fire = async (event: string, payload: unknown) => {
  const handlers = [...(H.handlers.get(event) ?? [])];
  if (handlers.length === 0) throw new Error(`${event} is not registered`);
  await act(async () => { await Promise.all(handlers.map((fn) => fn(payload))); });
};
/** A new connection of the same socket object: every `connect` listener runs. */
const reconnect = async (id: string) => {
  H.socketId = id;
  await fire('connect', undefined);
};

let container: HTMLDivElement;
let root: Root;
const render = async (node: React.ReactNode) => {
  await act(async () => { root.render(node); });
  await settle();
};

beforeEach(() => {
  vi.clearAllMocks();
  H.handlers.clear();
  H.socketId = 'socket-1';
  H.requests.length = 0;
  for (const key of Object.keys(pages)) delete pages[key];
  pages['channel:a'] = [row('h1')];
  pages['channel:b'] = [row('b1', { channelId: 'b' })];
  pages['dm:c-1'] = [dmRow('d1')];
  pages['dm:c-2'] = [dmRow('e1', { conversationId: 'c-2' })];
  H.answer = (url) => {
    const channel = /^\/channels\/([^/]+)\//.exec(url);
    const dm = /^\/dm\/([^/]+)\//.exec(url);
    return page(pages[channel ? `channel:${channel[1]}` : `dm:${dm![1]}`] ?? []);
  };
  useServerStore.setState({ activeServerId: 'srv', activeChannelId: 'a' });
  useDMStore.setState({ conversations: [conversation('c-1'), conversation('c-2')], activeConversationId: null, dmUnreadCounts: {}, participantStatuses: {} });
  resetChatViewState();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

describe('a space shown with a conversation kept open behind it stays live', () => {
  const mention = (id: string) => row(id, { content: `hey @me ${id}`, mentions: [{ id: 'me', username: 'me', displayName: 'Me' }] } as Partial<Message>);

  /** A live message for the channel on screen: shown, not counted, the mention heard, the channel marked read. */
  async function expectLive(id: string, before: string[]) {
    H.server.markChannelRead.mockClear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fire('message:new', { ...mention(id), serverId: 'srv' });
    expect(onScreen()).toEqual([...before, id]);
    expect(H.server.incrementUnread).not.toHaveBeenCalled();
    expect(H.sounds.mention).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(H.server.markChannelRead).toHaveBeenCalledWith('a', 'srv');
    vi.useRealTimers();
  }

  beforeEach(async () => {
    // the space opened from Explore, an invite, a new space or the voice
    // panel: the conversation the person was in stays open behind it
    useDMStore.setState({ activeConversationId: 'c-1' });
    await render(<MainLayout />);
    expect(onScreen()).toEqual(['h1']);
    expect(H.requests).toEqual(['channel:a']);
  });

  it('its tab clicked again (or picked in the switcher): the history stays and a live message is shown, not counted, heard and marked read', async () => {
    // SpacesStrip.goServer / ServerSwitcher.choose on the same space: the
    // conversation is left, the same first channel selected again
    act(() => {
      useDMStore.getState().clearActiveConversation();
      useServerStore.setState({ activeChannelId: 'a' });
    });
    await settle();

    expect(useDMStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().viewScope).toEqual(channelView('a'));
    expect(onScreen()).toEqual(['h1']);
    expect(H.requests).toEqual(['channel:a']);
    await expectLive('live', ['h1']);
  });

  it('another space whose load fails: the channel left on screen stays live', async () => {
    // setActiveServer of another space, its GET /servers/:id refused: the
    // channels and the channel of the space before stay
    act(() => {
      useDMStore.getState().clearActiveConversation();
      useServerStore.setState({ activeServerId: 'srv-2' });
    });
    await settle();

    expect(onScreen()).toEqual(['h1']);
    expect(H.requests).toEqual(['channel:a']);
    await expectLive('live', ['h1']);
  });

  it('whatever clears the store with the channel unchanged, the view loads its channel again and stays live', async () => {
    act(() => {
      useChatStore.getState().clearMessages();
      useServerStore.setState({ activeChannelId: 'a' });
    });
    await settle();

    expect(useChatStore.getState().viewScope).toEqual(channelView('a'));
    expect(onScreen()).toEqual(['h1']);
    expect(H.requests).toEqual(['channel:a', 'channel:a']);
    await expectLive('live', ['h1']);
  });

  it('the same after a failed load of another space', async () => {
    act(() => {
      useChatStore.getState().clearMessages();
      useServerStore.setState({ activeServerId: 'srv-2' });
    });
    await settle();

    expect(onScreen()).toEqual(['h1']);
    expect(H.requests).toEqual(['channel:a', 'channel:a']);
    await expectLive('live', ['h1']);
  });
});

describe('from a space to a conversation and back: each view loads once', () => {
  it('the channel, the conversation, the channel again: one request each', async () => {
    await render(<MainLayout />);
    expect(H.requests).toEqual(['channel:a']);

    // the strip's avatar of a person: the space left, the conversation opened
    act(() => {
      useServerStore.setState({ activeServerId: null });
      useDMStore.getState().setActiveConversation('c-1');
    });
    await settle();
    expect(H.requests).toEqual(['channel:a', 'dm:c-1']);
    expect(onScreen()).toEqual(['d1']);

    // the space's tab: the conversation left, the space shown again
    act(() => {
      useDMStore.getState().clearActiveConversation();
      useServerStore.setState({ activeServerId: 'srv', activeChannelId: 'a' });
    });
    await settle();
    expect(H.requests).toEqual(['channel:a', 'dm:c-1', 'channel:a']);
    expect(onScreen()).toEqual(['h1']);
  });
});

describe('the conversation left behind: the store keeps the channel view, and drops a conversation view', () => {
  it('a channel view survives clearActiveConversation: its rows, its scope', async () => {
    await act(async () => { await useChatStore.getState().fetchMessages('a'); });
    const rows = useChatStore.getState().messages;
    useDMStore.setState({ activeConversationId: 'c-1' });

    useDMStore.getState().clearActiveConversation();

    expect(useDMStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().viewScope).toEqual(channelView('a'));
    expect(useChatStore.getState().messages).toBe(rows);
  });

  it('a conversation view is cleared by it: no rows, no scope', async () => {
    await act(async () => { await useChatStore.getState().fetchDMMessages('c-1'); });
    expect(useChatStore.getState().messages).toHaveLength(1);
    useDMStore.setState({ activeConversationId: 'c-1' });

    useDMStore.getState().clearActiveConversation();

    expect(useChatStore.getState().viewScope).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('a conversation opened clears whatever view the store holds, a channel\'s included; its own view then loads it', async () => {
    await act(async () => { await useChatStore.getState().fetchMessages('a'); });
    useDMStore.getState().setActiveConversation('c-2');
    expect(useChatStore.getState().viewScope).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('the conversation on screen reloaded: cleared and fetched once', async () => {
    useServerStore.setState({ activeServerId: null });
    useDMStore.setState({ activeConversationId: 'c-1' });
    await act(async () => { await useChatStore.getState().fetchDMMessages('c-1'); });
    H.requests.length = 0;
    pages['dm:c-1'] = [dmRow('d2')];

    await act(async () => { useDMStore.getState().reloadConversationView('c-1'); });
    await settle();

    expect(H.requests).toEqual(['dm:c-1']);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['d2']);
  });
});

describe('the channel view loads once per change, never in a loop', () => {
  beforeEach(async () => {
    await render(<ChatArea />);
    expect(H.requests).toEqual(['channel:a']);
    expect(onScreen()).toEqual(['h1']);
  });

  it('the open channel selected again, or a re-render, fetches nothing', async () => {
    act(() => useServerStore.setState({ activeChannelId: 'a' }));
    act(() => useServerStore.setState({ members: [] }));
    await render(<ChatArea />);
    expect(H.requests).toEqual(['channel:a']);
  });

  it('the store recording a conversation with the same id as the channel is another view: the channel is loaded again', async () => {
    act(() => useChatStore.setState({ viewScope: conversationView('a') }));
    await settle();
    expect(H.requests).toEqual(['channel:a', 'channel:a']);
    expect(useChatStore.getState().viewScope).toEqual(channelView('a'));
  });

  it('a channel switch fetches the new channel once', async () => {
    act(() => useServerStore.setState({ activeChannelId: 'b' }));
    await settle();
    expect(H.requests).toEqual(['channel:a', 'channel:b']);
    expect(onScreen()).toEqual(['b1']);
  });

  it('a reconnect fetches the open channel once', async () => {
    await reconnect('socket-2');
    await settle();
    expect(H.requests).toEqual(['channel:a', 'channel:a']);
    // the same connection reported again
    await reconnect('socket-2');
    expect(H.requests).toEqual(['channel:a', 'channel:a']);
  });

  it('a search jump to another channel: its newest page once, the page around the result once', async () => {
    act(() => useServerStore.setState({ activeChannelId: 'b' }));
    await act(async () => { await useChatStore.getState().fetchMessagesAround('b', 'b1'); });
    await settle();
    expect(H.requests).toEqual(['channel:a', 'channel:b', 'channel:b:around']);
  });

  it('a search jump in the open channel: the page around the result alone', async () => {
    await act(async () => { await useChatStore.getState().fetchMessagesAround('a', 'h1'); });
    await settle();
    expect(H.requests).toEqual(['channel:a', 'channel:a:around']);
  });

  it('a failed fetch is one request: its scope is recorded as it starts', async () => {
    H.answer = () => Promise.reject(new Error('offline'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      act(() => useServerStore.setState({ activeChannelId: 'b' }));
      await settle();
      await render(<ChatArea />);
      expect(H.requests).toEqual(['channel:a', 'channel:b']);
      expect(useChatStore.getState().viewScope).toEqual(channelView('b'));
    } finally {
      error.mockRestore();
    }
  });

  it('an aborted fetch is not asked again: the switch that aborted it fetches once', async () => {
    let answerA!: (value: unknown) => void;
    H.answer = (url) => (url.startsWith('/channels/a/')
      ? new Promise((resolve) => { answerA = resolve; })
      : page(pages['channel:b']));
    await reconnect('socket-2');
    act(() => useServerStore.setState({ activeChannelId: 'b' }));
    await settle();
    answerA({ data: { data: [row('late')], hasMore: false } });
    await settle();

    expect(H.requests).toEqual(['channel:a', 'channel:a', 'channel:b']);
    expect(onScreen()).toEqual(['b1']);
  });

  it('no channel open: nothing is fetched, a clear included', async () => {
    act(() => useServerStore.setState({ activeChannelId: null }));
    act(() => useChatStore.getState().clearMessages());
    await settle();
    expect(H.requests).toEqual(['channel:a']);
  });

  it('a logout fetches nothing', async () => {
    // resetAccountStores: the chat view and the space view both go
    act(() => {
      resetChatViewState();
      useServerStore.setState({ activeServerId: null, activeChannelId: null });
    });
    await settle();
    expect(H.requests).toEqual(['channel:a']);
  });
});

describe('the conversation view loads once per change, never in a loop', () => {
  beforeEach(async () => {
    useServerStore.setState({ activeServerId: null, activeChannelId: null });
    useDMStore.setState({ activeConversationId: 'c-1' });
    await render(<DMChatArea />);
    expect(H.requests).toEqual(['dm:c-1']);
    expect(onScreen()).toEqual(['d1']);
  });

  it('another conversation opened fetches it once', async () => {
    act(() => useDMStore.getState().setActiveConversation('c-2'));
    await settle();
    expect(H.requests).toEqual(['dm:c-1', 'dm:c-2']);
    expect(onScreen()).toEqual(['e1']);
  });

  it('the open conversation selected again fetches nothing', async () => {
    act(() => useDMStore.getState().setActiveConversation('c-1'));
    await settle();
    expect(H.requests).toEqual(['dm:c-1']);
  });

  it('the store recording a channel with the same id as the conversation is another view: the conversation is loaded again', async () => {
    act(() => useChatStore.setState({ viewScope: channelView('c-1') }));
    await settle();
    expect(H.requests).toEqual(['dm:c-1', 'dm:c-1']);
    expect(useChatStore.getState().viewScope).toEqual(conversationView('c-1'));
  });

  it('a reconnect fetches the open conversation once', async () => {
    await reconnect('socket-2');
    await settle();
    expect(H.requests).toEqual(['dm:c-1', 'dm:c-1']);
  });

  it('a search jump to another conversation: its newest page once, the page around the result once', async () => {
    act(() => useDMStore.getState().setActiveConversation('c-2'));
    await act(async () => { await useChatStore.getState().fetchDMMessagesAround('c-2', 'e1'); });
    await settle();
    expect(H.requests).toEqual(['dm:c-1', 'dm:c-2', 'dm:c-2:around']);
  });

  it('a clear with the conversation unchanged loads it again, once', async () => {
    act(() => useChatStore.getState().clearMessages());
    await settle();
    expect(useChatStore.getState().viewScope).toEqual(conversationView('c-1'));
    expect(H.requests).toEqual(['dm:c-1', 'dm:c-1']);
    expect(onScreen()).toEqual(['d1']);
  });

  it('a failed fetch is one request', async () => {
    H.answer = () => Promise.reject(new Error('offline'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      act(() => useDMStore.getState().setActiveConversation('c-2'));
      await settle();
      await render(<DMChatArea />);
      expect(H.requests).toEqual(['dm:c-1', 'dm:c-2']);
      expect(useChatStore.getState().viewScope).toEqual(conversationView('c-2'));
    } finally {
      error.mockRestore();
    }
  });
});
