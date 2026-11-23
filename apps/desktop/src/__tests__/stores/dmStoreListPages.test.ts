import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation } from '@voxium/shared';

/**
 * The conversation list is paged (`GET /dm?limit=&cursor=`): the first page
 * replaces the head, later pages append, and the rules of a list answer
 * (tickets, the account guard, local opens, removals) hold per page.
 */

const { apiGet, apiPost, toastError, chat } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastError: vi.fn(),
  chat: { clearMessages: vi.fn(), messages: [], deleteMessage: vi.fn() },
}));

vi.mock('../../services/api', () => ({ api: { get: apiGet, post: apiPost, patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview: vi.fn().mockResolvedValue(null) }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => chat } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));

import { useDMStore } from '../../stores/dmStore';
import { registerE2ESessionUser } from '../../services/e2e/session';

const peer = (n: number) => ({ id: `p${n}`, username: `p${n}`, displayName: `P${n}`, avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null });
// The updatedAt the server served: c1 is the newest of c1..c6 (each next one a day older), and c7, c8, c9 are newer than them all
const served = (n: number) => new Date(Date.UTC(2026, 5, 1) + (n >= 7 ? n : -n) * 86_400_000).toISOString();
const NEWEST = new Date(Date.UTC(2026, 6, 1)).toISOString();
const conv = (n: number, over: Record<string, unknown> = {}): Conversation => ({
  id: `c${n}`, user1Id: 'me', user2Id: `p${n}`, participant: peer(n) as Conversation['participant'], lastMessage: null,
  encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: served(n), ...over,
} as Conversation);
/** A row with an explicit id and time, for the ties. */
const row = (id: string, updatedAt: string): Conversation => ({ ...conv(1), id, updatedAt } as Conversation);
const ids = () => useDMStore.getState().conversations.map((c) => c.id);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const page = (rows: Conversation[], nextCursor?: string) => ({ data: { data: rows, ...(nextCursor ? { nextCursor } : {}) } });

let account: string | null;
beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  toastError.mockReset();
  account = 'me';
  registerE2ESessionUser(() => account);
  useDMStore.setState({
    conversations: [], isLoading: false, isLoadingMore: false, loadMoreFailed: false, listNextCursor: null,
    participantStatuses: {}, activeConversationId: null, readOnlyPurges: {}, readOnlyPending: {}, readOnlyConfirmed: {},
    removedAt: {}, removalSeq: 0, openedAt: {}, openSeq: 0,
  });
});
afterEach(() => registerE2ESessionUser(null));

