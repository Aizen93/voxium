import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  // The stored session is read asynchronously (the OS credential store in
  // the desktop app); `true` = the store answered
  hydrateTokens: vi.fn(async () => true),
  getTrustedDeviceToken: vi.fn(() => null as string | null),
  setTrustedDeviceToken: vi.fn(),
  clearTrustedDeviceToken: vi.fn(),
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

import {
  useAuthStore, SESSION_RESTORE_RETRY_DELAYS_MS, SESSION_RESTORE_TIMEOUT_MS, SESSION_RESTORE_RETRY_AFTER_MAX_MS,
  _resetSessionRestoreForTests,
} from '../../stores/authStore';

const me = { id: 'u-1', username: 'alice', emailVerified: true, consentRequired: false };

const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
const status = (code: number) => Object.assign(new Error(`${code}`), { isAxiosError: true, response: { status: code } });

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionRestoreForTests();
  storage.getAccessToken.mockReturnValue('access-old');
  storage.hydrateTokens.mockResolvedValue(true);
  storage.getTrustedDeviceToken.mockReturnValue(null);
  useAuthStore.setState({ user: null, isAuthenticated: true, isLoading: true });
});

afterEach(() => {
  _resetSessionRestoreForTests();
  vi.useRealTimers();
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
    expect(api.get).toHaveBeenCalledWith('/auth/me', expect.objectContaining({ timeout: SESSION_RESTORE_TIMEOUT_MS }));
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

  it('a sign-in cancels the retry a failed launch restore left pending', async () => {
    vi.useFakeTimers();
    api.get.mockRejectedValueOnce(networkError());
    await useAuthStore.getState().checkAuth();
    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'access-b', refreshToken: 'refresh-b' } } });

    await useAuthStore.getState().login('b@example.com', 'pw');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(api.get).toHaveBeenCalledTimes(1); // no restore ran over the new session
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

