/**
 * Where the signed-in session lives on this device, and the ONE module that
 * reads or writes it.
 *
 * Runtime reads are synchronous and come from memory: the REST interceptor,
 * the socket handshake and the stores all read the token inline. The memory
 * is written through to a backing store chosen by where the app runs:
 *
 * - The Tauri desktop app: the OS credential store (Windows Credential
 *   Manager / macOS Keychain / Linux Secret Service) through the
 *   `session_secret_*` commands — the keyring the E2E pickle key already
 *   lives in (docs/e2e-dm-spec.md §7.3). A refresh token is a 30-day bearer
 *   credential; the webview's localStorage is a plaintext LevelDB under the
 *   user's profile that ends up in every backup and that any process of the
 *   same OS user can read with a file copy. The credential store keeps it
 *   encrypted at rest under the OS user's login (macOS gates it per app as
 *   well), and the webview's storage never holds a token again. An install
 *   that kept its tokens there is migrated out on the first launch. "Remember
 *   me" OFF keeps the session in memory only — it ends with the process, like
 *   a browser tab closing.
 * - A browser (`pnpm dev:web`, the hosted web client): localStorage with
 *   "Remember me", sessionStorage without — there is no OS keychain to reach
 *   from a page. Other tabs' changes are followed through `storage` events.
 *
 * `hydrateTokens()` loads the memory from the store once, at launch, before
 * anything reads a token (authStore.checkAuth awaits it). Writes are queued
 * in order, so a renewal that lands after a logout cannot put the session
 * back into the store, and `flushTokenStorage()` waits for the queue before
 * a page reload (a reload that outran the persisted clear would restore the
 * refused tokens and loop). Whatever the store, a clear removes any copy in
 * the page's storage AT ONCE: that part never waits on the queue.
 *
 * Every stored session is bound to the API origin that issued it
 * (services/sessionOrigin.ts): a refresh token handed to the wrong server is
 * a stolen session. A desktop build for another server keeps its entries
 * apart by its own identifier (lib.rs `keychain_services`); builds that share
 * one (the official app and `tauri dev`) share the entries. Each entry
 * carries the origin of the build that wrote it, and a store hands back only
 * what names its own build's origin; a load leaves another origin's entry as
 * it is. An entry from before the stamp (no origin) is the official
 * service's: an official build keeps and stamps it, any other desktop build
 * leaves it unread. The web store accepts an unmarked pair as the page's own:
 * browser storage belongs to one page origin, which no other deployment
 * shares.
 */

import { BUILD_API_ORIGIN, isOfficialOrigin } from './sessionOrigin';
import { accountDeletionSettled } from './accountDeletion';
import { claimPageNavigation, pendingPageNavigation, _resetPageNavigationForTests } from './pageNavigation';
import { currentE2ESessionUser } from './e2e/session';
import { isSameSession, readTokenClaims, sessionIdOf, userIdOf, type SameSessionOptions } from './tokenClaims';

const ACCESS_KEY = 'voxium_access_token';
const REFRESH_KEY = 'voxium_refresh_token';
const TRUSTED_DEVICE_KEY = 'voxium_trusted_device';
/** The origin the pair in the same storage area was issued by (the web store). */
const SESSION_ORIGIN_KEY = 'voxium_session_origin';
/** The origin the trusted-device token was issued by (the web store). */
const TRUSTED_DEVICE_ORIGIN_KEY = 'voxium_trusted_device_origin';

/** The keychain entries, by the names the Rust side accepts (lib.rs `SESSION_SECRET_NAMES`). */
const TOKENS_ENTRY = 'tokens';
const TRUSTED_DEVICE_ENTRY = 'trusted-device';

/** How long a page reload waits for the persisted session writes before going ahead anyway. */
export const TOKEN_STORAGE_FLUSH_TIMEOUT_MS = 2_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Everything a store holds, as `load()` reports it. */
export interface StoredSession {
  accessToken: string | null;
  refreshToken: string | null;
  /** The pair sits in (or goes to) the slot that survives a restart. */
  remembered: boolean;
  /** The TOTP "trust this device" token (a 30-day JWT), if the device holds one. */
  trustedDeviceToken: string | null;
}

export interface LoadedSession extends StoredSession {
  /** False when the store did not answer (a keyring daemon not up yet, a
   *  locked keychain): what was loaded is the best copy available, and the
   *  store is worth asking again. */
  reachable: boolean;
}

/** A backing store for the session. Writes may be synchronous (the browser) or not (the keychain IPC). */
export interface SessionStore {
  load(): Promise<LoadedSession>;
  saveTokens(accessToken: string, refreshToken: string, remembered: boolean): void | Promise<void>;
  clearTokens(): void | Promise<void>;
  saveTrustedDeviceToken(token: string): void | Promise<void>;
  clearTrustedDeviceToken(): void | Promise<void>;
}

/** The page's own storage, which other tabs of the same page write too. */
interface WebSessionStore extends SessionStore {
  /** The API origin this store binds the session to. */
  readonly apiOrigin: string;
}