describe('the list is paged', () => {
  it('the first page asks for a limit and no cursor, and keeps the cursor of the next', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    expect(apiGet).toHaveBeenCalledWith('/dm', { params: { limit: 50 } });
    expect(ids()).toEqual(['c1', 'c2']);
    expect(useDMStore.getState().listNextCursor).toBe('cur-1');
  });

  it('later pages are appended in order, with the cursor of each, and no row twice', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(3), conv(2), conv(4)], 'cur-2'));
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenLastCalledWith('/dm', { params: { limit: 50, cursor: 'cur-1' } });
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    apiGet.mockResolvedValueOnce(page([conv(5)]));
    await useDMStore.getState().loadMoreConversations();
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(useDMStore.getState().listNextCursor).toBeNull();
    // the end is reached: nothing more is asked
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it('a later page never replaces a row the store holds with an older copy (a message moved it meanwhile)', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const loading = useDMStore.getState().loadMoreConversations();
    // c3 (not loaded yet) is brought in by a new message, as MainLayout does, and gets a newer preview
    useDMStore.getState().addConversation(conv(3, { lastMessage: { id: 'new', content: '', encrypted: false, type: 'system', createdAt: '2026-11-22T10:00:00.000Z', authorId: 'p3' } }));
    request.resolve(page([conv(3), conv(4)]));
    await loading;
    expect(ids().sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(useDMStore.getState().conversations.find((c) => c.id === 'c3')?.lastMessage?.id).toBe('new');
  });

  it('a conversation removed between two page requests is not brought back by the later page', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const loading = useDMStore.getState().loadMoreConversations();
    useDMStore.getState().applyConversationRemoval('c3', undefined, 'test');
    request.resolve(page([conv(3), conv(4)]));
    await loading;
    expect(ids()).toEqual(['c1', 'c2', 'c4']);
  });

  it('an answer for another account applies nothing, and does not leave the new account loading', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const loading = useDMStore.getState().loadMoreConversations();
    account = 'someone-else';
    request.resolve(page([conv(2)]));
    await loading;
    expect(ids()).toEqual(['c1']);
    expect(useDMStore.getState().isLoadingMore).toBe(false);
  });

  it('only one later page is in flight at a time', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const first = useDMStore.getState().loadMoreConversations();
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(useDMStore.getState().isLoadingMore).toBe(true);
    request.resolve(page([conv(2)]));
    await first;
    expect(useDMStore.getState().isLoadingMore).toBe(false);
  });

  it('a failed later page keeps the rows and the cursor, flags the failure with no toast, and a retry loads it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiGet.mockResolvedValueOnce(page([conv(1)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockRejectedValueOnce(new Error('network'));
    await useDMStore.getState().loadMoreConversations();
    expect(useDMStore.getState()).toMatchObject({ isLoadingMore: false, loadMoreFailed: true, listNextCursor: 'cur-1' });
    expect(ids()).toEqual(['c1']);
    expect(toastError).not.toHaveBeenCalled();
    apiGet.mockResolvedValueOnce(page([conv(2)]));
    await useDMStore.getState().loadMoreConversations();
    expect(useDMStore.getState().loadMoreFailed).toBe(false);
    expect(ids()).toEqual(['c1', 'c2']);
    error.mockRestore();
  });

  it('a server from before the paged list answers the whole list and no cursor: the end, no later page', async () => {
    apiGet.mockResolvedValueOnce(page(Array.from({ length: 120 }, (_, i) => conv(i))));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toHaveLength(120);
    expect(useDMStore.getState().listNextCursor).toBeNull();
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe('a later page the server refuses or that fails', () => {
  const invalidCursor = () => Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { success: false, error: 'Invalid cursor' } },
  });

  it('400 Invalid cursor starts over from the first page: later rows and cursor dropped, no failure state, no toast', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(3)], 'cur-2'));
    await useDMStore.getState().loadMoreConversations();
    apiGet.mockRejectedValueOnce(invalidCursor());
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-new'));
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenCalledTimes(4);
    expect(apiGet).toHaveBeenLastCalledWith('/dm', { params: { limit: 50 } });
    expect(ids()).toEqual(['c1', 'c2']);
    expect(useDMStore.getState()).toMatchObject({ listNextCursor: 'cur-new', loadMoreFailed: false, isLoadingMore: false });
    expect(toastError).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('any other 400 keeps the failure state, the rows and the cursor', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiGet.mockResolvedValueOnce(page([conv(1)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockRejectedValueOnce(Object.assign(new Error('bad'), { response: { status: 400, data: { error: 'limit must be a whole number of 1 or more' } } }));
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(useDMStore.getState()).toMatchObject({ loadMoreFailed: true, listNextCursor: 'cur-1' });
    error.mockRestore();
  });

  it('a failure that lands after another account signed in sets no failure state for it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiGet.mockResolvedValueOnce(page([conv(1)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    const request = deferred<never>();
    apiGet.mockReturnValueOnce(request.promise);
    const loading = useDMStore.getState().loadMoreConversations();
    account = 'someone-else';
    request.reject(new Error('network'));
    await loading;
    expect(useDMStore.getState().loadMoreFailed).toBe(false);
    expect(useDMStore.getState().isLoadingMore).toBe(false);
    error.mockRestore();
  });
});

describe('fetchConversationsFor', () => {
  it('asks once when the first answer holds the conversation', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1)]));
    await useDMStore.getState().fetchConversationsFor('c1');
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('asks one more time, and only one, when the conversation is still missing', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1)]));
    apiGet.mockResolvedValueOnce(page([conv(7), conv(1)]));
    await useDMStore.getState().fetchConversationsFor('c7');
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(['c7', 'c1']);
    apiGet.mockResolvedValue(page([conv(1)]));
    await useDMStore.getState().fetchConversationsFor('c-gone');
    expect(apiGet).toHaveBeenCalledTimes(4);
  });
});

