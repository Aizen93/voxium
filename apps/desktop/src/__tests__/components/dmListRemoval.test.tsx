import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AxiosError } from 'axios';
import type { Conversation } from '@voxium/shared';

/**
 * The conversation list's X asks first: it opens a confirmation dialog and
 * sends nothing; the dialog's confirm button is the only caller of the store's
 * removeConversation (`DELETE /dm/:id?clearHistory=true`; dmStoreClearedHistory.test.ts
 * holds the request itself). A refused removal keeps the dialog and the row.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (k: string, o?: { name?: string }) => (o?.name ? `${k}:${o.name}` : k);
  return { ...actual, useTranslation: () => ({ t }) };
});

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  chat: { clearMessages: vi.fn(), messages: [], deleteMessage: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  voice: { dmCallConversationId: null as string | null, handleDMCallEnded: vi.fn() },
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: h.apiDelete } }));
vi.mock('../../services/dmReadOnly', () => ({ applyReadOnlyConversations: vi.fn(), clearMarksOfLiveConversations: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast: h.toast }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => h.chat } }));
vi.mock('../../stores/voiceStore', () => {
  const useVoiceStore = <T,>(sel?: (s: typeof h.voice) => T) => (sel ? sel(h.voice) : h.voice);
  useVoiceStore.getState = () => h.voice;
  return { useVoiceStore };
});
vi.mock('../../components/voice/DMVoicePanel', () => ({ DMVoicePanel: () => null }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock('../../stores/friendStore', () => {
  const state = () => ({ showFriendsView: false, pendingIncoming: [], setShowFriendsView: vi.fn() });
  const useFriendStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useFriendStore.getState = state;
  return { useFriendStore };
});
vi.mock('../../stores/supportStore', () => ({ useSupportStore: { getState: () => ({ setShowSupportView: vi.fn(), ticket: null }) } }));

import { DMList } from '../../components/dm/DMList';
import { useDMStore } from '../../stores/dmStore';

const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null } as Conversation['participant'];
const conv = (id: string): Conversation => ({
  id, user1Id: 'me', user2Id: ALICE.id, participant: ALICE, lastMessage: null,
  encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
});
const deletedConv = (id: string): Conversation => ({
  ...conv(id),
  participant: { ...ALICE, id: `deleted:${id}`, username: 'deleted', displayName: 'Raw Server Name' },
  participantDeleted: true,
});

let container: HTMLDivElement;
let root: Root;
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DMList />));
  await flush();
}
const rows = () => container.querySelectorAll('[role="button"]').length;
const removeButton = () => container.querySelector('button[aria-label^="dm.remove.actionWith"]') as HTMLButtonElement;
const dialog = () => document.body.querySelector('[data-testid="dm-remove-dialog"]') as HTMLElement | null;
const confirmButton = () => document.body.querySelector('[data-testid="dm-remove-dialog-confirm"]') as HTMLButtonElement;
const cancelButton = () => Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'common.cancel') as HTMLButtonElement;
const escape = () => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
async function openDialog() {
  await act(async () => { removeButton().click(); });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.voice.dmCallConversationId = null;
  h.apiGet.mockImplementation(async () => ({ data: { data: [conv('c-1')] } }));
  useDMStore.setState({ conversations: [conv('c-1')], activeConversationId: null, participantStatuses: {}, dmUnreadCounts: {}, isLoading: false });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DMList: the X of a conversation asks first', () => {
  it('is a button that names the person and stays reachable by keyboard', async () => {
    await render();
    const x = removeButton();
    expect(x.tagName).toBe('BUTTON');
    expect(x.getAttribute('aria-label')).toBe('dm.remove.actionWith:Alice');
    expect(x.getAttribute('title')).toBe('dm.remove.action');
    expect(x.className).toContain('focus-visible:opacity-100');
  });

  it('opens the dialog and sends nothing', async () => {
    await render();
    await openDialog();

    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('dm.remove.title');
    expect(dialog()!.textContent).toContain('dm.remove.body:Alice');
    expect(dialog()!.textContent).toContain('dm.remove.bodyOther');
    expect(dialog()!.textContent).not.toContain('dm.remove.callEnds');
    expect(h.apiDelete).not.toHaveBeenCalled();
    expect(rows()).toBe(1);
  });

  it('Cancel closes it, sends nothing, and focus goes back to the X', async () => {
    await render();
    removeButton().focus();
    await openDialog();
    expect(dialog()!.contains(document.activeElement)).toBe(true);

    await act(async () => { cancelButton().click(); });

    expect(dialog()).toBeNull();
    expect(h.apiDelete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(removeButton());
  });

  it('Escape closes it and sends nothing', async () => {
    await render();
    await openDialog();

    await escape();

    expect(dialog()).toBeNull();
    expect(h.apiDelete).not.toHaveBeenCalled();
  });

  it('confirm removes it through the confirmed removal (clearHistory=true), exactly once, closes the dialog and toasts', async () => {
    h.apiDelete.mockResolvedValue({ data: { success: true, message: 'Conversation deleted' } });
    await render();
    await openDialog();

    await act(async () => { confirmButton().click(); });
    await flush();

    expect(h.apiDelete).toHaveBeenCalledTimes(1);
    expect(h.apiDelete).toHaveBeenCalledWith('/dm/c-1', { params: { clearHistory: true } });
    expect(dialog()).toBeNull();
    expect(h.toast.success).toHaveBeenCalledWith('dm.remove.done');
    expect(rows()).toBe(0);
  });

  it('while the request is in flight the dialog is busy: both buttons disabled, Escape does not close it', async () => {
    let finish!: (v: unknown) => void;
    h.apiDelete.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    await openDialog();

    await act(async () => { confirmButton().click(); });

    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toBe('dm.remove.removing');
    expect(cancelButton().disabled).toBe(true);
    await escape();
    expect(dialog()).not.toBeNull();
    await act(async () => { confirmButton().click(); });
    expect(h.apiDelete).toHaveBeenCalledTimes(1);

    await act(async () => { finish({ data: { success: true } }); });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('closes when its conversation leaves the list while it is open (removed from another device), but not while its own request is in flight', async () => {
    await render();
    await openDialog();
    expect(dialog()).not.toBeNull();

    // dm:conversation:deleted from another device of this account
    await act(async () => { useDMStore.setState({ conversations: [conv('c-2')] }); });
    await flush();
    expect(dialog()).toBeNull();
    expect(h.apiDelete).not.toHaveBeenCalled();

    // its own request on its way: the row goes when the answer is applied, the dialog stays busy until then
    useDMStore.setState({ conversations: [conv('c-1')] });
    await flush();
    let finish!: (v: unknown) => void;
    h.apiDelete.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await openDialog();
    await act(async () => { confirmButton().click(); });
    await act(async () => { useDMStore.setState({ conversations: [] }); });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(confirmButton().disabled).toBe(true);

    await act(async () => { finish({ data: { success: true } }); });
    await flush();
    expect(dialog()).toBeNull();
    expect(h.toast.success).toHaveBeenCalledWith('dm.remove.done');
  });

  it('a refused removal keeps the dialog and the row, shows the translated error, and can be tried again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.apiDelete.mockRejectedValue(new AxiosError('Request failed with status code 500'));
    await render();
    await openDialog();

    await act(async () => { confirmButton().click(); });
    await flush();

    expect(dialog()).not.toBeNull();
    expect(rows()).toBe(1);
    expect(h.toast.error).toHaveBeenCalledWith('dm.remove.failed');
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(confirmButton().disabled).toBe(false);
    expect(warn).toHaveBeenCalledWith('[DM] The conversation was not removed:', 'Request failed with status code 500');

    await act(async () => { confirmButton().click(); });
    await flush();
    expect(h.apiDelete).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    errorLog.mockRestore();
  });

  it('a read-only conversation says its own sentence alone, under the localised name', async () => {
    useDMStore.setState({ conversations: [deletedConv('c-1')] });
    await render();
    expect(removeButton().getAttribute('aria-label')).toBe('dm.remove.actionWith:dm.deletedParticipant.name');
    await openDialog();

    const text = dialog()!.textContent!;
    expect(text).toContain('dm.remove.bodyDeleted');
    expect(text).not.toContain('dm.remove.body:');
    expect(text).not.toContain('dm.remove.bodyOther');
    expect(text).not.toContain('Raw Server Name');
  });

  it('adds the call line when a call is in progress in that conversation, and only then', async () => {
    h.voice.dmCallConversationId = 'c-1';
    await render();
    await openDialog();
    expect(dialog()!.textContent).toContain('dm.remove.callEnds');
    await act(async () => { cancelButton().click(); });

    h.voice.dmCallConversationId = 'c-other';
    await act(async () => root.render(<DMList />));
    await openDialog();
    expect(dialog()!.textContent).not.toContain('dm.remove.callEnds');
  });
});
