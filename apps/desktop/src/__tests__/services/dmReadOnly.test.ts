import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DM_NOTICE_CALL_STARTED, type Conversation } from '@voxium/shared';

/**
 * `dm:conversation:read_only { conversationId }` as MainLayout registers it,
 * and the list reconciliation it shares with dmStore: the conversation flips
 * to the read-only state, the view on screen is loaded again, a call of THAT
 * conversation ends locally, profile cards of the person close, the cached
 * text the other person wrote is purged once this session, and the list is
 * fetched again. Payloads are untyped at runtime.
 */

const h = vi.hoisted(() => {
  const voice = {
    dmCallConversationId: null as string | null,
    incomingCall: null as { conversationId: string; from: unknown } | null,
    handleDMCallEnded: vi.fn(),
    setIncomingCall: vi.fn(),
  };
  const e2e = { ready: true, error: null as string | null, listeners: [] as Array<(s: { ready: boolean; error: string | null }) => void> };
  return {
    apiGet: vi.fn(),
    chat: { clearMessages: vi.fn(), fetchDMMessages: vi.fn(async () => {}) },
    server: { activeServerId: null as string | null },
    voice,
    auth: { user: { id: 'me' } as { id: string } | null },
    e2e,
    purgeCachedPlaintexts: vi.fn<(scopes: string[], remove: (e: PlaintextPurgeEntry) => boolean, opts?: PurgeOpts) => Promise<PurgeAnswer>>(),
    clearPurgeMarks: vi.fn<(mark: string, scopes: readonly string[]) => Promise<void>>(async () => {}),
    // the purge marks the service holds (an earlier session's, or this one's), per scope
    scopeMarkedPurged: vi.fn<(userId: string | null | undefined, scope: string) => boolean | Promise<boolean>>(() => false),
  };
});

type PurgeOpts = { mark?: string; record?: (scope: string) => boolean };
type PurgeAnswer = { removed: number; marked: string[] };

/** What the service answers when a walk ends: the mark for the scopes `record` names then (E2EService.purgeCachedPlaintexts). */
function walkEnded(scopes: string[], opts: PurgeOpts | undefined, removed = 0): PurgeAnswer {
  return { removed, marked: opts?.mark ? scopes.filter((scope) => opts.record?.(scope) ?? true) : [] };
}

/** A walk that ends when the test says so, its answer read at that moment. */
function heldWalk(): { finish: (removed?: number) => void } {
  const handle = { finish: (_removed?: number) => {} };
  h.purgeCachedPlaintexts.mockImplementationOnce((scopes, _remove, opts) => new Promise<PurgeAnswer>((resolve) => {
    handle.finish = (removed = 0) => resolve(walkEnded(scopes, opts, removed));
  }));
  return handle;
}

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview: vi.fn(async () => null) }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => h.chat } }));
vi.mock('../../stores/serverStore', () => ({ useServerStore: { getState: () => h.server } }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => h.voice } }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => h.auth } }));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: {
    getState: () => ({ ready: h.e2e.ready, error: h.e2e.error }),
    subscribe: (cb: (s: { ready: boolean; error: string | null }) => void) => {
      h.e2e.listeners.push(cb);
      return () => { h.e2e.listeners = h.e2e.listeners.filter((l) => l !== cb); };
    },
  },
}));
vi.mock('../../services/e2e/e2eService', () => ({
  READ_ONLY_PURGE_MARK: 'read-only',
  getE2EService: () => ({ purgeCachedPlaintexts: h.purgeCachedPlaintexts, clearPurgeMarks: h.clearPurgeMarks }),
  scopeMarkedPurged: (userId: string | null | undefined, scope: string) => h.scopeMarkedPurged(userId, scope),
}));

import {
  handleConversationReadOnly,
  applyReadOnlyConversations,
  purgeReadOnlyConversation,
  standsAsDeletedNow,
  clearMarksOfLiveConversations,
} from '../../services/dmReadOnly';
import { useDMStore } from '../../stores/dmStore';
import { onCloseProfilePopups } from '../../utils/profilePopupBus';
import type { PlaintextPurgeEntry } from '../../services/e2e/vault';

