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

// Keeps the helpers above in use for the describes later steps add here
void ok;
