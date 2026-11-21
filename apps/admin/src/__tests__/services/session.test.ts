import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  endServerSession, endSessionRenewals, refreshAccessToken, sameSession, storedSessionIs, userIdOf, SessionLostError,
  currentSessionEpoch, isTabSignedIn, setTabSignedInAs, tabAccountId, navigateOnce, mayCarry, differentAccounts,
  onBackgroundRenewalSettled, LOGOUT_TIMEOUT_MS, TRANSPORT_RETRY_DELAYS_MS, TRANSPORT_RETRY_JITTER_MS,
  _resetSessionForTests, _setSessionRandomForTests,
} from '../../services/session';
import { setTokens, getAccessToken, getRefreshToken } from '../../services/tokenStorage';

// Every tab of the dashboard shares one stored pair. "Another tab" is
// simulated by writing that storage directly; this module is "this tab".
const ACCESS_KEY = 'voxium_admin_access_token';
const REFRESH_KEY = 'voxium_admin_refresh_token';

function otherTabStores(access: string | null, refresh: string) {
  if (access === null) localStorage.removeItem(ACCESS_KEY);
  else localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
function otherTabClears() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

function failure(status: number): AxiosError {
  const cfg = {} as InternalAxiosRequestConfig;
  return new AxiosError(String(status), 'ERR_BAD_REQUEST', cfg, null, {
    status, statusText: '', headers: {}, config: cfg, data: { success: false, error: 'x' },
  });
}
const networkError = () => new AxiosError('Network Error', 'ERR_NETWORK');
const timeoutError = () => new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED');

function answer(accessToken: string, refreshToken: string) {
  return { data: { success: true, data: { accessToken, refreshToken } } };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A token shaped like ours, carrying the given claims (unsigned: only the client's own comparison reads it). */
function token(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}
// Two accounts, one session each
const A_U1 = token({ userId: 'u-1', sid: 's1', n: 1 });
const R_U1 = token({ userId: 'u-1', sid: 's1', gen: 0 });
const A_U2 = token({ userId: 'u-2', sid: 's2', n: 1 });
const R_U2 = token({ userId: 'u-2', sid: 's2', gen: 0 });

let post: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let hrefs: string[];
const realLocation = window.location;
const refreshCalls = () => (post.mock.calls as unknown[][]).filter((c) => String(c[0]).endsWith('/auth/refresh'));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetSessionForTests();
  hrefs = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { set href(v: string) { hrefs.push(v); }, get href() { return 'http://x/'; } },
  });
  post = vi.spyOn(axios, 'post');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetSessionForTests();
  onBackgroundRenewalSettled(null);
  post.mockRestore();
  warn.mockRestore();
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('endServerSession', () => {
  it('posts the refresh token alone, no bearer, with a bounded timeout', () => {
    post.mockResolvedValue({ status: 204 });
    endServerSession('R-secret');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatch(/\/auth\/logout$/);
    expect(post.mock.calls[0][1]).toEqual({ refreshToken: 'R-secret' });
    const config = post.mock.calls[0][2] as Record<string, unknown>;
    expect(config.timeout).toBe(LOGOUT_TIMEOUT_MS);
    expect(config.headers).toBeUndefined();
  });

  it('logs a failure by message only, never the token, and does not throw', async () => {
    post.mockRejectedValue(networkError());
    expect(() => endServerSession('R-secret')).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.stringify(warn.mock.calls)).toContain('Network Error');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('R-secret');
  });
});

describe('the account this tab is signed in as', () => {
  it('is set at a sign-in or a restore and cleared by every end of a session', () => {
    expect(isTabSignedIn()).toBe(false);
    setTabSignedInAs('u-1');
    expect(isTabSignedIn()).toBe(true);
    expect(tabAccountId()).toBe('u-1');
    endSessionRenewals();
    expect(isTabSignedIn()).toBe(false);
    expect(tabAccountId()).toBeNull();
  });

  it('mayCarry: a token of that account, any token while signed in as nobody, a token naming no account', () => {
    expect(mayCarry(A_U2)).toBe(true);
    setTabSignedInAs('u-1');
    expect(mayCarry(A_U1)).toBe(true);
    expect(mayCarry(token({ userId: 'u-1', sid: 'other' }))).toBe(true);
    expect(mayCarry(A_U2)).toBe(false);
    expect(mayCarry('A1')).toBe(true);
  });

  it('differentAccounts: only two tokens that both name an account, different ones', () => {
    expect(differentAccounts(A_U1, A_U2)).toBe(true);
    expect(differentAccounts(A_U1, R_U1)).toBe(false);
    expect(differentAccounts(A_U1, 'A1')).toBe(false);
  });
});

