import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Role } from '@voxium/shared';

/**
 * The viewer's bits as the role and override writes judge them: the owner
 * holds every bit, anyone else what the server says (useServerPermissions),
 * null while unknown; and `mayTurnOn` restricts nothing while unknown.
 */

type MemberRow = { userId: string; serverId: string; roles?: Array<Pick<Role, 'id' | 'position' | 'isDefault'>> };
const state = vi.hoisted(() => ({
  userId: 'u1' as string | undefined,
  ownerId: 'someone-else',
  serverBits: null as bigint | null,
  asked: [] as Array<[string | null | undefined, string | undefined]>,
  members: [] as MemberRow[],
  roles: [] as Array<Pick<Role, 'id' | 'position' | 'isDefault'>>,
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: <T,>(sel: (s: { user: { id: string } | null }) => T) => sel({ user: state.userId ? { id: state.userId } : null }),
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: <T,>(sel: (s: { servers: Array<{ id: string; ownerId: string }>; members: MemberRow[]; roles: typeof state.roles }) => T) =>
    sel({ servers: [{ id: 's1', ownerId: state.ownerId }], members: state.members, roles: state.roles }),
}));
vi.mock('../../hooks/useServerPermissions', () => ({
  useServerPermissions: (serverId: string | null | undefined, userId: string | undefined) => {
    state.asked.push([serverId, userId]);
    return state.serverBits;
  },
}));

import {
  useViewerPermissions,
  mayTurnOn,
  useViewerRolePosition,
  mayEditRoleOverrides,
  mayEditRole,
  mayCreateRole,
} from '../../hooks/useViewerPermissions';

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
  state.members = [];
  state.roles = [];
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

/**
 * The viewer's rank as the override writes judge it (getHighestRolePosition
 * on the server): Infinity for the owner, the highest assigned role's
 * position (from the store's current role list), 0 with none, null while
 * the member row of that space (with its roles) is not in the store.
 */
describe('useViewerRolePosition', () => {
  let rank: number | null | 'unset' = 'unset';
  function RankProbe() {
    rank = useViewerRolePosition('s1');
    return null;
  }
  function readRank(): number | null {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root.render(<RankProbe />));
    return rank as number | null;
  }
  const everyone = { id: 'r-everyone', position: 0, isDefault: true };

  it('the space\'s owner is above every role, with or without a member row', () => {
    state.ownerId = 'u1';
    expect(readRank()).toBe(Infinity);
  });

  it('a member: the highest position among their assigned roles, read from the space\'s current roles', () => {
    state.roles = [everyone, { id: 'r-mod', position: 7, isDefault: false }, { id: 'r-vip', position: 3, isDefault: false }];
    // the row carries an older copy of r-mod's position: the live list wins
    state.members = [{ userId: 'u1', serverId: 's1', roles: [{ id: 'r-mod', position: 2, isDefault: false }, { id: 'r-vip', position: 3, isDefault: false }, everyone] }];
    expect(readRank()).toBe(7);
  });

  it('a member with no role: 0', () => {
    state.roles = [everyone];
    state.members = [{ userId: 'u1', serverId: 's1', roles: [] }];
    expect(readRank()).toBe(0);
  });

  it('not known: no member row, a row of another space, or a row without its roles', () => {
    expect(readRank()).toBeNull();
    act(() => root.unmount());
    state.members = [{ userId: 'u1', serverId: 's2', roles: [] }];
    expect(readRank()).toBeNull();
    act(() => root.unmount());
    state.members = [{ userId: 'u1', serverId: 's1' }];
    expect(readRank()).toBeNull();
  });

  it('nobody signed in: not known', () => {
    state.userId = undefined;
    state.members = [{ userId: 'u1', serverId: 's1', roles: [] }];
    expect(readRank()).toBeNull();
  });
});

describe('mayEditRoleOverrides', () => {
  const role = (position: number, isDefault = false) => ({ position, isDefault });

  it('a role below the viewer may be edited; one at or above may not', () => {
    expect(mayEditRoleOverrides(5, role(4))).toBe(true);
    expect(mayEditRoleOverrides(5, role(5))).toBe(false);
    expect(mayEditRoleOverrides(5, role(9))).toBe(false);
  });

  it('@everyone may always be edited, whatever the viewer\'s rank', () => {
    expect(mayEditRoleOverrides(0, role(0, true))).toBe(true);
  });

  it('the owner (Infinity) may edit every role', () => {
    expect(mayEditRoleOverrides(Infinity, role(999))).toBe(true);
  });

  it('a rank not known yet restricts nothing', () => {
    expect(mayEditRoleOverrides(null, role(999))).toBe(true);
  });
});

describe('mayEditRole', () => {
  it('a role below the viewer may be edited or deleted; one at or above may not', () => {
    expect(mayEditRole(5, { position: 4 })).toBe(true);
    expect(mayEditRole(5, { position: 5 })).toBe(false);
    expect(mayEditRole(5, { position: 9 })).toBe(false);
  });

  it('@everyone has no exemption: a viewer of rank 0 may not edit it, one above it may', () => {
    expect(mayEditRole(0, { position: 0 })).toBe(false);
    expect(mayEditRole(1, { position: 0 })).toBe(true);
  });

  it('the owner (Infinity) may edit every role, and a rank not known yet restricts nothing', () => {
    expect(mayEditRole(Infinity, { position: 999 })).toBe(true);
    expect(mayEditRole(null, { position: 999 })).toBe(true);
  });
});

describe('mayCreateRole', () => {
  it('a viewer of rank 1 or more may create a role; one of rank 0 (highest position 0) may not', () => {
    expect(mayCreateRole(1)).toBe(true);
    expect(mayCreateRole(5)).toBe(true);
    expect(mayCreateRole(0)).toBe(false);
  });

  it('the owner may, and a rank not known yet restricts nothing', () => {
    expect(mayCreateRole(Infinity)).toBe(true);
    expect(mayCreateRole(null)).toBe(true);
  });
});
