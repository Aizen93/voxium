// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearedFloorOf,
  isAtOrBelowClearedFloor,
  parseServerTime,
  raiseClearedFloor,
  resetClearedFloors,
} from '../../services/e2e/clearedFloors';

/**
 * The floors this device knows, per account (services/e2e/clearedFloors.ts):
 * what the E2E service, the display gate and the DM store ask before writing,
 * answering or showing anything of a conversation whose history the account
 * cleared. Times compared as times, a floor that never moves back, one
 * account's floors never another's.
 */

const FLOOR = '2026-11-10T10:00:00.000Z';
const FLOOR_MS = Date.parse(FLOOR);

beforeEach(() => resetClearedFloors());

describe('parseServerTime', () => {
  it('takes the server\'s ISO form (toISOString, or an explicit offset) as the time it names', () => {
    expect(parseServerTime(FLOOR)).toBe(FLOOR_MS);
    expect(parseServerTime('2026-11-10T10:00:00Z')).toBe(FLOOR_MS);
    expect(parseServerTime('2026-11-10T11:00:00.000+01:00')).toBe(FLOOR_MS);
  });

  it('refuses everything else: forms Date.parse would still take, an impossible date, a non-string, an overlong value', () => {
    for (const value of ['1', 'Nov 10 2026', '2026-11-10', '2026-11-10 10:00:00Z', '2026-13-40T10:00:00.000Z', '', ' 2026-11-10T10:00:00.000Z',
      `${FLOOR}${' '.repeat(40)}`, 1762768800000, null, undefined, {}, ['2026-11-10T10:00:00.000Z']]) {
      expect(parseServerTime(value), String(value)).toBeNull();
    }
  });
});

describe('raiseClearedFloor / clearedFloorOf', () => {
  it('a floor never moves back: a lower or equal one changes nothing, a higher one raises it', () => {
    expect(raiseClearedFloor('me', 'c1', FLOOR_MS)).toBe(true);
    expect(raiseClearedFloor('me', 'c1', FLOOR_MS)).toBe(false);
    expect(raiseClearedFloor('me', 'c1', FLOOR_MS - 1)).toBe(false);
    expect(clearedFloorOf('me', 'c1')).toBe(FLOOR_MS);
    expect(raiseClearedFloor('me', 'c1', FLOOR_MS + 1)).toBe(true);
    expect(clearedFloorOf('me', 'c1')).toBe(FLOOR_MS + 1);
  });

  it('per conversation and per account: another account never sees this one\'s floors', () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);
    expect(clearedFloorOf('me', 'c2')).toBeNull();
    expect(clearedFloorOf('someone-else', 'c1')).toBeNull();
    expect(clearedFloorOf(null, 'c1')).toBeNull();
    expect(clearedFloorOf(undefined, 'c1')).toBeNull();
    expect(clearedFloorOf('me', null)).toBeNull();
  });

  it('refuses what is not a floor (no account, no conversation, not a finite time)', () => {
    expect(raiseClearedFloor('', 'c1', FLOOR_MS)).toBe(false);
    expect(raiseClearedFloor('me', '', FLOOR_MS)).toBe(false);
    expect(raiseClearedFloor('me', 'c1', Number.NaN)).toBe(false);
    expect(raiseClearedFloor('me', 'c1', Number.POSITIVE_INFINITY)).toBe(false);
    expect(clearedFloorOf('me', 'c1')).toBeNull();
  });

  it('logout drops every account\'s floors', () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);
    resetClearedFloors();
    expect(clearedFloorOf('me', 'c1')).toBeNull();
    expect(isAtOrBelowClearedFloor('me', 'c1', FLOOR)).toBe(false);
  });
});

describe('isAtOrBelowClearedFloor', () => {
  beforeEach(() => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);
  });

  it('at the floor and below: covered; one millisecond above: not', () => {
    expect(isAtOrBelowClearedFloor('me', 'c1', FLOOR)).toBe(true);
    expect(isAtOrBelowClearedFloor('me', 'c1', '2026-11-10T09:59:59.999Z')).toBe(true);
    expect(isAtOrBelowClearedFloor('me', 'c1', '2026-11-10T10:00:00.001Z')).toBe(false);
  });

  it('compares times, never strings: the same instant written with an offset is at the floor, a string-greater earlier one below it', () => {
    expect(isAtOrBelowClearedFloor('me', 'c1', '2026-11-10T11:00:00.000+01:00')).toBe(true);
    // compares above FLOOR as a string ("11" > "10"), lies below it as a time
    expect(isAtOrBelowClearedFloor('me', 'c1', '2026-11-10T11:00:00.000+02:00')).toBe(true);
    // compares below FLOOR as a string, lies above it as a time
    expect(isAtOrBelowClearedFloor('me', 'c1', '2026-11-10T09:30:00.000-01:00')).toBe(false);
  });

  it('a row or entry with no time, or one not in the server\'s form, is never covered', () => {
    expect(isAtOrBelowClearedFloor('me', 'c1', undefined)).toBe(false);
    expect(isAtOrBelowClearedFloor('me', 'c1', null)).toBe(false);
    expect(isAtOrBelowClearedFloor('me', 'c1', '')).toBe(false);
    expect(isAtOrBelowClearedFloor('me', 'c1', '1')).toBe(false);
  });

  it('only the conversation and the account the floor is for', () => {
    expect(isAtOrBelowClearedFloor('me', 'c2', FLOOR)).toBe(false);
    expect(isAtOrBelowClearedFloor('someone-else', 'c1', FLOOR)).toBe(false);
    expect(isAtOrBelowClearedFloor(null, 'c1', FLOOR)).toBe(false);
  });
});
