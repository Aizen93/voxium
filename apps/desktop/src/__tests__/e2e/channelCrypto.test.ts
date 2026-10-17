import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildE2EPlaintext, buildMegolmEnvelope, e2eChannelScope } from '@voxium/shared';
import type { Message } from '@voxium/shared';

/**
 * channelCrypto is the secure-channel twin of dmCrypto and inherits its
 * security posture: the display layer is a boundary. A message the server
 * says was "not encrypted" in a secure channel is a forgery vector, and every
 * service call must carry the CHANNEL scope — a channel message decrypted (or
 * cached) under a bare conversation id would cross the scope separation the
 * whole design leans on.
 */

const getCachedPlaintext = vi.fn();
const decryptMessage = vi.fn();
const encryptChannelMessage = vi.fn();
const cachePlaintext = vi.fn();
const searchDecrypted = vi.fn();

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({
      getCachedPlaintext,
      decryptMessage,
      encryptChannelMessage,
      cachePlaintext,
      searchDecrypted,
    }),
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } }) },
}));

vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ members: [] }) },
}));

const flagIdentityChanged = vi.fn();
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ flagIdentityChanged }) },
}));

import {
  decryptChannelMessageForDisplay,
  decryptChannelMessagesForDisplay,
  prepareOutgoingChannelMessage,
  cacheSentChannelPlaintext,
  DECRYPT_FAILED_CONTENT,
  E2EIdentityChangedError,
} from '../../services/e2e/channelCrypto';

const ENVELOPE = buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVydGV4dA');

function channelRow(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    type: 'user',
    content: ENVELOPE,
    encrypted: true,
    channelId: 'sec-1',
    conversationId: null,
    author: { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null },
    createdAt: new Date().toISOString(),
    editedAt: null,
    reactions: [],
    ...over,
  } as unknown as Message;
}

describe('channelCrypto — display boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptMessage.mockResolvedValue({ text: buildE2EPlaintext('decrypted!') });
  });

  it('decrypts through the CHANNEL scope, never a bare id', async () => {
    const result = await decryptChannelMessageForDisplay(channelRow());

    expect(result.content).toBe('decrypted!');
    expect(decryptMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: e2eChannelScope('sec-1') }),
    );
  });

  it('REFUSES an encrypted:false user row — the flag is the server\'s word', async () => {
    const result = await decryptChannelMessageForDisplay(
      channelRow({ encrypted: false, content: 'forged words under a member\'s name' }),
    );

    expect(result.content).toBe(DECRYPT_FAILED_CONTENT);
    expect(decryptMessage).not.toHaveBeenCalled();
  });

  it('refuses system rows too: channels have no server notices, and the type is the server\'s word', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const row = channelRow({ encrypted: false, type: 'system', content: 'Voice call started', attachments: [{ id: 'a1', s3Key: 'attachments/ch-x/y', fileName: 'y', fileSize: 1, mimeType: 'image/png', expired: false }] } as Partial<Message>);
      const result = await decryptChannelMessageForDisplay(row);

      expect(result.content).toBe(DECRYPT_FAILED_CONTENT);
      expect(result.encrypted).toBe(true);
      expect(result.attachments).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops a wire e2eAttachments and locks an unencrypted reply quote on an authentic message', async () => {
    decryptMessage.mockResolvedValue({ text: buildE2EPlaintext('hello') });
    const author = { id: 'peer', username: 'peer', displayName: 'Peer' };
    const result = await decryptChannelMessageForDisplay(channelRow({
      e2eAttachments: [{ s3Key: 'attachments/ch-x/evil', key: 'k', iv: 'i', fileName: 'f', fileSize: 1, mimeType: 'image/png' }],
      replyTo: { id: 'p1', content: 'forged quote', encrypted: false, author },
    } as Partial<Message>));

    expect(result.content).toBe('hello');
    expect(result.e2eAttachments).toBeUndefined();
    expect(result.replyTo).toMatchObject({ content: '', encrypted: true });
  });

  it('a row that fails to decrypt keeps no plaintext attachments either', async () => {
    decryptMessage.mockResolvedValue({ failed: true, text: '' });
    const result = await decryptChannelMessageForDisplay(channelRow({
      attachments: [{ id: 'a1', s3Key: 'attachments/ch-x/y.exe', fileName: 'y.exe', fileSize: 1, mimeType: 'application/octet-stream', expired: false }],
    } as Partial<Message>));
    expect(result.content).toBe(DECRYPT_FAILED_CONTENT);
    expect(result.attachments).toEqual([]);
  });

  it('a row without a channel id is refused outright — there is no scope to decrypt it under', async () => {
    const result = await decryptChannelMessageForDisplay(channelRow({
      channelId: null,
      attachments: [{ id: 'a1', s3Key: 'attachments/ch-x/y.exe', fileName: 'y.exe', fileSize: 1, mimeType: 'application/octet-stream', expired: false }],
      replyTo: { id: 'p1', content: 'quoted', encrypted: false, author: { id: 'peer', username: 'peer', displayName: 'Peer' } },
    } as Partial<Message>));
    expect(result.content).toBe(DECRYPT_FAILED_CONTENT);
    expect(result.attachments).toEqual([]);
    expect(result.replyTo).toMatchObject({ content: '', encrypted: true });
    expect(decryptMessage).not.toHaveBeenCalled();
  });

  it('an encrypted row decrypts as a USER row whatever type the server put on it', async () => {
    const result = await decryptChannelMessageForDisplay(channelRow({ type: 'system' }));
    expect(result.content).toBe('decrypted!');
    expect(result.type).toBe('user');
  });

  it('a quote without an author is dropped whole', async () => {
    const result = await decryptChannelMessageForDisplay(channelRow({
      replyTo: { id: 'p1', content: ENVELOPE, encrypted: true },
    } as Partial<Message>));
    expect(result.replyTo).toBeNull();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
  });

  it('a page decrypts every row — no some(encrypted) short-circuit for forged pages', async () => {
    decryptMessage.mockResolvedValue({ text: buildE2EPlaintext('ok') });
    const rows = [
      channelRow({ id: 'a' }),
      channelRow({ id: 'b', encrypted: false, content: 'forged' }),
    ];

    const out = await decryptChannelMessagesForDisplay(rows);

    expect(out[0].content).toBe('ok');
    expect(out[1].content).toBe(DECRYPT_FAILED_CONTENT);
  });

  it('surfaces attachment metas from structured plaintext', async () => {
    const meta = {
      s3Key: 'attachments/ch-sec-1/aa-encrypted.bin',
      fileName: 'real.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      key: 'k'.repeat(43),
      iv: 'aXZpdml2aXZpdml2',
    };
    decryptMessage.mockResolvedValue({ text: buildE2EPlaintext('with file', [meta as never]) });

    const result = await decryptChannelMessageForDisplay(channelRow());

    expect(result.content).toBe('with file');
    expect(result.e2eAttachments?.[0]?.fileName).toBe('real.pdf');
  });
});

