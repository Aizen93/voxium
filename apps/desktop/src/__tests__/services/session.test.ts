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
  // ─── The mark of a credential change, as the real module reads it ───────
  /** The T of a credential change marked in flight by some tab of this browser (null: none). */
  mark: null as number | null,
  /** Which mark is the one written now: a removal removes only its own. */
  markId: 0,
  markWaiters: [] as Array<() => void>,
  /** The mark goes (its change was answered, or failed): every wait for it ends. */
  clearMark: () => {
    storage.mark = null;
    for (const waiter of storage.markWaiters.splice(0)) waiter();
  },
  /** Live as tokenStorage.credentialChangeInFlightUntil reads it: before T, and T no further ahead than `maxAheadMs` and 5 s. */
  liveMark: (maxAheadMs: number, now: number = Date.now()): number | null => {
    const until = storage.mark;
    if (until === null || until <= now || until - now > maxAheadMs + 5_000) return null;
    return until;
  },
  markCredentialChange: vi.fn((until: number) => {
    storage.mark = until;
    const id = ++storage.markId;
    // tokenStorage's removal: only while the mark is still this one
    return () => {
      storage.unmark();
      if (storage.markId === id) storage.clearMark();
    };
  }),
  /** Called by every removal of a mark of this tab, whether or not it was still the one written. */
  unmark: vi.fn(),
  credentialChangeInFlightUntil: vi.fn((maxAheadMs: number, now?: number) => storage.liveMark(maxAheadMs, now)),
  /** As the real wait: false at once without a live mark; else until the mark goes, or its T at the latest. */
  waitForCredentialChange: vi.fn((maxAheadMs: number) => {
    const until = storage.liveMark(maxAheadMs);
    if (until === null) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), until - Date.now());
      storage.markWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }),
  // ─── This tab's question to its twins, as the real module bounds it ──────
  /** This tab asked its twins (at `twinAskedAt`) and no renewal has waited for their answer yet. */
  twinAsked: false,
  twinAskedAt: 0,
  askTwins: () => {
    storage.twinAsked = true;
    storage.twinAskedAt = Date.now();
  },
  twinSyncPending: vi.fn(() => storage.twinAsked),
  /** As the real wait: once, until 300 ms (TWIN_SYNC_WAIT_MS) after the question, the whole of it. */
  awaitTwinSync: vi.fn(() => {
    if (!storage.twinAsked) return Promise.resolve();
    storage.twinAsked = false;
    return new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, storage.twinAskedAt + 300 - Date.now()));
    });
  }),
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
  markCredentialChange: storage.markCredentialChange,
  credentialChangeInFlightUntil: storage.credentialChangeInFlightUntil,
  waitForCredentialChange: storage.waitForCredentialChange,
  twinSyncPending: storage.twinSyncPending,
  awaitTwinSync: storage.awaitTwinSync,
}));

