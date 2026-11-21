import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

// The real api instance and the real session module; only the socket is faked
const socket = vi.hoisted(() => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), followStoredSession: vi.fn() }));
vi.mock('../../services/socket', () => socket);

import { api } from '../../services/api';
import { useAuthStore, RESTORE_TIMEOUT_MS, SIGN_IN_TIMEOUT_MS } from '../../stores/authStore';
import {
  refreshAccessToken, SessionLostError, isTabSignedIn, setTabSignedInAs, tabAccountId, TRANSPORT_RETRY_DELAYS_MS,
  _resetSessionForTests, _setSessionRandomForTests,
} from '../../services/session';
import { setTokens, getAccessToken, getRefreshToken, getTrustedDeviceToken, setTrustedDeviceToken } from '../../services/tokenStorage';

// Every tab of the dashboard shares one stored pair: "another tab" writes it
// directly and the browser tells this tab with a `storage` event.
const ACCESS_KEY = 'voxium_admin_access_token';
const REFRESH_KEY = 'voxium_admin_refresh_token';

function otherTabStores(access: string, refresh: string) {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
function storageEvent(key: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
}

function failure(status: number, config?: InternalAxiosRequestConfig, error = 'x'): AxiosError {
  const cfg = config ?? ({} as InternalAxiosRequestConfig);
  return new AxiosError(String(status), 'ERR_BAD_REQUEST', config, null, {
    status, statusText: '', headers: {}, config: cfg, data: { success: false, error },
  });
}
const ok = (config: InternalAxiosRequestConfig, data: unknown) =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config });

/** A token shaped like ours, carrying `sid` (unsigned: only the client's own comparison reads it). */
function token(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}

let seen: Array<{ url: string; bearer: string | undefined }>;
let respond: (config: InternalAxiosRequestConfig) => unknown;
let post: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let hrefSet: string[];
const realLocation = window.location;

const adapter: AxiosAdapter = async (config) => {
  seen.push({ url: config.url ?? '', bearer: config.headers.Authorization as string | undefined });
  return respond(config) as never;
};

