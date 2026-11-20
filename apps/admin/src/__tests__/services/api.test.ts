import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../../services/api';
import {
  REFRESH_TIMEOUT_MS, AccountChangedError, SessionLostError, endSessionRenewals, isTabSignedIn, setTabSignedInAs,
  _resetSessionForTests,
} from '../../services/session';
import { setTokens, getAccessToken, getRefreshToken } from '../../services/tokenStorage';

// A fake backend behind the `api` instance: answers by the bearer a request carries
let seen: Array<{ url: string; bearer: string | null }>;
let validAccess: string;

function failure(status: number, config?: InternalAxiosRequestConfig): AxiosError {
  const cfg = config ?? ({} as InternalAxiosRequestConfig);
  return new AxiosError(String(status), 'ERR_BAD_REQUEST', config, null, {
    status, statusText: '', headers: {}, config: cfg, data: { success: false, error: 'x' },
  });
}
const ok = (config: InternalAxiosRequestConfig) => ({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config });

function bearerIn(config: InternalAxiosRequestConfig): string | null {
  const header = config.headers.Authorization as string | undefined;
  return header ? header.replace('Bearer ', '') : null;
}

const adapter: AxiosAdapter = async (config) => {
  const bearer = bearerIn(config);
  seen.push({ url: config.url ?? '', bearer });
  if (config.url === '/always401' || bearer !== validAccess) throw failure(401, config);
  return ok(config);
};

/** A token shaped like ours, carrying the given claims (unsigned: only the client's own comparison reads it). */
function token(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}
const A_U1 = token({ userId: 'u-1', sid: 's1', n: 1 });
const R_U1 = token({ userId: 'u-1', sid: 's1', gen: 0 });
const A_U2 = token({ userId: 'u-2', sid: 's2', n: 1 });
const R_U2 = token({ userId: 'u-2', sid: 's2', gen: 0 });
const name = (bearer: string | null) => (bearer === A_U1 ? 'u-1' : bearer === A_U2 ? 'u-2' : bearer);

let post: ReturnType<typeof vi.spyOn>;
let hrefSet: string[];
const realLocation = window.location;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetSessionForTests();
  // Signed in as an account the unclaimed test tokens ('A1', ...) do not contradict
  setTabSignedInAs('u');
  seen = [];
  validAccess = 'A2';
  api.defaults.adapter = adapter;
  hrefSet = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      set href(v: string) { hrefSet.push(v); },
      get href() { return 'http://x/'; },
    },
  });
  post = vi.spyOn(axios, 'post');
});

