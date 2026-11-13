import { describe, it, expect } from 'vitest';
import { isSortPosition, MAX_SORT_POSITION, positionAfter } from '../../utils/sortPosition';

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

describe('positionAfter', () => {
  it('is 0 when nothing holds a position yet', () => {
    expect(positionAfter(null)).toBe(0);
    expect(positionAfter(undefined)).toBe(0);
  });

  it('is one past the highest position held', () => {
    expect(positionAfter(0)).toBe(1);
    expect(positionAfter(23)).toBe(24);
    expect(positionAfter(MAX_SORT_POSITION)).toBe(MAX_SORT_POSITION + 1);
  });

  it('never passes the integer column\'s maximum', () => {
    expect(positionAfter(2_147_483_646)).toBe(2_147_483_647);
    expect(positionAfter(2_147_483_647)).toBe(2_147_483_647);
  });
});