const admin = { id: 'u', role: 'admin' };
const callsTo = (path: string) => (post.mock.calls as unknown[][]).filter((c) => String(c[0]).endsWith(path));
const signInAnswer = (access: string, refresh: string, extra: Record<string, unknown> = {}) =>
  (config: InternalAxiosRequestConfig) => ok(config, { data: { user: admin, accessToken: access, refreshToken: refresh, ...extra } });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  _resetSessionForTests();
  seen = [];
  hrefSet = [];
  api.defaults.adapter = adapter;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { set href(v: string) { hrefSet.push(v); }, get href() { return 'http://x/'; } },
  });
  post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 204 });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  useAuthStore.setState({
    user: null, isAuthenticated: false, isLoading: true, isRestoring: false, restoreUnavailable: false,
    error: null, totpRequired: false, totpToken: null, isSubmitting: false,
  });
});
afterEach(() => {
  _resetSessionForTests();
  post.mockRestore();
  warn.mockRestore();
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

// Two accounts, one session each (unsigned: only the client's own comparisons read the claims)
const A_U1 = token({ userId: 'u-1', sid: 's1', n: 1 });
const R_U1 = token({ userId: 'u-1', sid: 's1', gen: 0 });
const A_U2 = token({ userId: 'u-2', sid: 's2', n: 1 });
const R_U2 = token({ userId: 'u-2', sid: 's2', gen: 0 });
const userOfBearer = (config: InternalAxiosRequestConfig) => {
  const header = config.headers.Authorization as string | undefined;
  if (header === `Bearer ${A_U1}`) return { id: 'u-1', role: 'admin' };
  if (header === `Bearer ${A_U2}`) return { id: 'u-2', role: 'superadmin' };
  return null;
};
/** Another tab writes the pair and the browser tells this tab, key by key. */
function otherTabSignsIn(access: string, refresh: string) {
  otherTabStores(access, refresh);
  storageEvent(ACCESS_KEY);
  storageEvent(REFRESH_KEY);
}

const transport: Array<[string, () => unknown]> = [
  ['a network error', () => new AxiosError('Network Error', 'ERR_NETWORK')],
  ['a timeout', () => new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED')],
  ['a 429', () => failure(429)],
  ['a 500', () => failure(500)],
  ['a 503', () => failure(503)],
];

describe('checkAuth', () => {
  it.each(transport)('%s on /auth/me keeps both tokens, logs no token and sets restoreUnavailable', async (_n, make) => {
    setTokens('A-secret', 'R-secret', true);
    respond = () => { throw make(); };
    await useAuthStore.getState().checkAuth();
    expect(getAccessToken()).toBe('A-secret');
    expect(getRefreshToken()).toBe('R-secret');
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false, isRestoring: false, restoreUnavailable: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret/);
    expect(hrefSet).toEqual([]);
  });

  it.each(transport)('%s on the renewal /auth/me triggers keeps both tokens', async (_n, make) => {
    setTokens('A-secret', 'R-secret', true);
    respond = (config) => { throw failure(401, config); };
    post.mockRejectedValueOnce(make());
    await useAuthStore.getState().checkAuth();
    expect(getAccessToken()).toBe('A-secret');
    expect(getRefreshToken()).toBe('R-secret');
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false, restoreUnavailable: true });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret/);
    expect(hrefSet).toEqual([]);
  });

  it.each([401, 403])('a %i from /auth/me itself clears the tokens', async (status) => {
    setTokens('A', 'R', true);
    respond = (config) => { throw failure(status, config); };
    // the 401 gets its one renewal; the retry is refused again
    post.mockResolvedValue({ data: { data: { accessToken: 'A2', refreshToken: 'R2' } } });
    await useAuthStore.getState().checkAuth();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false, restoreUnavailable: false });
  });

  it('a refusal of /auth/me for a session another tab replaced meanwhile clears nothing; the stored one is checked instead', async () => {
    setTokens('A-S', 'R-S', true);
    respond = (config) => {
      if (config.headers.Authorization === 'Bearer A-S') {
        otherTabStores('A-M', 'R-M');
        throw failure(403, config);
      }
      return ok(config, { data: admin });
    };
    await useAuthStore.getState().checkAuth();
    expect(seen.map((s) => s.bearer)).toEqual(['Bearer A-S', 'Bearer A-M']);
    expect(getAccessToken()).toBe('A-M');
    expect(getRefreshToken()).toBe('R-M');
    expect(socket.connectSocket).toHaveBeenCalledWith('A-M');
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false });
  });

  it('a refused renewal (SessionLostError) is a refusal: no "server not reached" state, no keep-the-session warning, signed out', async () => {
    // As after an earlier attempt the server did not answer ("Try again")
    useAuthStore.setState({ restoreUnavailable: true });
    setTokens('A', 'R', true);
    respond = (config) => { throw failure(401, config); };
    post.mockRejectedValue(failure(401));
    await useAuthStore.getState().checkAuth();
    expect(getRefreshToken()).toBeNull();
    // Not signed in: nothing navigates, the router shows the sign-in page
    expect(hrefSet).toEqual([]);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false, restoreUnavailable: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a user who is not an admin: the session is ended on the server too, then cleared here', async () => {
    setTokens('A', 'R-user', true);
    respond = (config) => ok(config, { data: { id: 'u', role: 'user' } });
    await useAuthStore.getState().checkAuth();
    expect(getAccessToken()).toBeNull();
    expect(callsTo('/auth/logout')).toHaveLength(1);
    expect(callsTo('/auth/logout')[0][1]).toEqual({ refreshToken: 'R-user' });
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false });
  });

  it('a user who is not an admin, for a session another tab replaced meanwhile: nothing is ended or cleared', async () => {
    setTokens('A-S', 'R-S', true);
    respond = (config) => {
      if (config.headers.Authorization === 'Bearer A-S') {
        otherTabStores('A-M', 'R-M');
        return ok(config, { data: { id: 'u', role: 'user' } });
      }
      return ok(config, { data: admin });
    };
    await useAuthStore.getState().checkAuth();
    expect(getRefreshToken()).toBe('R-M');
    expect(callsTo('/auth/logout')).toHaveLength(0);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('connects the socket with the token stored AFTER /auth/me (renewed meanwhile)', async () => {
    setTokens('A1', 'R1', true);
    let calls = 0;
    respond = (config) => {
      calls++;
      if (calls === 1) throw failure(401, config);
      return ok(config, { data: admin });
    };
    post.mockResolvedValue({ data: { data: { accessToken: 'A2', refreshToken: 'R2' } } });
    await useAuthStore.getState().checkAuth();
    expect(socket.connectSocket).toHaveBeenCalledWith('A2');
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, restoreUnavailable: false });
  });

  it.each([
    ['an HTML page', '<html></html>'],
    ['data: null', { data: null }],
    ['a user without a role', { data: { id: 'u' } }],
  ])('a 2xx answer that is not a user (%s) keeps the tokens, ends loading and is logged by message', async (_n, body) => {
    setTokens('A-secret', 'R-secret', true);
    respond = (config) => ok(config, body);
    await expect(useAuthStore.getState().checkAuth()).resolves.toBeUndefined();
    expect(getRefreshToken()).toBe('R-secret');
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false, isRestoring: false, restoreUnavailable: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('not a user');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret/);
    expect(callsTo('/auth/logout')).toHaveLength(0);
  });

  it('a non-axios error on /auth/me keeps the tokens and ends loading', async () => {
    setTokens('A', 'R', true);
    respond = () => { throw new TypeError('Failed to parse'); };
    await expect(useAuthStore.getState().checkAuth()).resolves.toBeUndefined();
    expect(getRefreshToken()).toBe('R');
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, restoreUnavailable: true });
    expect(JSON.stringify(warn.mock.calls)).toContain('Failed to parse');
  });

  it('an unexpected throw later on the restore path never leaves the loading screen up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setTokens('A-secret', 'R', true);
    respond = (config) => ok(config, { data: admin });
    socket.connectSocket.mockImplementationOnce(() => { throw new Error('socket construction failed'); });
    await expect(useAuthStore.getState().checkAuth()).resolves.toBeUndefined();
    // The sign-in page says the session could not be restored and offers to try again
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, isRestoring: false, restoreUnavailable: true, isAuthenticated: false });
    expect(isTabSignedIn()).toBe(false);
    expect(getRefreshToken()).toBe('R');
    expect(JSON.stringify(error.mock.calls)).toContain('socket construction failed');
    expect(JSON.stringify(error.mock.calls)).not.toContain('A-secret');
    error.mockRestore();
  });

  it('is single-flight: concurrent calls share one /auth/me', async () => {
    setTokens('A', 'R', true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (config) => { await gate; return ok(config, { data: admin }); };
    const a = useAuthStore.getState().checkAuth();
    const b = useAuthStore.getState().checkAuth();
    expect(a).toBe(b);
    expect(useAuthStore.getState().isRestoring).toBe(true);
    release();
    await a;
    expect(seen.filter((s) => s.url === '/auth/me')).toHaveLength(1);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isRestoring: false });
  });

  it('"Try again" after a failed restore: the flag goes once the server answers, without the loading screen', async () => {
    setTokens('A', 'R', true);
    respond = () => { throw new AxiosError('Network Error', 'ERR_NETWORK'); };
    await useAuthStore.getState().checkAuth();
    expect(useAuthStore.getState().restoreUnavailable).toBe(true);

    respond = (config) => ok(config, { data: admin });
    const retry = useAuthStore.getState().checkAuth();
    expect(useAuthStore.getState()).toMatchObject({ isRestoring: true, isLoading: false });
    await retry;
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, restoreUnavailable: false, isRestoring: false });
  });

  it('a restore overtaken by a sign-in applies nothing', async () => {
    setTokens('A-S', 'R-S', true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (config) => {
      if (config.url === '/auth/login') return signInAnswer('A-M', 'R-M')(config);
      await gate;
      return ok(config, { data: { id: 'someone-else', role: 'admin' } });
    };
    const restoring = useAuthStore.getState().checkAuth();
    await useAuthStore.getState().login('e@x.test', 'pw');
    release();
    await restoring;
    expect(useAuthStore.getState().user).toEqual(admin);
    expect(socket.connectSocket).toHaveBeenCalledTimes(1);
  });
});

