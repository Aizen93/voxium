import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LIMITS } from '@voxium/shared';

/**
 * The per-message attachment limit holds whatever the timing. Drops and pastes
 * that land in the same tick all render with the same `pendingFiles`, so the
 * limit is counted on what is attached NOW plus what the call adds: the excess
 * is refused with the composer's "too many files" message, the files that fit
 * are kept. One component serves the server channel and the DM composer.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

vi.mock('../../stores/chatStore', () => {
  const state = () => ({ sendMessage: vi.fn(), sendDMMessage: vi.fn(), replyingTo: null, clearReplyingTo: vi.fn() });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useChatStore.getState = state;
  return { useChatStore };
});
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
  MentionAutocomplete: () => null,
  getMentionQuery: () => null,
  handleMentionKeyDown: () => false,
}));

import { MessageInput } from '../../components/chat/MessageInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAX = LIMITS.MAX_ATTACHMENTS_PER_MESSAGE;

let container: HTMLDivElement;
let root: Root;
let counter = 0;

const images = (n: number, type = 'image/png') =>
  Array.from({ length: n }, () => new File(['x'], `pic-${++counter}.png`, { type }));

/** The two ways a composer receives files: the textarea's paste and the root's drop. */
function paste(files: File[]) {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files } });
  container.querySelector('textarea')!.dispatchEvent(ev);
}
function drop(files: File[]) {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files, types: ['Files'] } });
  container.firstElementChild!.dispatchEvent(ev);
}
function pick(files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const attached = () => container.querySelectorAll('button[aria-label="messageInput.removeAttachment"]').length;
const uploads = () => api.post.mock.calls.filter(([url]) => url === '/uploads/presign/attachment').length;
const limitToasts = () => toast.error.mock.calls.filter(([m]) => m === 'chat.maxAttachments').length;

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount(props: { channelId?: string; conversationId?: string }) {
  act(() => { root.render(<MessageInput {...props} channelName="general" />); });
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe.each([
  ['the server channel composer', { channelId: 'c1' }],
  ['the DM composer', { conversationId: 'conv-1' }],
])('%s', (_name, props) => {
  it('several pastes and drops in one tick never attach more than the limit', async () => {
    mount(props);
    act(() => {
      paste(images(3));
      drop(images(3));
      paste(images(3));
      drop(images(2));
    });
    await settle();
    expect(attached()).toBe(MAX);
    expect(uploads()).toBe(MAX);
    expect(limitToasts()).toBeGreaterThanOrEqual(1);
  });

  it('keeps the files that fit and refuses only the excess, with the existing message', async () => {
    mount(props);
    act(() => {
      paste(images(MAX - 1));
      drop(images(4)); // one slot left: one kept, three refused
    });
    await settle();
    expect(attached()).toBe(MAX);
    expect(uploads()).toBe(MAX);
    expect(limitToasts()).toBe(1);
  });

  it('a single call with too many files keeps the first ones that fit and says so once', async () => {
    mount(props);
    act(() => { pick(images(MAX + 3)); });
    await settle();
    expect(attached()).toBe(MAX);
    expect(limitToasts()).toBe(1);
  });

  it('a full composer refuses a further paste or drop at once', async () => {
    mount(props);
    act(() => { paste(images(MAX)); });
    await settle();
    toast.error.mockClear();
    act(() => { paste(images(1)); drop(images(2)); });
    await settle();
    expect(attached()).toBe(MAX);
    expect(uploads()).toBe(MAX);
    expect(limitToasts()).toBe(2);
  });

  it('a file that is removed frees its slot straight away', async () => {
    mount(props);
    act(() => { paste(images(MAX)); });
    await settle();
    act(() => {
      (container.querySelector('button[aria-label="messageInput.removeAttachment"]') as HTMLButtonElement).click();
      paste(images(2)); // one slot: one kept
    });
    await settle();
    expect(attached()).toBe(MAX);
    expect(limitToasts()).toBe(1);
  });

  it('files of a type that is not allowed take no slot', async () => {
    mount(props);
    act(() => {
      paste([new File(['x'], 'run.exe', { type: 'application/x-msdownload' }), ...images(MAX)]);
    });
    await settle();
    expect(attached()).toBe(MAX);
    expect(limitToasts()).toBe(0);
    expect(toast.error).toHaveBeenCalledWith('chat.fileTypeNotAllowed');
  });
});
