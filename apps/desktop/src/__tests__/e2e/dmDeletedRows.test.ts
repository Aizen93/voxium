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
const forgetCachedPlaintext = vi.fn<(id: string, expected: { scope: string; authorId: string }, opts?: { mark?: string }) => Promise<void>>(async () => {});
// the purge marks of an earlier session (E2EService.scopePurged), per scope
const marks = vi.hoisted(() => ({ scopeMarkedPurged: vi.fn<(userId: string | null | undefined, scope: string) => boolean | Promise<boolean>>(() => false) }));

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({ getCachedPlaintext, decryptMessage, encryptMessage, cachePlaintext, searchDecrypted, encryptChannelMessage, forgetCachedPlaintext }),
    scopeMarkedPurged: (userId: string | null | undefined, scope: string) => marks.scopeMarkedPurged(userId, scope),
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
  quotedTextFromCache,
  resolveEncryptedPreview,
  DECRYPT_FAILED_CONTENT,
} from '../../services/e2e/dmCrypto';
import { decryptChannelMessageForDisplay } from '../../services/e2e/channelCrypto';
import { deletedMessageRow, deletedParticipantAuthor, isDeletedQuote } from '../../services/e2e/displayGate';
import { DMConversationReadOnlyError } from '../../utils/dmParticipant';
import { getTranslatedError } from '../../utils/serverErrors';
import { useDMStore } from '../../stores/dmStore';
import { registerE2ESessionUser } from '../../services/e2e/session';

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
  forgetCachedPlaintext.mockReset();
  forgetCachedPlaintext.mockImplementation(async () => {});
  marks.scopeMarkedPurged.mockReset();
  marks.scopeMarkedPurged.mockImplementation(() => false);
  registerE2ESessionUser(() => 'me');
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

  it('the error carries the server\'s sentence, and one translation serves both', async () => {
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    const err = await prepareOutgoingDM(CONV, 'hello?').catch((e: unknown) => e);
    expect((err as Error).message).toBe('This conversation is read-only');
    const t = ((key: string) => key) as unknown as Parameters<typeof getTranslatedError>[1];
    // the client's own refusal and the server's 403 answer read the same
    expect(getTranslatedError(err, t)).toBe('serverErrors.conversationReadOnly');
    const axiosErr = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, data: { success: false, error: 'This conversation is read-only' } },
    });
    expect(getTranslatedError(axiosErr, t)).toBe('serverErrors.conversationReadOnly');
  });
});