afterEach(() => {
  // A transport failure arms background renewals: never let one outlive the test
  _resetSessionForTests();
  post.mockRestore();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

function refreshAnswers(access = 'A2', refresh = 'R2') {
  post.mockResolvedValue({ data: { success: true, data: { accessToken: access, refreshToken: refresh } } });
}

/** An adapter whose first request waits for `release()` and then answers 401; later ones answer 200. */
function lateFirst401() {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let first = true;
  api.defaults.adapter = async (config) => {
    seen.push({ url: config.url ?? '', bearer: bearerIn(config) });
    if (first) {
      first = false;
      await gate;
      throw failure(401, config);
    }
    return ok(config);
  };
  return () => release();
}

describe('admin api: renewal on 401', () => {
  it('stores BOTH tokens of the refresh answer and sends client: admin', async () => {
    setTokens('A1', 'R1', true);
    refreshAnswers();
    const res = await api.get('/x');
    expect(res.data).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatch(/\/auth\/refresh$/);
    expect(post.mock.calls[0][1]).toEqual({ refreshToken: 'R1', client: 'admin' });
    expect(post.mock.calls[0][2]).toMatchObject({ timeout: REFRESH_TIMEOUT_MS });
    expect(getAccessToken()).toBe('A2');
    expect(getRefreshToken()).toBe('R2');
    expect(localStorage.getItem('voxium_admin_refresh_token')).toBe('R2');
  });

  it('three requests that 401 at once make ONE refresh call, each retried once with the new token', async () => {
    setTokens('A1', 'R1', true);
    refreshAnswers();
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results.map((r) => r.data)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(post).toHaveBeenCalledTimes(1);
    for (const url of ['/a', '/b', '/c']) {
      expect(seen.filter((s) => s.url === url).map((s) => s.bearer)).toEqual(['A1', 'A2']);
    }
  });

  it('a request refused after another renewal finished retries with the token stored meanwhile, no second refresh', async () => {
    setTokens('A1', 'R1', true);
    // The request leaves with A1; another request (or tab) stores A2 before its 401 comes back
    api.defaults.adapter = async (config) => {
      const bearer = (config.headers.Authorization as string).replace('Bearer ', '');
      seen.push({ url: config.url ?? '', bearer });
      if (bearer === 'A2') return ok(config);
      setTokens('A2', 'R2');
      throw failure(401, config);
    };
    await expect(api.get('/late')).resolves.toMatchObject({ data: { ok: true } });
    expect(seen.map((s) => s.bearer)).toEqual(['A1', 'A2']);
    expect(post).not.toHaveBeenCalled();
  });

  it('retries once and never loops when the retried request 401s again', async () => {
    setTokens('A1', 'R1', true);
    refreshAnswers();
    await expect(api.get('/always401')).rejects.toMatchObject({ response: { status: 401 } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    expect(hrefSet).toEqual([]);
    expect(getRefreshToken()).toBe('R2');
  });

  it('a 401 on a request that carried no bearer, with nothing stored, ends the session here: sign-in page, no refresh call', async () => {
    // The dashboard still on screen after another tab emptied the storage
    refreshAnswers();
    await expect(api.get('/admin/stats')).rejects.toBeInstanceOf(SessionLostError);
    // The session has ended: the next request of the page is not sent at all
    await expect(api.get('/admin/users')).rejects.toBeInstanceOf(SessionLostError);
    expect(seen.map((s) => s.bearer)).toEqual([null]);
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual(['/login']);
  });

  it('a 401 on a request that carried no bearer, with a refresh token stored, renews and retries once', async () => {
    localStorage.setItem('voxium_admin_refresh_token', 'R1');
    refreshAnswers();
    await expect(api.get('/x')).resolves.toMatchObject({ data: { ok: true } });
    expect(seen.map((s) => s.bearer)).toEqual([null, 'A2']);
    expect(post).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe('R2');
  });

  it('a 401 on a request that carried no bearer retries with a pair another tab stored meanwhile', async () => {
    api.defaults.adapter = async (config) => {
      const bearer = bearerIn(config);
      seen.push({ url: config.url ?? '', bearer });
      if (bearer === 'A-M') return ok(config);
      setTokens('A-M', 'R-M', true);
      throw failure(401, config);
    };
    await expect(api.get('/x')).resolves.toBeDefined();
    expect(seen.map((s) => s.bearer)).toEqual([null, 'A-M']);
    expect(post).not.toHaveBeenCalled();
  });

  it('a skipAuth request carries no bearer and never renews or retries on a 401', async () => {
    setTokens('A1', 'R1', true);
    refreshAnswers();
    await expect(api.post('/auth/login', {}, { skipAuth: true })).rejects.toMatchObject({ response: { status: 401 } });
    expect(seen).toEqual([{ url: '/auth/login', bearer: null }]);
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('R1');
  });

  it('a 401 answer to the refresh ends the session once, for every waiting request', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValue(failure(401));
    const results = await Promise.allSettled([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(hrefSet).toEqual(['/login']);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('a 403 answer to the refresh ends the session', async () => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValue(failure(403));
    await expect(api.get('/a')).rejects.toBeDefined();
    expect(hrefSet).toEqual(['/login']);
    expect(getRefreshToken()).toBeNull();
  });

  it('no refresh token ends the session without a refresh call', async () => {
    localStorage.setItem('voxium_admin_access_token', 'A1');
    await expect(api.get('/a')).rejects.toBeDefined();
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual(['/login']);
    expect(getAccessToken()).toBeNull();
  });

  const transport: Array<[string, () => unknown]> = [
    ['a network error', () => new AxiosError('Network Error', 'ERR_NETWORK')],
    ['a timeout', () => new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED')],
    ['a 429', () => failure(429)],
    ['a 500', () => failure(500)],
  ];
  it.each(transport)('%s on the refresh keeps the tokens and fails only that request', async (_n, make) => {
    setTokens('A1', 'R1', true);
    post.mockRejectedValueOnce(make());
    await expect(api.get('/a')).rejects.toBeDefined();
    expect(hrefSet).toEqual([]);
    expect(getAccessToken()).toBe('A1');
    expect(getRefreshToken()).toBe('R1');
    // The next request renews again
    refreshAnswers();
    await expect(api.get('/b')).resolves.toBeDefined();
    expect(getRefreshToken()).toBe('R2');
  });
});

describe('admin api: a late 401 after this tab signed out', () => {
  it('with no bearer: renews nothing, navigates nowhere and changes no storage', async () => {
    // A view that unmounted at sign-out had a request still out
    const release = lateFirst401();
    const late = api.get('/late');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    endSessionRenewals();
    localStorage.setItem('voxium_admin_refresh_token', 'R-other');
    release();
    await expect(late).rejects.toMatchObject({ response: { status: 401 } });
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual([]);
    expect(seen.map((s) => s.bearer)).toEqual([null]);
    expect(getRefreshToken()).toBe('R-other');
  });

  it('WITH a bearer and nothing stored: left to its caller, no renewal, no navigation', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const release = lateFirst401();
    const late = api.get('/admin/stats');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // The sign-out: renewals ended and the storage cleared
    endSessionRenewals();
    localStorage.clear();
    release();
    await expect(late).rejects.toMatchObject({ response: { status: 401 } });
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('WITH a bearer and another account\'s pair stored meanwhile: never replayed under it, nothing changed', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const release = lateFirst401();
    const late = api.post('/admin/users/x/ban', { reason: 'r' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    endSessionRenewals();
    localStorage.clear();
    // Another tab signs in as u-2 before the 401 of the late request returns
    setTokens(A_U2, R_U2, true);
    release();
    await expect(late).rejects.toMatchObject({ response: { status: 401 } });
    expect(seen.map((s) => name(s.bearer))).toEqual(['u-1']);
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual([]);
    expect(getAccessToken()).toBe(A_U2);
  });

  it('sent before a sign-out and a new sign-in in THIS tab as another account: never retried in the new session', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const release = lateFirst401();
    const late = api.post('/admin/users/x/ban', {});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // Signed out, then signed in as u-2 here: the tab is signed in again
    endSessionRenewals();
    setTokens(A_U2, R_U2, true);
    setTabSignedInAs('u-2');
    release();
    await expect(late).rejects.toMatchObject({ response: { status: 401 } });
    expect(seen.map((s) => name(s.bearer))).toEqual(['u-1']);
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual([]);
  });

  it('sent before a sign-out and a new sign-in as the SAME account: never retried either', async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    const release = lateFirst401();
    const late = api.post('/admin/users/x/ban', {});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    endSessionRenewals();
    setTokens(token({ userId: 'u-1', sid: 's3' }), token({ userId: 'u-1', sid: 's3', gen: 0 }), true);
    setTabSignedInAs('u-1');
    release();
    await expect(late).rejects.toMatchObject({ response: { status: 401 } });
    expect(seen).toHaveLength(1);
  });
});

describe('admin api: never as an account other than the one this tab shows', () => {
  beforeEach(() => {
    setTokens(A_U1, R_U1, true);
    _resetSessionForTests();
    setTabSignedInAs('u-1');
  });

  it('a first send while the storage holds another account\'s pair is rejected unsent, and the page reloads onto it once', async () => {
    setTokens(A_U2, R_U2, true);
    await expect(api.post('/admin/users/x/ban', {})).rejects.toBeInstanceOf(AccountChangedError);
    await expect(api.get('/admin/stats')).rejects.toBeInstanceOf(AccountChangedError);
    expect(seen).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual(['/']);
    expect(getAccessToken()).toBe(A_U2);
    expect(getRefreshToken()).toBe(R_U2);
    expect(isTabSignedIn()).toBe(true);
  });

  it('a request sent as u-1, a u-2 pair stored before its 401 returns: not retried with it, nothing cleared', async () => {
    api.defaults.adapter = async (config) => {
      seen.push({ url: config.url ?? '', bearer: bearerIn(config) });
      if (seen.length === 1) {
        // The other tab's sign-in lands while this request is out (its event not delivered yet)
        setTokens(A_U2, R_U2, true);
        throw failure(401, config);
      }
      return ok(config);
    };
    await expect(api.post('/admin/users/x/ban', {})).rejects.toBeInstanceOf(AccountChangedError);
    expect(seen.map((s) => name(s.bearer))).toEqual(['u-1']);
    expect(post).not.toHaveBeenCalled();
    expect(hrefSet).toEqual(['/']);
    expect(getRefreshToken()).toBe(R_U2);
  });

  it('the refresh of u-1 refused because another tab stored u-2: the request is not retried, nothing is cleared', async () => {
    api.defaults.adapter = async (config) => {
      seen.push({ url: config.url ?? '', bearer: bearerIn(config) });
      if (seen.length === 1) throw failure(401, config);
      return ok(config);
    };
    post.mockImplementation(async () => {
      setTokens(A_U2, R_U2, true);
      throw failure(401);
    });
    await expect(api.delete('/admin/users/x')).rejects.toBeInstanceOf(SessionLostError);
    expect(seen.map((s) => name(s.bearer))).toEqual(['u-1']);
    expect(getAccessToken()).toBe(A_U2);
    expect(getRefreshToken()).toBe(R_U2);
    expect(hrefSet).toEqual(['/']);
  });

  it('another session of the SAME account stored meanwhile is used as before', async () => {
    const otherSession = token({ userId: 'u-1', sid: 's2' });
    validAccess = otherSession;
    setTokens(otherSession, token({ userId: 'u-1', sid: 's2', gen: 0 }), true);
    await expect(api.get('/x')).resolves.toMatchObject({ data: { ok: true } });
    expect(seen.map((s) => s.bearer)).toEqual([otherSession]);
    expect(hrefSet).toEqual([]);
  });

  it('a 401 retried with the token another session of the same account stored meanwhile', async () => {
    const otherSession = token({ userId: 'u-1', sid: 's2' });
    validAccess = otherSession;
    api.defaults.adapter = async (config) => {
      const bearer = bearerIn(config);
      seen.push({ url: config.url ?? '', bearer });
      if (bearer === otherSession) return ok(config);
      setTokens(otherSession, token({ userId: 'u-1', sid: 's2', gen: 0 }), true);
      throw failure(401, config);
    };
    await expect(api.get('/x')).resolves.toBeDefined();
    expect(seen.map((s) => s.bearer)).toEqual([A_U1, otherSession]);
    expect(post).not.toHaveBeenCalled();
  });

  it('sign-in requests (skipAuth) go out as before, without a bearer, whatever is stored', async () => {
    setTokens(A_U2, R_U2, true);
    api.defaults.adapter = async (config) => {
      seen.push({ url: config.url ?? '', bearer: bearerIn(config) });
      return ok(config);
    };
    await expect(api.post('/auth/login', {}, { skipAuth: true })).resolves.toBeDefined();
    expect(seen).toEqual([{ url: '/auth/login', bearer: null }]);
    expect(hrefSet).toEqual([]);
  });

  it('a tab signed in as nobody (a restore) attaches whatever is stored', async () => {
    _resetSessionForTests();
    setTokens(A_U2, R_U2, true);
    validAccess = A_U2;
    await expect(api.get('/auth/me', { sessionRestore: true })).resolves.toBeDefined();
    expect(seen.map((s) => name(s.bearer))).toEqual(['u-2']);
  });
});

describe('admin api: the restore\'s own request', () => {
  it('renews on a 401 although the tab is not signed in yet', async () => {
    _resetSessionForTests();
    setTokens('A1', 'R1', true);
    refreshAnswers();
    await expect(api.get('/auth/me', { sessionRestore: true })).resolves.toBeDefined();
    expect(seen.map((s) => s.bearer)).toEqual(['A1', 'A2']);
    expect(getRefreshToken()).toBe('R2');
  });

  it('any other request of a tab that is not signed in is rejected unsent', async () => {
    _resetSessionForTests();
    setTokens('A1', 'R1', true);
    refreshAnswers();
    await expect(api.get('/admin/stats')).rejects.toBeInstanceOf(SessionLostError);
    expect(seen).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('R1');
    expect(hrefSet).toEqual([]);
  });
});

describe('admin api: a view still mounted after its session ended', () => {
  it("sends nothing, so nothing goes out with another account's pair stored since", async () => {
    setTokens(A_U1, R_U1, true);
    setTabSignedInAs('u-1');
    // The session ends here (a force:logout, a refused renewal): the page is
    // on its way to the sign-in page, and another tab signs in as u-2
    endSessionRenewals();
    setTokens(A_U2, R_U2, true);
    validAccess = A_U2;
    await expect(api.post('/admin/users/x/ban', {})).rejects.toBeInstanceOf(SessionLostError);
    await expect(api.get('/admin/stats')).rejects.toBeInstanceOf(SessionLostError);
    expect(seen).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe(R_U2);
  });
});
