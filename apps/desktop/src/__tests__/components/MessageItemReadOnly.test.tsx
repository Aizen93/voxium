import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DELETED_MESSAGE_TYPE } from '@voxium/shared';
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
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => <div data-testid="emoji-picker" /> }));
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
import { ReactionDisplay } from '../../components/chat/ReactionDisplay';

const CONV = 'c-1';
const PLACEHOLDER: MessageAuthor = { id: `deleted:${CONV}`, username: 'deleted', displayName: 'Deleted user', avatarUrl: 'x.webp', role: 'admin', isSupporter: true, supporterTier: 'top' };
const ME: MessageAuthor = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null };

function row(over: Partial<Message> = {}): Message {
  return {
    id: 'm-1', content: 'my words', type: 'user', encrypted: true, channelId: null, conversationId: CONV,
    author: ME, mentions: [], createdAt: '2026-11-01T10:00:00.000Z', editedAt: null,
    reactions: [{ emoji: '👍', count: 1, userIds: ['me'] }],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

function renderItem(message: Message, props: { isOwn?: boolean; readOnly?: boolean; conversationId?: string | null } = {}) {
  const conversationId = props.conversationId === null ? undefined : props.conversationId ?? CONV;
  render(
    <MessageItem
      message={message}
      showHeader
      addTopMargin={false}
      isOwn={props.isOwn ?? false}
      canDelete={props.isOwn ?? false}
      channelId={conversationId ? undefined : 'ch-plain'}
      conversationId={conversationId}
      readOnly={props.readOnly}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (sel: string) => container.querySelector(sel);
const button = (label: string) => q(`button[aria-label="${label}"]`);

describe('an own message in a read-only DM', () => {
  it('offers only the delete: no reply, no reaction, no edit', () => {
    renderItem(row(), { isOwn: true, readOnly: true });
    expect(button('messageItem.deleteMessage')).not.toBeNull();
    expect(button('messageItem.reply')).toBeNull();
    expect(button('messageItem.addReaction')).toBeNull();
    expect(button('messageItem.editMessage')).toBeNull();
  });

  it('the same row in a live DM offers all four', () => {
    renderItem(row(), { isOwn: true, readOnly: false });
    for (const label of ['messageItem.deleteMessage', 'messageItem.reply', 'messageItem.addReaction', 'messageItem.editMessage']) {
      expect(button(label), label).not.toBeNull();
    }
  });

  it('an edit being typed is dropped when the conversation turns read-only', () => {
    renderItem(row(), { isOwn: true, readOnly: false });
    act(() => (button('messageItem.editMessage') as HTMLButtonElement).click());
    expect(q('textarea')).not.toBeNull();
    act(() => root.render(
      <MessageItem message={row()} showHeader addTopMargin={false} isOwn canDelete conversationId={CONV} readOnly />,
    ));
    expect(q('textarea')).toBeNull();
    expect(chat.editDMMessage).not.toHaveBeenCalled();
  });

  it('its reactions are shown but inert: no toggle, no add', () => {
    render(<ReactionDisplay reactions={[{ emoji: '👍', count: 1, userIds: ['me'] }]} messageId="m-1" conversationId={CONV} readOnly />);
    const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('👍')) as HTMLButtonElement;
    expect(chip).toBeDefined();
    expect(chip.disabled).toBe(true);
    act(() => chip.click());
    expect(chat.toggleDMReaction).not.toHaveBeenCalled();
    expect(button('messageItem.addReaction')).toBeNull();
  });

  it('a live DM\'s reactions still toggle', () => {
    chat.toggleDMReaction.mockResolvedValue(undefined);
    render(<ReactionDisplay reactions={[{ emoji: '👍', count: 1, userIds: ['me'] }]} messageId="m-1" conversationId={CONV} />);
    const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('👍')) as HTMLButtonElement;
    act(() => chip.click());
    expect(chat.toggleDMReaction).toHaveBeenCalledWith(CONV, 'm-1', '👍');
  });
});

describe('a row under the deleted account\'s placeholder author', () => {
  it('the localised name and a neutral avatar; no profile card, no badge, no Report, no member lookup', () => {
    renderItem(row({ author: PLACEHOLDER, content: '' }), { readOnly: true });
    expect(q('[data-testid="deleted-author-name"]')?.textContent).toBe('dm.deletedParticipant.name');
    expect(q('[data-testid="deleted-user-avatar"]')).not.toBeNull();
    expect(q('[data-testid="hover-target"]')).toBeNull();
    expect(q('[data-testid="avatar"]')).toBeNull();
    expect(q('[data-testid="staff-badge"]')).toBeNull();
    expect(q('[data-testid="supporter-badge"]')).toBeNull();
    expect(button('messageItem.report')).toBeNull();
    // never the server's display name
    expect(container.textContent).not.toContain('Deleted user');
    for (const [arg] of useMemberMock.mock.calls) expect(arg).toBeUndefined();
  });
});

describe('a deleted account\'s message (the gate\'s placeholder row)', () => {
  const deletedRow = (): Message => ({
    id: 'm-del', type: DELETED_MESSAGE_TYPE, content: '', encrypted: false, channelId: null, conversationId: CONV,
    replyToId: null, replyTo: null, author: PLACEHOLDER, mentions: [], attachments: [], reactions: [],
    createdAt: '2026-11-01T10:00:00.000Z', editedAt: null,
  });

  it('is a quiet "Message deleted" line with its time: no toolbar, no author, no action', () => {
    renderItem(deletedRow(), { readOnly: true });
    const line = q('[data-testid="deleted-message-row"]');
    expect(line?.textContent).toContain('dm.deletedParticipant.messageDeleted');
    expect(line?.getAttribute('data-message-id')).toBe('m-del');
    expect(q('[data-testid="message-actions"]')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(q('[data-testid="hover-target"]')).toBeNull();
  });

  it('in a plaintext channel the type means nothing: the row renders as it always did', () => {
    renderItem({ ...deletedRow(), channelId: 'ch-plain', conversationId: null, content: 'a channel line', author: { id: 'u-bob', username: 'bob', displayName: 'Bob', avatarUrl: null } }, { conversationId: null });
    expect(q('[data-testid="deleted-message-row"]')).toBeNull();
    expect(container.textContent).toContain('a channel line');
  });
});

describe('a quote of a deleted account\'s message', () => {
  it('says "Message deleted" under the localised name, never the quote\'s text', () => {
    renderItem(row({ replyToId: 'm-del', replyTo: { id: 'm-del', content: 'server text', encrypted: false, author: PLACEHOLDER } }), { isOwn: true, readOnly: true });
    expect(container.textContent).toContain('dm.deletedParticipant.messageDeleted');
    expect(container.textContent).toContain('dm.deletedParticipant.name');
    expect(container.textContent).not.toContain('server text');
    expect(container.textContent).not.toContain('Deleted user');
  });

  it('the deleted account\'s call notice quoted keeps its fixed text', () => {
    renderItem(row({ replyToId: 'm-call', replyTo: { id: 'm-call', content: 'Voice call started', encrypted: false, author: PLACEHOLDER } }), { isOwn: true, readOnly: true });
    expect(container.textContent).toContain('Voice call started');
    expect(container.textContent).not.toContain('dm.deletedParticipant.messageDeleted');
  });
});