describe('local search of a read-only conversation', () => {
  it('returns only this account\'s own lines, whatever the cache still holds', async () => {
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    searchDecrypted.mockResolvedValue([
      { messageId: 'm-mine', text: 'pizza tonight?', authorId: 'me', createdAt: '2026-11-01T10:00:00.000Z', editedAt: null },
      { messageId: 'm-theirs', text: 'pizza is great', authorId: 'u-real', createdAt: '2026-11-01T10:01:00.000Z', editedAt: null },
      { messageId: 'm-noauthor', text: 'pizza, no author recorded', createdAt: '2026-11-01T10:02:00.000Z', editedAt: null },
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

describe('the read-only rule in the gate: the other person\'s rows the server has not rewritten yet', () => {
  const PEER = { id: 'u-real', username: 'alice', displayName: 'Alice', avatarUrl: null };
  const ME = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null };
  /** An ordinary encrypted row, as a page or an event in flight still carries it. */
  const live = (over: Partial<Message> = {}): Message => ({
    id: 'm-old', type: 'user', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true,
    channelId: null, conversationId: CONV, author: PEER, mentions: [], attachments: [],
    reactions: [{ emoji: '👍', count: 1, userIds: ['me'] }],
    createdAt: '2026-11-01T10:00:00.000Z', editedAt: null, ...over,
  });

  beforeEach(() => {
    useDMStore.setState({ conversations: [readOnlyConversation()], readOnlyPending: {} });
    decryptMessage.mockResolvedValue({ text: 'their words' });
    getCachedPlaintext.mockResolvedValue('their cached words');
  });

  /** Nothing decrypted, read from or written to the cache, nothing noted for a retry. */
  function expectUntouched() {
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(cachePlaintext).not.toHaveBeenCalled();
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
    expect(ledger.noteQuoteAwaiting).not.toHaveBeenCalled();
  }

  it('a page: the other person\'s row gets the deleted shape; my own and a call notice are gated as before', async () => {
    decryptMessage.mockResolvedValueOnce({ text: 'my words' });
    const out = await decryptMessagesForDisplay([
      live({ id: 'm-theirs' }),
      live({ id: 'm-mine', author: ME }),
      live({ id: 'm-call', type: 'system', encrypted: false, content: 'Voice call ended', author: PEER }),
    ], { conversationId: CONV });
    expectPlaceholderShape(out[0], 'm-theirs');
    expect(out[1]).toMatchObject({ id: 'm-mine', content: 'my words', encrypted: true });
    expect(out[2]).toMatchObject({ id: 'm-call', type: 'system', content: 'Voice call ended' });
    // only my own row reached the decrypt
    expect(decryptMessage).toHaveBeenCalledTimes(1);
    expect(decryptMessage.mock.calls[0][0]).toMatchObject({ id: 'm-mine', authorId: 'me' });
  });

  it('dm:message:new: the deleted shape, nothing decrypted, cached or noted (so no sound, unread or notification: MainLayout\'s early-out)', async () => {
    const out = await decryptMessageForDisplay(live());
    expectPlaceholderShape(out!, 'm-old');
    expectUntouched();
  });

  it('dm:message:update (an edit): the same', async () => {
    const out = await decryptMessageForDisplay(live({ editedAt: '2026-11-01T11:00:00.000Z' }));
    expectPlaceholderShape(out!, 'm-old');
    expectUntouched();
  });

  it('the retry on key arrival: the same, no claim', async () => {
    const out = await decryptMessageForDisplay(live(), { retry: true });
    expectPlaceholderShape(out!, 'm-old');
    expectUntouched();
  });

  it('an unencrypted user row of the other person: the deleted shape too (no refusal marker)', async () => {
    const out = await decryptMessageForDisplay(live({ encrypted: false, content: 'forged plain words' }));
    expectPlaceholderShape(out!, 'm-old');
  });

  it('a quote of the other person on my own row: "Message deleted", no cache read, nothing waits', async () => {
    decryptMessage.mockResolvedValueOnce({ text: 'my answer' });
    const out = await decryptMessageForDisplay(live({
      id: 'm-mine', author: ME, replyToId: 'm-old',
      replyTo: { id: 'm-old', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true, author: PEER },
    }));
    expect(out!.content).toBe('my answer');
    expect(out!.replyTo).toEqual({ id: 'm-old', content: '', encrypted: false, author: deletedParticipantAuthor(CONV) });
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(ledger.noteQuoteAwaiting).not.toHaveBeenCalled();
  });

  it('a quote of my own message keeps resolving from the cache', async () => {
    decryptMessage.mockResolvedValueOnce({ text: 'my answer' });
    getCachedPlaintext.mockResolvedValueOnce('my earlier words');
    const out = await decryptMessageForDisplay(live({
      id: 'm-mine2', author: ME, replyToId: 'm-mine',
      replyTo: { id: 'm-mine', content: '', encrypted: true, author: ME },
    }));
    expect(out!.replyTo?.content).toBe('my earlier words');
  });

  it('quotedTextFromCache (the fill on key arrival) reads nothing for the other person\'s quote', async () => {
    expect(await quotedTextFromCache(live({ author: ME, replyTo: { id: 'm-x', content: '', encrypted: true, author: PEER } }))).toBeNull();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
  });

  it('the list preview: the other person\'s last message is never read from the cache; my own is', async () => {
    expect(await resolveEncryptedPreview('m-old', CONV, 'u-real')).toBeNull();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    getCachedPlaintext.mockResolvedValueOnce('my last words');
    expect(await resolveEncryptedPreview('m-mine', CONV, 'me')).toBe('my last words');
  });

  it('a conversation an event named before the list loaded it is held read-only too', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: { [CONV]: true } });
    const out = await decryptMessageForDisplay(live());
    expectPlaceholderShape(out!, 'm-old');
    expectUntouched();
  });

  it('a row served under another conversation in this page takes the page\'s conversation (the read-only state and the placeholder)', async () => {
    const out = await decryptMessagesForDisplay([live({ conversationId: 'c-other' })], { conversationId: CONV });
    expectPlaceholderShape(out[0], 'm-old');
  });

  it('a decrypt already running when the conversation turns: the deleted shape, and the entry it wrote is dropped', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    let answer: (r: { text: string }) => void = () => {};
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const shown = decryptMessageForDisplay(live());
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));

    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: 'their words' });

    expectPlaceholderShape((await shown)!, 'm-old');
    // dropped under the read-only mark: a removal that fails clears the conversation's mark
    expect(forgetCachedPlaintext).toHaveBeenCalledWith('m-old', { scope: CONV, authorId: 'u-real' }, { mark: 'read-only' });
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
  });

  it('the other person\'s row FAILING to decrypt across the flip: the deleted shape, no retry note, no real author', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    let answer: (r: { text: string; failed: boolean }) => void = () => {};
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const shown = decryptMessageForDisplay(live({ replyToId: 'm-q', replyTo: { id: 'm-q', content: '', encrypted: true, author: PEER } }));
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));

    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: '', failed: true });

    const out = (await shown)!;
    expectPlaceholderShape(out, 'm-old');
    expect(JSON.stringify(out)).not.toMatch(/alice|Alice|u-real/);
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
    // the quote of the refused row is judged by the fresh flag: no cache read, nothing waits
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(ledger.noteQuoteAwaiting).not.toHaveBeenCalled();
  });

  it('a row failing to decrypt in a live conversation is still noted for a retry (the note waits for the last step)', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    decryptMessage.mockResolvedValueOnce({ text: '', failed: true });
    const out = await decryptMessageForDisplay(live());
    expect(out).toMatchObject({ id: 'm-old', content: DECRYPT_FAILED_CONTENT });
    expect(ledger.noteUndecrypted).toHaveBeenCalledTimes(1);
  });

  it('my own row decrypting across the flip with a quote of the other person: my text, the quote "Message deleted", no cache read for it', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    let answer: (r: { text: string }) => void = () => {};
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const shown = decryptMessageForDisplay(live({
      id: 'm-mine', author: ME, replyToId: 'm-old',
      replyTo: { id: 'm-old', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true, author: PEER },
    }));
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: 'my answer' });

    const out = (await shown)!;
    expect(out.content).toBe('my answer');
    expect(out.replyTo).toEqual({ id: 'm-old', content: '', encrypted: false, author: deletedParticipantAuthor(CONV) });
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(forgetCachedPlaintext).not.toHaveBeenCalled();
  });

  it('a flip during the quote\'s cache read: my row keeps its text, the quote comes back "Message deleted"', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    decryptMessage.mockResolvedValueOnce({ text: 'my answer' });
    let cached: (text: string | null) => void = () => {};
    getCachedPlaintext.mockImplementationOnce(() => new Promise((r) => { cached = r; }));
    const shown = decryptMessageForDisplay(live({
      id: 'm-mine', author: ME, replyToId: 'm-old',
      replyTo: { id: 'm-old', content: '', encrypted: true, author: PEER },
    }));
    await vi.waitFor(() => expect(getCachedPlaintext).toHaveBeenCalledTimes(1));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    cached('their cached words');

    const out = (await shown)!;
    expect(out.content).toBe('my answer');
    expect(out.replyTo).toEqual({ id: 'm-old', content: '', encrypted: false, author: deletedParticipantAuthor(CONV) });
    expect(JSON.stringify(out)).not.toContain('their cached words');
  });

  it('a flip during the quote\'s cache read of the other person\'s row: the deleted shape, its entry dropped', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    decryptMessage.mockResolvedValueOnce({ text: 'their words' });
    let cached: (text: string | null) => void = () => {};
    getCachedPlaintext.mockImplementationOnce(() => new Promise((r) => { cached = r; }));
    const shown = decryptMessageForDisplay(live({ replyToId: 'm-q', replyTo: { id: 'm-q', content: '', encrypted: true, author: ME } }));
    await vi.waitFor(() => expect(getCachedPlaintext).toHaveBeenCalledTimes(1));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    cached('my quoted words');

    expectPlaceholderShape((await shown)!, 'm-old');
    expect(forgetCachedPlaintext).toHaveBeenCalledWith('m-old', { scope: CONV, authorId: 'u-real' }, { mark: 'read-only' });
  });

  it('a row naming another conversation in a page of this one: the deleted shape across the flip, but no entry of that other conversation is dropped', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    let answer: (r: { text: string }) => void = () => {};
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const shown = decryptMessagesForDisplay([live({ conversationId: 'c-other' })], { conversationId: CONV });
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: 'their words' });

    expectPlaceholderShape((await shown)[0], 'm-old');
    expect(forgetCachedPlaintext).not.toHaveBeenCalled();
  });

  it('a removal that fails is logged and the row still takes the deleted shape; a session that ended settles it as nothing', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let answer: (r: { text: string }) => void = () => {};
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    forgetCachedPlaintext.mockRejectedValueOnce(new Error('write refused'));
    const shown = decryptMessageForDisplay(live());
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: 'their words' });
    expectPlaceholderShape((await shown)!, 'm-old');
    expect(warn).toHaveBeenCalledWith('e2e: the cache entry of message m-old could not be dropped:', 'write refused');

    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const ended = new Error('E2E service disposed');
    ended.name = 'E2EServiceDisposedError';
    forgetCachedPlaintext.mockRejectedValueOnce(ended);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const second = decryptMessageForDisplay(live({ id: 'm-two' }));
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: 'their words' });
    expect(await second).toBeNull();
    warn.mockRestore();
    debug.mockRestore();
  });

  it('my own row decrypting across the flip is shown as before, and its entry kept', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    let answer: (r: { text: string }) => void = () => {};
    decryptMessage.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const shown = decryptMessageForDisplay(live({ author: ME }));
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));
    useDMStore.setState({ conversations: [readOnlyConversation()] });
    answer({ text: 'my words' });
    expect((await shown)!.content).toBe('my words');
    expect(forgetCachedPlaintext).not.toHaveBeenCalled();
  });

  it('a live conversation is gated exactly as before', async () => {
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    const out = await decryptMessageForDisplay(live());
    expect(out).toMatchObject({ id: 'm-old', content: 'their words', encrypted: true, type: 'user' });
    expect(decryptMessage).toHaveBeenCalledTimes(1);
    expect(forgetCachedPlaintext).not.toHaveBeenCalled();
  });
});

