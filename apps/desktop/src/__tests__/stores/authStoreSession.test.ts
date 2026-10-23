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

const session = vi.hoisted(() => ({ SessionLostError: class SessionLostError extends Error {}, endSessionRenewals: vi.fn() }));
vi.mock('../../services/session', () => session);
vi.mock('../../stores/resetStores', () => ({ resetAccountStores: vi.fn() }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ activeChannelId: null, dmCallConversationId: null, leaveChannel: vi.fn(), leaveDMCall: vi.fn() }) },
}));
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

  it('a launch with NO NETWORK keeps the tokens (and says so): the next launch signs back in without a password', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tokens kept'), 'Network Error');
    warn.mockRestore();
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

  it('logout ends the session\'s renewals BEFORE clearing the tokens, so a refresh in flight stores nothing', () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });

    useAuthStore.getState().logout();

    expect(session.endSessionRenewals).toHaveBeenCalledTimes(1);
    expect(session.endSessionRenewals.mock.invocationCallOrder[0]).toBeLessThan(storage.clearTokens.mock.invocationCallOrder[0]);
    expect(socket.disconnectSocket).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('retrySessionRestore (the network came back) runs checkAuth only while signed out with a token stored and the first restore over', async () => {
    api.get.mockResolvedValue({ data: { data: me } });

    useAuthStore.setState({ isAuthenticated: true, isLoading: false });
    await useAuthStore.getState().retrySessionRestore();
    expect(api.get).not.toHaveBeenCalled();

    useAuthStore.setState({ isAuthenticated: false, isLoading: true });
    await useAuthStore.getState().retrySessionRestore();
    expect(api.get).not.toHaveBeenCalled();

    storage.getAccessToken.mockReturnValue(null);
    useAuthStore.setState({ isAuthenticated: false, isLoading: false });
    await useAuthStore.getState().retrySessionRestore();
    expect(api.get).not.toHaveBeenCalled();

    storage.getAccessToken.mockReturnValue('access-old');
    await useAuthStore.getState().retrySessionRestore();
    expect(api.get).toHaveBeenCalledWith('/auth/me');
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
  });

  it('an account that cannot hold a live session is signed in without a socket', async () => {
    api.get.mockResolvedValueOnce({ data: { data: { ...me, emailVerified: false } } });

    await useAuthStore.getState().checkAuth();

    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

describe('authStore — a sign-in discards the session it replaces FIRST', () => {
  // A launch that could not reach the server keeps its tokens and shows the
  // login page. Signing in from there used to send that stale token on the
  // sign-in request itself (renewed, or refused — a reload that swallowed the
  // attempt), and a socket still open for the old account would have been
  // handed to the new one.
  it('login clears the stored tokens and the socket before posting', async () => {
    api.post.mockImplementationOnce(async () => {
      expect(storage.clearTokens).toHaveBeenCalledTimes(1);
      expect(socket.disconnectSocket).toHaveBeenCalledTimes(1);
      return { data: { data: { user: me, accessToken: 'access-b', refreshToken: 'refresh-b' } } };
    });

    await useAuthStore.getState().login('b@example.com', 'pw');

    expect(api.post).toHaveBeenCalledWith('/auth/login', expect.objectContaining({ email: 'b@example.com' }));
    expect(storage.setTokens).toHaveBeenCalledWith('access-b', 'refresh-b', true);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-b');
    expect(socket.disconnectSocket.mock.invocationCallOrder[0]).toBeLessThan(socket.connectSocket.mock.invocationCallOrder[0]);
  });

  it('a wrong password leaves the login page with its error, nothing navigated', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    api.post.mockRejectedValueOnce(Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: 'Invalid credentials' } } }));

    await expect(useAuthStore.getState().login('b@example.com', 'wrong')).rejects.toBeTruthy();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().error).toBeTruthy();
    expect(socket.connectSocket).not.toHaveBeenCalled();
  });

  it('register clears them too, before the proof of work is even fetched', async () => {
    const { solveRegistrationPowOffThread } = await import('../../services/powSolver');
    vi.mocked(solveRegistrationPowOffThread).mockResolvedValueOnce({ nonce: 1 } as never);
    api.get.mockImplementationOnce(async () => {
      expect(storage.clearTokens).toHaveBeenCalledTimes(1);
      expect(socket.disconnectSocket).toHaveBeenCalledTimes(1);
      return { data: { data: { challenge: 'c' } } };
    });
    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'access-n', refreshToken: 'refresh-n' } } });

    await useAuthStore.getState().register('newbie', 'n@example.com', 'password123', { acceptTerms: true, acceptPrivacy: true });

    expect(api.get).toHaveBeenCalledWith('/auth/register-challenge');
    expect(storage.setTokens).toHaveBeenCalledWith('access-n', 'refresh-n', true);
  });
});
