import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, reloadAfterSessionChange, createKeychainSessionStore,
  _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests,
} from '../../services/tokenStorage';
import {
  refreshAccessToken, goToLoginPage, SessionLostError, setSessionLostNavigation, _resetSessionForTests, _setRefreshLocksForTests,
} from '../../services/session';

// The renewal (services/session.ts) over the REAL session storage
// (services/tokenStorage.ts): what one decides, the other must honour.

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A pair of session `sid` at generation `gen`, its access token expired (a renewal must send something). */
function expiredPair(sid: string, gen: number, userId = 'user-x') {
  return { accessToken: jwt({ userId, sid, exp: nowSeconds() - 60, n: gen }), refreshToken: jwt({ userId, sid, gen }) };
}

const reload = vi.fn();
const navigate = vi.fn();
let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  _resetSessionForTests();
  _setPageReloadForTests(reload);
  setSessionLostNavigation(navigate);
  _setRefreshLocksForTests(null);
  _setSessionChannelForTests(null);
  reload.mockClear();
  navigate.mockClear();
  post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('no request expected'));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Two tabs of one browser: two module instances over one localStorage ─────

type Tab = {
  session: typeof import('../../services/session');
  storage: typeof import('../../services/tokenStorage');
  navigate: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};

async function openTab(locks: unknown): Promise<Tab> {
  vi.resetModules();
  const storage = await import('../../services/tokenStorage');
  const session = await import('../../services/session');
  storage._resetTokenStorageForTests();
  const tabReload = vi.fn();
  storage._setPageReloadForTests(tabReload);
  storage._setSessionChannelForTests(null);
  session._resetSessionForTests();
  const tabNavigate = vi.fn();
  session.setSessionLostNavigation(tabNavigate);
  session._setRefreshLocksForTests(locks as never);
  await storage.hydrateTokens();
  return { session, storage, navigate: tabNavigate, reload: tabReload };
}

/** One exclusive lock shared by the tabs: FIFO, honouring the abort signal while waiting (the Web Locks contract). */
function sharedLocks() {
  const queue: Array<() => void> = [];
  let held = false;
  return {
    request(_name: string, opts: { signal: AbortSignal }, callback: () => Promise<unknown>) {
      return new Promise((resolve, reject) => {
        const grant = () => {
          held = true;
          Promise.resolve().then(callback).then(resolve, reject).finally(() => {
            held = false;
            queue.shift()?.();
          });
        };
        opts.signal.addEventListener('abort', () => {
          const at = queue.indexOf(grant);
          if (at >= 0) {
            queue.splice(at, 1);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }
        });
        if (held) queue.push(grant);
        else grant();
      });
    },
  };
}