describe('a conversation an earlier session marked as purged: read-only from the start, before any list', () => {
  const PEER = { id: 'u-real', username: 'alice', displayName: 'Alice', avatarUrl: null };
  const ME = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null };
  const live = (over: Partial<Message> = {}): Message => ({
    id: 'm-push', type: 'user', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true,
    channelId: null, conversationId: CONV, author: PEER, mentions: [], attachments: [], reactions: [],
    createdAt: '2026-11-01T10:00:00.000Z', editedAt: null, ...over,
  });

  beforeEach(() => {
    // no list yet: the store holds nothing about the conversation
    useDMStore.setState({ conversations: [], readOnlyPending: {} });
    decryptMessage.mockResolvedValue({ text: 'their words' });
  });

  it('a pushed row of the other person gets the deleted shape: nothing decrypted, read, cached or noted', async () => {
    marks.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === CONV);
    const out = await decryptMessageForDisplay(live());
    expectPlaceholderShape(out!, 'm-push');
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
    // asked for the signed-in account
    expect(marks.scopeMarkedPurged).toHaveBeenCalledWith('me', CONV);
  });

  it('while the marks are still being read (a promise), the same', async () => {
    marks.scopeMarkedPurged.mockImplementation(async (_userId, scope) => scope === CONV);
    expectPlaceholderShape((await decryptMessageForDisplay(live()))!, 'm-push');
    expect(decryptMessage).not.toHaveBeenCalled();
  });

  it('my own row decrypts as before', async () => {
    marks.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === CONV);
    decryptMessage.mockResolvedValueOnce({ text: 'my words' });
    expect(await decryptMessageForDisplay(live({ author: ME }))).toMatchObject({ content: 'my words', encrypted: true });
  });

  it('the list preview of the other person\'s last message is never read from the cache', async () => {
    marks.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === CONV);
    expect(await resolveEncryptedPreview('m-push', CONV, 'u-real')).toBeNull();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
  });

  it('a conversation a list of this session loaded live: the list decides, whatever the mark says', async () => {
    marks.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === CONV);
    useDMStore.setState({
      conversations: [{
        id: CONV, user1Id: 'me', user2Id: 'u-real', participant: { ...PEER }, lastMessage: null,
        encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      } as Conversation],
    });
    const out = await decryptMessageForDisplay(live());
    expect(out).toMatchObject({ id: 'm-push', type: 'user', content: 'their words', encrypted: true });
    expect(decryptMessage).toHaveBeenCalledTimes(1);
    // the mark is not even asked for a loaded conversation
    expect(marks.scopeMarkedPurged).not.toHaveBeenCalled();
    getCachedPlaintext.mockResolvedValueOnce('their last words');
    expect(await resolveEncryptedPreview('m-push', CONV, 'u-real')).toBe('their last words');
  });

  it('a page shown in a loaded conversation, for a row naming one no list loaded: the mark of that one still holds', async () => {
    marks.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === 'c-unloaded');
    useDMStore.setState({
      conversations: [{
        id: CONV, user1Id: 'me', user2Id: 'u-real', participant: { ...PEER }, lastMessage: null,
        encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      } as Conversation],
    });
    const out = await decryptMessagesForDisplay([live({ conversationId: 'c-unloaded' })], { conversationId: CONV });
    expectPlaceholderShape(out[0], 'm-push');
    expect(marks.scopeMarkedPurged).toHaveBeenCalledWith('me', 'c-unloaded');
    expect(marks.scopeMarkedPurged).not.toHaveBeenCalledWith('me', CONV);
  });

  it('an unmarked conversation is gated as before', async () => {
    const out = await decryptMessageForDisplay(live());
    expect(out).toMatchObject({ content: 'their words' });
    expect(decryptMessage).toHaveBeenCalledTimes(1);
  });
});
