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
  // The persisted clear a session-ending navigation waits for; resolved at
  // once unless a test holds it
  flushTokenStorage: vi.fn(async () => {}),
}));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: storage.getAccessToken,
  getRefreshToken: storage.getRefreshToken,
  setTokens: storage.setTokens,
  clearTokens: storage.clearTokens,
  flushTokenStorage: storage.flushTokenStorage,
}));

import {
  accessTokenExpiresAt, isAccessTokenFresh, shouldRenewBeforeSending, refreshAccessToken, getFreshAccessToken,
  endSessionRenewals, isDefinitiveRefreshFailure, SessionLostError, setSessionLostNavigation, _resetSessionForTests,
  TOKEN_EXPIRY_SKEW_MS, REFRESH_TIMEOUT_MS, API_BASE,
} from '../../services/session';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A JWT-shaped string whose payload carries `exp` (seconds) and optionally `iat`. Unsigned: only the claims are read. */
function jwtWithExp(expSeconds: number, iatSeconds?: number): string {
  const claims: Record<string, unknown> = { sub: 'u-1', exp: expSeconds };
  if (iatSeconds !== undefined) claims.iat = iatSeconds;
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

/** What the server answers a refresh with: a token issued "now" on ITS clock, living 15 minutes. */
function serverIssued(serverNowMs: number): { accessToken: string; refreshToken: string } {
  const iat = Math.floor(serverNowMs / 1000);
  return { accessToken: jwtWithExp(iat + 15 * 60, iat), refreshToken: 'refresh-new' };
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

    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-old' }, { timeout: REFRESH_TIMEOUT_MS });
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

  it('the navigation to the login page waits for the persisted clear (a reload must not outrun the keychain write)', async () => {
    // In the desktop app clearTokens() returns before the OS credential
    // store has the delete: reloading first would load the refused tokens
    // again at the next launch, be refused again, and loop
    let release!: () => void;
    storage.flushTokenStorage.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    http.post.mockRejectedValueOnce(axios401());

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(storage.clearTokens).toHaveBeenCalled();
    expect(storage.flushTokenStorage).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
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

  it('a renewal that lands AFTER a logout stores nothing, reconnects nothing, and does not navigate', async () => {
    // The answer belongs to the logged-out user; storing it (and the REST
    // client's 401 path then opening a socket for it) resurrected the session
    let finish!: (v: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const pending = refreshAccessToken();

    endSessionRenewals();
    storage.clearTokens();
    finish({ data: { data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } });

    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.access).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a refusal that lands after a logout does not navigate either (the login page is already up)', async () => {
    let fail!: (e: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((_r, j) => { fail = j; }));
    const pending = refreshAccessToken();

    endSessionRenewals();
    fail(axios401());

    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('after a logout a new session renews again (the in-flight slot is free)', async () => {
    http.post.mockReturnValueOnce(new Promise(() => {})); // never settles
    void refreshAccessToken().catch(() => {});
    endSessionRenewals();
    storage.refresh = 'refresh-next-session';
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-2', refreshToken: 'refresh-2' } } });

    await expect(refreshAccessToken()).resolves.toBe('access-2');
    expect(http.post).toHaveBeenLastCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-next-session' }, { timeout: REFRESH_TIMEOUT_MS });
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

describe('session — a device clock out of step with the server', () => {
  // A device clock 20 minutes ahead read every fresh 15-minute token as
  // expired and renewed on EVERY request: the per-IP refresh limiter, shared
  // by everyone behind the same NAT, was spent in silence
  const AHEAD_MS = 20 * 60_000;

  it('learns the server clock from a renewed token\'s iat, and judges freshness on it from then on', async () => {
    const serverNow = Date.now() - AHEAD_MS; // this device is 20 min ahead
    storage.access = jwtWithExp((Date.now() - 60_000) / 1000); // reads expired either way
    http.post.mockResolvedValueOnce({ data: { data: serverIssued(serverNow) } });

    const renewed = await getFreshAccessToken();
    expect(renewed).toBe(storage.access);

    // The renewed token expires 15 min after SERVER now, which is 5 min before
    // DEVICE now: read naively it is expired; read on the learnt offset it is fresh
    expect(isAccessTokenFresh(renewed!, Date.now())).toBe(false);
    expect(shouldRenewBeforeSending(renewed!)).toBe(false);
    await expect(getFreshAccessToken()).resolves.toBe(renewed);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a renewal answering a token that still reads expired (no iat to learn from) suspends proactive renewal: 401s only from here', async () => {
    storage.access = jwtWithExp((Date.now() - 60_000) / 1000);
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: jwtWithExp((Date.now() - 1000) / 1000), refreshToken: 'r' } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const renewed = await getFreshAccessToken();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('renewing on 401 only'));
    // Still "expired" by the clock, but no longer renewed before sending
    expect(isAccessTokenFresh(renewed!)).toBe(false);
    expect(shouldRenewBeforeSending(renewed!)).toBe(false);
    await expect(getFreshAccessToken()).resolves.toBe(renewed);
    expect(http.post).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a device clock BEHIND the server never renews early either', async () => {
    const serverNow = Date.now() + AHEAD_MS; // this device is 20 min behind
    storage.access = jwtWithExp((Date.now() - 60_000) / 1000);
    http.post.mockResolvedValueOnce({ data: { data: serverIssued(serverNow) } });

    const renewed = await getFreshAccessToken();

    // Naively it has 35 min left; on the server's clock, 15: fresh both ways,
    // and the offset would call it expired at the right moment, not 20 min late
    expect(shouldRenewBeforeSending(renewed!)).toBe(false);
    expect(isAccessTokenFresh(renewed!, Date.now() + AHEAD_MS + 15 * 60_000)).toBe(false);
  });
});