describe('channelCrypto — outgoing path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the envelope, the raw plaintext for the cache, and who cannot read yet', async () => {
    const position = { sessionId: 'sess-1', messageIndex: 3 };
    encryptChannelMessage.mockResolvedValue({ envelope: ENVELOPE, position, notReadyUserIds: ['dormant'] });

    const out = await prepareOutgoingChannelMessage('sec-1', 'hi room');

    expect(out.content).toBe(ENVELOPE);
    expect(out.position).toEqual(position);
    expect(out.plaintext).toBe(buildE2EPlaintext('hi room'));
    expect(out.notReadyUserIds).toEqual(['dormant']);
    expect(encryptChannelMessage).toHaveBeenCalledWith('sec-1', buildE2EPlaintext('hi room'));
  });

  it('flags identity changes for the UI and rethrows — the message must not send', async () => {
    encryptChannelMessage.mockRejectedValue(new E2EIdentityChangedError('peer'));

    await expect(prepareOutgoingChannelMessage('sec-1', 'hi')).rejects.toBeInstanceOf(
      E2EIdentityChangedError,
    );
    expect(flagIdentityChanged).toHaveBeenCalledWith('peer');
  });

  it('caches sent plaintext under the CHANNEL scope', async () => {
    await cacheSentChannelPlaintext('msg-1', 'sec-1', 'raw', null, '2026-08-12T00:00:00Z');

    expect(cachePlaintext).toHaveBeenCalledWith(
      'msg-1',
      e2eChannelScope('sec-1'),
      'raw',
      null,
      expect.objectContaining({ authorId: 'me' }),
    );
    expect(cachePlaintext.mock.calls[0][4]).not.toHaveProperty('position');
  });

  it('binds the ratchet position the message was encrypted at, under the CHANNEL scope', async () => {
    const position = { sessionId: 'sess-1', messageIndex: 3 };
    await cacheSentChannelPlaintext('msg-1', 'sec-1', 'raw', '2026-10-17T10:00:00.000Z', undefined, position);

    expect(cachePlaintext).toHaveBeenCalledWith(
      'msg-1',
      e2eChannelScope('sec-1'),
      'raw',
      '2026-10-17T10:00:00.000Z',
      { authorId: 'me', position },
    );
  });
});
