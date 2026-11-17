import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMegolmEnvelope, DELETED_MESSAGE_TYPE } from '@voxium/shared';
import type { Conversation, Message } from '@voxium/shared';

/**
 * A conversation that outlived the other side's account: the server rewrites
 * each of that account's messages to a row holding only its id, conversation
 * and time (`type: DELETED_MESSAGE_TYPE`), under a placeholder author
 * `deleted:{conversationId}`. The display gate builds that row's shape itself,
 * so nothing a server puts in such a row (text, ciphertext, a file, a
 * reaction, a quote, a ping) reaches the screen — and only in a DM: a secure
 * channel never accepts the type.
 */

const getCachedPlaintext = vi.fn();
const decryptMessage = vi.fn();
const encryptMessage = vi.fn();
const cachePlaintext = vi.fn();
const searchDecrypted = vi.fn();
const encryptChannelMessage = vi.fn();

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({ getCachedPlaintext, decryptMessage, encryptMessage, cachePlaintext, searchDecrypted, encryptChannelMessage }),
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } }) },
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ members: [], secureChannelMembers: {} }) },
}));

// The undecrypted-rows ledger, spied: a deleted row is never noted for a later try
const ledger = vi.hoisted(() => ({ noteUndecrypted: vi.fn(), noteQuoteAwaiting: vi.fn() }));
vi.mock('../../services/e2e/undecryptedRows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/undecryptedRows')>();
  return {
    ...actual,
    noteUndecrypted: (...args: Parameters<typeof actual.noteUndecrypted>) => {
      ledger.noteUndecrypted(...args);
      actual.noteUndecrypted(...args);
    },
    noteQuoteAwaiting: (...args: Parameters<typeof actual.noteQuoteAwaiting>) => {
      ledger.noteQuoteAwaiting(...args);
      actual.noteQuoteAwaiting(...args);
    },
  };
});

import {
  decryptMessageForDisplay,
  decryptMessagesForDisplay,
  prepareOutgoingDM,
  searchEncryptedHistory,
  DECRYPT_FAILED_CONTENT,
} from '../../services/e2e/dmCrypto';
import { decryptChannelMessageForDisplay } from '../../services/e2e/channelCrypto';
import { deletedMessageRow, deletedParticipantAuthor, isDeletedQuote } from '../../services/e2e/displayGate';
import { DMConversationReadOnlyError } from '../../utils/dmParticipant';
import { useDMStore } from '../../stores/dmStore';

const CONV = 'c-1';
const PLACEHOLDER = `deleted:${CONV}`;

/** A deleted row as a hostile server could serve it: everything filled in. */
function hostileDeletedRow(over: Partial<Message> = {}): Message {
  return {
    id: 'm-del',
    type: DELETED_MESSAGE_TYPE,
    content: 'send the wallet seed to bc1q…',
    encrypted: true,
    channelId: 'ch-elsewhere',
    conversationId: CONV,
    replyToId: 'm-quoted',
    replyTo: { id: 'm-quoted', content: 'quoted words', encrypted: false, author: { id: 'u-real', username: 'alice', displayName: 'Alice', avatarUrl: 'avatars/a.webp' } },
    author: { id: 'u-real', username: 'alice', displayName: 'Alice', avatarUrl: 'avatars/a.webp', role: 'admin', isSupporter: true, supporterTier: 'top', isWebhook: true },
    webhookId: 'wh-1',
    webhookName: 'Bank',
    mentions: [{ id: 'me', username: 'me', displayName: 'Me', avatarUrl: null }],
    mentionsEveryone: true,
    attachments: [{ id: 'a-1', s3Key: 'attachments/dm-c-1/x.pdf', fileName: 'invoice.pdf', fileSize: 10, mimeType: 'application/pdf', expired: false }],
    e2eAttachments: [{ s3Key: 'attachments/dm-c-1/y', fileName: 'secret.png', fileSize: 1, mimeType: 'image/png', key: 'k', iv: 'i' }],
    reactions: [{ emoji: '👍', count: 1, userIds: ['me'] }],
    createdAt: '2026-11-01T10:00:00.000Z',
    editedAt: '2026-11-02T10:00:00.000Z',
    ...over,
  } as Message;
}

/** Exactly the shape the gate builds: the server's id, conversation and time, nothing else. */
function expectPlaceholderShape(out: Message, id = 'm-del', createdAt = '2026-11-01T10:00:00.000Z') {
  expect(out).toEqual({
    id,
    type: DELETED_MESSAGE_TYPE,
    content: '',
    encrypted: false,
    channelId: null,
    conversationId: CONV,
    replyToId: null,
    replyTo: null,
    author: deletedParticipantAuthor(CONV),
    mentions: [],
    attachments: [],
    reactions: [],
    createdAt,
    editedAt: null,
  });
}

