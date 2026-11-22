import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Role } from '@voxium/shared';

/**
 * MANAGE_WEBHOOKS is a server-level permission: a role grants it (the
 * Integrations tab keys on it), so the role editor must offer it — in the
 * general category, next to the other server-management flags.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

vi.mock('../../stores/serverStore', () => {
  const state = { createRole: vi.fn(), updateRole: vi.fn(), deleteRole: vi.fn() };
  const useServerStore = <T,>(sel?: (s: typeof state) => T) => (sel ? sel(state) : state);
  useServerStore.getState = () => state;
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

import { RoleEditor } from '../../components/server/RoleEditor';
import { useServerStore } from '../../stores/serverStore';

const roles: Role[] = [
  { id: 'r-mod', serverId: 's1', name: 'Moderator', color: '#ff0000', position: 1, permissions: '0', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'r-everyone', serverId: 's1', name: '@everyone', color: null, position: 0, permissions: '0', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
];

let container: HTMLDivElement;
let root: Root;

function render(list: Role[] = roles, canManageRoles = true) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<RoleEditor serverId="s1" roles={list} canManageRoles={canManageRoles} />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  viewer.bits = null;
  viewer.rank = null;
});

/** The category panel whose heading reads `label` (the heading's panel, not the whole grid). */
function categoryPanel(label: string): HTMLElement {
  const heading = [...container.querySelectorAll('h4')].find((h) => h.textContent === label);
  expect(heading, `no category heading ${label}`).toBeTruthy();
  const panel = heading!.closest('.rounded-lg') as HTMLElement | null;
  expect(panel).toBeTruthy();
  return panel!;
}

const rowLabels = (panel: HTMLElement) =>
  [...panel.querySelectorAll('label span')].map((s) => s.textContent);

describe('RoleEditor — the order of the list', () => {
  it('highest first, @everyone last, roles that share a position in one order whatever the order of the space\'s list', () => {
    const at = (id: string, position: number): Role => ({ ...roles[0], id, name: id, position });
    const list = [at('tie-a', 3), at('top', 8), roles[1], at('tie-b', 3), at('low', 1)];
    for (const given of [list, [...list].reverse()]) {
      render(given);
      expect([...container.querySelectorAll('button span.truncate')].map((s) => s.textContent))
        .toEqual(['top', 'tie-b', 'tie-a', 'low', '@everyone']);
      act(() => root.unmount());
      container.remove();
    }
    render();
  });
});

