import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';

// The auth store over the REAL session storage, renewal and sign-out queue
// (only the socket, the voice store and the network are stand-ins): what
// another tab of the same browser writes is in the page's storage, as it is
// in a browser.

const socket = vi.hoisted(() => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
  reconnectSocketAfterCredentialChange: vi.fn(),
  beginCredentialChange: vi.fn(() => () => {}),
}));
vi.mock('../../services/socket', () => ({
  ...socket,
  getSocket: vi.fn(() => null),
  getSocketGeneration: vi.fn(() => 0),
  onSocketReady: vi.fn(),
  onSocketReconnect: vi.fn(() => () => {}),
  onConnectionStatusChange: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => 'connected'),
}));
vi.mock('../../stores/resetStores', () => ({ resetAccountStores: vi.fn() }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => ({ activeChannelId: null, dmCallConversationId: null }) } }));
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { api } from '../../services/api';
import { useAuthStore, _resetSessionRestoreForTests } from '../../stores/authStore';
import {
  getAccessToken, getRefreshToken, setTokens, flushTokenStorage, hydrateTokens,
  _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests, type SessionChannel,
} from '../../services/tokenStorage';
import { _resetSessionForTests, setSessionLostNavigation, _setRefreshLocksForTests } from '../../services/session';
import { _resetSessionRevocationForTests } from '../../services/sessionRevocation';

const ACCESS = 'voxium_access_token';
const REFRESH = 'voxium_refresh_token';

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
const exp = () => Math.floor(Date.now() / 1000) + 900;
/** A pair of session `sid` of `userId`, its access token fresh. */
function pairOf(userId: string, sid: string, gen = 1) {
  return { accessToken: jwt({ userId, sid, exp: exp(), n: gen }), refreshToken: jwt({ userId, sid, gen }) };
}
/** Another tab of this browser stores a remembered pair (or removes it), and this tab hears of it. */
function otherTabStores(p: { accessToken: string; refreshToken: string } | null): void {
  if (p) {
    localStorage.setItem(ACCESS, p.accessToken);
    localStorage.setItem(REFRESH, p.refreshToken);
  } else {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  }
  window.dispatchEvent(new StorageEvent('storage', { key: REFRESH, storageArea: localStorage }));
}
const userOf = (id: string) => ({ id, username: id, emailVerified: true, consentRequired: false });

/** What the server answers, per request (the api's own adapter, so its interceptors run for real). */
type Answer = (config: InternalAxiosRequestConfig) => Promise<unknown>;
let answers: Answer[] = [];
const requests: Array<{ url: string; bearer: string | null }> = [];
function ok(config: InternalAxiosRequestConfig, data: unknown) {
  return { data, status: 200, statusText: 'OK', headers: {}, config };
}

