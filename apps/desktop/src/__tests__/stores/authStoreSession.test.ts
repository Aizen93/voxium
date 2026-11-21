import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The session restore at launch (checkAuth): a launch with no network used to
// sign the user out (tokens cleared on ANY failure), and a token renewed by
// the /auth/me request's own 401 retry was not the one the socket then
// handshook with.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));

const socket = vi.hoisted(() => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), reconnectSocketAfterCredentialChange: vi.fn(), endCredentialChange: vi.fn(), beginCredentialChange: vi.fn() }));
vi.mock('../../services/socket', () => ({
  connectSocket: socket.connectSocket,
  disconnectSocket: socket.disconnectSocket,
  reconnectSocketAfterCredentialChange: socket.reconnectSocketAfterCredentialChange,
  beginCredentialChange: socket.beginCredentialChange,
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
  // the memory lets go of the pair
  clearTokens: vi.fn(() => storage.forgetPair()),
  getRefreshToken: vi.fn(() => 'refresh-old' as string | null),
  /** The memory lets go of the pair: nothing is read from it any more. */
  forgetPair: () => {
    storage.getAccessToken.mockReturnValue(null);
    storage.getRefreshToken.mockReturnValue(null);
  },
  // A session-ending clear, as the real one decides for these tokens (they
  // name no session, so only the very same token is of the ended session):
  // nothing held, or a reload pending → the memory alone lets go; another
  // token held → 'replaced', the memory lets go and the stored pair stays;
  // else the pair is cleared
  clearSessionTokensAsTheModuleDoes: (endedToken: string | null, _options?: { accountWide?: boolean }): 'cleared' | 'replaced' => {
    const access = storage.getAccessToken();
    const refresh = storage.getRefreshToken();
    if (storage.isReloadPending() || (access === null && refresh === null)) return storage.letGoOfSession();
    if (endedToken !== null && endedToken !== access && endedToken !== refresh) {
      storage.forgetPair();
      return 'replaced';
    }
    storage.clearTokens();
    return 'cleared';
  },
  clearSessionTokens: vi.fn((endedToken: string | null, options?: { accountWide?: boolean }) => storage.clearSessionTokensAsTheModuleDoes(endedToken, options)),
  reloadAfterSessionChange: vi.fn(),
  announceSessionEnded: vi.fn(),
  // no reload onto another session pending; a sign-out with no session to end lets go of the memory only
  isReloadPending: vi.fn(() => false),
  letGoOfSession: vi.fn((): 'cleared' | 'replaced' => {
    storage.forgetPair();
    return storage.isReloadPending() ? 'replaced' : 'cleared';
  }),
  // after a 'replaced' restore: what is stored now, taken up (false: the caller reloads onto it)
  takeUpStoredSession: vi.fn(() => false),
  isRemembered: vi.fn(() => true),
  // The stored session is read asynchronously (the OS credential store in
  // the desktop app); `true` = the store answered
  hydrateTokens: vi.fn(async () => true),
  getTrustedDeviceToken: vi.fn(() => null as string | null),
  setTrustedDeviceToken: vi.fn(),
  clearTrustedDeviceToken: vi.fn(),
  flushTokenStorage: vi.fn(async () => {}),
}));
vi.mock('../../services/tokenStorage', () => storage);

const session = vi.hoisted(() => ({
  SessionLostError: class SessionLostError extends Error {},
  endSessionRenewals: vi.fn(),
  // A credential change runs at once here; its holds and lock are services/session.ts's own tests
  runCredentialChange: vi.fn(<T,>(change: (stillCurrent: () => boolean) => Promise<T>) => change(() => true)),
  refreshAccessToken: vi.fn(async () => 'access-renewed'),
  CREDENTIAL_CHANGE_TIMEOUT_MS: 75_000,
  /** The session epoch: endSessionRenewals (a logout) moves it */
  epoch: 0,
  currentSessionEpoch: vi.fn((): number => session.epoch),
  forgetIgnoredSessionEnd: vi.fn(),
}));
vi.mock('../../services/session', () => session);
vi.mock('../../stores/resetStores', () => ({ resetAccountStores: vi.fn() }));
// The server side of a sign-out (services/sessionRevocation.ts): watched, never a real request
const revocation = vi.hoisted(() => ({ endSessionOnServer: vi.fn(), holdReplacedSession: vi.fn(), endReplacedSession: vi.fn(), forgetReplacedSession: vi.fn() }));
vi.mock('../../services/sessionRevocation', () => revocation);
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ activeChannelId: null, dmCallConversationId: null, leaveChannel: vi.fn(), leaveDMCall: vi.fn() }) },
}));
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
const imageProcessing = vi.hoisted(() => ({ processImage: vi.fn(), ASSET_UPLOAD_CONTENT_TYPE: 'image/webp' }));
vi.mock('../../utils/imageProcessing', () => imageProcessing);