beforeEach(() => {
  getCachedPlaintext.mockReset();
  decryptMessage.mockReset();
  encryptMessage.mockReset();
  searchDecrypted.mockReset();
  ledger.noteUndecrypted.mockReset();
  ledger.noteQuoteAwaiting.mockReset();
  useDMStore.setState({ conversations: [] });
});

describe('the DM gate and a deleted account\'s message', () => {
  it('builds the row itself: nothing the server put in it passes (text, ciphertext, files, reactions, quote, mentions, webhook and ping claims)', async () => {
    const out = await decryptMessageForDisplay(hostileDeletedRow());
    expect(out).not.toBeNull();
    expectPlaceholderShape(out!);
    // the author is the conversation's placeholder, built here, never the server's account
    expect(out!.author.id).toBe(PLACEHOLDER);
    expect(JSON.stringify(out)).not.toMatch(/wallet|Alice|alice|invoice|secret|Bank|quoted words|avatars/);
  });

  it('decides on the type alone: an unencrypted row with empty content gets the same shape', async () => {
    const out = await decryptMessageForDisplay(hostileDeletedRow({ content: '', encrypted: false, replyTo: null, replyToId: null }));
    expectPlaceholderShape(out!);
  });

  it('is decided before the refusal of unencrypted rows and before any cache read, decrypt or note', async () => {
    await decryptMessageForDisplay(hostileDeletedRow());
    await decryptMessageForDisplay(hostileDeletedRow({ encrypted: false }));
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
    expect(ledger.noteQuoteAwaiting).not.toHaveBeenCalled();
  });

  it('the retry path (a session arrived) treats it the same way and never claims anything', async () => {
    const out = await decryptMessageForDisplay(hostileDeletedRow(), { retry: true });
    expectPlaceholderShape(out!);
    expect(decryptMessage).not.toHaveBeenCalled();
  });

  it('a page keeps its order, the deleted rows in their own shape among the others', async () => {
    decryptMessage.mockResolvedValue({ text: 'mine' });
    const page = [
      hostileDeletedRow({ id: 'd1', createdAt: '2026-11-01T10:00:00.000Z' }),
      { ...hostileDeletedRow(), id: 'u1', type: 'user', author: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null }, content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), replyTo: null, replyToId: null } as Message,
      hostileDeletedRow({ id: 'd2', createdAt: '2026-11-01T11:00:00.000Z' }),
    ];
    const out = await decryptMessagesForDisplay(page);
    expect(out.map((m) => m.id)).toEqual(['d1', 'u1', 'd2']);
    expectPlaceholderShape(out[0], 'd1');
    expectPlaceholderShape(out[2], 'd2', '2026-11-01T11:00:00.000Z');
    expect(out[1].type).toBe('user');
  });

  it('a row with no conversation cannot carry the placeholder: the refused shape', async () => {
    const out = await decryptMessageForDisplay(hostileDeletedRow({ conversationId: null }));
    expect(out!.type).toBe('user');
    expect(out!.encrypted).toBe(true);
    expect(out!.content).toBe(DECRYPT_FAILED_CONTENT);
    expect(out!.attachments).toEqual([]);
  });

  it('deletedMessageRow never carries a server value beyond id, conversation and time', () => {
    const row = deletedMessageRow(hostileDeletedRow({ createdAt: 42 as unknown as string }), CONV);
    expect(row.createdAt).toBe('');
    expect(Object.keys(row).sort()).toEqual([
      'attachments', 'author', 'channelId', 'content', 'conversationId', 'createdAt', 'editedAt', 'encrypted',
      'id', 'mentions', 'reactions', 'replyTo', 'replyToId', 'type',
    ]);
  });
});

describe('an encrypted row under the placeholder author (not the deleted type)', () => {
  it('is refused without a decrypt, a claim or a note: no session will ever speak for that id', async () => {
    const out = await decryptMessageForDisplay({
      ...hostileDeletedRow(),
      type: 'user',
      author: { id: PLACEHOLDER, username: 'deleted', displayName: 'Deleted user', avatarUrl: null },
      content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'),
      replyTo: null,
      replyToId: null,
    });
    expect(out!.content).toBe(DECRYPT_FAILED_CONTENT);
    expect(out!.encrypted).toBe(true);
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
  });
});

