import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message } from '@voxium/shared';

/**
 * What the chat view shows for one message when its copies arrive out of
 * order: a page asked for before an edit and answered after it, an edit that
 * arrives before its row is shown, a view of another scope fetched over it.
 * The rules (stores/chatStore.ts):
 *  - the view holds the rows of ONE channel or conversation, the one its last
 *    fetch asked for: a fetch of another one starts a new view before it asks,
 *    and a writer for another one writes and keeps nothing;
 *  - a row the view shows is never replaced by a provably older version of
 *    itself (isNewerVersion: `editedAt`, the original the oldest), and a
 *    newer version replaces it whatever the gate made of it;
 *  - an edit that arrives before its row is shown is what the row shows once
 *    it lands (remembered per view, bounded).
 */

const { apiGet, apiPost, channels, dm } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  channels: [] as { id: string; secure: boolean }[],
  // what the DM store holds: a test puts a conversation read-only here
  dm: { conversations: [] as Array<{ id: string; participantDeleted?: boolean }> },
}));
vi.mock('../../services/api', () => ({ api: { post: apiPost, get: apiGet, patch: vi.fn(), delete: vi.fn(), put: vi.fn() } }));
vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => ({ updateLastMessage: vi.fn(), conversations: dm.conversations }) } }));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ channels, members: [], secureChannelMembers: {} }) },
}));
// The gates answer what each test says they answer: the store is what is tested
vi.mock('../../services/e2e/channelCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/channelCrypto')>();
  return {
    ...actual,
    decryptChannelMessagesForDisplay: vi.fn(async (rows: Message[]) => rows),
    prepareOutgoingChannelMessage: vi.fn(async () => ({ content: 'envelope', plaintext: 'raw', position: null, notReadyUserIds: [] })),
    cacheSentChannelPlaintext: vi.fn(async () => undefined),
  };
});
vi.mock('../../services/e2e/dmCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/dmCrypto')>();
  return {
    ...actual,
    decryptMessagesForDisplay: vi.fn(async (rows: Message[]) => rows),
    prepareOutgoingDM: vi.fn(async () => ({ content: 'envelope', plaintext: 'raw', position: null })),
    cacheSentPlaintext: vi.fn(async () => undefined),
  };
});

import {
  useChatStore,
  channelView,
  conversationView,
  resetChatViewState,
  RECENT_CHANGES_MAX,
  RECENT_CHANGE_MAX_AGE_MS,
  clearConversationView,
  type ChatViewScope,
} from '../../stores/chatStore';
import { decryptChannelMessagesForDisplay } from '../../services/e2e/channelCrypto';
import { decryptMessagesForDisplay } from '../../services/e2e/dmCrypto';
import { refusedRow, deletedMessageRow, isRefusedShape } from '../../services/e2e/displayGate';

const alice = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };
const bob = { id: 'u-bob', username: 'bob', displayName: 'Bob', avatarUrl: null };
const T0 = '2026-11-20T10:00:00.000Z';
const EDIT_1 = '2026-11-20T10:05:00.000Z';
const EDIT_2 = '2026-11-20T10:06:00.000Z';

const CH = channelView('ch-1');
const SEC = channelView('sec');
const DM = conversationView('c-1');

function row(id: string, over: Partial<Message> = {}): Message {
  return {
    id, type: 'user', content: `text of ${id}`, encrypted: false, channelId: 'ch-1', conversationId: null,
    author: alice, createdAt: T0, editedAt: null, reactions: [], attachments: [], mentions: [], replyTo: null,
    ...over,
  } as Message;
}
const dmRow = (id: string, over: Partial<Message> = {}): Message =>
  row(id, { channelId: null, conversationId: 'c-1', encrypted: true, ...over });
const secRow = (id: string, over: Partial<Message> = {}): Message =>
  row(id, { channelId: 'sec', encrypted: true, ...over });
const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

const state = () => useChatStore.getState();
const shown = () => state().messages;
const ids = () => shown().map((m) => m.id);
const byId = (id: string) => shown().find((m) => m.id === id);
const page = (rows: Message[], extra: Record<string, unknown> = {}) => ({ data: { data: rows, hasMore: false, ...extra } });
/** The view of `scope` holding `rows`, as its fetch would have left it. */
const open = (scope: ChatViewScope, rows: Message[] = []) => useChatStore.setState({ messages: rows, viewScope: scope });
/** A request held until the test answers it. */
function held<T>() {
  let answer!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { answer = resolve; });
  return { promise, answer };
}

