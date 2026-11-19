import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Role } from '@voxium/shared';
import { buildModerationContext, hasEffective, highestRolePosition, memberRules } from '../../utils/memberActions';

/**
 * The client-side copy of the server's per-action rules: the permission bit,
 * and the role-position rule (`getHighestRolePosition`: the owner is
 * Infinity, anyone else their highest assigned role, 0 with none; the actor
 * must be strictly above the target).
 */

const role = (id: string, position: number, permissions: bigint = 0n, isDefault = false): Role => ({
  id, serverId: 's', name: id, color: null, position, permissions: permissions.toString(), isDefault, createdAt: '2026-01-01T00:00:00.000Z',
});
const everyone = role('everyone', 0, 0n, true);
const low = role('low', 1);
const mid = role('mid', 5);
const high = role('high', 9);
const roles = [everyone, low, mid, high];

const ref = (userId: string, ...assigned: Role[]) => ({ userId, roles: assigned });

function rulesFor(bits: bigint | null, actorRoles: Role[] = [mid], ownerId = 'owner') {
  const ctx = buildModerationContext({ actorId: 'me', actor: ref('me', ...actorRoles), ownerId, bits, roles });
  return memberRules(ctx);
}

describe('highestRolePosition', () => {
  it('is Infinity for the owner, the highest assigned role otherwise, 0 with none', () => {
    expect(highestRolePosition(ref('owner'), 'owner', roles)).toBe(Infinity);
    expect(highestRolePosition(ref('a', low, high), 'owner', roles)).toBe(9);
    expect(highestRolePosition(ref('a'), 'owner', roles)).toBe(0);
    expect(highestRolePosition(undefined, 'owner', roles)).toBe(0);
  });

  it('ignores @everyone and reads a role position from the current list of the space', () => {
    expect(highestRolePosition(ref('a', everyone), 'owner', roles)).toBe(0);
    // The copy on the member row says 1; the list of the space (after a reorder) says 7
    const stale = { ...low, position: 1 };
    expect(highestRolePosition({ userId: 'a', roles: [stale] }, 'owner', [{ ...low, position: 7 }])).toBe(7);
    // A role the list does not hold falls back to the copy on the member
    expect(highestRolePosition({ userId: 'a', roles: [stale] }, 'owner', [])).toBe(1);
  });
});

describe('hasEffective', () => {
  it('is false while the bits are unknown, ADMINISTRATOR holds every one', () => {
    expect(hasEffective(null, Permissions.KICK_MEMBERS)).toBe(false);
    expect(hasEffective(undefined, Permissions.KICK_MEMBERS)).toBe(false);
    expect(hasEffective(Permissions.KICK_MEMBERS, Permissions.KICK_MEMBERS)).toBe(true);
    expect(hasEffective(Permissions.SPEAK, Permissions.KICK_MEMBERS)).toBe(false);
    expect(hasEffective(Permissions.ADMINISTRATOR, Permissions.MANAGE_CHANNELS)).toBe(true);
  });
});

type Action = 'canKick' | 'canAssignRoles' | 'canSetNickname' | 'canMove';
const BIT: Record<Action, bigint> = {
  canKick: Permissions.KICK_MEMBERS,
  canAssignRoles: Permissions.MANAGE_ROLES,
  canSetNickname: Permissions.MANAGE_NICKNAMES,
  canMove: Permissions.MOVE_MEMBERS,
};

describe.each(Object.keys(BIT) as Action[])('%s', (action) => {
  const bit = BIT[action];

  it('needs its permission bit (and no other)', () => {
    expect(rulesFor(bit)[action](ref('t', low))).toBe(true);
    expect(rulesFor(ALL_PERMISSIONS & ~bit & ~Permissions.ADMINISTRATOR)[action](ref('t', low))).toBe(false);
    expect(rulesFor(0n)[action](ref('t', low))).toBe(false);
    expect(rulesFor(null)[action](ref('t', low))).toBe(false);
  });

  it('ADMINISTRATOR stands in for the bit', () => {
    expect(rulesFor(Permissions.ADMINISTRATOR)[action](ref('t', low))).toBe(true);
  });

  it('needs the actor strictly above the target: lower yes, equal no, higher no', () => {
    const r = rulesFor(bit, [mid]);
    expect(r[action](ref('lower', low))).toBe(true);
    expect(r[action](ref('none'))).toBe(true); // 0 < 5
    expect(r[action](ref('equal', mid))).toBe(false);
    expect(r[action](ref('higher', high))).toBe(false);
    expect(r[action](ref('mixed', low, high))).toBe(false); // the highest role counts
  });

  it('never applies to oneself', () => {
    expect(rulesFor(bit)[action](ref('me', low))).toBe(false);
  });

  it('is refused for the owner as target, whoever the actor is', () => {
    expect(rulesFor(bit, [high])[action](ref('owner'))).toBe(false);
    expect(rulesFor(ALL_PERMISSIONS, [high])[action](ref('owner'))).toBe(false);
  });

  it('lets the owner act on everyone else, whatever roles they hold', () => {
    const ctx = buildModerationContext({ actorId: 'me', actor: ref('me'), ownerId: 'me', bits: ALL_PERMISSIONS, roles });
    const r = memberRules(ctx);
    expect(r[action](ref('t', high))).toBe(true);
    expect(r[action](ref('t'))).toBe(true);
    // the server lets the owner assign their own roles; nothing else applies to oneself
    expect(r[action](ref('me'))).toBe(action === 'canAssignRoles');
  });

  it('a role edit that grants the bit changes the answer with no reassignment (same member, new bits)', () => {
    const target = ref('t', low);
    expect(rulesFor(0n)[action](target)).toBe(false);
    expect(rulesFor(bit)[action](target)).toBe(true);
  });
});

