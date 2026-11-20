import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  /** The browser build: the store is the page's storage, which other tabs write too. */
  shared: false,
  /** What another tab left in the page's storage, which a re-read brings into memory (undefined: nothing new). */
  page: undefined as { access: string | null; refresh: string | null } | undefined,
  getAccessToken: vi.fn(() => storage.access),
  getRefreshToken: vi.fn(() => storage.refresh),
  setTokens: vi.fn((a: string, r: string) => { storage.access = a; storage.refresh = r; }),
  clearTokens: vi.fn(() => { storage.access = null; storage.refresh = null; }),
  // The persisted clear a session-ending navigation waits for; resolved at
  // once unless a test holds it
  flushTokenStorage: vi.fn(async () => {}),
  isSharedWithOtherTabs: vi.fn(() => storage.shared),
  /** What following the shared storage answers: 'reloading' when it holds another account's session. */
  follow: 'followed' as 'followed' | 'reloading',
  followSharedSession: vi.fn(() => {
    if (storage.follow === 'reloading') return 'reloading';
    if (storage.shared && storage.page !== undefined) {
      storage.access = storage.page.access;
      storage.refresh = storage.page.refresh;
    }
    return 'followed';
  }),
  /** What a session-ending clear finds: 'replaced' when another tab stored a different session. */
  clearOutcome: 'cleared' as 'cleared' | 'replaced',
  clearSessionTokens: vi.fn((_endedToken: string | null) => {
    if (storage.clearOutcome === 'replaced') {
      storage.access = null;
      storage.refresh = null;
      return 'replaced';
    }
    storage.clearTokens();
    return 'cleared';
  }),
  reloadAfterSessionChange: vi.fn(),
}));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: storage.getAccessToken,
  getRefreshToken: storage.getRefreshToken,
  setTokens: storage.setTokens,
  clearTokens: storage.clearTokens,
  clearSessionTokens: storage.clearSessionTokens,
  reloadAfterSessionChange: storage.reloadAfterSessionChange,
  flushTokenStorage: storage.flushTokenStorage,
  isSharedWithOtherTabs: storage.isSharedWithOtherTabs,
  followSharedSession: storage.followSharedSession,
}));