export interface SessionStoreOptions {
  /** The origin of the API the build talks to (default: the one it is compiled for). */
  apiOrigin?: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── The page's storage (the browser store, and what older builds left behind) ─

function readPair(area: Storage): TokenPair | null {
  const accessToken = area.getItem(ACCESS_KEY);
  const refreshToken = area.getItem(REFRESH_KEY);
  return accessToken !== null && refreshToken !== null ? { accessToken, refreshToken } : null;
}

function removePair(area: Storage): void {
  area.removeItem(ACCESS_KEY);
  area.removeItem(REFRESH_KEY);
  area.removeItem(SESSION_ORIGIN_KEY);
}

/** Every copy of the pair the page's storage holds, gone — synchronously. */
function removeLegacyPairs(): void {
  removePair(localStorage);
  removePair(sessionStorage);
}

/** The page's trusted-device token and its mark, gone — synchronously. */
function removeTrustedCopy(): void {
  localStorage.removeItem(TRUSTED_DEVICE_KEY);
  localStorage.removeItem(TRUSTED_DEVICE_ORIGIN_KEY);
}

/** What an older desktop build left in the page's storage (no origin mark: it predates it). */
function legacyCopies(): { local: TokenPair | null; session: TokenPair | null; trusted: string | null } {
  return {
    local: readPair(localStorage),
    session: readPair(sessionStorage),
    trusted: localStorage.getItem(TRUSTED_DEVICE_KEY),
  };
}

const NO_LEGACY_COPIES = { local: null, session: null, trusted: null } as const;

/**
 * Whether the web store may use what `area` holds under `originKey`: unmarked
 * (the page's own, written before the mark existed: it gets the mark) or
 * marked with `apiOrigin`. A mark of another origin is removed with what it
 * marks, never read.
 */
function webAreaOwned(area: Storage, originKey: string, keys: readonly string[], apiOrigin: string): boolean {
  const mark = area.getItem(originKey);
  if (mark === apiOrigin) return true;
  if (mark !== null) {
    for (const key of [...keys, originKey]) area.removeItem(key);
    console.warn('[Session] The page held a session issued by another server — dropped unread');
    return false;
  }
  if (keys.some((key) => area.getItem(key) !== null)) area.setItem(originKey, apiOrigin);
  return true;
}

/**
 * localStorage ("Remember me") or sessionStorage: the page's own storage,
 * for the web client. Reads the two tokens independently, as the module
 * always did (an access token alone still serves until it expires). Each
 * area's pair, and the trusted-device token, carry the API origin they were
 * issued by; the mark is written BEFORE the tokens, so another tab never sees
 * a pair without it.
 */
export function createWebSessionStore({ apiOrigin = BUILD_API_ORIGIN }: SessionStoreOptions = {}): WebSessionStore {
  const PAIR_KEYS = [ACCESS_KEY, REFRESH_KEY] as const;
  return {
    apiOrigin,
    async load() {
      const local = webAreaOwned(localStorage, SESSION_ORIGIN_KEY, PAIR_KEYS, apiOrigin);
      const session = webAreaOwned(sessionStorage, SESSION_ORIGIN_KEY, PAIR_KEYS, apiOrigin);
      const trusted = webAreaOwned(localStorage, TRUSTED_DEVICE_ORIGIN_KEY, [TRUSTED_DEVICE_KEY], apiOrigin);
      const fromLocal = (key: string) => (local ? localStorage.getItem(key) : null);
      const fromSession = (key: string) => (session ? sessionStorage.getItem(key) : null);
      return {
        accessToken: fromLocal(ACCESS_KEY) ?? fromSession(ACCESS_KEY),
        refreshToken: fromLocal(REFRESH_KEY) ?? fromSession(REFRESH_KEY),
        remembered: fromLocal(ACCESS_KEY) !== null,
        trustedDeviceToken: trusted ? localStorage.getItem(TRUSTED_DEVICE_KEY) : null,
        reachable: true,
      };
    },
    saveTokens(accessToken, refreshToken, remembered) {
      const [into, outOf] = remembered ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
      removePair(outOf);
      into.setItem(SESSION_ORIGIN_KEY, apiOrigin);
      into.setItem(ACCESS_KEY, accessToken);
      into.setItem(REFRESH_KEY, refreshToken);
    },
    clearTokens() {
      removeLegacyPairs();
    },
    saveTrustedDeviceToken(token) {
      localStorage.setItem(TRUSTED_DEVICE_ORIGIN_KEY, apiOrigin);
      localStorage.setItem(TRUSTED_DEVICE_KEY, token);
    },
    clearTrustedDeviceToken() {
      removeTrustedCopy();
    },
  };
}

/** The web client's store, bound to the API the build is compiled for. */
export const webSessionStore: SessionStore = createWebSessionStore();

// ─── The OS credential store (Tauri) ─────────────────────────────────────────

/** Test/DI hook so unit tests don't need a real Tauri runtime. */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** What an entry holds and the API origin it was issued by (null: written before the stamp existed). */
interface Stamped<T> {
  value: T;
  origin: string | null;
}

/** The `tokens` entry: one JSON object, the pair and its origin, so they are written together or not at all. */
function encodePair(accessToken: string, refreshToken: string, origin: string): string {
  return JSON.stringify({ accessToken, refreshToken, origin });
}

/** The pair an entry holds, or null for an empty or unreadable entry (logged
 *  without the content: a parse error's message quotes its input, and the
 *  input is a token). An entry without `origin` predates the stamp. */
function decodePair(raw: string | null): Stamped<TokenPair> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as (Partial<TokenPair> & { origin?: unknown }) | null;
    if (parsed && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
      const value = { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
      if (!('origin' in parsed)) return { value, origin: null };
      if (typeof parsed.origin === 'string') return { value, origin: parsed.origin };
    }
  } catch {
    // Reported just below, like the wrong shape: the entry is ours to rewrite
  }
  console.error('[Session] The stored session could not be decoded — ignoring it');
  return null;
}