describe('a first-page refetch: the answer is the list down to its last row', () => {
  it('a held row the answer does not name, inside its range, is dropped (hidden or deleted elsewhere); the rows beyond stay', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2), conv(3)], 'A'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(4)], 'B'));
    await useDMStore.getState().loadMoreConversations();
    // c2 is gone from the account's list: the answer's range covers it and it is not there
    apiGet.mockResolvedValueOnce(page([conv(1), conv(3)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
    expect(useDMStore.getState().listNextCursor).toBe('B');
  });

  it('a held row beyond the answer\'s last row is kept', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2), conv(3)], 'A'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(9), conv(1), conv(2)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c9', 'c1', 'c2', 'c3']);
  });

  it('equal times: the id decides, the smaller one lies beyond (kept), the larger one lies inside (dropped)', async () => {
    const T = served(2);
    apiGet.mockResolvedValueOnce(page([row('c', T), row('b', T)], 'A'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([row('a', T)], 'B'));
    await useDMStore.getState().loadMoreConversations();
    expect(ids()).toEqual(['c', 'b', 'a']);
    apiGet.mockResolvedValueOnce(page([row('b', T)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['b', 'a']);
  });

  it('a held row that got a socket message after the request began is kept: its served time is still beyond the range', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'A'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(3), conv(4)], 'B'));
    await useDMStore.getState().loadMoreConversations();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const refetch = useDMStore.getState().fetchConversations();
    useDMStore.getState().updateLastMessage('c4', { id: 'm-new', content: '', encrypted: false, type: 'system', createdAt: '2026-11-22T10:00:00.000Z', authorId: 'p4' });
    request.resolve(page([conv(1), conv(2)], 'C'));
    await refetch;
    expect(ids().sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(useDMStore.getState().conversations.find((c) => c.id === 'c4')?.lastMessage?.id).toBe('m-new');
  });

  it('a held row with no served time cannot be placed: it is kept, after the answer\'s rows', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'A'));
    await useDMStore.getState().fetchConversations();
    useDMStore.getState().addConversation(conv(8, { updatedAt: undefined }));
    // opened before this request began: only a list may keep or drop it now
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c1', 'c2', 'c8']);
  });

  it('openDM of a conversation beyond the first page: a refetch with a cursor held keeps it once, after the answer\'s rows, still the active one', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'A'));
    await useDMStore.getState().fetchConversations();
    // POST /dm answers the row with its own updatedAt: an old conversation (ranks beyond c2)
    apiPost.mockResolvedValueOnce({ data: { data: conv(5, { lastMessage: null }) } });
    apiPost.mockResolvedValue({ data: {} }); // the mark-as-read request of the active conversation
    await useDMStore.getState().openDM('p5');
    useDMStore.getState().setActiveConversation('c5');
    apiGet.mockResolvedValueOnce(page([conv(9), conv(1), conv(2)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c9', 'c1', 'c2', 'c5']);
    expect(useDMStore.getState().activeConversationId).toBe('c5');
  });

  it('openDM of a conversation the next answer names: it appears once, at the answer\'s place', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'A'));
    await useDMStore.getState().fetchConversations();
    apiPost.mockResolvedValueOnce({ data: { data: conv(3) } });
    await useDMStore.getState().openDM('p3');
    apiGet.mockResolvedValueOnce(page([conv(1), conv(3), conv(2)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c1', 'c3', 'c2']);
  });

  it('an opened conversation inside the range that the answer does not name is gone and dropped', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(3)], 'A'));
    await useDMStore.getState().fetchConversations();
    apiPost.mockResolvedValueOnce({ data: { data: conv(2) } });
    await useDMStore.getState().openDM('p2');
    apiGet.mockResolvedValueOnce(page([conv(1), conv(3)], 'C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c1', 'c3']);
  });
});

