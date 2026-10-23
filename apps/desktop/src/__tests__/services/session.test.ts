import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => http.post(...args),
    isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean } | null)?.isAxiosError,
  },
  isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean } | null)?.isAxiosError,
}));

const storage = vi.hoisted(() => ({
  access: null as string | null,
  refresh: null as string | null,
  getAccessToken: vi.fn(() => storage.access),
  getRefreshToken: vi.fn(() => storage.refresh),
  setTokens: vi.fn((a: string, r: string) => { storage.access = a; storage.refresh = r; }),
  clearTokens: vi.fn(() => { storage.access = null; storage.refresh = null; }),
}));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: storage.getAccessToken,
  getRefreshToken: storage.getRefreshToken,
  setTokens: storage.setTokens,
  clearTokens: storage.clearTokens,
}));

import {
  accessTokenExpiresAt, isAccessTokenFresh, refreshAccessToken, getFreshAccessToken,
  isDefinitiveRefreshFailure, SessionLostError, setSessionLostNavigation, _resetSessionForTests,
  TOKEN_EXPIRY_SKEW_MS, API_BASE,
} from '../../services/session';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A JWT-shaped string whose payload carries `exp` (seconds). Unsigned: only the claim is read. */
function jwtWithExp(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ sub: 'u-1', exp: expSeconds })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

function axios401(): unknown {
  return Object.assign(new Error('Request failed with status code 401'), { isAxiosError: true, response: { status: 401, data: { success: false, error: 'Invalid refresh token' } } });
}
function networkError(): unknown {
  return Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
}

const navigate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionForTests();
  setSessionLostNavigation(navigate);
  storage.access = 'access-old';
  storage.refresh = 'refresh-old';
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('session — reading the access token expiry', () => {
  it('decodes the exp claim as milliseconds', () => {
    expect(accessTokenExpiresAt(jwtWithExp(1_700_000_000))).toBe(1_700_000_000_000);
  });

  it('answers null for anything that is not a three-part token with a JSON payload', () => {
    expect(accessTokenExpiresAt('not-a-jwt')).toBeNull();
    expect(accessTokenExpiresAt('a.b.c')).toBeNull();
    expect(accessTokenExpiresAt(`h.${btoa('{"exp":"soon"}')}.s`)).toBeNull();
  });

  it('a token is fresh while more than the skew is left, expired within it, and an undecodable one is left to the server', () => {
    const now = 1_000_000_000_000;
    expect(isAccessTokenFresh(jwtWithExp((now + TOKEN_EXPIRY_SKEW_MS + 1000) / 1000), now)).toBe(true);
    expect(isAccessTokenFresh(jwtWithExp((now + TOKEN_EXPIRY_SKEW_MS - 1000) / 1000), now)).toBe(false);
    expect(isAccessTokenFresh(jwtWithExp((now - 60_000) / 1000), now)).toBe(false);
    expect(isAccessTokenFresh('garbage', now)).toBe(true);
  });
});

describe('session — refreshAccessToken', () => {
  it('posts the stored refresh token to the refresh route, stores the new pair and resolves the access token', async () => {
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } });

    await expect(refreshAccessToken()).resolves.toBe('access-new');

    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-old' });
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('is single-flight: callers during the round trip share ONE request and its answer', async () => {
    let finish!: (v: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((r) => { finish = r; }));

    const a = refreshAccessToken();
    const b = refreshAccessToken();
    expect(b).toBe(a);
    finish({ data: { data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } });

    await expect(Promise.all([a, b])).resolves.toEqual(['access-new', 'access-new']);
    expect(http.post).toHaveBeenCalledTimes(1);

    // A later call is a new request
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-3', refreshToken: 'refresh-3' } } });
    await expect(refreshAccessToken()).resolves.toBe('access-3');
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('a REFUSED refresh (401) ends the session: tokens cleared, login page, SessionLostError', async () => {
    http.post.mockRejectedValueOnce(axios401());

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(storage.clearTokens).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('a TRANSIENT failure (no answer) fails this renewal only: tokens untouched, no login page', async () => {
    // A laptop that woke up before its network did used to be signed out here
    http.post.mockRejectedValueOnce(networkError());

    await expect(refreshAccessToken()).rejects.toMatchObject({ message: 'Network Error' });

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(storage.access).toBe('access-old');
  });

  it('a server error (5xx) and a 429 are transient too', async () => {
    for (const status of [500, 503, 429]) {
      http.post.mockRejectedValueOnce(Object.assign(new Error(`status ${status}`), { isAxiosError: true, response: { status } }));
      await expect(refreshAccessToken()).rejects.toMatchObject({ message: `status ${status}` });
    }
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('with no refresh token there is no session to renew: ended at once', async () => {
    storage.refresh = null;

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(http.post).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('the login navigation happens once however many refusals land', async () => {
    http.post.mockRejectedValue(axios401());
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    storage.refresh = 'refresh-old';
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(navigate).toHaveBeenCalledTimes(1);
    http.post.mockReset();
  });

  it('isDefinitiveRefreshFailure: 401 and 403 answers only', () => {
    expect(isDefinitiveRefreshFailure(axios401())).toBe(true);
    expect(isDefinitiveRefreshFailure(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 403 } }))).toBe(true);
    expect(isDefinitiveRefreshFailure(networkError())).toBe(false);
    expect(isDefinitiveRefreshFailure(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 500 } }))).toBe(false);
    expect(isDefinitiveRefreshFailure(new Error('plain'))).toBe(false);
  });
});

describe('session — getFreshAccessToken', () => {
  it('answers the stored token while it is fresh, without a request', async () => {
    storage.access = jwtWithExp((Date.now() + 10 * 60_000) / 1000);

    await expect(getFreshAccessToken()).resolves.toBe(storage.access);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('renews an expired one', async () => {
    storage.access = jwtWithExp((Date.now() - 60_000) / 1000);
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } });

    await expect(getFreshAccessToken()).resolves.toBe('access-new');
  });

  it('answers null when there is no session', async () => {
    storage.access = null;

    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(http.post).not.toHaveBeenCalled();
  });
});
