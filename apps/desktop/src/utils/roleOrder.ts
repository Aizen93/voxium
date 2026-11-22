import type { Role } from '@voxium/shared';

/** What the role order reads of a role. */
type Placed = Pick<Role, 'id' | 'position'>;

/**
 * The order of a space's roles, lowest first: by position, then by id
 * (compared by code unit). Roles that share a position therefore always come
 * in one order, whatever order their rows arrived in, so a list and a
 * member's top role never depend on it. Reverse it for highest first:
 * `(a, b) => compareRoles(b, a)`.
 */
export function compareRoles(a: Placed, b: Placed): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The highest of `roles` in that order (a member's top role, the one whose colour their name takes), undefined for none. */
export function topRole<T extends Placed>(roles: readonly T[]): T | undefined {
  let top: T | undefined;
  for (const role of roles) {
    if (top === undefined || compareRoles(role, top) > 0) top = role;
  }
  return top;
}