describe('authStore.checkAuth — the stored session, the deadline and the retry back-off', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
  });

  it('loads the stored session BEFORE reading a token (the desktop app keeps it in the OS credential store)', async () => {
    storage.getAccessToken.mockReturnValue(null);
    storage.hydrateTokens.mockImplementationOnce(async () => {
      storage.getAccessToken.mockReturnValue('access-old');
      return true;
    });
    api.get.mockResolvedValueOnce({ data: { data: me } });

    await useAuthStore.getState().checkAuth();

    expect(storage.hydrateTokens).toHaveBeenCalledTimes(1);
    expect(storage.hydrateTokens.mock.invocationCallOrder[0]).toBeLessThan(api.get.mock.invocationCallOrder[0]);
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true, isLoading: false });
  });

  it('gives the restore request a deadline of its own', async () => {
    api.get.mockResolvedValueOnce({ data: { data: me } });
    await useAuthStore.getState().checkAuth();
    expect(api.get).toHaveBeenCalledWith('/auth/me', { timeout: SESSION_RESTORE_TIMEOUT_MS });
  });

  it('a transport failure keeps the tokens and retries after the first delay; the retry signs in when the server answers, then nothing more runs', async () => {
    api.get.mockRejectedValueOnce(networkError());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false });
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying'), 'Network Error');

    api.get.mockResolvedValueOnce({ data: { data: me } });
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0] - 1);
    expect(api.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
    expect(socket.connectSocket).toHaveBeenCalledWith('access-old');

    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.get).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('the delay grows with each failure in a row and the last one repeats (a 5xx and a timeout count as failures too)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockRejectedValue(status(503));

    await useAuthStore.getState().checkAuth();
    expect(api.get).toHaveBeenCalledTimes(1);

    for (const [i, delay] of SESSION_RESTORE_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api.get).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.get).toHaveBeenCalledTimes(i + 2);
    }
    const last = SESSION_RESTORE_RETRY_DELAYS_MS[SESSION_RESTORE_RETRY_DELAYS_MS.length - 1];
    api.get.mockRejectedValue(Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }));
    await vi.advanceTimersByTimeAsync(last);
    expect(api.get).toHaveBeenCalledTimes(SESSION_RESTORE_RETRY_DELAYS_MS.length + 2);
    await vi.advanceTimersByTimeAsync(last);
    expect(api.get).toHaveBeenCalledTimes(SESSION_RESTORE_RETRY_DELAYS_MS.length + 3);
    expect(storage.clearTokens).not.toHaveBeenCalled();
    api.get.mockReset();
  });

  it('a refusal on a retry clears the tokens and stops the retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockRejectedValueOnce(networkError());
    await useAuthStore.getState().checkAuth();

    api.get.mockRejectedValueOnce(status(401));
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]);

    expect(storage.clearTokens).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('the network coming back (retrySessionRestore) runs the restore at once and resets the back-off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockRejectedValue(networkError());
    await useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[1]);
    expect(api.get).toHaveBeenCalledTimes(3); // the next retry would be delay[2] away

    await useAuthStore.getState().retrySessionRestore();
    expect(api.get).toHaveBeenCalledTimes(4);

    // back to the first delay, not the third
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]);
    expect(api.get).toHaveBeenCalledTimes(5);
    api.get.mockReset();
  });

  it('logout cancels a pending retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockRejectedValueOnce(networkError());
    await useAuthStore.getState().checkAuth();

    useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls share ONE restore (launch, the network event and a timer can ask within the same second)', async () => {
    let answer!: (value: unknown) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

    const first = useAuthStore.getState().checkAuth();
    const second = useAuthStore.getState().checkAuth();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0); // past the awaited hydration
    expect(api.get).toHaveBeenCalledTimes(1);

    answer({ data: { data: me } });
    await Promise.all([first, second]);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // and a later call is a new restore
    api.get.mockResolvedValueOnce({ data: { data: me } });
    await useAuthStore.getState().checkAuth();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('a credential store that did not answer, with nothing loaded, is asked again on the back-off (a keyring daemon still starting)', async () => {
    storage.getAccessToken.mockReturnValue(null);
    storage.hydrateTokens.mockResolvedValueOnce(false);

    await useAuthStore.getState().checkAuth();
    expect(api.get).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoading).toBe(false);

    storage.hydrateTokens.mockImplementationOnce(async () => {
      storage.getAccessToken.mockReturnValue('access-old');
      return true;
    });
    api.get.mockResolvedValueOnce({ data: { data: me } });
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]);

    expect(storage.hydrateTokens).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
  });

  it('a store that answered with nothing stored is not asked again', async () => {
    storage.getAccessToken.mockReturnValue(null);

    await useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(storage.hydrateTokens).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('authStore — the trusted-device token lives with the session, not in localStorage', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, totpRequired: false, totpToken: null });
  });

  it('login sends the stored trusted-device token (and nothing when the device holds none)', async () => {
    api.post.mockResolvedValue({ data: { data: { user: me, accessToken: 'a', refreshToken: 'r' } } });

    await useAuthStore.getState().login('a@example.com', 'pw');
    expect(api.post.mock.calls[0][1]).toMatchObject({ trustedDeviceToken: undefined });

    storage.getTrustedDeviceToken.mockReturnValue('trusted-1');
    await useAuthStore.getState().login('a@example.com', 'pw');
    expect(api.post.mock.calls[1][1]).toMatchObject({ trustedDeviceToken: 'trusted-1' });
    expect(localStorage.getItem('voxium_trusted_device')).toBeNull();
  });

  it('verifyTOTP stores the trusted-device token the server hands out, through the session store', async () => {
    useAuthStore.setState({ totpRequired: true, totpToken: 'totp-challenge', totpRememberMe: true });
    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'a', refreshToken: 'r', trustedDeviceToken: 'trusted-new' } } });

    await useAuthStore.getState().verifyTOTP('123456');

    expect(storage.setTrustedDeviceToken).toHaveBeenCalledWith('trusted-new');
    expect(storage.setTokens).toHaveBeenCalledWith('a', 'r', true);
    expect(localStorage.getItem('voxium_trusted_device')).toBeNull();
  });

  it('verifyTOTP stores none when the server hands none out', async () => {
    useAuthStore.setState({ totpRequired: true, totpToken: 'totp-challenge' });
    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'a', refreshToken: 'r' } } });

    await useAuthStore.getState().verifyTOTP('123456');

    expect(storage.setTrustedDeviceToken).not.toHaveBeenCalled();
  });

  it('disabling TOTP and deleting the account forget the trusted device', async () => {
    api.post.mockResolvedValueOnce({ data: {} });
    await useAuthStore.getState().disableTOTP('123456');
    expect(storage.clearTrustedDeviceToken).toHaveBeenCalledTimes(1);

    api.delete.mockResolvedValueOnce({ data: {} });
    await useAuthStore.getState().deleteAccount('pw');
    expect(storage.clearTrustedDeviceToken).toHaveBeenCalledTimes(2);
  });
});

