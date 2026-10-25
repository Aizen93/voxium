import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ServerMember } from '@voxium/shared';
import { E2E_LIMITS } from '@voxium/shared';

/**
 * The create-secure-channel dialog (owner, 2026-10-25: "I select 4 members
 * but I can't see who I selected"): whoever is picked is shown as a removable
 * chip above the search box, the list highlights the picked rows and fills a
 * dialog that is wide enough for two columns, and Create sends exactly the
 * picked ids with the chosen type.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, o?: Record<string, unknown>) => (o && ('count' in o || 'name' in o || 'max' in o) ? `${k}:${o.count ?? o.name ?? o.max}` : k),
    }),
  };
});

const { createSecureChannel, setActiveChannel, toastError, toastSuccess } = vi.hoisted(() => ({
  createSecureChannel: vi.fn(),
  setActiveChannel: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

let members: ServerMember[] = [];

vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, createSecureChannel, setActiveChannel });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me', username: 'me', displayName: 'Me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('../../hooks/useMemberSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useMemberSearch')>();
  // No server-side search in the test: the client's rows filter locally.
  return { ...actual, useMemberSearch: () => null };
});
vi.mock('../../services/e2e/voiceFrameTransform', () => ({ isSecureVoiceSupported: () => true }));

import { SecureChannelCreateModal } from '../../components/server/SecureChannelCreateModal';

const member = (userId: string, username: string, displayName: string, nickname: string | null = null): ServerMember =>
  ({ userId, nickname, user: { id: userId, username, displayName, avatarUrl: null } }) as unknown as ServerMember;

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render() {
  act(() => {
    root.render(<SecureChannelCreateModal serverId="srv1" onClose={onClose} />);
  });
}
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const row = (username: string) => q(`[data-testid="secure-invite-${username}"]`)!;
const chips = () => qa('[data-testid^="secure-selected-"]').filter((el) => el.dataset.testid !== 'secure-selected-empty');
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  members = [
    member('me', 'me', 'Me'),
    member('u1', 'yasser', 'Yasser'),
    member('u2', 'zizoo', 'Zizoo'),
    member('u3', 'mara', 'Mara', 'Mara V.'),
    member('u4', 'jonas', 'Jonas'),
    member('u5', 'priya', 'Priya'),
  ];
  createSecureChannel.mockReset().mockResolvedValue({ id: 'ch-new' });
  setActiveChannel.mockClear();
  toastError.mockClear();
  toastSuccess.mockClear();
  onClose.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SecureChannelCreateModal', () => {
  it('is a wide two-column dialog that names itself and never lists the creator', () => {
    render();
    const modal = q('[data-testid="secure-channel-create-modal"]')!;
    expect(modal.className).toContain('max-w-3xl');
    expect(q('[data-testid="secure-channel-create-body"]')!.className).toMatch(/grid-cols-\[280px_minmax\(0,1fr\)\]/);
    expect(q('[role="dialog"]')!.getAttribute('aria-labelledby')).toBe('secure-channel-create-title');
    expect(q('#secure-channel-create-title')!.textContent).toContain('secureChannel.createTitle');
    expect(q('[data-testid="secure-invite-me"]')).toBeNull();
    expect(qa('[data-testid^="secure-invite-"]')).toHaveLength(5);
  });

  it('keeps the picked members under the channel name, and the whole right column for the search and the list', () => {
    render();
    const left = q('[data-testid="secure-channel-create-channel"]')!;
    const right = q('[data-testid="secure-channel-create-people"]')!;
    expect(left.contains(q('[data-testid="secure-channel-name"]'))).toBe(true);
    expect(left.contains(q('[data-testid="secure-selected"]'))).toBe(true);
    expect(right.contains(q('[data-testid="secure-member-search"]'))).toBe(true);
    expect(right.contains(q('[data-testid="secure-candidates"]'))).toBe(true);
    expect(right.contains(q('[data-testid="secure-selected"]'))).toBe(false);
    // the picked box grows to the column's remaining height and scrolls inside itself
    expect(q('[data-testid="secure-selected"]')!.className).toContain('flex-1');
    click(row('yasser'));
    expect(q('[data-testid="secure-selected"]')!.querySelector('.overflow-y-auto')).toBeTruthy();
  });

  it('starts with the empty state and no chips', () => {
    render();
    expect(q('[data-testid="secure-selected-empty"]')!.textContent).toBe('secureChannel.noneSelected');
    expect(chips()).toHaveLength(0);
    expect(q('[data-testid="secure-selected"]')!.textContent).toContain('secureChannel.selectedMembers:0');
  });

  it('shows every picked member as a chip, in the order picked, and counts them', () => {
    render();
    click(row('yasser'));
    click(row('zizoo'));
    click(row('mara'));
    click(row('jonas'));
    expect(chips().map((c) => c.dataset.testid)).toEqual([
      'secure-selected-yasser', 'secure-selected-zizoo', 'secure-selected-mara', 'secure-selected-jonas',
    ]);
    // the chip shows the nickname when there is one, as the list does
    expect(q('[data-testid="secure-selected-mara"]')!.textContent).toContain('Mara V.');
    expect(q('[data-testid="secure-selected-mara"]')!.getAttribute('aria-label')).toBe('secureChannel.removeFromInvite:Mara V.');
    expect(q('[data-testid="secure-selected-empty"]')).toBeNull();
    expect(q('[data-testid="secure-channel-create-body"]')!.textContent).toContain('secureChannel.inviteMembers:4');
    expect(q('[data-testid="secure-selected"]')!.textContent).toContain('secureChannel.selectedMembers:4');
  });

  it('highlights the picked rows in the list and un-picks on a second click', () => {
    render();
    click(row('yasser'));
    expect(row('yasser').getAttribute('aria-pressed')).toBe('true');
    expect(row('yasser').className).toContain('bg-vox-accent-tint');
    expect(row('zizoo').getAttribute('aria-pressed')).toBe('false');
    click(row('yasser'));
    expect(row('yasser').getAttribute('aria-pressed')).toBe('false');
    expect(chips()).toHaveLength(0);
  });

  it('a chip removes its member from the invite list', () => {
    render();
    click(row('yasser'));
    click(row('zizoo'));
    click(q('[data-testid="secure-selected-yasser"]')!);
    expect(chips().map((c) => c.dataset.testid)).toEqual(['secure-selected-zizoo']);
    expect(row('yasser').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the chips while the list is filtered by the search box', () => {
    render();
    click(row('yasser'));
    typeInto(q('[data-testid="secure-member-search"]') as HTMLInputElement, 'zi');
    expect(qa('[data-testid^="secure-invite-"]').map((el) => el.dataset.testid)).toEqual(['secure-invite-zizoo']);
    expect(chips().map((c) => c.dataset.testid)).toEqual(['secure-selected-yasser']);
  });

  it('refuses one invitee more than the cap, with a toast', () => {
    const max = E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP - 1;
    members = [member('me', 'me', 'Me'), ...Array.from({ length: max + 1 }, (_, i) => member(`u${i}`, `user${i}`, `User ${i}`))];
    render();
    for (let i = 0; i <= max; i++) click(row(`user${i}`));
    expect(chips()).toHaveLength(max);
    expect(toastError).toHaveBeenCalledWith(`secureChannel.memberCapReached:${E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP}`);
    expect(row(`user${max}`).getAttribute('aria-pressed')).toBe('false');
  });

  it('Create stays disabled without a name, then sends the picked ids and the type and opens the channel', async () => {
    render();
    const create = q('[data-testid="secure-channel-create"]') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    click(row('yasser'));
    click(row('mara'));
    typeInto(q('[data-testid="secure-channel-name"]') as HTMLInputElement, 'ops');
    expect(create.disabled).toBe(false);
    await act(async () => {
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(createSecureChannel).toHaveBeenCalledWith('srv1', 'ops', ['u1', 'u3'], 'text');
    expect(setActiveChannel).toHaveBeenCalledWith('ch-new');
    expect(toastSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a voice channel is created with its type and not opened as text', async () => {
    render();
    click(q('[data-testid="secure-type-voice"]')!);
    typeInto(q('[data-testid="secure-channel-name"]') as HTMLInputElement, 'war-room');
    await act(async () => {
      q('[data-testid="secure-channel-create"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(createSecureChannel).toHaveBeenCalledWith('srv1', 'war-room', [], 'voice');
    expect(setActiveChannel).not.toHaveBeenCalled();
  });
});
