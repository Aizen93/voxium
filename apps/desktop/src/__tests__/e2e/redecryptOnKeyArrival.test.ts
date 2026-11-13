import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildE2EPlaintext, buildMegolmEnvelope, buildE2EEnvelope, parseE2EEnvelope } from '@voxium/shared';
import type { Message, ReactionGroup } from '@voxium/shared';

/**
 * A row the gate could not open (its group session had not reached this
 * device) is tried again when that session arrives, for the conversation or
 * secure channel on screen, through the same gate, and replaces its marker in
 * place. The service is a stand-in here: every decrypt answer is chosen by the
 * test. The real service and the key server are exercised in e2eService.test.ts.
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
import { resetUndecryptedRows } from '../../services/e2e/undecryptedRows';
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

function channelRow(id: string, sid: string): Message {
  return dmRow(id, sid, { channelId: 'ch1', conversationId: null } as Partial<Message>);
}

/** The sessions on the stand-in device: a decrypt under one of them opens. */
const sessionsHere = new Set<string>();
const sidOf = (content: string): string | null => {
  const envelope = parseE2EEnvelope(content);
  return envelope && envelope.e === 'megolm1' ? envelope.sid : null;
};
const decryptsFromSessionsHere = async (message: { id: string; content: string }) => {
  const sid = sidOf(message.content);
  return sid && sessionsHere.has(sid) ? { text: buildE2EPlaintext(`text of ${message.id}`) } : { text: '', failed: true };
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

let stopWatch: () => void;

beforeEach(() => {
  decryptMessage.mockReset();
  decryptMessage.mockImplementation(decryptsFromSessionsHere);
  getCachedPlaintext.mockReset();
  getCachedPlaintext.mockResolvedValue(null);
  for (const fn of Object.values(api)) fn.mockReset();
  sessionsHere.clear();
  resetUndecryptedRows();
  useChatStore.setState({ messages: [] });
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
    // only the row under the session that arrived was tried, through the same decrypt
    expect(decryptMessage).toHaveBeenCalledTimes(3);
    expect(decryptMessage.mock.calls[2][0]).toMatchObject({
      id: 'm1', conversationId: 'c1', authorId: 'peer', content: buildMegolmEnvelope(SID_A, 'Y2lwaGVy'),
    });
  });

  it('secure channel: the row opens in place under its ch: scope', async () => {
    viewChannel('ch1');
    useChatStore.setState({ messages: await decryptChannelMessagesForDisplay([channelRow('m1', SID_A)]) });
    expect(rowById('m1')?.content).toBe(DECRYPT_FAILED_CONTENT);

    arrive('ch:ch1', [SID_A]);
    await redecryptPassesSettled();

    expect(rowById('m1')?.content).toBe('text of m1');
    expect(decryptMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm1', conversationId: 'ch:ch1' }));
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
    useChatStore.getState().addMessage(dmRow('m9', SID_C, { encrypted: false, content: 'unrelated' }));
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

  it('leaves alone a scope that is not on screen', async () => {
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

    // on screen, the same row is opened
    viewDM('c2');
    useChatStore.setState({ messages: [other!] });
    await redecryptPassesSettled();
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

  it('an edit that could not be decrypted either is tried once the view shows it', async () => {
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

    // a pass while the view still shows the version before the edit leaves it be
    useChatStore.getState().addMessage(dmRow('m9', SID_C, { encrypted: false, content: 'unrelated' }));
    await redecryptPassesSettled();
    expect(decryptMessage).toHaveBeenCalledTimes(2);

    // the edit reaches the view: it is tried, and opens
    useChatStore.getState().updateMessage(editShown!);
    await redecryptPassesSettled();
    expect(rowById('m1')).toMatchObject({ content: 'text of m1', editedAt });
  });

  it('clearing the view drops the rows it held', async () => {
    const page = await decryptMessagesForDisplay([dmRow('m1', SID_A)]);
    useChatStore.setState({ messages: page });
    useChatStore.getState().clearMessages();
    // a refused row put back without passing the gate holds no ciphertext here
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
