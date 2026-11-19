import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/socket', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn() }));

import { useAuthStore } from '../../stores/authStore';
import { setTokens } from '../../services/tokenStorage';

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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
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
