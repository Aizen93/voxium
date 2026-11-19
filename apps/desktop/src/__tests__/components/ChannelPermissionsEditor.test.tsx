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

import { ChannelPermissionsEditor } from '../../components/server/ChannelPermissionsEditor';

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

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
