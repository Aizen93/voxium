import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Channel, Role, ServerMember, VoiceUser } from '@voxium/shared';

/**
 * The member context menu. Which controls it offers follows what the server
 * enforces for each action (the permission bit and the role-position rule),
 * never the legacy member.role label; and "Remove and ban": the first click
 * opens the reason panel, the confirm (button or Enter) sends the trimmed
 * reason once, and the panel survives a refusal so the moderator can read it.
 */

// A STABLE t, like react-i18next's
const t = (k: string, o?: Record<string, unknown>) => (o && 'name' in o ? `${k}:${o.name}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

const S = vi.hoisted(() => ({
  kickMember: vi.fn(), updateMemberRole: vi.fn(), assignMemberRoles: vi.fn(), setNickname: vi.fn(), setMemberNickname: vi.fn(),
  fetchEffectivePermissions: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));

let members: ServerMember[] = [];
let roles: Role[] = [];
let channels: Channel[] = [];
let servers: { id: string; ownerId: string }[] = [];
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, activeServerId: 'srv-1', roles, channels, servers, ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
const V = vi.hoisted(() => ({
  channelUsers: new Map<string, VoiceUser[]>(),
  activeChannelId: null as string | null,
  serverMuteUser: vi.fn(), serverDeafenUser: vi.fn(), forceMoveUser: vi.fn(),
}));
vi.mock('../../stores/voiceStore', () => {
  const state = () => V;
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
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const role = (id: string, position: number, permissions: bigint = 0n): Role => ({
  id, serverId: 'srv-1', name: id, color: null, position, permissions: permissions.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z',
});
const member = (userId: string, legacy: ServerMember['role'], displayName: string, assigned: Role[] = []): ServerMember =>
  ({ userId, serverId: 'srv-1', role: legacy, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: assigned,
    user: { id: userId, username: displayName.toLowerCase(), displayName, avatarUrl: null } } as unknown as ServerMember);
const voiceChannel = (id: string, extra: Partial<Channel> = {}): Channel =>
  ({ id, name: id, type: 'voice', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', ...extra });
const voiceUser = (id: string): VoiceUser => ({ id, username: id, displayName: id, avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false } as unknown as VoiceUser);

const lowRole = role('low', 1);
const midRole = role('mid', 5);
const highRole = role('high', 9);

/** What the effective-permissions route answers: the space's bits, or a voice channel's. */
let spaceBits: bigint = ALL_PERMISSIONS;
let channelBits: bigint | null = null; // null = the same as the space's

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
async function render(target: ServerMember) {
  await act(async () => { root.render(<MemberContextMenu member={target} position={{ x: 10, y: 10 }} onClose={onClose} />); });
  await flush();
}
// the menu is portaled to document.body
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const menuText = () => document.body.textContent ?? '';
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
  resetServerPermissionsCache();
  // The viewer owns the space; the legacy labels below deliberately disagree
  // with the real permissions in the tests that are about that
  servers = [{ id: 'srv-1', ownerId: 'me' }];
  roles = [lowRole, midRole, highRole];
  channels = [];
  spaceBits = ALL_PERMISSIONS;
  channelBits = null;
  V.channelUsers = new Map();
  V.activeChannelId = null;
  members = [member('me', 'owner', 'Me'), member('u-2', 'member', 'Bob'), member('u-3', 'admin', 'Cy')];
  S.kickMember.mockResolvedValue(undefined);
  S.fetchEffectivePermissions.mockImplementation((_srv: string, channelId?: string) =>
    Promise.resolve((channelId && channelBits !== null ? channelBits : spaceBits).toString()));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const bob = () => members.find((m) => m.userId === 'u-2')!;

describe('MemberContextMenu — remove and ban', () => {
  it('the first click opens the reason panel; the confirm sends the TRIMMED reason, toasts and closes', async () => {
    await render(bob());
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
    await render(bob());
    await openPanel();
    await act(async () => {
      q('[data-testid="menu-ban-reason"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(S.kickMember).toHaveBeenCalledWith('srv-1', 'u-2', undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the panel and forgets the typed reason', async () => {
    await render(bob());
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
    await render(bob());
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
    await render(bob());
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
    await render(bob());
    await openPanel();
    await act(async () => { setValue(q('[data-testid="menu-ban-reason"]') as HTMLInputElement, `spam${String.fromCharCode(0x202e)}`); });
    await act(async () => { q('[data-testid="menu-remove-and-ban-submit"]')!.click(); });
    expect(S.kickMember).not.toHaveBeenCalled();
    expect(S.toastError).toHaveBeenCalledWith('serverErrors.reasonUnsupportedChars');
    expect(q('[data-testid="menu-remove-and-ban-confirm"]')).not.toBeNull();
  });

  it('the owner is offered no removal of themselves; every other member can be removed', async () => {
    await render(member('me', 'owner', 'Me'));
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull();
    await render(member('u-3', 'admin', 'Cy'));
    expect(q('[data-testid="menu-remove-and-ban"]')).not.toBeNull();
  });
});

describe('MemberContextMenu — the controls follow the real permissions, not the legacy label', () => {
  /** The viewer is a plain legacy "member" whose custom role (position 5) carries `bits`. */
  function viewerWithRole(bits: bigint, position = 5) {
    const mine = role('mine', position, bits);
    roles = [lowRole, mine, highRole, midRole];
    servers = [{ id: 'srv-1', ownerId: 'owner-id' }];
    spaceBits = bits;
    members = [
      member('me', 'member', 'Me', [mine]),
      member('u-low', 'member', 'Low', [lowRole]),
      member('u-none', 'member', 'None'),
      member('u-equal', 'member', 'Equal', [midRole]),
      member('u-high', 'member', 'High', [highRole]),
      member('owner-id', 'owner', 'Owner'),
    ];
    return mine;
  }
  const target = (id: string) => members.find((m) => m.userId === id)!;

  it('KICK_MEMBERS alone: Remove and ban on lower-ranked members, not on an equal or higher one, nor the owner', async () => {
    viewerWithRole(Permissions.KICK_MEMBERS);
    for (const id of ['u-low', 'u-none']) {
      await render(target(id));
      expect(q('[data-testid="menu-remove-and-ban"]'), id).not.toBeNull();
    }
    for (const id of ['u-equal', 'u-high', 'owner-id', 'me']) {
      await render(target(id));
      expect(q('[data-testid="menu-remove-and-ban"]'), id).toBeNull();
    }
  });

  it('a legacy "admin" and a legacy "owner" label without the bits see nothing at all', async () => {
    for (const legacy of ['admin', 'owner'] as const) {
      viewerWithRole(0n);
      members[0] = member('me', legacy, 'Me');
      resetServerPermissionsCache();
      await render(target('u-low'));
      expect(document.body.querySelector('[class*="fixed"]'), legacy).toBeNull();
      expect(menuText()).toBe('');
    }
  });

  it('without the KICK_MEMBERS bit there is no removal even for the lowest target', async () => {
    viewerWithRole(ALL_PERMISSIONS & ~Permissions.KICK_MEMBERS & ~Permissions.ADMINISTRATOR);
    await render(target('u-none'));
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull();
  });

  it('MANAGE_ROLES alone: the role list holds only roles below the viewer, and only for lower-ranked members', async () => {
    viewerWithRole(Permissions.MANAGE_ROLES);
    await render(target('u-low'));
    expect(menuText()).toContain('contextMenu.roles');
    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('contextMenu.roles'))!.click();
    });
    const offered = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent);
    expect(offered).toContain('low');
    expect(offered).not.toContain('mid');
    expect(offered).not.toContain('high');
    expect(offered).not.toContain('mine');

    await render(target('u-equal'));
    expect(menuText()).not.toContain('contextMenu.roles');
    await render(target('u-high'));
    expect(menuText()).not.toContain('contextMenu.roles');
    await render(target('owner-id'));
    expect(menuText()).not.toContain('contextMenu.roles');
  });

  it('MANAGE_NICKNAMES alone: Set nickname on lower-ranked members only', async () => {
    viewerWithRole(Permissions.MANAGE_NICKNAMES);
    await render(target('u-low'));
    expect(menuText()).toContain('contextMenu.setNickname');
    await render(target('u-equal'));
    expect(menuText()).not.toContain('contextMenu.setNickname');
    await render(target('u-high'));
    expect(menuText()).not.toContain('contextMenu.setNickname');
    await render(target('owner-id'));
    expect(menuText()).not.toContain('contextMenu.setNickname');
  });

  it('the viewer\'s own nickname follows CHANGE_NICKNAME, the owner included', async () => {
    viewerWithRole(Permissions.CHANGE_NICKNAME);
    await render(target('me'));
    expect(menuText()).toContain('contextMenu.editNickname');

    viewerWithRole(Permissions.MANAGE_NICKNAMES);
    resetServerPermissionsCache();
    await render(target('me'));
    expect(menuText()).toBe('');

    // The owner has every bit: their own nickname is editable too (an ownership
    // transfer moves the stored label with it, which is what refetches the bits)
    servers = [{ id: 'srv-1', ownerId: 'me' }];
    members[0] = member('me', 'owner', 'Me');
    spaceBits = ALL_PERMISSIONS;
    resetServerPermissionsCache();
    await render(member('me', 'member', 'Me'));
    expect(menuText()).toContain('contextMenu.editNickname');
  });

  describe('voice moderation', () => {
    function inVoice(...ids: string[]) {
      channels = [voiceChannel('v1'), voiceChannel('v2'), voiceChannel('v-secure', { secure: true })];
      V.channelUsers = new Map([['v1', ids.map(voiceUser)]]);
      V.activeChannelId = 'v1';
    }

    /** A call in ANOTHER space: channelUsers covers every space, `channels` only the viewed one. */
    function inOtherSpaceCall(...ids: string[]) {
      channels = [voiceChannel('v2')];
      V.channelUsers = new Map([['v-other', ids.map(voiceUser)]]);
      V.activeChannelId = 'v-other';
    }
    const channelRequests = () => S.fetchEffectivePermissions.mock.calls.filter((c) => c[1] !== undefined);

    it('a target in a call of ANOTHER space gets none of Mute, Deafen and Move, for a moderator and for the owner, and no channel request is made', async () => {
      viewerWithRole(Permissions.MUTE_MEMBERS | Permissions.DEAFEN_MEMBERS | Permissions.MOVE_MEMBERS);
      inOtherSpaceCall('me', 'u-low');
      await render(target('u-low'));
      expect(menuText()).not.toMatch(/muteServer|deafenServer|moveToChannel/);
      expect(channelRequests()).toEqual([]);

      servers = [{ id: 'srv-1', ownerId: 'me' }];
      members[0] = member('me', 'owner', 'Me');
      spaceBits = ALL_PERMISSIONS;
      resetServerPermissionsCache();
      await render(target('u-low'));
      expect(menuText()).not.toMatch(/muteServer|deafenServer|moveToChannel/);
      expect(channelRequests()).toEqual([]);
    });

    it('makes no channel request for a secure voice channel', async () => {
      viewerWithRole(Permissions.MUTE_MEMBERS);
      channels = [voiceChannel('v-secure', { secure: true })];
      V.channelUsers = new Map([['v-secure', [voiceUser('me'), voiceUser('u-low')]]]);
      V.activeChannelId = 'v-secure';
      await render(target('u-low'));
      expect(channelRequests()).toEqual([]);
      expect(menuText()).toBe('');
    });

    it('the owner and an ADMINISTRATOR holder have Mute and Deafen without waiting for, or surviving the failure of, the channel request', async () => {
      viewerWithRole(ALL_PERMISSIONS);
      servers = [{ id: 'srv-1', ownerId: 'me' }];
      inVoice('me', 'u-low');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
      await render(target('u-low'));
      expect(menuText()).toContain('contextMenu.muteServer');
      expect(menuText()).toContain('contextMenu.deafenServer');
      expect(channelRequests()).toEqual([]);

      servers = [{ id: 'srv-1', ownerId: 'owner-id' }];
      S.fetchEffectivePermissions.mockImplementation((_s: string, channelId?: string) =>
        channelId ? Promise.reject(new Error('offline')) : Promise.resolve(Permissions.ADMINISTRATOR.toString()));
      const adminRole = role('mine', 5, Permissions.ADMINISTRATOR);
      roles = [lowRole, adminRole, highRole];
      members[0] = member('me', 'member', 'Me', [adminRole]);
      resetServerPermissionsCache();
      await render(target('u-low'));
      expect(menuText()).toContain('contextMenu.muteServer');
      expect(menuText()).toContain('contextMenu.deafenServer');
      expect(channelRequests()).toEqual([]);
      warn.mockRestore();
    });

    it('a moderator Mute appears when the channel answer arrives, and the menu is placed again for its new height', async () => {
      viewerWithRole(Permissions.KICK_MEMBERS | Permissions.MUTE_MEMBERS);
      inVoice('me', 'u-low');
      const both = (Permissions.KICK_MEMBERS | Permissions.MUTE_MEMBERS).toString();
      let release!: (bits: string) => void;
      S.fetchEffectivePermissions.mockImplementation((_s: string, channelId?: string) =>
        channelId ? new Promise<string>((resolve) => { release = resolve; }) : Promise.resolve(both));
      const innerHeight = window.innerHeight;
      Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => {
        const grown = (document.body.textContent ?? '').includes('contextMenu.muteServer');
        return { width: 100, height: grown ? 200 : 100, top: 0, left: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
      try {
        await act(async () => { root.render(<MemberContextMenu member={target('u-low')} position={{ x: 10, y: 150 }} onClose={onClose} />); });
        await flush();
        const menu = () => document.body.querySelector('.fixed.z-\\[9999\\]') as HTMLElement;
        expect(menuText()).not.toContain('contextMenu.muteServer');
        expect(menu().style.top).toBe('150px');
        await act(async () => { release(both); });
        await flush();
        expect(menuText()).toContain('contextMenu.muteServer');
        expect(menu().style.top).toBe('92px'); // 300 - 200 - 8
      } finally {
        rect.mockRestore();
        Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
      }
    });

    it('Move is not offered for a member who is not in voice, although the space has voice channels', async () => {
      viewerWithRole(Permissions.MOVE_MEMBERS);
      channels = [voiceChannel('v1'), voiceChannel('v2')];
      V.channelUsers = new Map([['v1', [voiceUser('someone-else')]]]);
      await render(target('u-low'));
      expect(menuText()).toBe('');
    });

    it('MUTE_MEMBERS alone: only Mute, for a lower-ranked member in the viewer\'s own voice channel', async () => {
      viewerWithRole(Permissions.MUTE_MEMBERS);
      inVoice('me', 'u-low', 'u-equal', 'u-high');
      await render(target('u-low'));
      expect(S.fetchEffectivePermissions).toHaveBeenCalledWith('srv-1', 'v1');
      expect(menuText()).toContain('contextMenu.muteServer');
      expect(menuText()).not.toContain('contextMenu.deafenServer');
      expect(menuText()).not.toContain('contextMenu.moveToChannel');
      await render(target('u-equal'));
      expect(menuText()).not.toContain('contextMenu.muteServer');
      await render(target('u-high'));
      expect(menuText()).not.toContain('contextMenu.muteServer');
    });

    it('DEAFEN_MEMBERS alone: only Deafen', async () => {
      viewerWithRole(Permissions.DEAFEN_MEMBERS);
      inVoice('me', 'u-low');
      await render(target('u-low'));
      expect(menuText()).toContain('contextMenu.deafenServer');
      expect(menuText()).not.toContain('contextMenu.muteServer');
    });

    it('mute and deafen are read at the voice channel: an override that denies the bit there hides them', async () => {
      viewerWithRole(Permissions.MUTE_MEMBERS | Permissions.DEAFEN_MEMBERS);
      channelBits = Permissions.DEAFEN_MEMBERS; // the channel denies MUTE_MEMBERS
      inVoice('me', 'u-low');
      await render(target('u-low'));
      expect(menuText()).not.toContain('contextMenu.muteServer');
      expect(menuText()).toContain('contextMenu.deafenServer');
    });

    it('no mute or deafen when the viewer is not in the member\'s voice channel, or for oneself', async () => {
      viewerWithRole(Permissions.MUTE_MEMBERS | Permissions.DEAFEN_MEMBERS);
      inVoice('me', 'u-low');
      V.activeChannelId = null;
      await render(target('u-low'));
      expect(menuText()).toBe('');
      V.activeChannelId = 'v1';
      await render(target('me'));
      expect(menuText()).toBe('');
    });

    it('no mute or deafen inside a secure voice channel, whatever the effective-permissions answer says', async () => {
      viewerWithRole(ALL_PERMISSIONS);
      servers = [{ id: 'srv-1', ownerId: 'me' }]; // the owner: the answer says every bit
      channels = [voiceChannel('v-secure', { secure: true }), voiceChannel('v2')];
      V.channelUsers = new Map([['v-secure', [voiceUser('me'), voiceUser('u-low')]]]);
      V.activeChannelId = 'v-secure';
      await render(target('u-low'));
      expect(menuText()).not.toContain('contextMenu.muteServer');
      expect(menuText()).not.toContain('contextMenu.deafenServer');
    });

    it('MOVE_MEMBERS alone: Move to channel for a lower-ranked member in any voice channel, never out of a secure one', async () => {
      viewerWithRole(Permissions.MOVE_MEMBERS);
      inVoice('u-low', 'u-high');
      V.activeChannelId = null; // cross-channel: the viewer need not be there
      await render(target('u-low'));
      expect(menuText()).toContain('contextMenu.moveToChannel');
      expect(menuText()).not.toContain('contextMenu.muteServer');
      await render(target('u-high'));
      expect(menuText()).not.toContain('contextMenu.moveToChannel');
      V.channelUsers = new Map([['v-secure', [voiceUser('u-low')]]]);
      await render(target('u-low'));
      expect(menuText()).not.toContain('contextMenu.moveToChannel');
    });

    it('the destinations leave out the member\'s own channel and every secure voice channel', async () => {
      viewerWithRole(Permissions.MOVE_MEMBERS);
      inVoice('u-low');
      await render(target('u-low'));
      await act(async () => {
        Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('contextMenu.moveToChannel'))!.click();
      });
      const names = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent);
      expect(names).toContain('v2');
      expect(names).not.toContain('v1');
      expect(names).not.toContain('v-secure');
    });
  });

  it('the owner of the space (Server.ownerId) has the controls at once, and keeps them when the permissions fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewerWithRole(0n);
    servers = [{ id: 'srv-1', ownerId: 'me' }];
    S.fetchEffectivePermissions.mockRejectedValue(new Error('offline'));
    await render(target('u-high')); // above the viewer's role, but the owner is above everyone
    expect(q('[data-testid="menu-remove-and-ban"]')).not.toBeNull();
    await render(target('me'));
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull();
    warn.mockRestore();
  });

  it('your own nickname can always be cleared, only setting one needs CHANGE_NICKNAME', async () => {
    viewerWithRole(0n);
    const named = { ...target('me'), nickname: 'Moo' };
    await render(named);
    expect(menuText()).toContain('contextMenu.clearNickname');
    expect(menuText()).not.toContain('contextMenu.editNickname');
    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'contextMenu.clearNickname')!.click();
    });
    expect(S.setNickname).toHaveBeenCalledWith('srv-1', null);
    // no nickname, nothing to clear and nothing to set
    await render(target('me'));
    expect(menuText()).toBe('');
  });

  it('Clear nickname is not offered on ANOTHER member who has a nickname, to a viewer without MANAGE_NICKNAMES', async () => {
    viewerWithRole(Permissions.KICK_MEMBERS);
    await render({ ...target('u-low'), nickname: 'Lowly' });
    expect(menuText()).not.toContain('contextMenu.clearNickname');
    expect(menuText()).not.toContain('contextMenu.setNickname');
  });

  it('Set nickname on another member is not offered to a holder of CHANGE_NICKNAME only', async () => {
    viewerWithRole(Permissions.CHANGE_NICKNAME);
    await render(target('u-low'));
    expect(menuText()).toBe('');
  });

  it('no Roles entry when the viewer has nothing below their own position to hand out', async () => {
    viewerWithRole(Permissions.MANAGE_ROLES, 1);
    await render(target('u-none'));
    expect(menuText()).not.toContain('contextMenu.roles');
  });

  it('Roles on the viewer OWN row: offered to the owner, hidden for everyone else', async () => {
    viewerWithRole(Permissions.MANAGE_ROLES);
    await render(target('me'));
    expect(menuText()).not.toContain('contextMenu.roles');

    servers = [{ id: 'srv-1', ownerId: 'me' }];
    members[0] = member('me', 'owner', 'Me');
    spaceBits = ALL_PERMISSIONS;
    resetServerPermissionsCache();
    await render(target('me'));
    expect(menuText()).toContain('contextMenu.roles');
  });

  it('a role edit that grants the bit shows the control without any role being reassigned', async () => {
    const mine = viewerWithRole(0n);
    spaceBits = 0n;
    await render(target('u-low'));
    expect(q('[data-testid="menu-remove-and-ban"]')).toBeNull();

    // Another admin adds KICK_MEMBERS to the viewer's role: the member rows are untouched
    roles = roles.map((r) => (r.id === mine.id ? { ...r, permissions: Permissions.KICK_MEMBERS.toString() } : r));
    spaceBits = Permissions.KICK_MEMBERS;
    await render(target('u-low'));
    expect(q('[data-testid="menu-remove-and-ban"]')).not.toBeNull();
    expect(members[0].roles).toHaveLength(1);
  });
});