/** The `trusted-device` entry: `{ token, origin }` as JSON. Builds before the stamp stored the bare token. */
function encodeTrusted(token: string, origin: string): string {
  return JSON.stringify({ token, origin });
}

function decodeTrusted(raw: string | null): Stamped<string> | null {
  if (raw === null || raw === '') return null;
  // A bare token (a JWT never starts with a brace) is an entry from before the stamp
  if (!raw.startsWith('{')) return { value: raw, origin: null };
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; origin?: unknown } | null;
    if (parsed && typeof parsed.token === 'string' && parsed.token && typeof parsed.origin === 'string') {
      return { value: parsed.token, origin: parsed.origin };
    }
  } catch {
    // Reported just below, without the content
  }
  console.error('[Session] The stored trusted-device token could not be decoded — ignoring it');
  return null;
}

/**
 * The OS credential store, through the Tauri commands. A session kept there
 * survives restarts; one not remembered is written nowhere (and the entry of
 * a previous remembered session is removed, so it cannot come back at the
 * next launch). Copies an older build left in the page's storage are moved
 * in on the first load — the plaintext copy goes only after a verified
 * read-back, as for the pickle key — and a store that does not answer leaves
 * them in place for this run and the next attempt. Every write of a slot
 * removes the page-storage copy of that slot first: once the memory has been
 * written, a copy on disk can only be stale, and a stale refresh token is
 * still a working credential (the refresh is stateless).
 *
 * The entries live under the build's own service (lib.rs names it after the
 * build's identifier): only builds with the same identifier, the official
 * app and `tauri dev`, share them, so each carries the origin of the API it
 * was issued by. An entry of another origin reads as no session, and a load
 * leaves it as it is; this build's own writes and clears replace or remove
 * it. An entry without an origin, like the page-storage copies older builds
 * left, is the official service's: only a build whose API is the official
 * one reads, migrates and stamps it.
 */