describe('a credential change in one tab while another tab renews', () => {
  const refused = () => Object.assign(new Error('Request failed with status code 401'), { isAxiosError: true, response: { status: 401 } });
  const exp = () => nowSeconds() + 900;
  // the session before the change (version 1) and the answer of the change (version 2)
  const r1 = () => jwt({ userId: 'user-x', sid: 's-1', gen: 1, v: 1 });
  const a1 = () => jwt({ userId: 'user-x', sid: 's-1', exp: exp(), v: 1 });
  const answer = () => ({ accessToken: jwt({ userId: 'user-x', sid: 's-1', exp: exp(), v: 2 }), refreshToken: jwt({ userId: 'user-x', sid: 's-1', gen: 2, v: 2 }) });

  /** Tab A changes the password: its request commits at 1 s, it is answered at 45 s. */
  function changeInTabA(tabA: Tab, x2: { accessToken: string; refreshToken: string }, state: { committed: boolean }) {
    return tabA.session.runCredentialChange(async (stillCurrent) => {
      setTimeout(() => { state.committed = true; }, 1_000);
      await new Promise((r) => setTimeout(r, 45_000));
      if (stillCurrent()) tabA.storage.setTokens(x2.accessToken, x2.refreshToken);
      return 'changed';
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.clear();
    sessionStorage.clear();
  });

  it('with Web Locks: the other tab, past the lock\'s bound, waits for the change and takes its pair; nothing is refused, nobody is signed out', async () => {
    const oldRefresh = r1();
    localStorage.setItem('voxium_access_token', jwt({ userId: 'user-x', sid: 's-1', exp: nowSeconds() - 60, v: 1 }));
    localStorage.setItem('voxium_refresh_token', oldRefresh);
    const locks = sharedLocks();
    const tabA = await openTab(locks);
    const tabB = await openTab(locks);
    const state = { committed: false };
    post.mockImplementation(async (_url: string, body: { refreshToken: string }) => {
      if (state.committed && body.refreshToken === oldRefresh) throw refused();
      return { data: { data: { accessToken: jwt({ userId: 'user-x', sid: 's-1', exp: exp(), v: 1, g: 2 }), refreshToken: jwt({ userId: 'user-x', sid: 's-1', gen: 2, v: 1 }) } } };
    });
    // tab A's access token is fresh: its change goes out without an inline renewal
    const x2 = answer();
    tabA.storage.setTokens(a1(), oldRefresh);
    await tabA.storage.flushTokenStorage();
    const change = changeInTabA(tabA, x2, state);
    await vi.advanceTimersByTimeAsync(2_000);

    // tab B's access token has expired: it renews, behind tab A's lock
    const renewal = tabB.session.refreshAccessToken().then((token) => ({ token }), (err: Error) => ({ err: err.name }));
    await vi.advanceTimersByTimeAsync(36_000); // past the 35 s bound: B goes on without the lock
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); // tab A is answered at 45 s
    await change;

    expect(await renewal).toEqual({ token: x2.accessToken });
    expect(post).not.toHaveBeenCalled();
    expect(tabB.navigate).not.toHaveBeenCalled();
    expect(tabA.navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('voxium_refresh_token')).toBe(x2.refreshToken);
    expect(localStorage.getItem('voxium_credential_change')).toBeNull();
  });

  it('without Web Locks (an origin served without HTTPS): the other tab\'s renewal waits for the change all the same', async () => {
    const oldRefresh = r1();
    localStorage.setItem('voxium_access_token', jwt({ userId: 'user-x', sid: 's-1', exp: nowSeconds() - 60, v: 1 }));
    localStorage.setItem('voxium_refresh_token', oldRefresh);
    const tabA = await openTab(null);
    const tabB = await openTab(null);
    const state = { committed: false };
    post.mockImplementation(async () => { throw refused(); });
    const x2 = answer();
    tabA.storage.setTokens(a1(), oldRefresh);
    await tabA.storage.flushTokenStorage();
    const change = changeInTabA(tabA, x2, state);
    await vi.advanceTimersByTimeAsync(2_000);

    const renewal = tabB.session.refreshAccessToken().then((token) => ({ token }), (err: Error) => ({ err: err.name }));
    await vi.advanceTimersByTimeAsync(44_000);
    await change;

    expect(await renewal).toEqual({ token: x2.accessToken });
    expect(post).not.toHaveBeenCalled();
    expect(tabB.navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('voxium_refresh_token')).toBe(x2.refreshToken);
  });

  it('without Web Locks, a renewal sent just before the change and refused after its commit is not final: it takes the change\'s pair', async () => {
    const oldRefresh = r1();
    localStorage.setItem('voxium_access_token', jwt({ userId: 'user-x', sid: 's-1', exp: nowSeconds() - 60, v: 1 }));
    localStorage.setItem('voxium_refresh_token', oldRefresh);
    const tabA = await openTab(null);
    const tabB = await openTab(null);
    const state = { committed: false };
    // tab B's request is out from 0 s and refused at 3 s, after tab A's change committed
    post.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(refused()), 3_000)));
    const renewal = tabB.session.refreshAccessToken().then((token) => ({ token }), (err: Error) => ({ err: err.name }));
    await vi.advanceTimersByTimeAsync(500);
    const x2 = answer();
    tabA.storage.setTokens(a1(), oldRefresh);
    await tabA.storage.flushTokenStorage();
    const change = changeInTabA(tabA, x2, state);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(tabB.navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('voxium_refresh_token')).toBe(oldRefresh);
    await vi.advanceTimersByTimeAsync(40_000);
    await change;

    expect(await renewal).toEqual({ token: x2.accessToken });
    expect(post).toHaveBeenCalledTimes(1);
    expect(tabB.navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('voxium_refresh_token')).toBe(x2.refreshToken);
  });
});

describe('one page-level navigation per page load: the first one asked for wins', () => {
  it('a reload onto another session asked for first: a trip to the sign-in page asked for after it goes nowhere', async () => {
    reloadAfterSessionChange();
    goToLoginPage('banned');
    await flushTokenStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a trip to the sign-in page asked for first: a reload asked for after it never overrides it, and its reason can still be given', async () => {
    goToLoginPage(null);
    reloadAfterSessionChange();
    goToLoginPage('session-ended');
    await flushTokenStorage();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));

    expect(navigate).toHaveBeenCalledWith('/login?reason=session-ended');
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();
  });

  it('a refusal that finds another account\'s session stored reloads onto it, and a force:logout that follows does not navigate over it', async () => {
    const mine = expiredPair('s-1', 1);
    setTokens(mine.accessToken, mine.refreshToken, true);
    await flushTokenStorage();
    post.mockImplementationOnce(async () => {
      // another tab signed in (as anyone) while the refused request was out; this tab missed the event
      const other = expiredPair('s-other', 1, 'user-y');
      localStorage.setItem('voxium_access_token', other.accessToken);
      localStorage.setItem('voxium_refresh_token', other.refreshToken);
      throw Object.assign(new Error('Request failed with status code 401'), { isAxiosError: true, response: { status: 401 } });
    });

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    goToLoginPage('banned');
    await flushTokenStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('a renewal while this page reloads onto another session sends nothing', () => {
  it('in the browser build', async () => {
    const p = expiredPair('s-1', 1);
    setTokens(p.accessToken, p.refreshToken, true);
    await flushTokenStorage();
    reloadAfterSessionChange();

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(post).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe(p.refreshToken);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('in the desktop app', async () => {
    const invoke = async <T>(): Promise<T> => null as T;
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    _setPageReloadForTests(reload);
    await hydrateTokens();
    const p = expiredPair('s-1', 1);
    setTokens(p.accessToken, p.refreshToken, true);
    await flushTokenStorage();
    reloadAfterSessionChange();

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(post).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
