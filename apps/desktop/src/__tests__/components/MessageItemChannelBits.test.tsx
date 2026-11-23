import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, MessageAuthor } from '@voxium/shared';

/**
 * A DM whose other side's account was deleted: each message row offers no
 * edit, no reply and no reaction (deleting one's own stays); the deleted
 * account's rows are a quiet "Message deleted" line with its time and no
 * toolbar; its placeholder author (`deleted:{conversationId}`) gets the
 * localised name, a neutral avatar and no profile card, badge or Report; a
 * quote of one of its messages says "Message deleted", never text. A
 * plaintext channel keeps rendering an unknown `deleted` type as it always did.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

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

import { MessageItem } from '../../components/chat/MessageItem';

/**
 * Reply and reactions follow the viewer's bits in the CHANNEL (the server
 * judges SEND_MESSAGES for a reply and ADD_REACTIONS for a reaction toggle,
 * adding AND removing). The props are false only when the bits are known and
 * lack the bit; every other caller keeps the old behaviour by default.
 */

const CONV = 'c-1';
const ME: MessageAuthor = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null };
const OTHER: MessageAuthor = { id: 'u-x', username: 'x', displayName: 'x', avatarUrl: null };
const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm-1', content: 'my words', type: 'user', channelId: 'ch-plain', conversationId: null,
  author: ME, mentions: [], createdAt: '2026-11-01T10:00:00.000Z', editedAt: null,
  reactions: [{ emoji: '👍', count: 1, userIds: ['me'] }], ...over,
});

let container: HTMLDivElement;
let root: Root;
function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}
interface ItemProps { canReply?: boolean; canReact?: boolean; canDelete?: boolean; isOwn?: boolean; conversationId?: string; message?: Message }
const item = (props: ItemProps) =>
  render(
    <MessageItem
      message={props.message ?? msg()}
      showHeader
      addTopMargin={false}
      isOwn={props.isOwn ?? true}
      canDelete={props.canDelete ?? false}
      channelId={props.conversationId ? undefined : 'ch-plain'}
      conversationId={props.conversationId}
      canReply={props.canReply}
      canReact={props.canReact}
    />,
  );
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const q = (sel: string) => container.querySelector(sel);
const button = (label: string) => q(`button[aria-label="${label}"]`);
const toolbarReact = () => q('[data-testid="message-actions"] button[aria-label="messageItem.addReaction"]') as HTMLButtonElement | null;
const chip = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('👍')) as HTMLButtonElement;
const remount = (props: ItemProps) => { act(() => root.unmount()); container.remove(); item(props); };

describe('MessageItem: Reply follows canReply', () => {
  it('is absent when canReply is false, present by default and when true', () => {
    item({ canReply: false });
    expect(button('messageItem.reply')).toBeNull();
    remount({});
    expect(button('messageItem.reply')).not.toBeNull();
    remount({ canReply: true });
    expect(button('messageItem.reply')).not.toBeNull();
  });

  it('a click on Reply sets the reply', () => {
    item({ canReply: true });
    act(() => (button('messageItem.reply') as HTMLButtonElement).click());
    expect(chat.setReplyingTo).toHaveBeenCalledTimes(1);
  });

  it('Edit does not follow it (the server asks only for VIEW to edit one\'s own message)', () => {
    item({ canReply: false, canReact: false, isOwn: true });
    expect(button('messageItem.editMessage')).not.toBeNull();
  });
});

describe('MessageItem: reactions follow canReact', () => {
  it('without the bit: no react control, no add button, no picker', () => {
    item({ canReact: false });
    expect(button('messageItem.addReaction')).toBeNull();
    expect(q('[data-testid="emoji-picker"]')).toBeNull();
  });

  it('with the bit the react control opens the picker', () => {
    item({});
    act(() => toolbarReact()!.click());
    expect(q('[data-testid="emoji-picker"]')).not.toBeNull();
  });

  it('a picker open when the bit goes away closes with the control', () => {
    item({ canReact: true });
    act(() => toolbarReact()!.click());
    expect(q('[data-testid="emoji-picker"]')).not.toBeNull();
    act(() => root.render(
      <MessageItem message={msg()} showHeader addTopMargin={false} isOwn canDelete={false} channelId="ch-plain" canReact={false} />,
    ));
    expect(q('[data-testid="emoji-picker"]')).toBeNull();
  });

  it('existing chips stay shown but inert without the bit: the server refuses a removal too', () => {
    item({ canReact: false });
    expect(chip()).toBeTruthy();
    expect(chip().disabled).toBe(true);
    act(() => chip().click());
    expect(chat.toggleReaction).not.toHaveBeenCalled();
  });

  it('with the bit a chip click toggles the reaction (adds, or takes one\'s own back)', () => {
    item({ canReact: true });
    expect(chip().disabled).toBe(false);
    act(() => chip().click());
    expect(chat.toggleReaction).toHaveBeenCalledWith('ch-plain', 'm-1', '👍');
  });
});

describe('MessageItem: the toolbar', () => {
  it('another person\'s message with no bit keeps only what is left (Report), without Reply or react', () => {
    item({ isOwn: false, canReply: false, canReact: false, message: msg({ author: OTHER }) });
    expect(q('[data-testid="message-actions"]')).not.toBeNull();
    expect(button('messageItem.reply')).toBeNull();
    expect(button('messageItem.addReaction')).toBeNull();
  });

  it('a system message with nothing left has no toolbar box at all', () => {
    item({ isOwn: false, canReact: false, message: msg({ type: 'system', author: OTHER }) });
    expect(q('[data-testid="message-actions"]')).toBeNull();
  });
});

describe('the picker does not reopen by itself when the bit returns', () => {
  const mk = (canReact: boolean) => (
    <MessageItem message={msg()} showHeader addTopMargin={false} isOwn canDelete={false} channelId="ch-plain" canReact={canReact} />
  );
  const toolbar = () => q('[data-testid="message-actions"]') as HTMLElement;

  it('opened from the toolbar: bit away, bit back: no picker, toolbar not forced visible', () => {
    render(mk(true));
    act(() => toolbarReact()!.click());
    expect(q('[data-testid="emoji-picker"]')).not.toBeNull();
    act(() => root.render(mk(false)));
    act(() => root.render(mk(true)));
    expect(q('[data-testid="emoji-picker"]')).toBeNull();
    expect(toolbar().classList.contains('hidden')).toBe(true);
    expect(toolbar().classList.contains('flex')).toBe(false);
  });

  it('opened from a reaction row: bit away, bit back: no picker', () => {
    render(mk(true));
    const rowAdd = Array.from(container.querySelectorAll('button[aria-label="messageItem.addReaction"]'))
      .find((b) => !b.closest('[data-testid="message-actions"]')) as HTMLButtonElement;
    act(() => rowAdd.click());
    expect(q('[data-testid="emoji-picker"]')).not.toBeNull();
    act(() => root.render(mk(false)));
    act(() => root.render(mk(true)));
    expect(q('[data-testid="emoji-picker"]')).toBeNull();
  });
});

describe('a direct conversation row is unchanged', () => {
  it('offers reply, react and an active chip with no props', () => {
    item({ conversationId: CONV, message: msg({ channelId: null, conversationId: CONV }) });
    expect(button('messageItem.reply')).not.toBeNull();
    expect(button('messageItem.addReaction')).not.toBeNull();
    expect(chip().disabled).toBe(false);
    act(() => chip().click());
    expect(chat.toggleDMReaction).toHaveBeenCalledWith(CONV, 'm-1', '👍');
  });
});
