import { describe, it, expect, vi, afterEach } from 'vitest';
import { isNewDay, daySeparatorFor } from '../../utils/dateSeparator';

afterEach(() => {
  vi.useRealTimers();
});

describe('isNewDay', () => {
  it('is true for the first message (no predecessor)', () => {
    expect(isNewDay(undefined, '2026-07-14T09:12:00.000Z')).toBe(true);
  });

  it('is false within the same calendar day', () => {
    expect(isNewDay('2026-07-14T00:05:00', '2026-07-14T23:55:00')).toBe(false);
  });

  it('is true across midnight', () => {
    expect(isNewDay('2026-07-14T23:59:00', '2026-07-15T00:01:00')).toBe(true);
  });

  it('is true across months and years', () => {
    expect(isNewDay('2026-07-31T12:00:00', '2026-08-01T12:00:00')).toBe(true);
    expect(isNewDay('2025-12-31T12:00:00', '2026-01-01T12:00:00')).toBe(true);
  });

  it('never separates on unparseable dates', () => {
    expect(isNewDay('not-a-date', '2026-07-14T09:12:00')).toBe(false);
    expect(isNewDay('2026-07-14T09:12:00', 'not-a-date')).toBe(false);
  });
});

describe('daySeparatorFor', () => {
  it('classifies today and yesterday relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T10:00:00'));
    expect(daySeparatorFor('2026-07-15T01:00:00')).toEqual({ kind: 'today' });
    expect(daySeparatorFor('2026-07-14T23:00:00')).toEqual({ kind: 'yesterday' });
  });

  it('renders an absolute label for older days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T10:00:00'));
    expect(daySeparatorFor('2026-07-01T12:00:00')).toEqual({ kind: 'date', label: 'July 1, 2026' });
  });

  it('degrades to an empty label on an unparseable date', () => {
    expect(daySeparatorFor('garbage')).toEqual({ kind: 'date', label: '' });
  });
});
