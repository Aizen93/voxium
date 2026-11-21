import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { createHash } from 'node:crypto';
import {
  getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, reloadAfterSessionChange, createKeychainSessionStore,
  TWIN_SYNC_WAIT_MS, _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests,
} from '../../services/tokenStorage';
import {
  refreshAccessToken, goToLoginPage, SessionLostError, setSessionLostNavigation, _resetSessionForTests, _setRefreshLocksForTests,
} from '../../services/session';
import { createBrowser, type Browser, type BrowserTab, type TabLocks } from '../helpers/browserTabs';

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
let browser: Browser;

beforeEach(() => {
  browser = createBrowser();
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
  browser.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Tabs of one browser: one module copy each (helpers/browserTabs.ts) ──────
//
// Each tab has its own sessionStorage (a copy of the page's when it opens, as
// a duplicated or restored tab has), the one localStorage of the origin, and
// a `storage` event for every change another tab makes to it.

type Tab = {
  tab: BrowserTab;
  session: typeof import('../../services/session');
  storage: typeof import('../../services/tokenStorage');
  navigate: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};

async function openTab(locks: TabLocks | null, withChannel = false): Promise<Tab> {
  const tab = browser.openTab(`tab ${browser.tabs.length + 1}`);
  return tab.run(async () => {
    vi.resetModules();
    const storage = tab.bind(await import('../../services/tokenStorage'));
    const session = tab.bind(await import('../../services/session'));
    storage._resetTokenStorageForTests();
    const tabReload = vi.fn();
    storage._setPageReloadForTests(tabReload);
    storage._setSessionChannelForTests(withChannel ? browser.channel : null);
    session._resetSessionForTests();
    const tabNavigate = vi.fn();
    session.setSessionLostNavigation(tabNavigate);
    session._setRefreshLocksForTests(locks);
    await storage.hydrateTokens();
    return { tab, session, storage, navigate: tabNavigate, reload: tabReload };
  });
}

/** Each tab's module copy holds one `storage` and one `pageshow` listener, never one more (a wait for a mark removes its own). */
function expectOneListenerEach(...tabs: Tab[]): void {
  for (const { tab } of tabs) {
    expect(tab.listenerCount('storage'), tab.name).toBe(1);
    expect(tab.listenerCount('pageshow'), tab.name).toBe(1);
    expect(tab.duplicateAdds, tab.name).toBe(0);
  }
}

describe('the tabs of these tests are tabs of one browser', () => {
  it("a tab reads its own sessionStorage, never another tab's, and starts with a copy of the page's", async () => {
    const opened = expiredPair('s-1', 1);
    sessionStorage.setItem('voxium_access_token', opened.accessToken);
    sessionStorage.setItem('voxium_refresh_token', opened.refreshToken);
    const a = await openTab(null);
    sessionStorage.clear();
    const b = await openTab(null);

    expect(a.storage.getRefreshToken()).toBe(opened.refreshToken);
    expect(b.storage.getRefreshToken()).toBeNull();
    const renewed = expiredPair('s-1', 2);
    a.storage.setTokens(renewed.accessToken, renewed.refreshToken, false);
    await a.storage.flushTokenStorage();

    expect(a.tab.sessionStorage.getItem('voxium_refresh_token')).toBe(renewed.refreshToken);
    expect(b.tab.sessionStorage.getItem('voxium_refresh_token')).toBeNull();
    expect(sessionStorage.getItem('voxium_refresh_token')).toBeNull();
    expect(b.storage.followSharedSession()).toBe('followed');
    expect(b.storage.getRefreshToken()).toBeNull();
  });

  it('a change of localStorage reaches every OTHER tab as a `storage` event, never the tab that made it', async () => {
    vi.useFakeTimers();
    const a = await openTab(null);
    const b = await openTab(null);
    const heardByA = vi.fn();
    const heardByB = vi.fn();
    a.tab.run(() => window.addEventListener('storage', heardByA));
    b.tab.run(() => window.addEventListener('storage', heardByB));

    const remembered = expiredPair('s-1', 1);
    a.storage.setTokens(remembered.accessToken, remembered.refreshToken, true);
    await a.storage.flushTokenStorage();
    await vi.advanceTimersByTimeAsync(0);

    expect(heardByA).not.toHaveBeenCalled();
    expect(heardByB).toHaveBeenCalled();
    expect(b.storage.getRefreshToken()).toBe(remembered.refreshToken);
    a.tab.run(() => window.removeEventListener('storage', heardByA));
    b.tab.run(() => window.removeEventListener('storage', heardByB));
    expectOneListenerEach(a, b);
  });
});

describe('a not-remembered tab restored with an old copy of its session renews with the newest refresh token', () => {
  const pairAt = (gen: number, expired: boolean) => ({
    accessToken: jwt({ userId: 'user-x', sid: 's-1', exp: expired ? nowSeconds() - 60 : nowSeconds() + 900, n: gen }),
    refreshToken: jwt({ userId: 'user-x', sid: 's-1', gen }),
  });
  const sentRefreshTokens = () => post.mock.calls.map((call: unknown[]) => (call[1] as { refreshToken: string }).refreshToken);

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('its twin, still open at a later generation, answers: the restored tab sends that generation, never its own', async () => {
    // the twin, still open: it renewed to generation 3 since the other tab was closed
    const current = pairAt(3, true);
    sessionStorage.setItem('voxium_access_token', current.accessToken);
    sessionStorage.setItem('voxium_refresh_token', current.refreshToken);
    const twin = await openTab(null, true);
    // the restored tab (Ctrl+Shift+T restores its sessionStorage): generation 1
    const stale = pairAt(1, true);
    sessionStorage.setItem('voxium_access_token', stale.accessToken);
    sessionStorage.setItem('voxium_refresh_token', stale.refreshToken);
    const restored = await openTab(null, true);
    expect(restored.storage.getRefreshToken()).toBe(stale.refreshToken);
    post.mockResolvedValueOnce({ data: { data: pairAt(4, false) } });

    const renewal = restored.session.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS);
    await renewal;

    expect(sentRefreshTokens()).toEqual([current.refreshToken]);
    expect(twin.navigate).not.toHaveBeenCalled();
    expectOneListenerEach(twin, restored);
  });

  it('a twin whose access token is still fresh: its pair is the answer and nothing is sent', async () => {
    const current = pairAt(3, false);
    sessionStorage.setItem('voxium_access_token', current.accessToken);
    sessionStorage.setItem('voxium_refresh_token', current.refreshToken);
    await openTab(null, true);
    const stale = pairAt(1, true);
    sessionStorage.setItem('voxium_access_token', stale.accessToken);
    sessionStorage.setItem('voxium_refresh_token', stale.refreshToken);
    const restored = await openTab(null, true);

    const renewal = restored.session.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS);

    await expect(renewal).resolves.toBe(current.accessToken);
    expect(post).not.toHaveBeenCalled();
  });

  it('twins at different generations both answer: the restored tab sends the newest, not the first to answer', async () => {
    // the twin at generation 3 opened first: it answers first; the one at 5 answers after it
    const twins: Tab[] = [];
    for (const gen of [3, 5]) {
      const held = pairAt(gen, true);
      sessionStorage.setItem('voxium_access_token', held.accessToken);
      sessionStorage.setItem('voxium_refresh_token', held.refreshToken);
      twins.push(await openTab(null, true));
    }
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS);
    expect(twins[0].storage.getRefreshToken()).toBe(pairAt(3, true).refreshToken);
    const stale = pairAt(1, true);
    sessionStorage.setItem('voxium_access_token', stale.accessToken);
    sessionStorage.setItem('voxium_refresh_token', stale.refreshToken);
    const restored = await openTab(null, true);
    post.mockResolvedValueOnce({ data: { data: pairAt(6, false) } });

    const renewal = restored.session.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS);
    await renewal;

    expect(sentRefreshTokens()).toEqual([pairAt(5, true).refreshToken]);
    expectOneListenerEach(...twins, restored);
  });

  it('with no twin alive nothing answers: after the wait the tab sends what it holds', async () => {
    const stale = pairAt(1, true);
    sessionStorage.setItem('voxium_access_token', stale.accessToken);
    sessionStorage.setItem('voxium_refresh_token', stale.refreshToken);
    const alone = await openTab(null, true);
    post.mockResolvedValueOnce({ data: { data: pairAt(2, false) } });

    const renewal = alone.session.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS - 1);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await renewal;

    expect(sentRefreshTokens()).toEqual([stale.refreshToken]);
  });
});

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
    const locks = browser.locks();
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
    expectOneListenerEach(tabA, tabB);
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
    expectOneListenerEach(tabA, tabB);
  });

  it('a tab of another account does not wait for the change: its renewal goes out at once', async () => {
    // tab X (user-x) and tab Y (user-y), each with its own not-remembered session
    sessionStorage.setItem('voxium_access_token', a1());
    sessionStorage.setItem('voxium_refresh_token', r1());
    const tabX = await openTab(null);
    const y = expiredPair('s-y', 1, 'user-y');
    sessionStorage.setItem('voxium_access_token', y.accessToken);
    sessionStorage.setItem('voxium_refresh_token', y.refreshToken);
    const tabY = await openTab(null);
    const x2 = answer();
    const change = tabX.session.runCredentialChange(async (stillCurrent) => {
      await new Promise((r) => setTimeout(r, 45_000));
      if (stillCurrent()) tabX.storage.setTokens(x2.accessToken, x2.refreshToken);
      return 'changed';
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(localStorage.getItem('voxium_credential_change')).not.toBeNull();
    const renewedY = { accessToken: jwt({ userId: 'user-y', sid: 's-y', exp: exp() }), refreshToken: jwt({ userId: 'user-y', sid: 's-y', gen: 2 }) };
    post.mockResolvedValueOnce({ data: { data: renewedY } });

    const renewal = tabY.session.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    await expect(renewal).resolves.toBe(renewedY.accessToken);

    await vi.advanceTimersByTimeAsync(45_000);
    await change;
    expect(localStorage.getItem('voxium_credential_change')).toBeNull();
    expectOneListenerEach(tabX, tabY);
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
    expectOneListenerEach(tabA, tabB);
  });

  it('twins of a not-remembered session: the one refused under the mark asks before it gives up, and takes the change\'s pair arriving after the mark went', async () => {
    // the channel is slower than the storage event that tells of the mark's removal
    browser.dispose();
    browser = createBrowser({ channelDelayMs: 200 });
    const oldRefresh = r1();
    sessionStorage.setItem('voxium_access_token', jwt({ userId: 'user-x', sid: 's-1', exp: nowSeconds() - 60, v: 1 }));
    sessionStorage.setItem('voxium_refresh_token', oldRefresh);
    const tabA = await openTab(null, true);
    const tabB = await openTab(null, true);
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS * 2); // the questions they asked at load, unanswered
    // tab A's access token is fresh: its change goes out without an inline renewal
    tabA.storage.setTokens(a1(), oldRefresh);
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS);
    const state = { committed: false };
    // tab B's request is out from now and refused at 3 s, after tab A's change committed
    post.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(refused()), 3_000)));
    const renewal = tabB.session.refreshAccessToken().then((token) => ({ token }), (err: Error) => ({ err: err.name }));
    await vi.advanceTimersByTimeAsync(500);
    const x2 = answer();
    const change = tabA.session.runCredentialChange(async (stillCurrent) => {
      setTimeout(() => { state.committed = true; }, 1_000);
      await new Promise((r) => setTimeout(r, 10_000));
      if (stillCurrent()) tabA.storage.setTokens(x2.accessToken, x2.refreshToken);
      return 'changed';
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await change;

    expect(await renewal).toEqual({ token: x2.accessToken });
    expect(tabB.storage.getRefreshToken()).toBe(x2.refreshToken);
    expect(tabB.tab.sessionStorage.getItem('voxium_refresh_token')).toBe(x2.refreshToken);
    expect(tabB.navigate).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expectOneListenerEach(tabA, tabB);
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

describe('a lost answer is recovered within the grace window, whatever mark another tab left', () => {
  const noAnswer = () => Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
  /** A mark as tokenStorage writes it, computed here: T and the first 12 hex digits of SHA-256('voxium-credential-change:' + id). */
  const markOf = (until: number, userId: string) => `${until}:${createHash('sha256').update(`voxium-credential-change:${userId}`).digest('hex').slice(0, 12)}`;

  it('a mark of this account written while the background renewals run (its tab then closed) holds none of them past 120 s', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    localStorage.setItem('voxium_access_token', jwt({ userId: 'u', sid: 's', exp: nowSeconds() - 60 }));
    localStorage.setItem('voxium_refresh_token', jwt({ userId: 'u', sid: 's', gen: 1 }));
    await hydrateTokens();
    const sentAt: number[] = [];
    // the server rotates at the first request; its answer, and the prompt retry's, never arrive
    post.mockImplementation(() => {
      sentAt.push(Date.now() - t0);
      if (sentAt.length <= 2) return new Promise((_resolve, reject) => setTimeout(() => reject(noAnswer()), 15_000));
      return Promise.resolve({ data: { data: { accessToken: jwt({ userId: 'u', sid: 's', exp: nowSeconds() + 900 }), refreshToken: jwt({ userId: 'u', sid: 's', gen: 3 }) } } });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    void refreshAccessToken().catch(() => {});

    await vi.advanceTimersByTimeAsync(44_000);
    // another tab of the account starts a password change here, and is closed before it settles
    localStorage.setItem('voxium_credential_change', markOf(Date.now() + 80_000, 'u'));
    await vi.advanceTimersByTimeAsync(200_000);

    expect(sentAt).toHaveLength(3);
    for (const at of sentAt) expect(at).toBeLessThan(120_000);
    expect(sentAt[2]).toBe(45_000);
    expect(getRefreshToken()).toBe(jwt({ userId: 'u', sid: 's', gen: 3 }));
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
