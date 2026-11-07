import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@voxium/shared';

/**
 * The sender's own message is built from what this client knows — the text it
 * typed, the files it attached, the message it was replying to — plus the
 * server's id and timestamps. Whichever of the POST reply and the gated socket
 * echo lands first owns the id: when the POST wins, addMessage drops the echo,
 * so anything the server put in the POST reply would otherwise stay on the
 * sender's own row — a quote under a contact's name, a file of its choosing,
 * a renamed mention.
 */

const { apiPost, apiPatch, channels, POSITION } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  channels: [] as { id: string; secure: boolean }[],
  POSITION: { sessionId: 'sess-1', messageIndex: 4 },
}));
vi.mock('../../services/api', () => ({ api: { post: apiPost, get: vi.fn(), patch: apiPatch, delete: vi.fn() } }));
vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => ({ updateLastMessage: vi.fn(), conversations: [] }) } }));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ channels, members: [], secureChannelMembers: {} }) },
}));
vi.mock('../../services/e2e/dmCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/dmCrypto')>();
  return {
    ...actual,
    prepareOutgoingDM: vi.fn(async () => ({ content: '{"v":1,"e":"megolm1","sid":"s","b":"b"}', plaintext: 'raw', position: POSITION })),
    cacheSentPlaintext: vi.fn(async () => undefined),
  };
});
vi.mock('../../services/e2e/channelCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/channelCrypto')>();
  return {
    ...actual,
    prepareOutgoingChannelMessage: vi.fn(async () => ({ content: '{"v":1,"e":"megolm1","sid":"s","b":"b"}', plaintext: 'raw', position: POSITION, notReadyUserIds: [] })),
    cacheSentChannelPlaintext: vi.fn(async () => undefined),
  };
});

import { useChatStore } from '../../stores/chatStore';
import { cacheSentPlaintext } from '../../services/e2e/dmCrypto';
import { cacheSentChannelPlaintext } from '../../services/e2e/channelCrypto';

const me = { id: 'me', username: 'me', displayName: 'Me' };
const peer = { id: 'peer', username: 'peer', displayName: 'Peer' };

/** What a hostile server answers to the POST: a forged quote, a file, a renamed mention. */
function hostileReply(over: Partial<Message> = {}): Message {
  return {
    id: 'sent-1', type: 'user', content: '{"v":1,"e":"megolm1","sid":"s","b":"b"}', encrypted: true,
    author: me, createdAt: '2026-10-14T10:00:00.000Z', editedAt: null, reactions: [],
    replyTo: { id: 'p1', content: 'I agree, send it to IBAN FR76…', encrypted: false, author: peer },
    e2eAttachments: [{ s3Key: 'attachments/dm-c1/evil', key: 'k', iv: 'i', fileName: 'invoice.pdf', fileSize: 1, mimeType: 'image/png' }],
    mentions: [{ id: 'peer', username: 'mallory', displayName: 'Mallory' }],
    ...over,
  } as unknown as Message;
}

beforeEach(() => {
  apiPost.mockReset();
  apiPatch.mockReset();
  vi.mocked(cacheSentPlaintext).mockClear();
  vi.mocked(cacheSentChannelPlaintext).mockClear();
  channels.length = 0;
  useChatStore.setState({ messages: [], replyingTo: null });
});