import {
  accessTokenExpiresAt, isAccessTokenFresh, shouldRenewBeforeSending, refreshAccessToken, getFreshAccessToken,
  endSessionRenewals, isDefinitiveRefreshFailure, SessionLostError, setSessionLostNavigation, _resetSessionForTests,
  _setRefreshLocksForTests, runCredentialChange, goToLoginPage, noteIgnoredSessionEnd, forgetIgnoredSessionEnd, IGNORED_SESSION_END_WINDOW_MS,
  CREDENTIAL_CHANGE_TIMEOUT_MS, CREDENTIAL_CHANGE_MARK_MS, BACKGROUND_RENEWAL_DELAYS_MS, type RefreshLockManager,
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

/** A JWT-shaped string carrying `claims` (unsigned: only the claims are read). */
function jwtWith(claims: Record<string, unknown>): string {
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
  // clearAllMocks keeps the queued answers (mockResolvedValueOnce and the
  // like) a failed test left unconsumed: they would answer the next tests
  http.post.mockReset();
  storage.flushTokenStorage.mockReset();
  storage.flushTokenStorage.mockImplementation(async () => {});
  _resetSessionForTests();
  setSessionLostNavigation(navigate);
  storage.access = 'access-old';
  storage.refresh = 'refresh-old';
  storage.shared = false;
  storage.page = undefined;
  storage.follow = 'followed';
  storage.clearOutcome = 'cleared';
  storage.mark = null;
  storage.markId = 0;
  storage.markWaiters = [];
  storage.twinAsked = false;
  storage.twinAskedAt = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    let failed = false;
    const settledOffline = expect(refreshAccessToken().catch((err: unknown) => { failed = true; throw err; })).rejects.toMatchObject({ message: 'Network Error' });
    // an offline page fails at once: its callers do not wait out the retry's delay for nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toBe(true);
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

  it('reads the shared storage again after the wait: a pair another tab stored during it is the answer, nothing more is sent', async () => {
    storage.shared = true;
    _setRefreshLocksForTests(null);
    const fresh = freshToken();
    http.post.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(renewed('access-late', 'refresh-late'));
    const pending = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(1);
    // another tab renewed during the wait; this tab's memory missed the event
    storage.page = { access: fresh, refresh: 'refresh-from-other-tab' };
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);

    await expect(pending).resolves.toBe(fresh);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.setTokens).not.toHaveBeenCalled();
  });

  it('the storage holding another account after the wait stops the retry: nothing more is sent', async () => {
    storage.shared = true;
    _setRefreshLocksForTests(null);
    http.post.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(renewed('access-late', 'refresh-late'));
    const settled = expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    await vi.advanceTimersByTimeAsync(1);
    storage.follow = 'reloading';
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);

    await settled;
    expect(http.post).toHaveBeenCalledTimes(1);
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

describe('session — a credential change holds the renewals around it', () => {
  it('a renewal in flight lands (and is stored) BEFORE the change goes out', async () => {
    let finish!: (v: unknown) => void;
    http.post.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const renewal = refreshAccessToken();
    const change = vi.fn(async () => 'changed');

    const pending = runCredentialChange(change);
    await Promise.resolve();
    await Promise.resolve();
    expect(change).not.toHaveBeenCalled();

    finish(renewed(freshToken(), 'refresh-renewed'));
    await expect(renewal).resolves.toBeTruthy();
    await expect(pending).resolves.toBe('changed');
    expect(storage.setTokens.mock.invocationCallOrder[0]).toBeLessThan(change.mock.invocationCallOrder[0]);
  });

  it('renewals asked for during the change wait for it, then take the pair it stored and send nothing', async () => {
    storage.access = freshToken();
    let answer!: () => void;
    const pending = runCredentialChange(() => new Promise<string>((resolve) => {
      answer = () => {
        // the change stores the pair of the new version
        storage.access = freshToken();
        storage.refresh = 'refresh-new-version';
        resolve('changed');
      };
    }));
    await vi.waitFor(() => expect(answer).toBeDefined());

    const held = refreshAccessToken();
    await Promise.resolve();
    expect(http.post).not.toHaveBeenCalled();

    answer();
    await expect(pending).resolves.toBe('changed');
    await expect(held).resolves.toBe(storage.access);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('one change at a time: the second starts once the first has settled', async () => {
    storage.access = freshToken();
    let releaseFirst!: () => void;
    const first = vi.fn(() => new Promise<string>((resolve) => { releaseFirst = () => resolve('first'); }));
    const second = vi.fn(async () => 'second');

    const a = runCredentialChange(first);
    const b = runCredentialChange(second);
    await vi.waitFor(() => expect(first).toHaveBeenCalled());
    expect(second).not.toHaveBeenCalled();

    releaseFirst();
    await expect(a).resolves.toBe('first');
    await expect(b).resolves.toBe('second');
  });

  it('a change that fails lifts the hold, and the next renewal goes out', async () => {
    storage.access = freshToken();
    await expect(runCredentialChange(async () => { throw new Error('400'); })).rejects.toThrow('400');

    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    await expect(refreshAccessToken()).resolves.toBe('access-new');
  });

  it('an expired access token is renewed inline before the change, without waiting for itself', async () => {
    storage.access = expiredToken();
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const change = vi.fn(async () => {
      expect(storage.access).toBe('access-new');
      return 'changed';
    });

    await expect(runCredentialChange(change)).resolves.toBe('changed');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a renewal that waited for a change, overtaken by a sign-out and a new sign-in, sends nothing for the new session', async () => {
    storage.access = freshToken();
    let finish!: () => void;
    const change = runCredentialChange(() => new Promise<string>((resolve) => { finish = () => resolve('changed'); }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    const outcome = refreshAccessToken().then(() => 'resolved', (err: unknown) => err);
    await Promise.resolve();

    // signed out, then in again: a new session whose access token has expired
    endSessionRenewals();
    storage.access = expiredToken();
    storage.refresh = 'refresh-next-session';
    finish();
    await change;

    expect(await outcome).toBeInstanceOf(SessionLostError);
    expect(http.post).not.toHaveBeenCalled();
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.refresh).toBe('refresh-next-session');
  });

  it('with no session there is nothing to change: SessionLostError, nothing sent', async () => {
    storage.access = null;
    const change = vi.fn(async () => 'changed');
    await expect(runCredentialChange(change)).rejects.toBeInstanceOf(SessionLostError);
    expect(change).not.toHaveBeenCalled();
  });

  it('stillCurrent() is false once the session ended (logout) while the change was out', async () => {
    storage.access = freshToken();
    const seen: boolean[] = [];
    await runCredentialChange(async (stillCurrent) => {
      seen.push(stillCurrent());
      endSessionRenewals();
      seen.push(stillCurrent());
      return 'changed';
    });
    expect(seen).toEqual([true, false]);
  });

  it('in the browser build the change runs under the renewal lock, after reading the shared storage', async () => {
    storage.shared = true;
    storage.access = freshToken();
    const request = vi.fn((_name: string, _opts: unknown, callback: () => Promise<unknown>) => callback());
    _setRefreshLocksForTests({ request });
    const change = vi.fn(async () => {
      expect(storage.followSharedSession).toHaveBeenCalled();
      return 'changed';
    });

    await expect(runCredentialChange(change)).resolves.toBe('changed');
    expect(request).toHaveBeenCalledWith(REFRESH_LOCK_NAME, expect.objectContaining({ mode: 'exclusive' }), expect.any(Function));
    expect(CREDENTIAL_CHANGE_TIMEOUT_MS).toBe(75_000);
  });
});

describe('session — a credential change answers for the session it was made in, and never outlives it', () => {
  const fresh = (sid: string) => jwtWith({ userId: 'u-1', sid, exp: Math.floor(Date.now() / 1000) + 15 * 60 });
  const refreshOf = (sid: string, gen: number) => jwtWith({ userId: 'u-1', sid, gen });

  it('stillCurrent() holds while the stored pair is of the session read as the change went out, at any generation', async () => {
    storage.access = fresh('s-1');
    storage.refresh = refreshOf('s-1', 3);
    const seen: boolean[] = [];

    await runCredentialChange(async (stillCurrent) => {
      seen.push(stillCurrent());
      // a twin's rotation, or a tab that renewed without the lock: the same session
      storage.refresh = refreshOf('s-1', 4);
      seen.push(stillCurrent());
      // another tab's new sign-in (as anyone): its pair stands
      storage.access = fresh('s-2');
      storage.refresh = refreshOf('s-2', 1);
      seen.push(stillCurrent());
      // another tab signed out
      storage.access = null;
      storage.refresh = null;
      seen.push(stillCurrent());
      // the shared storage holds another account's session: the page reloads onto it
      storage.access = fresh('s-1');
      storage.refresh = refreshOf('s-1', 5);
      storage.follow = 'reloading';
      seen.push(stillCurrent());
      return 'changed';
    });

    expect(seen).toEqual([true, true, false, false, false]);
  });

  it('it re-reads the shared storage before it answers', async () => {
    storage.shared = true;
    _setRefreshLocksForTests(null);
    storage.access = fresh('s-1');
    storage.refresh = refreshOf('s-1', 1);
    const seen: boolean[] = [];

    await runCredentialChange(async (stillCurrent) => {
      // another tab signed in while the change was out; this tab missed the event
      storage.page = { access: fresh('s-other'), refresh: refreshOf('s-other', 1) };
      seen.push(stillCurrent());
      return 'changed';
    });

    expect(seen).toEqual([false]);
  });

  it('for a token issued before sessions, only that very token counts (the answer opens a session of its own for it)', async () => {
    const beforeSessions = jwtWith({ userId: 'u-1' });
    storage.access = jwtWith({ userId: 'u-1', exp: Math.floor(Date.now() / 1000) + 15 * 60 });
    storage.refresh = beforeSessions;
    const seen: boolean[] = [];

    await runCredentialChange(async (stillCurrent) => {
      seen.push(stillCurrent());
      // another tab's new sign-in to the SAME account: not this change's to overwrite
      storage.access = fresh('s-9');
      storage.refresh = refreshOf('s-9', 1);
      seen.push(stillCurrent());
      storage.refresh = jwtWith({ userId: 'u-1', n: 2 });
      seen.push(stillCurrent());
      return 'changed';
    });

    expect(seen).toEqual([true, false, false]);
  });

  it('the session is read as the change goes out, after the inline renewal of an expired access token', async () => {
    // a token issued before sessions, renewed into a session pair on the way
    storage.access = expiredToken();
    storage.refresh = jwtWith({ userId: 'u-1' });
    http.post.mockResolvedValueOnce(renewed(fresh('s-1'), refreshOf('s-1', 0)));
    const seen: boolean[] = [];

    await runCredentialChange(async (stillCurrent) => {
      seen.push(stillCurrent());
      return 'changed';
    });

    expect(seen).toEqual([true]);
  });

  it('a sign-out while a change is out releases its hold: the next session renews at once', async () => {
    storage.access = freshToken();
    let finish!: () => void;
    const change = runCredentialChange(() => new Promise<string>((resolve) => { finish = () => resolve('changed'); }));
    await vi.waitFor(() => expect(finish).toBeDefined());

    endSessionRenewals();
    storage.access = expiredToken();
    storage.refresh = 'refresh-next-session';
    http.post.mockResolvedValueOnce(renewed('access-2', 'refresh-2'));
    const renewal = refreshAccessToken();

    await vi.waitFor(() => expect(http.post).toHaveBeenCalledTimes(1));
    expect(http.post.mock.calls[0][1]).toEqual({ refreshToken: 'refresh-next-session', client: 'web' });
    await expect(renewal).resolves.toBe('access-2');
    finish();
    await expect(change).resolves.toBe('changed');
  });

  it('... and the next session\'s change does not queue behind it', async () => {
    storage.access = freshToken();
    const first = runCredentialChange(() => new Promise<string>(() => {}));
    await Promise.resolve();
    await Promise.resolve();

    endSessionRenewals();
    const second = vi.fn(async () => 'second');
    await expect(runCredentialChange(second)).resolves.toBe('second');
    void first;
  });

  it('... and it lets go of the renewal lock: the next session does not wait for it', async () => {
    storage.shared = true;
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    storage.access = freshToken();
    let finish!: () => void;
    const change = runCredentialChange(() => new Promise<string>((resolve) => { finish = () => resolve('changed'); }));
    await vi.waitFor(() => expect(finish).toBeDefined());

    endSessionRenewals();
    storage.access = expiredToken();
    storage.refresh = 'refresh-next-session';
    http.post.mockResolvedValueOnce(renewed('access-2', 'refresh-2'));
    const renewal = refreshAccessToken();

    await vi.waitFor(() => expect(http.post).toHaveBeenCalledTimes(1));
    await expect(renewal).resolves.toBe('access-2');
    finish();
    await change;
  });

  it('the old change settling releases nothing the next session\'s change holds', async () => {
    storage.access = freshToken();
    let finishFirst!: () => void;
    const first = runCredentialChange(() => new Promise<string>((resolve) => { finishFirst = () => resolve('first'); }));
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    endSessionRenewals();
    storage.refresh = 'refresh-next-session';
    let finishSecond!: () => void;
    const second = runCredentialChange(() => {
      storage.access = expiredToken();
      return new Promise<string>((resolve) => { finishSecond = () => resolve('second'); });
    });
    await vi.waitFor(() => expect(finishSecond).toBeDefined());

    finishFirst();
    await first;
    http.post.mockResolvedValueOnce(renewed('access-2', 'refresh-2'));
    const renewal = refreshAccessToken();
    await new Promise((r) => setTimeout(r, 20));
    // still held by the second change
    expect(http.post).not.toHaveBeenCalled();

    finishSecond();
    await second;
    await expect(renewal).resolves.toBe('access-2');
  });

  it('a change whose session ended while it waited for the lock sends nothing', async () => {
    storage.shared = true;
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    locks.hold(); // another tab is renewing
    storage.access = freshToken();
    const change = vi.fn(async () => 'changed');
    const pending = runCredentialChange(change);
    await Promise.resolve();

    endSessionRenewals();
    locks.release();

    await expect(pending).rejects.toBeInstanceOf(SessionLostError);
    expect(change).not.toHaveBeenCalled();
  });

  it('a change queued behind one, its session ended meanwhile, sends nothing under the next session', async () => {
    storage.access = freshToken();
    let releaseFirst!: (value: string) => void;
    const first = runCredentialChange(() => new Promise<string>((resolve) => { releaseFirst = resolve; }));
    const queued = vi.fn(async () => 'changed');
    const second = runCredentialChange(queued);
    await vi.waitFor(() => expect(storage.markCredentialChange).toHaveBeenCalledTimes(1));

    // a sign-out, then a sign-in to another session, while the first change is out
    endSessionRenewals();
    storage.access = freshToken();
    storage.refresh = 'refresh-next-session';
    releaseFirst('changed');

    await expect(first).resolves.toBe('changed');
    await expect(second).rejects.toBeInstanceOf(SessionLostError);
    expect(queued).not.toHaveBeenCalled();
    expect(storage.markCredentialChange).toHaveBeenCalledTimes(1);
  });
});

describe('session — a credential change in another tab, marked in the shared storage', () => {
  const markLive = () => { storage.mark = Date.now() + CREDENTIAL_CHANGE_MARK_MS; };

  it('the mark lasts the change\'s own deadline and a little more', () => {
    expect(CREDENTIAL_CHANGE_MARK_MS).toBe(CREDENTIAL_CHANGE_TIMEOUT_MS + 5_000);
  });

  it('a mark past its T, or further ahead than a change can take (80 s and 5 s), holds nothing: the request goes out at once', () => {
    storage.access = expiredToken();
    http.post.mockReturnValue(new Promise(() => {}));
    storage.mark = Date.now() - 1;
    void refreshAccessToken();
    expect(http.post).toHaveBeenCalledTimes(1);

    _resetSessionForTests();
    storage.mark = Date.now() + 80_000 + 5_000 + 1_000;
    void refreshAccessToken();
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(storage.waitForCredentialChange).not.toHaveBeenCalled();
  });

  it('a mark nobody removes (its tab was closed) holds a renewal until its T, not longer', async () => {
    vi.useFakeTimers();
    storage.access = expiredToken();
    storage.mark = Date.now() + 10_000;
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const renewal = refreshAccessToken();

    await vi.advanceTimersByTimeAsync(10_000 - 1);
    expect(http.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(renewal).resolves.toBe('access-new');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a renewal while it is in flight waits for it, then takes the pair it stored: nothing is sent', async () => {
    storage.access = expiredToken();
    markLive();
    const renewal = refreshAccessToken();
    await Promise.resolve();
    await Promise.resolve();
    expect(http.post).not.toHaveBeenCalled();

    // the change is answered in the other tab: its pair is stored, then the mark goes
    const answered = freshToken();
    storage.access = answered;
    storage.refresh = 'refresh-of-the-new-version';
    storage.clearMark();

    await expect(renewal).resolves.toBe(answered);
    expect(http.post).not.toHaveBeenCalled();
    expect(storage.waitForCredentialChange).toHaveBeenCalledWith(CREDENTIAL_CHANGE_MARK_MS);
  });

  it('... and sends the newest refresh token there is once it is over, when its access token has expired too', async () => {
    storage.access = expiredToken();
    markLive();
    http.post.mockResolvedValueOnce(renewed('access-3', 'refresh-3'));
    const renewal = refreshAccessToken();
    await Promise.resolve();

    storage.refresh = 'refresh-of-the-new-version';
    storage.clearMark();

    await expect(renewal).resolves.toBe('access-3');
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0][1]).toEqual({ refreshToken: 'refresh-of-the-new-version', client: 'web' });
  });

  it('a sign-out and a new sign-in during that wait: the old renewal sends nothing for the new session', async () => {
    storage.access = expiredToken();
    markLive();
    const outcome = refreshAccessToken().then(() => 'resolved', (err: unknown) => err);
    await Promise.resolve();

    endSessionRenewals();
    storage.refresh = 'refresh-next-session';
    storage.clearMark();

    expect(await outcome).toBeInstanceOf(SessionLostError);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('a refusal while it is in flight is not final: once the change\'s answer is stored, that pair is the answer', async () => {
    storage.access = expiredToken();
    let refuse!: () => void;
    http.post.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = () => reject(axios401()); }));
    const renewal = refreshAccessToken();
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledTimes(1));
    // the other tab's change went out while this request was out, and committed first
    markLive();
    refuse();
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();

    const answered = freshToken();
    storage.access = answered;
    storage.refresh = 'refresh-of-the-new-version';
    storage.clearMark();

    await expect(renewal).resolves.toBe(answered);
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('... and final when the change stored nothing (it failed, or its answer was dropped)', async () => {
    storage.access = expiredToken();
    http.post.mockImplementationOnce(async () => {
      markLive();
      throw axios401();
    });
    const renewal = expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    await new Promise((r) => setTimeout(r, 0));
    storage.clearMark();

    await renewal;
    expect(storage.clearSessionTokens).toHaveBeenCalledWith('refresh-old');
  });

  it('... and a sign-out during that wait clears nothing and sends nothing more', async () => {
    storage.access = expiredToken();
    http.post.mockImplementationOnce(async () => {
      markLive();
      throw axios401();
    });
    const outcome = refreshAccessToken().then(() => 'resolved', (err: unknown) => err);
    await new Promise((r) => setTimeout(r, 0));
    endSessionRenewals();
    storage.clearMark();

    expect(await outcome).toBeInstanceOf(SessionLostError);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
  });

  it('a renewal with no change in flight awaits nothing: its request goes out at once', () => {
    storage.access = expiredToken();
    http.post.mockReturnValueOnce(new Promise(() => {}));
    void refreshAccessToken();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a credential change waits for another tab\'s in flight before it goes out, and a sign-out meanwhile sends nothing', async () => {
    storage.access = freshToken();
    markLive();
    const change = vi.fn(async () => 'changed');
    const pending = runCredentialChange(change);
    await new Promise((r) => setTimeout(r, 0));
    expect(change).not.toHaveBeenCalled();
    storage.clearMark();
    await expect(pending).resolves.toBe('changed');

    markLive();
    const later = vi.fn(async () => 'changed');
    const refused = runCredentialChange(later);
    await new Promise((r) => setTimeout(r, 0));
    endSessionRenewals();
    storage.clearMark();
    await expect(refused).rejects.toBeInstanceOf(SessionLostError);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('session — a not-remembered tab that asked its twins renews on their answer', () => {
  it('its renewal waits for the answer, then sends the newest refresh token it holds', async () => {
    vi.useFakeTimers();
    storage.askTwins();
    storage.access = expiredToken();
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const renewal = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(299);
    expect(http.post).not.toHaveBeenCalled();

    // the twin's answer: its pair is taken as this tab's; the wait runs to its end
    storage.refresh = 'refresh-from-twin';
    await vi.advanceTimersByTimeAsync(1);

    await expect(renewal).resolves.toBe('access-new');
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0][1]).toEqual({ refreshToken: 'refresh-from-twin', client: 'web' });
  });

  it('a fresh pair in the answer is the renewal\'s answer: nothing is sent', async () => {
    vi.useFakeTimers();
    storage.askTwins();
    storage.access = expiredToken();
    const renewal = refreshAccessToken();
    await Promise.resolve();

    const fromTwin = freshToken();
    storage.access = fromTwin;
    storage.refresh = 'refresh-from-twin';
    await vi.advanceTimersByTimeAsync(300);

    await expect(renewal).resolves.toBe(fromTwin);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('no answer within the wait: it sends what it holds, 300 ms after the question', async () => {
    vi.useFakeTimers();
    storage.askTwins();
    storage.access = expiredToken();
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const renewal = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(300 - 1);
    expect(http.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(renewal).resolves.toBe('access-new');
    expect(http.post.mock.calls[0][1]).toEqual({ refreshToken: 'refresh-old', client: 'web' });
  });

  it('only a tab that asked waits: with no question out nothing is awaited', () => {
    storage.access = expiredToken();
    http.post.mockReturnValueOnce(new Promise(() => {}));
    void refreshAccessToken();
    expect(storage.awaitTwinSync).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a sign-out and a new sign-in during the wait: the old renewal sends nothing for the new session', async () => {
    vi.useFakeTimers();
    storage.askTwins();
    storage.access = expiredToken();
    const outcome = refreshAccessToken().then(() => 'resolved', (err: unknown) => err);
    await Promise.resolve();

    endSessionRenewals();
    storage.refresh = 'refresh-next-session';
    await vi.advanceTimersByTimeAsync(300);

    expect(await outcome).toBeInstanceOf(SessionLostError);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('the wait runs under the renewal lock, where there is one', async () => {
    storage.shared = true;
    const locks = fakeLocks();
    _setRefreshLocksForTests(locks.manager);
    locks.hold();
    vi.useFakeTimers();
    storage.askTwins();
    storage.access = expiredToken();
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const renewal = refreshAccessToken();
    await Promise.resolve();
    expect(storage.awaitTwinSync).not.toHaveBeenCalled();

    locks.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.awaitTwinSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await expect(renewal).resolves.toBe('access-new');
  });

  it('a credential change waits for the answer too, and goes out on the newest pair of the session', async () => {
    vi.useFakeTimers();
    storage.askTwins();
    storage.access = freshToken();
    const seen: boolean[] = [];
    const change = vi.fn(async (stillCurrent: () => boolean) => {
      seen.push(stillCurrent());
      return 'changed';
    });
    const pending = runCredentialChange(change);
    await vi.advanceTimersByTimeAsync(0);
    expect(change).not.toHaveBeenCalled();

    storage.refresh = 'refresh-from-twin';
    await vi.advanceTimersByTimeAsync(300);

    await expect(pending).resolves.toBe('changed');
    // the session it was made in is the twin's pair it went out with
    expect(seen).toEqual([true]);
  });
});

describe('session — this tab\'s own credential change marks itself in flight', () => {
  it('after its inline renewal and before its request; removed once its answer is written', async () => {
    storage.access = expiredToken();
    http.post.mockResolvedValueOnce(renewed(freshToken(), 'refresh-renewed'));
    let release!: () => void;
    const change = vi.fn(() => {
      // the mark is live while the request is out: every other tab waits for it
      expect(storage.mark).not.toBeNull();
      return new Promise<string>((resolve) => { release = () => resolve('changed'); });
    });

    const pending = runCredentialChange(change);
    await vi.waitFor(() => expect(change).toHaveBeenCalled());
    expect(storage.markCredentialChange.mock.invocationCallOrder[0]).toBeGreaterThan(http.post.mock.invocationCallOrder[0]);
    const [until] = storage.markCredentialChange.mock.calls[0] as [number];
    expect(until - Date.now()).toBeGreaterThan(CREDENTIAL_CHANGE_MARK_MS - 1_000);
    expect(until - Date.now()).toBeLessThanOrEqual(CREDENTIAL_CHANGE_MARK_MS);

    release();
    await expect(pending).resolves.toBe('changed');
    expect(storage.unmark).toHaveBeenCalledTimes(1);
    // after the answer's write landed: the other tabs re-read the storage once the mark is gone
    expect(storage.flushTokenStorage.mock.invocationCallOrder.at(-1)).toBeLessThan(storage.unmark.mock.invocationCallOrder[0]);
    expect(storage.mark).toBeNull();
  });

  it('removed when the change fails, and when the session ends while it is out', async () => {
    storage.access = freshToken();
    await expect(runCredentialChange(async () => { throw new Error('400'); })).rejects.toThrow('400');
    expect(storage.unmark).toHaveBeenCalledTimes(1);
    expect(storage.mark).toBeNull();

    const pending = runCredentialChange(() => new Promise<string>(() => {}));
    await vi.waitFor(() => expect(storage.markCredentialChange).toHaveBeenCalledTimes(2));
    endSessionRenewals();
    expect(storage.unmark).toHaveBeenCalledTimes(2);
    expect(storage.mark).toBeNull();
    void pending;
  });

  it('the change of an ended session, settling later, leaves the next session\'s mark in place: a sign-out still removes that one', async () => {
    storage.access = freshToken();
    let releaseOld!: (value: string) => void;
    const old = runCredentialChange(() => new Promise<string>((resolve) => { releaseOld = resolve; }));
    await vi.waitFor(() => expect(storage.markCredentialChange).toHaveBeenCalledTimes(1));
    endSessionRenewals();
    expect(storage.mark).toBeNull();

    // the next session's change is out: its mark is the one written now
    const next = runCredentialChange(() => new Promise<string>(() => {}));
    await vi.waitFor(() => expect(storage.markCredentialChange).toHaveBeenCalledTimes(2));
    const nextMark = storage.mark;
    expect(nextMark).not.toBeNull();
    releaseOld('changed');
    await expect(old).resolves.toBe('changed');
    expect(storage.mark).toBe(nextMark);

    endSessionRenewals();
    expect(storage.mark).toBeNull();
    void next;
  });
});

describe('session — one trip to the sign-in page per page load, the reason kept', () => {
  it('waits for the persisted clear, then goes once, whoever else asks', async () => {
    let release!: () => void;
    storage.flushTokenStorage.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));

    goToLoginPage('session-ended');
    goToLoginPage(null);
    goToLoginPage('banned');
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    // the first reason given stands
    expect(navigate).toHaveBeenCalledWith('/login?reason=session-ended');
    goToLoginPage(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('a force:logout followed by a late refusal: ONE navigation, with the reason', async () => {
    goToLoginPage('signed-out-elsewhere');
    // a request in flight comes back refused after the sign-out
    http.post.mockRejectedValueOnce(axios401());
    storage.refresh = 'refresh-old';
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith('/login?reason=signed-out-elsewhere');
  });

  it('a refusal first, then the force:logout before the page has left: the reason is still shown', async () => {
    let release!: () => void;
    storage.flushTokenStorage.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    http.post.mockRejectedValueOnce(axios401());
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    goToLoginPage('session-ended');
    release();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith('/login?reason=session-ended');
  });
});

describe('session — a force:logout the tab ignored keeps its reason for a short while', () => {
  it('a trip to the sign-in page within a minute of it, with no reason of its own, says that reason', async () => {
    noteIgnoredSessionEnd('signed-out-elsewhere');
    // the session held now is refused later: no reason of its own
    http.post.mockRejectedValueOnce(axios401());
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith('/login?reason=signed-out-elsewhere');
  });

  it('the window is one minute: a trip that starts later carries no reason', async () => {
    vi.useFakeTimers();
    expect(IGNORED_SESSION_END_WINDOW_MS).toBe(60_000);
    noteIgnoredSessionEnd('session-ended');
    vi.advanceTimersByTime(60_001);
    goToLoginPage(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('... and at its very end the reason still holds', async () => {
    vi.useFakeTimers();
    noteIgnoredSessionEnd('session-ended');
    vi.advanceTimersByTime(60_000);
    goToLoginPage(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(navigate).toHaveBeenCalledWith('/login?reason=session-ended');
  });

  it('a trip with a reason of its own says its own', async () => {
    noteIgnoredSessionEnd('session-ended');
    goToLoginPage('banned');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?reason=banned'));
  });

  it('a sign-in forgets it, and an end with no reason of the list keeps none', async () => {
    noteIgnoredSessionEnd('signed-out-elsewhere');
    forgetIgnoredSessionEnd();
    noteIgnoredSessionEnd(null);
    goToLoginPage(null);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
  });
});

describe('session — a renewal never answers another account\'s session', () => {
  /** An access token of `userId`, fresh, and a refresh token of the same account. */
  const accessOf = (userId: string) => jwtWith({ userId, exp: Math.floor(Date.now() / 1000) + 15 * 60 });
  const refreshOf = (userId: string, gen = 1) => jwtWith({ userId, sid: `s-${userId}`, gen });

  beforeEach(() => {
    storage.access = expiredToken();
    storage.refresh = refreshOf('user-x');
  });

  it('a pair of another account stored while the request was out: not handed over, nothing cleared, the page reloads onto it', async () => {
    http.post.mockImplementationOnce(async () => {
      storage.access = accessOf('user-y');
      storage.refresh = refreshOf('user-y');
      return renewed(accessOf('user-x'), refreshOf('user-x', 2));
    });

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a refusal while another account\'s pair is stored: no adoption, no refresh with its token, no sign-out of it', async () => {
    http.post.mockImplementationOnce(async () => {
      storage.access = expiredToken();
      storage.refresh = refreshOf('user-y');
      throw axios401();
    });

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
  });

  it('another account\'s fresh pair found at the START of a renewal (another tab signed in as someone else) is not answered: nothing sent, the page reloads onto it', async () => {
    storage.shared = true;
    _setRefreshLocksForTests(null);
    // this tab's memory missed the other tab's sign-in: the re-read finds it
    storage.page = { access: accessOf('user-y'), refresh: refreshOf('user-y') };

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(http.post).not.toHaveBeenCalled();
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('the same account\'s newer pair is adopted as before', async () => {
    const fresh = accessOf('user-x');
    http.post.mockImplementationOnce(async () => {
      storage.access = fresh;
      storage.refresh = refreshOf('user-x', 5);
      throw axios401();
    });

    await expect(refreshAccessToken()).resolves.toBe(fresh);
    expect(storage.reloadAfterSessionChange).not.toHaveBeenCalled();
  });
});

describe('session — background renewals after a refresh that got no usable answer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('three of them, 10 s, 30 s and 75 s after the lost answer, inside the grace window', () => {
    expect(BACKGROUND_RENEWAL_DELAYS_MS).toEqual([10_000, 30_000, 75_000]);
    expect(Math.max(...BACKGROUND_RENEWAL_DELAYS_MS)).toBeLessThan(120_000);
  });

  it('a mark another tab of the account writes meanwhile holds none of them: each goes out on time', async () => {
    storage.access = expiredToken();
    http.post
      .mockRejectedValueOnce(timeoutError()) // the caller's request
      .mockRejectedValueOnce(timeoutError()) // its prompt retry
      .mockRejectedValueOnce(timeoutError()) // background, 10 s
      .mockResolvedValueOnce(renewed('access-new', 'refresh-new')); // background, 30 s
    const settled = refreshAccessToken().catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    expect(await settled).toBe('failed');
    // another tab starts a password change (and may be closed before it settles)
    storage.mark = Date.now() + CREDENTIAL_CHANGE_MARK_MS;

    await vi.advanceTimersByTimeAsync(10_000 - REFRESH_RETRY_DELAY_MS);
    expect(http.post).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(http.post).toHaveBeenCalledTimes(4);
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
    expect(storage.waitForCredentialChange).not.toHaveBeenCalled();
  });

  it('... and so does a renewal asked for meanwhile that sends that same token', async () => {
    storage.access = expiredToken();
    http.post
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const settled = refreshAccessToken().catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    expect(await settled).toBe('failed');
    storage.mark = Date.now() + CREDENTIAL_CHANGE_MARK_MS;

    const renewal = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.post).toHaveBeenCalledTimes(3);
    await expect(renewal).resolves.toBe('access-new');
  });

  it('a renewal that would send another token than the unanswered one still waits for the mark', async () => {
    storage.access = expiredToken();
    http.post.mockRejectedValueOnce(timeoutError()).mockRejectedValueOnce(timeoutError());
    const settled = refreshAccessToken().catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    expect(await settled).toBe('failed');
    // another tab stored a newer pair (its access token expired too), then started a change
    storage.refresh = 'refresh-newer';
    storage.mark = Date.now() + CREDENTIAL_CHANGE_MARK_MS;
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));

    const renewal = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(http.post).toHaveBeenCalledTimes(2);
    storage.clearMark();
    await expect(renewal).resolves.toBe('access-new');
    expect(http.post.mock.calls[2][1]).toEqual({ refreshToken: 'refresh-newer', client: 'web' });
  });

  it('the prompt retry is not held by a mark that appears during its wait', async () => {
    storage.access = expiredToken();
    http.post.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const renewal = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(1_000);
    storage.mark = Date.now() + CREDENTIAL_CHANGE_MARK_MS;
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS - 1_000);

    expect(http.post).toHaveBeenCalledTimes(2);
    await expect(renewal).resolves.toBe('access-new');
  });

  it('go out on their own after the caller got its failure, one request each, until the first real answer', async () => {
    http.post
      .mockRejectedValueOnce(timeoutError()) // the caller's request
      .mockRejectedValueOnce(networkError()) // its prompt retry, 3 s later
      .mockRejectedValueOnce(axiosStatus(503)) // background, 10 s
      .mockResolvedValueOnce(renewed('access-new', 'refresh-new')); // background, 30 s
    const settled = expect(refreshAccessToken()).rejects.toMatchObject({ message: 'Network Error' });
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;
    expect(http.post).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000 - REFRESH_RETRY_DELAY_MS - 1);
    expect(http.post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(http.post).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(http.post).toHaveBeenCalledTimes(4);
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
    // every one with the token that went unanswered
    expect(new Set(http.post.mock.calls.map((c) => (c[1] as { refreshToken: string }).refreshToken))).toEqual(new Set(['refresh-old']));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(http.post).toHaveBeenCalledTimes(4);
  });

  it('a refusal or a 429 is an answer: the chain stops there', async () => {
    for (const answer of [axios401(), axiosStatus(429)]) {
      _resetSessionForTests();
      setSessionLostNavigation(navigate);
      storage.access = 'access-old';
      storage.refresh = 'refresh-old';
      http.post.mockReset();
      http.post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError()).mockRejectedValueOnce(answer);
      const settled = expect(refreshAccessToken()).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
      await settled;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(http.post).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(80_000);
      expect(http.post).toHaveBeenCalledTimes(3);
    }
    http.post.mockReset();
  });

  it('none once the stored token changed (renewed elsewhere) or the session ended; a prompt retry that succeeds stops it', async () => {
    http.post.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    const first = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await expect(first).resolves.toBe('access-new');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(http.post).toHaveBeenCalledTimes(2);

    http.post.mockReset();
    storage.access = 'access-old';
    storage.refresh = 'refresh-old';
    http.post.mockRejectedValue(networkError());
    const second = expect(refreshAccessToken()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await second;
    endSessionRenewals();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(http.post).toHaveBeenCalledTimes(2);

    http.post.mockReset();
    http.post.mockRejectedValue(networkError());
    const third = expect(refreshAccessToken()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await third;
    storage.refresh = 'refresh-from-other-tab';
    await vi.advanceTimersByTimeAsync(80_000);
    expect(http.post).toHaveBeenCalledTimes(2);
    http.post.mockReset();
  });

  it('skips one while the page is offline or another renewal is out, and goes on with the next', async () => {
    const nav = { onLine: true };
    vi.stubGlobal('navigator', nav);
    http.post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    const settled = expect(refreshAccessToken()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;

    nav.onLine = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.post).toHaveBeenCalledTimes(2);

    nav.onLine = true;
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(http.post).toHaveBeenCalledTimes(3);
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
  });

  it('skips the one due while another renewal is out (that renewal\'s answer is its own, not the chain\'s), and goes on with the next', async () => {
    http.post.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    const settled = expect(refreshAccessToken()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await settled;
    expect(http.post).toHaveBeenCalledTimes(2);

    // a caller's renewal is out when the 10 s one falls due
    let answer!: (err: unknown) => void;
    http.post.mockImplementationOnce(() => new Promise((_resolve, reject) => { answer = reject; }));
    await vi.advanceTimersByTimeAsync(10_000 - REFRESH_RETRY_DELAY_MS - 100);
    const caller = refreshAccessToken().then(() => 'renewed', () => 'failed');
    expect(http.post).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(http.post).toHaveBeenCalledTimes(3);

    // the caller's renewal is answered with a 429: the chain is not ended by it
    answer(axiosStatus(429));
    await expect(caller).resolves.toBe('failed');
    http.post.mockResolvedValueOnce(renewed('access-new', 'refresh-new'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(http.post).toHaveBeenCalledTimes(4);
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
  });
});

describe('session — the background chain after its last attempt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('is done once its last timer fired: a refresh unanswered later starts a chain of its own', async () => {
    http.post.mockRejectedValue(networkError());
    const first = expect(refreshAccessToken()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await first;
    await vi.advanceTimersByTimeAsync(80_000);
    // the caller's request, its prompt retry and the three background ones
    expect(http.post).toHaveBeenCalledTimes(5);

    // much later, the same token goes unanswered again
    await vi.advanceTimersByTimeAsync(600_000);
    const later = expect(refreshAccessToken()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAY_MS);
    await later;
    expect(http.post).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(10_000 - REFRESH_RETRY_DELAY_MS);
    expect(http.post).toHaveBeenCalledTimes(8);
    http.post.mockReset();
  });
});
