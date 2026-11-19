import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';

/**
 * The viewer's bits as the role and override writes judge them: the owner
 * holds every bit, anyone else what the server says (useServerPermissions),
 * null while unknown; and `mayTurnOn` restricts nothing while unknown.
 */

const state = vi.hoisted(() => ({
  userId: 'u1' as string | undefined,
  ownerId: 'someone-else',
  serverBits: null as bigint | null,
  asked: [] as Array<[string | null | undefined, string | undefined]>,
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: <T,>(sel: (s: { user: { id: string } | null }) => T) => sel({ user: state.userId ? { id: state.userId } : null }),
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: <T,>(sel: (s: { servers: Array<{ id: string; ownerId: string }> }) => T) => sel({ servers: [{ id: 's1', ownerId: state.ownerId }] }),
}));
vi.mock('../../hooks/useServerPermissions', () => ({
  useServerPermissions: (serverId: string | null | undefined, userId: string | undefined) => {
    state.asked.push([serverId, userId]);
    return state.serverBits;
  },
}));

import { useViewerPermissions, mayTurnOn } from '../../hooks/useViewerPermissions';

let root: Root;
let container: HTMLDivElement;
let seen: bigint | null | 'unset' = 'unset';
function Probe() {
  seen = useViewerPermissions('s1');
  return null;
}
function read(): bigint | null {
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(<Probe />));
  return seen as bigint | null;
}

afterEach(() => {
  act(() => root.unmount());
  state.userId = 'u1';
  state.ownerId = 'someone-else';
  state.serverBits = null;
  state.asked = [];
  seen = 'unset';
});

describe('useViewerPermissions', () => {
  it('the space\'s owner holds every bit, whatever the server answer says', () => {
    state.ownerId = 'u1';
    state.serverBits = Permissions.VIEW_CHANNEL;
    expect(read()).toBe(ALL_PERMISSIONS);
  });

  it('anyone else: the effective server permissions of the signed-in user in that space', () => {
    state.serverBits = Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES;
    expect(read()).toBe(Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES);
    expect(state.asked[0]).toEqual(['s1', 'u1']);
  });

  it('null while they are not known', () => {
    expect(read()).toBeNull();
  });

  it('nobody signed in is never the owner', () => {
    state.userId = undefined;
    state.ownerId = undefined as unknown as string;
    expect(read()).toBeNull();
  });
});

describe('mayTurnOn', () => {
  it('a held bit, or ADMINISTRATOR, may be turned on; another may not', () => {
    expect(mayTurnOn(Permissions.SEND_MESSAGES, Permissions.SEND_MESSAGES)).toBe(true);
    expect(mayTurnOn(Permissions.ADMINISTRATOR, Permissions.KICK_MEMBERS)).toBe(true);
    expect(mayTurnOn(Permissions.SEND_MESSAGES, Permissions.KICK_MEMBERS)).toBe(false);
  });

  it('bits not known yet restrict nothing', () => {
    expect(mayTurnOn(null, Permissions.KICK_MEMBERS)).toBe(true);
  });
});