const reload = vi.fn();
const navigate = vi.fn();
const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
let posted: unknown[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  _resetSessionForTests();
  _resetSessionRestoreForTests();
  _resetSessionRevocationForTests();
  _setPageReloadForTests(reload);
  setSessionLostNavigation(navigate);
  _setRefreshLocksForTests(null);
  posted = [];
  _setSessionChannelForTests(() => ({ postMessage: (m: unknown) => void posted.push(m), onmessage: null, close: () => {} }) as SessionChannel);
  reload.mockClear();
  navigate.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  answers = [];
  requests.length = 0;
  api.defaults.adapter = async (config) => {
    const header = config.headers.Authorization;
    requests.push({ url: config.url ?? '', bearer: typeof header === 'string' ? header.slice('Bearer '.length) : null });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${config.url}`);
    return next(config) as never;
  };
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, pendingRegistration: null });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  _resetSessionRevocationForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The refresh tokens the sign-out queue sent to the server. */
function signedOutOnServer(): string[] {
  return fetchMock.mock.calls.map((call) => (JSON.parse((call as unknown as [string, { body: string }])[1].body) as { refreshToken: string }).refreshToken);
}

describe('a sign-out with no session of its own to end ends nothing else', () => {
  it('while the page reloads onto another account\'s session: nothing stored is touched, nothing is sent, no twin is told', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
    const y = pairOf('user-y', 's-y');
    otherTabStores(y);
    expect(getRefreshToken()).toBeNull();

    expect(useAuthStore.getState().logout()).toBe('replaced');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(localStorage.getItem(ACCESS)).toBe(y.accessToken);
    expect(signedOutOnServer()).toEqual([]);
    expect(posted).toEqual([]);
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('while the page reloads with the memory still holding the session it is leaving for: that session is not signed out, sent or announced', async () => {
    // the REST client found another account's token stored and asked for the reload (api.ts)
    const y = pairOf('user-y', 's-y');
    setTokens(y.accessToken, y.refreshToken, true);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
    const { reloadAfterSessionChange } = await import('../../services/tokenStorage');
    reloadAfterSessionChange();

    expect(useAuthStore.getState().logout()).toBe('replaced');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(signedOutOnServer()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('a session check made with no session (the vault gate\'s) ends nothing, even when the memory took up a pair meanwhile', async () => {
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
    // another tab signed in to the same account while the check was out: this tab followed it
    const again = pairOf('user-x', 's-x2');
    otherTabStores(again);
    expect(getRefreshToken()).toBe(again.refreshToken);

    expect(useAuthStore.getState().logout({ tellServer: false, endingSession: null })).toBe('cleared');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(again.refreshToken);
    expect(getAccessToken()).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('a Sign out with nothing held touches no storage another tab wrote since, and sends nothing', async () => {
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
    await hydrateTokens();
    // a pair another tab stored, whose event has not reached this tab
    const other = pairOf('user-x', 's-other');
    localStorage.setItem(ACCESS, other.accessToken);
    localStorage.setItem(REFRESH, other.refreshToken);

    expect(useAuthStore.getState().logout()).toBe('cleared');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(other.refreshToken);
    expect(signedOutOnServer()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('a tab holding only an access token ends that session: cleared, and its twins told by the access token\'s sid', async () => {
    // an access token alone serves until it expires
    const x = pairOf('user-x', 's-x');
    sessionStorage.setItem(ACCESS, x.accessToken);
    await hydrateTokens();
    expect(getRefreshToken()).toBeNull();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });

    expect(useAuthStore.getState().logout()).toBe('cleared');

    expect(sessionStorage.getItem(ACCESS)).toBeNull();
    expect(posted).toEqual([{ type: 'ended', sid: 's-x' }]);
    // no refresh token held: nothing to send the server
    expect(signedOutOnServer()).toEqual([]);
  });
});

describe('the sign-out queue sends what the auth store hands it', () => {
  it('a Sign out of a held session sends its refresh token once, with a keepalive fetch', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });

    expect(useAuthStore.getState().logout()).toBe('cleared');

    expect(signedOutOnServer()).toEqual([x.refreshToken]);
    expect(requests).toEqual([]);
  });
});

describe('a refused restore that finds another session stored restores that session', () => {
  const refused = (status: number) => (config: InternalAxiosRequestConfig) =>
    Promise.reject(Object.assign(new Error(String(status)), { isAxiosError: true, config, response: { status, data: {}, headers: {}, config } }));

  it('another tab signed in while /auth/me was out: this tab takes up its pair and signs in as that account, no sign-in page', async () => {
    const x = pairOf('user-x', 's-x');
    localStorage.setItem(ACCESS, x.accessToken);
    localStorage.setItem(REFRESH, x.refreshToken);
    const y = pairOf('user-y', 's-y');
    useAuthStore.setState({ isLoading: true });
    answers = [
      (config) => {
        // the other tab's sign-in, heard while the refused request was out
        otherTabStores(y);
        return refused(403)(config);
      },
      async (config) => ok(config, { data: userOf('user-y') }),
    ];

    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(useAuthStore.getState().user).toMatchObject({ id: 'user-y' }));

    expect(requests.map((r) => r.bearer)).toEqual([x.accessToken, y.accessToken]);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false });
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(getRefreshToken()).toBe(y.refreshToken);
    expect(socket.connectSocket).toHaveBeenCalledWith(y.accessToken);
    expect(reload).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('... also when this tab never heard of that sign-in (it was frozen): the refusal\'s clear finds it', async () => {
    const x = pairOf('user-x', 's-x');
    localStorage.setItem(ACCESS, x.accessToken);
    localStorage.setItem(REFRESH, x.refreshToken);
    const y = pairOf('user-x', 's-x-again');
    useAuthStore.setState({ isLoading: true });
    answers = [
      (config) => {
        // a 403 (the session's account was banned): no renewal is tried for it
        localStorage.setItem(ACCESS, y.accessToken);
        localStorage.setItem(REFRESH, y.refreshToken);
        return refused(403)(config);
      },
      async (config) => ok(config, { data: userOf('user-x') }),
    ];

    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));

    expect(requests.map((r) => r.bearer)).toEqual([x.accessToken, y.accessToken]);
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(reload).not.toHaveBeenCalled();
  });

  it('the page shows an account and the session stored in place of its refused one is another account\'s: the page reloads onto it', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true, isLoading: false });
    const y = pairOf('user-y', 's-y');
    answers = [
      (config) => {
        localStorage.setItem(ACCESS, y.accessToken);
        localStorage.setItem(REFRESH, y.refreshToken);
        return refused(403)(config);
      },
    ];

    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(requests).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('a credential change stores its answer only for the session it was made in', () => {
  const x = pairOf('user-x', 's-x', 1);
  /** The answer: this session re-keyed to the account's new version, at a new generation. */
  const answer = pairOf('user-x', 's-x', 3);

  beforeEach(async () => {
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
  });

  it('another tab signs in as another account while the password change is out: its pair stands, nothing is stored, the page reloads onto it', async () => {
    const y = pairOf('user-y', 's-y');
    answers = [async (config) => {
      otherTabStores(y);
      return ok(config, { success: true, message: 'changed', data: answer });
    }];

    await useAuthStore.getState().changePassword('old-pw', 'new-pw');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(getRefreshToken()).not.toBe(answer.refreshToken);
    expect(socket.reconnectSocketAfterCredentialChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('another tab signs out while the change is out: the session is not put back', async () => {
    answers = [async (config) => {
      otherTabStores(null);
      return ok(config, { success: true, message: 'changed', data: answer });
    }];

    await useAuthStore.getState().changePassword('old-pw', 'new-pw');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(socket.reconnectSocketAfterCredentialChange).not.toHaveBeenCalled();
  });

  it('another tab renewed the SAME session while the change was out: the answer, of the new version, is stored', async () => {
    answers = [async (config) => {
      // a renewal that went out before the change, from a tab without the lock: same session, old version
      otherTabStores(pairOf('user-x', 's-x', 2));
      return ok(config, { success: true, message: 'changed', data: answer });
    }];

    await useAuthStore.getState().changePassword('old-pw', 'new-pw');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(answer.refreshToken);
    expect(socket.reconnectSocketAfterCredentialChange).toHaveBeenCalledWith(answer.accessToken);
  });

  it('signing out of the other sessions: the trusted-device token of a dropped answer is neither stored nor cleared', async () => {
    const { setTrustedDeviceToken, getTrustedDeviceToken } = await import('../../services/tokenStorage');
    setTrustedDeviceToken('trusted-old');
    await flushTokenStorage();
    answers = [async (config) => {
      otherTabStores(pairOf('user-y', 's-y'));
      return ok(config, { success: true, data: { revoked: 2, ...answer, trustedDeviceToken: 'trusted-new' } });
    }];

    await expect(useAuthStore.getState().revokeOtherSessions('pw')).resolves.toEqual({ revoked: 2 });

    await flushTokenStorage();
    expect(getTrustedDeviceToken()).toBe('trusted-old');
    expect(localStorage.getItem('voxium_trusted_device')).toBe('trusted-old');
  });

  it('signing out of the other sessions with a stored answer stores its trusted-device token with it', async () => {
    const { setTrustedDeviceToken, getTrustedDeviceToken } = await import('../../services/tokenStorage');
    setTrustedDeviceToken('trusted-old');
    await flushTokenStorage();
    answers = [async (config) => ok(config, { success: true, data: { revoked: 1, ...answer, trustedDeviceToken: 'trusted-new' } })];

    await useAuthStore.getState().revokeOtherSessions('pw');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(answer.refreshToken);
    expect(getTrustedDeviceToken()).toBe('trusted-new');
  });

  it('a session from before sessions: the answer, which opens a session of its own, is stored with its trusted-device token', async () => {
    const legacy = { accessToken: jwt({ userId: 'user-x', exp: exp() }), refreshToken: jwt({ userId: 'user-x' }) };
    setTokens(legacy.accessToken, legacy.refreshToken, true);
    await flushTokenStorage();
    const opened = pairOf('user-x', 's-new', 0);
    answers = [async (config) => ok(config, { success: true, data: { revoked: 1, ...opened, trustedDeviceToken: 'trusted-new' } })];
    const { getTrustedDeviceToken } = await import('../../services/tokenStorage');

    await useAuthStore.getState().revokeOtherSessions('pw');

    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(opened.refreshToken);
    expect(getTrustedDeviceToken()).toBe('trusted-new');
  });
});

describe('a not-remembered tab that follows another tab\'s remembered sign-in ends the session it held', () => {
  it('its own session goes from its sessionStorage and the server is told to end it', async () => {
    const own = pairOf('user-x', 's-own');
    setTokens(own.accessToken, own.refreshToken, false);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
    const remembered = pairOf('user-x', 's-remembered');

    otherTabStores(remembered);

    expect(getRefreshToken()).toBe(remembered.refreshToken);
    expect(sessionStorage.getItem(REFRESH)).toBeNull();
    expect(signedOutOnServer()).toEqual([own.refreshToken]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('the end of the session it let go of, which the server tells its socket, is no end of the session it holds now', async () => {
    const own = pairOf('user-x', 's-own');
    setTokens(own.accessToken, own.refreshToken, false);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });
    const remembered = pairOf('user-x', 's-remembered');
    const { holdsAnotherSessionOf } = await import('../../services/tokenStorage');
    expect(holdsAnotherSessionOf(own.accessToken)).toBe(false);

    otherTabStores(remembered);

    // the socket was admitted with the session let go of
    expect(holdsAnotherSessionOf(own.accessToken)).toBe(true);
    // ... never with the session held, another account's, or a token that names no session
    expect(holdsAnotherSessionOf(remembered.accessToken)).toBe(false);
    expect(holdsAnotherSessionOf(pairOf('user-y', 's-y').accessToken)).toBe(false);
    expect(holdsAnotherSessionOf(jwt({ userId: 'user-x', exp: exp() }))).toBe(false);
    expect(holdsAnotherSessionOf(null)).toBe(false);
  });

  it('... also when it reloads onto another account\'s remembered session instead', async () => {
    const own = pairOf('user-x', 's-own');
    setTokens(own.accessToken, own.refreshToken, false);
    await flushTokenStorage();
    useAuthStore.setState({ user: userOf('user-x') as never, isAuthenticated: true });

    otherTabStores(pairOf('user-y', 's-y'));

    expect(getRefreshToken()).toBeNull();
    expect(sessionStorage.getItem(REFRESH)).toBeNull();
    expect(signedOutOnServer()).toEqual([own.refreshToken]);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('nothing is ended when the remembered pair is of its own session, or when its pair names no session', async () => {
    const own = pairOf('user-x', 's-own', 1);
    setTokens(own.accessToken, own.refreshToken, false);
    await flushTokenStorage();
    otherTabStores(pairOf('user-x', 's-own', 2));
    expect(signedOutOnServer()).toEqual([]);

    _resetTokenStorageForTests();
    _setPageReloadForTests(reload);
    sessionStorage.clear();
    localStorage.clear();
    setTokens(jwt({ userId: 'user-x', exp: exp() }), jwt({ userId: 'user-x' }), false);
    await flushTokenStorage();
    otherTabStores(pairOf('user-x', 's-other'));
    expect(signedOutOnServer()).toEqual([]);
  });

  it('a remembered tab following another remembered sign-in ends nothing (the pair it held was the shared one)', async () => {
    const before = pairOf('user-x', 's-1');
    setTokens(before.accessToken, before.refreshToken, true);
    await flushTokenStorage();

    otherTabStores(pairOf('user-x', 's-2'));

    expect(signedOutOnServer()).toEqual([]);
  });
});