export function createKeychainSessionStore(invokeFn?: InvokeFn, { apiOrigin = BUILD_API_ORIGIN }: SessionStoreOptions = {}): SessionStore {
  const ownsUnstamped = isOfficialOrigin(apiOrigin);
  const owns = (origin: string | null) => origin === apiOrigin || (origin === null && ownsUnstamped);
  const doInvoke: InvokeFn = async (cmd, args) => {
    if (invokeFn) return invokeFn(cmd, args);
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
  };
  const read = (name: string) => doInvoke<string | null>('session_secret_get', { name });
  const write = (name: string, value: string) => doInvoke<void>('session_secret_set', { name, value });
  const remove = (name: string) => doInvoke<void>('session_secret_delete', { name });

  // A store that never answers (no Secret Service on this Linux box) is asked
  // again on every retry: the failure is reported once, and again only after
  // it answered in between
  let unavailableReported = false;
  function reportUnavailable(level: 'warn' | 'error', message: string, err: unknown): void {
    if (unavailableReported) return;
    unavailableReported = true;
    console[level](message, describe(err));
  }
  function reportReachable(): void {
    if (!unavailableReported) return;
    unavailableReported = false;
    console.info('[Session] OS credential store reachable again');
  }

  /** Move a value the webview kept on disk into the keychain; the disk copy goes only once the keychain provably holds it. */
  async function migrate(name: string, value: string, removeLegacy: () => void): Promise<void> {
    await write(name, value);
    if ((await read(name)) === value) {
      removeLegacy();
      console.info(`[Session] ${name} moved from the page's storage to the OS credential store`);
    } else {
      console.error(`[Session] The OS credential store did not keep ${name} — the on-disk copy stays until it does`);
    }
  }

  /** An entry of ours written before the stamp, rewritten with it; a failure only logs (the entry still reads as ours). */
  async function stamp(name: string, value: string): Promise<void> {
    try {
      await write(name, value);
    } catch (err) {
      console.warn(`[Session] Could not stamp ${name} with its server:`, describe(err));
    }
  }

  let foreignReported = false;
  function reportForeign(): void {
    if (foreignReported) return;
    foreignReported = true;
    console.info('[Session] The OS credential store holds a session of another Voxium build (another server) — not used here');
  }

  return {
    async load() {
      // The copies older builds left in the page's storage carry no origin:
      // the official service's, read by an official build only
      const legacy = ownsUnstamped ? legacyCopies() : NO_LEGACY_COPIES;
      let pair: TokenPair | null = null;
      let remembered = false;
      try {
        // The pair first, on its own: it decides whether there is a session.
        // Sequential, not parallel — a locked keychain prompts once per read
        const stored = decodePair(await read(TOKENS_ENTRY));
        if (stored && !owns(stored.origin)) reportForeign();
        if (stored && owns(stored.origin)) {
          pair = stored.value;
          remembered = true;
          // The keychain is authoritative: a stale copy on disk is a credential too
          if (ownsUnstamped) removeLegacyPairs();
          if (stored.origin === null) await stamp(TOKENS_ENTRY, encodePair(pair.accessToken, pair.refreshToken, apiOrigin));
        } else if (legacy.local) {
          await migrate(TOKENS_ENTRY, encodePair(legacy.local.accessToken, legacy.local.refreshToken, apiOrigin), () => removePair(localStorage));
          pair = legacy.local;
          remembered = true;
          removePair(sessionStorage);
        } else if (legacy.session) {
          // A not-remembered session of an older build: in memory only from here
          pair = legacy.session;
          removePair(sessionStorage);
        }
        reportReachable();
      } catch (err) {
        // The store did not answer. A copy an older build left on disk is a
        // real answer for this run (and stays, for the next attempt); with
        // none there is no session to restore YET — not "no session"
        pair = legacy.local ?? legacy.session;
        if (pair || legacy.trusted) {
          reportUnavailable('warn', '[Session] OS credential store unavailable — using the copy an older build left on disk for this run:', err);
        } else {
          reportUnavailable('error', '[Session] OS credential store unavailable — a remembered session cannot be restored yet:', err);
        }
        return {
          accessToken: pair?.accessToken ?? null,
          refreshToken: pair?.refreshToken ?? null,
          remembered: legacy.local !== null,
          trustedDeviceToken: legacy.trusted,
          reachable: false,
        };
      }

      // The trusted-device token on its own: a failure here must not cost
      // the session that was just read. Same origin rule as the pair
      let trustedDeviceToken: string | null = legacy.trusted;
      try {
        const stored = decodeTrusted(await read(TRUSTED_DEVICE_ENTRY));
        if (stored && !owns(stored.origin)) reportForeign();
        if (stored && owns(stored.origin)) {
          trustedDeviceToken = stored.value;
          if (ownsUnstamped) localStorage.removeItem(TRUSTED_DEVICE_KEY);
          if (stored.origin === null) await stamp(TRUSTED_DEVICE_ENTRY, encodeTrusted(stored.value, apiOrigin));
        } else if (legacy.trusted) {
          await migrate(TRUSTED_DEVICE_ENTRY, encodeTrusted(legacy.trusted, apiOrigin), () => localStorage.removeItem(TRUSTED_DEVICE_KEY));
        }
      } catch (err) {
        console.warn('[Session] The trusted-device token could not be read from the OS credential store (the device may need its TOTP code once):', describe(err));
      }

      return {
        accessToken: pair?.accessToken ?? null,
        refreshToken: pair?.refreshToken ?? null,
        remembered,
        trustedDeviceToken,
        reachable: true,
      };
    },
    async saveTokens(accessToken, refreshToken, remembered) {
      removeLegacyPairs();
      if (remembered) await write(TOKENS_ENTRY, encodePair(accessToken, refreshToken, apiOrigin));
      else await remove(TOKENS_ENTRY);
    },
    async clearTokens() {
      removeLegacyPairs();
      await remove(TOKENS_ENTRY);
    },
    async saveTrustedDeviceToken(token) {
      removeTrustedCopy();
      await write(TRUSTED_DEVICE_ENTRY, encodeTrusted(token, apiOrigin));
    },
    async clearTrustedDeviceToken() {
      removeTrustedCopy();
      await remove(TRUSTED_DEVICE_ENTRY);
    },
  };
}

// ─── The module: memory, write-through, hydration ────────────────────────────

const EMPTY: StoredSession = { accessToken: null, refreshToken: null, remembered: false, trustedDeviceToken: null };

function selectStore(): SessionStore {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return isTauri ? createKeychainSessionStore() : webSessionStore;
}

let memory: StoredSession = EMPTY;
let store: SessionStore = selectStore();
// Writes run in order on one chain; a load runs on it too, so a write queued
// while the store is still being read lands after the read (and wins)
let chain: Promise<void> = Promise.resolve();
// Bumped by the test reset: an operation queued before it runs against nothing
let generation = 0;
let hydrated = false;
let hydration: Promise<boolean> | null = null;
// Set by the first write of each slot: a load that lands afterwards must not
// put the stored values back over them
let tokensWritten = false;
let trustedWritten = false;
// Writes of the pair this tab queued and the store has not applied yet: the
// memory is newer than the page's storage meanwhile, and a re-read of that
// storage (followSharedSession) must not put the older pair back over it
let pendingTokenWrites = 0;

function enqueue(what: string, op: (target: SessionStore) => void | Promise<void>): void {
  const target = store;
  const queuedIn = generation;
  chain = chain
    .then(() => {
      if (queuedIn !== generation) return;
      return op(target);
    })
    .catch((err) => {
      console.error(`[Session] ${what}:`, describe(err));
    });
}

/** A write of the pair: queued like any other, counted until the store has it (or refused it). */
function enqueueTokenWrite(what: string, op: (target: SessionStore) => void | Promise<void>): void {
  const queuedIn = generation;
  pendingTokenWrites++;
  enqueue(what, async (target) => {
    try {
      await op(target);
    } finally {
      // An operation of a store the test reset replaced settles nothing of today's count
      if (queuedIn === generation) pendingTokenWrites = Math.max(0, pendingTokenWrites - 1);
    }
  });
}

