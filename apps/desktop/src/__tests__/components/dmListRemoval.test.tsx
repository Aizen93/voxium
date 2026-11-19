import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Conversation } from '@voxium/shared';

/**
 * The conversation list's X sends the confirmed removal (the store's
 * removeConversation: `DELETE /dm/:id?clearHistory=true`), and a refused one
 * leaves the row where it was. Its confirmation dialog comes in front of this
 * call later; what the call does is the store's (dmStoreClearedHistory.test.ts).
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  chat: { clearMessages: vi.fn(), messages: [], deleteMessage: vi.fn() },
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: h.apiDelete } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => h.chat } }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => ({ dmCallConversationId: null, handleDMCallEnded: vi.fn() }) } }));
vi.mock('../../components/voice/DMVoicePanel', () => ({ DMVoicePanel: () => null }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock('../../stores/friendStore', () => {
  const state = () => ({ showFriendsView: false, pendingIncoming: [], setShowFriendsView: vi.fn() });
  const useFriendStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useFriendStore.getState = state;
  return { useFriendStore };
});
vi.mock('../../stores/supportStore', () => ({ useSupportStore: { getState: () => ({ setShowSupportView: vi.fn(), ticket: null }) } }));

import { DMList } from '../../components/dm/DMList';
import { useDMStore } from '../../stores/dmStore';

const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null } as Conversation['participant'];
const conv = (id: string): Conversation => ({
  id, user1Id: 'me', user2Id: ALICE.id, participant: ALICE, lastMessage: null,
  encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
});

let container: HTMLDivElement;
let root: Root;
async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DMList />));
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}
const removeButton = () => container.querySelector('button[aria-label="common.delete"]') as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  h.apiGet.mockImplementation(async () => ({ data: { data: [conv('c-1')] } }));
  useDMStore.setState({ conversations: [conv('c-1')], activeConversationId: null, participantStatuses: {}, dmUnreadCounts: {}, isLoading: false });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DMList: the X of a conversation', () => {
  it('removes it through the confirmed removal (clearHistory=true), and the row goes', async () => {
    h.apiDelete.mockResolvedValue({ data: { success: true, message: 'Conversation deleted' } });
    await render();

    await act(async () => { removeButton().click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });

    expect(h.apiDelete).toHaveBeenCalledWith('/dm/c-1', { params: { clearHistory: true } });
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
  });

  it('a refused removal leaves the row, and the rejection is handled (logged, never unhandled)', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.apiDelete.mockRejectedValue(new Error('Request failed with status code 500'));
    await render();

    await act(async () => { removeButton().click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });

    expect(container.querySelectorAll('[role="button"]').length).toBe(1);
    expect(warn).toHaveBeenCalledWith('[DM] The conversation was not removed:', 'Request failed with status code 500');
    errorLog.mockRestore();
    warn.mockRestore();
  });
});