import {
  useAuthStore, SESSION_RESTORE_RETRY_DELAYS_MS, SESSION_RESTORE_TIMEOUT_MS, SESSION_RESTORE_RETRY_AFTER_MAX_MS,
  _resetSessionRestoreForTests,
} from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { currentE2ESessionUser } from '../../services/e2e/session';

const me = { id: 'u-1', username: 'alice', emailVerified: true, consentRequired: false };

const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
const status = (code: number) => Object.assign(new Error(`${code}`), { isAxiosError: true, response: { status: code } });

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps the answers a failed test queued and left unconsumed
  for (const mock of [api.get, api.post, api.patch, api.delete, storage.clearSessionTokens, storage.takeUpStoredSession, storage.flushTokenStorage]) mock.mockReset();
  storage.takeUpStoredSession.mockReturnValue(false);
  storage.flushTokenStorage.mockImplementation(async () => {});
  _resetSessionRestoreForTests();
  storage.getAccessToken.mockReturnValue('access-old');
  storage.getRefreshToken.mockReturnValue('refresh-old');
  storage.clearSessionTokens.mockImplementation(storage.clearSessionTokensAsTheModuleDoes);
  storage.isReloadPending.mockReturnValue(false);
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
      // an end of a session ignored before says nothing about this one
      expect(session.forgetIgnoredSessionEnd).toHaveBeenCalledTimes(1);
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
    api.post.mockResolvedValueOnce({ data: { data: { pendingId: 'p-n', resendAfterSeconds: 600 } } });

    await useAuthStore.getState().register('newbie', 'n@example.com', 'password123', { acceptTerms: true, acceptPrivacy: true });

    expect(api.get).toHaveBeenCalledWith('/auth/register-challenge');
    // Step one creates no account: nothing to store yet
    expect(storage.setTokens).not.toHaveBeenCalled();
  });

  it('completing a registration clears them before the code goes out, then stores the new session', async () => {
    useAuthStore.setState({
      pendingRegistration: { pendingId: 'p-n', email: 'n@example.com', resendAfterSeconds: 600, issuedAt: Date.now(), resendUsed: false, usernameTaken: false },
    });
    api.post.mockImplementationOnce(async () => {
      expect(storage.clearTokens).toHaveBeenCalledTimes(1);
      expect(socket.disconnectSocket).toHaveBeenCalledTimes(1);
      return { data: { data: { user: me, accessToken: 'access-n', refreshToken: 'refresh-n' } } };
    });

    await useAuthStore.getState().completeRegistration('123456');

    expect(api.post).toHaveBeenCalledWith('/auth/register/complete', { pendingId: 'p-n', code: '123456', client: 'web' });
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

describe('authStore.changePassword — the live socket follows the new tokens', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true, isLoading: false });
    socket.beginCredentialChange.mockImplementation(() => socket.endCredentialChange);
  });

  it('stores the fresh pair, THEN reopens the socket with the new access token — no sign-out, no new socket', async () => {
    const order: string[] = [];
    socket.beginCredentialChange.mockImplementationOnce(() => { order.push('begin'); return socket.endCredentialChange; });
    socket.endCredentialChange.mockImplementationOnce(() => { order.push('end'); });
    api.post.mockImplementationOnce(async () => {
      order.push('post');
      return { data: { message: 'Password changed successfully.', data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } };
    });
    storage.setTokens.mockImplementationOnce(() => { order.push('setTokens'); });
    socket.reconnectSocketAfterCredentialChange.mockImplementationOnce(() => { order.push('reconnect'); });

    const message = await useAuthStore.getState().changePassword('old-pw', 'new-pw-123');

    expect(message).toBe('Password changed successfully.');
    // The change is marked in flight BEFORE the request (its server
    // disconnect may beat the answer), and ended after the reopen
    expect(order).toEqual(['begin', 'post', 'setTokens', 'reconnect', 'end']);
    expect(api.post).toHaveBeenCalledWith('/auth/change-password', { currentPassword: 'old-pw', newPassword: 'new-pw-123', rememberMe: true, client: 'web' }, { _noRenewal: true, timeout: 75_000 });
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
    expect(socket.reconnectSocketAfterCredentialChange).toHaveBeenCalledWith('access-new');
    // The session is the same one: nothing torn down, still signed in
    expect(socket.disconnectSocket).not.toHaveBeenCalled();
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user).toEqual(me);
  });

  it('touches neither the tokens nor the socket when the change is refused', async () => {
    api.post.mockRejectedValueOnce(status(400));

    await expect(useAuthStore.getState().changePassword('wrong', 'new-pw-123')).rejects.toThrow('400');

    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(socket.reconnectSocketAfterCredentialChange).not.toHaveBeenCalled();
    // The in-flight mark is lifted on a refusal too
    expect(socket.endCredentialChange).toHaveBeenCalledTimes(1);
  });

  it('reopens nothing when the answer carries no token pair (an older server)', async () => {
    api.post.mockResolvedValueOnce({ data: { message: 'ok' } });

    await useAuthStore.getState().changePassword('old-pw', 'new-pw-123');

    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(socket.reconnectSocketAfterCredentialChange).not.toHaveBeenCalled();
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

  it("the sign-in and the two-factor step name the kind of app ('web' in the browser build, 'desktop' in the Tauri app)", async () => {
    api.post.mockResolvedValue({ data: { data: { user: me, accessToken: 'a', refreshToken: 'r' } } });
    await useAuthStore.getState().login('a@example.com', 'pw');
    expect(api.post).toHaveBeenLastCalledWith('/auth/login', expect.objectContaining({ client: 'web' }));

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      useAuthStore.setState({ totpRequired: true, totpToken: 'totp-challenge', totpRememberMe: true });
      await useAuthStore.getState().verifyTOTP('123456');
      expect(api.post).toHaveBeenLastCalledWith('/auth/totp/verify', { totpToken: 'totp-challenge', code: '123456', client: 'desktop' });
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
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

describe('authStore.uploadAvatar — the presign is signed for the processed image', () => {
  const KEY = 'avatars/u-1-1700000000.webp';
  const processed = new Blob([new Uint8Array(12_345)], { type: 'image/webp' });
  const original = new File([new Uint8Array(3_000_000)], 'me.jpg', { type: 'image/jpeg' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('processes FIRST, presigns with the processed size, PUTs that blob, then saves the key', async () => {
    const order: string[] = [];
    imageProcessing.processImage.mockImplementation(async () => { order.push('process'); return processed; });
    api.post.mockImplementation(async () => { order.push('presign'); return { data: { data: { uploadUrl: 'https://store.example/put', key: KEY } } }; });
    const fetchMock = vi.fn(async () => { order.push('put'); return { ok: true, status: 200 }; });
    vi.stubGlobal('fetch', fetchMock);
    api.patch.mockImplementation(async () => { order.push('save'); return { data: { data: { avatarUrl: KEY } } }; });
    useAuthStore.setState({ user: { ...me, avatarUrl: null } as never });

    await useAuthStore.getState().uploadAvatar(original);

    expect(order).toEqual(['process', 'presign', 'put', 'save']);
    expect(imageProcessing.processImage).toHaveBeenCalledWith(original);
    expect(api.post).toHaveBeenCalledWith('/uploads/presign/avatar', { fileSize: 12_345 });
    expect(fetchMock).toHaveBeenCalledWith('https://store.example/put', {
      method: 'PUT',
      body: processed,
      headers: { 'Content-Type': 'image/webp' },
    });
    expect(api.patch).toHaveBeenCalledWith('/users/me/profile', { avatarUrl: KEY });
    expect(useAuthStore.getState().user?.avatarUrl).toBe(KEY);
  });

  it('declares the size of the PNG an engine without a WebP encoder produced; the PUT keeps the type the presign signed', async () => {
    const png = new Blob([new Uint8Array(23_456)], { type: 'image/png' });
    imageProcessing.processImage.mockResolvedValue(png);
    api.post.mockResolvedValue({ data: { data: { uploadUrl: 'https://store.example/put', key: KEY } } });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    api.patch.mockResolvedValue({ data: { data: { avatarUrl: KEY } } });
    useAuthStore.setState({ user: { ...me, avatarUrl: null } as never });

    await useAuthStore.getState().uploadAvatar(original);

    expect(api.post).toHaveBeenCalledWith('/uploads/presign/avatar', { fileSize: 23_456 });
    expect(fetchMock).toHaveBeenCalledWith('https://store.example/put', {
      method: 'PUT',
      body: png,
      headers: { 'Content-Type': 'image/webp' },
    });
  });

  it('shows the key the server stored (its verified copy), not the uploaded one', async () => {
    const ADOPTED = 'avatars/u-1-1700000000500-0123456789ab.webp';
    imageProcessing.processImage.mockResolvedValue(processed);
    api.post.mockResolvedValue({ data: { data: { uploadUrl: 'https://store.example/put', key: KEY } } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    api.patch.mockResolvedValue({ data: { data: { avatarUrl: ADOPTED } } });
    useAuthStore.setState({ user: { ...me, avatarUrl: null } as never });

    await useAuthStore.getState().uploadAvatar(original);

    expect(api.patch).toHaveBeenCalledWith('/users/me/profile', { avatarUrl: KEY });
    expect(useAuthStore.getState().user?.avatarUrl).toBe(ADOPTED);
  });

  it.each([
    ['no avatarUrl', {}],
    ['a null avatarUrl', { avatarUrl: null }],
    ['an empty avatarUrl', { avatarUrl: '' }],
    ['a non-string avatarUrl', { avatarUrl: 42 }],
  ])('never shows the uploaded key when the answer carries %s (fails instead)', async (_label, answer) => {
    imageProcessing.processImage.mockResolvedValue(processed);
    api.post.mockResolvedValue({ data: { data: { uploadUrl: 'https://store.example/put', key: KEY } } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    api.patch.mockResolvedValue({ data: { data: answer } });
    const OLD = 'avatars/u-1-1600000000000-0123456789ab.webp';
    useAuthStore.setState({ user: { ...me, avatarUrl: OLD } as never });
    const memberSpy = vi.spyOn(useServerStore.getState(), 'updateMemberAvatar');

    await expect(useAuthStore.getState().uploadAvatar(original)).rejects.toThrow('without the stored avatar key');
    // The deleted upload is never shown; the current avatar stays until a real answer
    expect(useAuthStore.getState().user?.avatarUrl).toBe(OLD);
    expect(memberSpy).not.toHaveBeenCalled();
    memberSpy.mockRestore();
  });

  it('asks for no presign when the image cannot be processed', async () => {
    imageProcessing.processImage.mockRejectedValue(new Error('decode failed'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(useAuthStore.getState().uploadAvatar(original)).rejects.toThrow('decode failed');
    expect(api.post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('never saves the key when the store refuses the PUT', async () => {
    imageProcessing.processImage.mockResolvedValue(processed);
    api.post.mockResolvedValue({ data: { data: { uploadUrl: 'https://store.example/put', key: KEY } } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));

    await expect(useAuthStore.getState().uploadAvatar(original)).rejects.toThrow('S3 upload failed: 403');
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('authStore — the signed-in user is the E2E session', () => {
  it('reports the current user to getE2EService, and nobody once signed out', () => {
    // getE2EService refuses a service for anyone else (services/e2e/session.ts)
    useAuthStore.setState({ user: me as never });
    expect(currentE2ESessionUser()).toBe('u-1');
    useAuthStore.setState({ user: null });
    expect(currentE2ESessionUser()).toBeNull();
  });
});

describe('authStore — a local end of a session clears only that session (another tab may have stored a new one)', () => {
  it('logout ends the session held when it runs, by default, and reports it cleared', () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });

    expect(useAuthStore.getState().logout()).toBe('cleared');

    expect(storage.clearSessionTokens).toHaveBeenCalledWith('refresh-old', { accountWide: false });
    expect(storage.reloadAfterSessionChange).not.toHaveBeenCalled();
  });

  it('a different session stored meanwhile is kept: the stores are still reset, and the page reloads onto it', () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });
    storage.clearSessionTokens.mockReturnValueOnce('replaced');

    expect(useAuthStore.getState().logout({ endingSession: 'access-of-ended-session' })).toBe('replaced');

    expect(storage.clearSessionTokens).toHaveBeenCalledWith('access-of-ended-session', { accountWide: false });
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(socket.disconnectSocket).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
  });

  it('an account deletion ends the session it was sent from, read before the request', async () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });
    api.delete.mockImplementationOnce(async () => {
      // another tab signs in while the deletion runs
      storage.getRefreshToken.mockReturnValue('refresh-of-another-tab');
      return { data: {} };
    });

    await useAuthStore.getState().deleteAccount('pw');

    expect(storage.clearSessionTokens).toHaveBeenCalledWith('refresh-old', { accountWide: true });
  });

  it('an account deletion from a tab holding only an access token ends the session that token names', async () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });
    storage.getRefreshToken.mockReturnValue(null);
    storage.getAccessToken.mockReturnValue('access-only');
    api.delete.mockResolvedValueOnce({ data: {} });

    await useAuthStore.getState().deleteAccount('pw');

    expect(storage.clearSessionTokens).toHaveBeenCalledWith('access-only', { accountWide: true });
    expect(storage.clearTokens).toHaveBeenCalled();
  });

  it('a sign-out while the page reloads onto another session lets go of the memory only, and reports it replaced', () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });
    storage.isReloadPending.mockReturnValue(true);

    expect(useAuthStore.getState().logout()).toBe('replaced');

    expect(storage.clearSessionTokens).not.toHaveBeenCalled();
    expect(storage.letGoOfSession).toHaveBeenCalledTimes(1);
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(revocation.endSessionOnServer).not.toHaveBeenCalled();
    expect(storage.announceSessionEnded).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('a sign-out given a token of another session than the one held ends nothing of the held one', () => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true });

    expect(useAuthStore.getState().logout({ tellServer: false, endingSession: 'refresh-of-a-session-let-go-of' })).toBe('replaced');

    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
  });

  it('a refused restore ends the session it was made with; a different one stored meanwhile is restored instead', async () => {
    vi.useFakeTimers();
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
    api.get.mockRejectedValueOnce(status(403));
    // as the storage module does: 'replaced' lets go of the memory, and only
    // taking up what is stored brings a session back into it
    storage.clearSessionTokens.mockImplementationOnce(() => {
      storage.getAccessToken.mockReturnValue(null);
      storage.getRefreshToken.mockReturnValue(null);
      return 'replaced';
    });
    storage.takeUpStoredSession.mockImplementationOnce(() => {
      storage.getAccessToken.mockReturnValue('access-other');
      storage.getRefreshToken.mockReturnValue('refresh-other');
      return true;
    });
    api.get.mockResolvedValueOnce({ data: { data: me } });

    await useAuthStore.getState().checkAuth();
    expect(storage.clearSessionTokens).toHaveBeenCalledWith('refresh-old');
    expect(storage.clearTokens).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true }));
    expect(api.get).toHaveBeenCalledTimes(2);
    // taken up once the clear of the refused session's copies had landed
    expect(storage.flushTokenStorage.mock.invocationCallOrder[0]).toBeLessThan(storage.takeUpStoredSession.mock.invocationCallOrder[0]);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-other');
    expect(storage.reloadAfterSessionChange).not.toHaveBeenCalled();
  });

  it('a refused restore whose replacement cannot be taken up here (the desktop app, another account) reloads onto it: never the sign-in page over it', async () => {
    vi.useFakeTimers();
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
    api.get.mockRejectedValueOnce(status(401));
    storage.clearSessionTokens.mockImplementationOnce(() => {
      storage.getAccessToken.mockReturnValue(null);
      return 'replaced';
    });

    await useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.takeUpStoredSession).toHaveBeenCalledTimes(1);
    expect(storage.reloadAfterSessionChange).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('a sign-in made before the take-up runs is left alone: nothing taken up, nothing reloaded', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
    api.get.mockRejectedValueOnce(status(401));
    storage.clearSessionTokens.mockReturnValueOnce('replaced');
    let flushed!: () => void;
    storage.flushTokenStorage.mockReturnValueOnce(new Promise<void>((resolve) => { flushed = resolve; }));

    await useAuthStore.getState().checkAuth();
    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'access-b', refreshToken: 'refresh-b' } } });
    await useAuthStore.getState().login('b@example.com', 'pw');
    flushed();
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.takeUpStoredSession).not.toHaveBeenCalled();
    expect(storage.reloadAfterSessionChange).not.toHaveBeenCalled();
  });
});

