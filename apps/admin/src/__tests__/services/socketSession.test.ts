import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

// The REAL session module, api instance, socket module and auth store; only
// the socket.io transport is faked. "Another tab" writes the shared storage
// and dispatches the `storage` event the browser would deliver.
type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); return this; }
  removeAllListeners() { this.handlers.clear(); }
  fire(ev: string, ...args: unknown[]) { (this.handlers.get(ev) ?? []).forEach((fn) => fn(...args)); }
}

class FakeSocket extends FakeEmitter {
  connected = false;
  auth: { token?: string };
  io = new FakeEmitter();
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(opts: { auth: { token: string } }) { super(); this.auth = opts.auth; }
}

const created: FakeSocket[] = [];
vi.mock('socket.io-client', () => ({
  io: (_url: string, opts: { auth: { token: string } }) => {
    const s = new FakeSocket(opts);
    created.push(s);
    return s;
  },
}));

import { api } from '../../services/api';
import { connectSocket, disconnectSocket } from '../../services/socket';
import { _resetSessionForTests, isTabSignedIn, setTabSignedInAs } from '../../services/session';
import { setTokens, getAccessToken, getRefreshToken } from '../../services/tokenStorage';
import { useAuthStore } from '../../stores/authStore';

/** A token shaped like ours, carrying `sid` (unsigned: only the client's own comparison reads it). */
function token(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}
function otherTabStores(access: string, refresh: string) {
  localStorage.setItem('voxium_admin_access_token', access);
  localStorage.setItem('voxium_admin_refresh_token', refresh);
  window.dispatchEvent(new StorageEvent('storage', { key: 'voxium_admin_access_token', storageArea: localStorage }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'voxium_admin_refresh_token', storageArea: localStorage }));
}

function failure(status: number, config: InternalAxiosRequestConfig): AxiosError {
  return new AxiosError(String(status), 'ERR_BAD_REQUEST', config, null, {
    status, statusText: '', headers: {}, config, data: { success: false, error: 'x' },
  });
}

let seen: Array<string | undefined>;
const adapter: AxiosAdapter = async (config) => {
  const bearer = (config.headers.Authorization as string | undefined)?.replace('Bearer ', '');
  seen.push(bearer);
  if (bearer !== 'A2') throw failure(401, config);
  return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
};

let post: ReturnType<typeof vi.spyOn>;
let hrefs: string[];
const realLocation = window.location;

beforeEach(() => {
  hrefs = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { set href(v: string) { hrefs.push(v); }, get href() { return 'http://x/'; } },
  });
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
  localStorage.clear();
  sessionStorage.clear();
  created.length = 0;
  seen = [];
  _resetSessionForTests();
  api.defaults.adapter = adapter;
  post = vi.spyOn(axios, 'post');
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  disconnectSocket();
  _resetSessionForTests();
  post.mockRestore();
});