describe('a first-page refetch with later pages loaded', () => {
  async function loadTwoPages() {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(3), conv(4)], 'cur-2'));
    await useDMStore.getState().loadMoreConversations();
  }

  it('replaces the head, keeps the rows of the later pages it does not name, and leaves the cursor where they end', async () => {
    await loadTwoPages();
    apiGet.mockResolvedValueOnce(page([conv(9), conv(1)], 'cur-9'));
    await useDMStore.getState().fetchConversations();
    // c2 is the old first page's row the new first page no longer names: kept too
    expect(ids()).toEqual(['c9', 'c1', 'c2', 'c3', 'c4']);
    expect(useDMStore.getState().listNextCursor).toBe('cur-2');
    // the next page continues after the loaded rows
    apiGet.mockResolvedValueOnce(page([conv(5)]));
    await useDMStore.getState().loadMoreConversations();
    expect(apiGet).toHaveBeenLastCalledWith('/dm', { params: { limit: 50, cursor: 'cur-2' } });
    expect(ids()).toEqual(['c9', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('a row of the old first page pushed past the new first page is kept, and so is every later row (nothing is lost)', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2), conv(3)], 'cur-A'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(4), conv(5)], 'cur-B'));
    await useDMStore.getState().loadMoreConversations();
    apiGet.mockResolvedValueOnce(page([conv(9), conv(1), conv(2)], 'cur-C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c9', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(useDMStore.getState().listNextCursor).toBe('cur-B');
  });

  it('a conversation that moved up from a later page pushes a first-page row off: the pushed row stays, the mover is not doubled', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-A'));
    await useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(3), conv(4)], 'cur-B'));
    await useDMStore.getState().loadMoreConversations();
    apiGet.mockResolvedValueOnce(page([conv(4, { updatedAt: NEWEST }), conv(1)], 'cur-C'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c4', 'c1', 'c2', 'c3']);
  });

  it('a held row the answer does not name that was removed meanwhile is not kept', async () => {
    await loadTwoPages();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const refetch = useDMStore.getState().fetchConversations();
    useDMStore.getState().applyConversationRemoval('c2', undefined, 'test');
    request.resolve(page([conv(1)], 'cur-x'));
    await refetch;
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
  });

  it('a row of a later page that the first page now names stands as the first page serves it', async () => {
    await loadTwoPages();
    apiGet.mockResolvedValueOnce(page([conv(3, { lastMessage: { id: 'm', content: '', encrypted: false, type: 'system', createdAt: '2026-11-22T10:00:00.000Z', authorId: 'p3' } }), conv(1)], 'cur-9'));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c3', 'c1', 'c2', 'c4']);
  });

  it('an answer that is the whole list (no cursor) drops the later rows and the cursor', async () => {
    await loadTwoPages();
    apiGet.mockResolvedValueOnce(page([conv(1)]));
    await useDMStore.getState().fetchConversations();
    expect(ids()).toEqual(['c1']);
    expect(useDMStore.getState().listNextCursor).toBeNull();
  });

  it('an older first-page answer landing after a newer one applies nothing', async () => {
    const older = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(older.promise);
    const slow = useDMStore.getState().fetchConversations();
    apiGet.mockResolvedValueOnce(page([conv(7)]));
    await useDMStore.getState().fetchConversations();
    older.resolve(page([conv(1)], 'stale'));
    await slow;
    expect(ids()).toEqual(['c7']);
    expect(useDMStore.getState().listNextCursor).toBeNull();
  });

  it('a later page that began before a first page applied is dropped, and the next request asks again', async () => {
    apiGet.mockResolvedValueOnce(page([conv(1)], 'cur-1'));
    await useDMStore.getState().fetchConversations();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const loading = useDMStore.getState().loadMoreConversations();
    apiGet.mockResolvedValueOnce(page([conv(1), conv(2)], 'cur-1b'));
    await useDMStore.getState().fetchConversations();
    request.resolve(page([conv(3)]));
    await loading;
    expect(ids()).toEqual(['c1', 'c2']);
    expect(useDMStore.getState()).toMatchObject({ isLoadingMore: false, listNextCursor: 'cur-1b' });
  });

  it('a conversation opened locally while a first page was in flight is kept, as before', async () => {
    await loadTwoPages();
    const request = deferred<ReturnType<typeof page>>();
    apiGet.mockReturnValueOnce(request.promise);
    const refetch = useDMStore.getState().fetchConversations();
    useDMStore.getState().addConversation(conv(8));
    request.resolve(page([conv(1)], 'cur-x'));
    await refetch;
    expect(ids()).toEqual(['c8', 'c1', 'c2', 'c3', 'c4']);
  });
});