describe('navigateOnce', () => {
  it('the first navigation of the page load wins, its reason included', () => {
    navigateOnce('/login?reason=x');
    navigateOnce('/login');
    navigateOnce('/');
    expect(hrefs).toEqual(['/login?reason=x']);
  });
});

describe('refresh racing a local sign-out', () => {
  it('stores nothing from an answer that arrives after the sign-out, clears nothing, navigates nowhere', async () => {
    setTokens('A1', 'R1', true);
    setTabSignedInAs('u');
    const d = deferred<unknown>();
    post.mockReturnValue(d.promise);
    const pending = refreshAccessToken();
    // The sign-out ends the renewals; the storage is left as it is here, so
    // only the session check can refuse the answer
    endSessionRenewals();
    d.resolve(answer('A2', 'R2'));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe('A1');
    expect(getRefreshToken()).toBe('R1');
    expect(hrefs).toEqual([]);
  });

  it("a sign-in meanwhile: the old answer stores nothing and the new session's token goes to nobody", async () => {
    setTokens('A-S', 'R-S', true);
    setTabSignedInAs('u');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    endSessionRenewals();
    setTokens('A-M', 'R-M', true);
    setTabSignedInAs('u');
    const epochOfNewSession = currentSessionEpoch();
    d.resolve(answer('A-S2', 'R-S2'));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe('A-M');
    expect(getRefreshToken()).toBe('R-M');
    expect(isTabSignedIn()).toBe(true);
    expect(currentSessionEpoch()).toBe(epochOfNewSession);
    expect(hrefs).toEqual([]);
  });
});

describe('a renewal that FAILS after the session ended', () => {
  it.each([401, 403])('a %s after a sign-out and a new sign-in: no navigation, nothing cleared, the new token goes to nobody', async (status) => {
    setTokens('A-S', 'R-S', true);
    setTabSignedInAs('u');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    endSessionRenewals();
    setTokens('A-M', 'R-M', true);
    setTabSignedInAs('u');
    const epochOfNewSession = currentSessionEpoch();
    d.reject(failure(status));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe('A-M');
    expect(getRefreshToken()).toBe('R-M');
    expect(isTabSignedIn()).toBe(true);
    expect(currentSessionEpoch()).toBe(epochOfNewSession);
    expect(hrefs).toEqual([]);
  });

  it('a 401 after a sign-out that left the storage as it was: nothing cleared, no navigation', async () => {
    setTokens('A1', 'R1', true);
    setTabSignedInAs('u');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    endSessionRenewals();
    d.reject(failure(401));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getRefreshToken()).toBe('R1');
    expect(hrefs).toEqual([]);
  });

  it('a transport failure after a sign-out and a new sign-in: a session-lost error, no background renewal', async () => {
    vi.useFakeTimers();
    _setSessionRandomForTests(() => 0.5);
    setTokens('A-S', 'R-S', true);
    setTabSignedInAs('u');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    endSessionRenewals();
    setTokens('A-M', 'R-M', true);
    setTabSignedInAs('u');
    d.reject(networkError());
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(refreshCalls()).toHaveLength(1);
    expect(getRefreshToken()).toBe('R-M');
  });
});

describe('a renewal of an ended session is never handed to the next one', () => {
  it('a renewal asked for after a sign-out and a new sign-in starts a NEW request and stores its answer', async () => {
    setTokens('A-S', 'R-S', true);
    const old = deferred<unknown>();
    post.mockReturnValueOnce(old.promise);
    const first = refreshAccessToken();
    // A sign-out and a new sign-in in this tab
    endSessionRenewals();
    setTokens('A-M', 'R-M', true);
    post.mockResolvedValueOnce(answer('A-M2', 'R-M2'));
    const second = refreshAccessToken();
    expect(second).not.toBe(first);
    await expect(second).resolves.toBe('A-M2');
    expect(refreshCalls()).toHaveLength(2);
    expect(refreshCalls()[1][1]).toEqual({ refreshToken: 'R-M', client: 'admin' });
    old.resolve(answer('A-S2', 'R-S2'));
    await expect(first).rejects.toBeInstanceOf(SessionLostError);
    expect(getRefreshToken()).toBe('R-M2');
  });

  it("the old renewal settling late does not free the new renewal's slot", async () => {
    setTokens('A-S', 'R-S', true);
    const old = deferred<unknown>();
    const next = deferred<unknown>();
    post.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = refreshAccessToken();
    endSessionRenewals();
    setTokens('A-M', 'R-M', true);
    const second = refreshAccessToken();
    old.resolve(answer('A-S2', 'R-S2'));
    await expect(first).rejects.toBeInstanceOf(SessionLostError);
    // Still single-flight: a caller now shares the new session's request
    expect(refreshAccessToken()).toBe(second);
    next.resolve(answer('A-M2', 'R-M2'));
    await expect(second).resolves.toBe('A-M2');
    expect(refreshCalls()).toHaveLength(2);
  });
});

