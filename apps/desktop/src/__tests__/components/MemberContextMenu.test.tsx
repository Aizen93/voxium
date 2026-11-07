import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ServerMember } from '@voxium/shared';

/**
 * The member context menu's "Remove and ban": the first click opens the
 * reason panel, the confirm (button or Enter) sends the trimmed reason once,
 * and the panel survives a refusal so the moderator can read it.
 */

// A STABLE t, like react-i18next's
const t = (k: string, o?: Record<string, unknown>) => (o && 'name' in o ? `${k}:${o.name}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

const S = vi.hoisted(() => ({
  kickMember: vi.fn(), updateMemberRole: vi.fn(), assignMemberRoles: vi.fn(), setNickname: vi.fn(), setMemberNickname: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));

let members: ServerMember[] = [];
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, activeServerId: 'srv-1', roles: [], channels: [], ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/voiceStore', () => {
  const state = () => ({ channelUsers: new Map(), serverMuteUser: vi.fn(), serverDeafenUser: vi.fn(), forceMoveUser: vi.fn(), activeChannelId: null });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useVoiceStore.getState = state;
  return { useVoiceStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me', username: 'me', displayName: 'Me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: S.toastSuccess, error: S.toastError, info: vi.fn(), warning: vi.fn() } }));

import { MemberContextMenu } from '../../components/server/MemberContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const member = (userId: string, role: ServerMember['role'], displayName: string): ServerMember =>
  ({ userId, serverId: 'srv-1', role, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id: userId, username: displayName.toLowerCase(), displayName, avatarUrl: null } } as unknown as ServerMember);
const bob = member('u-2', 'member', 'Bob');

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

async function render(target: ServerMember = bob) {
  await act(async () => { root.render(<MemberContextMenu member={target} position={{ x: 10, y: 10 }} onClose={onClose} />); });
}
// the menu is portaled to document.body
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const setValue = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const openPanel = async () => {
  await act(async () => { q('[data-testid="menu-remove-and-ban"]')!.click(); });
  expect(q('[data-testid="menu-remove-and-ban-confirm"]')).not.toBeNull();
};

beforeEach(() => {
  vi.clearAllMocks();
  members = [member('me', 'owner', 'Me'), bob, member('u-3', 'admin', 'Cy')];
  S.kickMember.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MemberContextMenu — remove and ban', () => {
  it('the first click opens the reason panel; the confirm sends the TRIMMED reason, toasts and closes', async () => {
    await render();
    expect(q('[data-testid="menu-remove-and-ban-confirm"]')).toBeNull();
    await openPanel();
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull(); // the button became the panel
    expect(q('[data-testid="menu-remove-and-ban-confirm"]')!.textContent).toContain('server.removeAndBanDescription');
    await act(async () => { setValue(q('[data-testid="menu-ban-reason"]') as HTMLInputElement, '  spam  '); });
    await act(async () => { q('[data-testid="menu-remove-and-ban-submit"]')!.click(); });
    expect(S.kickMember).toHaveBeenCalledWith('srv-1', 'u-2', 'spam');
    expect(S.toastSuccess).toHaveBeenCalledWith('server.removeAndBanned:Bob');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter in the reason field confirms; an empty reason is sent as none at all', async () => {
    await render();
    await openPanel();
    await act(async () => {
      q('[data-testid="menu-ban-reason"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(S.kickMember).toHaveBeenCalledWith('srv-1', 'u-2', undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the panel and forgets the typed reason', async () => {
    await render();
    await openPanel();
    await act(async () => { setValue(q('[data-testid="menu-ban-reason"]') as HTMLInputElement, 'typo'); });
    await act(async () => { q('[data-testid="menu-remove-and-ban-cancel"]')!.click(); });
    expect(q('[data-testid="menu-remove-and-ban-confirm"]')).toBeNull();
    expect(S.kickMember).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await openPanel();
    expect((q('[data-testid="menu-ban-reason"]') as HTMLInputElement).value).toBe('');
  });

  it('a refused removal toasts the translated error and keeps the panel open', async () => {
    S.kickMember.mockRejectedValue(new Error('Cannot kick a member with an equal or higher role'));
    await render();
    await openPanel();
    await act(async () => { q('[data-testid="menu-remove-and-ban-submit"]')!.click(); });
    expect(S.toastError).toHaveBeenCalledWith('serverErrors.cannotKickHigherRole');
    expect(S.toastSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[data-testid="menu-remove-and-ban-confirm"]')).not.toBeNull();
    expect((q('[data-testid="menu-remove-and-ban-submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('while the removal is in flight the panel is disabled and a second confirm does not send twice', async () => {
    let finish!: () => void;
    S.kickMember.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await render();
    await openPanel();
    await act(async () => { q('[data-testid="menu-remove-and-ban-submit"]')!.click(); });
    expect((q('[data-testid="menu-remove-and-ban-submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-testid="menu-ban-reason"]') as HTMLInputElement).disabled).toBe(true);
    expect((q('[data-testid="menu-remove-and-ban-cancel"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { q('[data-testid="menu-remove-and-ban-submit"]')!.click(); });
    await act(async () => {
      q('[data-testid="menu-ban-reason"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(S.kickMember).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a reason with a bidi override locally, before any request', async () => {
    await render();
    await openPanel();
    await act(async () => { setValue(q('[data-testid="menu-ban-reason"]') as HTMLInputElement, `spam${String.fromCharCode(0x202e)}`); });
    await act(async () => { q('[data-testid="menu-remove-and-ban-submit"]')!.click(); });
    expect(S.kickMember).not.toHaveBeenCalled();
    expect(S.toastError).toHaveBeenCalledWith('serverErrors.reasonUnsupportedChars');
    expect(q('[data-testid="menu-remove-and-ban-confirm"]')).not.toBeNull();
  });

  it('offers no removal for a member the actor does not outrank, nor for themselves', async () => {
    members = [member('me', 'admin', 'Me'), bob, member('u-3', 'admin', 'Cy')];
    await render(member('u-3', 'admin', 'Cy'));
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull();
    await render(bob);
    expect(q('[data-testid="menu-remove-and-ban"]')).not.toBeNull();
    await render(member('me', 'admin', 'Me'));
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull();
  });
});
