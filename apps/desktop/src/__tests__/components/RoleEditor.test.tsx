import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
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

import { RoleEditor } from '../../components/server/RoleEditor';
import { useServerStore } from '../../stores/serverStore';

const roles: Role[] = [
  { id: 'r-mod', serverId: 's1', name: 'Moderator', color: '#ff0000', position: 1, permissions: '0', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'r-everyone', serverId: 's1', name: '@everyone', color: null, position: 0, permissions: '0', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
];

let container: HTMLDivElement;
let root: Root;

function render(list: Role[] = roles) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<RoleEditor serverId="s1" roles={list} canManageRoles />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
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
