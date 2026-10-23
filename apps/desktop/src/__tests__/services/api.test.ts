import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  return { handlers, instance };
});
vi.mock('axios', () => ({
  default: { create: () => fake.instance },
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

import { api } from '../../services/api';

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
