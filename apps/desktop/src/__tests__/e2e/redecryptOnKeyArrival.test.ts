import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildE2EPlaintext, buildMegolmEnvelope, buildE2EEnvelope, parseE2EEnvelope } from '@voxium/shared';
import type { Conversation, Message, ReactionGroup } from '@voxium/shared';

/**
 * A row the gate could not open (its group session had not reached this
 * device) is tried again when that session arrives, for the conversation or
 * secure channel on screen, through the same gate, and replaces its marker in
 * place. The service is a stand-in here: every decrypt answer is chosen by the
 * test, and a successful one writes the stand-in's plaintext cache. The real
 * service and the key server are exercised in e2eService.test.ts.
 */

const { decryptMessage, getCachedPlaintext, api } = vi.hoisted(() => ({
  decryptMessage: vi.fn(),
  getCachedPlaintext: vi.fn(),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return { ...actual, getE2EService: () => ({ decryptMessage, getCachedPlaintext }) };
});
vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me' } }) },
}));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { watchKeyArrivals, redecryptPassesSettled } from '../../services/e2e/redecryptOnKeyArrival';
import { resetUndecryptedRows, hasDueRows } from '../../services/e2e/undecryptedRows';
import { decryptMessagesForDisplay, decryptMessageForDisplay, DECRYPT_FAILED_CONTENT } from '../../services/e2e/dmCrypto';
import { decryptChannelMessagesForDisplay } from '../../services/e2e/channelCrypto';
import { E2EServiceDisposedError, type E2ESessionsAvailable } from '../../services/e2e/e2eService';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { useChatStore } from '../../stores/chatStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';

const SID_A = 'c2Vzc2lvbkE';
const SID_B = 'c2Vzc2lvbkI';
const SID_C = 'c2Vzc2lvbkM';
const peer = { id: 'peer', username: 'peer', displayName: 'Peer' };

function dmRow(id: string, sid: string, over: Partial<Message> = {}): Message {
  return {
    id,
    type: 'user',
    content: buildMegolmEnvelope(sid, 'Y2lwaGVy'),
    channelId: null,
    conversationId: 'c1',
    encrypted: true,
    author: peer,
    createdAt: '2026-11-01T10:00:00.000Z',
    editedAt: null,
    reactions: [],
    attachments: [],
    ...over,
  } as unknown as Message;
}

function channelRow(id: string, sid: string, over: Partial<Message> = {}): Message {
  return dmRow(id, sid, { channelId: 'ch1', conversationId: null, ...over } as Partial<Message>);
}

/** The sessions on the stand-in device: a decrypt under one of them opens. */
const sessionsHere = new Set<string>();
/** The stand-in's plaintext cache: what a decrypt that opened wrote, by id. */
const cache = new Map<string, { scope: string; authorId: string; text: string }>();
const sidOf = (content: string): string | null => {
  const envelope = parseE2EEnvelope(content);
  return envelope && envelope.e === 'megolm1' ? envelope.sid : null;
};
const decryptsFromSessionsHere = async (message: { id: string; content: string; conversationId: string; authorId: string }) => {
  const sid = sidOf(message.content);
  if (!sid || !sessionsHere.has(sid)) return { text: '', failed: true };
  const text = buildE2EPlaintext(`text of ${message.id}`);
  cache.set(message.id, { scope: message.conversationId, authorId: message.authorId, text });
  return { text };
};
const readsTheCache = async (messageId: string, expected: { scope: string; authorId?: string }) => {
  const entry = cache.get(messageId);
  if (!entry || entry.scope !== expected.scope) return null;
  if (expected.authorId !== undefined && entry.authorId !== expected.authorId) return null;
  return entry.text;
};

/** A stand-in for the service's event, and what the watch subscribed with. */
let listener: ((event: E2ESessionsAvailable) => void) | null = null;
const fakeService = {
  onSessionsAvailable(l: (event: E2ESessionsAvailable) => void) {
    listener = l;
    return () => {
      if (listener === l) listener = null;
    };
  },
};
/** The service stored these sessions: they are on the device from now on, and it says so. */
function arrive(scope: string, sessionIds: string[]): void {
  for (const id of sessionIds) sessionsHere.add(id);
  listener?.({ scope, sessionIds });
}

