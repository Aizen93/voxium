import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, MessageAuthor } from '@voxium/shared';

/**
 * A webhook-authored message carries `author.id = 'webhook:<id>'` (or
 * `'webhook:deleted'` once the webhook is gone), never a user id. It must
 * reach no member lookup (one such id 400s the whole /members/lookup batch),
 * no profile popup and no Report; it shows an APP tag instead of the staff
 * and supporter badges, and a deleted webhook's name renders dimmed.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

vi.mock('../../stores/chatStore', () => {
  const state = () => ({
    editMessage: vi.fn(),
    editDMMessage: vi.fn(),
    setReplyingTo: vi.fn(),
    toggleReaction: vi.fn(),
    toggleDMReaction: vi.fn(),
  });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useChatStore.getState = state;
  return { useChatStore };
});

vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useAuthStore.getState = state;
  return { useAuthStore };
});

const serverState = vi.hoisted(() => ({
  members: [] as unknown[],
  channels: [{ id: 'ch-plain', name: 'general', type: 'text', secure: false }],
}));
vi.mock('../../stores/serverStore', () => {
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) =>
    sel ? sel(serverState) : serverState;
  useServerStore.getState = () => serverState;
  return { useServerStore };
});

const { useMemberMock } = vi.hoisted(() => ({
  useMemberMock: vi.fn((userId: string | undefined): undefined => { void userId; return undefined; }),
}));
vi.mock('../../hooks/useMember', () => ({ useMember: useMemberMock }));

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children, userId }: { children: React.ReactNode; userId: string }) => (
    <span data-testid="hover-target" data-user-id={userId}>{children}</span>
  ),
}));
vi.mock('../../components/common/StaffBadge', () => ({ StaffBadge: () => <span data-testid="staff-badge" /> }));
vi.mock('../../components/common/SupporterBadge', () => ({ SupporterBadge: () => <span data-testid="supporter-badge" /> }));
vi.mock('../../components/chat/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('../../components/chat/AttachmentDisplay', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../components/chat/E2EAttachmentDisplay', () => ({ E2EAttachmentDisplay: () => null }));
vi.mock('../../components/chat/ReactionDisplay', () => ({ ReactionDisplay: () => null }));
vi.mock('../../components/chat/DeleteConfirmModal', () => ({ DeleteConfirmModal: () => null }));
vi.mock('../../components/chat/ReportModal', () => ({ ReportModal: () => <div data-testid="report-modal" /> }));

import { MessageItem } from '../../components/chat/MessageItem';

const webhookAuthor = (id = 'webhook:wh-1', name = 'CI Bot'): MessageAuthor =>
  ({ id, username: name, displayName: name, avatarUrl: null, isWebhook: true });

const human: MessageAuthor = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };

function webhookMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm-hook',
    content: 'build passed',
    type: 'user',
    channelId: 'ch-plain',
    conversationId: null,
    author: webhookAuthor(),
    webhookId: 'wh-1',
    mentions: [],
    createdAt: new Date().toISOString(),
    editedAt: null,
    reactions: [],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(
  message: Message,
  props: { isOwn?: boolean; canDelete?: boolean; showHeader?: boolean; conversationId?: string } = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MessageItem
        message={message}
        showHeader={props.showHeader ?? true}
        addTopMargin={false}
        isOwn={props.isOwn ?? false}
        canDelete={props.canDelete ?? false}
        // a DM row has a conversation and no channel (as DMChatArea renders it)
        channelId={props.conversationId ? undefined : 'ch-plain'}
        conversationId={props.conversationId}
      />,
    );
  });
}

beforeEach(() => {
  useMemberMock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (sel: string) => container.querySelector(sel);
const hoverTargets = () => [...container.querySelectorAll('[data-testid="hover-target"]')];
const button = (label: string) => q(`button[aria-label="${label}"]`);

describe('MessageItem — a webhook author', () => {
  it('renders the APP tag, no hover target, no Report, Delete when canDelete, no Edit', () => {
    render(webhookMessage(), { canDelete: true });
    const tag = q('[data-testid="app-tag"]');
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toBe('messageItem.appTag');
    expect(hoverTargets()).toHaveLength(0);
    expect(button('messageItem.report')).toBeNull();
    expect(button('messageItem.deleteMessage')).toBeTruthy();
    expect(button('messageItem.editMessage')).toBeNull();
    // Reply and reactions stay: a human may answer a webhook post
    expect(button('messageItem.reply')).toBeTruthy();
    expect(button('messageItem.addReaction')).toBeTruthy();
  });

  it('no Delete without the permission', () => {
    render(webhookMessage(), { canDelete: false });
    expect(button('messageItem.deleteMessage')).toBeNull();
  });

  it('never offers Edit, even if a caller passed isOwn', () => {
    render(webhookMessage(), { isOwn: true, canDelete: true });
    expect(button('messageItem.editMessage')).toBeNull();
    expect(button('messageItem.report')).toBeNull();
  });

  it('the name is plain text in the default colour: no hover styling, no role colour', () => {
    render(webhookMessage());
    const name = q('[data-testid="webhook-author-name"]') as HTMLElement;
    expect(name.textContent).toBe('CI Bot');
    expect(name.className).toContain('text-vox-text-primary');
    expect(name.className).not.toContain('cursor-pointer');
    expect(name.className).not.toContain('hover:underline');
    expect(name.getAttribute('style')).toBeNull();
    expect(name.getAttribute('title')).toBeNull();
  });

  it('never asks useMember for the webhook id (called with undefined)', () => {
    render(webhookMessage());
    expect(useMemberMock).toHaveBeenCalled();
    for (const [arg] of useMemberMock.mock.calls) expect(arg).toBeUndefined();
  });

  it('shows no staff or supporter badge, whatever the author fields claim', () => {
    render(webhookMessage({ author: { ...webhookAuthor(), role: 'admin', isSupporter: true } }));
    expect(q('[data-testid="staff-badge"]')).toBeNull();
    expect(q('[data-testid="supporter-badge"]')).toBeNull();
    expect(q('[data-testid="app-tag"]')).toBeTruthy();
  });

  it('a deleted webhook (webhookId null) renders the name dimmed, titled "Deleted webhook"', () => {
    render(webhookMessage({ author: webhookAuthor('webhook:deleted', 'Old CI'), webhookId: null }));
    const name = q('[data-testid="webhook-author-name"]') as HTMLElement;
    expect(name.textContent).toBe('Old CI');
    expect(name.className).toContain('text-vox-text-muted');
    expect(name.className).not.toContain('text-vox-text-primary');
    expect(name.getAttribute('title')).toBe('messageItem.deletedWebhook');
    expect(q('[data-testid="app-tag"]')).toBeTruthy();
    expect(hoverTargets()).toHaveLength(0);
  });

  it('a grouped (headerless) webhook row has no hover target and no Report either', () => {
    render(webhookMessage(), { showHeader: false });
    expect(hoverTargets()).toHaveLength(0);
    expect(button('messageItem.report')).toBeNull();
  });
});

describe('MessageItem — a human author (unchanged)', () => {
  const humanMessage = (over: Partial<Message> = {}): Message =>
    webhookMessage({ id: 'm-human', author: human, webhookId: undefined, ...over });

  it('keeps the hover targets, the Report button and no APP tag; useMember gets the author id', () => {
    render(humanMessage());
    expect(hoverTargets()).toHaveLength(2);
    for (const el of hoverTargets()) expect(el.getAttribute('data-user-id')).toBe('u-alice');
    expect(q('[data-testid="app-tag"]')).toBeNull();
    expect(q('[data-testid="webhook-author-name"]')).toBeNull();
    expect(button('messageItem.report')).toBeTruthy();
    expect(useMemberMock).toHaveBeenCalledWith('u-alice');
  });

  it('a human reply quoting a webhook message renders the quoted name without a hover target', () => {
    render(humanMessage({
      replyToId: 'm-hook',
      replyTo: { id: 'm-hook', content: 'build passed', author: webhookAuthor() },
    }));
    // The two hover targets are the replying human's avatar and name; the quote has none
    expect(hoverTargets()).toHaveLength(2);
    for (const el of hoverTargets()) {
      expect(el.getAttribute('data-user-id')).toBe('u-alice');
      expect(el.textContent).not.toContain('CI Bot');
    }
    const quoted = [...container.querySelectorAll('span')].find((s) => s.textContent === 'CI Bot') as HTMLElement;
    expect(quoted).toBeTruthy();
    expect(quoted.closest('[data-testid="hover-target"]')).toBeNull();
    expect(quoted.className).not.toContain('cursor-pointer');
    // the quoted webhook keeps its APP tag (the replying human's header has none)
    const tags = [...container.querySelectorAll('[data-testid="app-tag"]')];
    expect(tags).toHaveLength(1);
    expect(tags[0].previousElementSibling).toBe(quoted);
    // the quoted webhook id reached no member lookup either
    for (const [arg] of useMemberMock.mock.calls) expect(arg).not.toBe('webhook:wh-1');
  });

  it('a webhook quoting itself as "Alice" is still tagged in the quote: the name alone would pass for the member', () => {
    render(humanMessage({
      replyToId: 'm-hook',
      replyTo: { id: 'm-hook', content: 'please send me your password', author: webhookAuthor('webhook:wh-1', 'Alice') },
    }));
    const tag = q('[data-testid="app-tag"]');
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toBe('messageItem.appTag');
    expect(tag!.previousElementSibling!.textContent).toBe('Alice');
  });

  it('a deleted webhook in a quote is tagged too', () => {
    render(humanMessage({
      replyToId: 'm-old',
      replyTo: { id: 'm-old', content: 'old news', author: webhookAuthor('webhook:deleted', 'Old CI') },
    }));
    expect(container.querySelectorAll('[data-testid="app-tag"]')).toHaveLength(1);
  });

  it('a human quote carries no APP tag', () => {
    render(humanMessage({
      replyToId: 'm-bob',
      replyTo: { id: 'm-bob', content: 'hi', author: { id: 'u-bob', username: 'bob', displayName: 'Bob', avatarUrl: null } },
    }));
    expect(q('[data-testid="app-tag"]')).toBeNull();
  });
});

describe('MessageItem — a quoted webhook claim where no webhook posts', () => {
  const human2 = (over: Partial<Message> = {}): Message =>
    webhookMessage({ id: 'm-human', author: human, webhookId: undefined, ...over });
  const claimingQuote = { id: 'm-x', content: 'hello', author: { ...human, id: 'u-bob', displayName: 'Bob', isWebhook: true } };

  it('an ENCRYPTED quote never shows the tag (no webhook posts encrypted rows)', () => {
    render(human2({ replyToId: 'm-x', replyTo: { ...claimingQuote, encrypted: true } }));
    expect(q('[data-testid="app-tag"]')).toBeNull();
  });

  it('a quote on an ENCRYPTED row never shows it', () => {
    render(human2({ encrypted: true, replyToId: 'm-x', replyTo: claimingQuote }));
    expect(q('[data-testid="app-tag"]')).toBeNull();
  });

  it('a quote in a DM never shows it', () => {
    render(human2({ channelId: null, conversationId: 'conv-1', replyToId: 'm-x', replyTo: claimingQuote }), { conversationId: 'conv-1' });
    expect(q('[data-testid="app-tag"]')).toBeNull();
  });
});

describe('MessageItem — a webhook claim on a row no webhook can post', () => {
  // Webhooks never post encrypted rows nor into DMs. The display gate strips
  // `isWebhook` from those rows; MessageItem refuses the flag on them too, so
  // a server that stamps it on an authentic message cannot hide Report (a DM
  // E2E row must stay reportable), hide Edit, or relabel a person as an app.

  it('an ENCRYPTED channel row claiming a webhook author renders as the human it is', () => {
    render(webhookMessage({ author: { ...human, isWebhook: true }, webhookId: 'x', encrypted: true }));
    expect(q('[data-testid="app-tag"]')).toBeNull();
    expect(q('[data-testid="webhook-author-name"]')).toBeNull();
    expect(hoverTargets()).toHaveLength(2);
    for (const el of hoverTargets()) expect(el.getAttribute('data-user-id')).toBe('u-alice');
    expect(button('messageItem.report')).toBeTruthy();
    expect(useMemberMock).toHaveBeenCalledWith('u-alice');
  });

  it('a DM row claiming a webhook author renders as the human it is — Report stays', () => {
    // unencrypted on purpose: the conversation alone must be enough to refuse the flag
    render(
      webhookMessage({ author: { ...human, isWebhook: true }, webhookId: 'x', channelId: null, conversationId: 'conv-1' }),
      { conversationId: 'conv-1' },
    );
    expect(q('[data-testid="app-tag"]')).toBeNull();
    expect(q('[data-testid="webhook-author-name"]')).toBeNull();
    expect(hoverTargets()).toHaveLength(2);
    expect(button('messageItem.report')).toBeTruthy();
  });

  it('an encrypted DM row of the user’s OWN claiming a webhook author keeps Edit', () => {
    render(
      webhookMessage({
        author: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, isWebhook: true },
        webhookId: null,
        encrypted: true,
        channelId: null,
        conversationId: 'conv-1',
      }),
      { isOwn: true, conversationId: 'conv-1' },
    );
    expect(button('messageItem.editMessage')).toBeTruthy();
    expect(q('[data-testid="app-tag"]')).toBeNull();
    // not dimmed as a "deleted webhook" either
    expect(q('[data-testid="webhook-author-name"]')).toBeNull();
  });
});
