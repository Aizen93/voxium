import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';

/**
 * A channel override can only carry flags the server keeps in an override
 * mask. ADMINISTRATOR, CREATE_SECURE_CHANNELS and MANAGE_WEBHOOKS are stripped
 * from every override server-side (server-level only), so the editor must not
 * offer a tri-state for them: one would look saved and silently do nothing.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

// One stable state object: the editor's effects depend on the selected
// functions and the roles array, so fresh references per read would loop
const serverState = vi.hoisted(() => ({
  roles: [
    { id: 'r-everyone', serverId: 's1', name: '@everyone', color: null, position: 0, permissions: '0', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  fetchChannelPermissions: vi.fn(async () => []),
  setChannelPermissionOverride: vi.fn(async () => {}),
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

// The viewer's server permissions and rank (null: not known yet, which
// restricts nothing; Infinity: the space's owner)
const viewer = vi.hoisted(() => ({ bits: null as bigint | null, rank: null as number | null }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: () => undefined }));
vi.mock('../../hooks/useViewerPermissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useViewerPermissions')>()),
  useViewerPermissions: () => viewer.bits,
  useViewerRolePosition: () => viewer.rank,
}));

import { AxiosError, type AxiosResponse } from 'axios';
import { ChannelPermissionsEditor } from '../../components/server/ChannelPermissionsEditor';
import { toast } from '../../stores/toastStore';

let container: HTMLDivElement;
let root: Root;

async function render(channelType: 'text' | 'voice') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // async act: lets the mount fetch (overrides) resolve and the loader go
  await act(async () => {
    root.render(
      <ChannelPermissionsEditor
        serverId="s1"
        channelId="ch-1"
        channelName="general"
        channelType={channelType}
        onClose={() => {}}
      />,
    );
  });
}

const ONLY_EVERYONE = serverState.roles;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  viewer.bits = null;
  viewer.rank = null;
  serverState.roles = ONLY_EVERYONE;
});

const offered = (key: string) => (container.textContent ?? '').includes(`permissions.${key}.name`);

describe('ChannelPermissionsEditor — what a channel override may carry', () => {
  it.each(['text', 'voice'] as const)('a %s channel offers no row for the server-level-only flags', async (type) => {
    await render(type);
    expect(serverState.fetchChannelPermissions).toHaveBeenCalledWith('s1', 'ch-1');
    // the permission grid rendered (a general flag both channel types share)
    expect(offered('VIEW_CHANNEL')).toBe(true);
    expect(offered('MANAGE_WEBHOOKS')).toBe(false);
    expect(offered('CREATE_SECURE_CHANNELS')).toBe(false);
    expect(offered('ADMINISTRATOR')).toBe(false);
  });

  it('a text channel offers SEND_MESSAGES', async () => {
    await render('text');
    expect(offered('SEND_MESSAGES')).toBe(true);
  });
});

/**
 * A save never carries a bit this build does not know, and never removes one
 * (#75): the editor holds the bits it knows, and a save is always the PUT
 * (the store adds `knownPermissions`, serverStoreRoleWrites.test.ts); the
 * store has no DELETE action any more.
 */
describe('ChannelPermissionsEditor — what a save sends', () => {
  // A bit no flag uses yet: a permission added after this build
  const FUTURE = 1n << 22n;
  const stored = (allow: bigint, deny: bigint) => [{ id: 'o1', channelId: 'ch-1', roleId: 'r-everyone', allow: String(allow), deny: String(deny) }];
  const footer = () => container.textContent ?? '';
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
  /** Cycle the tri-state of a row once (inherit → allow → deny → inherit). */
  function cycle(key: string) {
    const name = [...container.querySelectorAll('p')].find((p) => p.textContent === `permissions.${key}.name`)!;
    const row = name.closest('.group') as HTMLElement;
    act(() => (row.querySelector('button') as HTMLButtonElement).click());
  }
  async function save() {
    await act(async () => button('common.save').click());
  }

  afterEach(() => vi.clearAllMocks());

  it('an override holding a bit this build does not know opens with no unsaved changes', async () => {
    serverState.fetchChannelPermissions.mockResolvedValueOnce(stored(Permissions.VIEW_CHANNEL | FUTURE, FUTURE << 1n) as never);
    await render('text');
    expect(footer()).toContain('roles.noUnsavedChanges');
    expect(button('common.save').disabled).toBe(true);
  });

  it('a change sends the bits this build knows, never the unknown one', async () => {
    serverState.fetchChannelPermissions.mockResolvedValueOnce(stored(Permissions.VIEW_CHANNEL | FUTURE, 0n) as never);
    await render('text');
    cycle('SEND_MESSAGES'); // inherit → allow

    await save();

    expect(serverState.setChannelPermissionOverride).toHaveBeenCalledWith(
      's1', 'ch-1', 'r-everyone',
      String(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES),
      '0',
    );
  });

  it('clearing everything it shows is a write of 0/0, never the DELETE route (the server keeps what it does not show)', async () => {
    serverState.fetchChannelPermissions.mockResolvedValueOnce(stored(Permissions.VIEW_CHANNEL | FUTURE, 0n) as never);
    await render('text');
    cycle('VIEW_CHANNEL'); // allow → deny
    cycle('VIEW_CHANNEL'); // deny → inherit

    await save();

    expect(serverState.setChannelPermissionOverride).toHaveBeenCalledWith('s1', 'ch-1', 'r-everyone', '0', '0');
    expect(serverState.setChannelPermissionOverride).toHaveBeenCalledTimes(1);
  });

  it('a role with no override and nothing set sends nothing', async () => {
    await render('text');
    cycle('SEND_MESSAGES'); // inherit → allow
    cycle('SEND_MESSAGES'); // allow → deny
    cycle('SEND_MESSAGES'); // deny → inherit
    expect(button('common.save').disabled).toBe(true);
    expect(serverState.setChannelPermissionOverride).not.toHaveBeenCalled();
  });
});

