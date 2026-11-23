import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';

/**
 * The composer follows the viewer's bits in THIS channel (a channel override
 * can move any of them): without SEND_MESSAGES the input is replaced by a
 * notice; without ATTACH_FILES the attach control is gone and a paste or a
 * drop of files is refused with one sentence; the `@everyone` row needs
 * MENTION_EVERYONE. A control that only prevents a refusal stays usable while
 * the bits are unknown (or the fetch failed); the row that offers a power
 * waits for them. A secure channel and a direct conversation are untouched.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const chat = vi.hoisted(() => ({ replyingTo: null as unknown, sendMessage: vi.fn(), sendDMMessage: vi.fn() }));
vi.mock('../../stores/chatStore', () => {
  const state = () => ({ sendMessage: chat.sendMessage, sendDMMessage: chat.sendDMMessage, replyingTo: chat.replyingTo, clearReplyingTo: vi.fn() });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useChatStore.getState = state;
  return { useChatStore };
});

const space = vi.hoisted(() => ({ channels: [] as { id: string; secure?: boolean }[] }));
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ channels: space.channels, activeServerId: 'srv-1' });
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
vi.mock('../../stores/dmStore', () => {
  const state = () => ({ conversations: [], readOnlyConfirmed: new Set<string>() });
  const useDMStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useDMStore.getState = state;
  return { useDMStore };
});
vi.mock('../../utils/dmParticipant', () => ({ isHeldReadOnly: () => false }));

// What the hook answers for a channel of a space; null for no channel (a DM)
const bits = vi.hoisted(() => ({ value: null as bigint | null, calls: [] as unknown[][] }));
vi.mock('../../hooks/useChannelPermissions', () => ({
  useChannelPermissions: (...args: unknown[]) => {
    bits.calls.push(args);
    return args[0] && args[1] ? bits.value : null;
  },
}));

vi.mock('../../services/socket', () => ({ getSocket: () => null, onSocketReconnect: () => () => {} }));
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));
vi.mock('../../services/e2e/engine', () => ({
  initEngine: async () => {},
  encryptAttachment: () => ({ key: 'k', iv: 'i', takeCiphertext: () => new Uint8Array(4) }),
}));
vi.mock('../../components/common/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('../../components/chat/MentionAutocomplete', () => ({
  MentionAutocomplete: ({ canMentionEveryone }: { canMentionEveryone?: boolean }) => (
    <div data-testid="mentions" data-can-everyone={String(!!canMentionEveryone)} />
  ),
  getMentionQuery: (text: string) => (text.startsWith('@') ? { start: 0, query: text.slice(1) } : null),
  handleMentionKeyDown: () => false,
}));

import { MessageInput } from '../../components/chat/MessageInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEND = Permissions.SEND_MESSAGES;
const ATTACH = Permissions.ATTACH_FILES;
const EVERYONE = Permissions.MENTION_EVERYONE;
const VIEW = Permissions.VIEW_CHANNEL;
const SENT = 'serverErrors.noPermissionSendMessages';
const ATTACH_REFUSED = 'serverErrors.noPermissionAttachFiles';

let container: HTMLDivElement;
let root: Root;

const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement | null;
const attachButton = () => container.querySelector('button[aria-label="messageInput.attachFile"]');
const fileInput = () => container.querySelector('input[type="file"]');
const notice = () => container.querySelector('[data-testid="channel-send-refused-notice"]');
const mentions = () => container.querySelector('[data-testid="mentions"]');
const uploads = () => api.post.mock.calls.filter(([url]) => url === '/uploads/presign/attachment').length;
const refusals = () => toast.error.mock.calls.filter(([m]) => m === ATTACH_REFUSED).length;

function mount(props: { channelId?: string; conversationId?: string } = { channelId: 'ch-1' }) {
  act(() => { root.render(<MessageInput {...props} channelName="general" />); });
}
function type(text: string) {
  const el = textarea()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const png = () => new File(['x'], 'pic.png', { type: 'image/png' });
function paste(files: File[]) {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files } });
  act(() => { textarea()!.dispatchEvent(ev); });
  return ev;
}
function drop(files: File[]) {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files, types: ['Files'] } });
  act(() => { container.firstElementChild!.dispatchEvent(ev); });
}
async function settle() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

beforeEach(() => {
  vi.clearAllMocks();
  bits.value = null;
  bits.calls = [];
  chat.replyingTo = null;
  space.channels = [{ id: 'ch-1' }, { id: 'ch-sec', secure: true }];
  api.post.mockResolvedValue({ data: { data: { uploadUrl: 'https://s3.test/put', key: 'k' } } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the composer follows SEND_MESSAGES in the channel', () => {
  it('held: the composer, as before', () => {
    bits.value = VIEW | SEND | ATTACH;
    mount();
    expect(textarea()).not.toBeNull();
    expect(notice()).toBeNull();
  });

  it('denied: a polite notice replaces the input, which cannot be focused', () => {
    bits.value = VIEW | ATTACH;
    mount();
    expect(textarea()).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(notice()?.querySelector('[role="status"]')).not.toBeNull();
    expect(notice()?.textContent).toBe(SENT);
  });

  it('the polite region is in the page first, its sentence is put in afterwards (so it is announced)', async () => {
    bits.value = VIEW | SEND;
    mount();
    const seenTargets: Node[] = [];
    const obs = new MutationObserver((records) => { for (const r of records) seenTargets.push(r.target); });
    obs.observe(container, { childList: true, characterData: true, subtree: true });
    bits.value = VIEW;
    mount();
    await act(async () => { await Promise.resolve(); });
    obs.disconnect();
    const region = notice()!.querySelector('[role="status"]')!;
    expect(region.textContent).toBe(SENT);
    // the text went into a region that was already mounted
    expect(seenTargets).toContain(region);
  });

  it('a focused textarea hands focus to the notice, and the composer taking its place gets it back', () => {
    bits.value = VIEW | SEND;
    mount();
    textarea()!.focus();
    expect(document.activeElement).toBe(textarea());
    bits.value = VIEW;
    mount();
    expect(document.activeElement).toBe(notice());
    expect(notice()!.getAttribute('tabindex')).toBe('-1');
    bits.value = VIEW | SEND;
    mount();
    expect(document.activeElement).toBe(textarea());
  });

  it('focus is never moved when the textarea did not have it, nor when the notice does not', () => {
    bits.value = VIEW | SEND;
    mount();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    bits.value = VIEW;
    mount();
    expect(document.activeElement).toBe(outside);
    bits.value = VIEW | SEND;
    mount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('not known yet or the fetch failed (null): the composer stays usable, the server decides', () => {
    bits.value = null;
    mount();
    expect(textarea()).not.toBeNull();
    expect(attachButton()).not.toBeNull();
    expect(notice()).toBeNull();
  });

  it('a secure channel keeps its composer (the hook answers null there: membership decides)', () => {
    bits.value = null;
    mount({ channelId: 'ch-sec' });
    expect(textarea()).not.toBeNull();
    expect(notice()).toBeNull();
  });

  it('a direct conversation is not a channel: the hook is asked for no channel and the composer stays', () => {
    bits.value = 0n;
    mount({ conversationId: 'conv-1' });
    expect(textarea()).not.toBeNull();
    expect(notice()).toBeNull();
    expect(bits.calls.every(([serverId, channelId]) => !serverId && !channelId)).toBe(true);
  });

  it('the draft, the attachments and the reply being composed survive the bit going away and coming back', async () => {
    chat.replyingTo = { id: 'm1', content: 'quoted', channelId: 'ch-1', author: { id: 'u2', username: 'a', displayName: 'alice', avatarUrl: null } };
    bits.value = VIEW | SEND | ATTACH;
    mount();
    type('half a thought');
    act(() => { paste([png()]); });
    await settle();
    expect(container.querySelectorAll('button[aria-label="messageInput.removeAttachment"]')).toHaveLength(1);

    bits.value = VIEW | ATTACH;
    mount();
    expect(textarea()).toBeNull();
    expect(notice()).not.toBeNull();

    bits.value = VIEW | SEND | ATTACH;
    mount();
    expect(textarea()!.value).toBe('half a thought');
    expect(container.querySelectorAll('button[aria-label="messageInput.removeAttachment"]')).toHaveLength(1);
    expect(container.textContent).toContain('messageInput.replyingTo');
  });
});

describe('the attach control follows ATTACH_FILES in the channel', () => {
  it('held: the control, the picker, paste and drop work', async () => {
    bits.value = VIEW | SEND | ATTACH;
    mount();
    expect(attachButton()).not.toBeNull();
    expect(fileInput()).not.toBeNull();
    paste([png()]);
    drop([png()]);
    await settle();
    expect(uploads()).toBe(2);
    expect(refusals()).toBe(0);
  });

  it('denied: no control and no picker; a paste or a drop is refused with one sentence and uploads nothing', async () => {
    bits.value = VIEW | SEND;
    mount();
    expect(attachButton()).toBeNull();
    expect(fileInput()).toBeNull();
    expect(textarea()).not.toBeNull();
    const ev = paste([png()]);
    expect(ev.defaultPrevented).toBe(true);
    expect(refusals()).toBe(1);
    drop([png()]);
    expect(refusals()).toBe(2);
    await settle();
    expect(uploads()).toBe(0);
    expect(container.querySelectorAll('button[aria-label="messageInput.removeAttachment"]')).toHaveLength(0);
  });

  it('denied: a drag over the composer shows no drop overlay', () => {
    bits.value = VIEW | SEND;
    mount();
    const ev = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'] } });
    act(() => { container.firstElementChild!.dispatchEvent(ev); });
    expect(container.textContent).not.toContain('messageInput.dropToUpload');
  });

  it('denied: pasting text is untouched', () => {
    bits.value = VIEW | SEND;
    mount();
    const ev = paste([]);
    expect(ev.defaultPrevented).toBe(false);
    expect(refusals()).toBe(0);
  });

  it('not known yet or the fetch failed (null): the control stays and a file is accepted', async () => {
    bits.value = null;
    mount();
    expect(attachButton()).not.toBeNull();
    paste([png()]);
    await settle();
    expect(uploads()).toBe(1);
  });

  it('a secure channel and a direct conversation keep the control', () => {
    bits.value = null; // the real hook answers null for a secure channel
    mount({ channelId: 'ch-sec' });
    expect(attachButton()).not.toBeNull();
    bits.value = 0n;
    mount({ conversationId: 'conv-1' });
    expect(attachButton()).not.toBeNull();
  });
});

describe('the @everyone row follows MENTION_EVERYONE in the channel', () => {
  const offered = () => mentions()?.getAttribute('data-can-everyone');

  it('held: offered', () => {
    bits.value = VIEW | SEND | EVERYONE;
    mount();
    type('@');
    expect(offered()).toBe('true');
  });

  it('denied: not offered', () => {
    bits.value = VIEW | SEND;
    mount();
    type('@');
    expect(offered()).toBe('false');
  });

  it('not known yet or the fetch failed (null): hidden, it offers a power', () => {
    bits.value = null;
    mount();
    type('@');
    expect(offered()).toBe('false');
  });

  it('never in a secure channel, whatever the bits', () => {
    bits.value = ALL;
    mount({ channelId: 'ch-sec' });
    type('@');
    expect(offered()).toBe('false');
  });
});

const ALL = VIEW | SEND | ATTACH | EVERYONE;
