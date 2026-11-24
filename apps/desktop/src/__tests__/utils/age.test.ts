import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isYoungerThan } from '../../utils/age';

describe('isYoungerThan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const now = () => Date.now();

  it('is true below the maximum and false at or above it', () => {
    expect(isYoungerThan(now() - 1999, 2000)).toBe(true);
    expect(isYoungerThan(now() - 2000, 2000)).toBe(false);
    expect(isYoungerThan(now(), 2000)).toBe(true);
  });

  it('is false for a time ahead of the clock (the clock was set back)', () => {
    expect(isYoungerThan(now() + 1, 2000)).toBe(false);
    expect(isYoungerThan(now() + 3_600_000, 2000)).toBe(false);
  });

  it('is false for anything that is not a finite number', () => {
    expect(isYoungerThan(undefined, 2000)).toBe(false);
    expect(isYoungerThan(Number.NaN, 2000)).toBe(false);
    expect(isYoungerThan(Number.POSITIVE_INFINITY, 2000)).toBe(false);
    expect(isYoungerThan(Number.NEGATIVE_INFINITY, 2000)).toBe(false);
  });
});
