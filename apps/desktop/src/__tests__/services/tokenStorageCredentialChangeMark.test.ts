import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  markCredentialChange, credentialChangeInFlightUntil, waitForCredentialChange, createKeychainSessionStore,
  CREDENTIAL_CHANGE_MARK_TOLERANCE_MS, CREDENTIAL_CHANGE_MARK_POLL_MS, _resetTokenStorageForTests,
} from '../../services/tokenStorage';

// "A credential change is in flight until T", as every tab of the browser
// build reads it without a lock (services/session.ts writes and waits on it).

const KEY = 'voxium_credential_change';
const MAX_AHEAD = 80_000;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the mark of a credential change in flight', () => {
  it('holds T, a time on this device\'s clock, and nothing else: no token, no account', () => {
    const until = Date.now() + MAX_AHEAD;
    const unmark = markCredentialChange(until);

    expect(unmark).toBeTypeOf('function');
    expect(localStorage.getItem(KEY)).toBe(String(until));
    expect(Object.keys(localStorage)).toEqual([KEY]);
    expect(sessionStorage.length).toBe(0);
  });

  it('its removal removes it only while it is still this one', () => {
    const now = Date.now();
    const first = markCredentialChange(now + 10_000)!;
    const second = markCredentialChange(now + 20_000)!;

    first();
    expect(localStorage.getItem(KEY)).toBe(String(now + 20_000));
    second();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('is live before T and while T is no further ahead than a mark is written for, with the tolerance', () => {
    const now = 1_000_000_000_000;
    localStorage.setItem(KEY, String(now + MAX_AHEAD));
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now)).toBe(now + MAX_AHEAD);
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now - CREDENTIAL_CHANGE_MARK_TOLERANCE_MS)).toBe(now + MAX_AHEAD);
    // past T: a mark left behind (its tab crashed) is ignored
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now + MAX_AHEAD)).toBeNull();
    // further ahead than any change can take: not a mark this app wrote
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now - CREDENTIAL_CHANGE_MARK_TOLERANCE_MS - 1)).toBeNull();
  });

  it('anything that is not a time is ignored', () => {
    for (const value of ['', 'soon', '-5', '1e15', '12.5', '9'.repeat(17), '{"until":1}']) {
      localStorage.setItem(KEY, value);
      expect(credentialChangeInFlightUntil(MAX_AHEAD), value).toBeNull();
    }
  });

  it('a wait ends when the mark is removed: the next read finds it gone', async () => {
    vi.useFakeTimers();
    const unmark = markCredentialChange(Date.now() + MAX_AHEAD)!;
    let ended = false;
    const wait = waitForCredentialChange(MAX_AHEAD).then((waited) => { ended = true; return waited; });

    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_MARK_POLL_MS * 4);
    expect(ended).toBe(false);
    unmark();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_MARK_POLL_MS);

    await expect(wait).resolves.toBe(true);
  });

  it('... at once on the `storage` event that tells of its removal', async () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, String(Date.now() + MAX_AHEAD));
    const wait = waitForCredentialChange(MAX_AHEAD);

    localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null, storageArea: localStorage }));

    await expect(wait).resolves.toBe(true);
  });

  it('... and at T at the latest, the mark still there', async () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, String(Date.now() + 30_000));
    let ended = false;
    const wait = waitForCredentialChange(MAX_AHEAD).then((waited) => { ended = true; return waited; });

    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBe(true);
  });

  it('with no mark there is nothing to wait for', async () => {
    await expect(waitForCredentialChange(MAX_AHEAD)).resolves.toBe(false);
  });

  it('the desktop app writes and reads none (one webview)', async () => {
    const invoke = async <T>(): Promise<T> => null as T;
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    localStorage.setItem(KEY, String(Date.now() + 10_000));

    expect(markCredentialChange(Date.now() + MAX_AHEAD)).toBeNull();
    expect(localStorage.getItem(KEY)).not.toBe(String(Date.now() + MAX_AHEAD));
    expect(credentialChangeInFlightUntil(MAX_AHEAD)).toBeNull();
    await expect(waitForCredentialChange(MAX_AHEAD)).resolves.toBe(false);
  });

  it('a storage that refuses the write is logged, and the change goes on unmarked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });

    expect(markCredentialChange(Date.now() + MAX_AHEAD)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be told'), 'QuotaExceededError');
  });
});
