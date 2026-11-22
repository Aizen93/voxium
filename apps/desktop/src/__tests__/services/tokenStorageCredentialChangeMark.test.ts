import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  markCredentialChange, credentialChangeInFlightUntil, waitForCredentialChange, createKeychainSessionStore, setTokens,
  flushTokenStorage, accountScopeOf, CREDENTIAL_CHANGE_MARK_TOLERANCE_MS, CREDENTIAL_CHANGE_MARK_POLL_MS, _resetTokenStorageForTests,
} from '../../services/tokenStorage';

// "A credential change of this account is in flight until T", as every tab of
// the browser build reads it without a lock (services/session.ts writes and
// waits on it).

const KEY = 'voxium_credential_change';
const MAX_AHEAD = 80_000;

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
/** A not-remembered pair of `userId` (sessionStorage: localStorage holds nothing but the mark). */
async function hold(userId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const pair = { accessToken: jwt({ userId, sid: `s-${userId}`, exp: 10 }), refreshToken: jwt({ userId, sid: `s-${userId}`, gen: 1 }) };
  setTokens(pair.accessToken, pair.refreshToken, false);
  await flushTokenStorage();
  return pair;
}
/** The account's scope, computed here on its own: the first 12 hex digits of SHA-256('voxium-credential-change:' + id). */
function scopeOf(userId: string): string {
  return createHash('sha256').update(`voxium-credential-change:${userId}`).digest('hex').slice(0, 12);
}
const markOf = (until: number, userId: string) => `${until}:${scopeOf(userId)}`;

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
  it('holds T and the scope of the account whose pair the tab holds: never the user id, never a token', async () => {
    const pair = await hold('user-x');
    const until = Date.now() + MAX_AHEAD;
    const unmark = markCredentialChange(until);

    expect(unmark).toBeTypeOf('function');
    const value = localStorage.getItem(KEY)!;
    expect(value).toBe(markOf(until, 'user-x'));
    expect(value).toMatch(/^\d+:[0-9a-f]{12}$/);
    expect(value).not.toContain('user-x');
    expect(value).not.toContain(pair.refreshToken);
    expect(value).not.toContain(pair.accessToken);
    expect(Object.keys(localStorage)).toEqual([KEY]);
    expect(accountScopeOf('user-x')).toBe(scopeOf('user-x'));
    expect(accountScopeOf('user-y')).not.toBe(accountScopeOf('user-x'));
  });

  it('a tab whose pair names no account, or that holds none, writes no mark', async () => {
    expect(markCredentialChange(Date.now() + MAX_AHEAD)).toBeNull();
    setTokens('opaque-a', 'opaque-r', false);
    expect(markCredentialChange(Date.now() + MAX_AHEAD)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('its removal removes it only while it is still this one', async () => {
    await hold('user-x');
    const now = Date.now();
    const first = markCredentialChange(now + 10_000)!;
    const second = markCredentialChange(now + 20_000)!;

    first();
    expect(localStorage.getItem(KEY)).toBe(markOf(now + 20_000, 'user-x'));
    second();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('is live for the account held before T, while T is no further ahead than a mark is written for with 5 s of tolerance', async () => {
    await hold('user-x');
    const now = 1_000_000_000_000;
    localStorage.setItem(KEY, markOf(now + MAX_AHEAD, 'user-x'));
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now)).toBe(now + MAX_AHEAD);
    // the device's clock set back by up to 5 s between the write and the read
    expect(CREDENTIAL_CHANGE_MARK_TOLERANCE_MS).toBe(5_000);
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now - 5_000)).toBe(now + MAX_AHEAD);
    // further ahead than any change can take: not a mark this app wrote, ignored and left
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now - 5_001)).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(markOf(now + MAX_AHEAD, 'user-x'));
  });

  it('a mark of another account holds nothing in this tab, and is left for that account\'s tabs', async () => {
    await hold('user-y');
    const mark = markOf(Date.now() + MAX_AHEAD, 'user-x');
    localStorage.setItem(KEY, mark);

    expect(credentialChangeInFlightUntil(MAX_AHEAD)).toBeNull();
    await expect(waitForCredentialChange(MAX_AHEAD)).resolves.toBe(false);
    expect(localStorage.getItem(KEY)).toBe(mark);
  });

  it('a tab that holds no pair waits for no mark', async () => {
    localStorage.setItem(KEY, markOf(Date.now() + MAX_AHEAD, 'user-x'));
    expect(credentialChangeInFlightUntil(MAX_AHEAD)).toBeNull();
  });

  it('anything that is not a mark this build writes is ignored, and left: the bare T of earlier builds included', async () => {
    await hold('user-x');
    const until = Date.now() + 10_000;
    const scope = scopeOf('user-x');
    for (const value of ['', 'soon', String(until), `${until}:`, `${until}:${scope.slice(0, 11)}`, `${until}:${scope.toUpperCase()}`,
      `-5:${scope}`, `1e15:${scope}`, `${'9'.repeat(17)}:${scope}`, `${until}:user-x`, '{"until":1}']) {
      localStorage.setItem(KEY, value);
      expect(credentialChangeInFlightUntil(MAX_AHEAD), value).toBeNull();
      expect(localStorage.getItem(KEY), value).toBe(value);
    }
  });

  it('a mark past its T is removed by the tab that reads it, whatever its account (its tab never did)', async () => {
    await hold('user-y');
    const now = Date.now();
    localStorage.setItem(KEY, markOf(now - 1, 'user-x'));
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();

    // ... and the tab's own account's at T exactly
    localStorage.setItem(KEY, markOf(now, 'user-y'));
    expect(credentialChangeInFlightUntil(MAX_AHEAD, now)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('... only the very value it read: a mark written meanwhile stays', async () => {
    await hold('user-x');
    const now = Date.now();
    const stale = markOf(now - 1, 'user-x');
    const fresh = markOf(now + MAX_AHEAD, 'user-x');
    localStorage.setItem(KEY, fresh);
    // the read finds the stale mark; another tab writes its own before the removal looks again
    const getItem = Storage.prototype.getItem;
    let reads = 0;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === KEY && reads++ === 0) return stale;
      return getItem.call(this, key);
    });

    expect(credentialChangeInFlightUntil(MAX_AHEAD, now)).toBeNull();
    expect(getItem.call(localStorage, KEY)).toBe(fresh);
  });

  it('a wait ends when the mark is removed: the next read finds it gone', async () => {
    vi.useFakeTimers();
    await hold('user-x');
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
    await hold('user-x');
    localStorage.setItem(KEY, markOf(Date.now() + MAX_AHEAD, 'user-x'));
    const wait = waitForCredentialChange(MAX_AHEAD);

    localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null, storageArea: localStorage }));

    await expect(wait).resolves.toBe(true);
  });

  it('... and at T at the latest, the mark still there (between two reads of it), which it then removes', async () => {
    vi.useFakeTimers();
    await hold('user-x');
    // off the poll's grid: the wait ends at T itself, not at the next read
    const ahead = 30_000 + Math.floor(CREDENTIAL_CHANGE_MARK_POLL_MS / 2) + 1;
    localStorage.setItem(KEY, markOf(Date.now() + ahead, 'user-x'));
    let ended = false;
    const wait = waitForCredentialChange(MAX_AHEAD).then((waited) => { ended = true; return waited; });

    await vi.advanceTimersByTimeAsync(ahead - 1);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toBe(true);
    await expect(wait).resolves.toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('with no mark there is nothing to wait for', async () => {
    await hold('user-x');
    await expect(waitForCredentialChange(MAX_AHEAD)).resolves.toBe(false);
  });

  it('the desktop app writes and reads none (one webview)', async () => {
    const invoke = async <T>(): Promise<T> => null as T;
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    setTokens(jwt({ userId: 'user-x', sid: 's', exp: 10 }), jwt({ userId: 'user-x', sid: 's', gen: 1 }), true);
    const left = markOf(Date.now() + 10_000, 'user-x');
    localStorage.setItem(KEY, left);

    expect(markCredentialChange(Date.now() + MAX_AHEAD)).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(left);
    expect(credentialChangeInFlightUntil(MAX_AHEAD)).toBeNull();
    await expect(waitForCredentialChange(MAX_AHEAD)).resolves.toBe(false);
  });

  it('a storage that refuses the write is logged, and the change goes on unmarked', async () => {
    await hold('user-x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });

    expect(markCredentialChange(Date.now() + MAX_AHEAD)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be told'), 'QuotaExceededError');
  });
});
