import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The composer is ONE row: attach | input | emoji | send.
 *
 * It used to stack the textarea above a separate toolbar row, spending a full
 * extra line of vertical space on three small buttons. This pins the flat
 * structure — every control is a direct sibling of the textarea — so a
 * refactor that quietly re-splits the composer into rows fails here.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

/** What the mocked chat store answers for replyingTo (a test sets it, then re-renders). */
const chatState = vi.hoisted(() => ({ replyingTo: null as unknown }));

vi.mock('../../stores/chatStore', () => {
  const state = () => ({
    sendMessage: vi.fn(),
    sendDMMessage: vi.fn(),
    replyingTo: chatState.replyingTo,
    clearReplyingTo: vi.fn(),
  });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useChatStore.getState = state;
  return { useChatStore };
});

vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../services/api', () => ({ api: { post: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('../../components/chat/MentionAutocomplete', () => ({
  MentionAutocomplete: () => null,
  getMentionQuery: () => null,
  handleMentionKeyDown: () => false,
}));

import { MessageInput } from '../../components/chat/MessageInput';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<MessageInput channelId="c1" channelName="general" />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byLabel = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

describe('MessageInput single-row composer', () => {
  it('keeps attach, input, emoji, and send in the same row', () => {
    const textarea = container.querySelector('textarea')!;
    const attach = byLabel('messageInput.attachFile');
    const emoji = byLabel('messageInput.emojiPicker');
    const send = byLabel('messageInput.sendMessage');

    expect(textarea).toBeTruthy();
    for (const el of [attach, emoji, send]) {
      expect(el, el?.ariaLabel ?? 'button').toBeTruthy();
      expect(el.parentElement, `${el.ariaLabel} shares the textarea's row`).toBe(textarea.parentElement);
    }
  });

  it('orders the row attach → input → emoji → send', () => {
    const row = container.querySelector('textarea')!.parentElement!;
    const seq = Array.from(row.children)
      .map((el) =>
        el.tagName === 'TEXTAREA' ? 'input' : (el.getAttribute('aria-label') ?? ''),
      )
      .filter((x) => x === 'input' || x.startsWith('messageInput.'));
    expect(seq).toEqual([
      'messageInput.attachFile',
      'input',
      'messageInput.emojiPicker',
      'messageInput.sendMessage',
    ]);
  });
});

describe('MessageInput reply banner', () => {
  afterEach(() => { chatState.replyingTo = null; });

  const reply = (author: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'm1', content: 'the quoted text', channelId: 'c1', createdAt: '2026-10-18T00:00:00.000Z', editedAt: null, reactions: [],
    author: { id: 'u2', username: 'alice', displayName: 'alice', avatarUrl: null, ...author },
    ...extra,
  });
  const rerender = () => act(() => { root.render(<MessageInput channelId="c1" channelName="general" />); });
  const appTag = () => container.querySelector('[data-testid="app-tag"]');

  it('tags a webhook author with APP: a webhook names itself on every post, and the composer is where a reply quotes it', () => {
    chatState.replyingTo = reply({ id: 'webhook:wh-1', isWebhook: true });
    rerender();
    expect(container.textContent).toContain('messageInput.replyingTo');
    expect(container.textContent).toContain('alice');
    expect(appTag()).toBeTruthy();
  });

  it('shows no tag for a member, nor for a webhook claim on an encrypted or a DM row (there it is the server relabelling)', () => {
    chatState.replyingTo = reply({});
    rerender();
    expect(appTag()).toBeNull();
    chatState.replyingTo = reply({ id: 'webhook:wh-1', isWebhook: true }, { encrypted: true });
    rerender();
    expect(appTag()).toBeNull();
    chatState.replyingTo = reply({ id: 'webhook:wh-1', isWebhook: true }, { conversationId: 'dm-1', channelId: null });
    rerender();
    expect(appTag()).toBeNull();
  });
});