describe('checkAuth: the tab signed in, and only for the session the answer was for', () => {
  it('a successful restore signs the tab in as that account', async () => {
    setTokens(A_U1, R_U1, true);
    respond = (config) => ok(config, { data: userOfBearer(config) });
    await useAuthStore.getState().checkAuth();
    expect(isTabSignedIn()).toBe(true);
    expect(tabAccountId()).toBe('u-1');
    expect(useAuthStore.getState().user).toMatchObject({ id: 'u-1' });
  });

  it('another account stored during /auth/me: nothing applied from that answer, the stored session restored instead', async () => {
    setTokens(A_U1, R_U1, true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (config) => {
      if (config.headers.Authorization === `Bearer ${A_U1}`) await gate;
      return ok(config, { data: userOfBearer(config) });
    };
    const restoring = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    otherTabSignsIn(A_U2, R_U2);
    release();
    await restoring;
    expect(seen.map((s) => s.bearer)).toEqual([`Bearer ${A_U1}`, `Bearer ${A_U2}`]);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, user: { id: 'u-2' }, restoreUnavailable: false });
    expect(socket.connectSocket.mock.calls).toEqual([[A_U2]]);
    expect(tabAccountId()).toBe('u-2');
    expect(callsTo('/auth/logout')).toHaveLength(0);
  });

  it('an answer naming another account than the stored token: never applied; after one more check, "could not be restored"', async () => {
    setTokens(A_U2, R_U2, true);
    // A server answering u-1 whatever the bearer
    respond = (config) => ok(config, { data: { id: 'u-1', role: 'admin' } });
    await useAuthStore.getState().checkAuth();
    expect(seen).toHaveLength(2);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null, restoreUnavailable: true, isLoading: false });
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(isTabSignedIn()).toBe(false);
    expect(getRefreshToken()).toBe(R_U2);
  });

  it("the restore's renewal finds another account's pair stored: nothing cleared, and that session is restored instead", async () => {
    setTokens(A_U1, R_U1, true);
    respond = (config) => {
      const user = userOfBearer(config);
      if (user?.id === 'u-1') throw failure(401, config);
      return ok(config, { data: user });
    };
    post.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/auth/refresh')) {
        // Another tab signs in as u-2 while this renewal is out; this one is refused
        otherTabStores(A_U2, R_U2);
        throw failure(401);
      }
      return { status: 204 };
    });
    await useAuthStore.getState().checkAuth();
    expect(seen.map((s) => s.bearer)).toEqual([`Bearer ${A_U1}`, `Bearer ${A_U2}`]);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, user: { id: 'u-2' } });
    expect(getRefreshToken()).toBe(R_U2);
    expect(hrefSet).toEqual([]);
  });

  it('the storage emptied during /auth/me: signed out, no socket, nothing navigates', async () => {
    setTokens(A_U1, R_U1, true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (config) => { await gate; return ok(config, { data: userOfBearer(config) }); };
    const restoring = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    localStorage.clear();
    storageEvent(null);
    release();
    await restoring;
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, restoreUnavailable: false, isLoading: false });
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(isTabSignedIn()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(hrefSet).toEqual([]);
  });

  it('the stored session changing during both checks: two checks, then "could not be restored" with the tokens kept', async () => {
    setTokens('A-0', 'R-0', true);
    let n = 0;
    respond = (config) => {
      n++;
      otherTabStores(`A-${n}`, `R-${n}`);
      return ok(config, { data: admin });
    };
    await useAuthStore.getState().checkAuth();
    expect(seen.map((s) => s.bearer)).toEqual(['Bearer A-0', 'Bearer A-1']);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, restoreUnavailable: true });
    expect(getRefreshToken()).toBe('R-2');
    expect(socket.connectSocket).not.toHaveBeenCalled();
  });

  it('a restore overtaken by a sign-in while /auth/me fails on the network applies nothing from its failure', async () => {
    setTokens('A-S', 'R-S', true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (config) => {
      if (config.url === '/auth/login') return signInAnswer('A-M', 'R-M')(config);
      await gate;
      throw new AxiosError('Network Error', 'ERR_NETWORK');
    };
    const restoring = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await useAuthStore.getState().login('e@x.test', 'pw');
    release();
    await restoring;
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, restoreUnavailable: false });
    expect(getRefreshToken()).toBe('R-M');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a restore overtaken by a sign-in while /auth/me is refused clears nothing of the new session', async () => {
    setTokens('A-S', 'R-S', true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (config) => {
      if (config.url === '/auth/login') return signInAnswer('A-M', 'R-M')(config);
      await gate;
      throw failure(403, config);
    };
    const restoring = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await useAuthStore.getState().login('e@x.test', 'pw');
    release();
    await restoring;
    expect(getRefreshToken()).toBe('R-M');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

describe('checkAuth always ends', () => {
  it('a /auth/me that never answers: "could not be restored" after the bound, the tokens kept, "Try again" sends again', async () => {
    vi.useFakeTimers();
    setTokens('A', 'R', true);
    respond = () => new Promise(() => undefined);
    const first = useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS - 1);
    expect(useAuthStore.getState()).toMatchObject({ isLoading: true, isRestoring: true });
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, isRestoring: false, restoreUnavailable: true, isAuthenticated: false });
    expect(getAccessToken()).toBe('A');
    expect(getRefreshToken()).toBe('R');

    const again = useAuthStore.getState().checkAuth();
    expect(again).not.toBe(first);
    expect(useAuthStore.getState().isRestoring).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.filter((s) => s.url === '/auth/me')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS);
    await again;
    expect(useAuthStore.getState()).toMatchObject({ isRestoring: false, restoreUnavailable: true });
  });

  it('an attempt given up on applies nothing when its answer comes later, and does not end the next attempt', async () => {
    vi.useFakeTimers();
    setTokens('A', 'R', true);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });
    let calls = 0;
    respond = async (config) => {
      calls++;
      if (calls === 1) { await firstGate; return ok(config, { data: admin }); }
      await secondGate;
      throw new AxiosError('Network Error', 'ERR_NETWORK');
    };
    const first = useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS);
    await first;
    // The bound itself is reported once
    expect(warn).toHaveBeenCalledTimes(1);
    const second = useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(0);
    // The first attempt's answer arrives while the second is out
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isRestoring: true });
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    releaseSecond();
    await second;
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isRestoring: false, restoreUnavailable: true });
  });

  it('the sign-in and the two-factor requests are bounded', async () => {
    const timeouts: Array<number | undefined> = [];
    respond = (config) => {
      timeouts.push(config.timeout);
      if (config.url === '/auth/login') return ok(config, { data: { totpRequired: true, totpToken: 'T' } });
      return signInAnswer('A', 'R')(config);
    };
    await useAuthStore.getState().login('e@x.test', 'pw');
    await useAuthStore.getState().verifyTOTP('123456');
    expect(timeouts).toEqual([SIGN_IN_TIMEOUT_MS, SIGN_IN_TIMEOUT_MS]);
  });
});

