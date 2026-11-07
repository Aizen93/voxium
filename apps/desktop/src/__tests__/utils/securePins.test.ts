import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  activateSecurePins,
  deactivateSecurePins,
  pinSecure,
  isPinnedSecure,
  forgetSecurePins,
  claimDowngradeWarning,
  securePinStorageKey,
} from '../../utils/securePins';

function stored(userId: string): unknown {
  const raw = localStorage.getItem(securePinStorageKey(userId));
  return raw === null ? null : JSON.parse(raw);
}

describe('securePins', () => {
  beforeEach(() => {
    deactivateSecurePins();
    forgetSecurePins('alice');
    forgetSecurePins('bob');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('answers false and writes nothing before an account is active', () => {
    expect(isPinnedSecure('ch-1')).toBe(false);
    expect(pinSecure('ch-1')).toBe(false);
    expect(isPinnedSecure('ch-1')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('pins write through to the account key', () => {
    activateSecurePins('alice');
    expect(pinSecure('ch-1')).toBe(true);
    expect(pinSecure('ch-1')).toBe(false); // already pinned
    expect(isPinnedSecure('ch-1')).toBe(true);
    expect(stored('alice')).toEqual(['ch-1']);
    expect(localStorage.getItem('vox:securePins:alice')).not.toBeNull();
  });

  it('keeps accounts apart', () => {
    activateSecurePins('alice');
    pinSecure('ch-a');
    deactivateSecurePins();
    activateSecurePins('bob');
    expect(isPinnedSecure('ch-a')).toBe(false);
    pinSecure('ch-b');
    expect(stored('bob')).toEqual(['ch-b']);
    expect(stored('alice')).toEqual(['ch-a']);
  });

  it('survives deactivate/activate (logout keeps the pins)', () => {
    activateSecurePins('alice');
    pinSecure('ch-1');
    deactivateSecurePins();
    expect(isPinnedSecure('ch-1')).toBe(false); // nobody active
    activateSecurePins('alice');
    expect(isPinnedSecure('ch-1')).toBe(true);
  });

  it('reloads pins from storage on activation (a new process)', () => {
    localStorage.setItem(securePinStorageKey('alice'), JSON.stringify(['ch-stored']));
    activateSecurePins('alice');
    expect(isPinnedSecure('ch-stored')).toBe(true);
  });

  it('keeps an in-memory pin whose write failed across a re-login', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    activateSecurePins('alice');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(pinSecure('ch-1')).toBe(true);
    expect(warn).toHaveBeenCalled();
    setItem.mockRestore();
    deactivateSecurePins();
    activateSecurePins('alice');
    expect(isPinnedSecure('ch-1')).toBe(true);
  });

  it('ignores a corrupted stored value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(securePinStorageKey('alice'), '{not json');
    activateSecurePins('alice');
    expect(isPinnedSecure('{not json')).toBe(false);
    expect(warn).toHaveBeenCalled();
    // ...and the next pin replaces it with a valid list
    pinSecure('ch-1');
    expect(stored('alice')).toEqual(['ch-1']);
  });

  it('ignores a stored value that is not a list, and drops bad entries', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(securePinStorageKey('alice'), JSON.stringify({ 'ch-1': true }));
    activateSecurePins('alice');
    expect(isPinnedSecure('ch-1')).toBe(false);
    deactivateSecurePins();

    localStorage.setItem(securePinStorageKey('bob'), JSON.stringify(['ch-ok', 42, null, '', 'has space', 'x'.repeat(200)]));
    activateSecurePins('bob');
    expect(isPinnedSecure('ch-ok')).toBe(true);
    expect(isPinnedSecure('has space')).toBe(false);
    expect(isPinnedSecure('')).toBe(false);
  });

  it('forgetSecurePins clears only that account, in memory and on disk', () => {
    activateSecurePins('bob');
    pinSecure('ch-b');
    deactivateSecurePins();
    activateSecurePins('alice');
    pinSecure('ch-a');
    forgetSecurePins('alice');
    expect(isPinnedSecure('ch-a')).toBe(false);
    expect(stored('alice')).toBeNull();
    deactivateSecurePins();
    activateSecurePins('alice');
    expect(isPinnedSecure('ch-a')).toBe(false); // the memory copy is gone too
    deactivateSecurePins();
    activateSecurePins('bob');
    expect(isPinnedSecure('ch-b')).toBe(true);
    expect(stored('bob')).toEqual(['ch-b']);
  });

  it('claims a downgrade warning once per channel per session', () => {
    activateSecurePins('alice');
    expect(claimDowngradeWarning('ch-1')).toBe(true);
    expect(claimDowngradeWarning('ch-1')).toBe(false);
    expect(claimDowngradeWarning('ch-2')).toBe(true);
    deactivateSecurePins();
    activateSecurePins('alice'); // a new login is a new session
    expect(claimDowngradeWarning('ch-1')).toBe(true);
  });
});
