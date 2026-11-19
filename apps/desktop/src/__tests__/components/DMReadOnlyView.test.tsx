import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DELETED_MESSAGE_TYPE } from '@voxium/shared';
import type { Conversation } from '@voxium/shared';

/**
 * The DM view of a conversation whose other side's account was deleted: the
 * localised "Deleted user" (never the server's display name), a neutral
 * avatar, no presence, no badge, no profile card, no safety number, no call
 * button, and in place of the composer a notice saying why. The list row and
 * the composer follow the same rule wherever they are rendered.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const h = vi.hoisted(() => ({
  apiGet: vi.fn(async (url: string): Promise<{ data: { data: unknown } }> => { void url; return { data: { data: [] } }; }),
  apiPost: vi.fn(),
  emit: vi.fn(),
  joinDMCall: vi.fn(),
  toastError: vi.fn(),
  chat: {
    fetchDMMessages: vi.fn(async () => {}),
    clearMessages: vi.fn(),
    sendMessage: vi.fn(),
    sendDMMessage: vi.fn(),
    replyingTo: null,
    clearReplyingTo: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: h.apiPost, patch: vi.fn(), delete: vi.fn() } }));
// the list fetch's read-only side (purge, view) is services/dmReadOnly's own test
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));
vi.mock('../../services/socket', () => ({ getSocket: () => ({ emit: h.emit, on: vi.fn(), off: vi.fn(), connected: false }), onConnectionStatusChange: () => () => {} }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: h.toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../stores/chatStore', () => {
  const useChatStore = <T,>(sel?: (s: typeof h.chat) => T) => (sel ? sel(h.chat) : h.chat);
  useChatStore.getState = () => h.chat;
  return { useChatStore };
});
vi.mock('../../stores/voiceStore', () => {
  const state = () => ({ dmCallConversationId: null, joinDMCall: h.joinDMCall, leaveDMCall: vi.fn() });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useVoiceStore.getState = state;
  return { useVoiceStore };
});
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ channels: [], activeServerId: null });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../hooks/useServerPermissions', () => ({ useServerPermissions: () => null }));
vi.mock('../../components/dm/DMMessageList', () => ({
  DMMessageList: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="message-list" data-read-only={String(!!readOnly)} />,
}));
vi.mock('../../components/dm/DMCallPanel', () => ({ DMCallPanel: () => <div data-testid="call-panel" /> }));
vi.mock('../../components/dm/E2EControls', () => ({ E2EControls: () => <div data-testid="e2e-controls" /> }));
vi.mock('../../components/search/SearchModal', () => ({ SearchModal: () => null }));
vi.mock('../../components/search/SearchField', () => ({ SearchField: () => <div data-testid="search-field" /> }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children, userId }: { children: React.ReactNode; userId: string }) => (
    <span data-testid="hover-target" data-user-id={userId}>{children}</span>
  ),
}));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock('../../components/common/StaffBadge', () => ({ StaffBadge: () => <span data-testid="staff-badge" /> }));
vi.mock('../../components/common/SupporterBadge', () => ({ SupporterBadge: () => <span data-testid="supporter-badge" /> }));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('../../components/voice/DMVoicePanel', () => ({ DMVoicePanel: () => null }));
vi.mock('../../stores/friendStore', () => {
  const state = () => ({ showFriendsView: false, pendingIncoming: [], setShowFriendsView: vi.fn() });
  const useFriendStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useFriendStore.getState = state;
  return { useFriendStore };
});
vi.mock('../../stores/supportStore', () => ({ useSupportStore: { getState: () => ({ setShowSupportView: vi.fn(), ticket: null }) } }));

import { DMChatArea } from '../../components/dm/DMChatArea';
import { DMList } from '../../components/dm/DMList';
import { MessageInput } from '../../components/chat/MessageInput';
import { useDMStore } from '../../stores/dmStore';
import { DMConversationReadOnlyError } from '../../utils/dmParticipant';

const PLACEHOLDER = { id: 'deleted:c-ro', username: 'deleted', displayName: 'Deleted user', avatarUrl: 'avatars/served.webp', role: 'admin', isSupporter: true, supporterTier: 'top', status: 'online' } as Conversation['participant'];
const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null, role: 'admin', isSupporter: true, supporterTier: 'top' } as Conversation['participant'];

const conv = (id: string, participant: Conversation['participant'], over: Partial<Conversation> = {}): Conversation => ({
  id, user1Id: 'me', user2Id: participant.id, participant, lastMessage: null,
  encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});
const readOnly = (over: Partial<Conversation> = {}) => conv('c-ro', PLACEHOLDER, { user2Id: null, participantDeleted: true, ...over });

let container: HTMLDivElement;
let root: Root;
async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(node));
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}
const q = (sel: string) => container.querySelector(sel);

beforeEach(() => {
  vi.clearAllMocks();
  h.apiGet.mockImplementation(async () => ({ data: { data: [] } }));
  h.apiPost.mockImplementation(async () => ({ data: {} }));
  useDMStore.setState({ conversations: [readOnly(), conv('c-live', ALICE)], activeConversationId: 'c-ro', participantStatuses: { 'deleted:c-ro': 'online' }, dmUnreadCounts: {}, isLoading: false });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DMChatArea of a read-only conversation', () => {
  it('the header: the localised name and a neutral avatar; no profile card, presence, safety number or call button', async () => {
    await render(<DMChatArea />);
    expect(q('[data-testid="dm-header-name"]')?.textContent).toBe('dm.deletedParticipant.name');
    expect(q('[data-testid="deleted-user-avatar"]')).not.toBeNull();
    expect(q('[data-testid="hover-target"]')).toBeNull();
    expect(q('[data-testid="avatar"]')).toBeNull();
    expect(container.innerHTML).not.toContain('bg-vox-accent-success');
    expect(q('[data-testid="e2e-controls"]')).toBeNull();
    expect(q('button[aria-label="dm.startCall"]')).toBeNull();
    expect(q('button[aria-label="dm.endCall"]')).toBeNull();
    expect(q('[data-testid="call-panel"]')).toBeNull();
    expect(container.textContent).not.toContain('Deleted user');
    // search of one's own messages stays
    expect(q('[data-testid="search-field"]')).not.toBeNull();
  });

  it('the composer is replaced by the read-only notice (role=status): no textarea, no attach, no send', async () => {
    await render(<DMChatArea />);
    const notice = q('[data-testid="dm-read-only-notice"]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toBe('dm.deletedParticipant.readOnlyNotice');
    expect(q('textarea')).toBeNull();
    expect(q('button[aria-label="messageInput.attachFile"]')).toBeNull();
    expect(q('button[aria-label="messageInput.sendMessage"]')).toBeNull();
    expect(q('[data-testid="message-list"]')?.getAttribute('data-read-only')).toBe('true');
  });

  it('the placeholder id is never sent: no /users/ request for it', async () => {
    await render(<DMChatArea />);
    for (const [url] of h.apiGet.mock.calls as unknown as Array<[string]>) expect(url).not.toContain('deleted:');
  });

  it('a live conversation keeps the full header, the call button and the composer', async () => {
    useDMStore.setState({ activeConversationId: 'c-live' });
    await render(<DMChatArea />);
    expect(q('[data-testid="dm-header-name"]')?.textContent).toBe('Alice');
    expect(q('[data-testid="hover-target"]')).not.toBeNull();
    expect(q('[data-testid="e2e-controls"]')).not.toBeNull();
    expect(q('button[aria-label="dm.startCall"]')).not.toBeNull();
    expect(q('textarea')).not.toBeNull();
    expect(q('[data-testid="dm-read-only-notice"]')).toBeNull();
  });
});

describe('a conversation on screen turning read-only (the event\'s local flip)', () => {
  it('the encryption controls (and the safety-number dialog they hold), the profile card, the call button and the composer go at once', async () => {
    useDMStore.setState({ activeConversationId: 'c-live' });
    await render(<DMChatArea />);
    expect(q('[data-testid="e2e-controls"]')).not.toBeNull();
    expect(q('textarea')).not.toBeNull();

    await act(async () => { useDMStore.getState().markParticipantDeleted('c-live', 'me'); });

    expect(q('[data-testid="e2e-controls"]')).toBeNull();
    expect(q('[data-testid="hover-target"]')).toBeNull();
    expect(q('button[aria-label="dm.startCall"]')).toBeNull();
    expect(q('textarea')).toBeNull();
    expect(q('[data-testid="dm-read-only-notice"]')).not.toBeNull();
    expect(q('[data-testid="dm-header-name"]')?.textContent).toBe('dm.deletedParticipant.name');
  });
});

describe('MessageInput rendered for a read-only conversation anyway', () => {
  it('renders the notice alone: nothing to type in, attach, paste or drop onto; nothing signalled or uploaded', async () => {
    await render(<MessageInput conversationId="c-ro" placeholderName="x" />);
    expect(q('[data-testid="dm-read-only-notice"]')).not.toBeNull();
    expect(q('textarea')).toBeNull();
    expect(q('input[type="file"]')).toBeNull();
    // a drop on what is there reaches no upload
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true }) as Event & { dataTransfer: unknown };
    drop.dataTransfer = { files: [file], types: ['Files'] };
    act(() => { container.firstElementChild!.dispatchEvent(drop); });
    expect(h.apiPost).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('a typing signal pending when the conversation turns read-only', () => {
  it('in the real DMChatArea, its "stop" never goes out: the composer stays mounted and drops it', async () => {
    useDMStore.setState({ activeConversationId: 'c-live' });
    vi.useFakeTimers();
    try {
      await render(<DMChatArea />);
      const textarea = q('textarea') as HTMLTextAreaElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'hel');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(h.emit).toHaveBeenCalledWith('dm:typing:start', 'c-live');

      act(() => { useDMStore.getState().markParticipantDeleted('c-live', 'me'); });
      act(() => { vi.advanceTimersByTime(3000); });

      expect(q('textarea')).toBeNull();
      expect(q('[data-testid="dm-read-only-notice"]')).not.toBeNull();
      expect(h.emit).not.toHaveBeenCalledWith('dm:typing:stop', 'c-live');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a send the store refuses', () => {
  it('shows the read-only sentence, as the server 403 will', async () => {
    useDMStore.setState({ activeConversationId: 'c-live' });
    h.chat.sendDMMessage.mockRejectedValueOnce(new DMConversationReadOnlyError('c-live'));
    await render(<DMChatArea />);
    const textarea = q('textarea') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'hello?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (q('button[aria-label="messageInput.sendMessage"]') as HTMLButtonElement).click(); });
    expect(h.toastError).toHaveBeenCalledWith('serverErrors.conversationReadOnly');
  });

  it('any other client error keeps the generic sentence (never its English message)', async () => {
    useDMStore.setState({ activeConversationId: 'c-live' });
    h.chat.sendDMMessage.mockRejectedValueOnce(new Error('Peer identity key changed'));
    await render(<DMChatArea />);
    const textarea = q('textarea') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'hello?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (q('button[aria-label="messageInput.sendMessage"]') as HTMLButtonElement).click(); });
    expect(h.toastError).toHaveBeenCalledWith('chat.failedToSend');
  });
});

describe('DMList row of a read-only conversation', () => {
  it('the localised name, a neutral avatar, no presence or badge; the remove button stays; the preview says "Message deleted"', async () => {
    const list = [
      readOnly({ lastMessage: { id: 'm-del', content: 'leaked', encrypted: false, type: DELETED_MESSAGE_TYPE, createdAt: '2026-11-01T10:00:00.000Z', authorId: 'deleted:c-ro' } }),
      conv('c-live', ALICE),
    ];
    // the list fetch on mount answers the same list (its preview text is dropped there too)
    h.apiGet.mockImplementation(async () => ({ data: { data: list } }));
    useDMStore.setState({ conversations: list });
    await render(<DMList />);
    const rows = [...container.querySelectorAll('[role="button"]')];
    const ro = rows[0];
    expect(ro.textContent).toContain('dm.deletedParticipant.name');
    expect(ro.textContent).toContain('dm.deletedParticipant.messageDeleted');
    expect(ro.textContent).not.toContain('Deleted user');
    expect(ro.textContent).not.toContain('leaked');
    expect(ro.querySelector('[data-testid="deleted-user-avatar"]')).not.toBeNull();
    expect(ro.querySelector('[data-testid="avatar"]')).toBeNull();
    expect(ro.querySelector('[data-testid="staff-badge"]')).toBeNull();
    expect(ro.querySelector('[data-testid="supporter-badge"]')).toBeNull();
    expect(ro.querySelector('button[aria-label="common.delete"]')).not.toBeNull();
    // the live one keeps its own
    const live = rows[1];
    expect(live.textContent).toContain('Alice');
    expect(live.querySelector('[data-testid="staff-badge"]')).not.toBeNull();
  });
});
