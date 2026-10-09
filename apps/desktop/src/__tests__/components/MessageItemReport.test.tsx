import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '@voxium/shared';

/**
 * Messages in a SECURE channel cannot be reported. Their content is not the
 * server's to read, so a report could only carry text the reporter typed;
 * the members deal with each other, and a member who wants the channel gone
 * hands its id to a server admin (context menu → "Copy channel ID"). The
 * server refuses such reports outright — this pins that the UI never offers
 * one, while plaintext channels and DMs keep the button.
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
  channels: [
    { id: 'ch-plain', name: 'general', type: 'text', secure: false },
    { id: 'ch-secure', name: 'ops', type: 'text', secure: true },
  ],
}));
vi.mock('../../stores/serverStore', () => {
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) =>
    sel ? sel(serverState) : serverState;
  useServerStore.getState = () => serverState;
  return { useServerStore };
});

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/common/StaffBadge', () => ({ StaffBadge: () => null }));
vi.mock('../../components/common/SupporterBadge', () => ({ SupporterBadge: () => null }));
vi.mock('../../components/chat/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('../../components/chat/AttachmentDisplay', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../components/chat/E2EAttachmentDisplay', () => ({ E2EAttachmentDisplay: () => null }));
vi.mock('../../components/chat/ReactionDisplay', () => ({ ReactionDisplay: () => null }));
vi.mock('../../components/chat/DeleteConfirmModal', () => ({ DeleteConfirmModal: () => null }));
vi.mock('../../components/chat/ReportModal', () => ({ ReportModal: () => null }));

import { MessageItem } from '../../components/chat/MessageItem';

const message: Message = {
  id: 'm1',
  content: 'hello',
  type: 'user',
  channelId: 'ch-plain',
  conversationId: null,
  author: { id: 'someone-else', username: 'other', displayName: 'Other', avatarUrl: null },
  createdAt: new Date().toISOString(),
  editedAt: null,
  reactions: [],
};

let container: HTMLDivElement;
let root: Root;

function render(props: { channelId?: string; conversationId?: string }) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MessageItem
        message={{ ...message, channelId: props.channelId ?? null, conversationId: props.conversationId ?? null }}
        showHeader
        addTopMargin={false}
        isOwn={false}
        canDelete={false}
        {...props}
      />,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const reportButton = () => container.querySelector('button[aria-label="messageItem.report"]');
const replyButton = () => container.querySelector('button[aria-label="messageItem.reply"]');

describe('MessageItem — report action', () => {
  it('offers Report on a plaintext channel message', () => {
    render({ channelId: 'ch-plain' });
    expect(reportButton()).toBeTruthy();
  });

  it('offers Report on a DM message', () => {
    render({ conversationId: 'conv-1' });
    expect(reportButton()).toBeTruthy();
  });

  it('does NOT offer Report on a secure-channel message — the rest of the toolbar stays', () => {
    render({ channelId: 'ch-secure' });
    expect(reportButton()).toBeNull();
    expect(replyButton()).toBeTruthy();
  });
});
