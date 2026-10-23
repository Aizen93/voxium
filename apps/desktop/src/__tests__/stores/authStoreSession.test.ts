import { describe, it, expect, vi, beforeEach } from 'vitest';

// The session restore at launch (checkAuth): a launch with no network used to
// sign the user out (tokens cleared on ANY failure), and a token renewed by
// the /auth/me request's own 401 retry was not the one the socket then
// handshook with.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));

const socket = vi.hoisted(() => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn() }));
vi.mock('../../services/socket', () => ({
  connectSocket: socket.connectSocket,
  disconnectSocket: socket.disconnectSocket,
  getSocket: vi.fn(() => null),
  getSocketGeneration: vi.fn(() => 0),
  onSocketReady: vi.fn(() => () => {}),
  onSocketReconnect: vi.fn(() => () => {}),
  onConnectionStatusChange: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => 'connected'),
}));

const storage = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => 'access-old' as string | null),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  isRemembered: vi.fn(() => true),
}));
vi.mock('../../services/tokenStorage', () => storage);

const session = vi.hoisted(() => ({ SessionLostError: class SessionLostError extends Error {} }));
vi.mock('../../services/session', () => session);
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { useAuthStore } from '../../stores/authStore';

const me = { id: 'u-1', username: 'alice', emailVerified: true, consentRequired: false };

beforeEach(() => {
  vi.clearAllMocks();
  storage.getAccessToken.mockReturnValue('access-old');
  useAuthStore.setState({ user: null, isAuthenticated: true, isLoading: true });
});

describe('authStore.checkAuth — the session restore at launch', () => {
  it('signs in and handshakes the socket with the token stored AFTER /auth/me (it may have been renewed by that request)', async () => {
    api.get.mockImplementationOnce(async () => {
      // The request interceptor renewed the expired token on the way
      storage.getAccessToken.mockReturnValue('access-renewed');
      return { data: { data: me } };
    });

    await useAuthStore.getState().checkAuth();

    expect(socket.connectSocket).toHaveBeenCalledWith('access-renewed');
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true, isLoading: false });
    expect(storage.clearTokens).not.toHaveBeenCalled();
  });

  it('a launch with NO NETWORK keeps the tokens: the next launch signs back in without a password', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' }));

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(socket.connectSocket).not.toHaveBeenCalled();
  });

  it('a server mid-restart (5xx) keeps the tokens too', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('503'), { isAxiosError: true, response: { status: 503 } }));

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).not.toHaveBeenCalled();
  });

  it('a REFUSED session (401 after the renewal failed too) clears the tokens', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401 } }));

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('a lost session (the renewal was refused for good) clears them as well', async () => {
    api.get.mockRejectedValueOnce(new session.SessionLostError('lost'));

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).toHaveBeenCalledTimes(1);
  });

  it('with no stored token there is nothing to restore', async () => {
    storage.getAccessToken.mockReturnValue(null);

    await useAuthStore.getState().checkAuth();

    expect(api.get).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('an account that cannot hold a live session is signed in without a socket', async () => {
    api.get.mockResolvedValueOnce({ data: { data: { ...me, emailVerified: false } } });

    await useAuthStore.getState().checkAuth();

    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
