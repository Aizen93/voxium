import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

const roles: Role[] = [
  { id: 'r-mod', serverId: 's1', name: 'Moderator', color: '#ff0000', position: 1, permissions: '0', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'r-everyone', serverId: 's1', name: '@everyone', color: null, position: 0, permissions: '0', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
];

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<RoleEditor serverId="s1" roles={roles} canManageRoles />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