const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };
function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id, user1Id: 'me', user2Id: 'u-alice', participant: { ...ALICE }, lastMessage: null,
    encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}
function serverReadOnly(id: string): Conversation {
  return conv(id, { user2Id: null, participant: { id: `deleted:${id}`, username: 'deleted', displayName: 'Deleted user', avatarUrl: null }, participantDeleted: true });
}

/**
 * Lets the work these handlers start settle: the dynamic imports (the
 * list fetch loads services/dmReadOnly) and the promise chains after them.
 * No timer: nothing here waits on time.
 */
async function settle() {
  for (let round = 0; round < 5; round++) {
    await vi.dynamicImportSettled();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

let warn: ReturnType<typeof vi.spyOn>;
let closed: string[];
let stopListening: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  h.server.activeServerId = null;
  h.voice.dmCallConversationId = null;
  h.voice.incomingCall = null;
  h.auth.user = { id: 'me' };
  h.e2e.ready = true;
  h.e2e.error = null;
  h.e2e.listeners = [];
  h.purgeCachedPlaintexts.mockReset();
  h.purgeCachedPlaintexts.mockImplementation(async (scopes, _remove, opts) => walkEnded(scopes, opts));
  h.clearPurgeMarks.mockReset();
  h.clearPurgeMarks.mockImplementation(async () => {});
  h.scopeMarkedPurged.mockReset();
  h.scopeMarkedPurged.mockImplementation(() => false);
  h.apiGet.mockResolvedValue({ data: { data: [serverReadOnly('c1'), conv('c2')] } });
  useDMStore.setState({
    conversations: [conv('c1'), conv('c2')], activeConversationId: 'c1', readOnlyPurges: {}, readOnlyConfirmed: {}, readOnlyPending: {}, participantStatuses: {},
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  closed = [];
  stopListening = onCloseProfilePopups((id) => closed.push(id));
});
afterEach(() => {
  stopListening();
  warn.mockRestore();
});

describe('a payload that is not { conversationId: string } is ignored', () => {
  it.each([
    ['null', null],
    ['a string', 'c1'],
    ['a number', 42],
    ['an empty object', {}],
    ['a non-string id', { conversationId: 7 }],
    ['an empty id', { conversationId: '' }],
  ])('%s: warned once, nothing moves', (_label, payload) => {
    handleConversationReadOnly(payload);
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a malformed dm:conversation:read_only payload');
    expect(useDMStore.getState().conversations[0].participantDeleted).toBeUndefined();
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.purgeCachedPlaintexts).not.toHaveBeenCalled();
  });
});

describe('a conversation the list has not loaded', () => {
  it('is held read-only by its id: no refetch and no purge now; the next list applies it, purge included', async () => {
    handleConversationReadOnly({ conversationId: 'c-unknown' });
    await settle();
    expect(useDMStore.getState().readOnlyPending).toEqual({ 'c-unknown': true });
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.purgeCachedPlaintexts).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    h.apiGet.mockResolvedValue({ data: { data: [conv('c1'), conv('c2'), conv('c-unknown')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(useDMStore.getState().conversations.find((c) => c.id === 'c-unknown')!.participantDeleted).toBe(true);
    expect(useDMStore.getState().readOnlyPending).toEqual({});
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(h.purgeCachedPlaintexts.mock.calls[0][0]).toEqual(['c-unknown']);
  });
});

describe('the conversation on screen turns read-only', () => {
  it('flips at once, reloads the view through dmStore, refetches the list once, and purges what the other person wrote', async () => {
    const walk = heldWalk();
    handleConversationReadOnly({ conversationId: 'c1' });

    // at once, before any request settles
    const flipped = useDMStore.getState().conversations.find((c) => c.id === 'c1')!;
    expect(flipped.participantDeleted).toBe(true);
    expect(flipped.participant.id).toBe('deleted:c1');
    expect(h.chat.clearMessages).toHaveBeenCalledTimes(1);
    expect(h.chat.fetchDMMessages).toHaveBeenCalledWith('c1');

    await settle();
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(h.apiGet).toHaveBeenCalledWith('/dm');
    // the refetched list served it read-only: confirmed, while the walk runs
    expect(useDMStore.getState().readOnlyConfirmed).toEqual({ c1: true });
    walk.finish();
    await settle();
    // one purge, though the refetched list names the conversation read-only again
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    const [scopes, remove, opts] = h.purgeCachedPlaintexts.mock.calls[0] as unknown as [string[], (e: PlaintextPurgeEntry) => boolean, PurgeOpts];
    expect(scopes).toEqual(['c1']);
    // the mark that lets a later session skip the walk, asked of the list's word when the walk ended
    expect(opts.mark).toBe('read-only');
    expect(opts.record?.('c1')).toBe(true);
    expect(opts.record?.('c2')).toBe(false);
    expect(remove({ scope: 'c1', messageId: 'a', authorId: 'me', editedAt: null })).toBe(false);
    expect(remove({ scope: 'c1', messageId: 'b', authorId: 'u-alice', editedAt: null })).toBe(true);
    // an entry that records no author is kept
    expect(remove({ scope: 'c1', messageId: 'c', editedAt: null })).toBe(false);
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done' });
    // the other conversation is untouched
    expect(useDMStore.getState().conversations.find((c) => c.id === 'c2')!.participantDeleted).toBeUndefined();
  });

  it('closes the profile cards of the person it was', () => {
    handleConversationReadOnly({ conversationId: 'c1' });
    expect(closed).toEqual(['u-alice']);
  });

  it('a server channel on screen (activeConversationId kept behind it): the shared chat store is left alone', () => {
    h.server.activeServerId = 'srv-1';
    handleConversationReadOnly({ conversationId: 'c1' });
    expect(h.chat.clearMessages).not.toHaveBeenCalled();
    expect(h.chat.fetchDMMessages).not.toHaveBeenCalled();
    expect(useDMStore.getState().conversations[0].participantDeleted).toBe(true);
  });

  it('another conversation on screen: no reload', () => {
    useDMStore.setState({ activeConversationId: 'c2' });
    handleConversationReadOnly({ conversationId: 'c1' });
    expect(h.chat.clearMessages).not.toHaveBeenCalled();
  });
});

describe('calls', () => {
  it('a call of THIS conversation (ringing out or connected) ends locally', () => {
    h.voice.dmCallConversationId = 'c1';
    handleConversationReadOnly({ conversationId: 'c1' });
    expect(h.voice.handleDMCallEnded).toHaveBeenCalledTimes(1);
  });

  it('a ring of THIS conversation is dropped', () => {
    h.voice.incomingCall = { conversationId: 'c1', from: ALICE };
    handleConversationReadOnly({ conversationId: 'c1' });
    expect(h.voice.setIncomingCall).toHaveBeenCalledWith(null);
  });

  it('a call or a ring of ANOTHER conversation is left alone', () => {
    h.voice.dmCallConversationId = 'c2';
    h.voice.incomingCall = { conversationId: 'c2', from: ALICE };
    handleConversationReadOnly({ conversationId: 'c1' });
    expect(h.voice.handleDMCallEnded).not.toHaveBeenCalled();
    expect(h.voice.setIncomingCall).not.toHaveBeenCalled();
  });
});

describe('a conversation already read-only (a list said so first)', () => {
  it('no second transition and no refetch: only the once-per-session purge is left', async () => {
    useDMStore.setState({ conversations: [serverReadOnly('c1')], readOnlyPurges: {}, readOnlyConfirmed: { c1: true } });
    h.voice.dmCallConversationId = 'c1';
    handleConversationReadOnly({ conversationId: 'c1' });
    await settle();
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.chat.clearMessages).not.toHaveBeenCalled();
    expect(h.voice.handleDMCallEnded).not.toHaveBeenCalled();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
  });
});

describe('the list reconciliation (the event was missed)', () => {
  it('brings the transition into line exactly like the event (view, call, cards, purge), without fetching the list', async () => {
    h.voice.dmCallConversationId = 'c1';
    applyReadOnlyConversations([{ conversationId: 'c1', previousParticipantId: 'u-alice' }], ['c1']);
    await settle();
    expect(h.chat.fetchDMMessages).toHaveBeenCalledWith('c1');
    expect(h.voice.handleDMCallEnded).toHaveBeenCalledTimes(1);
    expect(closed).toEqual(['u-alice']);
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(h.apiGet).not.toHaveBeenCalled();
  });

  it('through dmStore: a fetch that serves the conversation read-only does the same, purge included', async () => {
    h.voice.dmCallConversationId = 'c1';
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(useDMStore.getState().conversations.find((c) => c.id === 'c1')!.participantDeleted).toBe(true);
    expect(h.chat.fetchDMMessages).toHaveBeenCalledWith('c1');
    expect(h.voice.handleDMCallEnded).toHaveBeenCalledTimes(1);
    expect(closed).toEqual(['u-alice']);
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    // a second fetch: nothing again
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(h.voice.handleDMCallEnded).toHaveBeenCalledTimes(1);
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
  });

  it('a placeholder as the previous participant closes no card', () => {
    applyReadOnlyConversations([{ conversationId: 'c1', previousParticipantId: 'deleted:c1' }], []);
    expect(closed).toEqual([]);
  });
});

describe('the purge, once per conversation per session', () => {
  it('the conversations a list names together are purged in ONE pass', async () => {
    useDMStore.setState({ readOnlyConfirmed: { c1: true, c2: true } });
    applyReadOnlyConversations([], ['c1', 'c2']);
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(h.purgeCachedPlaintexts.mock.calls[0][0]).toEqual(['c1', 'c2']);
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done', c2: 'done' });
  });

  it('one asked while a pass runs joins the next pass', async () => {
    const walk = heldWalk();
    purgeReadOnlyConversation('c1');
    await settle();
    purgeReadOnlyConversation('c2');
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    walk.finish();
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(2);
    expect(h.purgeCachedPlaintexts.mock.calls[1][0]).toEqual(['c2']);
  });

  it('an E2E start that already failed: no wait, the purge is left for the next list', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    h.e2e.ready = false;
    h.e2e.error = 'init failed';
    purgeReadOnlyConversation('c1');
    await settle();
    expect(h.e2e.listeners).toHaveLength(0);
    expect(h.purgeCachedPlaintexts).not.toHaveBeenCalled();
    expect(useDMStore.getState().readOnlyPurges.c1).toBeUndefined();
    debug.mockRestore();
  });

  it('running or done: not started again', async () => {
    useDMStore.setState({ readOnlyConfirmed: { c1: true } });
    const walk = heldWalk();
    purgeReadOnlyConversation('c1');
    await settle();
    purgeReadOnlyConversation('c1');
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().readOnlyPurges.c1).toBe('running');
    walk.finish(3);
    await settle();
    purgeReadOnlyConversation('c1');
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().readOnlyPurges.c1).toBe('done');
  });

  it('a failure is logged without any text, leaves no mark, and the next list tries again', async () => {
    useDMStore.setState({ readOnlyConfirmed: { c1: true } });
    h.purgeCachedPlaintexts.mockRejectedValueOnce(new DOMException('The transaction was aborted', 'AbortError'));
    purgeReadOnlyConversation('c1');
    await settle();
    expect(useDMStore.getState().readOnlyPurges.c1).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].join(' ');
    expect(logged).toContain('Could not purge the cached text of read-only conversations');
    expect(logged).toContain('AbortError');

    h.purgeCachedPlaintexts.mockImplementationOnce(async (scopes, _remove, opts) => walkEnded(scopes, opts, 2));
    purgeReadOnlyConversation('c1');
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(2);
    expect(useDMStore.getState().readOnlyPurges.c1).toBe('done');
  });

  it('a session ending under it (the service disposed) is not a failure to warn about', async () => {
    const ended = new Error('E2E service disposed');
    ended.name = 'E2EServiceDisposedError';
    h.purgeCachedPlaintexts.mockRejectedValueOnce(ended);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    purgeReadOnlyConversation('c1');
    await settle();
    expect(warn).not.toHaveBeenCalled();
    expect(useDMStore.getState().readOnlyPurges.c1).toBeUndefined();
    debug.mockRestore();
  });

  it('waits for the E2E service to start, then runs; a start that fails leaves it for the next list', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    h.e2e.ready = false;
    purgeReadOnlyConversation('c1');
    await settle();
    expect(h.purgeCachedPlaintexts).not.toHaveBeenCalled();
    for (const l of [...h.e2e.listeners]) l({ ready: true, error: null });
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);

    purgeReadOnlyConversation('c2');
    await settle();
    for (const l of [...h.e2e.listeners]) l({ ready: false, error: 'init failed' });
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().readOnlyPurges.c2).toBeUndefined();
    debug.mockRestore();
  });

  it('nobody signed in: nothing', async () => {
    h.auth.user = null;
    purgeReadOnlyConversation('c1');
    await settle();
    expect(h.purgeCachedPlaintexts).not.toHaveBeenCalled();
  });

  it('the account changed while it ran: the next session\'s store is not written', async () => {
    const walk = heldWalk();
    purgeReadOnlyConversation('c1');
    await settle();
    useDMStore.setState({ readOnlyPurges: {} }); // the logout reset
    h.auth.user = { id: 'someone-else' };
    walk.finish(1);
    await settle();
    expect(useDMStore.getState().readOnlyPurges).toEqual({});
  });
});

