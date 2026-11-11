import { describe, it, expect } from 'vitest';
import { isSortPosition, MAX_SORT_POSITION } from '../../utils/sortPosition';

describe('isSortPosition', () => {
  it('accepts every whole number from 0 to the bound', () => {
    expect(MAX_SORT_POSITION).toBe(1_000_000);
    for (const value of [0, 1, 42, MAX_SORT_POSITION]) expect(isSortPosition(value)).toBe(true);
  });

  it.each([
    -1, MAX_SORT_POSITION + 1, 2_147_483_647, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined, {}, [],
  ])('refuses %s', (value) => {
    expect(isSortPosition(value)).toBe(false);
  });
});
