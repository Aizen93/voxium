import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// axios.create() answers a callable fake whose interceptor registrations are
// captured, so the two interceptors can be driven directly
const fake = vi.hoisted(() => {
  type Req = (config: Record<string, unknown>) => unknown;
  type Res = { ok: (r: unknown) => unknown; bad: (e: unknown) => unknown };
  const handlers = { request: [] as Req[], response: [] as Res[] };
  const instance = Object.assign(vi.fn(), {
    interceptors: {
      request: { use: (f: Req) => { handlers.request.push(f); } },
      response: { use: (ok: Res['ok'], bad: Res['bad']) => { handlers.response.push({ ok, bad }); } },
    },
  });
  // The transport behind the coalescing adapter (what axios.getAdapter answers)
  const transport = vi.fn();
  // What api.ts passed to axios.create — the adapter under test lives there
  const created: { options?: Record<string, unknown> } = {};
  class AxiosError extends Error {
    isAxiosError = true;
    constructor(message?: string, public code?: string, public config?: unknown, public request?: unknown, public response?: unknown) {
      super(message);
    }
    static from(err: AxiosError, code?: string, config?: unknown, request?: unknown, response?: unknown) {
      return new AxiosError(err.message, code, config, request, response);
    }
  }
  return { handlers, instance, transport, created, AxiosError };
});
vi.mock('axios', () => ({
  default: {
    create: (options: Record<string, unknown>) => { fake.created.options = options; return fake.instance; },
    getAdapter: () => fake.transport,
    defaults: { adapter: ['xhr', 'http', 'fetch'] },
  },
  AxiosError: fake.AxiosError,
}));

const session = vi.hoisted(() => ({
  API_BASE: 'http://api.test/api/v1',
  isAccessTokenFresh: vi.fn(() => true),
  shouldRenewBeforeSending: vi.fn(() => false),
  refreshAccessToken: vi.fn(),
  SessionLostError: class SessionLostError extends Error {},
}));
vi.mock('../../services/session', () => session);

const socket = vi.hoisted(() => ({ connectSocket: vi.fn() }));
vi.mock('../../services/socket', () => socket);

const storage = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => 'access-old' as string | null),
  getRefreshToken: vi.fn(() => 'refresh-old' as string | null),
}));
vi.mock('../../services/tokenStorage', () => storage);

import { api, coalescingKey, _resetApiForTests, COALESCE_MAX_AGE_MS } from '../../services/api';
import { requestGeneration, bumpRequestGeneration } from '../../services/requestGeneration';

const requestInterceptor = () => fake.handlers.request[0];
const responseRejected = () => fake.handlers.response[0].bad;

