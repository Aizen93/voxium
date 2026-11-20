import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/socket', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), followStoredSession: vi.fn() }));

import { useAuthStore, SIGN_IN_TIMEOUT_MS } from '../../stores/authStore';
import { setTokens, getRefreshToken } from '../../services/tokenStorage';
import { disconnectSocket } from '../../services/socket';
import {
  endSessionRenewals, isTabSignedIn, refreshAccessToken, SessionLostError, setTabSignedInAs, tabAccountId,
  _resetSessionForTests,
} from '../../services/session';

const CLIENT_KEYS = ['voxium_access_token', 'voxium_refresh_token'];

function seedClientSession() {
  for (const k of CLIENT_KEYS) {
    localStorage.setItem(k, `client-${k}`);
    sessionStorage.setItem(k, `client-s-${k}`);
  }
}
function expectClientSessionIntact() {
  for (const k of CLIENT_KEYS) {
    expect(localStorage.getItem(k)).toBe(`client-${k}`);
    expect(sessionStorage.getItem(k)).toBe(`client-s-${k}`);
  }
}

let axiosPost: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  axiosPost = vi.spyOn(axios, 'post').mockResolvedValue({ status: 204 });
  localStorage.clear();
  sessionStorage.clear();
  _resetSessionForTests();
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
});

afterEach(() => {
  _resetSessionForTests();
  axiosPost.mockRestore();
});

describe('authStore on an origin that also holds a web-client session', () => {
  it("checkAuth asks nothing and clears nothing when only the client's keys exist", async () => {
    seedClientSession();
    await useAuthStore.getState().checkAuth();
    expect(api.get).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false });
    expectClientSessionIntact();
  });

  it("checkAuth clearing a non-admin dashboard session leaves the client's session", async () => {
    seedClientSession();
    setTokens('a', 'r', true);
    api.get.mockResolvedValue({ data: { data: { id: 'u', role: 'user' } } });
    await useAuthStore.getState().checkAuth();
    expect(localStorage.getItem('voxium_admin_access_token')).toBeNull();
    expectClientSessionIntact();
  });

  it('logout clears only the dashboard session', () => {
    seedClientSession();
    setTokens('a', 'r', true);
    setTabSignedInAs('u');
    useAuthStore.getState().logout();
    expect(localStorage.getItem('voxium_admin_access_token')).toBeNull();
    expectClientSessionIntact();
  });

  it('login stores the session under the dashboard names only', async () => {
    seedClientSession();
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u', role: 'admin' }, accessToken: 'A', refreshToken: 'R' } } });
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(localStorage.getItem('voxium_admin_access_token')).toBe('A');
    expectClientSessionIntact();
  });
});

describe('authStore sign-in carries the client hint', () => {
  it('login sends client: admin', async () => {
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u', role: 'admin' }, accessToken: 'A', refreshToken: 'R' } } });
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(api.post).toHaveBeenCalledWith('/auth/login', expect.objectContaining({ email: 'e@x.test', client: 'admin' }), { skipAuth: true, timeout: SIGN_IN_TIMEOUT_MS });
  });

  it('the two-factor step sends client: admin', async () => {
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u', role: 'admin' }, accessToken: 'A', refreshToken: 'R' } } });
    await useAuthStore.getState().verifyTOTP('123456');
    expect(api.post).toHaveBeenCalledWith('/auth/totp/verify', { totpToken: 'T', code: '123456', client: 'admin' }, { skipAuth: true, timeout: SIGN_IN_TIMEOUT_MS });
  });
});

