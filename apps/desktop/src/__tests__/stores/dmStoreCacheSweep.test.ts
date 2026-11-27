import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation } from '@voxium/shared';

/**
 * The DM store's side of the device's sweep of its plaintext cache
 * (services/cacheSweep.ts, tested over a real vault in
 * __tests__/e2e/cacheSweep.test.ts): the sweep waits for a first page of the
 * conversation list of the session, applied for the account that asked, so
 * that what the list holds is kept. A later page, a failed fetch and an
 * answer for an account that signed out tell it nothing.
 */

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  noteConversationListApplied: vi.fn(),
  heldWhenNoted: [] as string[][],
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview: vi.fn().mockResolvedValue(null) }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ clearMessages: vi.fn(), messages: [] }) } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));
vi.mock('../../services/cacheSweep', () => ({
  noteConversationListApplied: (askedBy: string | null | undefined) => {
    // what the store holds when the sweep is told
    h.heldWhenNoted.push(useDMStore.getState().conversations.map((c) => c.id));
    h.noteConversationListApplied(askedBy);
  },
}));

import { useDMStore } from '../../stores/dmStore';
import { registerE2ESessionUser } from '../../services/e2e/session';

const conv = (id: string): Conversation => ({
  id, user1Id: 'me', user2Id: 'peer', participant: { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null },
  lastMessage: null, encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
});
const page = (rows: Conversation[], nextCursor?: string) => ({ data: { data: rows, ...(nextCursor ? { nextCursor } : {}) } });

let account: string | null;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.apiGet.mockReset();
  h.noteConversationListApplied.mockReset();
  h.heldWhenNoted = [];
  account = 'me';
  registerE2ESessionUser(() => account);
  useDMStore.setState({
    conversations: [], isLoading: false, isLoadingMore: false, loadMoreFailed: false, listNextCursor: null,
    participantStatuses: {}, activeConversationId: null, readOnlyPurges: {}, readOnlyPending: {}, readOnlyConfirmed: {},
    removedAt: {}, removalSeq: 0, openedAt: {}, openSeq: 0,
  });
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  registerE2ESessionUser(null);
  errors.mockRestore();
});

describe('the conversation list starts the cache sweep', () => {
  it('a first page applied tells the sweep, for the account that asked, once the store holds it', async () => {
    h.apiGet.mockResolvedValueOnce(page([conv('c1'), conv('c2')], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    await vi.dynamicImportSettled();
    expect(h.noteConversationListApplied.mock.calls).toEqual([['me']]);
    expect(h.heldWhenNoted).toEqual([['c1', 'c2']]);
  });

  it('a later page tells it nothing', async () => {
    h.apiGet.mockResolvedValueOnce(page([conv('c1')], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    await vi.dynamicImportSettled();
    h.apiGet.mockResolvedValueOnce(page([conv('c2')]));
    await useDMStore.getState().loadMoreConversations();
    await vi.dynamicImportSettled();
    expect(h.noteConversationListApplied).toHaveBeenCalledTimes(1);
  });

  it('a first page that failed tells it nothing', async () => {
    h.apiGet.mockRejectedValueOnce(new Error('offline'));
    await useDMStore.getState().fetchConversations();
    await vi.dynamicImportSettled();
    expect(h.noteConversationListApplied).not.toHaveBeenCalled();
  });

  it('an answer for an account that signed out meanwhile tells it nothing', async () => {
    let answer!: (value: unknown) => void;
    h.apiGet.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const fetching = useDMStore.getState().fetchConversations();
    account = 'someone-else';
    answer(page([conv('c1')]));
    await fetching;
    await vi.dynamicImportSettled();
    expect(h.noteConversationListApplied).not.toHaveBeenCalled();
  });
});