describe('RoleEditor — MANAGE_WEBHOOKS', () => {
  it('renders a row for MANAGE_WEBHOOKS under the general category, exactly once', () => {
    render();
    const general = categoryPanel('roles.categories.general');
    expect(rowLabels(general)).toContain('permissions.MANAGE_WEBHOOKS.name');
    expect(general.textContent).toContain('permissions.MANAGE_WEBHOOKS.description');
    // and nowhere else
    const everywhere = [...container.querySelectorAll('label span')]
      .filter((s) => s.textContent === 'permissions.MANAGE_WEBHOOKS.name');
    expect(everywhere).toHaveLength(1);
    expect(rowLabels(categoryPanel('roles.categories.membership'))).not.toContain('permissions.MANAGE_WEBHOOKS.name');
  });

  it('the row is a toggle the editor can flip (a checkbox, enabled for a manager)', () => {
    render();
    const span = [...container.querySelectorAll('label span')]
      .find((s) => s.textContent === 'permissions.MANAGE_WEBHOOKS.name')!;
    const checkbox = span.closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    act(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
  });
});

/**
 * A save never carries a bit this build does not know (#75): the editor holds
 * the bits it knows, compares and sends those only, and sends `permissions`
 * at all only when the user changed one. The store adds `knownPermissions`
 * (serverStoreRoleWrites.test.ts), and the server keeps every other bit.
 */
describe('RoleEditor — what a save sends', () => {
  // A bit no flag uses yet: a permission added after this build
  const FUTURE = 1n << 22n;
  const withFutureBit: Role[] = [
    { ...roles[0], permissions: String(Permissions.VIEW_CHANNEL | FUTURE) },
    roles[1],
  ];
  const updateRole = () => useServerStore.getState().updateRole as unknown as Mock;
  const unsavedBar = () => (container.textContent ?? '').includes('roles.unsavedChanges');
  const saveButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('settings.profile.saveChanges'));
  function typeInto(input: HTMLInputElement, value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function toggle(key: string) {
    const span = [...container.querySelectorAll('label span')].find((s) => s.textContent === `permissions.${key}.name`)!;
    act(() => (span.closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  }
  async function save() {
    await act(async () => saveButton()!.click());
  }

  it('a role holding a bit this build does not know opens with no unsaved changes', () => {
    render(withFutureBit);
    expect(unsavedBar()).toBe(false);
    expect(saveButton()).toBeUndefined();
  });

  it('a rename sends the name and no permissions', async () => {
    render(withFutureBit);
    typeInto(container.querySelector('input[type="text"]') as HTMLInputElement, 'Helpers');
    expect(unsavedBar()).toBe(true);

    await save();

    expect(updateRole()).toHaveBeenCalledTimes(1);
    expect(updateRole()).toHaveBeenCalledWith('s1', 'r-mod', { name: 'Helpers' });
  });

  it('a permission change sends the bits this build knows (the unknown one left to the server)', async () => {
    render(withFutureBit);
    toggle('SEND_MESSAGES');
    expect(unsavedBar()).toBe(true);

    await save();

    expect(updateRole()).toHaveBeenCalledWith('s1', 'r-mod', {
      permissions: String(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES),
    });
  });

  it('a permission toggled and toggled back is no change', () => {
    render(withFutureBit);
    toggle('SEND_MESSAGES');
    toggle('SEND_MESSAGES');
    expect(unsavedBar()).toBe(false);
  });
});

/**
 * The editor shows what the server will refuse: a save that turns on a bit
 * its author does not hold. Such a toggle, off in the stored role, is
 * disabled and says why; one the role holds stays usable (turning it off is
 * never refused, and back on within the same edit is no change).
 */
describe('RoleEditor — a toggle the server would refuse', () => {
  const holderOf = (perms: bigint): Role[] => [{ ...roles[0], permissions: String(perms) }, roles[1]];
  const row = (key: string) => {
    const span = [...container.querySelectorAll('label span')].find((el) => el.textContent === `permissions.${key}.name`)!;
    const label = span.closest('label') as HTMLLabelElement;
    return { label, box: label.querySelector('input[type="checkbox"]') as HTMLInputElement };
  };
  const updateRole = () => useServerStore.getState().updateRole as unknown as Mock;

  it('a bit the viewer lacks, off in the role: disabled, titled with the refusal', () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES;
    render(holderOf(Permissions.VIEW_CHANNEL));
    const kick = row('KICK_MEMBERS');
    expect(kick.box.disabled).toBe(true);
    expect(kick.label.title).toBe('serverErrors.cannotGrantPermissions');
    act(() => kick.box.click());
    expect(kick.box.checked).toBe(false);
  });

  it('a bit the viewer holds: usable, untitled', () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES;
    render(holderOf(Permissions.VIEW_CHANNEL));
    const send = row('SEND_MESSAGES');
    expect(send.box.disabled).toBe(false);
    expect(send.label.title).toBe('');
  });

  it('a bit the viewer lacks, on in the role: usable, off and back on, and its removal is saved', async () => {
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES;
    render(holderOf(Permissions.VIEW_CHANNEL | Permissions.KICK_MEMBERS));
    const kick = row('KICK_MEMBERS');
    expect(kick.box.disabled).toBe(false);
    expect(kick.label.title).toBe('');
    act(() => kick.box.click());
    expect(kick.box.checked).toBe(false);
    act(() => kick.box.click());
    expect(kick.box.checked).toBe(true);
    act(() => kick.box.click());
    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('settings.profile.saveChanges'))!;
    await act(async () => saveButton.click());
    expect(updateRole()).toHaveBeenCalledWith('s1', 'r-mod', { permissions: String(Permissions.VIEW_CHANNEL) });
  });

  it('a toggle switched on before the viewer bits were known stays usable until it is off again', () => {
    viewer.bits = null;
    render(holderOf(Permissions.VIEW_CHANNEL));
    act(() => row('KICK_MEMBERS').box.click());
    expect(row('KICK_MEMBERS').box.checked).toBe(true);
    // the bits arrive (any re-render reads them): KICK_MEMBERS is not held
    viewer.bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES;
    act(() => row('SEND_MESSAGES').box.click());
    expect(row('KICK_MEMBERS').box.disabled).toBe(false);
    act(() => row('KICK_MEMBERS').box.click());
    expect(row('KICK_MEMBERS').box.checked).toBe(false);
    expect(row('KICK_MEMBERS').box.disabled).toBe(true);
  });

  it('ADMINISTRATOR held means every toggle is usable', () => {
    viewer.bits = Permissions.ADMINISTRATOR;
    render(holderOf(0n));
    expect(row('KICK_MEMBERS').box.disabled).toBe(false);
    expect(row('ADMINISTRATOR').box.disabled).toBe(false);
  });

  it('every bit (the owner): nothing disabled', () => {
    viewer.bits = ALL_PERMISSIONS;
    render(holderOf(0n));
    expect([...container.querySelectorAll('input[type="checkbox"]')].some((box) => (box as HTMLInputElement).disabled)).toBe(false);
  });

  it('bits not known yet: nothing disabled (the server still decides)', () => {
    viewer.bits = null;
    render(holderOf(0n));
    expect([...container.querySelectorAll('input[type="checkbox"]')].some((box) => (box as HTMLInputElement).disabled)).toBe(false);
  });
});

