import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation } from '@voxium/shared';

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
    purgeCachedPlaintexts: vi.fn(async () => 0),
  };
});

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
  getE2EService: () => ({ purgeCachedPlaintexts: h.purgeCachedPlaintexts }),
}));

import { handleConversationReadOnly, applyReadOnlyConversations, purgeReadOnlyConversation } from '../../services/dmReadOnly';
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

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
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
  h.purgeCachedPlaintexts.mockImplementation(async () => 0);
  h.apiGet.mockResolvedValue({ data: { data: [serverReadOnly('c1'), conv('c2')] } });
  useDMStore.setState({ conversations: [conv('c1'), conv('c2')], activeConversationId: 'c1', readOnlyPurges: {}, participantStatuses: {} });
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

describe('an unknown conversation', () => {
  it('is ignored: no flip, no refetch, no purge (the next list brings it in)', async () => {
    handleConversationReadOnly({ conversationId: 'c-unknown' });
    await settle();
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.purgeCachedPlaintexts).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the conversation on screen turns read-only', () => {
  it('flips at once, reloads the view through dmStore, refetches the list once, and purges what the other person wrote', async () => {
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
    // one purge, though the refetched list names the conversation read-only again
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    const [scope, remove] = h.purgeCachedPlaintexts.mock.calls[0] as unknown as [string, (e: PlaintextPurgeEntry) => boolean];
    expect(scope).toBe('c1');
    expect(remove({ messageId: 'a', authorId: 'me', editedAt: null })).toBe(false);
    expect(remove({ messageId: 'b', authorId: 'u-alice', editedAt: null })).toBe(true);
    expect(remove({ messageId: 'c', editedAt: null })).toBe(true);
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
    useDMStore.setState({ conversations: [serverReadOnly('c1')], readOnlyPurges: {} });
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
  it('running or done: not started again', async () => {
    let finish: (n: number) => void = () => {};
    h.purgeCachedPlaintexts.mockImplementation(() => new Promise<number>((r) => { finish = r; }));
    purgeReadOnlyConversation('c1');
    await settle();
    purgeReadOnlyConversation('c1');
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().readOnlyPurges.c1).toBe('running');
    finish(3);
    await settle();
    purgeReadOnlyConversation('c1');
    expect(h.purgeCachedPlaintexts).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().readOnlyPurges.c1).toBe('done');
  });

  it('a failure is logged without any text, leaves no mark, and the next list tries again', async () => {
    h.purgeCachedPlaintexts.mockRejectedValueOnce(new DOMException('The transaction was aborted', 'AbortError'));
    purgeReadOnlyConversation('c1');
    await settle();
    expect(useDMStore.getState().readOnlyPurges.c1).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].join(' ');
    expect(logged).toContain('Could not purge the cached text of a read-only conversation');
    expect(logged).toContain('AbortError');

    h.purgeCachedPlaintexts.mockResolvedValueOnce(2);
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
    let finish: (n: number) => void = () => {};
    h.purgeCachedPlaintexts.mockImplementation(() => new Promise<number>((r) => { finish = r; }));
    purgeReadOnlyConversation('c1');
    await settle();
    useDMStore.setState({ readOnlyPurges: {} }); // the logout reset
    h.auth.user = { id: 'someone-else' };
    finish(1);
    await settle();
    expect(useDMStore.getState().readOnlyPurges).toEqual({});
  });
});
