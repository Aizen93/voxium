import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `message:bulk_deleted` as MainLayout registers it: it reaches every channel
 * room the user can view, and chatStore (shared with DMs) holds one view's
 * rows — so it acts only on the channel on screen, and only on a payload
 * whose ids are strings.
 */

type Row = { id: string; channelId: string; webhookId?: string | null };
const { chat, removeWebhookMessages, fetchMessages } = vi.hoisted(() => {
  const chat = { messages: [] as Row[], hasMore: false, hasMoreAfter: false };
  return {
    chat,
    // the store's filter, so the handler sees what the purge left behind
    removeWebhookMessages: vi.fn((channelId: string, webhookId: string) => {
      chat.messages = chat.messages.filter((m) => !(m.channelId === channelId && m.webhookId === webhookId));
    }),
    fetchMessages: vi.fn(async (channelId: string, before?: string) => { void channelId; void before; }),
  };
});
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ ...chat, removeWebhookMessages, fetchMessages }) },
}));

import { handleMessageBulkDeleted } from '../../services/webhookSocketHandlers';

let warn: ReturnType<typeof vi.spyOn>;
const hookRow: Row = { id: 'm-hook', channelId: 'ch-1', webhookId: 'wh-1' };
const humanRow: Row = { id: 'm-human', channelId: 'ch-1', webhookId: null };

beforeEach(() => {
  removeWebhookMessages.mockClear();
  fetchMessages.mockClear();
  chat.messages = [humanRow, hookRow];
  chat.hasMore = false;
  chat.hasMoreAfter = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
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