describe('a background renewal while the sign-in page says the session could not be restored', () => {
  const [FIRST] = TRANSPORT_RETRY_DELAYS_MS;

  /** A restore whose renewal got no answer: the sign-in page, tokens kept, a background renewal armed. */
  async function restoreWithoutAnswer() {
    vi.useFakeTimers();
    _setSessionRandomForTests(() => 0.5);
    setTokens('A1', 'R1', true);
    respond = (config) => {
      if (config.headers.Authorization === 'Bearer A2') return ok(config, { data: admin });
      throw failure(401, config);
    };
    post.mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));
    await useAuthStore.getState().checkAuth();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, restoreUnavailable: true, isLoading: false });
  }

  it('renewed: the restore runs again by itself and the tab is signed in', async () => {
    await restoreWithoutAnswer();
    post.mockResolvedValueOnce({ data: { data: { accessToken: 'A2', refreshToken: 'R2' } } });
    await vi.advanceTimersByTimeAsync(FIRST);
    await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(useAuthStore.getState()).toMatchObject({ restoreUnavailable: false, isRestoring: false });
    expect(getRefreshToken()).toBe('R2');
    expect(socket.connectSocket).toHaveBeenCalledWith('A2');
    expect(tabAccountId()).toBe('u');
  });

  it('refused: the pair it sent is cleared, nothing navigates, and the page no longer says the session is kept', async () => {
    await restoreWithoutAnswer();
    post.mockRejectedValueOnce(failure(401));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(getRefreshToken()).toBeNull();
    expect(hrefSet).toEqual([]);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, restoreUnavailable: false });
  });

  it('refused while the person is signing in: nothing navigates and the sign-in completes', async () => {
    await restoreWithoutAnswer();
    let releaseLogin!: () => void;
    const gate = new Promise<void>((r) => { releaseLogin = r; });
    respond = async (config) => {
      if (config.url === '/auth/login') { await gate; return signInAnswer('A-M', 'R-M')(config); }
      throw failure(401, config);
    };
    post.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/auth/refresh')) throw failure(401);
      return { status: 204 };
    });
    const signingIn = useAuthStore.getState().login('e@x.test', 'pw');
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(hrefSet).toEqual([]);
    expect(getRefreshToken()).toBeNull();
    releaseLogin();
    await signingIn;
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, restoreUnavailable: false });
    expect(getRefreshToken()).toBe('R-M');
    expect(hrefSet).toEqual([]);
  });

  it('renewed while the two-factor step is shown: no restore runs under it', async () => {
    await restoreWithoutAnswer();
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    post.mockResolvedValueOnce({ data: { data: { accessToken: 'A2', refreshToken: 'R2' } } });
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(getRefreshToken()).toBe('R2');
    expect(seen.filter((s) => s.url === '/auth/me')).toHaveLength(1);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, totpRequired: true });
  });

  it('renewed while the person is signing in: no restore runs under the sign-in', async () => {
    await restoreWithoutAnswer();
    let releaseLogin!: () => void;
    const gate = new Promise<void>((r) => { releaseLogin = r; });
    respond = async (config) => {
      if (config.url === '/auth/login') { await gate; return signInAnswer('A-M', 'R-M')(config); }
      return ok(config, { data: admin });
    };
    const signingIn = useAuthStore.getState().login('e@x.test', 'pw');
    post.mockResolvedValueOnce({ data: { data: { accessToken: 'A2', refreshToken: 'R2' } } });
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(seen.filter((s) => s.url === '/auth/me')).toHaveLength(1);
    releaseLogin();
    await signingIn;
    expect(getRefreshToken()).toBe('R-M');
  });
});

