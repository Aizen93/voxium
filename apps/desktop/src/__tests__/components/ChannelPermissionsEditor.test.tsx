import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
  deleteChannelPermissionOverride: vi.fn(async () => {}),
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
