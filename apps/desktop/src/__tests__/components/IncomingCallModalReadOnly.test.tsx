import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Conversation } from '@voxium/shared';

/**
 * Accepting a ring of a conversation whose other side's account was deleted:
 * voiceStore.joinDMCall refuses the call, and the modal does not then open
 * the conversation as if a call were running. A live conversation's accept
 * still navigates to it.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const h = vi.hoisted(() => ({
  voice: {
    incomingCall: null as { conversationId: string; from: { id: string; displayName: string; avatarUrl: null } } | null,
    acceptCall: vi.fn(async () => {}),
    declineCall: vi.fn(),
  },
  serverSetState: vi.fn(),
  setShowFriendsView: vi.fn(),
}));
vi.mock('../../stores/voiceStore', () => {
  const useVoiceStore = <T,>(sel?: (s: typeof h.voice) => T) => (sel ? sel(h.voice) : h.voice);
  useVoiceStore.getState = () => h.voice;
  return { useVoiceStore };
});
vi.mock('../../stores/serverStore', () => ({ useServerStore: { setState: h.serverSetState, getState: () => ({}) } }));
vi.mock('../../stores/friendStore', () => ({ useFriendStore: { getState: () => ({ setShowFriendsView: h.setShowFriendsView }) } }));
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ enableNotificationSounds: false }) } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/notificationSounds', () => ({ startCallRingtone: vi.fn(), stopCallRingtone: vi.fn() }));
vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn(async () => ({ data: {} })), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ clearMessages: vi.fn() }) } }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => null }));

import { IncomingCallModal } from '../../components/dm/IncomingCallModal';
import { useDMStore } from '../../stores/dmStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id, user1Id: 'me', user2Id: 'u-alice', participant: { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null },
  lastMessage: null, encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function accept(conversationId: string) {
  h.voice.incomingCall = { conversationId, from: { id: 'u-alice', displayName: 'Alice', avatarUrl: null } };
  act(() => root.render(<IncomingCallModal />));
  const setActive = vi.spyOn(useDMStore.getState(), 'setActiveConversation');
  await act(async () => { (container.querySelector('button[aria-label="voice.accept"]') as HTMLButtonElement).click(); });
  return setActive;
}

describe('IncomingCallModal accept', () => {
  it('a read-only conversation: the refused call does not open the conversation', async () => {
    useDMStore.setState({
      conversations: [conv('c-ro', { participant: { id: 'deleted:c-ro', username: 'deleted', displayName: 'Deleted user', avatarUrl: null }, participantDeleted: true })],
    });
    const setActive = await accept('c-ro');
    expect(h.voice.acceptCall).toHaveBeenCalledTimes(1);
    expect(setActive).not.toHaveBeenCalled();
    expect(h.serverSetState).not.toHaveBeenCalled();
  });

  it('a live conversation still opens with its call', async () => {
    useDMStore.setState({ conversations: [conv('c-live')] });
    const setActive = await accept('c-live');
    expect(setActive).toHaveBeenCalledWith('c-live');
  });
});