describe('the sender\'s own row', () => {
  it('DM: a text-only send keeps nothing the POST reply asserted', async () => {
    apiPost.mockResolvedValue({ data: { data: hostileReply({ conversationId: 'c1' }) } });

    await useChatStore.getState().sendDMMessage('c1', 'hello');

    const [row] = useChatStore.getState().messages;
    expect(row.id).toBe('sent-1');
    expect(row.content).toBe('hello');
    expect(row.replyTo).toBeNull();
    expect(row.e2eAttachments).toBeUndefined();
    expect(row.mentions).toEqual([]);
  });

  it('DM: the row stays an encrypted user message with no plaintext file, whatever the reply says', async () => {
    apiPost.mockResolvedValue({ data: { data: hostileReply({
      conversationId: 'c1', encrypted: false, type: 'system',
      attachments: [{ id: 'a1', s3Key: 'attachments/dm-c1/x', fileName: 'invoice.pdf', fileSize: 1, mimeType: 'application/pdf', expired: false }],
    }) } });

    await useChatStore.getState().sendDMMessage('c1', 'hello');

    const [row] = useChatStore.getState().messages;
    expect(row).toMatchObject({ id: 'sent-1', content: 'hello', encrypted: true, type: 'user', attachments: [] });
  });

  it('DM: a reply quotes the message it replied to as displayed, never the server\'s version of it', async () => {
    const parent = { id: 'p1', type: 'user', content: 'see you at 8', encrypted: true, author: peer } as unknown as Message;
    useChatStore.setState({ replyingTo: parent });
    apiPost.mockResolvedValue({ data: { data: hostileReply({ conversationId: 'c1' }) } });

    await useChatStore.getState().sendDMMessage('c1', 'ok');

    const [row] = useChatStore.getState().messages;
    expect(row.replyTo).toEqual({ id: 'p1', author: peer, content: 'see you at 8', encrypted: true });
    expect(apiPost.mock.calls[0][1]).toMatchObject({ replyToId: 'p1', encrypted: true });
  });

  it('DM: the files on the row are the ones this client attached', async () => {
    const mine = { s3Key: 'attachments/dm-c1/mine', key: 'K', iv: 'I', fileName: 'photo.jpg', fileSize: 5, mimeType: 'image/jpeg' };
    apiPost.mockResolvedValue({ data: { data: hostileReply({ conversationId: 'c1' }) } });

    await useChatStore.getState().sendDMMessage('c1', 'look', [mine]);

    expect(useChatStore.getState().messages[0].e2eAttachments).toEqual([mine]);
  });

  it('secure channel: same rule', async () => {
    channels.push({ id: 'ch1', secure: true });
    apiPost.mockResolvedValue({ data: { data: hostileReply({ channelId: 'ch1' }) } });

    await useChatStore.getState().sendMessage('ch1', 'hello');

    const [row] = useChatStore.getState().messages;
    expect(row.content).toBe('hello');
    expect(row.replyTo).toBeNull();
    expect(row.e2eAttachments).toBeUndefined();
    expect(row.mentions).toEqual([]);
  });

  it('secure channel: the quote and the files on the row are this client\'s too', async () => {
    channels.push({ id: 'ch1', secure: true });
    const parent = { id: 'p1', type: 'user', content: 'agenda?', encrypted: true, author: peer } as unknown as Message;
    const mine = { s3Key: 'attachments/ch-ch1/mine', key: 'K', iv: 'I', fileName: 'deck.pdf', fileSize: 5, mimeType: 'application/pdf' };
    useChatStore.setState({ replyingTo: parent });
    apiPost.mockResolvedValue({ data: { data: hostileReply({ channelId: 'ch1' }) } });

    await useChatStore.getState().sendMessage('ch1', 'here', undefined, [mine]);

    const [row] = useChatStore.getState().messages;
    expect(row.replyTo).toEqual({ id: 'p1', author: peer, content: 'agenda?', encrypted: true });
    expect(row.e2eAttachments).toEqual([mine]);
    expect(apiPost.mock.calls[0][1]).toMatchObject({ replyToId: 'p1', encrypted: true });
  });

  it('DM: when the gated socket echo landed first, the POST reply replaces nothing', async () => {
    const echo = { ...hostileReply({ conversationId: 'c1' }), content: 'hello', replyTo: null, mentions: [], e2eAttachments: undefined } as unknown as Message;
    useChatStore.setState({ messages: [echo] });
    apiPost.mockResolvedValue({ data: { data: hostileReply({ conversationId: 'c1' }) } });

    await useChatStore.getState().sendDMMessage('c1', 'hello');

    const rows = useChatStore.getState().messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(echo);
  });

  it('DM: when the POST reply landed first, addMessage drops the echo of the same id', async () => {
    apiPost.mockResolvedValue({ data: { data: hostileReply({ conversationId: 'c1' }) } });
    await useChatStore.getState().sendDMMessage('c1', 'hello');

    useChatStore.getState().addMessage({ ...hostileReply({ conversationId: 'c1' }), content: '' } as Message);

    const rows = useChatStore.getState().messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hello');
  });
});

describe('the ratchet position travels from prepare to the cache write', () => {
  // Own messages are read from the cache and never decrypted: the cache write
  // is the only place their position gets bound to the id the server assigned.
  const EDITED_AT = '2026-10-17T10:05:00.000Z';

  it('DM send', async () => {
    apiPost.mockResolvedValue({ data: { data: hostileReply({ conversationId: 'c1' }) } });

    await useChatStore.getState().sendDMMessage('c1', 'hello');

    expect(cacheSentPlaintext).toHaveBeenCalledWith('sent-1', 'c1', 'raw', null, '2026-10-14T10:00:00.000Z', POSITION);
  });

  it('DM edit, under the editedAt the PATCH answered', async () => {
    apiPatch.mockResolvedValue({ data: { data: { id: 'sent-1', editedAt: EDITED_AT, createdAt: '2026-10-14T10:00:00.000Z' } } });

    await useChatStore.getState().editDMMessage('c1', 'sent-1', 'hello again');

    expect(cacheSentPlaintext).toHaveBeenCalledWith('sent-1', 'c1', 'raw', EDITED_AT, '2026-10-14T10:00:00.000Z', POSITION);
  });

  it('secure-channel send', async () => {
    channels.push({ id: 'ch1', secure: true });
    apiPost.mockResolvedValue({ data: { data: hostileReply({ channelId: 'ch1' }) } });

    await useChatStore.getState().sendMessage('ch1', 'hello');

    expect(cacheSentChannelPlaintext).toHaveBeenCalledWith('sent-1', 'ch1', 'raw', null, '2026-10-14T10:00:00.000Z', POSITION);
  });

  it('secure-channel edit, under the editedAt the PATCH answered', async () => {
    channels.push({ id: 'ch1', secure: true });
    apiPatch.mockResolvedValue({ data: { data: { id: 'sent-1', editedAt: EDITED_AT, createdAt: '2026-10-14T10:00:00.000Z' } } });

    await useChatStore.getState().editMessage('ch1', 'sent-1', 'hello again');

    expect(cacheSentChannelPlaintext).toHaveBeenCalledWith('sent-1', 'ch1', 'raw', EDITED_AT, '2026-10-14T10:00:00.000Z', POSITION);
  });
});