describe('sign-in over a stored session', () => {
  it('a wrong password changes nothing: no bearer, no renewal, no logout, the stored pair and the trusted device kept', async () => {
    setTokens('A-stale', 'R-stale', true);
    setTrustedDeviceToken('TD');
    respond = (config) => { throw failure(401, config, 'Invalid credentials'); };
    await expect(useAuthStore.getState().login('e@x.test', 'bad')).rejects.toBeDefined();

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/auth/login');
    expect(seen[0].bearer).toBeUndefined();
    expect(callsTo('/auth/refresh')).toHaveLength(0);
    expect(callsTo('/auth/logout')).toHaveLength(0);
    expect(useAuthStore.getState().error).toBe('Invalid credentials');
    expect(getAccessToken()).toBe('A-stale');
    expect(getRefreshToken()).toBe('R-stale');
    expect(getTrustedDeviceToken()).toBe('TD');
    expect(hrefSet).toEqual([]);
    expect(socket.disconnectSocket).not.toHaveBeenCalled();
  });

  it('a sign-in that fails on the network keeps the stored session and sends nothing for it', async () => {
    setTokens('A-S', 'R-S', true);
    respond = () => { throw new AxiosError('Network Error', 'ERR_NETWORK'); };
    await expect(useAuthStore.getState().login('e@x.test', 'pw')).rejects.toBeDefined();
    expect(getRefreshToken()).toBe('R-S');
    expect(post).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ error: 'Login failed', isSubmitting: false });
  });

  it('a successful sign-in stores the new pair, opens its socket, and only then ends the stale session on the server', async () => {
    setTokens('A-stale', 'R-stale', true);
    setTrustedDeviceToken('TD');
    respond = signInAnswer('A-new', 'R-new');
    let storedAtLogout: string | null = 'unread';
    post.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/auth/logout')) storedAtLogout = getRefreshToken();
      return { status: 204 };
    });
    await useAuthStore.getState().login('e@x.test', 'pw');

    expect(seen[0].bearer).toBeUndefined();
    expect(getAccessToken()).toBe('A-new');
    expect(getRefreshToken()).toBe('R-new');
    expect(getTrustedDeviceToken()).toBe('TD');
    expect(socket.connectSocket).toHaveBeenCalledWith('A-new');
    const logoutCalls = callsTo('/auth/logout');
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0][1]).toEqual({ refreshToken: 'R-stale' });
    expect(storedAtLogout).toBe('R-new');
    // The old socket closed, then the new one opened, then the server told
    const closed = socket.disconnectSocket.mock.invocationCallOrder[0];
    const opened = socket.connectSocket.mock.invocationCallOrder[0];
    const told = post.mock.invocationCallOrder[(post.mock.calls as unknown[][]).findIndex((c) => String(c[0]).endsWith('/auth/logout'))];
    expect(closed).toBeLessThan(opened);
    expect(opened).toBeLessThan(told);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, error: null });
  });

  it('a renewal of the old session in flight at sign-in stores nothing after it', async () => {
    setTokens('A-stale', 'R-stale', true);
    let answer!: (v: unknown) => void;
    post.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const oldRenewal = refreshAccessToken();
    respond = signInAnswer('A-new', 'R-new');
    await useAuthStore.getState().login('e@x.test', 'pw');
    answer({ data: { data: { accessToken: 'A-stale2', refreshToken: 'R-stale2' } } });
    await expect(oldRenewal).rejects.toBeInstanceOf(SessionLostError);
    expect(getRefreshToken()).toBe('R-new');
    expect(hrefSet).toEqual([]);
  });

  it('a pair another tab stored while the sign-in request was out is ended too, after the first stale one, once each', async () => {
    setTokens('A-stale', 'R-stale', true);
    respond = (config) => {
      if (config.url === '/auth/login') otherTabStores('A-mid', 'R-mid');
      return signInAnswer('A-new', 'R-new')(config);
    };
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(getRefreshToken()).toBe('R-new');
    expect(callsTo('/auth/logout').map((c) => c[1])).toEqual([{ refreshToken: 'R-stale' }, { refreshToken: 'R-mid' }]);
  });

  it('the two-factor step ends the pair stored meanwhile as well', async () => {
    setTokens('A-stale', 'R-stale', true);
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    respond = (config) => {
      otherTabStores('A-mid', 'R-mid');
      return signInAnswer('A-new', 'R-new')(config);
    };
    await useAuthStore.getState().verifyTOTP('123456');
    expect(callsTo('/auth/logout').map((c) => c[1])).toEqual([{ refreshToken: 'R-stale' }, { refreshToken: 'R-mid' }]);
  });

  it('a stored pair equal to the one read before, or to the new refresh token, is not ended twice or at all', async () => {
    setTokens('A-stale', 'R-stale', true);
    respond = signInAnswer('A-new', 'R-stale');
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(callsTo('/auth/logout')).toHaveLength(0);

    setTokens('A-s2', 'R-s2', true);
    respond = (config) => {
      if (config.url === '/auth/login') otherTabStores('A-mid', 'R-new2');
      return signInAnswer('A-new2', 'R-new2')(config);
    };
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(callsTo('/auth/logout').map((c) => c[1])).toEqual([{ refreshToken: 'R-s2' }]);
  });

  it('a sign-in with nothing stored never calls /auth/logout', async () => {
    respond = signInAnswer('A', 'R');
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('R');
  });

  it('a sign-in answered with the stored refresh token itself ends nothing', async () => {
    setTokens('A-old', 'R-same', true);
    respond = signInAnswer('A-new', 'R-same');
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(callsTo('/auth/logout')).toHaveLength(0);
  });

  it('an account that is not an admin: the session the server just opened is ended there, nothing is stored', async () => {
    setTokens('A-stale', 'R-stale', true);
    respond = (config) => ok(config, { data: { user: { id: 'u', role: 'user' }, accessToken: 'A-user', refreshToken: 'R-user' } });
    await expect(useAuthStore.getState().login('e@x.test', 'pw')).rejects.toBeDefined();
    const logoutCalls = callsTo('/auth/logout');
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0][1]).toEqual({ refreshToken: 'R-user' });
    expect(getRefreshToken()).toBe('R-stale');
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isSubmitting: false, error: 'Access denied. Admin privileges required.' });
  });

  it('the two-factor step sends no bearer, never renews, and a wrong code changes nothing', async () => {
    setTokens('A-stale', 'R-stale', true);
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    respond = (config) => { throw failure(401, config, 'Invalid verification code'); };
    await expect(useAuthStore.getState().verifyTOTP('123456')).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].bearer).toBeUndefined();
    expect(callsTo('/auth/refresh')).toHaveLength(0);
    expect(callsTo('/auth/logout')).toHaveLength(0);
    expect(getRefreshToken()).toBe('R-stale');
    expect(useAuthStore.getState()).toMatchObject({ error: 'Invalid verification code', totpRequired: true });
  });

  it('a successful two-factor step stores the pair and the trusted device, then ends the stale session', async () => {
    setTokens('A-stale', 'R-stale', true);
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    respond = signInAnswer('A-new', 'R-new', { trustedDeviceToken: 'TD-new' });
    await useAuthStore.getState().verifyTOTP('123456');
    expect(getRefreshToken()).toBe('R-new');
    expect(getTrustedDeviceToken()).toBe('TD-new');
    expect(socket.connectSocket).toHaveBeenCalledWith('A-new');
    expect(callsTo('/auth/logout').map((c) => c[1])).toEqual([{ refreshToken: 'R-stale' }]);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, totpRequired: false, totpToken: null });
  });

  it('a two-factor step for an account that is not an admin ends the session the server opened', async () => {
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    respond = (config) => ok(config, { data: { user: { id: 'u', role: 'user' }, accessToken: 'A-user', refreshToken: 'R-user' } });
    await expect(useAuthStore.getState().verifyTOTP('123456')).rejects.toBeDefined();
    expect(callsTo('/auth/logout').map((c) => c[1])).toEqual([{ refreshToken: 'R-user' }]);
    expect(getRefreshToken()).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: false, totpRequired: false, error: 'Access denied. Admin privileges required.',
    });
  });
});

