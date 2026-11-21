import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAccessToken, getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, followSharedSession,
  clearSessionTokens, reloadAfterSessionChange, createKeychainSessionStore, isTokenOfAnotherAccount,
  _resetTokenStorageForTests, _setPageReloadForTests,
} from '../../services/tokenStorage';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { beginAccountDeletion } from '../../services/accountDeletion';

// The browser build keeps ONE session per browser: every tab reads and writes
// the same page storage, and a tab's memory follows the others. Rotation makes
// two old gaps matter: a tab following another tab's sign-in kept showing its
// own account while holding the other one's tokens, and a tab ending its
// session (a deletion, the server's word) wiped whatever another tab had
// stored since, often a brand-new session.

const ACCESS = 'voxium_access_token';
const REFRESH = 'voxium_refresh_token';

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
/** A pair of session `sid` of user `userId`, at generation `gen`. */
function pairOf(userId: string, sid: string, gen = 1) {
  return { accessToken: jwt({ userId, sid, n: gen }), refreshToken: jwt({ userId, sid, gen }) };
}
function otherTabStores(p: { accessToken: string; refreshToken: string }): void {
  localStorage.setItem(ACCESS, p.accessToken);
  localStorage.setItem(REFRESH, p.refreshToken);
  window.dispatchEvent(new StorageEvent('storage', { key: REFRESH, newValue: p.refreshToken, storageArea: localStorage }));
}

const reload = vi.fn();
let signedIn: string | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  _setPageReloadForTests(reload);
  reload.mockClear();
  signedIn = null;
  registerE2ESessionUser(() => signedIn);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  registerE2ESessionUser(null);
  vi.restoreAllMocks();
});