export function getAccessToken(): string | null {
  return memory.accessToken;
}

export function getRefreshToken(): string | null {
  return memory.refreshToken;
}

/** True while a session is held in the slot that survives a restart ("remember me"). */
export function isRemembered(): boolean {
  return memory.accessToken !== null && memory.remembered;
}

/**
 * Store a token pair.
 * - rememberMe=true  → the persistent slot (survives an app restart)
 * - rememberMe=false → this process only (the browser: sessionStorage)
 * - rememberMe omitted → the slot the current pair is in (a renewal keeps the choice made at sign-in)
 */
export function setTokens(accessToken: string, refreshToken: string, rememberMe?: boolean): void {
  const remembered = rememberMe ?? memory.remembered;
  storePair(accessToken, refreshToken, remembered);
  // The not-remembered tabs of the same session (a duplicated, restored or
  // opener tab) hold copies nothing else keeps current
  if (!remembered) announceRotation(accessToken, refreshToken);
}

function storePair(accessToken: string, refreshToken: string, remembered: boolean): void {
  memory = { ...memory, accessToken, refreshToken, remembered };
  tokensWritten = true;
  enqueueTokenWrite('Could not persist the session', (s) => s.saveTokens(accessToken, refreshToken, remembered));
}

// ─── The not-remembered tabs of one session (the browser build) ──────────────
//
// "Remember me" off keeps the pair in sessionStorage, which belongs to one
// tab. A duplicated, restored or opener tab starts with a COPY of it: two
// tabs on one session, and nothing kept them in step. Every renewal now
// replaces the refresh token, so the tab that did not renew would present a
// replaced one, which the server treats as reused once its grace window has
// passed. So every pair stored for a not-remembered session is posted on a
// BroadcastChannel ('rotated': a renewal, a password change, the answer of
// "sign out of all other sessions"), and a tab whose own pair names the same
// session (`sid`) at a lower generation (`gen`), both decoded for routing
// only, takes it. A sign-out posts 'ended' with the sid, and such a tab
// forgets its pair and reloads, signed out. A tab whose pair is remembered
// ignores the channel: it follows the `storage` events. A pair that names no
// session is never touched.
//
// The messages carry tokens. A BroadcastChannel reaches only the browsing
// contexts of this same origin (and the same storage partition): exactly
// those that can read this origin's localStorage, where any remembered
// session of this browser sits in full. They are never logged; a message is
// checked field by field and anything else in it is ignored.

/** The channel's name: one per origin, like the page's storage. */
export const SESSION_CHANNEL_NAME = 'voxium-session';
/** A token longer than this is no token of ours (the keychain caps the whole pair at 1280 characters). */
const CHANNEL_TOKEN_MAX_CHARS = 4096;

/** The part of BroadcastChannel used here (injectable for tests). */
export interface SessionChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

type SessionMessage =
  | { type: 'rotated'; sid: string; accessToken: string; refreshToken: string }
  | { type: 'ended'; sid: string };

// The page's BroadcastChannel unless a test installed its own (null: none)
let channelFactory: (() => SessionChannel) | null | undefined;
let channel: SessionChannel | null = null;
let channelTried = false;

function openChannel(): (() => SessionChannel) | null {
  if (channelFactory !== undefined) return channelFactory;
  const Channel = typeof window !== 'undefined' ? window.BroadcastChannel : undefined;
  return typeof Channel === 'function' ? () => new Channel(SESSION_CHANNEL_NAME) as unknown as SessionChannel : null;
}

/** The channel, opened on first use, in the browser build only (the desktop app has one webview). */
function sessionChannel(): SessionChannel | null {
  if (!isWebStore(store)) return null;
  if (channel || channelTried) return channel;
  channelTried = true;
  const open = openChannel();
  if (!open) return null;
  try {
    channel = open();
    channel.onmessage = (event) => onSessionMessage(event.data);
  } catch (err) {
    console.warn('[Session] The channel between the tabs of a session could not be opened:', describe(err));
    channel = null;
  }
  return channel;
}

function post(message: SessionMessage): void {
  const target = sessionChannel();
  if (!target) return;
  try {
    target.postMessage(message);
  } catch (err) {
    console.warn('[Session] Could not tell the other tabs of this session:', describe(err));
  }
}

function announceRotation(accessToken: string, refreshToken: string): void {
  const sid = sessionIdOf(refreshToken);
  if (sid === null || sessionIdOf(accessToken) !== sid) return;
  post({ type: 'rotated', sid, accessToken, refreshToken });
}

/**
 * A sign-out of this tab: the not-remembered tabs of the same session (named
 * by `sessionToken`, any token of it) forget their copy of its pair. Nothing
 * outside the browser build, nothing for a token that names no session.
 */
export function announceSessionEnded(sessionToken: string | null): void {
  const sid = sessionIdOf(sessionToken);
  if (sid === null) return;
  post({ type: 'ended', sid });
}

function isTokenString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CHANNEL_TOKEN_MAX_CHARS;
}

function sessionMessageOf(data: unknown): SessionMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, sid, accessToken, refreshToken } = data as Record<string, unknown>;
  if (!isTokenString(sid)) return null;
  if (type === 'ended') return { type, sid };
  if (type === 'rotated' && isTokenString(accessToken) && isTokenString(refreshToken)) return { type, sid, accessToken, refreshToken };
  return null;
}

