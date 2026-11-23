import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `message:bulk_deleted` as MainLayout registers it: it reaches every channel
 * room the user can view, and chatStore (shared with DMs) holds one view's
 * rows — so it acts only on the channel on screen, and only on a payload
 * whose ids are strings.
 */

type Row = { id: string; channelId: string; webhookId?: string | null };
const { chat, removeWebhookMessages, fetchMessages, markWebhookDeleted, refreshChannelUnread } = vi.hoisted(() => {
  const chat = { messages: [] as Row[], hasMore: false, hasMoreAfter: false };
  return {
    chat,
    // the store's filter, so the handler sees what the purge left behind
    removeWebhookMessages: vi.fn((channelId: string, webhookId: string) => {
      chat.messages = chat.messages.filter((m) => !(m.channelId === channelId && m.webhookId === webhookId));
    }),
    fetchMessages: vi.fn(async (channelId: string, before?: string) => { void channelId; void before; }),
    markWebhookDeleted: vi.fn(),
    refreshChannelUnread: vi.fn(async (channelIds: string[]) => { void channelIds; }),
  };
});
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ ...chat, removeWebhookMessages, fetchMessages, markWebhookDeleted }) },
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ refreshChannelUnread }) },
}));

import {
  handleMessageBulkDeleted,
  handleWebhookMessagesDetached,
  isPurgedWebhookMessage,
  withDetachedWebhookLabel,
  resetWebhookSocketState,
  PURGED_WEBHOOK_MEMORY_MS,
  PURGED_WEBHOOK_MAX,
  UNREAD_REFRESH_DEBOUNCE_MS,
} from '../../services/webhookSocketHandlers';

let warn: ReturnType<typeof vi.spyOn>;
const hookRow: Row = { id: 'm-hook', channelId: 'ch-1', webhookId: 'wh-1' };
const humanRow: Row = { id: 'm-human', channelId: 'ch-1', webhookId: null };

beforeEach(() => {
  resetWebhookSocketState();
  markWebhookDeleted.mockClear();
  refreshChannelUnread.mockClear();
  removeWebhookMessages.mockClear();
  fetchMessages.mockClear();
  chat.messages = [humanRow, hookRow];
  chat.hasMore = false;
  chat.hasMoreAfter = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
  resetWebhookSocketState();
});

const payload = { channelId: 'ch-1', webhookId: 'wh-1', count: 3 };