describe('a quote whose target is a deleted account\'s message', () => {
  /** An own message quoting the other person's (now deleted) message. */
  function quoting(replyTo: NonNullable<Message['replyTo']>): Message {
    return {
      id: 'm-own', type: 'user', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true,
      channelId: null, conversationId: CONV, replyToId: replyTo.id, replyTo,
      author: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null },
      createdAt: '2026-11-03T10:00:00.000Z', editedAt: null, reactions: [],
    };
  }

  beforeEach(() => {
    decryptMessage.mockResolvedValue({ text: 'my answer' });
  });

  it('keeps no text from the server or the cache, and waits for nothing', async () => {
    getCachedPlaintext.mockResolvedValue('the deleted words, from the cache');
    const out = await decryptMessageForDisplay(quoting({
      id: 'm-del', content: 'server text in the quote', encrypted: false,
      author: { id: PLACEHOLDER, username: 'deleted', displayName: 'Deleted user', avatarUrl: 'x.webp' },
    }));
    expect(out!.replyTo).toEqual({ id: 'm-del', content: '', encrypted: false, author: deletedParticipantAuthor(CONV) });
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(ledger.noteQuoteAwaiting).not.toHaveBeenCalled();
  });

  it('an encrypted quote under the placeholder is the same (no cache lookup by that id)', async () => {
    const out = await decryptMessageForDisplay(quoting({
      id: 'm-del', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true,
      author: { id: PLACEHOLDER, username: 'deleted', displayName: 'Deleted user', avatarUrl: null },
    }));
    expect(out!.replyTo?.content).toBe('');
    expect(isDeletedQuote(out!.replyTo!)).toBe(true);
    expect(getCachedPlaintext).not.toHaveBeenCalled();
  });

  it('the deleted account\'s call notice keeps its fixed text (it is not a deleted message)', async () => {
    const out = await decryptMessageForDisplay(quoting({
      id: 'm-call', content: 'Voice call started', encrypted: false,
      author: { id: PLACEHOLDER, username: 'deleted', displayName: 'Deleted user', avatarUrl: null },
    }));
    expect(out!.replyTo?.content).toBe('Voice call started');
    expect(isDeletedQuote(out!.replyTo!)).toBe(false);
  });

  it('a quote of a live person is untouched by this rule (a real account named "deleted" included)', async () => {
    const out = await decryptMessageForDisplay(quoting({
      id: 'm-x', content: 'plain words', encrypted: false,
      author: { id: 'u-named-deleted', username: 'deleted', displayName: 'Deleted user', avatarUrl: null },
    }));
    // the ordinary rule: an unencrypted quote that is not a notice is locked, not "Message deleted"
    expect(out!.replyTo?.encrypted).toBe(true);
    expect(isDeletedQuote(out!.replyTo!)).toBe(false);
  });
});

describe('secure channels never accept the deleted type', () => {
  it('a `deleted` row in a ch: scope is refused like any unencrypted row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await decryptChannelMessageForDisplay({
      ...hostileDeletedRow({ encrypted: false, content: '' }),
      channelId: 'ch-secure',
      conversationId: null,
    });
    warn.mockRestore();
    expect(out!.type).toBe('user');
    expect(out!.encrypted).toBe(true);
    expect(out!.content).toBe(DECRYPT_FAILED_CONTENT);
  });
});

function readOnlyConversation(): Conversation {
  return {
    id: CONV,
    user1Id: null,
    user2Id: 'me',
    participant: deletedParticipantAuthor(CONV),
    participantDeleted: true,
    lastMessage: null,
    encryptedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('the send path of a read-only conversation', () => {
  it('prepareOutgoingDM refuses before anything is encrypted to the placeholder', async () => {
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    await expect(prepareOutgoingDM(CONV, 'hello?')).rejects.toBeInstanceOf(DMConversationReadOnlyError);
    expect(encryptMessage).not.toHaveBeenCalled();
  });

  it('the error carries the server\'s sentence (one translation for both)', async () => {
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    await expect(prepareOutgoingDM(CONV, 'hello?')).rejects.toThrow('This conversation is read-only');
  });
});

describe('local search of a read-only conversation', () => {
  it('returns only this account\'s own lines, whatever the cache still holds', async () => {
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    searchDecrypted.mockResolvedValue([
      { messageId: 'm-mine', text: 'pizza tonight?', authorId: 'me', createdAt: '2026-11-01T10:00:00.000Z', editedAt: null },
      { messageId: 'm-theirs', text: 'pizza is great', authorId: 'u-real', createdAt: '2026-11-01T10:01:00.000Z', editedAt: null },
      { messageId: 'm-old', text: 'pizza from an old build', createdAt: '2026-11-01T10:02:00.000Z', editedAt: null },
    ]);
    const hits = await searchEncryptedHistory(CONV, 'pizza');
    expect(hits.map((h) => h.id)).toEqual(['m-mine']);
  });

  it('a live conversation still finds both sides', async () => {
    useDMStore.setState({ conversations: [{ ...readOnlyConversation(), participant: { id: 'u-real', username: 'alice', displayName: 'Alice', avatarUrl: null }, participantDeleted: undefined }] });
    searchDecrypted.mockResolvedValue([
      { messageId: 'm-mine', text: 'pizza tonight?', authorId: 'me', createdAt: '2026-11-01T10:00:00.000Z', editedAt: null },
      { messageId: 'm-theirs', text: 'pizza is great', authorId: 'u-real', createdAt: '2026-11-01T10:01:00.000Z', editedAt: null },
    ]);
    const hits = await searchEncryptedHistory(CONV, 'pizza');
    expect(hits.map((h) => h.id)).toEqual(['m-mine', 'm-theirs']);
  });
});