/**
 * The server refuses a save and a delete of a role at or above the viewer's
 * own highest one, with no exemption for @everyone, and a creation by a
 * viewer whose highest position is 0. Such a role stays selectable and
 * opens read-only: its list entry carries a lock titled with the refusal,
 * the panel states it, every input and toggle is disabled, Save (for an edit
 * made before) and Delete are disabled with their reason. While the rank is
 * unknown nothing is locked.
 */
describe('RoleEditor — a role at or above the viewer', () => {
  const role = (id: string, position: number, isDefault = false): Role => ({
    id, serverId: 's1', name: id, color: null, position, permissions: String(Permissions.SEND_MESSAGES), isDefault, createdAt: '2026-01-01T00:00:00.000Z',
  });
  const RANKED: Role[] = [role('above', 9), role('same', 5), role('below', 2), { ...role('r-everyone', 0, true), name: '@everyone' }];
  const EDIT_REFUSAL = 'serverErrors.cannotEditHigherRole';
  const entry = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.querySelector('span.truncate')?.textContent === label) as HTMLButtonElement;
  const locked = (label: string) => entry(label).querySelector('.lucide-lock') !== null;
  const open = (label: string) => act(() => entry(label).click());
  const heading = () => container.querySelector('h3')?.textContent;
  const panelReason = () => container.querySelector('[data-testid="role-locked-reason"]')?.textContent ?? null;
  const boxes = () => [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  const textInputs = () => [...container.querySelectorAll('input[type="text"], input[type="color"]')] as HTMLInputElement[];
  const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
  const updateRole = () => useServerStore.getState().updateRole as unknown as Mock;

  it('a viewer of rank 5: the roles at 5 and 9 carry a lock titled with the refusal and stay selectable; the role below and @everyone do not', () => {
    viewer.rank = 5;
    render(RANKED);

    for (const label of ['above', 'same']) {
      expect(locked(label)).toBe(true);
      expect(entry(label).title).toBe(EDIT_REFUSAL);
      expect(entry(label).disabled).toBe(false);
    }
    for (const label of ['below', '@everyone']) {
      expect(locked(label)).toBe(false);
      expect(entry(label).title).toBe('');
    }
  });

  it('a role above the viewer opens read-only and readable: inputs and toggles disabled with the refusal, Delete disabled with its own', () => {
    viewer.rank = 5;
    render(RANKED);
    open('above');

    expect(heading()).toBe('above');
    expect(panelReason()).toBe(EDIT_REFUSAL);
    // its stored permissions are shown
    const send = boxes().find((b) => b.closest('label')!.textContent!.includes('permissions.SEND_MESSAGES.name'))!;
    expect(send.checked).toBe(true);
    expect(boxes().every((b) => b.disabled)).toBe(true);
    expect([...container.querySelectorAll('label[title]')].every((l) => l.getAttribute('title') === EDIT_REFUSAL)).toBe(true);
    expect(textInputs()).toHaveLength(3);
    expect(textInputs().every((i) => i.disabled && i.title === EDIT_REFUSAL)).toBe(true);
    const del = button('roles.deleteRole')!;
    expect(del.disabled).toBe(true);
    expect(del.title).toBe('serverErrors.cannotDeleteHigherRole');
    act(() => send.click());
    expect(send.checked).toBe(true);
    expect(button('settings.profile.saveChanges')).toBeUndefined();
  });

  it('a role below the viewer opens editable, with no reason shown', () => {
    viewer.rank = 5;
    render(RANKED);
    open('below');

    expect(panelReason()).toBeNull();
    expect(boxes().some((b) => b.disabled)).toBe(false);
    expect(textInputs().some((i) => i.disabled || i.title !== '')).toBe(false);
    expect(button('roles.deleteRole')!.disabled).toBe(false);
  });

  it('@everyone has no exemption: locked for a viewer with no role (rank 0), editable for one above it', () => {
    viewer.rank = 0;
    render(RANKED);
    expect(locked('@everyone')).toBe(true);
    open('@everyone');
    expect(panelReason()).toBe(EDIT_REFUSAL);
    expect(boxes().every((b) => b.disabled)).toBe(true);

    act(() => root.unmount());
    container.remove();
    viewer.rank = 1;
    render(RANKED);
    expect(locked('@everyone')).toBe(false);
  });

  it('a delete confirmation opened before the role became locked closes when it does, and does not come back when the lock lifts', async () => {
    const confirm = () => button('common.confirm');
    const rerender = () => act(() => root.render(<RoleEditor serverId="s1" roles={RANKED} canManageRoles />));
    render(RANKED);
    open('below');
    act(() => button('roles.deleteRole')!.click());
    expect(confirm()).toBeDefined();

    // the viewer's rank arrives: the role is at their own position
    viewer.rank = 2;
    rerender();
    expect(confirm()).toBeUndefined();
    expect(button('roles.deleteRole')!.disabled).toBe(true);

    // ranked above it again: the confirmation stays closed until asked for
    viewer.rank = 5;
    rerender();
    expect(confirm()).toBeUndefined();
    const del = button('roles.deleteRole')!;
    expect(del.disabled).toBe(false);
    await act(async () => del.click());
    await act(async () => confirm()!.click());
    expect(useServerStore.getState().deleteRole).toHaveBeenCalledWith('s1', 'below');
  });

  it('the owner, and a rank not known yet: nothing locked', () => {
    for (const rank of [Infinity, null]) {
      viewer.rank = rank;
      render(RANKED);
      expect(RANKED.map((r) => locked(r.isDefault ? '@everyone' : r.name))).toEqual([false, false, false, false]);
      open('above');
      expect(panelReason()).toBeNull();
      act(() => root.unmount());
      container.remove();
    }
    render(RANKED);
  });

  it('a viewer who may not manage roles sees no lock (the editor is read-only for them anyway)', () => {
    viewer.rank = 0;
    render(RANKED, false);
    expect(RANKED.map((r) => locked(r.isDefault ? '@everyone' : r.name))).toEqual([false, false, false, false]);
    expect(panelReason()).toBeNull();
  });

  it('an edit made before the rank was known, on a role then found above the viewer: Save disabled with the refusal, Reset undoes it', async () => {
    viewer.rank = null;
    render(RANKED);
    open('above');
    const typeInto = (input: HTMLInputElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    typeInto(container.querySelector('input[type="text"]') as HTMLInputElement, 'Renamed');
    expect(button('settings.profile.saveChanges')!.disabled).toBe(false);

    // the rank arrives (the next render reads it): below the open role
    viewer.rank = 5;
    act(() => root.render(<RoleEditor serverId="s1" roles={RANKED} canManageRoles />));

    const save = button('settings.profile.saveChanges')!;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe(EDIT_REFUSAL);
    await act(async () => save.click());
    expect(updateRole()).not.toHaveBeenCalled();
    act(() => button('common.reset')!.click());
    expect(button('settings.profile.saveChanges')).toBeUndefined();
  });

  it('Create: disabled with its reason for a viewer whose highest position is 0 (rank 0), usable otherwise', () => {
    const create = () => button('roles.createRole')!;
    const note = () => container.querySelector('[data-testid="role-create-refused"]')?.textContent ?? null;

    viewer.rank = 0;
    render(RANKED);
    expect(create().disabled).toBe(true);
    expect(create().title).toBe('serverErrors.cannotCreateRoleTooLow');
    expect(note()).toBe('serverErrors.cannotCreateRoleTooLow');

    for (const rank of [1, 5, Infinity, null]) {
      act(() => root.unmount());
      container.remove();
      viewer.rank = rank;
      render(RANKED);
      expect(create().disabled).toBe(false);
      expect(create().title).toBe('');
      expect(note()).toBeNull();
    }
  });
});