describe('authStore.checkAuth — a restore outlived by the session it ran for applies nothing', () => {
  const bob = { id: 'u-2', username: 'bob', emailVerified: true, consentRequired: false };

  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
  });

  it('a sign-in while /auth/me is pending: the old answer sets no user and hands no token to the socket', async () => {
    let answer!: (value: unknown) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const restore = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    api.post.mockResolvedValueOnce({ data: { data: { user: bob, accessToken: 'access-b', refreshToken: 'refresh-b' } } });
    await useAuthStore.getState().login('b@example.com', 'pw');
    // the sign-in ended the old session's renewals too (one refused in flight must not end the NEW session)
    expect(session.endSessionRenewals).toHaveBeenCalled();

    storage.getAccessToken.mockReturnValue('access-b');
    answer({ data: { data: me } }); // alice's profile lands late
    await restore;

    expect(useAuthStore.getState().user).toEqual(bob);
    expect(socket.connectSocket).toHaveBeenCalledTimes(1);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-b');
  });

  it('a logout while /auth/me is pending: the late 200 signs nobody back in and connects nothing', async () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });
    let answer!: (value: unknown) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const restore = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    useAuthStore.getState().logout();
    answer({ data: { data: me } });
    await restore;

    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false });
    expect(socket.connectSocket).not.toHaveBeenCalled();
  });

  it('a transport failure landing after a sign-in schedules no retry over the new session', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail!: (err: unknown) => void;
    api.get.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const restore = useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(0);

    api.post.mockResolvedValueOnce({ data: { data: { user: bob, accessToken: 'access-b', refreshToken: 'refresh-b' } } });
    await useAuthStore.getState().login('b@example.com', 'pw');
    fail(networkError());
    await restore;

    api.get.mockClear();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.get).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toEqual(bob);
  });

  it('a refusal landing after a sign-in does not clear the NEW session\'s tokens', async () => {
    let fail!: (err: unknown) => void;
    api.get.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const restore = useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    api.post.mockResolvedValueOnce({ data: { data: { user: bob, accessToken: 'access-b', refreshToken: 'refresh-b' } } });
    await useAuthStore.getState().login('b@example.com', 'pw');
    storage.clearTokens.mockClear(); // the sign-in's own discard
    fail(status(401));
    await restore;

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ user: bob, isAuthenticated: true });
  });
});