describe('the purge mark: only for a conversation a LIST served read-only', () => {
  it('the event alone writes no mark: the walk runs, records nothing, and is not started again on the event\'s word', async () => {
    // the list fetched after the event answers from before the deletion: it confirms nothing
    h.apiGet.mockResolvedValue({ data: { data: [conv('c1'), conv('c2')] } });
    handleConversationReadOnly({ conversationId: 'c1' });
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    const opts = h.purgeCachedPlaintexts.mock.calls[0][2] as PurgeOpts;
    expect(opts.record?.('c1')).toBe(false);
    expect(await h.purgeCachedPlaintexts.mock.results[0].value).toEqual({ removed: 0, marked: [] });
    expect(useDMStore.getState().readOnlyConfirmed).toEqual({});
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'unmarked' });
    // still read-only on screen (an account deletion is final)
    expect(useDMStore.getState().conversations.find((c) => c.id === 'c1')!.participantDeleted).toBe(true);
    // asked again on the event's word (or by a list that does not serve it so): nothing
    purgeReadOnlyConversation('c1');
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
  });

  it('a list that serves it read-only later: the walk runs again and writes the mark', async () => {
    h.apiGet.mockResolvedValue({ data: { data: [conv('c1'), conv('c2')] } });
    handleConversationReadOnly({ conversationId: 'c1' });
    await settle();
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'unmarked' });

    h.apiGet.mockResolvedValue({ data: { data: [serverReadOnly('c1'), conv('c2')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(useDMStore.getState().readOnlyConfirmed).toEqual({ c1: true });
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(2);
    expect(await h.purgeCachedPlaintexts.mock.results[1].value).toEqual({ removed: 0, marked: ['c1'] });
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done' });
  });

  it('a list-confirmed purge writes it, a pending id included', async () => {
    handleConversationReadOnly({ conversationId: 'c-unknown' });
    h.apiGet.mockResolvedValue({ data: { data: [conv('c-unknown', { participantDeleted: true, participant: { id: 'deleted:c-unknown', username: 'deleted', displayName: 'Deleted user', avatarUrl: null } })] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(await h.purgeCachedPlaintexts.mock.results[0].value).toEqual({ removed: 0, marked: ['c-unknown'] });
    expect(useDMStore.getState().readOnlyPurges).toEqual({ 'c-unknown': 'done' });
  });

  it('a pending id the list applies without serving it read-only: purged, not marked', async () => {
    handleConversationReadOnly({ conversationId: 'c-unknown' });
    h.apiGet.mockResolvedValue({ data: { data: [conv('c-unknown')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(useDMStore.getState().conversations[0].participantDeleted).toBe(true);
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().readOnlyConfirmed).toEqual({});
    expect(useDMStore.getState().readOnlyPurges).toEqual({ 'c-unknown': 'unmarked' });
  });

  it('confirmed by a list after the walk ended but before its answer was applied: the mark is still written', async () => {
    let finish: () => void = () => {};
    h.purgeCachedPlaintexts.mockImplementationOnce((scopes, _remove, opts) => new Promise<PurgeAnswer>((resolve) => {
      // the walk ends and asks `record` BEFORE the list confirms
      const answer = walkEnded(scopes, opts);
      finish = () => resolve(answer);
    }));
    purgeReadOnlyConversation('c1');
    await settle();
    useDMStore.setState({ readOnlyConfirmed: { c1: true } });
    finish();
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(2);
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done' });
  });
});

describe('standsAsDeletedNow: a row the read-only rule shows as deleted', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    conversationId: 'c1', type: 'user' as const, encrypted: true, content: 'x', author: { id: 'u-alice' }, ...over,
  }) as Parameters<typeof standsAsDeletedNow>[0];

  it('the other person\'s row of a conversation held read-only, and only there', () => {
    expect(standsAsDeletedNow(row())).toBe(false);
    useDMStore.setState({ conversations: [serverReadOnly('c1'), conv('c2')] });
    expect(standsAsDeletedNow(row())).toBe(true);
    expect(standsAsDeletedNow(row({ conversationId: 'c2' }))).toBe(false);
    expect(standsAsDeletedNow(row({ conversationId: null }))).toBe(false);
  });

  it('a conversation an event named before the list loaded it counts too', () => {
    useDMStore.setState({ conversations: [], readOnlyPending: { c1: true } });
    expect(standsAsDeletedNow(row())).toBe(true);
  });

  it('our own row and a listed call notice stand; nobody signed in: nothing is ours', () => {
    useDMStore.setState({ conversations: [serverReadOnly('c1')] });
    expect(standsAsDeletedNow(row({ author: { id: 'me' } }))).toBe(false);
    expect(standsAsDeletedNow(row({ type: 'system', encrypted: false, content: DM_NOTICE_CALL_STARTED, author: { id: 'u-alice' } }))).toBe(false);
    // the type alone is not a notice
    expect(standsAsDeletedNow(row({ type: 'system', encrypted: false, content: 'hello', author: { id: 'u-alice' } }))).toBe(true);
    h.auth.user = null;
    expect(standsAsDeletedNow(row({ author: { id: 'me' } }))).toBe(true);
  });
});

describe('a list that serves a conversation live clears its purge mark', () => {
  it('the marked ones it serves live, and only those, have their mark cleared', async () => {
    h.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === 'c1' || scope === 'c9');
    h.apiGet.mockResolvedValue({ data: { data: [conv('c1'), conv('c2')] } });
    useDMStore.setState({ conversations: [] });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(h.clearPurgeMarks).toHaveBeenCalledTimes(1);
    // c9 is marked but the list does not name it: it keeps its mark
    expect(h.clearPurgeMarks).toHaveBeenCalledWith('read-only', ['c1']);
    expect(h.scopeMarkedPurged).toHaveBeenCalledWith('me', 'c1');
  });

  it('a list that serves it read-only clears nothing', async () => {
    h.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === 'c1');
    h.apiGet.mockResolvedValue({ data: { data: [serverReadOnly('c1'), conv('c2')] } });
    useDMStore.setState({ conversations: [] });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(h.clearPurgeMarks).not.toHaveBeenCalled();
  });

  it('nothing marked: no clear at all', async () => {
    clearMarksOfLiveConversations(['c1', 'c2']);
    await settle();
    expect(h.clearPurgeMarks).not.toHaveBeenCalled();
  });

  it('marks still being read: their answer decides', async () => {
    h.scopeMarkedPurged.mockImplementation(async (_userId, scope) => scope === 'c2');
    clearMarksOfLiveConversations(['c1', 'c2']);
    await settle();
    expect(h.clearPurgeMarks).toHaveBeenCalledWith('read-only', ['c2']);
  });

  it('waits for the E2E service to start; a start that fails clears nothing', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    h.scopeMarkedPurged.mockImplementation(() => true);
    h.e2e.ready = false;
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.clearPurgeMarks).not.toHaveBeenCalled();
    for (const l of [...h.e2e.listeners]) l({ ready: true, error: null });
    await settle();
    expect(h.clearPurgeMarks).toHaveBeenCalledWith('read-only', ['c1']);

    h.clearPurgeMarks.mockClear();
    h.e2e.ready = false;
    h.e2e.error = 'init failed';
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.clearPurgeMarks).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it('nobody signed in, or an account change on the way: nothing', async () => {
    h.scopeMarkedPurged.mockImplementation(() => true);
    h.auth.user = null;
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.clearPurgeMarks).not.toHaveBeenCalled();

    h.auth.user = { id: 'me' };
    h.scopeMarkedPurged.mockImplementation(async () => {
      h.auth.user = { id: 'someone-else' };
      return true;
    });
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.clearPurgeMarks).not.toHaveBeenCalled();
  });

  it('a failure is logged; a session that ended is not warned about', async () => {
    h.scopeMarkedPurged.mockImplementation(() => true);
    h.clearPurgeMarks.mockRejectedValueOnce(new DOMException('The transaction was aborted', 'AbortError'));
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('Could not clear the purge marks of conversations a list served live');
    expect(warn.mock.calls[0].join(' ')).toContain('AbortError');

    const ended = new Error('E2E service disposed');
    ended.name = 'E2EServiceDisposedError';
    h.clearPurgeMarks.mockRejectedValueOnce(ended);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it('the conversation on screen in the DM view whose mark it cleared is loaded again; another one, or a server view, is not', async () => {
    h.scopeMarkedPurged.mockImplementation((_userId, scope) => scope === 'c1');
    useDMStore.setState({ conversations: [conv('c1'), conv('c2')], activeConversationId: 'c1' });
    clearMarksOfLiveConversations(['c1', 'c2']);
    await settle();
    expect(h.clearPurgeMarks).toHaveBeenCalledWith('read-only', ['c1']);
    expect(h.chat.clearMessages).toHaveBeenCalledTimes(1);
    expect(h.chat.fetchDMMessages).toHaveBeenCalledWith('c1');

    // c2 on screen, c1 cleared: no reload
    h.chat.fetchDMMessages.mockClear();
    useDMStore.setState({ activeConversationId: 'c2' });
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.chat.fetchDMMessages).not.toHaveBeenCalled();

    // a server channel on screen (activeConversationId kept behind it): the shared chat store is left alone
    useDMStore.setState({ activeConversationId: 'c1' });
    h.server.activeServerId = 'srv-1';
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.chat.fetchDMMessages).not.toHaveBeenCalled();
  });

  it('a conversation the store still holds read-only this session is not reloaded when its mark is cleared', async () => {
    h.scopeMarkedPurged.mockImplementation(() => true);
    useDMStore.setState({ conversations: [serverReadOnly('c1')], activeConversationId: 'c1' });
    clearMarksOfLiveConversations(['c1']);
    await settle();
    expect(h.clearPurgeMarks).toHaveBeenCalledWith('read-only', ['c1']);
    expect(h.chat.fetchDMMessages).not.toHaveBeenCalled();
  });

  it('a conversation unconfirmed by a live list and confirmed again: the walk runs and marks it', async () => {
    // confirmed and purged, then served live (a restored server), then read-only again
    h.apiGet.mockResolvedValue({ data: { data: [serverReadOnly('c1')] } });
    useDMStore.setState({ conversations: [] });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done' });
    // the list now serves it live; the store, having seen it read-only this session, still holds it so
    h.apiGet.mockResolvedValue({ data: { data: [conv('c1')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'unmarked' });
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);

    h.apiGet.mockResolvedValue({ data: { data: [serverReadOnly('c1')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(2);
    expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done' });
  });
});