describe('a refusal of the refresh token this tab sent', () => {
  it('ends the session while that token is still the stored one: cleared, sign-in page, once', async () => {
    setTokens('A1', 'R1', true);
    setTabSignedInAs('u');
    post.mockRejectedValue(failure(401));
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(hrefs).toEqual(['/login']);
    expect(isTabSignedIn()).toBe(false);
  });

  it('while the tab is not signed in (the sign-in page, a restore): cleared, and no navigation', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValue(failure(401));
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(getRefreshToken()).toBeNull();
    expect(hrefs).toEqual([]);
  });

  it('after another tab stored a newer pair: clears nothing, does not navigate, answers the stored access token', async () => {
    setTokens('A-S', 'R-S', true);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores('A-M', 'R-M');
    d.reject(failure(401));
    await expect(pending).resolves.toBe('A-M');
    expect(getAccessToken()).toBe('A-M');
    expect(getRefreshToken()).toBe('R-M');
    expect(hrefs).toEqual([]);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('after another tab stored a refresh token without its access token: renews ONCE with the stored one', async () => {
    setTokens('A-S', 'R-S', true);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise).mockResolvedValueOnce(answer('A-M2', 'R-M2'));
    const pending = refreshAccessToken();
    otherTabStores(null, 'R-M');
    d.reject(failure(403));
    await expect(pending).resolves.toBe('A-M2');
    expect(refreshCalls()).toHaveLength(2);
    expect(refreshCalls()[1][1]).toEqual({ refreshToken: 'R-M', client: 'admin' });
    expect(getRefreshToken()).toBe('R-M2');
    expect(hrefs).toEqual([]);
  });
});

describe('another account stored in the shared storage', () => {
  it('signed in as one account with another account\'s pair stored: no refresh at all, nothing cleared, a reload onto it', async () => {
    setTabSignedInAs('u-1');
    otherTabStores(A_U2, R_U2);
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(refreshCalls()).toHaveLength(0);
    expect(getAccessToken()).toBe(A_U2);
    expect(getRefreshToken()).toBe(R_U2);
    expect(hrefs).toEqual(['/']);
  });

  it("a refusal while another account's pair was stored: that pair is neither used nor cleared, a reload onto it", async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(A_U2, R_U2);
    d.reject(failure(401));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe(A_U2);
    expect(getRefreshToken()).toBe(R_U2);
    expect(refreshCalls()).toHaveLength(1);
    expect(hrefs).toEqual(['/']);
  });

  it("a refusal while another account's REFRESH token alone was stored: it is never sent", async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(null, R_U2);
    d.reject(failure(401));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(refreshCalls()).toHaveLength(1);
    expect(getRefreshToken()).toBe(R_U2);
  });

  it("a successful answer while another account's pair was stored: dropped, that pair kept, a reload onto it", async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(A_U2, R_U2);
    d.resolve(answer(token({ userId: 'u-1', sid: 's1', n: 2 }), token({ userId: 'u-1', sid: 's1', gen: 1 })));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe(A_U2);
    expect(hrefs).toEqual(['/']);
  });

  it('a refusal while the stored access token names another account (its refresh token naming none): not handed back', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(A_U2, 'R-unreadable');
    d.reject(failure(401));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe(A_U2);
    expect(getRefreshToken()).toBe('R-unreadable');
    expect(hrefs).toEqual(['/']);
  });

  it("a successful answer while another account's REFRESH token alone was stored: it is never sent", async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(null, R_U2);
    d.resolve(answer(token({ userId: 'u-1', sid: 's1', n: 2 }), token({ userId: 'u-1', sid: 's1', gen: 1 })));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(refreshCalls()).toHaveLength(1);
    expect(getRefreshToken()).toBe(R_U2);
    expect(hrefs).toEqual(['/']);
  });

  it('a successful answer while the stored access token names another account (its refresh token naming none): dropped', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(A_U2, 'R-unreadable');
    d.resolve(answer(token({ userId: 'u-1', sid: 's1', n: 2 }), token({ userId: 'u-1', sid: 's1', gen: 1 })));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getAccessToken()).toBe(A_U2);
    expect(hrefs).toEqual(['/']);
  });

  it('while signed in as nobody (a restore): another account\'s pair is not handed back and not cleared, no navigation', async () => {
    setTokens(A_U1, R_U1, true);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores(A_U2, R_U2);
    d.reject(failure(401));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(getRefreshToken()).toBe(R_U2);
    expect(hrefs).toEqual([]);
  });

  it('another session of the SAME account stored meanwhile is still used', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    const otherSession = token({ userId: 'u-1', sid: 's9' });
    otherTabStores(otherSession, token({ userId: 'u-1', sid: 's9', gen: 0 }));
    d.reject(failure(401));
    await expect(pending).resolves.toBe(otherSession);
    expect(hrefs).toEqual([]);
  });
});