describe('authStore.logout — the sign-out ends the session on the server too', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true, isLoading: false });
  });

  it('captures the refresh token FIRST, completes locally, THEN tells the server (not awaited) and the twin tabs', () => {
    const order: string[] = [];
    storage.getRefreshToken.mockImplementationOnce(() => { order.push('capture'); return 'refresh-old'; });
    session.endSessionRenewals.mockImplementationOnce(() => { order.push('end renewals'); });
    storage.clearSessionTokens.mockImplementationOnce(() => { order.push('clear'); return 'cleared'; });
    socket.disconnectSocket.mockImplementationOnce(() => { order.push('disconnect'); });
    revocation.endSessionOnServer.mockImplementationOnce(() => { order.push('server'); });
    storage.announceSessionEnded.mockImplementationOnce(() => { order.push('twins'); });

    const outcome = useAuthStore.getState().logout();

    expect(outcome).toBe('cleared');
    expect(order).toEqual(['capture', 'end renewals', 'clear', 'disconnect', 'server', 'twins']);
    expect(revocation.endSessionOnServer).toHaveBeenCalledWith('refresh-old');
    expect(storage.announceSessionEnded).toHaveBeenCalledWith('refresh-old');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('a sign-out that finds another session stored sends its request BEFORE the page is asked to reload (the first try outlives the page)', () => {
    storage.clearSessionTokens.mockReturnValueOnce('replaced');

    expect(useAuthStore.getState().logout()).toBe('replaced');

    expect(revocation.endSessionOnServer).toHaveBeenCalledWith('refresh-old');
    expect(revocation.endSessionOnServer.mock.invocationCallOrder[0]).toBeLessThan(storage.reloadAfterSessionChange.mock.invocationCallOrder[0]);
  });

  it('with nothing held, nothing is sent (the call is a no-op without a token)', () => {
    storage.getRefreshToken.mockReturnValueOnce(null);
    useAuthStore.getState().logout();
    expect(revocation.endSessionOnServer).toHaveBeenCalledWith(null);
  });

  it('tellServer: false (the server ended it, or it is over already) sends nothing and tells no twin', () => {
    useAuthStore.getState().logout({ tellServer: false, endingSession: 'access-of-ended-session' });
    expect(revocation.endSessionOnServer).not.toHaveBeenCalled();
    expect(storage.announceSessionEnded).not.toHaveBeenCalled();
  });

  it('an account deletion never calls the server about the session (the account is gone)', async () => {
    api.delete.mockResolvedValueOnce({ data: {} });
    await useAuthStore.getState().deleteAccount('pw');
    expect(revocation.endSessionOnServer).not.toHaveBeenCalled();
  });

  it('a refused session restore never calls the server either', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
    api.get.mockRejectedValueOnce(status(401));
    await useAuthStore.getState().checkAuth();
    expect(revocation.endSessionOnServer).not.toHaveBeenCalled();
  });
});