describe('a tab never shows one account while holding another account\'s tokens', () => {
  it("another tab's sign-in to ANOTHER account: the memory lets go of it and the page reloads onto it, after the queued writes", async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    signedIn = 'user-x';

    otherTabStores(pairOf('user-y', 's-y'));

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // what the other tab stored is left as it is
    expect(localStorage.getItem(REFRESH)).toBe(pairOf('user-y', 's-y').refreshToken);
  });

  it('the same account (a second sign-in, a renewal) is followed as before, without a reload', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    signedIn = 'user-x';

    const again = pairOf('user-x', 's-x2');
    otherTabStores(again);

    expect(getRefreshToken()).toBe(again.refreshToken);
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });

  it('nobody signed in on this page, or a pair that cannot be decoded: followed, never reloaded (no reload loop)', async () => {
    await hydrateTokens();
    otherTabStores(pairOf('user-y', 's-y'));
    expect(getRefreshToken()).toBe(pairOf('user-y', 's-y').refreshToken);

    signedIn = 'user-x';
    otherTabStores({ accessToken: 'opaque-a', refreshToken: 'opaque-r' });
    expect(getRefreshToken()).toBe('opaque-r');
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });

  it('the re-read before a refresh applies the same rule, and stops the renewal (it answers reloading)', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    signedIn = 'user-x';
    // the event was missed (a frozen tab)
    const y = pairOf('user-y', 's-y');
    localStorage.setItem(ACCESS, y.accessToken);
    localStorage.setItem(REFRESH, y.refreshToken);

    expect(followSharedSession()).toBe('reloading');
    expect(getRefreshToken()).toBeNull();
    expect(followSharedSession()).toBe('reloading');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('while a reload is pending the re-read follows nothing and answers reloading, in the desktop app too', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    reloadAfterSessionChange();
    localStorage.setItem(ACCESS, pairOf('user-x', 's-x', 2).accessToken);
    localStorage.setItem(REFRESH, pairOf('user-x', 's-x', 2).refreshToken);
    expect(followSharedSession()).toBe('reloading');
    expect(getRefreshToken()).toBe(x.refreshToken);

    const invoke = async <T>(): Promise<T> => null as T;
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    _setPageReloadForTests(reload);
    await hydrateTokens();
    setTokens(x.accessToken, x.refreshToken, true);
    expect(followSharedSession()).toBe('followed');
    reloadAfterSessionChange();
    expect(followSharedSession()).toBe('reloading');
  });

  it('the reload waits for an account deletion of this client in flight to finish its clean-up', async () => {
    const endDeletion = beginAccountDeletion();
    reloadAfterSessionChange();
    reloadAfterSessionChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();
    endDeletion();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('ending a session clears only that session', () => {
  it('the stored pair is still of the ended session (any generation): cleared, as clearTokens does', async () => {
    const x = pairOf('user-x', 's-x', 3);
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();

    // the token this tab held may be an older generation of the same session
    expect(clearSessionTokens(pairOf('user-x', 's-x', 2).refreshToken)).toBe('cleared');

    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBeNull();
  });

  it('another tab stored a DIFFERENT session meanwhile: kept, the memory lets go, "replaced"', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    const y = pairOf('user-y', 's-y');
    localStorage.setItem(ACCESS, y.accessToken);
    localStorage.setItem(REFRESH, y.refreshToken);

    expect(clearSessionTokens(x.refreshToken)).toBe('replaced');
    await flushTokenStorage();

    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(reload).not.toHaveBeenCalled(); // the caller decides
  });

  it("a not-remembered tab's copy of the ended session goes, the remembered session of another tab stays", async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, false);
    await flushTokenStorage();
    const y = pairOf('user-x', 's-y');
    localStorage.setItem(ACCESS, y.accessToken);
    localStorage.setItem(REFRESH, y.refreshToken);

    expect(clearSessionTokens(x.accessToken)).toBe('replaced');
    await flushTokenStorage();

    expect(sessionStorage.getItem(REFRESH)).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
  });

  it('a remembered tab does not take a pair left in its own sessionStorage for the stored session: the session it ends is cleared', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    // a pair of another session, left in this tab's sessionStorage from before it was remembered
    const orphan = pairOf('user-x', 's-orphan');
    sessionStorage.setItem(ACCESS, orphan.accessToken);
    sessionStorage.setItem(REFRESH, orphan.refreshToken);
    // another tab signed out; the event did not reach this one (it was frozen)
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);

    expect(clearSessionTokens(x.refreshToken)).toBe('cleared');
    expect(getRefreshToken()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a write of the ended session still queued is removed after it lands', async () => {
    await hydrateTokens();
    const y = pairOf('user-y', 's-y');
    localStorage.setItem(ACCESS, y.accessToken);
    localStorage.setItem(REFRESH, y.refreshToken);
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, false); // queued

    expect(clearSessionTokens(x.refreshToken)).toBe('replaced');
    await flushTokenStorage();

    expect(sessionStorage.getItem(REFRESH)).toBeNull();
  });

  it('nothing to compare with (null), or nothing stored: cleared', async () => {
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();
    expect(clearSessionTokens(null)).toBe('cleared');
    expect(localStorage.getItem(REFRESH)).toBeNull();
    expect(clearSessionTokens(x.refreshToken)).toBe('cleared');
  });

  it('a token naming no session matches by string only: a pair it cannot be told apart from is kept', async () => {
    setTokens('a-legacy', 'r-legacy', true);
    await flushTokenStorage();
    expect(clearSessionTokens('r-other-legacy')).toBe('replaced');
    expect(localStorage.getItem(REFRESH)).toBe('r-legacy');
    expect(clearSessionTokens('r-legacy')).toBe('cleared');
  });

  it('a ban or a deletion seen by a socket admitted before sessions ends the account\'s stored pair, the session that token became', async () => {
    const renewed = pairOf('user-x', 's-x', 2);
    setTokens(renewed.accessToken, renewed.refreshToken, true);
    await flushTokenStorage();
    // the socket's handshake token: an access token issued before sessions (no sid)
    const handshake = jwt({ userId: 'user-x', exp: 10 });

    // one session ended: such a token cannot be told to be this one, the pair is kept
    expect(clearSessionTokens(handshake)).toBe('replaced');
    expect(localStorage.getItem(REFRESH)).toBe(renewed.refreshToken);

    setTokens(renewed.accessToken, renewed.refreshToken, true);
    await flushTokenStorage();
    expect(clearSessionTokens(handshake, { accountWide: true })).toBe('cleared');
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBeNull();
  });

  it('... never another account\'s pair; the ended account\'s copy in this tab\'s own storage goes', async () => {
    const y = pairOf('user-y', 's-y');
    setTokens(y.accessToken, y.refreshToken, true);
    await flushTokenStorage();
    // this tab's not-remembered copy of the ended account's session, left in its sessionStorage
    const x = pairOf('user-x', 's-x', 2);
    sessionStorage.setItem(ACCESS, x.accessToken);
    sessionStorage.setItem(REFRESH, x.refreshToken);

    expect(clearSessionTokens(jwt({ userId: 'user-x', exp: 10 }), { accountWide: true })).toBe('replaced');
    await flushTokenStorage();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
    expect(sessionStorage.getItem(REFRESH)).toBeNull();
  });

  it('the desktop app compares with the memory, its one store', async () => {
    const entries = new Map<string, string>();
    const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      const name = args?.name as string;
      if (cmd === 'session_secret_get') return (entries.get(name) ?? null) as T;
      if (cmd === 'session_secret_set') entries.set(name, args?.value as string);
      if (cmd === 'session_secret_delete') entries.delete(name);
      return undefined as T;
    };
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    await hydrateTokens();
    const x = pairOf('user-x', 's-x');
    setTokens(x.accessToken, x.refreshToken, true);
    await flushTokenStorage();

    expect(clearSessionTokens(pairOf('user-x', 's-other').refreshToken)).toBe('replaced');
    setTokens(x.accessToken, x.refreshToken, true);
    expect(clearSessionTokens(x.accessToken)).toBe('cleared');
    await flushTokenStorage();
    expect(entries.has('tokens')).toBe(false);
  });
});

describe('isTokenOfAnotherAccount — the rule the REST client applies to one token', () => {
  it('true only for a decodable token of another account than the one shown', () => {
    expect(isTokenOfAnotherAccount(pairOf('user-y', 's-y').accessToken)).toBe(false); // nobody shown
    signedIn = 'user-x';
    expect(isTokenOfAnotherAccount(pairOf('user-y', 's-y').accessToken)).toBe(true);
    expect(isTokenOfAnotherAccount(pairOf('user-x', 's-x').accessToken)).toBe(false);
    expect(isTokenOfAnotherAccount('opaque')).toBe(false);
    expect(isTokenOfAnotherAccount(null)).toBe(false);
  });
});