function onSessionMessage(data: unknown): void {
  if (!isWebStore(store) || reloadPending()) return;
  const message = sessionMessageOf(data);
  // A remembered pair follows the storage events; a tab without a pair has no session to keep current
  if (!message || memory.remembered || memory.accessToken === null || memory.refreshToken === null) return;
  const own = readTokenClaims(memory.refreshToken);
  if (!own?.sid || own.sid !== message.sid) return;
  if (message.type === 'ended') {
    // The other tab signed this session out: this copy goes with it
    clearSessionTokens(memory.refreshToken);
    console.info('[Session] Another tab signed this session out — reloading');
    reloadAfterSessionChange();
    return;
  }
  const theirs = readTokenClaims(message.refreshToken);
  if (theirs?.sid !== message.sid || sessionIdOf(message.accessToken) !== message.sid) return;
  if (own.gen === undefined || theirs.gen === undefined || theirs.gen <= own.gen) return;
  // Taken as this tab's own pair, without posting it again
  storePair(message.accessToken, message.refreshToken, false);
}

/** Open the channel when this tab holds a not-remembered pair, so it hears its twins from its start. */
function listenWhenNotRemembered(): void {
  if (memory.refreshToken !== null && !memory.remembered) sessionChannel();
}

/** @internal tests: the channel factory (undefined: the page's BroadcastChannel, null: none). */
export function _setSessionChannelForTests(factory: (() => SessionChannel) | null | undefined): void {
  channel?.close();
  channel = null;
  channelTried = false;
  channelFactory = factory;
}

/**
 * Forget the pair: in memory and in the page's storage now, in the store in
 * turn, whoever's session it is. For a sign-in replacing whatever this device
 * holds; a session that ENDS is forgotten with clearSessionTokens.
 */
export function clearTokens(): void {
  memory = { ...memory, accessToken: null, refreshToken: null };
  tokensWritten = true;
  removeLegacyPairs();
  enqueueTokenWrite('Could not clear the stored session', (s) => s.clearTokens());
}

/** The pair the web store holds where this tab follows it: the remembered pair (any tab's), else this tab's own not-remembered one. */
function followedWebPair(apiOrigin: string): TokenPair | null {
  const remembered = markedOwn(SESSION_ORIGIN_KEY, apiOrigin) ? readPair(localStorage) : null;
  if (remembered) return remembered;
  if (memory.remembered) return null;
  const mark = sessionStorage.getItem(SESSION_ORIGIN_KEY);
  return mark === null || mark === apiOrigin ? readPair(sessionStorage) : null;
}

/** Every copy of the ended session's pair the page's storage holds, gone — and no other. */
function removeEndedSessionCopies(endedToken: string, options: SameSessionOptions): void {
  for (const area of [localStorage, sessionStorage]) {
    const pair = readPair(area);
    if (pair && isSameSession(pair, endedToken, options)) removePair(area);
  }
}

/**
 * A session ended on this device (a sign-out, a refusal, the server's word,
 * an account deletion): forget its pair, as clearTokens does — but only
 * while the pair stored where this tab follows it is still of that session
 * (`endedToken` is any token of it, access or refresh; the session is told
 * by its `sid`, or by the very token when it names none). When another tab
 * stored a different session meanwhile (a sign-in, as anyone), that pair is
 * left as it is, every copy of the ended session is removed, the memory lets
 * go of both, and 'replaced' is answered: the caller reloads the page onto
 * the stored session (reloadAfterSessionChange) instead of signing out a
 * session that is not the one that ended. `null` (nothing to compare with)
 * clears this tab's own pair as clearTokens does. In the desktop app the
 * memory is the store.
 *
 * A tab with no session of its own to end touches nothing but its memory
 * (letGoOfSession): when its memory holds no token (it let go already:
 * another tab signed out, or in as someone else), and while a reload of the
 * page onto another session is pending (what the memory holds then, if
 * anything, is not this page's to clear).
 *
 * `accountWide`: the whole account's sessions ended (a ban, a deletion); a
 * token issued before sessions then also matches a stored pair of its
 * account (tokenClaims.isSameSession).
 */
export function clearSessionTokens(endedToken: string | null, options: SameSessionOptions = {}): 'cleared' | 'replaced' {
  if (reloadPending() || (memory.accessToken === null && memory.refreshToken === null)) return letGoOfSession();
  if (endedToken !== null) {
    const stored = isWebStore(store)
      ? followedWebPair(store.apiOrigin)
      : memory.accessToken !== null && memory.refreshToken !== null
        ? { accessToken: memory.accessToken, refreshToken: memory.refreshToken }
        : null;
    if (stored && !isSameSession(stored, endedToken, options)) {
      memory = { ...memory, accessToken: null, refreshToken: null };
      if (isWebStore(store)) {
        removeEndedSessionCopies(endedToken, options);
        // after a write of this tab still queued, which may be the ended session's
        enqueueTokenWrite('Could not clear the ended session', () => removeEndedSessionCopies(endedToken, options));
      }
      return 'replaced';
    }
  }
  clearTokens();
  return 'cleared';
}

/**
 * This tab has no session of its own to end: its memory is signed out, and
 * nothing else is touched (no storage, no store, no other tab). 'replaced'
 * while a reload onto another session is pending (the caller does not go to
 * the sign-in page: the reload stands), 'cleared' otherwise.
 */
