import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@voxium/shared';
import type { Role, ServerMember } from '@voxium/shared';

/** useMemberRules: what the viewer may do to members, null without a viewer who is a member. */

const S = vi.hoisted(() => ({ fetchEffectivePermissions: vi.fn() }));
let members: ServerMember[] = [];
let roles: Role[] = [];
let userId: string | undefined = 'me';
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, roles, servers: [{ id: 'srv', ownerId: 'owner' }], ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: userId ? { id: userId } : null });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  return { useAuthStore };
});
vi.mock('../../services/socket', () => ({ onSocketReconnect: () => () => {} }));

import { useMemberRules, type MemberRulesView } from '../../hooks/useMemberRules';
import { resetServerPermissionsCache } from '../../hooks/useServerPermissions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string): ServerMember =>
  ({ userId: id, serverId: 'srv', role: 'member', nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id, username: id, displayName: id, avatarUrl: null } } as unknown as ServerMember);

let container: HTMLDivElement;
let root: Root;
let seen: MemberRulesView | null | undefined;
function Probe() { seen = useMemberRules('srv'); return null; }
async function render() {
  await act(async () => { root.render(<Probe />); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  resetServerPermissionsCache();
  userId = 'me';
  const mod = { id: 'r1', serverId: 'srv', name: 'mod', color: null, position: 5, permissions: Permissions.KICK_MEMBERS.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' } as Role;
  roles = [mod];
  members = [{ ...row('me'), roles: [mod] }, row('t')];
  seen = undefined;
  S.fetchEffectivePermissions.mockResolvedValue(Permissions.KICK_MEMBERS.toString());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('useMemberRules', () => {
  it('answers the rules for a viewer who is a member', async () => {
    await render();
    expect(seen).not.toBeNull();
    expect(seen!.isOwner).toBe(false);
    expect(seen!.rules.canKick(row('t'))).toBe(true);
  });

  it('answers null with no actor: the viewer has no member row', async () => {
    members = [row('t')];
    await render();
    expect(seen).toBeNull();
  });

  it('answers null with no signed-in viewer', async () => {
    userId = undefined;
    await render();
    expect(seen).toBeNull();
  });
});