describe('following the other tabs', () => {
  beforeEach(() => {
    setTokens('A-S', 'R-S', true);
    useAuthStore.setState({ user: admin as never, isAuthenticated: true, isLoading: false });
  });

  it('another tab removing the pair ends this tab\'s session locally, without a server call', () => {
    localStorage.removeItem(ACCESS_KEY);
    storageEvent(ACCESS_KEY);
    // The access key goes first: nothing is decided on half a pair
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    localStorage.removeItem(REFRESH_KEY);
    storageEvent(REFRESH_KEY);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null });
    expect(socket.disconnectSocket).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('the refresh token gone while another tab writes a new pair: this tab ends in memory and clears nothing', () => {
    setTabSignedInAs('u');
    const fresh = token({ userId: 'u', sid: 'M' });
    localStorage.removeItem(REFRESH_KEY);
    localStorage.setItem(ACCESS_KEY, fresh);
    storageEvent(REFRESH_KEY);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null });
    expect(socket.disconnectSocket).toHaveBeenCalled();
    expect(isTabSignedIn()).toBe(false);
    expect(getAccessToken()).toBe(fresh);
    expect(post).not.toHaveBeenCalled();
  });

  it('another tab clearing the storage (an event naming no key) ends it too', () => {
    localStorage.clear();
    storageEvent(null);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('another tab storing a pair keeps this tab signed in and moves its socket on', () => {
    otherTabStores('A-M', 'R-M');
    storageEvent(REFRESH_KEY);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(socket.followStoredSession).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe('R-M');
  });

  it('another tab storing a pair of ANOTHER account reloads this page onto it instead of following', () => {
    useAuthStore.setState({ user: { id: 'u-1', role: 'admin' } as never });
    otherTabStores(token({ userId: 'u-2', sid: 's2' }), 'R-M');
    storageEvent(ACCESS_KEY);
    expect(hrefSet).toEqual(['/']);
    expect(socket.followStoredSession).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('R-M');
  });

  it('another tab storing a pair of the SAME account (another session) still follows, no reload', () => {
    useAuthStore.setState({ user: { id: 'u-1', role: 'admin' } as never });
    otherTabStores(token({ userId: 'u-1', sid: 's2' }), 'R-M');
    storageEvent(REFRESH_KEY);
    expect(hrefSet).toEqual([]);
    expect(socket.followStoredSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an undecodable access token', 'not-a-token'],
    ['a payload that is not JSON', 'a.bm90anNvbg.b'],
    ['a token with no userId', token({ sid: 's2' })],
  ])('%s: no throw, the socket follows, no reload', (_n, access) => {
    useAuthStore.setState({ user: { id: 'u-1', role: 'admin' } as never });
    otherTabStores(access, 'R-M');
    expect(() => storageEvent(ACCESS_KEY)).not.toThrow();
    expect(hrefSet).toEqual([]);
    expect(socket.followStoredSession).toHaveBeenCalledTimes(1);
  });

  it('an event for another key, or while this tab is signed out, changes nothing', () => {
    localStorage.setItem('unrelated', 'x');
    storageEvent('unrelated');
    expect(socket.followStoredSession).not.toHaveBeenCalled();
    useAuthStore.setState({ isAuthenticated: false });
    localStorage.clear();
    storageEvent(null);
    expect(socket.disconnectSocket).not.toHaveBeenCalled();
  });
});

describe('endSessionLocally', () => {
  it('with the token of the stored session: cleared, true', () => {
    setTokens('A1', 'R1', true);
    expect(useAuthStore.getState().endSessionLocally('A1')).toBe(true);
    expect(getRefreshToken()).toBeNull();
  });

  it('with a token of the stored session that a renewal has replaced since (same sid): cleared, true', () => {
    setTokens(token({ sid: 's1', gen: 3 }), token({ sid: 's1', gen: 3, r: 1 }), true);
    expect(useAuthStore.getState().endSessionLocally(token({ sid: 's1', gen: 2 }))).toBe(true);
    expect(getRefreshToken()).toBeNull();
  });

  it('with a token of another session (another tab signed in since): the stored pair stays, false, this tab signed out', () => {
    setTokens(token({ sid: 'M', gen: 0 }), 'R-M', true);
    useAuthStore.setState({ user: admin as never, isAuthenticated: true });
    expect(useAuthStore.getState().endSessionLocally(token({ sid: 'S', gen: 5 }))).toBe(false);
    expect(getRefreshToken()).toBe('R-M');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(socket.disconnectSocket).toHaveBeenCalled();
  });

  it('without a token (this tab\'s own sign-out): cleared', () => {
    setTokens('A1', 'R1', true);
    expect(useAuthStore.getState().endSessionLocally()).toBe(true);
    expect(getAccessToken()).toBeNull();
  });
});