beforeEach(() => {
  vi.clearAllMocks();
  channels.length = 0;
  channels.push({ id: 'ch-1', secure: false }, { id: 'ch-2', secure: false }, { id: 'sec', secure: true });
  dm.conversations = [];
  vi.mocked(decryptChannelMessagesForDisplay).mockImplementation(async (rows: Message[]) => rows);
  vi.mocked(decryptMessagesForDisplay).mockImplementation(async (rows: Message[]) => rows);
  // a new view, of nothing: nothing remembered from the previous test
  state().clearMessages();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a page never puts an older version over the one the view shows (#142)', () => {
  it('a plaintext channel: the newest page\'s pre-edit row leaves the edited one in place', async () => {
    open(CH, [row('m1', { content: 'edited', editedAt: EDIT_1 })]);
    apiGet.mockResolvedValue(page([row('m0'), row('m1', { content: 'original' }), row('m2', { createdAt: at(1) })]));

    await state().fetchMessages('ch-1');

    expect(ids()).toEqual(['m0', 'm1', 'm2']);
    expect(byId('m1')).toMatchObject({ content: 'edited', editedAt: EDIT_1 });
  });

  it('a secure channel: the gate\'s refusal of the pre-edit row does not cover the opened edit', async () => {
    const opened = secRow('m1', { content: 'edited', editedAt: EDIT_1 });
    open(SEC, [opened]);
    // the page was asked for before the edit: its row is the older version,
    // which the gate refuses once the edit's position is recorded
    vi.mocked(decryptChannelMessagesForDisplay).mockImplementation(async (rows: Message[]) => rows.map((r) => refusedRow(r)));
    apiGet.mockResolvedValue(page([secRow('m1', { content: 'envelope' })]));

    await state().fetchMessages('sec');

    expect(byId('m1')).toBe(opened);
  });

  it('a direct conversation: the same, for the newest page', async () => {
    const opened = dmRow('m1', { content: 'edited', editedAt: EDIT_1 });
    open(DM, [opened]);
    vi.mocked(decryptMessagesForDisplay).mockImplementation(async (rows: Message[]) => rows.map((r) => refusedRow(r)));
    apiGet.mockResolvedValue(page([dmRow('m1', { content: 'envelope' })]));

    await state().fetchDMMessages('c-1');

    expect(byId('m1')).toBe(opened);
  });

  it('an older page (before) and an around page keep the edited row too', async () => {
    const edited = dmRow('m1', { content: 'edited', editedAt: EDIT_1 });
    open(DM, [edited, dmRow('m2', { createdAt: at(1) })]);
    apiGet.mockResolvedValue(page([dmRow('m0', { createdAt: '2026-11-20T09:59:00.000Z' }), dmRow('m1', { content: 'original' })]));

    await state().fetchDMMessages('c-1', T0);
    expect(ids()).toEqual(['m0', 'm1', 'm2']);
    expect(byId('m1')).toBe(edited);

    apiGet.mockResolvedValue(page([dmRow('m1', { content: 'original' }), dmRow('m2', { createdAt: at(1) })], { targetMessageId: 'm1' }));
    await state().fetchDMMessagesAround('c-1', 'm1');
    expect(byId('m1')).toBe(edited);

    open(CH, [row('m1', { content: 'edited', editedAt: EDIT_1 })]);
    apiGet.mockResolvedValue(page([row('m1', { content: 'original' })], { targetMessageId: 'm1' }));
    await state().fetchMessagesAround('ch-1', 'm1');
    expect(byId('m1')).toMatchObject({ content: 'edited' });
  });

  it('an older page whose copy of a row the view shows is the same version keeps the copy shown', async () => {
    const shownCopy = row('m1', { content: 'edited', editedAt: EDIT_1 });
    open(CH, [shownCopy, row('m2', { createdAt: at(1) })]);
    const pageCopy = row('m1', { content: 'edited', editedAt: EDIT_1, reactions: [{ emoji: '👍', count: 1, userIds: ['u-bob'] }] } as Partial<Message>);
    apiGet.mockResolvedValue(page([row('m0', { createdAt: '2026-11-20T09:59:00.000Z' }), pageCopy]));

    await state().fetchMessages('ch-1', T0);

    expect(ids()).toEqual(['m0', 'm1', 'm2']);
    expect(byId('m1')).toBe(shownCopy);
  });

  it('a page row that is the NEWER version replaces the one shown', async () => {
    open(CH, [row('m1', { content: 'first edit', editedAt: EDIT_1 })]);
    apiGet.mockResolvedValue(page([row('m1', { content: 'second edit', editedAt: EDIT_2 })]));

    await state().fetchMessages('ch-1');

    expect(byId('m1')).toMatchObject({ content: 'second edit', editedAt: EDIT_2 });
  });

  it('a newer version the gate refused replaces the plaintext shown: the marker, never the older text', async () => {
    open(DM, [dmRow('m1', { content: 'first edit', editedAt: EDIT_1 })]);
    vi.mocked(decryptMessagesForDisplay).mockImplementation(async (rows: Message[]) => rows.map((r) => refusedRow(r)));
    apiGet.mockResolvedValue(page([dmRow('m1', { content: 'envelope', editedAt: EDIT_2 })]));

    await state().fetchDMMessages('c-1');

    expect(isRefusedShape(byId('m1')!)).toBe(true);
    expect(byId('m1')?.editedAt).toBe(EDIT_2);
  });

  it('the same version: the page\'s copy stands (it carries the reactions of now)', async () => {
    open(CH, [row('m1', { content: 'edited', editedAt: EDIT_1 })]);
    const fresh = row('m1', { content: 'edited', editedAt: EDIT_1, reactions: [{ emoji: '👍', count: 1, userIds: ['u-bob'] }] } as Partial<Message>);
    apiGet.mockResolvedValue(page([fresh]));

    await state().fetchMessages('ch-1');

    expect(byId('m1')).toBe(fresh);
  });

  it('what proves nothing keeps the page\'s copy: another author, or an edit time that does not parse', async () => {
    open(CH, [row('m1', { content: 'edited', editedAt: EDIT_1 }), row('m2', { content: 'edited', editedAt: 'not a time' })]);
    const relabelled = row('m1', { author: bob, content: 'original' });
    const m2 = row('m2', { content: 'original' });
    apiGet.mockResolvedValue(page([relabelled, m2]));

    await state().fetchMessages('ch-1');

    expect(byId('m1')).toBe(relabelled);
    expect(byId('m2')).toBe(m2);
  });

  it('a deleted account\'s row from the page replaces even a newer version shown', async () => {
    open(DM, [dmRow('m1', { author: bob, content: 'edited', editedAt: EDIT_1 })]);
    const placeholder = deletedMessageRow(dmRow('m1'), 'c-1');
    vi.mocked(decryptMessagesForDisplay).mockImplementation(async () => [placeholder]);
    apiGet.mockResolvedValue(page([dmRow('m1', { type: 'deleted' as Message['type'] })]));

    await state().fetchDMMessages('c-1');

    expect(byId('m1')).toBe(placeholder);
  });

  it('an edit that arrived while the view was empty (the first page in flight) is what the page\'s row shows', async () => {
    open(DM);
    const edit = dmRow('m1', { content: 'edited', editedAt: EDIT_1 });
    // the view opens empty; the edit arrives before the page that was asked for before it
    expect(state().updateMessage(edit, DM)).toBe(false);
    expect(shown()).toEqual([]);
    vi.mocked(decryptMessagesForDisplay).mockImplementation(async (rows: Message[]) => rows.map((r) => refusedRow(r)));
    apiGet.mockResolvedValue(page([dmRow('m1', { content: 'envelope' }), dmRow('m2', { createdAt: at(1) })]));

    await state().fetchDMMessages('c-1');

    expect(byId('m1')).toBe(edit);
    expect(isRefusedShape(byId('m2')!)).toBe(true);
  });
});

describe('the view holds the rows of one channel or conversation', () => {
  /** The channel's view as its fetch leaves it, through the real fetch. */
  async function loadChannel(channelId: string, rows: Message[]): Promise<void> {
    apiGet.mockResolvedValueOnce(page(rows));
    await state().fetchMessages(channelId);
    expect(state().viewScope).toEqual(channelView(channelId));
  }

  /** What the conversation's gate answers for its page: refused rows, as new objects. */
  function dmGateRefuses(): Message[] {
    const answered: Message[] = [];
    vi.mocked(decryptMessagesForDisplay).mockImplementation(async (rows: Message[]) => {
      const out = rows.map((r) => refusedRow(r));
      answered.push(...out);
      return out;
    });
    return answered;
  }

  it('a secure channel\'s row on screen never stands in the conversation opened next with no clear (X7)', async () => {
    // the channel's row with the id the conversation's page names, under the same author, edited
    await loadChannel('sec', [secRow('X', { content: 'channel words', editedAt: EDIT_1 })]);
    const answered = dmGateRefuses();
    apiGet.mockResolvedValueOnce(page([dmRow('X', { content: 'envelope' })]));

    // the conversation's mount fetches with no clear in between
    await state().fetchDMMessages('c-1');

    expect(state().viewScope).toEqual(DM);
    expect(shown()).toHaveLength(answered.length);
    shown().forEach((m, i) => expect(m).toBe(answered[i]));
    expect(byId('X')).toMatchObject({ conversationId: 'c-1', channelId: null });
  });

  it('an edit a secure channel kept for a row it did not show never reaches the conversation opened next (X8)', async () => {
    await loadChannel('sec', [secRow('a1')]);
    expect(state().updateMessage(secRow('X', { content: 'channel edit', editedAt: EDIT_1 }), SEC)).toBe(false);
    const answered = dmGateRefuses();
    apiGet.mockResolvedValueOnce(page([dmRow('X', { content: 'envelope' })]));

    await state().fetchDMMessages('c-1');

    expect(shown()).toEqual(answered);
    expect(byId('X')).toBe(answered[0]);
  });

  it('a plaintext channel\'s kept edit, which no gate saw, never shows in the encrypted conversation opened next (X9)', async () => {
    await loadChannel('ch-1', [row('a1')]);
    state().updateMessage(row('X', { author: bob, content: 'words bob never wrote', editedAt: EDIT_1 }), CH);
    const answered = dmGateRefuses();
    apiGet.mockResolvedValueOnce(page([dmRow('X', { author: bob, content: 'garbage' })]));

    await state().fetchDMMessages('c-1');

    expect(byId('X')).toBe(answered[0]);
    expect(byId('X')?.encrypted).toBe(true);
    expect(shown().some((m) => m.content === 'words bob never wrote')).toBe(false);
  });

  it('nothing of the channel is shown while the conversation\'s page is on its way', async () => {
    await loadChannel('sec', [secRow('X', { content: 'channel words' })]);
    useChatStore.setState({ replyingTo: secRow('X'), typingUsers: new Map([['u-bob', 'bob']]) });
    const request = held<unknown>();
    apiGet.mockReturnValueOnce(request.promise);

    const loading = state().fetchDMMessages('c-1');

    // synchronously, before the request: no row, no reply, no typing line of the channel
    expect(shown()).toEqual([]);
    expect(state().replyingTo).toBeNull();
    expect(state().typingUsers.size).toBe(0);
    expect(state().viewScope).toEqual(DM);
    request.answer(page([dmRow('d1')]));
    await loading;
    expect(ids()).toEqual(['d1']);
  });

  it('the other way: a conversation\'s rows and kept edit never stand in a channel fetched next', async () => {
    apiGet.mockResolvedValueOnce(page([dmRow('X', { content: 'their words', editedAt: EDIT_1 })]));
    await state().fetchDMMessages('c-1');
    state().updateMessage(dmRow('Y', { content: 'kept edit', editedAt: EDIT_1 }), DM);
    const channelPage = [row('X'), row('Y', { createdAt: at(1) })];
    apiGet.mockResolvedValueOnce(page(channelPage));

    await state().fetchMessages('ch-1');

    expect(state().viewScope).toEqual(CH);
    expect(shown()).toEqual(channelPage);
    expect(byId('X')).toBe(channelPage[0]);
    expect(byId('Y')).toBe(channelPage[1]);
  });

  it('two channels: the second one\'s page is merged with nothing of the first', async () => {
    await loadChannel('ch-1', [row('X', { content: 'edited in ch-1', editedAt: EDIT_1 })]);
    state().updateMessage(row('Y', { content: 'kept in ch-1', editedAt: EDIT_1 }), CH);
    const other = [row('X', { channelId: 'ch-2' }), row('Y', { channelId: 'ch-2', createdAt: at(1) })];
    apiGet.mockResolvedValueOnce(page(other));

    await state().fetchMessages('ch-2');

    expect(shown()).toEqual(other);
    expect(byId('X')).toBe(other[0]);
  });

  it('a channel and a conversation of the same id are two scopes: no write of one lands in the other, a fetch starts a new view', async () => {
    const channelsRow = row('X', { channelId: 'same-id', content: 'channel words' });
    open(channelView('same-id'), [channelsRow]);
    const before = shown();

    expect(state().addMessage(dmRow('Y', { conversationId: 'same-id' }), conversationView('same-id'))).toBe(false);
    expect(state().updateMessage(dmRow('X', { conversationId: 'same-id', content: 'their edit', editedAt: EDIT_1 }), conversationView('same-id'))).toBe(false);
    state().updateMessageReactions('X', [{ emoji: '👍', count: 1, userIds: ['u-bob'] }], conversationView('same-id'));
    expect(shown()).toBe(before);

    const theirs = dmRow('X', { conversationId: 'same-id', content: 'their copy' });
    apiGet.mockResolvedValueOnce(page([theirs]));
    await state().fetchDMMessages('same-id');
    expect(state().viewScope).toEqual(conversationView('same-id'));
    expect(shown()).toEqual([theirs]);
    expect(byId('X')).toBe(theirs);
  });

  it('a new view drops the message a jump was aimed at', async () => {
    apiGet.mockResolvedValueOnce(page([row('m1')], { targetMessageId: 'm1' }));
    await state().fetchMessagesAround('ch-1', 'm1');
    expect(state().targetMessageId).toBe('m1');

    apiGet.mockResolvedValueOnce(page([dmRow('d1')]));
    const loading = state().fetchDMMessages('c-1');
    // synchronously, with the new view
    expect(state().targetMessageId).toBeNull();
    await loading;

    apiGet.mockResolvedValueOnce(page([row('m1')], { targetMessageId: 'm1' }));
    await state().fetchMessagesAround('ch-1', 'm1');
    state().clearMessages();
    expect(state().targetMessageId).toBeNull();
  });

  it('leaving a conversation (clearConversationView) ends a conversation\'s view only', async () => {
    open(CH, [row('m1')]);
    const rows = shown();
    clearConversationView();
    expect(state().viewScope).toEqual(CH);
    expect(shown()).toBe(rows);

    open(DM, [dmRow('d1')]);
    clearConversationView();
    expect(state().viewScope).toBeNull();
    expect(shown()).toEqual([]);

    // none recorded: nothing changes
    const empty = shown();
    clearConversationView();
    expect(state().viewScope).toBeNull();
    expect(shown()).toBe(empty);
  });

  it('every fetch entry of another scope starts a new view: before, around, and their DM forms', async () => {
    const entries: Array<[string, () => Promise<void>, ChatViewScope]> = [
      ['an older page of a channel', () => state().fetchMessages('ch-2', T0), channelView('ch-2')],
      ['a channel page around a message', () => state().fetchMessagesAround('ch-2', 'm1'), channelView('ch-2')],
      ['an older page of a conversation', () => state().fetchDMMessages('c-2', T0), conversationView('c-2')],
      ['a conversation page around a message', () => state().fetchDMMessagesAround('c-2', 'm1'), conversationView('c-2')],
    ];
    for (const [name, fetch, scope] of entries) {
      open(CH, [row('m1', { content: 'edited', editedAt: EDIT_2 })]);
      const theirs = row('m1', { channelId: null, conversationId: 'c-2', content: 'their copy' });
      apiGet.mockResolvedValueOnce(page([theirs], { targetMessageId: 'm1' }));
      await fetch();
      expect(state().viewScope, name).toEqual(scope);
      expect(byId('m1'), name).toBe(theirs);
    }
  });

  it('a page of the scope left behind that answers late is dropped', async () => {
    const late = held<unknown>();
    apiGet.mockReturnValueOnce(late.promise);
    const leaving = state().fetchMessages('ch-1');
    apiGet.mockResolvedValueOnce(page([dmRow('d1')]));
    await state().fetchDMMessages('c-1');

    late.answer(page([row('c1')]));
    await leaving;

    expect(state().viewScope).toEqual(DM);
    expect(ids()).toEqual(['d1']);
  });

  it('the same scope fetched again keeps merging: an older page does not overwrite a newer edit held', async () => {
    await loadChannel('ch-1', [row('m1')]);
    expect(state().updateMessage(row('m1', { content: 'edited', editedAt: EDIT_1 }), CH)).toBe(true);
    apiGet.mockResolvedValueOnce(page([row('m1', { content: 'original' })]));

    // a jump to the latest page, or the conversation's reconnect: no clear
    await state().fetchMessages('ch-1');

    expect(byId('m1')).toMatchObject({ content: 'edited', editedAt: EDIT_1 });
  });

  it('a writer for another channel or conversation writes and keeps nothing', () => {
    open(CH, [row('m1'), row('m2', { createdAt: at(1), reactions: [] })]);
    const before = shown();

    expect(state().addMessage(dmRow('d1'), DM)).toBe(false);
    expect(state().updateMessage(row('m1', { content: 'their edit', editedAt: EDIT_1 }), DM)).toBe(false);
    expect(state().updateMessage(row('m9', { content: 'their kept edit', editedAt: EDIT_1 }), SEC)).toBe(false);
    state().updateMessageReactions('m2', [{ emoji: '👍', count: 1, userIds: ['u-bob'] }], DM);
    state().removeWebhookMessages('ch-2', 'wh-1');

    expect(shown()).toBe(before);
    // nothing of them waits in this view either
    expect(state().addMessage(row('m9'), CH)).toBe(true);
    expect(byId('m9')?.content).toBe('text of m9');
  });

  it('the same writers for the view\'s scope apply', () => {
    open(CH, [row('m1'), row('m2', { createdAt: at(1) })]);
    const reactions = [{ emoji: '👍', count: 1, userIds: ['u-bob'] }];
    state().updateMessageReactions('m2', reactions, CH);
    expect(byId('m2')?.reactions).toEqual(reactions);
    expect(state().updateMessage(row('m1', { content: 'edited', editedAt: EDIT_1 }), CH)).toBe(true);
  });

  it('a webhook\'s purge applies to the view of its channel only', () => {
    const posted = row('w1', { webhookId: 'wh-1' } as Partial<Message>);
    // a conversation's view holding a row the server labelled with that channel and webhook
    open(DM, [{ ...posted, conversationId: 'c-1' }]);
    const before = shown();
    state().removeWebhookMessages('ch-1', 'wh-1');
    expect(shown()).toBe(before);

    open(CH, [posted]);
    state().removeWebhookMessages('ch-1', 'wh-1');
    expect(shown()).toEqual([]);
  });

  it('with no scope recorded (after a clear), every writer drops what it brings', () => {
    state().clearMessages();
    expect(state().viewScope).toBeNull();
    expect(state().addMessage(row('m1'), CH)).toBe(false);
    expect(state().updateMessage(row('m2', { editedAt: EDIT_1 }), CH)).toBe(false);
    expect(shown()).toEqual([]);
    // and the edit was not kept for the channel's next view
    open(CH);
    expect(state().addMessage(row('m2'), CH)).toBe(true);
    expect(byId('m2')?.content).toBe('text of m2');
  });

  it('a scope that names no channel or conversation matches none', () => {
    open(channelView(''));
    expect(state().addMessage(row('m1'), channelView(undefined))).toBe(false);
    expect(state().addMessage(row('m1'), conversationView(null))).toBe(false);
  });

  it('a page in flight at logout lands for nobody', async () => {
    const request = held<unknown>();
    apiGet.mockReturnValueOnce(request.promise);
    const loading = state().fetchDMMessages('c-1');

    resetChatViewState();
    request.answer(page([dmRow('d1')]));
    await loading;

    expect(state().viewScope).toBeNull();
    expect(shown()).toEqual([]);
    expect(state().isLoading).toBe(false);
  });
});

describe('the sender\'s own row lands in the channel or conversation it was sent to', () => {
  it('a channel\'s own row is never put into the conversation opened while its POST was on the way (X1)', async () => {
    open(CH, [row('a1')]);
    const post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    const sending = state().sendMessage('ch-1', 'my channel text');
    apiGet.mockResolvedValueOnce(page([dmRow('d1', { createdAt: at(1) })]));
    await state().fetchDMMessages('c-1');

    post.answer({ data: { data: row('mine', { content: 'my channel text', createdAt: at(30) }) } });
    await sending;

    expect(ids()).toEqual(['d1']);
  });

  it('a secure channel\'s own row: the same', async () => {
    open(SEC);
    const post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    const sending = state().sendMessage('sec', 'secret');
    apiGet.mockResolvedValueOnce(page([dmRow('d1')]));
    await state().fetchDMMessages('c-1');

    post.answer({ data: { data: secRow('mine', { createdAt: at(30) }) } });
    await sending;

    expect(ids()).toEqual(['d1']);
  });

  it('a conversation\'s own row is never put into the channel opened while its POST was on the way', async () => {
    open(DM);
    const post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    const sending = state().sendDMMessage('c-1', 'to you');
    apiGet.mockResolvedValueOnce(page([row('c1')]));
    await state().fetchMessages('ch-1');

    post.answer({ data: { data: dmRow('mine', { createdAt: at(30) }) } });
    await sending;

    expect(ids()).toEqual(['c1']);
  });

  it('the view of the channel cleared and loaded again while the POST was on the way (a reconnect) keeps it (X3)', async () => {
    open(CH);
    const post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    const sending = state().sendMessage('ch-1', 'hello');
    // ChatArea's reconnect: clearMessages, then fetchMessages of the same channel
    state().clearMessages();
    apiGet.mockResolvedValueOnce(page([row('m0')]));
    await state().fetchMessages('ch-1');

    post.answer({ data: { data: row('mine', { createdAt: at(5) }) } });
    await sending;

    expect(ids()).toEqual(['m0', 'mine']);
  });

  it('the same for a secure channel and a conversation reloaded while the POST was on the way', async () => {
    open(SEC);
    let post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    let sending = state().sendMessage('sec', 'hello');
    state().clearMessages();
    apiGet.mockResolvedValueOnce(page([secRow('m0')]));
    await state().fetchMessages('sec');
    post.answer({ data: { data: secRow('mine', { createdAt: at(5) }) } });
    await sending;
    expect(ids()).toEqual(['m0', 'mine']);
    expect(byId('mine')).toMatchObject({ content: 'hello', encrypted: true });

    open(DM);
    post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    sending = state().sendDMMessage('c-1', 'hello');
    // reloadConversationView: clearMessages, then fetchDMMessages of the same conversation
    state().clearMessages();
    apiGet.mockResolvedValueOnce(page([dmRow('m0')]));
    await state().fetchDMMessages('c-1');
    post.answer({ data: { data: dmRow('mine', { createdAt: at(5) }) } });
    await sending;
    expect(ids()).toEqual(['m0', 'mine']);
  });

  it('a view cleared and of nothing yet when the POST answers takes it nowhere', async () => {
    open(CH);
    const post = held<unknown>();
    apiPost.mockReturnValueOnce(post.promise);
    const sending = state().sendMessage('ch-1', 'hello');
    state().clearMessages();
    post.answer({ data: { data: row('mine') } });
    await sending;
    expect(shown()).toEqual([]);
  });
});

describe('a deleted account\'s row while the conversation is held read-only, and once it is live again', () => {
  it('held read-only: no copy of the account\'s text comes back over the deleted shape', async () => {
    dm.conversations = [{ id: 'c-1', participantDeleted: true }];
    open(DM, [dmRow('m1', { author: bob, content: 'edited', editedAt: EDIT_1 })]);
    const placeholder = deletedMessageRow(dmRow('m1'), 'c-1');
    state().updateMessage(placeholder, DM);
    expect(byId('m1')).toBe(placeholder);

    state().updateMessage(dmRow('m1', { author: bob, content: 'edited again', editedAt: EDIT_2 }), DM);
    expect(byId('m1')).toBe(placeholder);
    apiGet.mockResolvedValueOnce(page([dmRow('m1', { author: bob, content: 'their text' })]));
    await state().fetchDMMessages('c-1');
    expect(byId('m1')).toBe(placeholder);
  });

  it('live again (the DM store no longer holds it read-only): the page\'s rows stand', async () => {
    open(DM, [deletedMessageRow(dmRow('m1'), 'c-1')]);
    const live = dmRow('m1', { author: bob, content: 'their text' });
    apiGet.mockResolvedValueOnce(page([live]));

    await state().fetchDMMessages('c-1');

    expect(byId('m1')).toBe(live);
  });

  it('a deleted shape the page itself brings wins whatever the DM store says', async () => {
    open(DM, [dmRow('m1', { author: bob, content: 'their text' })]);
    const placeholder = deletedMessageRow(dmRow('m1'), 'c-1');
    vi.mocked(decryptMessagesForDisplay).mockImplementation(async () => [placeholder]);
    apiGet.mockResolvedValueOnce(page([dmRow('m1', { type: 'deleted' as Message['type'] })]));

    await state().fetchDMMessages('c-1');

    expect(byId('m1')).toBe(placeholder);
  });
});

describe('version order follows the server\'s edit time', () => {
  it('within one view not cleared, the latest stamp wins: an edit stamped earlier stays ignored, a refetch included', async () => {
    open(CH);
    state().addMessage(row('m1'), CH);
    state().updateMessage(row('m1', { content: 'first edit', editedAt: at(30) }), CH);
    state().updateMessage(row('m1', { content: 'second edit', editedAt: at(29) }), CH);
    expect(byId('m1')?.content).toBe('first edit');

    apiGet.mockResolvedValueOnce(page([row('m1', { content: 'second edit', editedAt: at(29) })]));
    await state().fetchMessages('ch-1');
    expect(byId('m1')?.content).toBe('first edit');
  });

  it('the first page after a clear stands: nothing is held to compare with', async () => {
    open(CH);
    state().addMessage(row('m1'), CH);
    state().updateMessage(row('m1', { content: 'first edit', editedAt: at(30) }), CH);

    state().clearMessages();
    apiGet.mockResolvedValueOnce(page([row('m1', { content: 'second edit', editedAt: at(29) })]));
    await state().fetchMessages('ch-1');

    expect(byId('m1')?.content).toBe('second edit');
  });
});

describe('the newest version of a row is what the view ends up showing', () => {
  beforeEach(() => open(DM));

  it('an edit that arrives before its insert lands is what the insert shows', () => {
    expect(state().updateMessage(dmRow('m1', { content: 'edited', editedAt: EDIT_1 }), DM)).toBe(false);
    expect(state().addMessage(dmRow('m1'), DM)).toBe(true);
    expect(byId('m1')).toMatchObject({ content: 'edited', editedAt: EDIT_1 });
  });

  it('two such edits in the other order: the newer one wins', () => {
    state().updateMessage(dmRow('m1', { content: 'second edit', editedAt: EDIT_2 }), DM);
    state().updateMessage(dmRow('m1', { content: 'first edit', editedAt: EDIT_1 }), DM);
    state().addMessage(dmRow('m1'), DM);
    expect(byId('m1')).toMatchObject({ content: 'second edit', editedAt: EDIT_2 });
  });

  it('an older edit landing after a newer one leaves the newer one, and the view as it was', () => {
    state().addMessage(dmRow('m1'), DM);
    expect(state().updateMessage(dmRow('m1', { content: 'second edit', editedAt: EDIT_2 }), DM)).toBe(true);
    const before = shown();
    expect(state().updateMessage(dmRow('m1', { content: 'first edit', editedAt: EDIT_1 }), DM)).toBe(false);
    expect(shown()).toBe(before);
    expect(byId('m1')?.content).toBe('second edit');
  });

  it('an insert of a row the view shows keeps the copy shown (the first to land owns the id)', () => {
    const first = dmRow('m1', { content: 'first copy' });
    state().addMessage(first, DM);
    expect(state().addMessage(dmRow('m1', { content: 'second copy' }), DM)).toBe(false);
    expect(byId('m1')).toBe(first);
  });

  it('an update of the same version replaces the copy shown, as before', () => {
    state().addMessage(dmRow('m1'), DM);
    const again = dmRow('m1', { content: 'the same version gated again' });
    expect(state().updateMessage(again, DM)).toBe(true);
    expect(byId('m1')).toBe(again);
  });

  it('a deleted account\'s row replaces a newer version shown', () => {
    state().addMessage(dmRow('m1', { author: bob, content: 'edited', editedAt: EDIT_1 }), DM);
    const placeholder = deletedMessageRow(dmRow('m1'), 'c-1');
    state().updateMessage(placeholder, DM);
    expect(byId('m1')).toBe(placeholder);
  });

  it(`keeps at most ${RECENT_CHANGES_MAX} such edits: the oldest goes first`, () => {
    open(CH);
    const edit = (id: string) => row(id, { content: 'edited', editedAt: EDIT_1 });
    state().updateMessage(edit('first'), CH);
    state().updateMessage(edit('second'), CH);
    for (let i = 0; i < RECENT_CHANGES_MAX - 1; i++) state().updateMessage(edit(`e${i}`), CH);

    state().addMessage(row('first'), CH);
    state().addMessage(row('second'), CH);
    expect(byId('first')?.content).toBe('text of first');
    expect(byId('second')?.content).toBe('edited');
  });

  for (const by of ['a page', 'an insert'] as const) {
    it(`an edit ${by} applied is kept no more: it takes no place among the ${RECENT_CHANGES_MAX}`, async () => {
      open(CH);
      const edit = (id: string) => row(id, { content: 'edited', editedAt: EDIT_1 });
      state().updateMessage(edit('first'), CH);
      for (let i = 0; i < RECENT_CHANGES_MAX - 1; i++) state().updateMessage(edit(`e${i}`), CH);
      if (by === 'a page') {
        apiGet.mockResolvedValueOnce(page([row('e0')]));
        await state().fetchMessages('ch-1');
      } else {
        state().addMessage(row('e0'), CH);
      }
      expect(byId('e0')?.content).toBe('edited');

      // one more: the bound is not reached, the oldest is still kept
      state().updateMessage(edit('last'), CH);
      state().addMessage(row('first', { createdAt: at(1) }), CH);
      expect(byId('first')?.content).toBe('edited');
    });
  }

  it(`keeps such an edit for ${RECENT_CHANGE_MAX_AGE_MS / 60_000} minutes, and a clock stepped back keeps it`, () => {
    open(CH);
    vi.useFakeTimers();
    const start = Date.parse('2026-11-20T12:00:00.000Z');
    vi.setSystemTime(new Date(start));
    state().updateMessage(row('m1', { content: 'edited', editedAt: EDIT_1 }), CH);
    state().updateMessage(row('m2', { content: 'edited', editedAt: EDIT_1 }), CH);
    state().updateMessage(row('m3', { content: 'edited', editedAt: EDIT_1 }), CH);

    vi.setSystemTime(new Date(start - 3_600_000));
    state().addMessage(row('m1'), CH);
    vi.setSystemTime(new Date(start + RECENT_CHANGE_MAX_AGE_MS - 1));
    state().addMessage(row('m2'), CH);
    vi.setSystemTime(new Date(start + RECENT_CHANGE_MAX_AGE_MS));
    state().addMessage(row('m3'), CH);

    expect(byId('m1')?.content).toBe('edited');
    expect(byId('m2')?.content).toBe('edited');
    expect(byId('m3')?.content).toBe('text of m3');
  });

  it('an edit kept for a row not shown is forgotten at a change of view and at logout', () => {
    open(CH);
    state().updateMessage(row('m1', { content: 'edited', editedAt: EDIT_1 }), CH);
    state().clearMessages();
    open(CH);
    expect(state().addMessage(row('m1'), CH)).toBe(true);
    expect(byId('m1')?.content).toBe('text of m1');

    state().updateMessage(row('m2', { content: 'edited', editedAt: EDIT_1 }), CH);
    resetChatViewState();
    open(CH);
    expect(state().addMessage(row('m2'), CH)).toBe(true);
    expect(byId('m2')?.content).toBe('text of m2');
  });
});

