import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DELETED_MESSAGE_TYPE } from '@voxium/shared';
import type { Conversation } from '@voxium/shared';

/**
 * A conversation whose other side's account was deleted, as dmStore holds it.
 * The `dm:conversation:read_only` event can be missed (it is at-most-once),
 * so the list fetch is the other way in: a list that serves the conversation
 * with `participantDeleted: true` brings the screen into line and purges the
 * cache, exactly like the event (services/dmReadOnly.ts does both).
 */

const { apiGet, apiPost, toastError, resolveEncryptedPreview, applyReadOnlyConversations, chat } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastError: vi.fn(),
  resolveEncryptedPreview: vi.fn(),
  applyReadOnlyConversations: vi.fn(),
  chat: { clearMessages: vi.fn(), fetchDMMessages: vi.fn(async () => {}) },
}));

vi.mock('../../services/api', () => ({ api: { get: apiGet, post: apiPost, patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => chat } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations }));

import { useDMStore, isConversationReadOnly } from '../../stores/dmStore';

const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: 'avatars/alice.webp', status: 'online', role: 'admin', isSupporter: true, supporterTier: 'top' };
const PLACEHOLDER = { id: 'deleted:c1', username: 'deleted', displayName: 'Deleted user', avatarUrl: null, status: 'offline', role: 'user', isSupporter: false, supporterTier: null };