describe('a successful answer that lands after the storage moved on', () => {
  it('two tabs renewing at once: the later answer is dropped and the pair the other tab stored is kept', async () => {
    setTokens('A1', 'R1', true);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabStores('A2-other', 'R2-other');
    d.resolve(answer('A2-mine', 'R2-mine'));
    await expect(pending).resolves.toBe('A2-other');
    expect(getAccessToken()).toBe('A2-other');
    expect(getRefreshToken()).toBe('R2-other');
  });

  it('another tab signed out and in again: the late answer does not overwrite the new session', async () => {
    setTokens('A-S1', 'R-S1', true);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabClears();
    otherTabStores('A-M', 'R-M');
    d.resolve(answer('A-S2', 'R-S2'));
    await expect(pending).resolves.toBe('A-M');
    expect(getRefreshToken()).toBe('R-M');
  });

  it('another tab stored a refresh token alone: a second refresh with it, whose answer is stored', async () => {
    setTokens('A-S', 'R-S', true);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise).mockResolvedValueOnce(answer('A-M2', 'R-M2'));
    const pending = refreshAccessToken();
    otherTabStores(null, 'R-M');
    d.resolve(answer('A-S2', 'R-S2'));
    await expect(pending).resolves.toBe('A-M2');
    expect(refreshCalls()).toHaveLength(2);
    expect(refreshCalls()[1][1]).toEqual({ refreshToken: 'R-M', client: 'admin' });
    expect(getRefreshToken()).toBe('R-M2');
    expect(hrefs).toEqual([]);
  });

  it('another tab signed out: nothing is written anywhere, session storage included; a signed-in tab goes to sign-in', async () => {
    setTokens('A-S1', 'R-S1', true);
    setTabSignedInAs('u');
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    otherTabClears();
    d.resolve(answer('A-S2', 'R-S2'));
    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(hrefs).toEqual(['/login']);
  });

  it('stores the answer where the renewed pair was read', async () => {
    setTokens('a', 'r', false);
    post.mockResolvedValueOnce(answer('a2', 'r2'));
    await expect(refreshAccessToken()).resolves.toBe('a2');
    expect(sessionStorage.getItem(REFRESH_KEY)).toBe('r2');
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it('stores the answer where the pair was READ, not where an access key turned up while the request was out', async () => {
    setTokens('a', 'r', false);
    const d = deferred<unknown>();
    post.mockReturnValueOnce(d.promise);
    const pending = refreshAccessToken();
    // A stray access key in the shared storage (the pair still lives in this tab's)
    localStorage.setItem(ACCESS_KEY, 'stray');
    d.resolve(answer('a2', 'r2'));
    await expect(pending).resolves.toBe('a2');
    expect(sessionStorage.getItem(REFRESH_KEY)).toBe('r2');
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe('a2');
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});

describe('background renewals after a refresh request that got no answer', () => {
  const [FIRST, SECOND, THIRD] = TRANSPORT_RETRY_DELAYS_MS;
  beforeEach(() => {
    vi.useFakeTimers();
    // The middle of the spread: no jitter
    _setSessionRandomForTests(() => 0.5);
  });

  it('three, at about 10 s, 30 s and 75 s after the failure, the last well inside the two minutes', () => {
    expect(TRANSPORT_RETRY_DELAYS_MS).toEqual([10_000, 30_000, 75_000]);
    expect(TRANSPORT_RETRY_JITTER_MS).toBe(5_000);
    // The failed request left at most 15 s before its failure
    expect(15_000 + THIRD + TRANSPORT_RETRY_JITTER_MS).toBeLessThan(110_000);
  });

  it.each([['a network error', networkError], ['a timeout', timeoutError], ['a 502', () => failure(502)]])(
    '%s each time: renewals at 10, 30 and 75 s with the same refresh token, then nothing more',
    async (_n, make) => {
      setTokens('A1', 'R1-secret', true);
      post.mockImplementation(async () => { throw make(); });
      await expect(refreshAccessToken()).rejects.toBeDefined();
      expect(getRefreshToken()).toBe('R1-secret');
      await vi.advanceTimersByTimeAsync(FIRST - 1);
      expect(refreshCalls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshCalls()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(SECOND - FIRST - 1);
      expect(refreshCalls()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshCalls()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(THIRD - SECOND);
      expect(refreshCalls()).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(refreshCalls()).toHaveLength(4);
      expect(refreshCalls().map((c) => (c[1] as { refreshToken: string }).refreshToken)).toEqual(
        ['R1-secret', 'R1-secret', 'R1-secret', 'R1-secret'],
      );
      expect(getRefreshToken()).toBe('R1-secret');
      // Each failure is logged by message, never the token
      expect(JSON.stringify(warn.mock.calls)).not.toContain('R1-secret');
    },
  );

  it('the offsets are counted from the failure, not from the renewal before', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError());
    await expect(refreshAccessToken()).rejects.toBeDefined();
    // The first background renewal hangs for 15 s before it fails
    const slow = deferred<unknown>();
    post.mockReturnValueOnce(slow.promise);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(refreshCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    post.mockRejectedValueOnce(networkError());
    slow.reject(timeoutError());
    await vi.advanceTimersByTimeAsync(SECOND - FIRST - 15_000 - 1);
    expect(refreshCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls()).toHaveLength(3);
  });

  it('the first one that gets an answer ends the chain: its pair is stored', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(answer('A2', 'R2'));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(refreshCalls()).toHaveLength(2);
    expect(getRefreshToken()).toBe('R2');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(2);
  });

  it('a 429 answer to a background renewal ends the chain, the tokens kept', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(failure(429));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(2);
    expect(getRefreshToken()).toBe('R1');
  });

  it('the wait is spread around each offset', async () => {
    setTokens('A1', 'R1', true);
    _setSessionRandomForTests(() => 0);
    post.mockRejectedValue(networkError());
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST - TRANSPORT_RETRY_JITTER_MS - 1);
    expect(refreshCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls()).toHaveLength(2);

    // The far end of the spread
    endSessionRenewals();
    _setSessionRandomForTests(() => 0.9999);
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST + TRANSPORT_RETRY_JITTER_MS - 2);
    expect(refreshCalls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2);
    expect(refreshCalls()).toHaveLength(4);
  });

  it('a 429 answer schedules nothing (the server answered: it did not rotate)', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(failure(429));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(1);
  });

  it.each([401, 403])('a %s answer schedules nothing', async (status) => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(failure(status));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(1);
  });

  it.each([500, 502, 503, 504])('a %s answer keeps the tokens, fails the request and schedules a background renewal', async (status) => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(failure(status)).mockResolvedValueOnce(answer('A2', 'R2'));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    expect(getRefreshToken()).toBe('R1');
    expect(hrefs).toEqual([]);
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(refreshCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls()).toHaveLength(2);
    expect(getRefreshToken()).toBe('R2');
  });

  it('a sign-out cancels the chain: no timer is left', async () => {
    setTokens('A1', 'R1', true);
    const before = vi.getTimerCount();
    post.mockRejectedValueOnce(networkError());
    await expect(refreshAccessToken()).rejects.toBeDefined();
    expect(vi.getTimerCount()).toBe(before + 1);
    endSessionRenewals();
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('nothing once the session ended or the stored refresh token changed', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(failure(503));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    endSessionRenewals();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(1);

    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(failure(503));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    otherTabStores('A9', 'R9');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(2);
    expect(getRefreshToken()).toBe('R9');
  });

  it('the chain stops when the stored refresh token changes between two of its renewals', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValue(networkError());
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(refreshCalls()).toHaveLength(2);
    otherTabStores('A9', 'R9');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(2);
  });

  it('a renewal that starts meanwhile replaces the chain; its own transport failure starts a new one from then', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError());
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    // A request's 401 renews at t = 5 s and gets no answer either
    post.mockRejectedValueOnce(networkError());
    await expect(refreshAccessToken()).rejects.toBeDefined();
    expect(refreshCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(refreshCalls()).toHaveLength(2);
    post.mockResolvedValueOnce(answer('A2', 'R2'));
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls()).toHaveLength(3);
    expect(getRefreshToken()).toBe('R2');
  });

  it('a renewal that starts meanwhile and is answered 429 ends the chain too', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(failure(429));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(2);
    expect(getRefreshToken()).toBe('R1');
  });

  it('a renewal that starts meanwhile and succeeds leaves no background renewal', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(answer('A2', 'R2'));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await expect(refreshAccessToken()).resolves.toBe('A2');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshCalls()).toHaveLength(2);
  });

  it('a refused background renewal on the sign-in page clears the pair it sent and navigates nowhere', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(failure(401));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(refreshCalls()).toHaveLength(2);
    expect(getRefreshToken()).toBeNull();
    expect(hrefs).toEqual([]);
  });

  it('a refused background renewal of a signed-in tab goes to the sign-in page', async () => {
    setTokens('A1', 'R1', true);
    setTabSignedInAs('u');
    post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(failure(401));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(hrefs).toEqual(['/login']);
  });

  it('the listener hears of a background renewal that renewed or ended the session, not of one that got no answer', async () => {
    const listener = vi.fn();
    onBackgroundRenewalSettled(listener);
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError()).mockResolvedValueOnce(answer('A2', 'R2'));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SECOND - FIRST);
    expect(listener).toHaveBeenCalledTimes(1);

    // A refusal is an answer too; a foreground renewal tells nobody
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(failure(401));
    await expect(refreshAccessToken()).rejects.toBeDefined();
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('userIdOf', () => {
  it('reads the userId claim; null for none, an empty one, a malformed token or one that cannot be decoded', () => {
    expect(userIdOf(token({ userId: 'u-1', sid: 's' }))).toBe('u-1');
    expect(userIdOf(token({ sid: 's' }))).toBeNull();
    expect(userIdOf(token({ userId: '' }))).toBeNull();
    expect(userIdOf(token({ userId: 5 }))).toBeNull();
    expect(userIdOf('A1')).toBeNull();
    expect(userIdOf('a.%%%.b')).toBeNull();
    expect(userIdOf('a.bm90anNvbg.b')).toBeNull();
    // A payload that is JSON but not an object
    expect(userIdOf(`a.${btoa('5')}.b`)).toBeNull();
  });
});