/**
 * The editor shows what the server will refuse: a save that turns on, in
 * allow or in deny, a bit its author does not hold. A bit the viewer lacks
 * that the stored override leaves as inherit cannot move (disabled, with the
 * refusal as its title); one stored as allow or deny moves between that state
 * and inherit only. A failed save shows the server's reason.
 */
describe('ChannelPermissionsEditor — a toggle the server would refuse', () => {
  const stored = (allow: bigint, deny: bigint) => [{ id: 'o1', channelId: 'ch-1', roleId: 'r-everyone', allow: String(allow), deny: String(deny) }];
  const toggleOf = (key: string) => {
    const name = [...container.querySelectorAll('p')].find((p) => p.textContent === `permissions.${key}.name`)!;
    return (name.closest('.group') as HTMLElement).querySelector('button') as HTMLButtonElement;
  };
  /** The state a toggle shows, read from its title ("... <state>. ..."). */
  const stateOf = (key: string) => /current (\w+)\./.exec(toggleOf(key).title)?.[1];
  const click = (key: string) => act(() => toggleOf(key).click());
  const save = () => act(async () => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'common.save') as HTMLButtonElement).click());

  afterEach(() => vi.clearAllMocks());

  it('a bit the viewer lacks, stored as inherit: disabled, titled with the refusal, does not move', async () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES;
    await render('text');
    const kick = toggleOf('KICK_MEMBERS');
    expect(kick.disabled).toBe(true);
    expect(kick.title).toBe('serverErrors.cannotOverrideUnheldPermissions');
    click('KICK_MEMBERS');
    expect(toggleOf('KICK_MEMBERS').title).toBe('serverErrors.cannotOverrideUnheldPermissions');
    expect(container.textContent ?? '').toContain('roles.noUnsavedChanges');
  });

  it('a bit the viewer holds cycles inherit, allow, deny, inherit', async () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES;
    await render('text');
    expect(toggleOf('SEND_MESSAGES').disabled).toBe(false);
    expect(stateOf('SEND_MESSAGES')).toBe('inherit');
    click('SEND_MESSAGES');
    expect(stateOf('SEND_MESSAGES')).toBe('allow');
    click('SEND_MESSAGES');
    expect(stateOf('SEND_MESSAGES')).toBe('deny');
    click('SEND_MESSAGES');
    expect(stateOf('SEND_MESSAGES')).toBe('inherit');
  });

  it('a bit the viewer lacks, stored as allow: usable, moves between allow and inherit only (never to deny)', async () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES;
    serverState.fetchChannelPermissions.mockResolvedValueOnce(stored(Permissions.KICK_MEMBERS, 0n) as never);
    await render('text');
    expect(toggleOf('KICK_MEMBERS').disabled).toBe(false);
    expect(stateOf('KICK_MEMBERS')).toBe('allow');
    click('KICK_MEMBERS');
    expect(stateOf('KICK_MEMBERS')).toBe('inherit');
    click('KICK_MEMBERS');
    expect(stateOf('KICK_MEMBERS')).toBe('allow');
  });

  it('a bit the viewer lacks, stored as deny: moves between deny and inherit only (never to allow), and the removal is saved', async () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES;
    serverState.fetchChannelPermissions.mockResolvedValueOnce(stored(0n, Permissions.KICK_MEMBERS) as never);
    await render('text');
    expect(stateOf('KICK_MEMBERS')).toBe('deny');
    click('KICK_MEMBERS');
    expect(stateOf('KICK_MEMBERS')).toBe('inherit');
    click('KICK_MEMBERS');
    expect(stateOf('KICK_MEMBERS')).toBe('deny');
    click('KICK_MEMBERS');
    await save();
    expect(serverState.setChannelPermissionOverride).toHaveBeenCalledWith('s1', 'ch-1', 'r-everyone', '0', '0');
  });

  it('a bit moved before the viewer bits were known can still go back to inherit, and then cannot move', async () => {
    viewer.bits = null;
    await render('text');
    click('KICK_MEMBERS');
    expect(stateOf('KICK_MEMBERS')).toBe('allow');
    // the bits arrive (any re-render reads them): KICK_MEMBERS is not held
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES;
    click('SEND_MESSAGES');
    expect(toggleOf('KICK_MEMBERS').disabled).toBe(false);
    click('KICK_MEMBERS');
    expect(toggleOf('KICK_MEMBERS').disabled).toBe(true);
    expect(toggleOf('KICK_MEMBERS').title).toBe('serverErrors.cannotOverrideUnheldPermissions');
  });

  it('bits not known yet: nothing disabled (the server still decides)', async () => {
    viewer.bits = null;
    await render('text');
    expect([...container.querySelectorAll('.group button')].some((b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });

  it('ADMINISTRATOR held: nothing disabled', async () => {
    viewer.bits = Permissions.ADMINISTRATOR;
    await render('text');
    expect([...container.querySelectorAll('.group button')].some((b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });

  it('a failed save shows the server\'s reason, translated', async () => {
    const refusal = { status: 403, statusText: 'Forbidden', headers: {}, config: {}, data: { success: false, error: 'Cannot set overrides for permissions you do not have' } } as unknown as AxiosResponse;
    serverState.setChannelPermissionOverride.mockRejectedValueOnce(new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', undefined, undefined, refusal) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render('text');
      click('SEND_MESSAGES');
      await save();
      expect(toast.error).toHaveBeenCalledWith('serverErrors.cannotOverrideUnheldPermissions');
    } finally {
      err.mockRestore();
    }
  });

  it('a failure with no server reason shows the editor\'s own line', async () => {
    const noReason = { status: 500, statusText: 'Error', headers: {}, config: {}, data: {} } as unknown as AxiosResponse;
    serverState.setChannelPermissionOverride.mockRejectedValueOnce(new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, noReason) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render('text');
      click('SEND_MESSAGES');
      await save();
      expect(toast.error).toHaveBeenCalledWith('channelPermissions.failedToSave');
    } finally {
      err.mockRestore();
    }
  });
});

/**
 * The server refuses every override write on a role at or above the
 * viewer's own highest one, never on @everyone (the owner stands above every
 * role), and serves the stored overrides to whoever views the channel. Such a
 * role stays selectable and readable: its list entry carries a lock titled
 * with that refusal, and its panel is locked (toggles and Save disabled with
 * the refusal, which the panel also states). While the viewer's rank is
 * unknown nothing is locked.
 */
describe('ChannelPermissionsEditor — a role at or above the viewer', () => {
  const role = (id: string, position: number) => ({
    id, serverId: 's1', name: id, color: null, position, permissions: '0', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z',
  });
  const RANKED = [...ONLY_EVERYONE, role('below', 2), role('same', 5), role('above', 9)];
  const REFUSAL = 'serverErrors.cannotSetHigherOverrides';
  const roleButton = (name: string) =>
    [...container.querySelectorAll('button')].find((b) => b.querySelector('span.truncate')?.textContent === name) as HTMLButtonElement;
  const locked = (name: string) => roleButton(name).querySelector('.lucide-lock') !== null;
  const selectedHeading = () => container.querySelector('h3')?.textContent;
  const toggles = () => [...container.querySelectorAll('.group button')] as HTMLButtonElement[];
  const toggleOf = (key: string) => {
    const name = [...container.querySelectorAll('p')].find((p) => p.textContent === `permissions.${key}.name`)!;
    return (name.closest('.group') as HTMLElement).querySelector('button') as HTMLButtonElement;
  };
  const saveButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'common.save') as HTMLButtonElement;
  const panelReason = () => container.querySelector('[data-testid="role-locked-reason"]')?.textContent ?? null;

  afterEach(() => vi.clearAllMocks());

  it('a viewer of rank 5: the roles at 5 and 9 carry a lock titled with the refusal and stay selectable; @everyone and the role below carry none', async () => {
    serverState.roles = RANKED;
    viewer.rank = 5;
    await render('text');

    for (const name of ['same', 'above']) {
      expect(roleButton(name).disabled).toBe(false);
      expect(roleButton(name).title).toBe(REFUSAL);
      expect(locked(name)).toBe(true);
    }
    for (const name of ['@everyone', 'below']) {
      expect(roleButton(name).disabled).toBe(false);
      expect(roleButton(name).title).toBe('');
      expect(locked(name)).toBe(false);
    }
    // a role below opens editable, with no reason shown
    act(() => roleButton('below').click());
    expect(selectedHeading()).toBe('below');
    expect(toggles().some((b) => b.disabled)).toBe(false);
    expect(panelReason()).toBeNull();
  });

  it('a role above the viewer opens and shows its stored override, read-only: every toggle and Save disabled with the refusal, the panel states it', async () => {
    serverState.roles = RANKED;
    viewer.rank = 5;
    serverState.fetchChannelPermissions.mockResolvedValueOnce([
      { id: 'o1', channelId: 'ch-1', roleId: 'above', allow: String(Permissions.SEND_MESSAGES), deny: String(Permissions.ATTACH_FILES) },
    ] as never);
    await render('text');

    act(() => roleButton('above').click());

    expect(selectedHeading()).toBe('above');
    // the stored override is read: SEND_MESSAGES allowed, ATTACH_FILES denied
    expect(toggleOf('SEND_MESSAGES').querySelector('.lucide-check')).not.toBeNull();
    expect(toggleOf('ATTACH_FILES').querySelector('.lucide-x')).not.toBeNull();
    expect(toggles().every((b) => b.disabled && b.title === REFUSAL)).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().title).toBe(REFUSAL);
    expect(panelReason()).toBe(REFUSAL);
    // a click on a locked toggle changes nothing
    act(() => toggleOf('SEND_MESSAGES').click());
    expect(container.textContent ?? '').toContain('roles.noUnsavedChanges');
    expect(serverState.setChannelPermissionOverride).not.toHaveBeenCalled();
  });

  it('@everyone is never locked, even for a viewer with no role (rank 0)', async () => {
    serverState.roles = RANKED;
    viewer.rank = 0;
    await render('text');

    expect(locked('@everyone')).toBe(false);
    expect(roleButton('@everyone').title).toBe('');
    expect(locked('below')).toBe(true);
    expect(roleButton('below').disabled).toBe(false);
  });

  it('the owner: no role is locked', async () => {
    serverState.roles = RANKED;
    viewer.rank = Infinity;
    await render('text');

    expect(RANKED.map((r) => locked(r.name))).toEqual([false, false, false, false]);
  });

  it('the rank not known yet: no role is locked (the server still decides)', async () => {
    serverState.roles = RANKED;
    viewer.rank = null;
    await render('text');

    expect(RANKED.map((r) => locked(r.name))).toEqual([false, false, false, false]);
    expect(RANKED.map((r) => roleButton(r.name).disabled)).toEqual([false, false, false, false]);
  });

  it('a role selected before the rank was known, at or above it once known: its toggles and Save are disabled with the refusal, Reset still works', async () => {
    serverState.roles = RANKED;
    viewer.rank = null;
    await render('text');
    act(() => roleButton('above').click());
    expect(selectedHeading()).toBe('above');
    const sendRow = () => {
      const name = [...container.querySelectorAll('p')].find((p) => p.textContent === 'permissions.SEND_MESSAGES.name')!;
      return (name.closest('.group') as HTMLElement).querySelector('button') as HTMLButtonElement;
    };
    act(() => sendRow().click()); // inherit → allow, before the rank arrived
    expect(saveButton().disabled).toBe(false);

    // the rank arrives (the next render reads it): below the selected role
    viewer.rank = 5;
    act(() => root.render(
      <ChannelPermissionsEditor serverId="s1" channelId="ch-1" channelName="general" channelType="text" onClose={() => {}} />,
    ));

    expect(selectedHeading()).toBe('above');
    expect(toggles().every((b) => b.disabled && b.title === 'serverErrors.cannotSetHigherOverrides')).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().title).toBe('serverErrors.cannotSetHigherOverrides');
    const reset = [...container.querySelectorAll('button')].find((b) => b.textContent === 'common.reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    act(() => reset.click());
    expect(container.textContent ?? '').toContain('roles.noUnsavedChanges');
    expect(serverState.setChannelPermissionOverride).not.toHaveBeenCalled();
  });
});
