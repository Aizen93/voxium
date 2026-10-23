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
  refreshAccessToken: vi.fn(),
  SessionLostError: class SessionLostError extends Error {},
}));
vi.mock('../../services/session', () => session);

const socket = vi.hoisted(() => ({ connectSocket: vi.fn() }));
vi.mock('../../services/socket', () => socket);

const storage = vi.hoisted(() => ({ getAccessToken: vi.fn(() => 'access-old') }));
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
  storage.getAccessToken.mockReturnValue('access-old');
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
    session.isAccessTokenFresh.mockReturnValue(false);
    session.refreshAccessToken.mockResolvedValueOnce('access-new');

    const out = await requestInterceptor()(config()) as { headers: Record<string, string> };

    expect(out.headers.Authorization).toBe('Bearer access-new');
  });

  it('sends with the stale token when the renewal fails transiently (the server decides)', async () => {
    session.isAccessTokenFresh.mockReturnValue(false);
    session.refreshAccessToken.mockRejectedValueOnce(new Error('Network Error'));

    const out = await requestInterceptor()(config()) as { headers: Record<string, string> };

    expect(out.headers.Authorization).toBe('Bearer access-old');
  });

  it('refuses the request outright once the session is lost', async () => {
    session.isAccessTokenFresh.mockReturnValue(false);
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
    const original = config();
    const error = { response: { status: 401 }, config: original };

    await responseRejected()(error);

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-new');
    expect(fake.instance).toHaveBeenCalledTimes(1);
    const retried = fake.instance.mock.calls[0][0] as { headers: Record<string, string>; _retry: boolean };
    expect(retried.headers.Authorization).toBe('Bearer access-new');
    expect(retried._retry).toBe(true);
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
    const error = { response: { status: 401 }, config: config() };

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
