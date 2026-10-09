import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Reported from the running app, on both the Tauri client and the browser:
 * hide the window, come back, and a red "Failed to load conversations" appears
 * over a conversation list that is sitting right there, fully loaded.
 *
 * Two independent faults produced that. The list really had loaded — what
 * failed was hydrating the encrypted previews from the local vault, because a
 * backgrounded page can have its IndexedDB connection closed by the browser.
 * The hydration ran inside the same try as the fetch, so a local cache problem
 * was reported as a network one.
 */

// hoisted: vi.mock factories are lifted above module-level consts, so the fns
// they close over have to be created in the hoisted scope too.
const { apiGet, toastError, resolveEncryptedPreview } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  toastError: vi.fn(),
  resolveEncryptedPreview: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview }));
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ clearMessages: vi.fn() }) },
}));

import { useDMStore } from '../../stores/dmStore';

const CONV = {
  id: 'c1',
  participant: { id: 'peer', username: 'peer', displayName: 'Peer', status: 'online' },
  lastMessage: { id: 'm1', content: 'ciphertext', encrypted: true },
};

beforeEach(() => {
  apiGet.mockReset();
  toastError.mockReset();
  resolveEncryptedPreview.mockReset();
  useDMStore.setState({ conversations: [], isLoading: false, participantStatuses: {} });
});

describe('fetchConversations — what the error actually claims', () => {
  it('does not claim the list failed when only a preview did', async () => {
    // The exact shape of the reported bug: IndexedDB is gone after the window
    // was hidden, so the cache read throws. The conversations themselves are
    // fine and already rendered — telling the user they failed to load is
    // simply false, and it is the only thing they see.
    apiGet.mockResolvedValue({ data: { data: [CONV] } });
    resolveEncryptedPreview.mockRejectedValue(
      new DOMException('The database connection is closing', 'InvalidStateError')
    );

    await useDMStore.getState().fetchConversations();

    expect(toastError).not.toHaveBeenCalled();
    expect(useDMStore.getState().conversations).toHaveLength(1);
    expect(useDMStore.getState().isLoading).toBe(false);
  });

  it('still reports a genuine fetch failure', async () => {
    // The toast must not be defanged — when the request really fails, say so.
    apiGet.mockRejectedValue(new Error('Network Error'));

    await useDMStore.getState().fetchConversations();

    expect(toastError).toHaveBeenCalledWith('Failed to load conversations');
    expect(useDMStore.getState().isLoading).toBe(false);
  });

  it('keeps hydrating the rest after one preview throws', async () => {
    // One unreadable entry costs a lock icon on that row, not every other row.
    const second = { ...CONV, id: 'c2', lastMessage: { id: 'm2', content: 'ct', encrypted: true } };
    apiGet.mockResolvedValue({ data: { data: [CONV, second] } });
    resolveEncryptedPreview
      .mockRejectedValueOnce(new Error('vault unavailable'))
      .mockResolvedValueOnce('the second one decrypted');

    await useDMStore.getState().fetchConversations();

    const convs = useDMStore.getState().conversations;
    expect(convs.find((c) => c.id === 'c2')?.lastMessage?.content).toBe('the second one decrypted');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('survives the preview module failing to load at all', async () => {
    apiGet.mockResolvedValue({ data: { data: [CONV] } });
    resolveEncryptedPreview.mockImplementation(() => {
      throw new Error('chunk load failed');
    });

    await useDMStore.getState().fetchConversations();

    expect(useDMStore.getState().conversations).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('leaves isLoading false on every path', async () => {
    apiGet.mockResolvedValue({ data: { data: [] } });
    await useDMStore.getState().fetchConversations();
    expect(useDMStore.getState().isLoading).toBe(false);
  });
});