describe('telling sessions apart', () => {
  const s1a = token({ sid: 'sess-1', gen: 1 });
  const s1b = token({ sid: 'sess-1', gen: 2 });
  const s2 = token({ sid: 'sess-2', gen: 1 });

  it('two tokens of one session (a renewal replaced them) are the same session; another sid is not', () => {
    expect(sameSession(s1a, s1b)).toBe(true);
    expect(sameSession(s1a, s2)).toBe(false);
  });

  it('tokens without a readable sid are the same session only when they are the same token', () => {
    expect(sameSession('A1', 'A1')).toBe(true);
    expect(sameSession('A1', 'A2')).toBe(false);
    expect(sameSession(token({ userId: 'u' }), token({ userId: 'u', iat: 2 }))).toBe(false);
    expect(sameSession('a.%%%.b', 'a.%%%.c')).toBe(false);
  });

  it('storedSessionIs: nothing stored, the stored session (rotated or not), never another one', () => {
    expect(storedSessionIs('anything')).toBe(true);
    setTokens(s1b, token({ sid: 'sess-1', gen: 2, refresh: true }), true);
    expect(storedSessionIs(s1a)).toBe(true);
    expect(storedSessionIs(s2)).toBe(false);
    expect(storedSessionIs(null)).toBe(false);
    setTokens('A1', 'R1', true);
    expect(storedSessionIs('A1')).toBe(true);
    expect(storedSessionIs('R1')).toBe(true);
    expect(storedSessionIs('A0')).toBe(false);
  });
});