describe('authStore.checkAuth — what counts as a refusal, and what the deadline covers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
  });

  it('a 401 to a request sent with a token whose renewal had just failed transiently is NOT a refusal: tokens kept, retried', async () => {
    // The pre-send renewal met a 429 (the per-IP refresh limiter) and the
    // request went out with the expired token; the 401 answers that token,
    // the refresh token was never judged — clearing here erased a 30-day
    // remembered session over a limiter answer
    api.get.mockRejectedValueOnce(Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401 }, config: { _renewalFailed: true } }));

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false });

    api.get.mockResolvedValueOnce({ data: { data: me } });
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]);
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
  });

  it('a 401 to a request that was sent with a renewed (or unexpired) token IS a refusal', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401 }, config: { _retry: true } }));

    await useAuthStore.getState().checkAuth();

    expect(storage.clearTokens).toHaveBeenCalledTimes(1);
  });

  it('the deadline covers the stored-session read: a keychain prompt nobody answers ends in a retry, not a loading screen forever', async () => {
    storage.hydrateTokens.mockReturnValueOnce(new Promise(() => {})); // never answers
    const restore = useAuthStore.getState().checkAuth();

    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_TIMEOUT_MS - 1);
    expect(useAuthStore.getState().isLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await restore;

    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
    expect(storage.clearTokens).not.toHaveBeenCalled();

    // the store answered by the time the retry runs
    api.get.mockResolvedValueOnce({ data: { data: me } });
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]);
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
  });

  it('the deadline covers a /auth/me that never answers either (its renewal hung before axios started its own timer)', async () => {
    api.get.mockReturnValueOnce(new Promise(() => {}));
    const restore = useAuthStore.getState().checkAuth();

    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_TIMEOUT_MS);
    await restore;

    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retrying'), expect.stringContaining('no answer within'));
  });

  it('a credential store that never answers is asked on the schedule once, then left to the next network change or launch', async () => {
    storage.getAccessToken.mockReturnValue(null);
    storage.hydrateTokens.mockResolvedValue(false);

    await useAuthStore.getState().checkAuth();
    for (const delay of SESSION_RESTORE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    expect(storage.hydrateTokens).toHaveBeenCalledTimes(SESSION_RESTORE_RETRY_DELAYS_MS.length + 1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(storage.hydrateTokens).toHaveBeenCalledTimes(SESSION_RESTORE_RETRY_DELAYS_MS.length + 1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('has not answered'));

    // the network coming back asks again
    useAuthStore.setState({ isLoading: false });
    await useAuthStore.getState().retrySessionRestore();
    expect(storage.hydrateTokens).toHaveBeenCalledTimes(SESSION_RESTORE_RETRY_DELAYS_MS.length + 2);
  });

  it('a server that keeps not answering is retried for as long as the login page is up (every 30 s at most)', async () => {
    api.get.mockRejectedValue(networkError());

    await useAuthStore.getState().checkAuth();
    for (const delay of SESSION_RESTORE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    const afterSchedule = api.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[SESSION_RESTORE_RETRY_DELAYS_MS.length - 1] * 10);

    expect(api.get.mock.calls.length).toBe(afterSchedule + 10);
    api.get.mockReset();
  });

  it('checkAuth while signed in (the email-verification page) failing transiently schedules no retry', async () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true, isLoading: false });
    api.get.mockRejectedValueOnce(networkError());

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe('authStore.checkAuth — a 429 is retried when the server says, not sooner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
  });

  const tooMany = (retryAfter: string) => Object.assign(new Error('429'), {
    isAxiosError: true,
    response: { status: 429, headers: { 'retry-after': retryAfter } },
  });

  it('honours Retry-After when it is longer than the back-off (retrying into a block only spends the shared budget again)', async () => {
    api.get.mockRejectedValueOnce(tooMany('45'));

    await useAuthStore.getState().checkAuth();
    expect(storage.clearTokens).not.toHaveBeenCalled(); // a 429 is never a refusal

    api.get.mockResolvedValueOnce({ data: { data: me } });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(api.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
  });

  it('keeps the back-off when Retry-After is shorter, and bounds an absurd one', async () => {
    api.get.mockRejectedValueOnce(tooMany('1'));
    await useAuthStore.getState().checkAuth();
    api.get.mockRejectedValueOnce(tooMany('999999'));
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_DELAYS_MS[0]); // the back-off, not 1 s
    expect(api.get).toHaveBeenCalledTimes(2);

    api.get.mockResolvedValueOnce({ data: { data: me } });
    await vi.advanceTimersByTimeAsync(SESSION_RESTORE_RETRY_AFTER_MAX_MS - 1);
    expect(api.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});
