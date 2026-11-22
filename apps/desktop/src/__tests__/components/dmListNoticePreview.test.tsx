import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Conversation } from '@voxium/shared';

/**
 * The conversation list prints a listed call notice in the viewer's language
 * (display only, after dmPreviewText has decided what may print).
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (k: string) => k;
  return { ...actual, useTranslation: () => ({ t }) };
});

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  chat: { clearMessages: vi.fn(), messages: [], deleteMessage: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  voice: { dmCallConversationId: null as string | null, handleDMCallEnded: vi.fn() },
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: h.apiDelete } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast: h.toast }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => h.chat } }));
vi.mock('../../stores/voiceStore', () => {
  const useVoiceStore = <T,>(sel?: (s: typeof h.voice) => T) => (sel ? sel(h.voice) : h.voice);
  useVoiceStore.getState = () => h.voice;
  return { useVoiceStore };
});
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
async function renderWith(last: Conversation['lastMessage']) {
  const c = { ...conv('c-1'), lastMessage: last };
  h.apiGet.mockImplementation(async () => ({ data: { data: [c] } }));
  useDMStore.setState({ conversations: [c], activeConversationId: null, participantStatuses: {}, dmUnreadCounts: {}, isLoading: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DMList />));
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const base = { id: 'm1', senderId: ALICE.id, createdAt: '2026-01-01T00:00:00.000Z' } as unknown as NonNullable<Conversation['lastMessage']>;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DMList preview of a call notice', () => {
  it('maps the listed sentences to keys', async () => {
    await renderWith({ ...base, content: 'Voice call ended', encrypted: false, type: 'system' });
    expect(container.textContent).toContain('dm.callEnded');
    expect(container.textContent).not.toContain('Voice call ended');
  });

  // The hydrated preview the app holds for an encrypted row: the store blanks
  // the server's text on arrival, then writes the decrypted plaintext back
  // over the very same row (encrypted stays true).
  async function renderHydrated(last: NonNullable<Conversation['lastMessage']>) {
    await renderWith({ ...last, content: '' });
    await act(async () => {
      useDMStore.setState({ conversations: [{ ...conv('c-1'), lastMessage: last }] });
    });
  }

  it.each(['Voice call ended', 'Voice call started'])(
    'shows an encrypted message reading "%s" as written, never as the notice',
    async (words) => {
      await renderHydrated({ ...base, content: words, encrypted: true, type: 'user' });
      expect(container.textContent).toContain(words);
      expect(container.textContent).not.toContain('dm.call');
    },
  );

  it('keeps the lock for an unencrypted user row with those words (dmPreviewText prints nothing)', async () => {
    await renderWith({ ...base, content: 'Voice call started', encrypted: false, type: 'user' });
    expect(container.textContent).toContain('e2e.encryptedMessage');
    expect(container.textContent).not.toContain('dm.callStarted');
    expect(container.textContent).not.toContain('Voice call started');
  });

  it('maps a listed sentence on a row with no type (a 2.0 server sends none; dmPreviewText prints it by its text)', async () => {
    await renderWith({ ...base, content: 'Voice call started', encrypted: false });
    expect(container.textContent).toContain('dm.callStarted');
  });
});