describe('authStore sign-out', () => {
  // Signed in as an account the unclaimed test tokens do not contradict
  beforeEach(() => setTabSignedInAs('u'));

  it('captures the refresh token before clearing, signs out locally at once and calls the route once without a bearer', () => {
    setTokens('A', 'R-1', true);
    useAuthStore.setState({ user: { id: 'u' } as never, isAuthenticated: true });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false });
    expect(getRefreshToken()).toBeNull();
    expect(disconnectSocket).toHaveBeenCalled();
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0][0]).toMatch(/\/auth\/logout$/);
    expect(axiosPost.mock.calls[0][1]).toEqual({ refreshToken: 'R-1' });
    expect((axiosPost.mock.calls[0][2] as { headers?: unknown }).headers).toBeUndefined();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a failing call changes nothing for the user and logs no token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    axiosPost.mockRejectedValue(new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE'));
    setTokens('A', 'R-secret', true);
    useAuthStore.setState({ user: { id: 'u' } as never, isAuthenticated: true });
    expect(() => useAuthStore.getState().logout()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.stringify(warn.mock.calls)).not.toContain('R-secret');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().error).toBeNull();
    warn.mockRestore();
  });

  it('a hanging call leaves the person signed out at once', () => {
    axiosPost.mockReturnValue(new Promise(() => undefined));
    setTokens('A', 'R', true);
    useAuthStore.setState({ user: { id: 'u' } as never, isAuthenticated: true });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(axiosPost.mock.calls[0][2]).toMatchObject({ timeout: expect.any(Number) });
  });

  it('makes no call without a refresh token', () => {
    localStorage.setItem('voxium_admin_access_token', 'A');
    useAuthStore.getState().logout();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(localStorage.getItem('voxium_admin_access_token')).toBeNull();
  });

  it('from a tab whose session has already ended (the page on its way to sign-in): nothing cleared, no server call', () => {
    setTokens('A', 'R', true);
    useAuthStore.setState({ user: { id: 'u' } as never, isAuthenticated: true });
    endSessionRenewals();
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(getRefreshToken()).toBe('R');
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('a server-caused sign-out clears locally and makes no call', () => {
    setTokens('A', 'R', true);
    useAuthStore.setState({ user: { id: 'u' } as never, isAuthenticated: true });
    useAuthStore.getState().endSessionLocally();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(getRefreshToken()).toBeNull();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('a renewal in flight at sign-out cannot bring the session back, nor hand the next session to its callers', async () => {
    const hrefs: string[] = [];
    const realLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { set href(v: string) { hrefs.push(v); }, get href() { return 'http://x/'; } },
    });
    try {
      setTokens('A', 'R', true);
      useAuthStore.setState({ user: { id: 'u', role: 'admin' } as never, isAuthenticated: true });
      let answer!: (v: unknown) => void;
      axiosPost.mockReturnValueOnce(new Promise((r) => { answer = r; }));
      const pending = refreshAccessToken();
      useAuthStore.getState().logout();
      // Signed in again in this tab before the old answer lands
      api.post.mockResolvedValue({ data: { data: { user: { id: 'u', role: 'admin' }, accessToken: 'A-new', refreshToken: 'R-new' } } });
      await useAuthStore.getState().login('e@x.test', 'pw');
      answer({ data: { data: { accessToken: 'A2', refreshToken: 'R2' } } });
      await expect(pending).rejects.toBeInstanceOf(SessionLostError);
      expect(getRefreshToken()).toBe('R-new');
      expect(isTabSignedIn()).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(hrefs).toEqual([]);
    } finally {
      endSessionRenewals();
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  it("with another account's pair stored (a sign-in in another tab, not followed yet): signed out here only, nothing cleared, no server call", () => {
    const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims))}.s`;
    const otherAccess = token({ userId: 'u-2', sid: 's2' });
    const otherRefresh = token({ userId: 'u-2', sid: 's2', gen: 0 });
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u-1', role: 'admin' }, accessToken: token({ userId: 'u-1', sid: 's1' }), refreshToken: 'R-1' } } });
    return useAuthStore.getState().login('e@x.test', 'pw').then(() => {
      setTokens(otherAccess, otherRefresh, true);
      axiosPost.mockClear();
      useAuthStore.getState().logout();
      expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null });
      expect(isTabSignedIn()).toBe(false);
      expect(disconnectSocket).toHaveBeenCalled();
      expect(axiosPost).not.toHaveBeenCalled();
      expect(getRefreshToken()).toBe(otherRefresh);
      expect(localStorage.getItem('voxium_admin_access_token')).toBe(otherAccess);
    });
  });

  it('a local end of the session also drops a two-factor step under way', () => {
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    useAuthStore.getState().endSessionLocally();
    expect(useAuthStore.getState()).toMatchObject({ totpRequired: false, totpToken: null });
  });
});

describe('authStore sign-in signs the tab in as that account', () => {
  it('a successful sign-in', async () => {
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u-7', role: 'admin' }, accessToken: 'A', refreshToken: 'R' } } });
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(isTabSignedIn()).toBe(true);
    expect(tabAccountId()).toBe('u-7');
  });

  it('a successful two-factor step', async () => {
    useAuthStore.setState({ totpRequired: true, totpToken: 'T' });
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u-8', role: 'superadmin' }, accessToken: 'A', refreshToken: 'R' } } });
    await useAuthStore.getState().verifyTOTP('123456');
    expect(tabAccountId()).toBe('u-8');
  });

  it('a refused sign-in signs nobody in', async () => {
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u', role: 'user' }, accessToken: 'A', refreshToken: 'R' } } });
    await expect(useAuthStore.getState().login('e@x.test', 'pw')).rejects.toBeDefined();
    expect(isTabSignedIn()).toBe(false);
  });

  it('a sign-out signs the tab out', async () => {
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u', role: 'admin' }, accessToken: 'A', refreshToken: 'R' } } });
    await useAuthStore.getState().login('e@x.test', 'pw');
    expect(isTabSignedIn()).toBe(true);
    useAuthStore.getState().logout();
    expect(isTabSignedIn()).toBe(false);
  });
});