function config(): Record<string, unknown> & { headers: Record<string, string> } {
  return { url: '/servers', method: 'get', headers: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.isAccessTokenFresh.mockReturnValue(true);
  session.shouldRenewBeforeSending.mockReturnValue(false);
  storage.getAccessToken.mockReturnValue('access-old');
  storage.getRefreshToken.mockReturnValue('refresh-old');
  fake.instance.mockResolvedValue({ data: { success: true } });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('api — the request interceptor', () => {
  it('registers one request interceptor and one response interceptor', () => {
    expect(api).toBe(fake.instance);
    expect(fake.handlers.request).toHaveLength(1);
    expect(fake.handlers.response).toHaveLength(1);
  });

  it('attaches the stored token while it is fresh, without renewing it', async () => {
    const out = await requestInterceptor()(config()) as { headers: Record<string, string> };

    expect(out.headers.Authorization).toBe('Bearer access-old');
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('renews a token known to be expired BEFORE sending (a window restored after a long minimize): no 401 round trip', async () => {
    session.shouldRenewBeforeSending.mockReturnValue(true);
    session.refreshAccessToken.mockResolvedValueOnce('access-new');

    const out = await requestInterceptor()(config()) as { headers: Record<string, string> };

    expect(out.headers.Authorization).toBe('Bearer access-new');
  });

  it('sends with the stale token when the renewal fails transiently (the server decides), logged and marked on the request', async () => {
    session.shouldRenewBeforeSending.mockReturnValue(true);
    session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await requestInterceptor()(config()) as { headers: Record<string, string>; _renewalFailed?: boolean };

    expect(out.headers.Authorization).toBe('Bearer access-old');
    expect(out._renewalFailed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('renew'), 'Network Error');
    warn.mockRestore();
  });

  it('refuses the request outright once the session is lost', async () => {
    session.shouldRenewBeforeSending.mockReturnValue(true);
    session.refreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('lost'));

    await expect(requestInterceptor()(config())).rejects.toBeInstanceOf(session.SessionLostError);
  });

  it('sends no header without a stored token', async () => {
    storage.getAccessToken.mockReturnValue(null as never);

    const out = await requestInterceptor()(config()) as { headers: Record<string, string> };

    expect(out.headers.Authorization).toBeUndefined();
  });
});

describe('api — the 401 retry', () => {
  it('renews the token once, re-handshakes the socket with it and retries the request', async () => {
    session.refreshAccessToken.mockResolvedValueOnce('access-new');
    const original = { ...config(), headers: { Authorization: 'Bearer access-old' } };
    const error = { response: { status: 401 }, config: original };

    await responseRejected()(error);

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-new');
    expect(fake.instance).toHaveBeenCalledTimes(1);
    const retried = fake.instance.mock.calls[0][0] as { headers: Record<string, string>; _retry: boolean };
    expect(retried.headers.Authorization).toBe('Bearer access-new');
    expect(retried._retry).toBe(true);
  });

  it('retries with the token stored meanwhile — no second renewal — when another request\'s renewal landed after this one left', async () => {
    storage.getAccessToken.mockReturnValue('access-renewed-by-another');
    const original = { ...config(), headers: { Authorization: 'Bearer access-old' } };
    const error = { response: { status: 401 }, config: original };

    await responseRejected()(error);

    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connectSocket).not.toHaveBeenCalled();
    const retried = fake.instance.mock.calls[0][0] as { headers: Record<string, string> };
    expect(retried.headers.Authorization).toBe('Bearer access-renewed-by-another');
  });

  it('does not spend a second renewal on a request whose own pre-send renewal just failed transiently', async () => {
    const original = { ...config(), headers: { Authorization: 'Bearer access-old' }, _renewalFailed: true };
    const error = { response: { status: 401 }, config: original };

    await expect(responseRejected()(error)).rejects.toBe(error);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(fake.instance).not.toHaveBeenCalled();
  });

  it('a 401 to a request that carried NO token (a sign-in with a wrong password) is the answer: no renewal, nothing ended', async () => {
    // Renewing here found no refresh token and ended a session that did not
    // exist — a navigation to the login page that lost the typed e-mail and
    // the "invalid credentials" banner
    storage.getAccessToken.mockReturnValue(null);
    storage.getRefreshToken.mockReturnValue(null);
    const error = { response: { status: 401 }, config: { ...config(), url: '/auth/login', method: 'post' } };

    await expect(responseRejected()(error)).rejects.toBe(error);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(fake.instance).not.toHaveBeenCalled();
  });

  it('a 401 with a token sent but no refresh token stored passes through as well (nothing to renew with)', async () => {
    storage.getRefreshToken.mockReturnValue(null);
    const error = { response: { status: 401 }, config: { ...config(), headers: { Authorization: 'Bearer access-old' } } };

    await expect(responseRejected()(error)).rejects.toBe(error);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('reads the sent token through AxiosHeaders#get, which is what a sent request carries', async () => {
    session.refreshAccessToken.mockResolvedValueOnce('access-new');
    const headers = { get: (name: string) => (name === 'Authorization' ? 'Bearer access-old' : undefined) };
    const error = { response: { status: 401 }, config: { ...config(), headers } };

    await responseRejected()(error);

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('never retries twice: a 401 on the retried request is the answer', async () => {
    const error = { response: { status: 401 }, config: { ...config(), _retry: true } };

    await expect(responseRejected()(error)).rejects.toBe(error);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(fake.instance).not.toHaveBeenCalled();
  });

  it('a failed renewal fails this request with the renewal error (tokens are the session module\'s business)', async () => {
    const failure = new Error('Network Error');
    session.refreshAccessToken.mockRejectedValueOnce(failure);
    const error = { response: { status: 401 }, config: { ...config(), headers: { Authorization: 'Bearer access-old' } } };

    await expect(responseRejected()(error)).rejects.toBe(failure);
    expect(fake.instance).not.toHaveBeenCalled();
    expect(socket.connectSocket).not.toHaveBeenCalled();
  });

  it('every other failure passes through untouched', async () => {
    const error = { response: { status: 500 }, config: config() };

    await expect(responseRejected()(error)).rejects.toBe(error);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('a failure without a config (the request never went out) passes through', async () => {
    const error = { response: { status: 401 } };

    await expect(responseRejected()(error)).rejects.toBe(error);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });
});


// ─── Identical GETs in flight share one request (issue 4) ───────────────────
//
// The layout's mount and the socket's connect handler both fetch the server
// and DM lists, every permission gate asks for the same effective bits, a
// reload asked for the device list four times — each copy a point of the
// per-IP budget everyone behind the NAT shares. Coalesced at the transport.

type Adapter = (config: Record<string, unknown>) => Promise<unknown>;
const adapter = () => fake.created.options!.adapter as Adapter;

function getConfig(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: 'get', baseURL: 'http://api.test/api/v1', url, headers: { Authorization: 'Bearer access-old' }, ...extra };
}

const ok = (data: unknown = {}) => ({ status: 200, data, config: {}, headers: {} });

/** A transport answer the test releases by hand. */
function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('api — the coalescing adapter', () => {
  beforeEach(() => {
    _resetApiForTests();
    fake.transport.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is what api.ts hands axios', () => {
    expect(typeof fake.created.options!.adapter).toBe('function');
  });

  it('two identical GETs in flight make ONE request; the follower gets its own copy of the data and its own config', async () => {
    const answer = deferred();
    fake.transport.mockReturnValueOnce(answer.promise);
    const leaderConfig = getConfig('/servers');
    const followerConfig = getConfig('/servers');

    const leader = adapter()(leaderConfig);
    const follower = adapter()(followerConfig);
    expect(fake.transport).toHaveBeenCalledTimes(1);

    const payload = { data: [{ id: 's1' }] };
    answer.resolve({ status: 200, data: payload, config: leaderConfig, headers: {} });
    const [a, b] = (await Promise.all([leader, follower])) as Array<{ data: unknown; config: unknown }>;

    expect(a.data).toBe(payload);
    expect(b.data).toEqual(payload);
    expect(b.data).not.toBe(payload); // a copy: one store mutating its slice cannot reach the other
    expect(a.config).toBe(leaderConfig);
    expect(b.config).toBe(followerConfig);
  });

  it('releases the key once the leader settled: a later identical GET goes out again', async () => {
    fake.transport.mockResolvedValueOnce(ok('one'));
    await adapter()(getConfig('/dm'));
    fake.transport.mockResolvedValueOnce(ok('two'));
    const second = (await adapter()(getConfig('/dm'))) as { data: string };

    expect(fake.transport).toHaveBeenCalledTimes(2);
    expect(second.data).toBe('two');
  });

  it('a leader\'s failure reaches the follower as an error of ITS OWN: own config and its own copy of the body, so the 401 path marks and retries the right request', async () => {
    const answer = deferred();
    fake.transport.mockReturnValueOnce(answer.promise);
    const leaderConfig = getConfig('/servers');
    const followerConfig = getConfig('/servers');
    const leader = adapter()(leaderConfig);
    const follower = adapter()(followerConfig);

    const body = { success: false, error: 'Unauthorized' };
    const failure = new fake.AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', leaderConfig, {}, { status: 401, config: leaderConfig, data: body });
    answer.reject(failure);

    await expect(leader).rejects.toBe(failure);
    const got = await follower.catch((e: unknown) => e) as InstanceType<typeof fake.AxiosError>;
    expect(got).toBeInstanceOf(fake.AxiosError);
    expect(got).not.toBe(failure);
    expect(got.config).toBe(followerConfig);
    const response = got.response as { status: number; config: unknown; data: unknown };
    expect(response.status).toBe(401);
    expect(response.config).toBe(followerConfig);
    expect(response.data).toEqual(body);
    expect(response.data).not.toBe(body);
    expect(got.message).toBe(failure.message);
    // a non-axios failure passes through as it is
    fake.transport.mockRejectedValueOnce(new Error('boom'));
    await expect(adapter()(getConfig('/x'))).rejects.toThrow('boom');
  });

  it('a different URL, different params or a different bearer is a different request', async () => {
    fake.transport.mockResolvedValue(ok());
    await Promise.all([
      adapter()(getConfig('/servers')),
      adapter()(getConfig('/dm')),
      adapter()(getConfig('/servers', { params: { page: 2 } })),
      adapter()(getConfig('/servers', { headers: { Authorization: 'Bearer someone-else' } })),
    ]);
    expect(fake.transport).toHaveBeenCalledTimes(4);
  });

  it('leaves alone what must go out on its own: non-GETs, aborts, cancel tokens, downloads, bodies, custom transforms or status checks, params that are not a plain object, the key-share claim', async () => {
    fake.transport.mockResolvedValue(ok());
    const signal = new AbortController().signal;
    const alone = [
      getConfig('/servers', { method: 'post' }),
      getConfig('/servers', { method: 'post' }),
      getConfig('/uploads/k', { responseType: 'blob' }),
      getConfig('/uploads/k', { responseType: 'blob' }),
      getConfig('/uploads/k', { responseType: 'arraybuffer' }),
      getConfig('/search', { signal }),
      getConfig('/search', { signal }),
      getConfig('/a', { cancelToken: {} }),
      getConfig('/a', { cancelToken: {} }),
      getConfig('/b', { data: { x: 1 } }),
      getConfig('/b', { data: { x: 1 } }),
      getConfig('/c', { validateStatus: () => true }),
      getConfig('/c', { validateStatus: () => true }),
      getConfig('/d', { transformResponse: [(v: unknown) => v] }),
      getConfig('/d', { transformResponse: [(v: unknown) => v] }),
      getConfig('/e', { params: new URLSearchParams('a=1') }),
      getConfig('/e', { params: new URLSearchParams('a=1') }),
      getConfig('/e2e/keyshares', { params: { deviceId: 'd1' } }),
      getConfig('/e2e/keyshares', { params: { deviceId: 'd1' } }),
    ];
    await Promise.all(alone.map((c) => adapter()(c)));
    expect(fake.transport).toHaveBeenCalledTimes(alone.length);
  });

  it('a GET issued AFTER a write does not join a GET in flight from before it (it would get the pre-write answer)', async () => {
    const before = deferred();
    fake.transport.mockReturnValueOnce(before.promise);
    const stale = adapter()(getConfig('/servers'));

    fake.transport.mockResolvedValueOnce(ok({ created: true }));
    await adapter()(getConfig('/servers', { method: 'post', data: { name: 'New' } }));

    fake.transport.mockResolvedValueOnce(ok('fresh'));
    const fresh = (await adapter()(getConfig('/servers'))) as { data: string };
    expect(fresh.data).toBe('fresh');
    expect(fake.transport).toHaveBeenCalledTimes(3);

    before.resolve(ok('stale'));
    expect(((await stale) as { data: string }).data).toBe('stale');
  });

  it('a socket event separates the GETs issued after it from those issued before (the stores refetch BECAUSE of the event)', async () => {
    const before = deferred();
    fake.transport.mockReturnValueOnce(before.promise);
    void adapter()(getConfig('/servers/s1/roles/permissions/effective'));

    bumpRequestGeneration(); // what socket.ts does on every inbound event

    fake.transport.mockResolvedValueOnce(ok('after the role edit'));
    const after = (await adapter()(getConfig('/servers/s1/roles/permissions/effective'))) as { data: string };
    expect(after.data).toBe('after the role edit');
    expect(fake.transport).toHaveBeenCalledTimes(2);
    before.resolve(ok('before'));
  });

  it('nobody joins a leader older than COALESCE_MAX_AGE_MS (a request hung on a dead connection must not take later GETs with it)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    const hung = deferred();
    fake.transport.mockReturnValueOnce(hung.promise);
    void adapter()(getConfig('/dm'));

    vi.setSystemTime(new Date('2026-10-24T12:00:00Z').getTime() + COALESCE_MAX_AGE_MS + 1);
    fake.transport.mockResolvedValueOnce(ok('fresh'));
    const fresh = (await adapter()(getConfig('/dm'))) as { data: string };
    expect(fresh.data).toBe('fresh');
    expect(fake.transport).toHaveBeenCalledTimes(2);
    hung.resolve(ok('late'));
  });

  it('coalescingKey: the identity is generation + method + base + url + params + bearer; everything else is null', () => {
    const key = coalescingKey(getConfig('/servers') as never, 7);
    expect(key).toBe('7|http://api.test/api/v1|/servers||access-old');
    expect(coalescingKey(getConfig('/servers', { params: { a: 1 } }) as never, 7)).toBe('7|http://api.test/api/v1|/servers|{"a":1}|access-old');
    expect(coalescingKey(getConfig('/servers', { headers: {} }) as never, 7)).toBe('7|http://api.test/api/v1|/servers||');
    expect(coalescingKey(getConfig('/servers', { responseType: 'json' }) as never, 7)).toBe(key);
    expect(coalescingKey(getConfig('/servers') as never)).toBe(`${requestGeneration()}|http://api.test/api/v1|/servers||access-old`);
    expect(coalescingKey(getConfig('/servers', { method: 'POST' }) as never)).toBeNull();
    expect(coalescingKey(getConfig('/servers', { responseType: 'blob' }) as never)).toBeNull();
    expect(coalescingKey(getConfig('/servers', { signal: new AbortController().signal }) as never)).toBeNull();
    expect(coalescingKey(getConfig('/servers', { params: { big: BigInt(1) } }) as never)).toBeNull();
    expect(coalescingKey(getConfig('/e2e/keyshares') as never)).toBeNull();
    expect(coalescingKey(getConfig('/servers', { paramsSerializer: { indexes: null } }) as never)).toBeNull();
  });
});
