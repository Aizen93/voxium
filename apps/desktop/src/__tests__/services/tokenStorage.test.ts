import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAccessToken, getRefreshToken, setTokens, clearTokens, isRemembered,
  getTrustedDeviceToken, setTrustedDeviceToken, clearTrustedDeviceToken,
  hydrateTokens, flushTokenStorage, createKeychainSessionStore, createWebSessionStore, webSessionStore,
  TOKEN_STORAGE_FLUSH_TIMEOUT_MS, _resetTokenStorageForTests,
  type SessionStore,
} from '../../services/tokenStorage';

// Where the signed-in session lives on the device. The desktop app keeps it
// in the OS credential store through the Tauri `session_secret_*` commands
// (never again in the webview's localStorage, a plaintext file); the web
// client keeps localStorage/sessionStorage. Both sit behind one in-memory
// module with synchronous reads. Every stored session is stamped with the
// origin of the API that issued it, and is only ever handed to a build of
// that origin.

const ACCESS = 'voxium_access_token';
const REFRESH = 'voxium_refresh_token';
const TRUSTED = 'voxium_trusted_device';
const ORIGIN_MARK = 'voxium_session_origin';
const TRUSTED_ORIGIN_MARK = 'voxium_trusted_device_origin';

/** An official build's API origin (the official domain is public: the release policy names it). */
const OFFICIAL = 'https://voxium.app';
/** A build someone made for their own server with `pnpm tauri:build`. */
const COMMUNITY = 'https://chat.example.org';
/** The API a web client in these tests is compiled for. */
const WEB = 'https://web.example.org';

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
    /** What the `trusted-device` entry holds, decoded. */
    trusted: () => (entries.has('trusted-device') ? JSON.parse(entries.get('trusted-device')!) : null),
  };
}

/** The `tokens` entry as this version writes it: the pair and the origin of the API that issued it. */
const pair = (access: string, refresh: string, origin = OFFICIAL) => JSON.stringify({ accessToken: access, refreshToken: refresh, origin });
/** The `tokens` entry as builds before the origin stamp wrote it. */
const legacyPair = (access: string, refresh: string) => JSON.stringify({ accessToken: access, refreshToken: refresh });
/** The `trusted-device` entry as this version writes it (older builds stored the bare token). */
const trusted = (token: string, origin = OFFICIAL) => JSON.stringify({ token, origin });
/** What a pair entry decodes to once stamped. */
const stamped = (access: string, refresh: string, origin = OFFICIAL) => ({ accessToken: access, refreshToken: refresh, origin });