describe('authStore — a sign-in that replaces a stored session ends that one on the server once it SUCCEEDED', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, totpRequired: false, totpToken: null });
  });

  it('login: the stale token is held before the discard, and handed over with the new refresh token after success', async () => {
    api.post.mockImplementationOnce(async () => {
      expect(revocation.holdReplacedSession).toHaveBeenCalledWith('refresh-old');
      expect(revocation.holdReplacedSession.mock.invocationCallOrder[0]).toBeLessThan(storage.clearTokens.mock.invocationCallOrder[0]);
      expect(revocation.endReplacedSession).not.toHaveBeenCalled();
      return { data: { data: { user: me, accessToken: 'access-b', refreshToken: 'refresh-b' } } };
    });

    await useAuthStore.getState().login('b@example.com', 'pw');

    expect(revocation.endReplacedSession).toHaveBeenCalledWith('refresh-b');
  });

  it('a failed sign-in sends nothing about the stale session, and neither does a step that asks for the code', async () => {
    api.post.mockRejectedValueOnce(Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: 'Invalid credentials' } } }));
    await expect(useAuthStore.getState().login('b@example.com', 'wrong')).rejects.toBeTruthy();
    expect(revocation.endReplacedSession).not.toHaveBeenCalled();

    api.post.mockResolvedValueOnce({ data: { data: { totpRequired: true, totpToken: 'challenge' } } });
    await useAuthStore.getState().login('b@example.com', 'pw');
    expect(revocation.endReplacedSession).not.toHaveBeenCalled();

    api.post.mockRejectedValueOnce(Object.assign(new Error('400'), { isAxiosError: true, response: { status: 400, data: { error: 'Invalid verification code' } } }));
    await expect(useAuthStore.getState().verifyTOTP('000000')).rejects.toBeTruthy();
    expect(revocation.endReplacedSession).not.toHaveBeenCalled();

    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'access-t', refreshToken: 'refresh-t' } } });
    await useAuthStore.getState().verifyTOTP('123456');
    expect(revocation.endReplacedSession).toHaveBeenCalledTimes(1);
    expect(revocation.endReplacedSession).toHaveBeenCalledWith('refresh-t');
  });

  it('the completion of a registration hands the new refresh token over too', async () => {
    useAuthStore.setState({
      pendingRegistration: { pendingId: 'p-n', email: 'n@example.com', resendAfterSeconds: 600, issuedAt: Date.now(), resendUsed: false, usernameTaken: false },
    });
    api.post.mockResolvedValueOnce({ data: { data: { user: me, accessToken: 'access-n', refreshToken: 'refresh-n' } } });

    await useAuthStore.getState().completeRegistration('123456');

    expect(revocation.holdReplacedSession).toHaveBeenCalled();
    expect(revocation.endReplacedSession).toHaveBeenCalledWith('refresh-n');
  });
});