function conv(over: Partial<Conversation> & Record<string, unknown> = {}): Conversation {
  return {
    id: 'c1',
    user1Id: 'me',
    user2Id: 'u-alice',
    participant: ALICE,
    lastMessage: { id: 'm1', content: 'Voice call ended', encrypted: false, type: 'system', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'u-alice' },
    encryptedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Conversation;
}
const readOnlyConv = (over: Partial<Conversation> & Record<string, unknown> = {}) =>
  conv({ user2Id: null, participant: PLACEHOLDER as Conversation['participant'], participantDeleted: true, ...over });

/** Lets the dynamic import of services/dmReadOnly settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  toastError.mockReset();
  resolveEncryptedPreview.mockReset();
  applyReadOnlyConversations.mockReset();
  chat.clearMessages.mockReset();
  chat.fetchDMMessages.mockReset();
  useDMStore.setState({ conversations: [], isLoading: false, participantStatuses: {}, activeConversationId: null, readOnlyPurges: {} });
});

describe('the list reconciles read-only conversations without the event', () => {
  it('a conversation seen live, now served read-only: one transition with the participant it had, and a purge', async () => {
    useDMStore.setState({ conversations: [conv()] });
    apiGet.mockResolvedValue({ data: { data: [readOnlyConv()] } });

    await useDMStore.getState().fetchConversations();
    await settle();

    expect(applyReadOnlyConversations).toHaveBeenCalledTimes(1);
    expect(applyReadOnlyConversations).toHaveBeenCalledWith([{ conversationId: 'c1', previousParticipantId: 'u-alice' }], ['c1']);
    expect(isConversationReadOnly('c1')).toBe(true);
  });

  it('the first list of a session: no transition (nothing on screen yet), but every read-only conversation is purged', async () => {
    apiGet.mockResolvedValue({ data: { data: [readOnlyConv(), conv({ id: 'c2' })] } });

    await useDMStore.getState().fetchConversations();
    await settle();

    expect(applyReadOnlyConversations).toHaveBeenCalledWith([], ['c1']);
  });

  it('no read-only conversation: the module is not even loaded', async () => {
    apiGet.mockResolvedValue({ data: { data: [conv()] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(applyReadOnlyConversations).not.toHaveBeenCalled();
  });

  it('stays read-only: a later list answered from before the deletion (or that lost the flag) changes nothing', async () => {
    useDMStore.setState({ conversations: [readOnlyConv()] });
    apiGet.mockResolvedValue({ data: { data: [conv()] } });

    await useDMStore.getState().fetchConversations();

    const c = useDMStore.getState().conversations[0];
    expect(c.participantDeleted).toBe(true);
    expect(c.participant.id).toBe('deleted:c1');
    expect(isConversationReadOnly('c1')).toBe(true);
  });

  it('a deleted account has no presence: its placeholder gets no status', async () => {
    apiGet.mockResolvedValue({ data: { data: [readOnlyConv(), conv({ id: 'c2' })] } });
    await useDMStore.getState().fetchConversations();
    expect(useDMStore.getState().participantStatuses).toEqual({ 'u-alice': 'online' });
  });

  it('a `deleted` last message keeps no text and is never looked up in the cache, whatever the server put in it', async () => {
    apiGet.mockResolvedValue({ data: { data: [readOnlyConv({
      lastMessage: { id: 'm9', content: 'leaked words', encrypted: true, type: DELETED_MESSAGE_TYPE, createdAt: '2026-11-01T10:00:00.000Z', authorId: 'deleted:c1' },
    })] } });

    await useDMStore.getState().fetchConversations();

    const last = useDMStore.getState().conversations[0].lastMessage!;
    expect(last.content).toBe('');
    expect(last.encrypted).toBe(false);
    expect(resolveEncryptedPreview).not.toHaveBeenCalled();
  });

  it('an encrypted preview under the placeholder author is never looked up either', async () => {
    apiGet.mockResolvedValue({ data: { data: [readOnlyConv({
      lastMessage: { id: 'm9', content: 'ct', encrypted: true, type: 'user', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'deleted:c1' },
    })] } });
    await useDMStore.getState().fetchConversations();
    expect(resolveEncryptedPreview).not.toHaveBeenCalled();
  });

  it('the recognition is the flag or the id prefix, never the name: a real "deleted" account stays live', async () => {
    apiGet.mockResolvedValue({ data: { data: [conv({ participant: { ...ALICE, username: 'deleted', displayName: 'Deleted user' } as Conversation['participant'] })] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(isConversationReadOnly('c1')).toBe(false);
    expect(applyReadOnlyConversations).not.toHaveBeenCalled();
  });
});

describe('markParticipantDeleted (the event\'s local flip)', () => {
  it('flips at once: the placeholder built here from the conversation id, the flag, the transition answered', () => {
    useDMStore.setState({ conversations: [conv({ lastMessage: { id: 'm1', content: 'their last words', encrypted: true, type: 'user', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'u-alice' } })] });

    const transition = useDMStore.getState().markParticipantDeleted('c1', 'me');

    expect(transition).toEqual({ conversationId: 'c1', previousParticipantId: 'u-alice' });
    const c = useDMStore.getState().conversations[0];
    expect(c.participantDeleted).toBe(true);
    expect(c.participant.id).toBe('deleted:c1');
    expect(c.participant.avatarUrl).toBeNull();
    expect(c.participant.isSupporter).toBe(false);
    // the other person wrote the last message: it stands as deleted, no text
    expect(c.lastMessage).toMatchObject({ id: 'm1', type: DELETED_MESSAGE_TYPE, content: '', encrypted: false, authorId: 'deleted:c1' });
  });

  it('keeps an own last message and the other person\'s call notice as they are', () => {
    const own = { id: 'm2', content: 'my words', encrypted: true, type: 'user', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'me' };
    useDMStore.setState({ conversations: [conv({ lastMessage: own }), conv({ id: 'c2' })] });

    useDMStore.getState().markParticipantDeleted('c1', 'me');
    useDMStore.getState().markParticipantDeleted('c2', 'me');

    expect(useDMStore.getState().conversations[0].lastMessage).toEqual(own);
    expect(useDMStore.getState().conversations[1].lastMessage?.content).toBe('Voice call ended');
  });

  it('a conversation not loaded, or already read-only: null, nothing changes', () => {
    useDMStore.setState({ conversations: [readOnlyConv()] });
    expect(useDMStore.getState().markParticipantDeleted('c1', 'me')).toBeNull();
    expect(useDMStore.getState().markParticipantDeleted('nope', 'me')).toBeNull();
  });
});

describe('reloadConversationView', () => {
  it('the active conversation: dmStore clears the shared chat store and loads it again', () => {
    useDMStore.setState({ activeConversationId: 'c1' });
    useDMStore.getState().reloadConversationView('c1');
    expect(chat.clearMessages).toHaveBeenCalledTimes(1);
    expect(chat.fetchDMMessages).toHaveBeenCalledWith('c1');
  });

  it('another conversation: nothing', () => {
    useDMStore.setState({ activeConversationId: 'c2' });
    useDMStore.getState().reloadConversationView('c1');
    expect(chat.clearMessages).not.toHaveBeenCalled();
    expect(chat.fetchDMMessages).not.toHaveBeenCalled();
  });
});

describe('openDM never names the placeholder', () => {
  it('refuses a `deleted:` id without a request', async () => {
    await expect(useDMStore.getState().openDM('deleted:c1')).rejects.toThrow();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
