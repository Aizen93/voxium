import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAccessToken, getRefreshToken, setTokens, clearTokens, isRemembered,
  getTrustedDeviceToken, setTrustedDeviceToken, clearTrustedDeviceToken,
  hydrateTokens, flushTokenStorage, createKeychainSessionStore, webSessionStore,
  TOKEN_STORAGE_FLUSH_TIMEOUT_MS, _resetTokenStorageForTests,
  type SessionStore,
} from '../../services/tokenStorage';

// Where the signed-in session lives on the device. The desktop app keeps it
// in the OS credential store through the Tauri `session_secret_*` commands
// (never again in the webview's localStorage, a plaintext file); the web
// client keeps localStorage/sessionStorage. Both sit behind one in-memory
// module with synchronous reads.

const ACCESS = 'voxium_access_token';
const REFRESH = 'voxium_refresh_token';
const TRUSTED = 'voxium_trusted_device';

/** A stand-in for the Rust commands: a Map of entries, a call log, and a switch to take the store down. */
function fakeKeychain(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const calls: Array<{ cmd: string; name: string; value?: string }> = [];
  let down = false;
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const name = args?.name as string;
    calls.push({ cmd, name, ...(args?.value !== undefined ? { value: args.value as string } : {}) });
    if (down) throw new Error('Secret Service not available');
    if (cmd === 'session_secret_get') return (entries.get(name) ?? null) as T;
    if (cmd === 'session_secret_set') {
      entries.set(name, args?.value as string);
      return undefined as T;
    }
    if (cmd === 'session_secret_delete') {
      entries.delete(name);
      return undefined as T;
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return {
    entries,
    calls,
    invoke,
    setDown(value: boolean) { down = value; },
    /** The pair the `tokens` entry holds. */
    tokens: () => (entries.has('tokens') ? JSON.parse(entries.get('tokens')!) : null),
  };
}

const pair = (access: string, refresh: string) => JSON.stringify({ accessToken: access, refreshToken: refresh });

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── The web store (the browser client) ──────────────────────────────────────

describe('tokenStorage — the web store keeps the browser semantics', () => {
  it('"remember me" writes localStorage, otherwise sessionStorage, and a renewal keeps the slot', async () => {
    setTokens('a1', 'r1', true);
    await flushTokenStorage();
    expect(localStorage.getItem(ACCESS)).toBe('a1');
    expect(localStorage.getItem(REFRESH)).toBe('r1');
    expect(sessionStorage.getItem(ACCESS)).toBeNull();
    expect(isRemembered()).toBe(true);

    setTokens('a2', 'r2'); // a renewal: no flag
    await flushTokenStorage();
    expect(localStorage.getItem(ACCESS)).toBe('a2');

    setTokens('a3', 'r3', false);
    await flushTokenStorage();
    expect(sessionStorage.getItem(ACCESS)).toBe('a3');
    expect(sessionStorage.getItem(REFRESH)).toBe('r3');
    expect(localStorage.getItem(ACCESS)).toBeNull();
    expect(isRemembered()).toBe(false);

    setTokens('a4', 'r4');
    await flushTokenStorage();
    expect(sessionStorage.getItem(ACCESS)).toBe('a4');
    expect(localStorage.getItem(ACCESS)).toBeNull();
  });

  it('reads come from memory: nothing is known before hydrateTokens(), everything after', async () => {
    localStorage.setItem(ACCESS, 'a-disk');
    localStorage.setItem(REFRESH, 'r-disk');
    localStorage.setItem(TRUSTED, 't-disk');
    expect(getAccessToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBe('a-disk');
    expect(getRefreshToken()).toBe('r-disk');
    expect(getTrustedDeviceToken()).toBe('t-disk');
    expect(isRemembered()).toBe(true);
  });

  it('a session in sessionStorage hydrates as not remembered', async () => {
    sessionStorage.setItem(ACCESS, 'a-s');
    sessionStorage.setItem(REFRESH, 'r-s');
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-s');
    expect(isRemembered()).toBe(false);
  });

  it('clearTokens empties both slots and the memory; the trusted-device token has its own key', async () => {
    setTokens('a', 'r', true);
    setTrustedDeviceToken('t1');
    await flushTokenStorage();
    expect(localStorage.getItem(TRUSTED)).toBe('t1');

    clearTokens();
    await flushTokenStorage();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(ACCESS)).toBeNull();
    expect(sessionStorage.getItem(ACCESS)).toBeNull();
    // logging out keeps the device trusted (as before)
    expect(getTrustedDeviceToken()).toBe('t1');
    expect(localStorage.getItem(TRUSTED)).toBe('t1');

    clearTrustedDeviceToken();
    await flushTokenStorage();
    expect(getTrustedDeviceToken()).toBeNull();
    expect(localStorage.getItem(TRUSTED)).toBeNull();
  });

  it('the web store is the default outside Tauri', async () => {
    // jsdom has no __TAURI_INTERNALS__: the module picked webSessionStore
    expect('__TAURI_INTERNALS__' in window).toBe(false);
    localStorage.setItem(ACCESS, 'a');
    localStorage.setItem(REFRESH, 'r');
    expect((await webSessionStore.load()).accessToken).toBe('a');
    await hydrateTokens();
    expect(getAccessToken()).toBe('a');
  });
});

// ─── The OS credential store (the Tauri desktop app) ─────────────────────────

describe('tokenStorage — the keychain store (desktop app)', () => {
  it('hydrates from the keychain and drops stale copies left in the page storage', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc'), 'trusted-device': 't-kc' });
    localStorage.setItem(ACCESS, 'a-stale');
    localStorage.setItem(REFRESH, 'r-stale');
    localStorage.setItem(TRUSTED, 't-stale');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBe('a-kc');
    expect(getRefreshToken()).toBe('r-kc');
    expect(getTrustedDeviceToken()).toBe('t-kc');
    expect(isRemembered()).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(keychain.calls.filter((c) => c.cmd === 'session_secret_set')).toHaveLength(0);
  });

  it('migrates a pre-keychain install: the tokens move in, the plaintext copy goes after a verified read-back', async () => {
    const keychain = fakeKeychain();
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    localStorage.setItem(TRUSTED, 't-old');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBe('a-old');
    expect(isRemembered()).toBe(true);
    expect(keychain.tokens()).toEqual({ accessToken: 'a-old', refreshToken: 'r-old' });
    expect(keychain.entries.get('trusted-device')).toBe('t-old');
    expect(localStorage.length).toBe(0);
    // Sequential, the pair first: a locked keychain prompts once per read,
    // and a trusted-device failure must not cost the session
    expect(keychain.calls.map((c) => `${c.cmd}:${c.name}`)).toEqual([
      'session_secret_get:tokens',
      'session_secret_set:tokens',
      'session_secret_get:tokens', // the read-back
      'session_secret_get:trusted-device',
      'session_secret_set:trusted-device',
      'session_secret_get:trusted-device',
    ]);
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  it('a trusted-device read that fails costs neither the session nor the on-disk trusted copy', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc') });
    const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === 'session_secret_get' && args?.name === 'trusted-device') throw new Error('item locked');
      return keychain.invoke<T>(cmd, args);
    };
    localStorage.setItem(TRUSTED, 't-old');
    _resetTokenStorageForTests(createKeychainSessionStore(invoke));

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBe('a-kc');
    expect(getTrustedDeviceToken()).toBe('t-old');
    expect(localStorage.getItem(TRUSTED)).toBe('t-old'); // kept for the next launch's migration
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('trusted-device token could not be read'), 'item locked');
  });

  it('keeps the plaintext copy when the migrated write cannot be read back', async () => {
    const invoke = async <T>(cmd: string): Promise<T> => (cmd === 'session_secret_get' ? (null as T) : (undefined as T));
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    _resetTokenStorageForTests(createKeychainSessionStore(invoke));

    await hydrateTokens();

    expect(getAccessToken()).toBe('a-old');
    expect(localStorage.getItem(ACCESS)).toBe('a-old');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('did not keep tokens'));
  });

  it('a not-remembered session of an older build (sessionStorage) is loaded in memory only and written nowhere', async () => {
    const keychain = fakeKeychain();
    sessionStorage.setItem(ACCESS, 'a-s');
    sessionStorage.setItem(REFRESH, 'r-s');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));

    await hydrateTokens();

    expect(getAccessToken()).toBe('a-s');
    expect(isRemembered()).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(keychain.entries.size).toBe(0);
  });

  it('"remember me" writes the pair as one keychain entry and never the page storage; a renewal keeps it there', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();

    setTokens('a1', 'r1', true);
    await flushTokenStorage();
    expect(keychain.tokens()).toEqual({ accessToken: 'a1', refreshToken: 'r1' });

    setTokens('a2', 'r2');
    await flushTokenStorage();
    expect(keychain.tokens()).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('"remember me" OFF writes nothing and removes the entry of a previous remembered session', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-prev', 'r-prev') });
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();

    setTokens('a-mem', 'r-mem', false);
    await flushTokenStorage();

    expect(getAccessToken()).toBe('a-mem');
    expect(isRemembered()).toBe(false);
    expect(keychain.entries.has('tokens')).toBe(false);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('clearTokens removes the entry; the trusted-device token has its own entry and lifecycle', async () => {
    const keychain = fakeKeychain({ tokens: pair('a', 'r') });
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();

    setTrustedDeviceToken('t-new');
    clearTokens();
    await flushTokenStorage();
    expect(keychain.entries.has('tokens')).toBe(false);
    expect(keychain.entries.get('trusted-device')).toBe('t-new');
    expect(getTrustedDeviceToken()).toBe('t-new');

    clearTrustedDeviceToken();
    await flushTokenStorage();
    expect(keychain.entries.has('trusted-device')).toBe(false);
    expect(getTrustedDeviceToken()).toBeNull();
  });

  it('a store that does not answer: a copy an older build left on disk serves this run and STAYS, and the store is asked again', async () => {
    const keychain = fakeKeychain();
    keychain.setDown(true);
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(false);
    expect(getAccessToken()).toBe('a-old');
    expect(localStorage.getItem(REFRESH)).toBe('r-old'); // not deleted: nothing holds it yet
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('using the copy an older build left on disk'), 'Secret Service not available');

    // The daemon came up: the next attempt migrates
    keychain.setDown(false);
    await expect(hydrateTokens()).resolves.toBe(true);
    expect(keychain.tokens()).toEqual({ accessToken: 'a-old', refreshToken: 'r-old' });
    expect(localStorage.length).toBe(0);

    // and once it answered, it is not read again
    const reads = keychain.calls.length;
    await expect(hydrateTokens()).resolves.toBe(true);
    expect(keychain.calls.length).toBe(reads);
  });

  it('a store that does not answer with nothing on disk is "not yet", not "no session" — reported once until it answers', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc') });
    keychain.setDown(true);
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be restored yet'), 'Secret Service not available');

    // the retries keep asking, the console does not fill up
    await expect(hydrateTokens()).resolves.toBe(false);
    await expect(hydrateTokens()).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    keychain.setDown(false);
    await expect(hydrateTokens()).resolves.toBe(true);
    expect(getAccessToken()).toBe('a-kc');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('reachable again'));
  });

  it('clearTokens removes an older build\'s copy from the page storage AT ONCE, store down or not (a refused session must not come back on reload)', async () => {
    const keychain = fakeKeychain();
    keychain.setDown(true);
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    localStorage.setItem(TRUSTED, 't-old');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-old');

    clearTokens();
    clearTrustedDeviceToken();
    // synchronously, before any queued store operation
    expect(localStorage.getItem(ACCESS)).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBeNull();
    expect(localStorage.getItem(TRUSTED)).toBeNull();
    expect(getAccessToken()).toBeNull();

    // the next launch (store still down) finds no session to restore
    await flushTokenStorage();
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await expect(hydrateTokens()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it('a write removes the older build\'s copy of that slot too, and a later load brings the store up to date with the memory', async () => {
    const keychain = fakeKeychain();
    keychain.setDown(true);
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens(); // false: the legacy copy serves this run

    setTokens('a-renewed', 'r-renewed'); // a renewal, no flag: stays remembered
    await flushTokenStorage();
    expect(localStorage.getItem(ACCESS)).toBeNull(); // the stale copy is gone even though the store write failed
    expect(getAccessToken()).toBe('a-renewed');
    expect(errorSpy).toHaveBeenCalledWith('[Session] Could not persist the session:', 'Secret Service not available');

    // The store comes back (another checkAuth re-runs the load): the memory
    // wins, and the store receives it instead of staying empty forever
    keychain.setDown(false);
    await expect(hydrateTokens()).resolves.toBe(true);
    expect(getAccessToken()).toBe('a-renewed');
    expect(keychain.tokens()).toEqual({ accessToken: 'a-renewed', refreshToken: 'r-renewed' });
  });

  it('a load after a clear leaves the store empty as well', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc') });
    keychain.setDown(true);
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();

    clearTokens(); // a logout while the store was down
    await flushTokenStorage();
    keychain.setDown(false);
    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBeNull();
    expect(keychain.entries.has('tokens')).toBe(false);
  });

  it('"remember me" OFF after a remembered session of an older build leaves nothing on disk', async () => {
    const keychain = fakeKeychain();
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens(); // migrated into the keychain

    setTokens('a-mem', 'r-mem', false);
    await flushTokenStorage();

    expect(keychain.entries.has('tokens')).toBe(false);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(getAccessToken()).toBe('a-mem');
  });

  it('a write the store refuses is logged and the session stays in memory (nothing falls back to the page storage)', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();
    keychain.setDown(true);

    setTokens('a1', 'r1', true);
    await flushTokenStorage();

    expect(getAccessToken()).toBe('a1');
    expect(errorSpy).toHaveBeenCalledWith('[Session] Could not persist the session:', 'Secret Service not available');
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('an entry with an unexpected shape is ignored, not trusted — and never quoted in the console', async () => {
    const raws = ['not json', '{"accessToken":1}', '[]', '{"refreshToken":"r"}', 'eyJhbGciOiJIUzI1NiJ9.broken.entry'];
    for (const raw of raws) {
      const keychain = fakeKeychain({ tokens: raw });
      _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
      await expect(hydrateTokens()).resolves.toBe(true);
      expect(getAccessToken()).toBeNull();
    }
    expect(errorSpy).toHaveBeenCalledTimes(raws.length);
    // V8 quotes a fragment of the input in a JSON.parse error message; a
    // fragment of a token must not reach the console
    for (const call of errorSpy.mock.calls) {
      expect(call).toEqual(['[Session] The stored session could not be decoded — ignoring it']);
    }
  });
});

// ─── Ordering, hydration and the flush ───────────────────────────────────────

describe('tokenStorage — writes land in order, the memory is read at once', () => {
  it('a slow write followed by a clear leaves the store empty (a renewal landing after a logout cannot resurrect the session)', async () => {
    const keychain = fakeKeychain();
    let releaseSet!: () => void;
    const slowInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === 'session_secret_set') await new Promise<void>((r) => { releaseSet = r; });
      return keychain.invoke<T>(cmd, args);
    };
    _resetTokenStorageForTests(createKeychainSessionStore(slowInvoke));
    await hydrateTokens();

    setTokens('a-late', 'r-late', true);
    clearTokens();
    expect(getAccessToken()).toBeNull(); // memory is immediate
    await Promise.resolve();
    expect(keychain.calls.filter((c) => c.cmd === 'session_secret_delete')).toHaveLength(0); // queued behind the set

    releaseSet();
    await flushTokenStorage();
    expect(keychain.entries.has('tokens')).toBe(false);
    expect(keychain.calls.map((c) => c.cmd).slice(-2)).toEqual(['session_secret_set', 'session_secret_delete']);
  });

  it('hydration is shared by concurrent callers and runs once', async () => {
    const load = vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', remembered: true, trustedDeviceToken: null, reachable: true }));
    const store: SessionStore = { load, saveTokens() {}, clearTokens() {}, saveTrustedDeviceToken() {}, clearTrustedDeviceToken() {} };
    _resetTokenStorageForTests(store);

    await Promise.all([hydrateTokens(), hydrateTokens(), hydrateTokens()]);
    await hydrateTokens();

    expect(load).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBe('a');
  });

  it('a write made while the store is still being read wins over what the read brings back', async () => {
    let releaseLoad!: () => void;
    const store: SessionStore = {
      load: async () => {
        await new Promise<void>((r) => { releaseLoad = r; });
        return { accessToken: 'a-disk', refreshToken: 'r-disk', remembered: true, trustedDeviceToken: 't-disk', reachable: true };
      },
      saveTokens() {}, clearTokens() {}, saveTrustedDeviceToken() {}, clearTrustedDeviceToken() {},
    };
    _resetTokenStorageForTests(store);

    const hydration = hydrateTokens();
    await Promise.resolve();
    setTokens('a-login', 'r-login', true);
    releaseLoad();
    await hydration;

    expect(getAccessToken()).toBe('a-login');
    expect(getTrustedDeviceToken()).toBe('t-disk'); // the slot nobody wrote still hydrates
  });

  it('a load that throws is logged, leaves the memory empty and is retried by the next call', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r', remembered: true, trustedDeviceToken: null, reachable: true });
    const store: SessionStore = { load, saveTokens() {}, clearTokens() {}, saveTrustedDeviceToken() {}, clearTrustedDeviceToken() {} };
    _resetTokenStorageForTests(store);

    await expect(hydrateTokens()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[Session] Could not read the stored session:', 'boom');

    await expect(hydrateTokens()).resolves.toBe(true);
    expect(getAccessToken()).toBe('a');
  });

  it('flushTokenStorage resolves when the queued writes have landed, and gives up on a hung store after the timeout', async () => {
    vi.useFakeTimers();
    const hung: SessionStore = {
      load: async () => ({ accessToken: null, refreshToken: null, remembered: true, trustedDeviceToken: null, reachable: true }),
      saveTokens: () => new Promise<void>(() => {}), // never answers
      clearTokens() {}, saveTrustedDeviceToken() {}, clearTrustedDeviceToken() {},
    };
    _resetTokenStorageForTests(hung);
    setTokens('a', 'r', true);

    let flushed = false;
    void flushTokenStorage().then(() => { flushed = true; });
    await vi.advanceTimersByTimeAsync(TOKEN_STORAGE_FLUSH_TIMEOUT_MS - 1);
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did not finish writing in time'));
  });
});