describe('authStore.revokeOtherSessions — "sign out of all other sessions" is a credential change', () => {
  const NEW_PAIR = { accessToken: 'access-new', refreshToken: 'refresh-new' };

  beforeEach(() => {
    useAuthStore.setState({ user: me as never, isAuthenticated: true, isLoading: false });
    socket.beginCredentialChange.mockImplementation(() => socket.endCredentialChange);
  });

  it('runs inside the credential change, marked on the socket, and stores the pair, THEN reopens the socket', async () => {
    const order: string[] = [];
    session.runCredentialChange.mockImplementationOnce(async (change: (stillCurrent: () => boolean) => Promise<unknown>) => {
      order.push('hold');
      const result = await change(() => true);
      order.push('release');
      return result;
    });
    socket.beginCredentialChange.mockImplementationOnce(() => { order.push('begin'); return socket.endCredentialChange; });
    socket.endCredentialChange.mockImplementationOnce(() => { order.push('end'); });
    api.post.mockImplementationOnce(async () => {
      order.push('post');
      return { data: { success: true, data: { revoked: 2, ...NEW_PAIR } } };
    });
    storage.setTokens.mockImplementationOnce(() => { order.push('setTokens'); });
    socket.reconnectSocketAfterCredentialChange.mockImplementationOnce(() => { order.push('reconnect'); });

    await expect(useAuthStore.getState().revokeOtherSessions('pw')).resolves.toEqual({ revoked: 2 });

    expect(order).toEqual(['hold', 'begin', 'post', 'setTokens', 'reconnect', 'end', 'release']);
    expect(api.post).toHaveBeenCalledWith(
      '/auth/sessions/revoke-others',
      { password: 'pw', rememberMe: true, client: 'web' },
      { _noRenewal: true, timeout: 75_000 },
    );
    // the slot the session is in stays: a renewal-like store
    expect(storage.setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
    expect(socket.reconnectSocketAfterCredentialChange).toHaveBeenCalledWith('access-new');
  });

  it('sends the trusted-device token it holds, and stores the one re-issued under the new version', async () => {
    storage.getTrustedDeviceToken.mockReturnValue('trusted-old');
    api.post.mockResolvedValueOnce({ data: { data: { revoked: 1, ...NEW_PAIR, trustedDeviceToken: 'trusted-new' } } });

    await useAuthStore.getState().revokeOtherSessions('pw');

    expect(api.post.mock.calls[0][1]).toMatchObject({ trustedDeviceToken: 'trusted-old' });
    expect(storage.setTrustedDeviceToken).toHaveBeenCalledWith('trusted-new');
    expect(storage.clearTrustedDeviceToken).not.toHaveBeenCalled();
  });

  it('one sent and none back: the stored one is dropped (it died with the version) — only while it is still the one sent', async () => {
    storage.getTrustedDeviceToken.mockReturnValue('trusted-old');
    api.post.mockResolvedValueOnce({ data: { data: { revoked: 1, ...NEW_PAIR } } });
    await useAuthStore.getState().revokeOtherSessions('pw');
    expect(storage.clearTrustedDeviceToken).toHaveBeenCalledTimes(1);

    // another tab stored a new one while the request was out: not this change's to drop
    storage.getTrustedDeviceToken.mockReturnValueOnce('trusted-old').mockReturnValue('trusted-of-another-tab');
    api.post.mockResolvedValueOnce({ data: { data: { revoked: 1, ...NEW_PAIR } } });
    await useAuthStore.getState().revokeOtherSessions('pw');
    expect(storage.clearTrustedDeviceToken).toHaveBeenCalledTimes(1);
  });

  it('none held: none sent, none dropped', async () => {
    api.post.mockResolvedValueOnce({ data: { data: { revoked: 0, ...NEW_PAIR } } });
    await useAuthStore.getState().revokeOtherSessions('pw');
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('trustedDeviceToken');
    expect(storage.clearTrustedDeviceToken).not.toHaveBeenCalled();
  });

  it('does not rely on the pair: an answer without one stores nothing and reopens nothing', async () => {
    api.post.mockResolvedValueOnce({ data: { data: { revoked: 3 } } });
    await expect(useAuthStore.getState().revokeOtherSessions('pw')).resolves.toEqual({ revoked: 3 });
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(socket.reconnectSocketAfterCredentialChange).not.toHaveBeenCalled();
    expect(socket.endCredentialChange).toHaveBeenCalledTimes(1);
  });

  it('an answer that lands after the session ended (a logout) stores nothing', async () => {
    session.runCredentialChange.mockImplementationOnce((change: (stillCurrent: () => boolean) => Promise<unknown>) => change(() => false));
    storage.getTrustedDeviceToken.mockReturnValue('trusted-old');
    api.post.mockResolvedValueOnce({ data: { data: { revoked: 1, ...NEW_PAIR, trustedDeviceToken: 'trusted-new' } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useAuthStore.getState().revokeOtherSessions('pw');

    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.setTrustedDeviceToken).not.toHaveBeenCalled();
    expect(storage.clearTrustedDeviceToken).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a 401 (the account moved under the request, the session ended) renews once the hold is lifted, and is reported', async () => {
    const refused = Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: 'Session invalidated' } } });
    api.post.mockRejectedValueOnce(refused);

    await expect(useAuthStore.getState().revokeOtherSessions('pw')).rejects.toBe(refused);

    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(socket.endCredentialChange).toHaveBeenCalledTimes(1);
  });

  it('a refused renewal after that 401 has signed out already (services/session.ts): the 401 is still what is reported', async () => {
    const refused = Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: 'Session invalidated' } } });
    api.post.mockRejectedValueOnce(refused);
    session.refreshAccessToken.mockRejectedValueOnce(new session.SessionLostError('refused'));

    await expect(useAuthStore.getState().revokeOtherSessions('pw')).rejects.toBe(refused);
  });

  it('a wrong password (400) or a 429 renews nothing', async () => {
    api.post.mockRejectedValueOnce(Object.assign(new Error('400'), { isAxiosError: true, response: { status: 400, data: { error: 'Password is incorrect' } } }));
    await expect(useAuthStore.getState().revokeOtherSessions('wrong')).rejects.toThrow('400');
    api.post.mockRejectedValueOnce(Object.assign(new Error('429'), { isAxiosError: true, response: { status: 429 } }));
    await expect(useAuthStore.getState().revokeOtherSessions('pw')).rejects.toThrow('429');
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('the password change follows the same rules: inside the credential change, and a 401 renews', async () => {
    const refused = Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: 'Session invalidated' } } });
    api.post.mockRejectedValueOnce(refused);

    await expect(useAuthStore.getState().changePassword('old-pw', 'new-pw-123')).rejects.toBe(refused);

    expect(session.runCredentialChange).toHaveBeenCalledTimes(1);
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('authStore.checkAuth — the answer is applied only for the session it checked', () => {
  /** An access token of `userId` (unsigned: only the claims are read). */
  const tokenOf = (userId: string) => `h.${btoa(JSON.stringify({ userId }))}.s`;

  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
  });

  it('another account stored while /auth/me was out (another tab signed in as someone else): not signed in as the old one, no socket, the restore runs again', async () => {
    vi.useFakeTimers();
    storage.getAccessToken.mockReturnValue(tokenOf('u-1'));
    api.get
      .mockImplementationOnce(async () => {
        storage.getAccessToken.mockReturnValue(tokenOf('u-2'));
        return { data: { data: me } };
      })
      .mockResolvedValueOnce({ data: { data: { ...me, id: 'u-2', username: 'bob' } } });

    await useAuthStore.getState().checkAuth();
    expect(useAuthStore.getState().user).toBeNull();
    expect(socket.connectSocket).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useAuthStore.getState().user).toMatchObject({ id: 'u-2' }));
    expect(socket.connectSocket).toHaveBeenCalledWith(tokenOf('u-2'));
    expect(socket.connectSocket).toHaveBeenCalledTimes(1);
  });

  it('the pair removed while /auth/me was out (another tab signed out): nobody signed in, nothing connected', async () => {
    vi.useFakeTimers();
    storage.getAccessToken.mockReturnValue(tokenOf('u-1'));
    api.get.mockImplementationOnce(async () => {
      storage.getAccessToken.mockReturnValue(null);
      return { data: { data: me } };
    });

    await useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(0);

    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false, isLoading: false });
    expect(socket.connectSocket).not.toHaveBeenCalled();
  });

  it('a token renewed during /auth/me for the same account is applied as before', async () => {
    storage.getAccessToken.mockReturnValue(tokenOf('u-1'));
    api.get.mockImplementationOnce(async () => {
      storage.getAccessToken.mockReturnValue(`${tokenOf('u-1')}-renewed`);
      return { data: { data: me } };
    });

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
    expect(socket.connectSocket).toHaveBeenCalledWith(`${tokenOf('u-1')}-renewed`);
  });
});

describe('authStore — a credential change answered after a sign-out is left to its caller', () => {
  beforeEach(() => {
    session.epoch = 0;
    useAuthStore.setState({ user: me as never, isAuthenticated: true, isLoading: false });
    socket.beginCredentialChange.mockImplementation(() => socket.endCredentialChange);
  });

  afterEach(() => {
    session.epoch = 0;
  });

  it('its 401 renews nothing once the session ended meanwhile (a sign-out, a new sign-in)', async () => {
    const refused = Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: 'Session invalidated' } } });
    api.post.mockImplementationOnce(async () => {
      session.epoch = 1; // the user signed out while the change was out
      throw refused;
    });

    await expect(useAuthStore.getState().revokeOtherSessions('pw')).rejects.toBe(refused);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();

    api.post.mockImplementationOnce(async () => {
      session.epoch = 2;
      throw refused;
    });
    await expect(useAuthStore.getState().changePassword('old-pw', 'new-pw-123')).rejects.toBe(refused);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });
});
