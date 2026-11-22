import { describe, it, expect } from 'vitest';
import { compareRoles, topRole } from '../../utils/roleOrder';

/**
 * Roles that share a position come in one order, whatever order their rows
 * arrived in: by position, then by id (code unit order). A list sorts with
 * compareRoles (reversed for highest first) and a member's top role, the one
 * their name's colour comes from, is topRole.
 */

const r = (id: string, position: number, color: string | null = null) => ({ id, position, color });
const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);

describe('compareRoles', () => {
  it('orders by position first, lowest first', () => {
    expect(ids([r('a', 3), r('b', 1), r('c', 2)].sort(compareRoles))).toEqual(['b', 'c', 'a']);
  });

  it('breaks a position tie by id, in code unit order, the same whatever the input order', () => {
    const tied = [r('cmb', 2), r('cma', 2), r('Cmz', 2), r('cm9', 2)];
    const expected = ['Cmz', 'cm9', 'cma', 'cmb'];
    expect(ids([...tied].sort(compareRoles))).toEqual(expected);
    expect(ids([...tied].reverse().sort(compareRoles))).toEqual(expected);
  });

  it('reversed, it lists highest first with ties in the reverse id order: the exact reverse of the list', () => {
    const list = [r('a', 1), r('c', 2), r('b', 2), r('d', 5)];
    const lowestFirst = ids([...list].sort(compareRoles));
    expect(ids([...list].sort((x, y) => compareRoles(y, x)))).toEqual([...lowestFirst].reverse());
  });

  it('a role equals only itself', () => {
    expect(compareRoles(r('a', 1), r('a', 1))).toBe(0);
    expect(compareRoles(r('a', 1), r('b', 1))).toBeLessThan(0);
    expect(compareRoles(r('b', 1), r('a', 1))).toBeGreaterThan(0);
  });
});

describe('topRole', () => {
  it('is the highest position', () => {
    expect(topRole([r('a', 1), r('b', 7), r('c', 3)])?.id).toBe('b');
  });

  it('on a tie at the top, the higher id, whatever the order of the member\'s rows', () => {
    const rows = [r('red', 4, '#f00'), r('blue', 4, '#00f'), r('low', 1, '#0f0')];
    expect(topRole(rows)?.color).toBe('#f00');
    expect(topRole([...rows].reverse())?.color).toBe('#f00');
    expect(topRole(rows)).toBe([...rows].sort((x, y) => compareRoles(y, x))[0]);
  });

  it('undefined for no role', () => {
    expect(topRole([])).toBeUndefined();
  });
});