// ─── Other tabs, the reset, the defaults ─────────────────────────────────────

describe('tokenStorage — the web store follows the other tabs (the read-through getters it replaced did by nature)', () => {
  const otherTab = (key: string | null, newValue: string | null) => {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
  };

  it('a logout in another tab empties this tab\'s remembered session', async () => {
    setTokens('a1', 'r1', true);
    await flushTokenStorage();

    // the other tab removed the keys; the event reaches this tab only
    removeFromOtherTab();
    otherTab(ACCESS, null);
    otherTab(REFRESH, null);

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();

    function removeFromOtherTab() {
      localStorage.removeItem(ACCESS);
      localStorage.removeItem(REFRESH);
    }
  });

  it('a sign-in in another tab (as anyone) becomes this tab\'s session, and a clear-all (key null) is followed too', async () => {
    await hydrateTokens();
    localStorage.setItem(ACCESS, 'a-b');
    localStorage.setItem(REFRESH, 'r-b');
    localStorage.setItem(TRUSTED, 't-b');
    otherTab(ACCESS, 'a-b');
    otherTab(REFRESH, 'r-b');
    otherTab(TRUSTED, 't-b');

    expect(getAccessToken()).toBe('a-b');
    expect(getRefreshToken()).toBe('r-b');
    expect(getTrustedDeviceToken()).toBe('t-b');
    expect(isRemembered()).toBe(true);

    localStorage.clear();
    otherTab(null, null);
    expect(getAccessToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
  });

  it('a not-remembered session (this tab\'s own sessionStorage) is left alone when a remembered one goes away elsewhere', async () => {
    setTokens('a-s', 'r-s', false);
    await flushTokenStorage();

    otherTab(ACCESS, null);
    otherTab(REFRESH, null);

    expect(getAccessToken()).toBe('a-s');
    expect(isRemembered()).toBe(false);
  });

  it('the keychain store ignores storage events (the desktop app has one window)', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc') });
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();

    localStorage.setItem(ACCESS, 'a-x');
    localStorage.setItem(REFRESH, 'r-x');
    otherTab(ACCESS, 'a-x');

    expect(getAccessToken()).toBe('a-kc');
  });
});

