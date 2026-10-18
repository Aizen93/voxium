import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@voxium/shared';

/**
 * `message:bulk_deleted` (a moderator deleted a webhook with purge) drops the
 * loaded rows that webhook posted in that channel. chatStore is shared with
 * DMs and holds other authors' rows, so a row goes ONLY when both its channel
 * and its webhook match.
 */

vi.mock('../../services/api', () => ({ api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } }));
vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => ({ updateLastMessage: vi.fn(), conversations: [] }) } }));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ channels: [], members: [], secureChannelMembers: {} }) },
}));

import { useChatStore } from '../../stores/chatStore';

const human = { id: 'u-1', username: 'alice', displayName: 'Alice', avatarUrl: null };
const hook = (webhookId: string, name = 'Deploy bot') =>
  ({ id: `webhook:${webhookId}`, username: name, displayName: name, avatarUrl: null, isWebhook: true });

function msg(id: string, over: Partial<Message>): Message {
  return {
    id, type: 'user', content: id, channelId: 'ch-1', conversationId: null,
    author: human, createdAt: '2026-10-18T10:00:00.000Z', editedAt: null, reactions: [],
    ...over,
  } as Message;
}

const fromHookA = msg('a1', { author: hook('wh-a'), webhookId: 'wh-a', mentions: [] });
const fromHookA2 = msg('a2', { author: hook('wh-a', 'Renamed'), webhookId: 'wh-a', mentions: [] });
const fromHookB = msg('b1', { author: hook('wh-b'), webhookId: 'wh-b', mentions: [] });
const fromHuman = msg('h1', {});
const fromHookAElsewhere = msg('a-other', { channelId: 'ch-2', author: hook('wh-a'), webhookId: 'wh-a', mentions: [] });
const fromDeletedHook = msg('d1', { author: { ...hook('deleted'), id: 'webhook:deleted' }, webhookId: null, mentions: [] });

beforeEach(() => {
  useChatStore.setState({ messages: [fromHookA, fromHuman, fromHookB, fromHookA2, fromHookAElsewhere, fromDeletedHook] });
});

describe('chatStore.removeWebhookMessages', () => {
  it('removes only the rows matching BOTH the channel and the webhook', () => {
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-a');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['h1', 'b1', 'a-other', 'd1']);
  });

  it('leaves a human row and another webhook\'s rows in the same channel, and the same webhook\'s rows in another channel', () => {
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-a');
    const left = useChatStore.getState().messages;
    expect(left).toContain(fromHuman);
    expect(left).toContain(fromHookB);
    expect(left).toContain(fromHookAElsewhere);
  });

  it('never matches the null webhookId of a deleted webhook\'s rows', () => {
    useChatStore.getState().removeWebhookMessages('ch-1', 'deleted');
    expect(useChatStore.getState().messages).toContain(fromDeletedHook);
    expect(useChatStore.getState().messages).toHaveLength(6);
  });

  it('is immutable: a new array, the untouched items are the same objects', () => {
    const before = useChatStore.getState().messages;
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-b');
    const after = useChatStore.getState().messages;
    expect(after).not.toBe(before);
    expect(before).toHaveLength(6);
    expect(after).toHaveLength(5);
    for (const m of after) expect(before).toContain(m);
  });

  it('a webhook with no loaded rows changes nothing but the array identity', () => {
    const before = useChatStore.getState().messages;
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-nope');
    expect(useChatStore.getState().messages).toEqual(before);
  });
});

describe('chatStore.removeWebhookMessages — quotes of the purged rows', () => {
  // The server deletes the webhook's rows and SetNulls `replyToId` on every
  // reply to them: a loaded reply must not keep quoting a message that is gone
  const quoteOf = (parent: Message) => ({ id: parent.id, content: parent.content, author: parent.author });
  const replyToA = msg('r-a', { replyToId: 'a1', replyTo: quoteOf(fromHookA) });
  const replyToB = msg('r-b', { replyToId: 'b1', replyTo: quoteOf(fromHookB) });
  const replyToHuman = msg('r-h', { replyToId: 'h1', replyTo: quoteOf(fromHuman) });
  const replyElsewhere = msg('r-other', { channelId: 'ch-2', replyToId: 'a-other', replyTo: quoteOf(fromHookAElsewhere) });

  beforeEach(() => {
    useChatStore.setState({ messages: [fromHookA, fromHuman, fromHookB, replyToA, replyToB, replyToHuman, replyElsewhere] });
  });

  it('a reply quoting the purged webhook loses its quote (replyTo AND replyToId null), the reply itself stays', () => {
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-a');
    const after = useChatStore.getState().messages;
    expect(after.map((m) => m.id)).toEqual(['h1', 'b1', 'r-a', 'r-b', 'r-h', 'r-other']);
    const reply = after.find((m) => m.id === 'r-a')!;
    expect(reply.replyTo).toBeNull();
    expect(reply.replyToId).toBeNull();
    // everything else on the row is as it was
    expect({ ...reply, replyTo: replyToA.replyTo, replyToId: replyToA.replyToId }).toEqual(replyToA);
  });

  it('quotes of another webhook, of a human, and of the same webhook in ANOTHER channel stay — the same objects', () => {
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-a');
    const after = useChatStore.getState().messages;
    expect(after.find((m) => m.id === 'r-b')).toBe(replyToB);
    expect(after.find((m) => m.id === 'r-h')).toBe(replyToHuman);
    expect(after.find((m) => m.id === 'r-other')).toBe(replyElsewhere);
  });

  it('is immutable: the reply is a new object, the one in the old array untouched', () => {
    const before = useChatStore.getState().messages;
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-a');
    expect(before.find((m) => m.id === 'r-a')).toBe(replyToA);
    expect(replyToA.replyTo).not.toBeNull();
    expect(replyToA.replyToId).toBe('a1');
    expect(useChatStore.getState().messages.find((m) => m.id === 'r-a')).not.toBe(replyToA);
  });

  it('a quote of the purged webhook whose parent was never loaded is cleared too', () => {
    useChatStore.setState({ messages: [replyToA] });
    useChatStore.getState().removeWebhookMessages('ch-1', 'wh-a');
    expect(useChatStore.getState().messages[0].replyTo).toBeNull();
  });
});