export function letGoOfSession(): 'cleared' | 'replaced' {
  memory = { ...memory, accessToken: null, refreshToken: null };
  return reloadPending() ? 'replaced' : 'cleared';
}

// What reloads the page onto the stored session, replaceable for tests (jsdom cannot navigate)
let reloadPage: () => void = () => {
  window.location.reload();
};

/**
 * A reload of this page onto another session is pending: nothing more is
 * taken from the storage, the channel or the memory for this page, and
 * nothing is sent on its behalf. A trip to the sign-in page pending instead
 * is not this (its page is signed out already, and may still learn why).
 */
function reloadPending(): boolean {
  return pendingPageNavigation() === 'reload';
}

/** Whether a reload of this page onto another session is pending (reloadAfterSessionChange). */
export function isReloadPending(): boolean {
  return reloadPending();
}

/**
 * Reload the page onto whatever session the storage holds now: once, after
 * the queued writes have landed (a reload that outran them would load a
 * stale pair) and after an account deletion of this client in flight has
 * finished its local clean-up (services/accountDeletion.ts). For a tab whose
 * session another tab replaced: its screen belongs to the session that was
 * there before. It is the page's one navigation (services/pageNavigation.ts):
 * a trip to the sign-in page asked for first stands, and one asked for after
 * this goes nowhere.
 */
export function reloadAfterSessionChange(): void {
  if (!claimPageNavigation('reload')) return;
  void flushTokenStorage()
    .then(() => accountDeletionSettled())
    .then(() => reloadPage());
}

/** @internal tests: what reloads, and a fresh page load (no navigation asked for yet) */
export function _setPageReloadForTests(fn: () => void): void {
  reloadPage = fn;
  _resetPageNavigationForTests();
}

export function getTrustedDeviceToken(): string | null {
  return memory.trustedDeviceToken;
}

export function setTrustedDeviceToken(token: string): void {
  memory = { ...memory, trustedDeviceToken: token };
  trustedWritten = true;
  enqueue('Could not persist the trusted-device token', (s) => s.saveTrustedDeviceToken(token));
}

export function clearTrustedDeviceToken(): void {
  memory = { ...memory, trustedDeviceToken: null };
  trustedWritten = true;
  removeTrustedCopy();
  enqueue('Could not clear the trusted-device token', (s) => s.clearTrustedDeviceToken());
}

/**
 * Load the memory from the store. Once per launch when the store answers;
 * a store that did not answer is asked again by the next call. A slot
 * written before the store answered keeps the written value, and the store
 * is brought up to date with it (a renewal made while the store was down
 * must not be the one copy that never gets persisted). Resolves whether the
 * store answered. Never rejects. Shared by concurrent callers.
 */
export function hydrateTokens(): Promise<boolean> {
  if (hydrated) return Promise.resolve(true);
  if (hydration) return hydration;
  hydration = new Promise<boolean>((resolve) => {
    enqueue('Could not read the stored session', async (s) => {
      let reachable = false;
      try {
        const loaded = await s.load();
        if (!tokensWritten) {
          memory = { ...memory, accessToken: loaded.accessToken, refreshToken: loaded.refreshToken, remembered: loaded.remembered };
        }
        if (!trustedWritten) {
          memory = { ...memory, trustedDeviceToken: loaded.trustedDeviceToken };
        }
        listenWhenNotRemembered();
        reachable = loaded.reachable;
        if (reachable) await resyncWrittenSlots(s);
      } catch (err) {
        console.error('[Session] Could not read the stored session:', describe(err));
      }
      hydrated = reachable;
      resolve(reachable);
    });
  }).finally(() => {
    hydration = null;
  });
  return hydration;
}

/** After a load: the slots the memory already owns are written to the store as they are. */
async function resyncWrittenSlots(s: SessionStore): Promise<void> {
  if (tokensWritten) {
    const { accessToken, refreshToken, remembered } = memory;
    if (accessToken !== null && refreshToken !== null) await s.saveTokens(accessToken, refreshToken, remembered);
    else await s.clearTokens();
  }
  if (trustedWritten) {
    const { trustedDeviceToken } = memory;
    if (trustedDeviceToken !== null) await s.saveTrustedDeviceToken(trustedDeviceToken);
    else await s.clearTrustedDeviceToken();
  }
}

/**
 * Resolve once every write queued so far has reached the store — or after
 * `timeoutMs`, with a warning, so a hung store cannot hold a page reload
 * forever. Never rejects (a failed write was logged where it failed).
 */
export function flushTokenStorage(timeoutMs: number = TOKEN_STORAGE_FLUSH_TIMEOUT_MS): Promise<void> {
  const pending = chain;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[Session] The stored session did not finish writing in time — going ahead');
      resolve();
    }, timeoutMs);
    void pending.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// The web client in another tab signed out, or in as someone else: this tab's
// memory follows (the read-through getters it replaced did so by nature). A
// `storage` event fires in the OTHER tabs only, for localStorage only — a
// not-remembered session (sessionStorage) is this tab's own and is left alone
// when a remembered one goes away elsewhere.
function isWebStore(s: SessionStore): s is WebSessionStore {
  return 'apiOrigin' in s;
}

