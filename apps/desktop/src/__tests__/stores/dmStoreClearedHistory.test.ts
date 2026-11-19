import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation, Message } from '@voxium/shared';

/**
 * The DM store's side of a removed conversation's cleared history (#47): the
 * removal this client sends (always the confirmed one, `?clearHistory=true`),
 * the answer it applies, the call it ends locally, and the floor every
 * conversation entering the store carries (services/dmClearedHistory.ts is
 * the one place that applies it; the walk itself is tested over a real vault
 * in __tests__/e2e/clearedHistoryCache.test.ts).
 */

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  resolveEncryptedPreview: vi.fn(),
  purge: vi.fn(),
  chat: { messages: [] as Message[], deleteMessage: vi.fn(), clearMessages: vi.fn(), fetchDMMessages: vi.fn() },
  voice: { dmCallConversationId: null as string | null, incomingCall: null as unknown, handleDMCallEnded: vi.fn(), setIncomingCall: vi.fn() },
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: h.apiPost, patch: vi.fn(), delete: h.apiDelete } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview: h.resolveEncryptedPreview }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => h.chat } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => h.voice } }));
// what dmClearedHistory loads when a walk runs: a purge spy, an E2E service already started
vi.mock('../../services/e2e/e2eService', () => ({
  CLEARED_HISTORY_PURGE_MARK: 'cleared',
  getE2EService: () => ({ purgeCachedPlaintexts: h.purge }),
}));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ ready: true, error: null }), subscribe: () => () => {} },
}));

import { useDMStore, wasRemovedSince } from '../../stores/dmStore';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { clearedFloorOf, isAtOrBelowClearedFloor } from '../../services/e2e/clearedFloors';
import { applyClearedFloor, clearedHistoryPurgesSettled, resetClearedHistory } from '../../services/dmClearedHistory';

const ME = 'me';
const FLOOR = '2026-11-10T10:00:00.000Z';
const FLOOR_MS = Date.parse(FLOOR);
const at = (offsetMs: number) => new Date(FLOOR_MS + offsetMs).toISOString();

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  user1Id: ME,
  user2Id: 'u2',
  participant: { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null },
  lastMessage: null,
  encryptedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});
const row = (id: string, createdAt: string, over: Partial<Message> = {}) =>
  ({ id, createdAt, conversationId: 'c1', channelId: null, content: 'x', encrypted: true, type: 'user', author: { id: 'u2' }, ...over }) as unknown as Message;

/** The purges asked for so far, as (scopes, levels). */
const purges = () => h.purge.mock.calls.map(([scopes, , opts]) => ({ scopes, levels: opts.levels }));

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  registerE2ESessionUser(() => ME);
  for (const fn of [h.apiGet, h.apiPost, h.apiDelete, h.resolveEncryptedPreview, h.purge, h.chat.deleteMessage, h.chat.clearMessages, h.voice.handleDMCallEnded, h.voice.setIncomingCall]) fn.mockReset();
  h.purge.mockImplementation(async (scopes: string[]) => ({ removed: 0, marked: scopes }));
  h.chat.messages = [];
  h.chat.deleteMessage.mockImplementation((id: string) => {
    h.chat.messages = h.chat.messages.filter((m) => m.id !== id);
  });
  h.voice.dmCallConversationId = null;
  h.voice.incomingCall = null;
  useDMStore.setState({
    conversations: [conversation(), conversation({ id: 'c2', participant: { id: 'u3', username: 'eve', displayName: 'Eve', avatarUrl: null } })],
    activeConversationId: 'c1',
    dmUnreadCounts: { c1: 3, c2: 1 },
    isLoading: false,
    participantStatuses: {},
    removedAt: {},
    removalSeq: 0,
  });
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  resetClearedHistory();
  await clearedHistoryPurgesSettled();
  registerE2ESessionUser(null);
  vi.restoreAllMocks();
});

/** The dynamic voiceStore import of applyConversationRemoval, settled. */
const settleVoice = () => vi.waitFor(() => Promise.resolve());