describe('handleMessageBulkDeleted', () => {
  it('viewing the channel: drops that webhook\'s rows (both ids passed through)', () => {
    const isViewing = vi.fn((id: string | null | undefined) => id === 'ch-1');
    handleMessageBulkDeleted(payload, isViewing);
    expect(isViewing).toHaveBeenCalledWith('ch-1');
    expect(removeWebhookMessages).toHaveBeenCalledTimes(1);
    expect(removeWebhookMessages).toHaveBeenCalledWith('ch-1', 'wh-1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('not viewing it (another channel, or the DM view): nothing moves', () => {
    handleMessageBulkDeleted(payload, () => false);
    expect(removeWebhookMessages).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a payload without count still acts (count is informational)', () => {
    handleMessageBulkDeleted({ channelId: 'ch-1', webhookId: 'wh-1' }, () => true);
    expect(removeWebhookMessages).toHaveBeenCalledWith('ch-1', 'wh-1');
  });

  it.each([
    ['null', null],
    ['a string', 'ch-1'],
    ['a missing webhookId', { channelId: 'ch-1', count: 1 }],
    ['a missing channelId', { webhookId: 'wh-1', count: 1 }],
    ['a numeric channelId', { channelId: 42, webhookId: 'wh-1', count: 1 }],
    ['an object webhookId', { channelId: 'ch-1', webhookId: { $ne: '' }, count: 1 }],
    ['empty ids', { channelId: '', webhookId: '', count: 0 }],
  ])('a malformed payload (%s) is ignored with a console.warn', (_label, bad) => {
    const isViewing = vi.fn(() => true);
    handleMessageBulkDeleted(bad, isViewing);
    expect(removeWebhookMessages).not.toHaveBeenCalled();
    expect(isViewing).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('handleMessageBulkDeleted — a purge that empties the loaded window', () => {
  // MessageList renders no Virtuoso for an empty list and handleStartReached
  // bails on length 0: with more history on the server, an emptied window
  // would stay blank for good unless the handler reloads the channel.
  const viewing = (id: string | null | undefined) => id === 'ch-1';

  it('emptied with older history left (hasMore): reloads the channel', () => {
    chat.messages = [hookRow];
    chat.hasMore = true;
    handleMessageBulkDeleted(payload, viewing);
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(fetchMessages).toHaveBeenCalledWith('ch-1');
  });

  it('emptied inside a jumped-to window (hasMoreAfter): reloads the channel', () => {
    chat.messages = [hookRow];
    chat.hasMoreAfter = true;
    handleMessageBulkDeleted(payload, viewing);
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(fetchMessages).toHaveBeenCalledWith('ch-1');
  });

  it('emptied with nothing more on the server: no fetch (the channel IS empty)', () => {
    chat.messages = [hookRow];
    handleMessageBulkDeleted(payload, viewing);
    expect(chat.messages).toHaveLength(0);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('rows left in the window: no fetch, whatever the server holds', () => {
    chat.hasMore = true;
    chat.hasMoreAfter = true;
    handleMessageBulkDeleted(payload, viewing);
    expect(chat.messages).toEqual([humanRow]);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('a window that was already empty (nothing purged): no fetch', () => {
    chat.messages = [];
    chat.hasMore = true;
    handleMessageBulkDeleted(payload, viewing);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('not viewing the channel: no fetch', () => {
    chat.messages = [hookRow];
    chat.hasMore = true;
    handleMessageBulkDeleted(payload, () => false);
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(chat.messages).toEqual([hookRow]);
  });
});

describe('handleWebhookMessagesDetached', () => {
  it('re-labels the webhook rows of that channel through the store, which decides by scope', () => {
    handleWebhookMessagesDetached({ channelId: 'ch-1', webhookId: 'wh-1' });
    expect(markWebhookDeleted).toHaveBeenCalledTimes(1);
    expect(markWebhookDeleted).toHaveBeenCalledWith('ch-1', 'wh-1');
    expect(removeWebhookMessages).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['a string', 'ch-1'],
    ['a missing webhookId', { channelId: 'ch-1' }],
    ['a numeric channelId', { channelId: 7, webhookId: 'wh-1' }],
    ['empty ids', { channelId: '', webhookId: '' }],
  ])('a malformed payload (%s) is ignored with a console.warn', (_label, bad) => {
    handleWebhookMessagesDetached(bad);
    expect(markWebhookDeleted).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('handleMessageBulkDeleted: the unread counts are asked again, debounced', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('a channel NOT on screen is refreshed too, after the debounce and not before', () => {
    handleMessageBulkDeleted(payload, () => false);
    expect(refreshChannelUnread).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS - 1);
    expect(refreshChannelUnread).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refreshChannelUnread).toHaveBeenCalledTimes(1);
    expect(refreshChannelUnread).toHaveBeenCalledWith(['ch-1']);
  });

  it('the channel on screen is refreshed as well as emptied', () => {
    handleMessageBulkDeleted(payload, (id) => id === 'ch-1');
    expect(removeWebhookMessages).toHaveBeenCalledWith('ch-1', 'wh-1');
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS);
    expect(refreshChannelUnread).toHaveBeenCalledWith(['ch-1']);
  });

  it('a purge across channels (one receipt each) is ONE refresh naming every channel once', () => {
    handleMessageBulkDeleted({ channelId: 'ch-1', webhookId: 'wh-1', count: 2 }, () => false);
    handleMessageBulkDeleted({ channelId: 'ch-2', webhookId: 'wh-1', count: 5 }, () => false);
    handleMessageBulkDeleted({ channelId: 'ch-1', webhookId: 'wh-1', count: 0 }, () => false);
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 5);
    expect(refreshChannelUnread).toHaveBeenCalledTimes(1);
    expect(refreshChannelUnread).toHaveBeenCalledWith(['ch-1', 'ch-2']);
  });

  it('a receipt after the burst starts the next one', () => {
    handleMessageBulkDeleted(payload, () => false);
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS);
    handleMessageBulkDeleted({ channelId: 'ch-3', webhookId: 'wh-9', count: 1 }, () => false);
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS);
    expect(refreshChannelUnread.mock.calls).toEqual([[['ch-1']], [['ch-3']]]);
  });

  it('a malformed payload schedules nothing', () => {
    handleMessageBulkDeleted({ channelId: 'ch-1' }, () => true);
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 2);
    expect(refreshChannelUnread).not.toHaveBeenCalled();
  });

  it('a refresh that rejects is logged by message and never thrown', async () => {
    refreshChannelUnread.mockRejectedValueOnce(new Error('network down'));
    handleMessageBulkDeleted(payload, () => false);
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('[Webhooks] The unread refresh after a purge failed:', 'network down');
  });

  it('the logout reset cancels a refresh still waiting', () => {
    handleMessageBulkDeleted(payload, () => false);
    resetWebhookSocketState();
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 2);
    expect(refreshChannelUnread).not.toHaveBeenCalled();
  });
});

describe('isPurgedWebhookMessage: a late message:new of a purged webhook', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('nothing is remembered before a purge: a webhook message is accepted', () => {
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(false);
  });

  it('after a purge receipt (any channel, viewed or not) the webhook message is dropped, another webhook and a human are not', () => {
    handleMessageBulkDeleted(payload, () => false);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(true);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-2' })).toBe(false);
    expect(isPurgedWebhookMessage({ webhookId: null })).toBe(false);
    expect(isPurgedWebhookMessage({})).toBe(false);
    expect(isPurgedWebhookMessage(null)).toBe(false);
  });

  it('is accepted again after the bound', () => {
    handleMessageBulkDeleted(payload, () => false);
    vi.advanceTimersByTime(PURGED_WEBHOOK_MEMORY_MS - 1);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(false);
  });

  it('a malformed receipt remembers nothing', () => {
    handleMessageBulkDeleted({ channelId: 'ch-1' }, () => true);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(false);
  });

  it('the memory is bounded: past the cap the oldest webhooks are forgotten first', () => {
    for (let i = 0; i < PURGED_WEBHOOK_MAX + 5; i++) {
      handleMessageBulkDeleted({ channelId: 'ch-1', webhookId: `wh-${i}`, count: 1 }, () => false);
    }
    expect(isPurgedWebhookMessage({ webhookId: 'wh-0' })).toBe(false);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-4' })).toBe(false);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-5' })).toBe(true);
    expect(isPurgedWebhookMessage({ webhookId: `wh-${PURGED_WEBHOOK_MAX + 4}` })).toBe(true);
  });

  it('is forgotten at logout', () => {
    handleMessageBulkDeleted(payload, () => false);
    resetWebhookSocketState();
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(false);
  });
});

describe('withDetachedWebhookLabel: a late message:new of a webhook deleted without purge', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  const live = (webhookId: string | null) => ({
    id: 'm1', content: 'late', webhookId, webhookName: 'CI',
    author: { id: webhookId ? `webhook:${webhookId}` : 'u-1', username: 'CI', displayName: 'CI', avatarUrl: null, isWebhook: !!webhookId },
  });

  it('nothing is remembered before the notice: the row is returned as it is', () => {
    const m = live('wh-1');
    expect(withDetachedWebhookLabel(m)).toBe(m);
  });

  it('after webhook:messages_detached the row takes the deleted-webhook shape: webhookId null, author id webhook:deleted, the name kept', () => {
    handleWebhookMessagesDetached({ channelId: 'ch-1', webhookId: 'wh-1' });
    const shown = withDetachedWebhookLabel(live('wh-1'));
    expect(shown).toMatchObject({ webhookId: null, webhookName: 'CI', author: { id: 'webhook:deleted', displayName: 'CI', isWebhook: true } });
  });

  it('another webhook, a human and a missing id are returned as they are; the row is never dropped (it is not a purge)', () => {
    handleWebhookMessagesDetached({ channelId: 'ch-1', webhookId: 'wh-1' });
    const other = live('wh-2');
    const human = live(null);
    expect(withDetachedWebhookLabel(other)).toBe(other);
    expect(withDetachedWebhookLabel(human)).toBe(human);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(false);
  });

  it('is applied again after the bound', () => {
    handleWebhookMessagesDetached({ channelId: 'ch-1', webhookId: 'wh-1' });
    vi.advanceTimersByTime(PURGED_WEBHOOK_MEMORY_MS);
    const m = live('wh-1');
    expect(withDetachedWebhookLabel(m)).toBe(m);
  });

  it('shares the memory bound of the purged ones and is forgotten at logout', () => {
    for (let i = 0; i < PURGED_WEBHOOK_MAX + 5; i++) handleWebhookMessagesDetached({ channelId: 'ch-1', webhookId: `wh-${i}` });
    const first = live('wh-0');
    expect(withDetachedWebhookLabel(first)).toBe(first);
    expect(withDetachedWebhookLabel(live('wh-9')).webhookId).toBeNull();
    resetWebhookSocketState();
    const again = live('wh-9');
    expect(withDetachedWebhookLabel(again)).toBe(again);
  });

  it('a malformed notice remembers nothing', () => {
    handleWebhookMessagesDetached({ channelId: 'ch-1' });
    const m = live('wh-1');
    expect(withDetachedWebhookLabel(m)).toBe(m);
  });

  it('the last announcement of a webhook wins: purged after detached is dropped, not relabelled', () => {
    handleWebhookMessagesDetached({ channelId: 'ch-1', webhookId: 'wh-1' });
    handleMessageBulkDeleted({ channelId: 'ch-1', webhookId: 'wh-1', count: 1 }, () => false);
    expect(isPurgedWebhookMessage({ webhookId: 'wh-1' })).toBe(true);
    const m = live('wh-1');
    expect(withDetachedWebhookLabel(m)).toBe(m);
  });
});