describe('the REST client and the socket handshake', () => {
  it('share ONE renewal when both find the token refused at once', async () => {
    setTokens('A1', 'R1', true);
    setTabSignedInAs('u');
    let answer!: (v: unknown) => void;
    post.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    connectSocket('A1');
    const s = created[0];

    // The handshake is refused and a request is refused, in the same breath
    s.fire('connect_error', new Error('Token expired'));
    const request = api.get('/admin/stats');
    await vi.waitFor(() => expect(seen).toEqual(['A1']));

    answer({ data: { success: true, data: { accessToken: 'A2', refreshToken: 'R2' } } });
    await expect(request).resolves.toMatchObject({ data: { ok: true } });
    await vi.waitFor(() => expect(s.connect).toHaveBeenCalledTimes(1));

    const refreshCalls = (post.mock.calls as unknown[][]).filter((c) => String(c[0]).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    expect(s.auth).toEqual({ token: 'A2' });
    expect(seen).toEqual(['A1', 'A2']);
    expect(getAccessToken()).toBe('A2');
    expect(getRefreshToken()).toBe('R2');
  });
});

describe('two tabs on one stored session', () => {
  const S1 = token({ sid: 'S', gen: 1 });
  const S2 = token({ sid: 'S', gen: 2 });
  const M = token({ sid: 'M', gen: 0 });

  function signedInOn(access: string, refresh: string) {
    setTokens(access, refresh, true);
    connectSocket(access);
    const s = created[created.length - 1];
    s.connected = true;
    useAuthStore.setState({ user: { id: 'u', role: 'admin' } as never, isAuthenticated: true });
    return s;
  }

  it("a sign-in in the other tab moves this tab's socket onto the new session; a renewal there does not", () => {
    const s = signedInOn(S1, 'R-S1');
    otherTabStores(S2, 'R-S2');
    expect(s.connect).not.toHaveBeenCalled();
    otherTabStores(M, 'R-M');
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.auth).toEqual({ token: M });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it("force:logout for this socket's session, renewed since in the other tab: cleared, the sign-in page with the reason", async () => {
    const s = signedInOn(S1, 'R-S1');
    setTokens(S2, 'R-S2');
    s.fire('force:logout', { reason: 'You were signed out from another device' });
    await vi.waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs[0]).toBe('/login?reason=You%20were%20signed%20out%20from%20another%20device');
    expect(getRefreshToken()).toBeNull();
  });

  it('force:logout with a request in flight that then comes back 401: ONE navigation, with its reason; no renewal', async () => {
    const access = token({ userId: 'u', sid: 'S' });
    const s = signedInOn(access, token({ userId: 'u', sid: 'S', gen: 1 }));
    setTabSignedInAs('u');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let out = false;
    api.defaults.adapter = (async (config) => { out = true; await gate; throw failure(401, config); }) as AxiosAdapter;
    const request = api.get('/admin/stats');
    await vi.waitFor(() => expect(out).toBe(true));
    s.fire('force:logout', { reason: 'You were signed out from another device' });
    await vi.waitFor(() => expect(hrefs).toHaveLength(1));
    release();
    await expect(request).rejects.toMatchObject({ response: { status: 401 } });
    expect(hrefs).toEqual(['/login?reason=You%20were%20signed%20out%20from%20another%20device']);
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBeNull();
  });

  it.each([
    ['Account banned', '/login?reason=Your%20account%20has%20been%20banned'],
    ['User not found', '/login?reason=Your%20account%20has%20been%20deleted'],
  ])('a handshake refused with %s signs this tab out, without a server call', async (message, href) => {
    const s = signedInOn(S1, 'R-S1');
    setTabSignedInAs('u');
    s.connected = false;
    s.fire('connect_error', new Error(message));
    await vi.waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs).toEqual([href]);
    expect(getRefreshToken()).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(isTabSignedIn()).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('force:logout on a socket opened with a token naming no session, the stored pair renewed into one since: kept, a reload onto it', async () => {
    // A token issued before sessions existed carries no sid: it cannot be
    // matched with the stored session, which is then not this tab's to clear
    const legacy = token({ userId: 'u' });
    connectSocket(legacy);
    const s = created[0];
    s.connected = true;
    setTokens(token({ userId: 'u', sid: 'S' }), token({ userId: 'u', sid: 'S', gen: 1 }), true);
    useAuthStore.setState({ user: { id: 'u', role: 'admin' } as never, isAuthenticated: true });
    s.fire('force:logout', { reason: 'Your account has been banned' });
    await vi.waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs).toEqual(['/']);
    expect(getRefreshToken()).not.toBeNull();
  });

  it('force:logout for a session the other tab has replaced with a new sign-in: nothing cleared, a reload onto the new one', async () => {
    const s = signedInOn(S1, 'R-S1');
    // Stored without the event reaching this tab yet
    setTokens(M, 'R-M');
    s.fire('force:logout', { reason: 'Your session has ended' });
    await vi.waitFor(() => expect(hrefs).toHaveLength(1));
    expect(hrefs[0]).toBe('/');
    expect(getAccessToken()).toBe(M);
    expect(getRefreshToken()).toBe('R-M');
    expect(post).not.toHaveBeenCalled();
  });
});