describe('removeConversation — the confirmed removal', () => {
  it('sends DELETE /dm/:id with clearHistory=true, and resolves once the answer is applied: the floor known, the conversation gone, the purge asked', async () => {
    h.apiDelete.mockResolvedValue({ data: { success: true, message: 'Conversation deleted', data: { clearedUntil: FLOOR } } });

    await useDMStore.getState().removeConversation('c1');

    expect(h.apiDelete).toHaveBeenCalledWith('/dm/c1', { params: { clearHistory: true } });
    // applied by the time it resolves
    expect(clearedFloorOf(ME, 'c1')).toBe(FLOOR_MS);
    const state = useDMStore.getState();
    expect(state.conversations.map((c) => c.id)).toEqual(['c2']);
    expect(state.activeConversationId).toBeNull();
    expect(state.dmUnreadCounts).toEqual({ c2: 1 });
    await clearedHistoryPurgesSettled();
    expect(purges()).toEqual([{ scopes: ['c1'], levels: new Map([['c1', FLOOR_MS]]) }]);
  });

  it('an answer with no floor (an empty conversation, an older server): the conversation goes, nothing is purged', async () => {
    h.apiDelete.mockResolvedValue({ data: { success: true, message: 'Conversation deleted' } });

    await useDMStore.getState().removeConversation('c1');

    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
    expect(clearedFloorOf(ME, 'c1')).toBeNull();
    await clearedHistoryPurgesSettled();
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('a refusal or a network failure rejects with it, and nothing changes here: no floor, the conversation stays', async () => {
    const refused = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
    h.apiDelete.mockRejectedValue(refused);

    await expect(useDMStore.getState().removeConversation('c1')).rejects.toBe(refused);

    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(useDMStore.getState().activeConversationId).toBe('c1');
    expect(clearedFloorOf(ME, 'c1')).toBeNull();
    expect(errorLog).toHaveBeenCalledWith('Failed to remove conversation:', refused);
    await clearedHistoryPurgesSettled();
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('an answer that lands after a switch of account applies nothing: its floor is not the next account\'s', async () => {
    h.apiDelete.mockImplementation(async () => {
      // A signs out and B signs in while the request is on its way
      registerE2ESessionUser(() => 'next-account');
      return { data: { success: true, message: 'Conversation deleted', data: { clearedUntil: FLOOR } } };
    });

    // the next account's own list holds the same conversation (A removed the A–B one), on a call in it
    h.voice.dmCallConversationId = 'c1';

    await useDMStore.getState().removeConversation('c1');
    await new Promise((r) => setTimeout(r, 0));

    expect(clearedFloorOf('next-account', 'c1')).toBeNull();
    expect(clearedFloorOf(ME, 'c1')).toBeNull();
    // nothing of the answer is the next account's: its conversation, its view and its call stay
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(useDMStore.getState().activeConversationId).toBe('c1');
    expect(useDMStore.getState().removalSeq).toBe(0);
    expect(h.voice.handleDMCallEnded).not.toHaveBeenCalled();
    await clearedHistoryPurgesSettled();
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('a malformed floor in the answer is ignored with a warning; the removal still applies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.apiDelete.mockResolvedValue({ data: { success: true, message: 'Conversation deleted', data: { clearedUntil: 'yesterday' } } });

    await useDMStore.getState().removeConversation('c1');

    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a malformed clearedUntil (removal answer)');
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
    expect(clearedFloorOf(ME, 'c1')).toBeNull();
  });
});

describe('applyConversationRemoval — the answer and dm:conversation:deleted alike', () => {
  it('a call of that conversation on this device is ended locally (the server ended it; nothing is emitted)', async () => {
    h.voice.dmCallConversationId = 'c1';

    useDMStore.getState().applyConversationRemoval('c1', FLOOR, 'dm:conversation:deleted');

    await vi.waitFor(() => expect(h.voice.handleDMCallEnded).toHaveBeenCalledTimes(1));
  });

  it('a call of another conversation, or a ring from the other person, is left alone', async () => {
    h.voice.dmCallConversationId = 'c2';
    h.voice.incomingCall = { conversationId: 'c1', from: { id: 'u2' } };

    useDMStore.getState().applyConversationRemoval('c1', FLOOR, 'dm:conversation:deleted');
    await settleVoice();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.voice.handleDMCallEnded).not.toHaveBeenCalled();
    expect(h.voice.setIncomingCall).not.toHaveBeenCalled();
  });

  it('works for a conversation the store does not hold (the answer dropped it first, or another device removed one never listed here)', async () => {
    useDMStore.getState().applyConversationRemoval('not-listed', FLOOR, 'dm:conversation:deleted');

    expect(clearedFloorOf(ME, 'not-listed')).toBe(FLOOR_MS);
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    await clearedHistoryPurgesSettled();
    expect(purges()).toEqual([{ scopes: ['not-listed'], levels: new Map([['not-listed', FLOOR_MS]]) }]);
  });

  it('the rows the chat view holds at or below the floor go; above it, of another conversation, or of a channel, they stay', () => {
    h.chat.messages = [
      row('old', at(-1)),
      row('last', FLOOR),
      row('newer', at(1)),
      row('elsewhere', at(-1), { conversationId: 'c2' }),
      row('channel', at(-1), { conversationId: null, channelId: 'ch1' }),
    ];

    useDMStore.getState().applyConversationRemoval('c1', FLOOR, 'dm:conversation:deleted');

    expect(h.chat.messages.map((m) => m.id)).toEqual(['newer', 'elsewhere', 'channel']);
  });
});

describe('every conversation entering the store carries its floor', () => {
  it('the list: each clearedUntil applied before the store holds it; a stale preview at or below it dropped, one above kept, and only that one hydrated', async () => {
    h.apiGet.mockResolvedValue({
      data: {
        data: [
          // answered from before the removal: its newest row is the floor's own
          conversation({ id: 'c1', clearedUntil: FLOOR, lastMessage: { id: 'm-old', content: 'env', encrypted: true, type: 'user', createdAt: FLOOR, authorId: 'u2' } }),
          conversation({ id: 'c3', clearedUntil: FLOOR, lastMessage: { id: 'm-new', content: 'env', encrypted: true, type: 'user', createdAt: at(1), authorId: 'u2' } }),
          conversation({ id: 'c4', lastMessage: { id: 'm-4', content: 'env', encrypted: true, type: 'user', createdAt: FLOOR, authorId: 'u2' } }),
        ],
      },
    });
    h.resolveEncryptedPreview.mockResolvedValue(null);

    await useDMStore.getState().fetchConversations();

    const byId = new Map(useDMStore.getState().conversations.map((c) => [c.id, c]));
    expect(byId.get('c1')?.lastMessage).toBeNull();
    expect(byId.get('c3')?.lastMessage?.id).toBe('m-new');
    expect(byId.get('c4')?.lastMessage?.id).toBe('m-4');
    expect(clearedFloorOf(ME, 'c1')).toBe(FLOOR_MS);
    expect(clearedFloorOf(ME, 'c4')).toBeNull();
    expect(h.resolveEncryptedPreview.mock.calls.map(([id]) => id).sort()).toEqual(['m-4', 'm-new']);
  });

  it('a list answered after a switch of account applies none of its floors to the next account, nor to an open\'s', async () => {
    h.apiGet.mockImplementation(async () => {
      registerE2ESessionUser(() => 'next-account');
      return { data: { data: [conversation({ id: 'c1', clearedUntil: FLOOR })] } };
    });
    h.apiPost.mockImplementation(async () => ({ data: { data: conversation({ id: 'c9', clearedUntil: FLOOR }) } }));

    await useDMStore.getState().fetchConversations();
    registerE2ESessionUser(() => ME);
    h.apiPost.mockImplementationOnce(async () => {
      registerE2ESessionUser(() => 'next-account');
      return { data: { data: conversation({ id: 'c9', clearedUntil: FLOOR }) } };
    });
    await useDMStore.getState().openDM('u2');

    for (const id of ['c1', 'c9']) {
      expect(clearedFloorOf('next-account', id)).toBeNull();
      expect(clearedFloorOf(ME, id)).toBeNull();
    }
    await clearedHistoryPurgesSettled();
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('a preview read from the cache while a floor covering it became known is not written in', async () => {
    h.apiGet.mockResolvedValue({
      data: { data: [conversation({ id: 'c1', lastMessage: { id: 'm-1', content: 'env', encrypted: true, type: 'user', createdAt: FLOOR, authorId: 'u2' } })] },
    });
    h.resolveEncryptedPreview.mockImplementation(async () => {
      // the removal, on another device, lands while the read runs
      const { applyClearedFloor } = await import('../../services/dmClearedHistory');
      applyClearedFloor('c1', FLOOR, 'dm:conversation:deleted');
      return 'their words';
    });

    await useDMStore.getState().fetchConversations();

    expect(useDMStore.getState().conversations[0].lastMessage?.content).toBe('');
  });

  it('a list fetch tries a purge that failed again, though the removed conversation is no longer listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.purge.mockRejectedValueOnce(new DOMException('disk full', 'QuotaExceededError'));
    useDMStore.getState().applyConversationRemoval('c1', FLOOR, 'dm:conversation:deleted');
    await clearedHistoryPurgesSettled();
    expect(warn).toHaveBeenCalled();
    h.apiGet.mockResolvedValue({ data: { data: [conversation({ id: 'c2' })] } });

    await useDMStore.getState().fetchConversations();
    await clearedHistoryPurgesSettled();

    expect(purges()).toEqual([
      { scopes: ['c1'], levels: new Map([['c1', FLOOR_MS]]) },
      { scopes: ['c1'], levels: new Map([['c1', FLOOR_MS]]) },
    ]);
  });

  it('an open (POST /dm reopening it) applies its floor too', async () => {
    useDMStore.setState({ conversations: [] });
    h.apiPost.mockResolvedValue({ data: { data: conversation({ id: 'c9', clearedUntil: FLOOR }) } });

    await useDMStore.getState().openDM('u2');

    expect(clearedFloorOf(ME, 'c9')).toBe(FLOOR_MS);
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c9']);
  });

  it('addConversation applies its floor too', () => {
    useDMStore.setState({ conversations: [] });

    useDMStore.getState().addConversation(conversation({ id: 'c8', clearedUntil: FLOOR }));

    expect(clearedFloorOf(ME, 'c8')).toBe(FLOOR_MS);
  });

  it('a pushed row at or below a known floor is no preview (updateLastMessage); one above it is', () => {
    useDMStore.setState({ conversations: [] });
    useDMStore.getState().addConversation(conversation({ id: 'c1', clearedUntil: FLOOR }));
    expect(isAtOrBelowClearedFloor(ME, 'c1', FLOOR)).toBe(true);

    const last = { id: 'm', content: '', encrypted: true, type: 'user' as const, authorId: 'u2' };
    useDMStore.getState().updateLastMessage('c1', { ...last, id: 'm-old', createdAt: FLOOR });
    expect(useDMStore.getState().conversations[0].lastMessage).toBeNull();
    useDMStore.getState().updateLastMessage('c1', { ...last, id: 'm-new', createdAt: at(1) });
    expect(useDMStore.getState().conversations[0].lastMessage?.id).toBe('m-new');
  });
});

describe('the chat view\'s rows at or below a floor a list or an open brings', () => {
  it('a list carrying a floor removes the rows the view still holds at or below it (a view loaded before the floor was known)', async () => {
    h.chat.messages = [row('old', FLOOR), row('newer', at(1)), row('elsewhere', FLOOR, { conversationId: 'c2' })];
    h.apiGet.mockResolvedValue({ data: { data: [conversation({ id: 'c1', clearedUntil: FLOOR }), conversation({ id: 'c2' })] } });

    await useDMStore.getState().fetchConversations();

    expect(h.chat.messages.map((m) => m.id)).toEqual(['newer', 'elsewhere']);
  });

  it('an open carrying a floor does the same', async () => {
    h.chat.messages = [row('old', at(-1)), row('newer', at(1))];
    h.apiPost.mockResolvedValue({ data: { data: conversation({ id: 'c1', clearedUntil: FLOOR }) } });

    await useDMStore.getState().openDM('u2');

    expect(h.chat.messages.map((m) => m.id)).toEqual(['newer']);
  });
});

describe('the list\'s `cleared`: the floors of the removed conversations it leaves out', () => {
  it('each is applied (the floor known, one walk), for a conversation the list does not name; the next list with the same floors walks nothing', async () => {
    h.apiGet.mockResolvedValue({ data: { data: [conversation({ id: 'c2' })], cleared: [{ conversationId: 'c-hidden', clearedUntil: FLOOR }] } });

    await useDMStore.getState().fetchConversations();
    await clearedHistoryPurgesSettled();

    expect(clearedFloorOf(ME, 'c-hidden')).toBe(FLOOR_MS);
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
    expect(purges()).toEqual([{ scopes: ['c-hidden'], levels: new Map([['c-hidden', FLOOR_MS]]) }]);

    await useDMStore.getState().fetchConversations();
    await clearedHistoryPurgesSettled();
    expect(h.purge).toHaveBeenCalledTimes(1);
  });

  it('a list answered after a switch of account applies none of them', async () => {
    h.apiGet.mockImplementation(async () => {
      registerE2ESessionUser(() => 'next-account');
      return { data: { data: [], cleared: [{ conversationId: 'c-hidden', clearedUntil: FLOOR }] } };
    });

    await useDMStore.getState().fetchConversations();

    expect(clearedFloorOf('next-account', 'c-hidden')).toBeNull();
    expect(clearedFloorOf(ME, 'c-hidden')).toBeNull();
  });
});

describe('a list that began before a removal does not bring the conversation back', () => {
  /** A list request held open, answered later with what the server computed before the removal. */
  function heldList() {
    let answer!: (data: unknown) => void;
    h.apiGet.mockImplementationOnce(() => new Promise((resolve) => { answer = (data) => resolve({ data }); }));
    const fetching = useDMStore.getState().fetchConversations();
    return { fetching, answer: (conversations: Conversation[]) => answer({ data: conversations }) };
  }
  const lastAt = (createdAt: string, id = 'm-1') => ({ id, content: '', encrypted: true, type: 'user' as const, createdAt, authorId: 'u2' });
  const stale = (over: Partial<Conversation> = {}) => conversation({ id: 'c1', lastMessage: lastAt(FLOOR), ...over });

  it('a removal with a floor applied while the list was on its way: the conversation stays out', async () => {
    const list = heldList();
    useDMStore.getState().applyConversationRemoval('c1', FLOOR, 'dm:conversation:deleted');
    list.answer([stale(), conversation({ id: 'c2' })]);
    await list.fetching;

    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
  });

  it('a removal with NO floor (a 2.1.x device of this account) while the list was on its way: the conversation stays out too', async () => {
    const list = heldList();
    useDMStore.getState().applyConversationRemoval('c1', undefined, 'dm:conversation:deleted');
    list.answer([stale(), conversation({ id: 'c2' })]);
    await list.fetching;

    expect(clearedFloorOf(ME, 'c1')).toBeNull();
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
  });

  it('a floor known this session (no removal here: another list taught it) above the row\'s, with nothing above it: left out; carrying that floor (reopened, nothing new): kept', async () => {
    applyClearedFloor('c1', FLOOR, 'cleared list');
    h.apiGet.mockResolvedValueOnce({ data: { data: [stale({ clearedUntil: at(-60_000) }), stale({ id: 'c3' })] } });
    await useDMStore.getState().fetchConversations();
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c3']);

    h.apiGet.mockResolvedValueOnce({ data: { data: [conversation({ id: 'c1', clearedUntil: FLOOR, lastMessage: null })] } });
    await useDMStore.getState().fetchConversations();
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c1']);
  });

  it('a newer message above the floor (the list begun after it) brings it back, and so does a list begun after a removal with no floor', async () => {
    applyClearedFloor('c1', FLOOR, 'cleared list');
    h.apiGet.mockResolvedValueOnce({ data: { data: [stale({ lastMessage: lastAt(at(1), 'm-2') })] } });
    await useDMStore.getState().fetchConversations();
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c1']);

    useDMStore.getState().applyConversationRemoval('c2', undefined, 'dm:conversation:deleted');
    h.apiGet.mockResolvedValueOnce({ data: { data: [conversation({ id: 'c2' })] } });
    await useDMStore.getState().fetchConversations();
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
  });

  it('an open of it, or a new message in it, since the removal: a list already on its way shows it again', async () => {
    let list = heldList();
    useDMStore.getState().applyConversationRemoval('c4', undefined, 'dm:conversation:deleted');
    h.apiPost.mockResolvedValueOnce({ data: { data: conversation({ id: 'c4' }) } });
    await useDMStore.getState().openDM('u4');
    list.answer([conversation({ id: 'c4' })]);
    await list.fetching;
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c4']);

    useDMStore.setState({ conversations: [conversation({ id: 'c5' })] });
    list = heldList();
    useDMStore.getState().applyConversationRemoval('c5', undefined, 'dm:conversation:deleted');
    // MainLayout's path for a message of a conversation the store no longer holds
    useDMStore.getState().forgetRemoval('c5');
    list.answer([conversation({ id: 'c5' })]);
    await list.fetching;
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c5']);

    list = heldList();
    useDMStore.getState().applyConversationRemoval('c5', undefined, 'dm:conversation:deleted');
    useDMStore.setState({ conversations: [conversation({ id: 'c5' })] });
    // a new message in a conversation the store holds again
    useDMStore.getState().updateLastMessage('c5', lastAt(at(1), 'm-5'));
    list.answer([conversation({ id: 'c5' })]);
    await list.fetching;
    expect(useDMStore.getState().conversations.map((c) => c.id)).toEqual(['c5']);
  });

  it('wasRemovedSince: after the mark only, and not once forgotten; the marks go at logout with the store', () => {
    const mark = useDMStore.getState().removalSeq;
    expect(wasRemovedSince('c1', mark)).toBe(false);
    useDMStore.getState().applyConversationRemoval('c1', undefined, 'dm:conversation:deleted');
    expect(wasRemovedSince('c1', mark)).toBe(true);
    expect(wasRemovedSince('c1', useDMStore.getState().removalSeq)).toBe(false);
    expect(wasRemovedSince('c2', mark)).toBe(false);
    useDMStore.getState().forgetRemoval('c1');
    expect(wasRemovedSince('c1', mark)).toBe(false);
  });
});