/**
 * Whether the session store is shared with other tabs (the browser build:
 * every tab of one browser reads and writes the same page storage). False in
 * the desktop app, whose one webview holds the session alone: there the
 * renewal takes no lock and reads nothing again.
 */
export function isSharedWithOtherTabs(): boolean {
  return isWebStore(store);
}

/** An unmarked value is the page's own, as at load; one marked for another server is not this build's to send anywhere. */
function markedOwn(originKey: string, apiOrigin: string): boolean {
  const mark = localStorage.getItem(originKey);
  return mark === null || mark === apiOrigin;
}

/** The memory follows the trusted-device token another tab stored (or removed). */
function followTrustedDeviceToken(apiOrigin: string): void {
  memory = { ...memory, trustedDeviceToken: markedOwn(TRUSTED_DEVICE_ORIGIN_KEY, apiOrigin) ? localStorage.getItem(TRUSTED_DEVICE_KEY) : null };
}

/**
 * Whether `pair` belongs to an account other than the one this page shows:
 * the signed-in user (authStore registers it, services/e2e/session.ts)
 * against the pair's `userId`, decoded for routing only. Nobody signed in,
 * or a pair that cannot be decoded, is never another account: the page
 * follows it as it always did, and nothing reloads in a loop.
 */
function belongsToAnotherAccount(pair: TokenPair): boolean {
  return isTokenOfAnotherAccount(pair.accessToken) || isTokenOfAnotherAccount(pair.refreshToken);
}

/**
 * Whether `token` belongs to an account other than the one this page shows
 * (the same rule as belongsToAnotherAccount, for one token): the REST
 * client sends no such token and retries with none.
 */
export function isTokenOfAnotherAccount(token: string | null): boolean {
  const signedIn = currentE2ESessionUser();
  if (!signedIn) return false;
  const owner = userIdOf(token);
  return owner !== null && owner !== signedIn;
}

/**
 * The memory follows the remembered pair another tab stored (any tab's
 * sign-in takes over every tab), or its removal. A pair of ANOTHER account
 * than the one on screen is not taken: a page that showed account X while
 * holding account Y's tokens would act as Y under X's name. The memory lets
 * go of the pair instead and the page reloads onto the stored session.
 */
function followRememberedPair(apiOrigin: string): 'followed' | 'reloading' {
  if (reloadPending()) return 'reloading';
  const pair = markedOwn(SESSION_ORIGIN_KEY, apiOrigin) ? readPair(localStorage) : null;
  if (pair) {
    const changed = pair.accessToken !== memory.accessToken || pair.refreshToken !== memory.refreshToken;
    if (changed && belongsToAnotherAccount(pair)) {
      memory = { ...memory, accessToken: null, refreshToken: null };
      console.info('[Session] Another tab signed in to another account — reloading onto it');
      reloadAfterSessionChange();
      return 'reloading';
    }
    memory = { ...memory, accessToken: pair.accessToken, refreshToken: pair.refreshToken, remembered: true };
  } else if (memory.remembered) {
    memory = { ...memory, accessToken: null, refreshToken: null };
  }
  return 'followed';
}

function followOtherTabs(event: StorageEvent): void {
  if (!isWebStore(store) || event.storageArea !== localStorage) return;
  const { apiOrigin } = store;
  const wholeStore = event.key === null;
  if (wholeStore || event.key === TRUSTED_DEVICE_KEY || event.key === TRUSTED_DEVICE_ORIGIN_KEY) {
    followTrustedDeviceToken(apiOrigin);
  }
  if (wholeStore || event.key === ACCESS_KEY || event.key === REFRESH_KEY || event.key === SESSION_ORIGIN_KEY) {
    followRememberedPair(apiOrigin);
  }
}

/**
 * Bring the memory up to date with what other tabs stored, as the `storage`
 * events would have: the renewal calls it before every refresh request,
 * before acting on a refusal and before storing an answer. A tab whose memory
 * missed those events (it sat in the back-forward cache, or the browser froze
 * it) would otherwise send a refresh token another tab has already replaced,
 * which the server treats as reused once its grace window has passed, ending
 * the session for every tab. Nothing is read while a write of this tab's own
 * is still queued (its memory is newer than the storage then), and nothing at
 * all outside the browser build. 'reloading' when the storage holds another
 * account's session than the one on screen: the page is reloading onto it,
 * and the caller sends nothing more.
 */
export function followSharedSession(): 'followed' | 'reloading' {
  if (reloadPending()) return 'reloading';
  if (!isWebStore(store) || pendingTokenWrites > 0) return 'followed';
  const { apiOrigin } = store;
  followTrustedDeviceToken(apiOrigin);
  return followRememberedPair(apiOrigin);
}

// The desktop app has one webview: nothing to follow there
if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
  window.addEventListener('storage', followOtherTabs);
}

/** @internal tests — empties the memory and installs a store (the one for this environment when omitted). */
export function _resetTokenStorageForTests(backend?: SessionStore): void {
  generation++;
  memory = EMPTY;
  store = backend ?? selectStore();
  chain = Promise.resolve();
  hydrated = false;
  hydration = null;
  tokensWritten = false;
  trustedWritten = false;
  pendingTokenWrites = 0;
  _resetPageNavigationForTests();
  _setSessionChannelForTests(undefined);
}
