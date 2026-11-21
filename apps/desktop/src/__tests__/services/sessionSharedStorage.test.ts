import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, reloadAfterSessionChange, createKeychainSessionStore,
  _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests,
} from '../../services/tokenStorage';
import {
  refreshAccessToken, goToLoginPage, SessionLostError, setSessionLostNavigation, _resetSessionForTests, _setRefreshLocksForTests,
} from '../../services/session';

// The renewal (services/session.ts) over the REAL session storage
// (services/tokenStorage.ts): what one decides, the other must honour.

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A pair of session `sid` at generation `gen`, its access token expired (a renewal must send something). */
function expiredPair(sid: string, gen: number, userId = 'user-x') {
  return { accessToken: jwt({ userId, sid, exp: nowSeconds() - 60, n: gen }), refreshToken: jwt({ userId, sid, gen }) };
}

const reload = vi.fn();
const navigate = vi.fn();
let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  _resetSessionForTests();
  _setPageReloadForTests(reload);
  setSessionLostNavigation(navigate);
  _setRefreshLocksForTests(null);
  _setSessionChannelForTests(null);
  reload.mockClear();
  navigate.mockClear();
  post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('no request expected'));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('one page-level navigation per page load: the first one asked for wins', () => {
  it('a reload onto another session asked for first: a trip to the sign-in page asked for after it goes nowhere', async () => {
    reloadAfterSessionChange();
    goToLoginPage('banned');
    await flushTokenStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a trip to the sign-in page asked for first: a reload asked for after it never overrides it, and its reason can still be given', async () => {
    goToLoginPage(null);
    reloadAfterSessionChange();
    goToLoginPage('session-ended');
    await flushTokenStorage();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));

    expect(navigate).toHaveBeenCalledWith('/login?reason=session-ended');
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();
  });

  it('a refusal that finds another account\'s session stored reloads onto it, and a force:logout that follows does not navigate over it', async () => {
    const mine = expiredPair('s-1', 1);
    setTokens(mine.accessToken, mine.refreshToken, true);
    await flushTokenStorage();
    post.mockImplementationOnce(async () => {
      // another tab signed in (as anyone) while the refused request was out; this tab missed the event
      const other = expiredPair('s-other', 1, 'user-y');
      localStorage.setItem('voxium_access_token', other.accessToken);
      localStorage.setItem('voxium_refresh_token', other.refreshToken);
      throw Object.assign(new Error('Request failed with status code 401'), { isAxiosError: true, response: { status: 401 } });
    });

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    goToLoginPage('banned');
    await flushTokenStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('a renewal while this page reloads onto another session sends nothing', () => {
  it('in the browser build', async () => {
    const p = expiredPair('s-1', 1);
    setTokens(p.accessToken, p.refreshToken, true);
    await flushTokenStorage();
    reloadAfterSessionChange();

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe(p.refreshToken);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('in the desktop app', async () => {
    const invoke = async <T>(): Promise<T> => null as T;
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    _setPageReloadForTests(reload);
    await hydrateTokens();
    const p = expiredPair('s-1', 1);
    setTokens(p.accessToken, p.refreshToken, true);
    await flushTokenStorage();
    reloadAfterSessionChange();

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(post).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