import {
  accessTokenExpiresAt, isAccessTokenFresh, shouldRenewBeforeSending, refreshAccessToken, getFreshAccessToken,
  endSessionRenewals, isDefinitiveRefreshFailure, SessionLostError, setSessionLostNavigation, _resetSessionForTests,
  _setRefreshLocksForTests, type RefreshLockManager,
  TOKEN_EXPIRY_SKEW_MS, REFRESH_TIMEOUT_MS, REFRESH_RETRY_DELAY_MS, REFRESH_LOCK_NAME, REFRESH_LOCK_WAIT_MS, API_BASE,
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

function axiosStatus(status: number): unknown {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });
}
function timeoutError(): unknown {
  return Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
}
const renewed = (access: string, refresh: string) => ({ data: { data: { accessToken: access, refreshToken: refresh } } });
const freshToken = () => jwtWithExp(Math.floor(Date.now() / 1000) + 15 * 60);
const expiredToken = () => jwtWithExp(Math.floor(Date.now() / 1000) - 60);

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionForTests();
  setSessionLostNavigation(navigate);
  storage.access = 'access-old';
  storage.refresh = 'refresh-old';
  storage.shared = false;
  storage.page = undefined;
  storage.follow = 'followed';
  storage.clearOutcome = 'cleared';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-old', client: 'web' }, { timeout: REFRESH_TIMEOUT_MS });
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
    expect(navigate).not.toHaveBeenCalled();
  });

  it("the refresh body names the kind of app: 'desktop' in the Tauri app", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } });
      await refreshAccessToken();
      expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-old', client: 'desktop' }, { timeout: REFRESH_TIMEOUT_MS });
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
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
    vi.useFakeTimers();
    http.post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());

    const pending = refreshAccessToken();
    const settled = expect(pending).rejects.toMatchObject({ message: 'Network Error' });
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;

    expect(http.post).toHaveBeenCalledTimes(2); // the one prompt retry, no more
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(storage.access).toBe('access-old');
  });

  it('a server error (5xx) and a 429 are transient too', async () => {
    vi.useFakeTimers();
    for (const status of [500, 503, 429]) {
      http.post.mockReset();
      http.post.mockRejectedValue(Object.assign(new Error(`status ${status}`), { isAxiosError: true, response: { status } }));
      const settled = expect(refreshAccessToken()).rejects.toMatchObject({ message: `status ${status}` });
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
      await settled;
      // a 5xx got one prompt retry; a 429 none (retrying into the limiter only spends it)
      expect(http.post).toHaveBeenCalledTimes(status === 429 ? 1 : 2);
    }
    http.post.mockReset();
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
    void refreshAccessToken();
    endSessionRenewals();
    storage.refresh = 'refresh-next-session';
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-2', refreshToken: 'refresh-2' } } });

    await expect(refreshAccessToken()).resolves.toBe('access-2');
    expect(http.post).toHaveBeenLastCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-next-session', client: 'web' }, { timeout: REFRESH_TIMEOUT_MS });
  });

  it('a refusal while the refused refresh token is STILL the stored one signs out exactly once, however many callers shared it', async () => {
    let fail!: (e: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((_r, j) => { fail = j; }));
    const a = refreshAccessToken();
    const b = refreshAccessToken();
    fail(axios401());

    await expect(a).rejects.toBeInstanceOf(SessionLostError);
    await expect(b).rejects.toBeInstanceOf(SessionLostError);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.clearTokens).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it('a refusal while a NEWER pair was stored meanwhile (another tab, a password change) does not sign out: its fresh access token is answered', async () => {
    // Tab B sent the old refresh token; tab A stored the pair of the new
    // password while it was out. Clearing would remove A's pair from the
    // shared storage and A would follow the removal
    const freshAccess = jwtWithExp(Math.floor(Date.now() / 1000) + 15 * 60);
    let fail!: (e: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((_r, j) => { fail = j; }));
    const pending = refreshAccessToken();
    storage.access = freshAccess;
    storage.refresh = 'refresh-from-other-tab';
    fail(axios401());

    await expect(pending).resolves.toBe(freshAccess);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(storage.refresh).toBe('refresh-from-other-tab');
  });

  it('a refusal while a newer pair with an EXPIRED access token was stored: ONE more refresh with the newer refresh token', async () => {
    let fail!: (e: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((_r, j) => { fail = j; }));
    const pending = refreshAccessToken();
    storage.access = jwtWithExp(Math.floor(Date.now() / 1000) - 60);
    storage.refresh = 'refresh-from-other-tab';
    http.post.mockResolvedValueOnce({ data: { data: { accessToken: 'access-2', refreshToken: 'refresh-2' } } });
    fail(axios401());

    await expect(pending).resolves.toBe('access-2');
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post).toHaveBeenLastCalledWith(`${API_BASE}/auth/refresh`, { refreshToken: 'refresh-from-other-tab', client: 'web' }, { timeout: REFRESH_TIMEOUT_MS });
    expect(storage.setTokens).toHaveBeenCalledWith('access-2', 'refresh-2');
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('the retry with the newer pair refused too, that pair still stored: the session ends, once', async () => {
    let fail!: (e: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((_r, j) => { fail = j; }));
    const pending = refreshAccessToken();
    storage.access = null;
    storage.refresh = 'refresh-from-other-tab';
    http.post.mockRejectedValueOnce(axios401());
    fail(axios401());

    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(storage.clearTokens).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it('the pair replaced AGAIN while the retry was out: no third request, no sign-out, a transient failure', async () => {
    let fail1!: (e: unknown) => void;
    let fail2!: (e: unknown) => void;
    http.post
      .mockReturnValueOnce(new Promise((_r, j) => { fail1 = j; }))
      .mockReturnValueOnce(new Promise((_r, j) => { fail2 = j; }));
    const pending = refreshAccessToken();
    storage.access = null;
    storage.refresh = 'refresh-2';
    fail1(axios401());
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledTimes(2));
    storage.refresh = 'refresh-3';
    fail2(axios401());

    await expect(pending).rejects.not.toBeInstanceOf(SessionLostError);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(storage.refresh).toBe('refresh-3');
  });

  it('a logout while the retry with the newer pair is out stores nothing and does not navigate', async () => {
    let fail!: (e: unknown) => void;
    let finish!: (v: unknown) => void;
    http.post
      .mockReturnValueOnce(new Promise((_r, j) => { fail = j; }))
      .mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const pending = refreshAccessToken();
    storage.access = null;
    storage.refresh = 'refresh-2';
    fail(axios401());
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledTimes(2));
    endSessionRenewals();
    finish({ data: { data: { accessToken: 'access-x', refreshToken: 'refresh-x' } } });

    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
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

describe('session — the prompt retry after a refresh that got no usable answer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('a lost answer (timeout) is asked again ONCE, about 3 s later, inside the same renewal: callers share it', async () => {
    http.post.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    const a = refreshAccessToken();
    const b = refreshAccessToken();
    expect(b).toBe(a);
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS - 1);
    expect(http.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(a).resolves.toBe('access-new');
    expect(http.post).toHaveBeenCalledTimes(2);
    // the same refresh token both times: within the grace window the server answers it again
    expect(http.post.mock.calls[1][1]).toEqual({ refreshToken: 'refresh-old', client: 'web' });
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
  });

  it('a 5xx gets the retry too; a 429, a 400 and a refusal never do', async () => {
    http.post.mockRejectedValueOnce(axiosStatus(502)).mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const first = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await expect(first).resolves.toBe('access-new');
    expect(http.post).toHaveBeenCalledTimes(2);

    for (const status of [429, 400]) {
      http.post.mockReset();
      http.post.mockRejectedValueOnce(axiosStatus(status));
      const settled = expect(refreshAccessToken()).rejects.toMatchObject({ response: { status } });
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS * 2);
      await settled;
      expect(http.post).toHaveBeenCalledTimes(1);
    }

    http.post.mockReset();
    http.post.mockRejectedValueOnce(axios401());
    const refused = expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS * 2);
    await refused;
    expect(http.post).toHaveBeenCalledTimes(1);
    http.post.mockReset();
  });

  it('nothing is retried while the page says it is offline, nor when it went offline during the wait', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    http.post.mockRejectedValueOnce(networkError());
    const settledOffline = expect(refreshAccessToken()).rejects.toMatchObject({ message: 'Network Error' });
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settledOffline;
    expect(http.post).toHaveBeenCalledTimes(1);

    const nav = { onLine: true };
    vi.stubGlobal('navigator', nav);
    http.post.mockRejectedValueOnce(networkError());
    const settled = expect(refreshAccessToken()).rejects.toMatchObject({ message: 'Network Error' });
    await vi.advanceTimersByTimeAsync(1);
    nav.onLine = false;
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('a logout during the wait ends it: no second request, nothing stored, no navigation', async () => {
    http.post.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(renewed('access-x', 'refresh-x'));
    const settled = expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    await vi.advanceTimersByTimeAsync(1);
    endSessionRenewals();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;

    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    http.post.mockReset();
  });

  it('a pair stored during the wait (another tab renewed) is the answer when fresh: no second request; an expired one fails the renewal', async () => {
    const fresh = freshToken();
    http.post.mockRejectedValueOnce(networkError());
    const pending = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(1);
    storage.access = fresh;
    storage.refresh = 'refresh-from-other-tab';
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await expect(pending).resolves.toBe(fresh);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.setTokens).not.toHaveBeenCalled();

    storage.access = 'access-old';
    storage.refresh = 'refresh-old';
    http.post.mockRejectedValueOnce(networkError());
    const settled = expect(refreshAccessToken()).rejects.toMatchObject({ message: 'Network Error' });
    await vi.advanceTimersByTimeAsync(1);
    storage.access = expiredToken();
    storage.refresh = 'refresh-from-other-tab-2';
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(storage.clearTokens).not.toHaveBeenCalled();
  });

  it('the retry refused with a newer pair stored meanwhile still adopts it: at most three requests in all', async () => {
    http.post
      .mockRejectedValueOnce(networkError())
      .mockImplementationOnce(async () => {
        storage.access = expiredToken();
        storage.refresh = 'refresh-from-other-tab';
        throw axios401();
      })
      .mockResolvedValueOnce(renewed('access-3', 'refresh-3'));

    const pending = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await expect(pending).resolves.toBe('access-3');
    expect(http.post).toHaveBeenCalledTimes(3);
    expect(http.post.mock.calls[2][1]).toEqual({ refreshToken: 'refresh-from-other-tab', client: 'web' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('session — an answer is stored only while the token it answers is still the stored one', () => {
  it('a pair stored while the request was out (another tab, a credential change) stands: the answer is dropped', async () => {
    let finish!: (v: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const pending = refreshAccessToken();
    storage.access = 'access-from-other-tab';
    storage.refresh = 'refresh-from-other-tab';
    finish(renewed('access-late', 'refresh-late'));

    await expect(pending).resolves.toBe('access-from-other-tab');
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.refresh).toBe('refresh-from-other-tab');
  });

  it('a pair removed while the request was out (another tab signed out) is not brought back: SessionLostError, no navigation', async () => {
    let finish!: (v: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const pending = refreshAccessToken();
    storage.access = null;
    storage.refresh = null;
    finish(renewed('access-late', 'refresh-late'));

    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('an answer without a token pair stores nothing and fails the renewal only', async () => {
    http.post.mockResolvedValueOnce({ data: { data: {} } });

    await expect(refreshAccessToken()).rejects.toThrow('The refresh answer carried no token pair');
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('session — the browser build reads the shared storage again before every refresh', () => {
  beforeEach(() => {
    storage.shared = true;
    _setRefreshLocksForTests(null); // a page without Web Locks (an insecure origin): the re-read alone
  });

  it('a tab with stale memory adopts the pair another tab stored when its access token is fresh, and sends nothing', async () => {
    const fresh = freshToken();
    storage.page = { access: fresh, refresh: 'refresh-from-other-tab' };

    await expect(refreshAccessToken()).resolves.toBe(fresh);

    expect(http.post).not.toHaveBeenCalled();
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.refresh).toBe('refresh-from-other-tab');
  });

  it('with an expired access token it sends the NEWER refresh token, never the replaced one', async () => {
    storage.page = { access: expiredToken(), refresh: 'refresh-from-other-tab' };
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    await expect(refreshAccessToken()).resolves.toBe('access-new');

    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0][1]).toEqual({ refreshToken: 'refresh-from-other-tab', client: 'web' });
  });

  it('reads again before acting on a refusal: a newer pair another tab stored is adopted instead of signing out', async () => {
    const fresh = freshToken();
    http.post.mockImplementationOnce(async () => {
      storage.page = { access: fresh, refresh: 'refresh-from-other-tab' };
      throw axios401();
    });

    await expect(refreshAccessToken()).resolves.toBe(fresh);
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reads again before storing an answer: a pair another tab stored meanwhile stands', async () => {
    http.post.mockImplementationOnce(async () => {
      storage.page = { access: 'access-from-other-tab', refresh: 'refresh-from-other-tab' };
      return renewed('access-late', 'refresh-late');
    });

    await expect(refreshAccessToken()).resolves.toBe('access-from-other-tab');
    expect(storage.setTokens).not.toHaveBeenCalled();
  });

  it('the desktop app (a store shared with no tab) asks for no lock', async () => {
    storage.shared = false;
    const request = vi.fn();
    _setRefreshLocksForTests({ request });
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    await expect(refreshAccessToken()).resolves.toBe('access-new');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('session — the browser build renews under one Web Lock', () => {
  /** A lock manager of one exclusive lock: grants in order, honours the abort signal while waiting. */
  function fakeLocks() {
    const queue: Array<() => void> = [];
    let held = false;
    const options: unknown[] = [];
    const manager: RefreshLockManager = {
      request: (name, opts, callback) => {
        options.push({ name, ...opts });
        return new Promise((resolve, reject) => {
          const grant = () => {
            held = true;
            Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(() => {
                held = false;
                queue.shift()?.();
              });
          };
          opts.signal.addEventListener('abort', () => {
            const at = queue.indexOf(grant);
            if (at >= 0) {
              queue.splice(at, 1);
              reject(Object.assign(new Error('The request was aborted'), { name: 'AbortError' }));
            }
          });
          if (held) queue.push(grant);
          else grant();
        });
      },
    };
    return { manager, options, hold: () => { held = true; }, release: () => { held = false; queue.shift()?.(); } };
  }

  beforeEach(() => {
    storage.shared = true;
  });

  it('runs the refresh under the named lock, exclusive, with a signal — never steal, never ifAvailable', async () => {
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    await expect(refreshAccessToken()).resolves.toBe('access-new');

    expect(locks.options).toHaveLength(1);
    expect(locks.options[0]).toMatchObject({ name: REFRESH_LOCK_NAME, mode: 'exclusive' });
    expect(Object.keys(locks.options[0] as object).sort()).toEqual(['mode', 'name', 'signal']);
  });

  it("a renewal that waited for another tab's finds that tab's pair after the lock and sends nothing", async () => {
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    locks.hold(); // another tab is renewing
    const pending = refreshAccessToken();
    await Promise.resolve();
    expect(http.post).not.toHaveBeenCalled();

    // the other tab stored its renewal, then let the lock go
    const fresh = freshToken();
    storage.page = { access: fresh, refresh: 'refresh-from-other-tab' };
    locks.release();

    await expect(pending).resolves.toBe(fresh);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('the wait for the lock is bounded: past it the renewal goes on with the re-read alone', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    locks.hold(); // a frozen tab that never lets go
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    const pending = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS - 1);
    expect(http.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe('access-new');
    expect(storage.followSharedSession).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held the renewal lock too long'));
    warn.mockRestore();
  });

  it('a lock manager that refuses leaves the renewal to the re-read alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setRefreshLocksForTests({ request: () => Promise.reject(new Error('SecurityError')) });
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    await expect(refreshAccessToken()).resolves.toBe('access-new');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock is not available'), 'SecurityError');
    warn.mockRestore();
  });

  it("an error of the renewal itself, inside the lock, is not mistaken for the lock's: no second run", async () => {
    vi.useFakeTimers();
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    http.post.mockRejectedValueOnce(axiosStatus(429));

    const settled = expect(refreshAccessToken()).rejects.toMatchObject({ response: { status: 429 } });
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS);
    await settled;
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

describe('session — a session-ending refusal clears only the session it refused', () => {
  it('passes the refused token to the clear, and navigates to the login page once it is cleared', async () => {
    http.post.mockRejectedValueOnce(axios401());

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(storage.clearSessionTokens).toHaveBeenCalledWith('refresh-old');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(storage.reloadAfterSessionChange).not.toHaveBeenCalled();
  });

  it('another tab stored a different session meanwhile: that one is kept and the page reloads onto it, no login page', async () => {
    storage.clearOutcome = 'replaced';
    http.post.mockRejectedValueOnce(axios401());

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('the storage holding another account\'s session stops the renewal at once: nothing sent, no login page', async () => {
    storage.follow = 'reloading';

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    expect(http.post).not.toHaveBeenCalled();
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