describe('tokenStorage — isolation and defaults', () => {
  it('an operation queued before the test reset runs against nothing (not the next test\'s store)', async () => {
    const before = fakeKeychain();
    let release!: () => void;
    const slowInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === 'session_secret_set') await new Promise<void>((r) => { release = r; });
      return before.invoke<T>(cmd, args);
    };
    _resetTokenStorageForTests(createKeychainSessionStore(slowInvoke));
    await hydrateTokens();
    setTokens('a-late', 'r-late', true);
    await Promise.resolve();

    const after = fakeKeychain();
    _resetTokenStorageForTests(createKeychainSessionStore(after.invoke));
    setTokens('a-next', 'r-next', true);
    release();
    await flushTokenStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(after.tokens()).toEqual({ accessToken: 'a-next', refreshToken: 'r-next' });
    // the first store received the set it was mid-way through (released), nothing queued behind it
    expect(before.calls.filter((c) => c.cmd === 'session_secret_set')).toHaveLength(1);
    expect(getAccessToken()).toBe('a-next');
  });

  it('with nothing stored, a pair written without a flag is NOT remembered (nothing persists by default)', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke));
    await hydrateTokens();

    setTokens('a', 'r');
    await flushTokenStorage();

    expect(isRemembered()).toBe(false);
    expect(keychain.entries.has('tokens')).toBe(false);
  });
});
