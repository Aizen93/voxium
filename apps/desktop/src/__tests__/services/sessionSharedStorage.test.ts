import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, reloadAfterSessionChange, createKeychainSessionStore,
  _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests,
} from '../../services/tokenStorage';
import {
  refreshAccessToken, SessionLostError, setSessionLostNavigation, _resetSessionForTests, _setRefreshLocksForTests,
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
