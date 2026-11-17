import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@voxium/shared';

/**
 * A DM whose other side's account was deleted is read-only. The controls are
 * gone from the screen (DMChatArea, MessageItem); the chat store refuses the
 * same actions when they are invoked anyway, before anything is encrypted,
 * sent or signalled: send, edit, reaction and reply. Deleting one's own
 * message stays allowed.
 */

const { apiPost, apiPatch, apiPut, apiDelete, emit, prepareOutgoingDM, dm } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(async () => ({ data: {} })),
  emit: vi.fn(),
  prepareOutgoingDM: vi.fn(),
  dm: { conversations: [] as Array<Record<string, unknown>> },
}));
vi.mock('../../services/api', () => ({ api: { post: apiPost, get: vi.fn(), patch: apiPatch, put: apiPut, delete: apiDelete } }));
vi.mock('../../services/socket', () => ({ getSocket: () => ({ emit }) }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => dm } }));
vi.mock('../../stores/serverStore', () => ({ useServerStore: { getState: () => ({ channels: [], members: [], secureChannelMembers: {} }) } }));
vi.mock('../../services/e2e/dmCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/dmCrypto')>();
  return { ...actual, prepareOutgoingDM, cacheSentPlaintext: vi.fn(async () => undefined) };
});

import { useChatStore } from '../../stores/chatStore';
import { DMConversationReadOnlyError } from '../../utils/dmParticipant';

const READ_ONLY = { id: 'c-ro', participant: { id: 'deleted:c-ro', username: 'deleted', displayName: 'Deleted user', avatarUrl: null }, participantDeleted: true };
const LIVE = { id: 'c-live', participant: { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null } };

const ownRow = (conversationId: string): Message => ({
  id: 'm-own', type: 'user', content: 'mine', encrypted: true, channelId: null, conversationId,
  author: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null },
  createdAt: '2026-11-01T10:00:00.000Z', editedAt: null, reactions: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  dm.conversations = [READ_ONLY, LIVE];
  useChatStore.setState({ messages: [], replyingTo: null });
});

function expectNothingSent() {
  expect(prepareOutgoingDM).not.toHaveBeenCalled();
  expect(apiPost).not.toHaveBeenCalled();
  expect(apiPatch).not.toHaveBeenCalled();
  expect(apiPut).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
}

describe('the chat store refuses what a read-only conversation does not allow', () => {
  it('sendDMMessage: the typed error, nothing encrypted, posted or signalled (no typing stop either)', async () => {
    await expect(useChatStore.getState().sendDMMessage('c-ro', 'hello?')).rejects.toBeInstanceOf(DMConversationReadOnlyError);
    expectNothingSent();
  });

  it('editDMMessage: refused, nothing re-encrypted or patched', async () => {
    await expect(useChatStore.getState().editDMMessage('c-ro', 'm-own', 'edited')).rejects.toBeInstanceOf(DMConversationReadOnlyError);
    expectNothingSent();
  });

  it('toggleDMReaction: refused, no reaction request', async () => {
    await expect(useChatStore.getState().toggleDMReaction('c-ro', 'm-own', '👍')).rejects.toBeInstanceOf(DMConversationReadOnlyError);
    expectNothingSent();
  });

  it('setReplyingTo: a message of the conversation is never set as the reply', () => {
    useChatStore.getState().setReplyingTo(ownRow('c-ro'));
    expect(useChatStore.getState().replyingTo).toBeNull();
  });

  it('deleting one\'s own message stays allowed', async () => {
    await useChatStore.getState().requestDeleteDMMessage('c-ro', 'm-own');
    expect(apiDelete).toHaveBeenCalledWith('/dm/c-ro/messages/m-own');
  });

  it('a live conversation is unaffected', async () => {
    apiPut.mockResolvedValue({ data: {} });
    await useChatStore.getState().toggleDMReaction('c-live', 'm-1', '👍');
    expect(apiPut).toHaveBeenCalledTimes(1);
    useChatStore.getState().setReplyingTo(ownRow('c-live'));
    expect(useChatStore.getState().replyingTo?.id).toBe('m-own');
  });

  it('recognised by the placeholder id even without the flag', async () => {
    dm.conversations = [{ ...READ_ONLY, participantDeleted: undefined }];
    await expect(useChatStore.getState().sendDMMessage('c-ro', 'hello?')).rejects.toBeInstanceOf(DMConversationReadOnlyError);
    expectNothingSent();
  });
});