/** The keychain store of an official build (its API under the official domain). */
const officialStore = (invoke: Parameters<typeof createKeychainSessionStore>[0]) => createKeychainSessionStore(invoke, { apiOrigin: OFFICIAL });
/** The keychain store of a build made for another server. */
const communityStore = (invoke: Parameters<typeof createKeychainSessionStore>[0], apiOrigin = COMMUNITY) => createKeychainSessionStore(invoke, { apiOrigin });

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
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc'), 'trusted-device': trusted('t-kc') });
    localStorage.setItem(ACCESS, 'a-stale');
    localStorage.setItem(REFRESH, 'r-stale');
    localStorage.setItem(TRUSTED, 't-stale');
    _resetTokenStorageForTests(officialStore(keychain.invoke));

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
    _resetTokenStorageForTests(officialStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBe('a-old');
    expect(isRemembered()).toBe(true);
    expect(keychain.tokens()).toEqual(stamped('a-old', 'r-old'));
    expect(keychain.trusted()).toEqual({ token: 't-old', origin: OFFICIAL });
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
    _resetTokenStorageForTests(officialStore(invoke));

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
    _resetTokenStorageForTests(officialStore(invoke));

    await hydrateTokens();

    expect(getAccessToken()).toBe('a-old');
    expect(localStorage.getItem(ACCESS)).toBe('a-old');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('did not keep tokens'));
  });

  it('a not-remembered session of an older build (sessionStorage) is loaded in memory only and written nowhere', async () => {
    const keychain = fakeKeychain();
    sessionStorage.setItem(ACCESS, 'a-s');
    sessionStorage.setItem(REFRESH, 'r-s');
    _resetTokenStorageForTests(officialStore(keychain.invoke));

    await hydrateTokens();

    expect(getAccessToken()).toBe('a-s');
    expect(isRemembered()).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(keychain.entries.size).toBe(0);
  });

  it('"remember me" writes the pair as one keychain entry and never the page storage; a renewal keeps it there', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await hydrateTokens();

    setTokens('a1', 'r1', true);
    await flushTokenStorage();
    expect(keychain.tokens()).toEqual(stamped('a1', 'r1'));

    setTokens('a2', 'r2');
    await flushTokenStorage();
    expect(keychain.tokens()).toEqual(stamped('a2', 'r2'));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('"remember me" OFF writes nothing and removes the entry of a previous remembered session', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-prev', 'r-prev') });
    _resetTokenStorageForTests(officialStore(keychain.invoke));
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
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await hydrateTokens();

    setTrustedDeviceToken('t-new');
    clearTokens();
    await flushTokenStorage();
    expect(keychain.entries.has('tokens')).toBe(false);
    expect(keychain.trusted()).toEqual({ token: 't-new', origin: OFFICIAL });
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
    _resetTokenStorageForTests(officialStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(false);
    expect(getAccessToken()).toBe('a-old');
    expect(localStorage.getItem(REFRESH)).toBe('r-old'); // not deleted: nothing holds it yet
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('using the copy an older build left on disk'), 'Secret Service not available');

    // The daemon came up: the next attempt migrates
    keychain.setDown(false);
    await expect(hydrateTokens()).resolves.toBe(true);
    expect(keychain.tokens()).toEqual(stamped('a-old', 'r-old'));
    expect(localStorage.length).toBe(0);

    // and once it answered, it is not read again
    const reads = keychain.calls.length;
    await expect(hydrateTokens()).resolves.toBe(true);
    expect(keychain.calls.length).toBe(reads);
  });

  it('a store that does not answer with nothing on disk is "not yet", not "no session" — reported once until it answers', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc') });
    keychain.setDown(true);
    _resetTokenStorageForTests(officialStore(keychain.invoke));

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
    _resetTokenStorageForTests(officialStore(keychain.invoke));
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
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await expect(hydrateTokens()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it('a write removes the older build\'s copy of that slot too, and a later load brings the store up to date with the memory', async () => {
    const keychain = fakeKeychain();
    keychain.setDown(true);
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    _resetTokenStorageForTests(officialStore(keychain.invoke));
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
    expect(keychain.tokens()).toEqual(stamped('a-renewed', 'r-renewed'));
  });

  it('a load after a clear leaves the store empty as well', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-kc', 'r-kc') });
    keychain.setDown(true);
    _resetTokenStorageForTests(officialStore(keychain.invoke));
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
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await hydrateTokens(); // migrated into the keychain

    setTokens('a-mem', 'r-mem', false);
    await flushTokenStorage();

    expect(keychain.entries.has('tokens')).toBe(false);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(getAccessToken()).toBe('a-mem');
  });

  it('a write the store refuses is logged and the session stays in memory (nothing falls back to the page storage)', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await hydrateTokens();
    keychain.setDown(true);

    setTokens('a1', 'r1', true);
    await flushTokenStorage();

    expect(getAccessToken()).toBe('a1');
    expect(errorSpy).toHaveBeenCalledWith('[Session] Could not persist the session:', 'Secret Service not available');
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('an entry with an unexpected shape is ignored, not trusted — and never quoted in the console', async () => {
    const raws = [
      'not json', '{"accessToken":1}', '[]', '{"refreshToken":"r"}', 'eyJhbGciOiJIUzI1NiJ9.broken.entry',
      // an origin that is not a string is not an origin
      '{"accessToken":"a","refreshToken":"r","origin":5}', '{"accessToken":"a","refreshToken":"r","origin":null}',
    ];
    for (const raw of raws) {
      const keychain = fakeKeychain({ tokens: raw });
      _resetTokenStorageForTests(officialStore(keychain.invoke));
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

// ─── The origin a session belongs to ─────────────────────────────────────────
//
// Every desktop build shares the keychain entries and the webview storage
// (fixed service names, one bundle identifier): the official app and a build
// made for another server with `pnpm tauri:build` read the same `tokens`
// entry. A pair is the issuing server's credential, so nothing stored for one
// origin may reach a build of another. Entries from before the stamp have no
// origin: they are the official service's (no other build could reach its
// server until now), kept by an official build, left unread by any other.

describe('tokenStorage — a stored session is only ever handed to the server that issued it', () => {
  it('an official build keeps an unstamped entry across the update, and stamps it', async () => {
    const keychain = fakeKeychain({ tokens: legacyPair('a-legacy', 'r-legacy'), 'trusted-device': 't-legacy' });
    _resetTokenStorageForTests(officialStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBe('a-legacy');
    expect(getRefreshToken()).toBe('r-legacy');
    expect(getTrustedDeviceToken()).toBe('t-legacy');
    expect(isRemembered()).toBe(true);
    expect(keychain.tokens()).toEqual(stamped('a-legacy', 'r-legacy'));
    expect(keychain.trusted()).toEqual({ token: 't-legacy', origin: OFFICIAL });
  });

  it('an official build on a subdomain of the official domain keeps it too', async () => {
    const keychain = fakeKeychain({ tokens: legacyPair('a-legacy', 'r-legacy') });
    _resetTokenStorageForTests(createKeychainSessionStore(keychain.invoke, { apiOrigin: 'https://api.voxium.app' }));
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-legacy');
    expect(keychain.tokens()).toEqual(stamped('a-legacy', 'r-legacy', 'https://api.voxium.app'));
  });

  it('a build for another server leaves an unstamped entry unread: nothing in memory to send, the entry untouched', async () => {
    const keychain = fakeKeychain({ tokens: legacyPair('a-legacy', 'r-legacy'), 'trusted-device': 't-legacy' });
    _resetTokenStorageForTests(communityStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(true);

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
    expect(isRemembered()).toBe(false);
    // left for the official app it belongs to
    expect(keychain.entries.get('tokens')).toBe(legacyPair('a-legacy', 'r-legacy'));
    expect(keychain.entries.get('trusted-device')).toBe('t-legacy');
    expect(keychain.calls.filter((c) => c.cmd !== 'session_secret_get')).toEqual([]);
  });

  it('a build for another server never reads the copies an older official build left in the page storage', async () => {
    const keychain = fakeKeychain();
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    localStorage.setItem(TRUSTED, 't-old');
    sessionStorage.setItem(ACCESS, 'a-s');
    sessionStorage.setItem(REFRESH, 'r-s');
    _resetTokenStorageForTests(communityStore(keychain.invoke));

    await hydrateTokens();

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
    expect(keychain.entries.size).toBe(0);
    expect(localStorage.getItem(REFRESH)).toBe('r-old');
  });

  it('... nor when the keychain does not answer', async () => {
    const keychain = fakeKeychain();
    keychain.setDown(true);
    localStorage.setItem(ACCESS, 'a-old');
    localStorage.setItem(REFRESH, 'r-old');
    localStorage.setItem(TRUSTED, 't-old');
    _resetTokenStorageForTests(communityStore(keychain.invoke));

    await expect(hydrateTokens()).resolves.toBe(false);

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
  });

  it('an entry stamped with another origin is never used, in either direction, and is left as it is', async () => {
    const cases: Array<[string, (invoke: Parameters<typeof createKeychainSessionStore>[0]) => SessionStore]> = [
      [COMMUNITY, officialStore], // the community's session, read by the official app
      [OFFICIAL, (invoke) => communityStore(invoke)], // the official session, read by a community build
      ['https://other.example.net', (invoke) => communityStore(invoke)], // another community's
      ['http://chat.example.org', (invoke) => communityStore(invoke)], // same host, another scheme
      ['https://chat.example.org:8443', (invoke) => communityStore(invoke)], // same host, another port
    ];
    for (const [origin, makeStore] of cases) {
      const keychain = fakeKeychain({ tokens: pair('a-foreign', 'r-foreign', origin), 'trusted-device': trusted('t-foreign', origin) });
      _resetTokenStorageForTests(makeStore(keychain.invoke));
      await expect(hydrateTokens()).resolves.toBe(true);
      expect(getAccessToken(), origin).toBeNull();
      expect(getRefreshToken(), origin).toBeNull();
      expect(getTrustedDeviceToken(), origin).toBeNull();
      expect(keychain.tokens(), origin).toEqual(stamped('a-foreign', 'r-foreign', origin));
      expect(keychain.trusted(), origin).toEqual({ token: 't-foreign', origin });
      expect(keychain.calls.filter((c) => c.cmd !== 'session_secret_get'), origin).toEqual([]);
    }
  });

  it('an entry stamped with the build\'s own origin is used, in a community build as in the official one', async () => {
    for (const [origin, makeStore] of [[COMMUNITY, communityStore], [OFFICIAL, officialStore]] as const) {
      const keychain = fakeKeychain({ tokens: pair('a-own', 'r-own', origin), 'trusted-device': trusted('t-own', origin) });
      _resetTokenStorageForTests(makeStore(keychain.invoke));
      await expect(hydrateTokens()).resolves.toBe(true);
      expect(getAccessToken(), origin).toBe('a-own');
      expect(getRefreshToken(), origin).toBe('r-own');
      expect(getTrustedDeviceToken(), origin).toBe('t-own');
      expect(isRemembered(), origin).toBe(true);
      expect(keychain.calls.filter((c) => c.cmd === 'session_secret_set'), origin).toEqual([]);
    }
  });

  it('the trusted-device token follows the same rule on its own: a foreign one is dropped while the build\'s own pair is used', async () => {
    const keychain = fakeKeychain({ tokens: pair('a-own', 'r-own', COMMUNITY), 'trusted-device': trusted('t-official', OFFICIAL) });
    _resetTokenStorageForTests(communityStore(keychain.invoke));
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-own');
    expect(getTrustedDeviceToken()).toBeNull();

    const legacyTrusted = fakeKeychain({ tokens: pair('a-own', 'r-own', COMMUNITY), 'trusted-device': 't-legacy' });
    _resetTokenStorageForTests(communityStore(legacyTrusted.invoke));
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-own');
    expect(getTrustedDeviceToken()).toBeNull();
  });

  it('every write stamps the build\'s origin, so the other build sharing the keychain cannot use it', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(communityStore(keychain.invoke));
    await hydrateTokens();
    setTokens('a-c', 'r-c', true);
    setTrustedDeviceToken('t-c');
    await flushTokenStorage();
    expect(keychain.tokens()).toEqual(stamped('a-c', 'r-c', COMMUNITY));
    expect(keychain.trusted()).toEqual({ token: 't-c', origin: COMMUNITY });

    // the official app launches next on the same machine
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await hydrateTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
  });

  it('a malformed trusted-device entry is ignored and never quoted in the console', async () => {
    for (const raw of ['{"token":5,"origin":"https://chat.example.org"}', '{"token":"t"}', '{not json', '{"origin":"https://chat.example.org"}']) {
      const keychain = fakeKeychain({ 'trusted-device': raw });
      _resetTokenStorageForTests(communityStore(keychain.invoke));
      await hydrateTokens();
      expect(getTrustedDeviceToken(), raw).toBeNull();
    }
    for (const call of errorSpy.mock.calls) {
      expect(call).toEqual(['[Session] The stored trusted-device token could not be decoded — ignoring it']);
    }
    expect(errorSpy).toHaveBeenCalledTimes(4);
  });
});

describe('tokenStorage — the web store binds the session to the API origin too', () => {
  beforeEach(() => {
    _resetTokenStorageForTests(createWebSessionStore({ apiOrigin: WEB }));
  });

  it('a write marks the pair and the trusted-device token with the build\'s origin', async () => {
    setTokens('a1', 'r1', true);
    setTrustedDeviceToken('t1');
    await flushTokenStorage();
    expect(localStorage.getItem(ORIGIN_MARK)).toBe(WEB);
    expect(localStorage.getItem(TRUSTED_ORIGIN_MARK)).toBe(WEB);

    setTokens('a2', 'r2', false);
    await flushTokenStorage();
    expect(sessionStorage.getItem(ORIGIN_MARK)).toBe(WEB);
    expect(localStorage.getItem(ORIGIN_MARK)).toBeNull();

    clearTokens();
    clearTrustedDeviceToken();
    await flushTokenStorage();
    expect(sessionStorage.getItem(ORIGIN_MARK)).toBeNull();
    expect(localStorage.getItem(TRUSTED_ORIGIN_MARK)).toBeNull();
  });

  it('a pair or trusted-device token marked for another origin is never loaded, and is removed', async () => {
    localStorage.setItem(ACCESS, 'a-foreign');
    localStorage.setItem(REFRESH, 'r-foreign');
    localStorage.setItem(ORIGIN_MARK, COMMUNITY);
    localStorage.setItem(TRUSTED, 't-foreign');
    localStorage.setItem(TRUSTED_ORIGIN_MARK, COMMUNITY);
    sessionStorage.setItem(ACCESS, 'a-foreign-s');
    sessionStorage.setItem(REFRESH, 'r-foreign-s');
    sessionStorage.setItem(ORIGIN_MARK, COMMUNITY);

    await hydrateTokens();

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('a pair marked with the build\'s origin is used', async () => {
    localStorage.setItem(ACCESS, 'a-own');
    localStorage.setItem(REFRESH, 'r-own');
    localStorage.setItem(ORIGIN_MARK, WEB);
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-own');
    expect(isRemembered()).toBe(true);
  });

  it('an unmarked pair is the page\'s own (page storage is per page origin) and gets the mark', async () => {
    localStorage.setItem(ACCESS, 'a-page');
    localStorage.setItem(REFRESH, 'r-page');
    localStorage.setItem(TRUSTED, 't-page');
    await hydrateTokens();
    expect(getAccessToken()).toBe('a-page');
    expect(getTrustedDeviceToken()).toBe('t-page');
    expect(localStorage.getItem(ORIGIN_MARK)).toBe(WEB);
    expect(localStorage.getItem(TRUSTED_ORIGIN_MARK)).toBe(WEB);
  });

  it('another tab\'s pair marked for another origin is not adopted', async () => {
    await hydrateTokens();
    localStorage.setItem(ORIGIN_MARK, COMMUNITY);
    localStorage.setItem(ACCESS, 'a-x');
    localStorage.setItem(REFRESH, 'r-x');
    localStorage.setItem(TRUSTED_ORIGIN_MARK, COMMUNITY);
    localStorage.setItem(TRUSTED, 't-x');
    for (const key of [ACCESS, REFRESH, TRUSTED]) {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'x', storageArea: localStorage }));
    }
    expect(getAccessToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
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
    _resetTokenStorageForTests(officialStore(slowInvoke));
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
    _resetTokenStorageForTests(officialStore(keychain.invoke));
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
    _resetTokenStorageForTests(officialStore(slowInvoke));
    await hydrateTokens();
    setTokens('a-late', 'r-late', true);
    await Promise.resolve();

    const after = fakeKeychain();
    _resetTokenStorageForTests(officialStore(after.invoke));
    setTokens('a-next', 'r-next', true);
    release();
    await flushTokenStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(after.tokens()).toEqual(stamped('a-next', 'r-next'));
    // the first store received the set it was mid-way through (released), nothing queued behind it
    expect(before.calls.filter((c) => c.cmd === 'session_secret_set')).toHaveLength(1);
    expect(getAccessToken()).toBe('a-next');
  });

  it('with nothing stored, a pair written without a flag is NOT remembered (nothing persists by default)', async () => {
    const keychain = fakeKeychain();
    _resetTokenStorageForTests(officialStore(keychain.invoke));
    await hydrateTokens();

    setTokens('a', 'r');
    await flushTokenStorage();

    expect(isRemembered()).toBe(false);
    expect(keychain.entries.has('tokens')).toBe(false);
  });
});