const rowById = (id: string) => useChatStore.getState().messages.find((m) => m.id === id);
const viewDM = (conversationId: string) => {
  useServerStore.setState({ activeServerId: null, activeChannelId: null });
  useDMStore.setState({ activeConversationId: conversationId });
};
const viewChannel = (channelId: string) => {
  useDMStore.setState({ activeConversationId: null });
  useServerStore.setState({ activeServerId: 's1', activeChannelId: channelId });
};
/** A deferred decrypt answer, for holding a pass at its first await. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Until every pending promise reaction has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const unrelated = () => dmRow(`u${Math.random().toString(36).slice(2)}`, SID_C, { encrypted: false, content: 'unrelated' });

let stopWatch: () => void;

beforeEach(() => {
  decryptMessage.mockReset();
  decryptMessage.mockImplementation(decryptsFromSessionsHere);
  getCachedPlaintext.mockReset();
  getCachedPlaintext.mockImplementation(readsTheCache);
  for (const fn of Object.values(api)) fn.mockReset();
  sessionsHere.clear();
  cache.clear();
  resetUndecryptedRows();
  useChatStore.setState({ messages: [] });
  useDMStore.setState({ conversations: [] });
  viewDM('c1');
  stopWatch = watchKeyArrivals('me', fakeService);
});

afterEach(async () => {
  stopWatch();
  await redecryptPassesSettled();
  registerE2ESessionUser(null);
  // local only: nothing here asks the server anything
  for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
});

describe('a row that could not be decrypted is tried again when its key arrives', () => {
  it('DM: the row opens in place, keeping the reactions the store has since; the other stays closed', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A), dmRow('m2', SID_B)]) });
    expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);
    const reactions: ReactionGroup[] = [{ emoji: '👍', count: 1, userIds: ['peer'] }];
    useChatStore.getState().updateMessageReactions('m1', reactions);
    const closed = rowById('m2');
    expect(decryptMessage).toHaveBeenCalledTimes(2);

    arrive('c1', [SID_A]);
    await redecryptPassesSettled();

    expect(rowById('m1')).toMatchObject({ content: 'text of m1', encrypted: true, reactions });
    expect(rowById('m2')).toBe(closed);
    // only the row under the session that arrived was tried, through the same
    // decrypt, which starts no claim for a session it does not find
    expect(decryptMessage).toHaveBeenCalledTimes(3);
    expect(decryptMessage.mock.calls[0][1]).toEqual({ claimMissing: true, storageFailureRejects: false });
    expect(decryptMessage.mock.calls[2][0]).toMatchObject({
      id: 'm1', conversationId: 'c1', authorId: 'peer', content: buildMegolmEnvelope(SID_A, 'Y2lwaGVy'),
    });
    expect(decryptMessage.mock.calls[2][1]).toEqual({ claimMissing: false, storageFailureRejects: true });
  });

  it('secure channel: the row opens in place under its ch: scope', async () => {
    viewChannel('ch1');
    useChatStore.setState({ messages: await decryptChannelMessagesForDisplay([channelRow('m1', SID_A)]) });
    expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);

    arrive('ch:ch1', [SID_A]);
    await redecryptPassesSettled();

    expect(rowById('m1')?.content).toBe('text of m1');
    expect(decryptMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'm1', conversationId: 'ch:ch1' }),
      { claimMissing: false, storageFailureRejects: true },
    );
  });

  it('a row that still fails stays as it is, tried once for the session that arrived', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    const closed = rowById('m1');
    // the session arrives, yet the row does not open with it (say its author does not match)
    decryptMessage.mockResolvedValue({ text: '', failed: true });

    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(rowById('m1')).toBe(closed);
    expect(decryptMessage).toHaveBeenCalledTimes(2);

    // another session of the conversation does not try it again
    arrive('c1', [SID_B]);
    useChatStore.getState().addMessage(unrelated());
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(2);
    expect(rowById('m1')).toBe(closed);
  });

  it('a decrypted row is never touched, and a row with no held ciphertext is not tried', async () => {
    sessionsHere.add(SID_A);
    // the server says it is not encrypted: refused, and nothing a key could open
    const page = await decryptMessagesForDisplay([
      dmRow('m1', SID_A),
      dmRow('m2', SID_B, { encrypted: false, content: 'forged plaintext' }),
    ]);
    useChatStore.setState({ messages: page });
    const before = useChatStore.getState().messages;
    expect(rowById('m2')?.content).toBe(DECRYPT_FAILED_CONTENT);

    arrive('c1', [SID_A, SID_B]);
    await redecryptPassesSettled();
    expect(useChatStore.getState().messages).toBe(before);
    expect(decryptMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a scope that is not on screen, and holds nothing of it', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    // a row of another conversation, gated (the socket path), that this view
    // holds as well: chatStore is shared, and only the scope on screen counts
    const other = await decryptMessageForDisplay(dmRow('x1', SID_C, { conversationId: 'c2' }));
    expect(other?.content).toBe(DECRYPT_FAILED_CONTENT);
    useChatStore.getState().addMessage(other!);
    expect(decryptMessage).toHaveBeenCalledTimes(2);

    arrive('c2', [SID_C]);
    await redecryptPassesSettled();
    // its session announced under the conversation on screen opens nothing of another one
    listener?.({ scope: 'c1', sessionIds: [SID_C] });
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(2);
    expect(rowById('x1')).toBe(other);

    // opening that conversation fetches and gates its rows afresh: nothing was held for it
    viewDM('c2');
    useChatStore.setState({ messages: [other!] });
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(2);
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('x1', SID_C, { conversationId: 'c2' })]) });
    expect(rowById('x1')?.content).toBe('text of x1');
  });

  it('opens a row that reaches the view after its session arrived', async () => {
    // the row failed while the page was still decrypting, and the session was
    // stored before the page reached the store
    const page = await decryptMessagesForDisplay([dmRow('m1', SID_A)]);
    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(1);

    useChatStore.setState({ messages: page });
    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('opens a row whose session was stored while its own first decrypt was running', async () => {
    const first = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => first.promise);
    const gating = decryptMessagesForDisplay([dmRow('m1', SID_A)]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(1));
    // the decrypt read no session; meanwhile the service stores it
    arrive('c1', [SID_A]);
    first.resolve({ text: '', failed: true });
    const page = await gating;
    expect(page[0].content).toBe(DECRYPT_FAILED_CONTENT);

    useChatStore.setState({ messages: page });
    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('coalesces: one pass at a time per scope, and exactly the work that arrived meanwhile after it', async () => {
    useChatStore.setState({
      messages: await decryptMessagesForDisplay([dmRow('m1', SID_A), dmRow('m2', SID_B), dmRow('m3', SID_C)]),
    });
    expect(decryptMessage).toHaveBeenCalledTimes(3);
    const held = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => held.promise);

    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(4));
    // signals while the pass waits on its decrypt start nothing beside it
    arrive('c1', [SID_B]);
    arrive('c1', [SID_C]);
    listener?.({ scope: 'c1', sessionIds: [SID_B] });
    await flush();
    expect(decryptMessage).toHaveBeenCalledTimes(4);

    held.resolve({ text: buildE2EPlaintext('text of m1') });
    await redecryptPassesSettled();
    // the one more pass took both rows that became due meanwhile, each once
    expect(decryptMessage).toHaveBeenCalledTimes(6);
    expect(decryptMessage.mock.calls.slice(4).map(([m]) => m.id).sort()).toEqual(['m2', 'm3']);
    expect(['m1', 'm2', 'm3'].map((id) => rowById(id)?.content)).toEqual(['text of m1', 'text of m2', 'text of m3']);
  });

  it('applies nothing when the watch stops (logout) during the pass', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    const closed = rowById('m1');
    const held = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => held.promise);

    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));
    stopWatch();
    held.resolve({ text: buildE2EPlaintext('text of m1') });
    await redecryptPassesSettled();

    expect(rowById('m1')).toBe(closed);
  });

  it('applies nothing when another account is signed in by the time the decrypt answers', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    const closed = rowById('m1');
    const held = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => held.promise);

    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));
    registerE2ESessionUser(() => 'someone-else');
    held.resolve({ text: buildE2EPlaintext('text of m1') });
    await redecryptPassesSettled();

    expect(rowById('m1')).toBe(closed);
  });

  it('ends the pass when the E2E session ends under a decrypt, trying no other row', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A), dmRow('m2', SID_A)]) });
    const closed = useChatStore.getState().messages;
    decryptMessage.mockRejectedValueOnce(new E2EServiceDisposedError());
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      arrive('c1', [SID_A]);
      await redecryptPassesSettled();
    } finally {
      debug.mockRestore();
    }
    expect(decryptMessage).toHaveBeenCalledTimes(3);
    expect(useChatStore.getState().messages).toBe(closed);
  });

  it('applies nothing once the view moved to another conversation', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    const held = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => held.promise);

    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));
    useDMStore.setState({ activeConversationId: 'c2' });
    held.resolve({ text: buildE2EPlaintext('text of m1') });
    await redecryptPassesSettled();

    expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);
  });

  it('an edit or a delete that lands during the pass stands', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A), dmRow('m2', SID_A)]) });
    const first = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => first.promise);

    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(3));
    // m1 is edited (its new version decrypted by the socket path) and m2 deleted meanwhile
    const edited = { ...dmRow('m1', SID_A, { editedAt: '2026-11-01T11:00:00.000Z' }), content: 'the edited text' };
    useChatStore.getState().updateMessage(edited);
    useChatStore.getState().deleteMessage('m2');
    first.resolve({ text: buildE2EPlaintext('the original text') });
    await redecryptPassesSettled();

    expect(rowById('m1')).toBe(edited);
    expect(rowById('m2')).toBeUndefined();
  });

  it('an edit that could not be decrypted either opens once the view shows it', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    // the edit's own decrypt runs while the session is stored, and fails too
    const editedAt = '2026-11-01T11:00:00.000Z';
    const editDecrypt = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => editDecrypt.promise);
    const gatingEdit = decryptMessageForDisplay(dmRow('m1', SID_A, { editedAt }));
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));
    arrive('c1', [SID_A]);
    editDecrypt.resolve({ text: '', failed: true });
    const editShown = await gatingEdit;
    expect(editShown?.content).toBe(DECRYPT_FAILED_CONTENT);
    // the view still shows the version before the edit, and that one opens
    await redecryptPassesSettled();
    expect(rowById('m1')).toMatchObject({ content: 'text of m1', editedAt: null });

    // the edit reaches the view: it is tried, and opens
    useChatStore.getState().updateMessage(editShown!);
    await redecryptPassesSettled();
    expect(rowById('m1')).toMatchObject({ content: 'text of m1', editedAt });
  });

  it('a view cleared and filled again with rows the gate did not answer for holds nothing', async () => {
    const page = await decryptMessagesForDisplay([dmRow('m1', SID_A)]);
    useChatStore.setState({ messages: page });
    useChatStore.getState().clearMessages();
    // the refused row put back without passing the gate again
    useChatStore.setState({ messages: page });

    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(1);
    expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);
  });

  it('does not hold a legacy pairwise row: no group session can open it later', async () => {
    useChatStore.setState({
      messages: await decryptMessagesForDisplay([dmRow('m1', SID_A, { content: buildE2EEnvelope(1, 'Y2lwaGVy') })]),
    });
    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(1);
  });
});

describe('what is held follows the view', () => {
  it('opens a row when a second delivery of it claims its session and the store keeps the first copy', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    // the socket brings m1 again: its decrypt claims the session, stores it, and opens
    decryptMessage.mockImplementationOnce(async (message: Parameters<typeof decryptsFromSessionsHere>[0]) => {
      arrive('c1', [SID_A]);
      return decryptsFromSessionsHere(message);
    });
    const again = await decryptMessageForDisplay(dmRow('m1', SID_A));
    expect(again?.content).toBe('text of m1');
    // the store keeps the row it has (the id is there already)
    useChatStore.getState().addMessage(again!);
    expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);

    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('opens a row when an overlapping older page brings it again and the store keeps the first copy', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]), hasMore: true });
    decryptMessage.mockImplementationOnce(async (message: Parameters<typeof decryptsFromSessionsHere>[0]) => {
      arrive('c1', [SID_A]);
      return decryptsFromSessionsHere(message);
    });
    api.get.mockResolvedValueOnce({ data: { data: [dmRow('m1', SID_A)], hasMore: false } });
    await useChatStore.getState().fetchDMMessages('c1', 'm2');
    expect(api.get).toHaveBeenCalledTimes(1);
    // the page's copy of m1 was dropped as one the view holds
    expect(useChatStore.getState().messages).toHaveLength(1);
    api.get.mockReset();

    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('opens a secure-channel row when an overlapping older page brings it again', async () => {
    viewChannel('ch1');
    useServerStore.setState({ channels: [{ id: 'ch1', serverId: 's1', name: 'secret', type: 'text', secure: true } as never] });
    useChatStore.setState({ messages: await decryptChannelMessagesForDisplay([channelRow('m1', SID_A)]), hasMore: true });
    decryptMessage.mockImplementationOnce(async (message: Parameters<typeof decryptsFromSessionsHere>[0]) => {
      arrive('ch:ch1', [SID_A]);
      return decryptsFromSessionsHere(message);
    });
    api.get.mockResolvedValueOnce({ data: { data: [channelRow('m1', SID_A)], hasMore: false } });
    await useChatStore.getState().fetchMessages('ch1', 'm2');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages).toHaveLength(1);
    api.get.mockReset();

    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
    useServerStore.setState({ channels: [] });
  });

  it('keeps an edit held when a try of the version before it finishes after it', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    const retryOfV1 = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => retryOfV1.promise);
    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));

    // the edit, under another session, fails and reaches the view
    const editedAt = '2026-11-01T11:00:00.000Z';
    const v2 = await decryptMessageForDisplay(dmRow('m1', SID_B, { editedAt }));
    expect(v2?.content).toBe(DECRYPT_FAILED_CONTENT);
    useChatStore.getState().updateMessage(v2!);
    // the try of v1 then fails
    retryOfV1.resolve({ text: '', failed: true });
    await redecryptPassesSettled();

    // v2's session arrives: v2 is still the row held, and opens
    arrive('c1', [SID_B]);
    await redecryptPassesSettled();
    expect(rowById('m1')).toMatchObject({ content: 'text of m1', editedAt });
  });

  it('lets go of a deleted row: its session arriving makes nothing due', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A), dmRow('m2', SID_B)]) });
    useChatStore.getState().deleteMessage('m1');
    arrive('c1', [SID_A]);
    expect(hasDueRows('c1')).toBe(false);
    useChatStore.getState().addMessage(unrelated());
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the rows on screen held however busy another scope is', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    // failures elsewhere (the socket path of conversations not on screen)
    for (let i = 0; i < 600; i++) {
      await decryptMessageForDisplay(dmRow(`x${i}`, SID_C, { conversationId: `other-${i % 7}` }));
    }
    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('holds every row the view shows, however many pages it holds', async () => {
    // scrolled up page after page: each page reaches the view once it is gated
    for (let page = 0; page < 12; page++) {
      const rows = Array.from({ length: 50 }, (_, i) => dmRow(`m${page}-${i}`, SID_A));
      const shown = await decryptMessagesForDisplay(rows);
      useChatStore.setState((state) => ({ messages: [...shown, ...state.messages] }));
    }
    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(useChatStore.getState().messages.filter((m) => m.content === DECRYPT_FAILED_CONTENT)).toHaveLength(0);
  });

  it('keeps a held row when the server uses its id again in another scope', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    await decryptMessageForDisplay(dmRow('m1', SID_C, { conversationId: 'c2' }));
    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('opens a conversation row that also names a channel', async () => {
    useChatStore.setState({
      messages: await decryptMessagesForDisplay([dmRow('m1', SID_A, { channelId: 'stray' } as Partial<Message>)]),
    });
    arrive('c1', [SID_A]);
    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
  });
});

describe('a try of a held row', () => {
  it('that ends in an error stays held, and is tried again at the next change of the view, not in a loop', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    decryptMessage.mockRejectedValueOnce(new Error('vault read failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      arrive('c1', [SID_A]);
      await redecryptPassesSettled();
      await flush();
      expect(decryptMessage).toHaveBeenCalledTimes(2);
      expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);
    } finally {
      warn.mockRestore();
    }

    useChatStore.getState().addMessage(unrelated());
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(3);
    expect(rowById('m1')?.content).toBe('text of m1');
  });

  it('still running when the watch starts again for the same account is applied', async () => {
    useChatStore.setState({ messages: await decryptMessagesForDisplay([dmRow('m1', SID_A)]) });
    const held = deferred<{ text: string; failed?: boolean }>();
    decryptMessage.mockImplementationOnce(() => held.promise);
    arrive('c1', [SID_A]);
    await vi.waitFor(() => expect(decryptMessage).toHaveBeenCalledTimes(2));

    // e2eStore starts the account's E2E again (a retry after a failed start)
    const again = watchKeyArrivals('me', fakeService);
    held.resolve({ text: buildE2EPlaintext('text of m1') });
    await redecryptPassesSettled();
    expect(rowById('m1')?.content).toBe('text of m1');
    // the same watch, kept
    expect(again).toBe(stopWatch);
  });
});

describe('once a row opens', () => {
  it('the quotes of it that found nothing in the cache, and the preview of it, show its text', async () => {
    useDMStore.setState({
      conversations: [{
        id: 'c1', user1Id: 'me', user2Id: 'peer', participant: peer,
        lastMessage: { id: 'm1', content: '', encrypted: true, type: 'user', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'peer' },
        encryptedAt: '2026-11-01T09:00:00.000Z', createdAt: '2026-11-01T09:00:00.000Z',
      } as Conversation],
    });
    sessionsHere.add(SID_B);
    const quoteOf = (encrypted: boolean) => ({ id: 'm1', author: peer, encrypted, content: encrypted ? '' : 'the server says so' });
    useChatStore.setState({
      messages: await decryptMessagesForDisplay([
        dmRow('m1', SID_A),
        dmRow('m2', SID_B, { replyTo: quoteOf(true) } as Partial<Message>),
        // a quote the server calls unencrypted is locked by the gate, and stays so
        dmRow('m3', SID_B, { replyTo: quoteOf(false) } as Partial<Message>),
      ]),
    });
    expect(rowById('m2')?.replyTo?.content).toBe('');
    expect(rowById('m3')?.replyTo?.content).toBe('');

    arrive('c1', [SID_A]);
    await redecryptPassesSettled();

    expect(rowById('m1')?.content).toBe('text of m1');
    expect(rowById('m2')?.replyTo?.content).toBe('text of m1');
    expect(rowById('m3')?.replyTo?.content).toBe('');
    expect(useDMStore.getState().conversations[0].lastMessage?.content).toBe('text of m1');
    // looked up as the gate looks a quote up: this conversation, the author the quote names
    expect(getCachedPlaintext).toHaveBeenCalledWith('m1', { scope: 'c1', authorId: 'peer' });
  });

  it('a secure channel quote of it shows its text', async () => {
    viewChannel('ch1');
    sessionsHere.add(SID_B);
    useChatStore.setState({
      messages: await decryptChannelMessagesForDisplay([
        channelRow('m1', SID_A),
        channelRow('m2', SID_B, { replyTo: { id: 'm1', author: peer, encrypted: true, content: '' } } as Partial<Message>),
      ]),
    });
    expect(rowById('m2')?.replyTo?.content).toBe('');

    arrive('ch:ch1', [SID_A]);
    await redecryptPassesSettled();
    expect(rowById('m2')?.replyTo?.content).toBe('text of m1');
  });
});