describe('server mute and deafen read the bit at the voice channel level', () => {
  it('the channel bits decide, not the space bits', () => {
    const r = rulesFor(Permissions.MUTE_MEMBERS | Permissions.DEAFEN_MEMBERS);
    const t = ref('t', low);
    expect(r.canServerMute(t, Permissions.MUTE_MEMBERS)).toBe(true);
    expect(r.canServerMute(t, Permissions.DEAFEN_MEMBERS)).toBe(false); // the other bit
    expect(r.canServerMute(t, 0n)).toBe(false); // an override denies it in that channel
    expect(r.canServerMute(t, null)).toBe(false); // not known yet
    expect(r.canServerDeafen(t, Permissions.DEAFEN_MEMBERS)).toBe(true);
    expect(r.canServerDeafen(t, Permissions.MUTE_MEMBERS)).toBe(false);
    expect(r.canServerDeafen(t, null)).toBe(false);
  });

  it.each(['canServerMute', 'canServerDeafen'] as const)('%s follows the position rule too', (action) => {
    const bit = action === 'canServerMute' ? Permissions.MUTE_MEMBERS : Permissions.DEAFEN_MEMBERS;
    const r = rulesFor(0n, [mid]);
    expect(r[action](ref('lower', low), bit)).toBe(true);
    expect(r[action](ref('equal', mid), bit)).toBe(false);
    expect(r[action](ref('higher', high), bit)).toBe(false);
    expect(r[action](ref('owner'), bit)).toBe(false);
    expect(r[action](ref('me', low), bit)).toBe(false);
  });
});

describe('canAssignRoles on oneself', () => {
  it('only the owner may edit their own roles, and only with MANAGE_ROLES', () => {
    const owner = (bits: bigint) => memberRules(buildModerationContext({ actorId: 'me', actor: ref('me'), ownerId: 'me', bits, roles }));
    expect(owner(Permissions.MANAGE_ROLES).canAssignRoles(ref('me'))).toBe(true);
    expect(owner(0n).canAssignRoles(ref('me'))).toBe(false);
    expect(rulesFor(Permissions.MANAGE_ROLES, [high]).canAssignRoles(ref('me', high))).toBe(false);
  });
});

describe('canChangeOwnNickname', () => {
  it('is CHANGE_NICKNAME alone', () => {
    expect(rulesFor(Permissions.CHANGE_NICKNAME).canChangeOwnNickname()).toBe(true);
    expect(rulesFor(Permissions.MANAGE_NICKNAMES).canChangeOwnNickname()).toBe(false);
    expect(rulesFor(null).canChangeOwnNickname()).toBe(false);
  });
});

describe('assignableRoles', () => {
  it('lists roles strictly below the actor, highest first, never @everyone', () => {
    expect(rulesFor(Permissions.MANAGE_ROLES, [mid]).assignableRoles().map((r) => r.id)).toEqual(['low']);
    expect(rulesFor(Permissions.MANAGE_ROLES, [high]).assignableRoles().map((r) => r.id)).toEqual(['mid', 'low']);
    expect(rulesFor(Permissions.MANAGE_ROLES, [low]).assignableRoles()).toEqual([]);
  });

  it('the owner may hand out every role but @everyone', () => {
    const ctx = buildModerationContext({ actorId: 'me', actor: ref('me'), ownerId: 'me', bits: ALL_PERMISSIONS, roles });
    expect(memberRules(ctx).assignableRoles().map((r) => r.id)).toEqual(['high', 'mid', 'low']);
  });

  it('does not reorder the own list of the space', () => {
    const own = [low, high, mid];
    const ctx = buildModerationContext({ actorId: 'me', actor: ref('me'), ownerId: 'me', bits: ALL_PERMISSIONS, roles: own });
    memberRules(ctx).assignableRoles();
    expect(own.map((r) => r.id)).toEqual(['low', 'high', 'mid']);
  });
});
