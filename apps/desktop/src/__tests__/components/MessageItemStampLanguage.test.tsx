import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, MessageAuthor } from '@voxium/shared';

// A message row is memoised: it re-renders on a language change only because
// it calls useTranslation() itself. This renders the real row with real i18n,
// switches the language while it is mounted and reads the stamp from the DOM.

const chat = vi.hoisted(() => ({
  editMessage: vi.fn(),
  editDMMessage: vi.fn(),
  setReplyingTo: vi.fn(),
  toggleReaction: vi.fn(),
  toggleDMReaction: vi.fn(),
}));
vi.mock('../../stores/chatStore', () => {
  const useChatStore = <T,>(sel?: (s: typeof chat) => T) => (sel ? sel(chat) : chat);
  useChatStore.getState = () => chat;
  return { useChatStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
const serverState = vi.hoisted(() => ({ members: [] as unknown[], channels: [{ id: 'ch-plain', name: 'general', type: 'text', secure: false }] }));
vi.mock('../../stores/serverStore', () => {
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) => (sel ? sel(serverState) : serverState);
  useServerStore.getState = () => serverState;
  return { useServerStore };
});
const { useMemberMock } = vi.hoisted(() => ({ useMemberMock: vi.fn((userId: string | undefined): undefined => { void userId; return undefined; }) }));
vi.mock('../../hooks/useMember', () => ({ useMember: useMemberMock }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn() } }));
vi.mock('../../components/common/EmojiPicker', () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (e: string) => void }) => (
    <button data-testid="emoji-picker" onClick={() => onEmojiSelect('👍')} />
  ),
}));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children, userId }: { children: React.ReactNode; userId: string }) => (
    <span data-testid="hover-target" data-user-id={userId}>{children}</span>
  ),
}));
vi.mock('../../components/common/StaffBadge', () => ({ StaffBadge: () => <span data-testid="staff-badge" /> }));
vi.mock('../../components/common/SupporterBadge', () => ({ SupporterBadge: () => <span data-testid="supporter-badge" /> }));
vi.mock('../../components/chat/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <span>{content}</span> }));
vi.mock('../../components/chat/AttachmentDisplay', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../components/chat/E2EAttachmentDisplay', () => ({ E2EAttachmentDisplay: () => null }));
vi.mock('../../components/chat/DeleteConfirmModal', () => ({ DeleteConfirmModal: () => null }));
vi.mock('../../components/chat/ReportModal', () => ({ ReportModal: () => <div data-testid="report-modal" /> }));

import i18n from '../../i18n';
import { MessageItem } from '../../components/chat/MessageItem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: MessageAuthor = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null };
const WHEN = '2025-03-09T14:05:00';
const STAMP = { dateStyle: 'medium', timeStyle: 'short' } as const;
const at = (language: string) => new Intl.DateTimeFormat(language, STAMP).format(new Date(WHEN));

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await i18n.changeLanguage('en');
});

describe('the stamp of a memoised message row follows the language', () => {
  it('changes in place, read from the DOM, when the language changes', async () => {
    await i18n.changeLanguage('en');
    const message: Message = {
      id: 'm-1', content: 'hello', type: 'user', encrypted: false, channelId: 'ch-plain', conversationId: null,
      author: ME, mentions: [], createdAt: WHEN, editedAt: null, reactions: [],
    } as unknown as Message;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<MessageItem message={message} showHeader addTopMargin={false} isOwn={false} canDelete={false} channelId="ch-plain" />);
    });
    const stamp = () => container.querySelector('span.font-mono')?.textContent;
    expect(stamp()).toBe(at('en'));
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    expect(stamp()).toBe(at('fr'));
    await act(async () => {
      await i18n.changeLanguage('ja');
    });
    expect(stamp()).toBe(at('ja'));
    expect(at('fr')).not.toBe(at('en'));
  });
});
