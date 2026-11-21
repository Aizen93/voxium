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
import { endSessionOnServer } from './sessionRevocation';
import { currentE2ESessionUser } from './e2e/session';
import { isSameSession, readTokenClaims, sessionIdOf, userIdOf, type SameSessionOptions } from './tokenClaims';
import { sha256Hex } from '../utils/sha256';

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
// A twin that missed those messages (restored with its sessionStorage,
// discarded and reloaded by the browser, kept in the back-forward cache)
// starts with an older generation. So a tab that loads a not-remembered pair,
// or comes back from the back-forward cache, asks: 'sync' with its sid and
// gen, never a token. A twin that holds the same session at a HIGHER
// generation answers with its pair as 'rotated', the one message that carries
// tokens, at most once per TWIN_SYNC_ANSWER_INTERVAL_MS. The asking tab's next
// renewal waits TWIN_SYNC_WAIT_MS after the ask, the whole of it: twins at
// different generations may all answer, and each answer newer than what the
// tab holds is taken, so the newest one received is held when the wait ends.
// Then it sends what it holds.
//
// The messages carry tokens, and the channel reaches farther than the
// storage a not-remembered pair lives in. That pair sits in one tab's
// sessionStorage, which no other context can read; a BroadcastChannel
// delivers to every context of this origin (and storage partition) that
// listens on its name: the other tabs, whatever account they show, and
// workers, which have no localStorage at all. So a not-remembered pair is
// handed to all of them at every renewal ('rotated'), and, since 'sync', on
// request to any of them that knows the session's id. That is accepted: the
// twins of one session can be kept in step only by handing them its pair,
// and every context of this origin runs the app's own code, which can read
// the page's remembered session in localStorage anyway. The messages are
// never logged; a message is checked field by field and anything else in it
// is ignored.

/** The channel's name: one per origin, like the page's storage. */
export const SESSION_CHANNEL_NAME = 'voxium-session';
/** A token longer than this is no token of ours (the keychain caps the whole pair at 1280 characters). */
const CHANNEL_TOKEN_MAX_CHARS = 4096;
/** A generation above this is no generation the server issues (it counts the renewals of one session). */
const CHANNEL_GEN_MAX = 2 ** 31;

/**
 * How long after a tab asked its twins ('sync') its next renewal waits for
 * their answer. A twin answers from its own event loop: a message each way
 * between two tabs of one browser on one machine, a few milliseconds, or the
 * length of a long task the twin is running (a render, a decrypt batch),
 * usually well under 200 ms. 300 ms covers that with room, and costs the
 * renewal that waits (every request waits on it) about a third of a second,
 * once per page load, only for a not-remembered tab whose access token has
 * expired by then. A twin frozen by the browser answers nothing: the tab then
 * sends what it holds, as before.
 */
export const TWIN_SYNC_WAIT_MS = 300;

/** The part of BroadcastChannel used here (injectable for tests). */
export interface SessionChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

type SessionMessage =
  | { type: 'rotated'; sid: string; accessToken: string; refreshToken: string }
  | { type: 'ended'; sid: string }
  | { type: 'sync'; sid: string; gen: number };

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
  const { gen } = data as Record<string, unknown>;
  if (type === 'sync' && typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0 && gen <= CHANNEL_GEN_MAX) return { type, sid, gen };
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
  if (message.type === 'sync') {
    // A twin asks for the newest pair of this session. Answered only when it
    // names this tab's own not-remembered session (the guards above) at an
    // OLDER generation than this tab holds: anything else (another session,
    // the same or a newer generation, a remembered tab, a malformed message)
    // is never answered, and an answer goes out at most once per
    // TWIN_SYNC_ANSWER_INTERVAL_MS (answerSync). A sid and a generation are
    // claims, not proof of holding a token: a context of this origin that
    // learnt the sid (the account's own pages list its sessions, an 'ended'
    // or 'sync' message names it) could ask too, and would get the pair that
    // every renewal of this session posts to every context listening (see
    // the section comment for why that is accepted)
    if (own.gen === undefined || message.gen >= own.gen) return;
    answerSync(message.sid, message.gen);
    return;
  }
  const theirs = readTokenClaims(message.refreshToken);
  if (theirs?.sid !== message.sid || sessionIdOf(message.accessToken) !== message.sid) return;
  if (own.gen === undefined || theirs.gen === undefined || theirs.gen <= own.gen) return;
  // Taken as this tab's own pair, without posting it again. It ends no wait
  // for the twins: a twin at a still higher generation may answer after it
  storePair(message.accessToken, message.refreshToken, false);
}

/**
 * The shortest time between two answers of this tab to a 'sync'. One answer
 * is a broadcast that reaches every twin listening, so it serves every
 * question that came before it; a question that arrives within the interval
 * is answered once, when the interval ends, by one answer for all of them,
 * re-checked then (answerSync). 100 ms keeps that answer well inside the
 * asker's TWIN_SYNC_WAIT_MS (300 ms) and bounds what any number of questions
 * can make a tab post to 10 pairs a second.
 */
export const TWIN_SYNC_ANSWER_INTERVAL_MS = 100;

// When this tab last answered a 'sync', and the one answer it still owes
let lastSyncAnswerAt = Number.NEGATIVE_INFINITY;
let owedSyncAnswer: { sid: string; lowestGen: number; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Answer a twin's 'sync' for this tab's session `sid`, asked from generation
 * `askedGen`: now, unless this tab answered less than
 * TWIN_SYNC_ANSWER_INTERVAL_MS ago; then once, when the interval ends, for
 * every question of the meantime (from the lowest generation asked).
 */
function answerSync(sid: string, askedGen: number): void {
  if (owedSyncAnswer) {
    if (owedSyncAnswer.sid === sid) owedSyncAnswer.lowestGen = Math.min(owedSyncAnswer.lowestGen, askedGen);
    return;
  }
  // a clock set back must not hold an answer for longer than the interval
  const wait = Math.min(lastSyncAnswerAt + TWIN_SYNC_ANSWER_INTERVAL_MS - Date.now(), TWIN_SYNC_ANSWER_INTERVAL_MS);
  if (wait <= 0) {
    postPairAnswering(sid, askedGen);
    return;
  }
  const owed = {
    sid,
    lowestGen: askedGen,
    timer: setTimeout(() => {
      if (owedSyncAnswer !== owed) return;
      owedSyncAnswer = null;
      postPairAnswering(owed.sid, owed.lowestGen);
    }, wait),
  };
  owedSyncAnswer = owed;
}

/** This tab's pair as the answer to a 'sync' for `sid` from `askedGen`, while this tab still answers it (checked again now). */
function postPairAnswering(sid: string, askedGen: number): void {
  if (!isWebStore(store) || reloadPending() || memory.remembered || memory.accessToken === null || memory.refreshToken === null) return;
  const own = readTokenClaims(memory.refreshToken);
  if (own?.sid !== sid || own.gen === undefined || askedGen >= own.gen) return;
  lastSyncAnswerAt = Date.now();
  announceRotation(memory.accessToken, memory.refreshToken);
}

// This tab's question to its twins, until a renewal has waited for it
let twinSync: { askedAt: number; waited: boolean } | null = null;

/**
 * Ask the twins of this tab's not-remembered session for its newest pair
 * ('sync': the sid and this tab's generation, decoded for routing only, and
 * no token). Nothing for a remembered pair, a pair that names no session or
 * no generation, while a reload is pending, without a channel, and outside
 * the browser build. True when the question went out.
 */
function askTwins(): boolean {
  if (!isWebStore(store) || reloadPending() || memory.remembered || memory.accessToken === null || memory.refreshToken === null) return false;
  const own = readTokenClaims(memory.refreshToken);
  if (!own?.sid || own.gen === undefined || sessionIdOf(memory.accessToken) !== own.sid) return false;
  if (!sessionChannel()) return false;
  twinSync = { askedAt: Date.now(), waited: false };
  post({ type: 'sync', sid: own.sid, gen: own.gen });
  return true;
}

/**
 * Whether this tab asked its twins and no renewal has waited for their
 * answer yet (services/session.ts asks this first, so that a renewal with
 * nothing to wait for awaits nothing).
 */
export function twinSyncPending(): boolean {
  return twinSync !== null && !twinSync.waited;
}

/**
 * Wait for the twins' answers to this tab's question until TWIN_SYNC_WAIT_MS
 * after it was asked, the whole of it, and once: a later renewal waits for
 * nothing. Every answer received meanwhile that is newer than what the tab
 * holds has been taken as its pair (onSessionMessage), so the newest of them
 * is held when this resolves. Never rejects.
 */
export function awaitTwinSync(): Promise<void> {
  const asked = twinSync;
  if (!asked || asked.waited) return Promise.resolve();
  asked.waited = true;
  const done = () => {
    if (twinSync === asked) twinSync = null;
  };
  // a clock set back must not stretch the wait past its length
  const remaining = Math.min(asked.askedAt + TWIN_SYNC_WAIT_MS - Date.now(), TWIN_SYNC_WAIT_MS);
  if (remaining <= 0) {
    done();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      done();
      resolve();
    }, remaining);
  });
}

/**
 * Open the channel when this tab holds a not-remembered pair, so it hears its
 * twins from its start, and ask them for the newest pair of its session.
 */
function listenWhenNotRemembered(): void {
  if (memory.refreshToken === null || memory.remembered) return;
  sessionChannel();
  askTwins();
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
 * `accountWide`: the whole account's sessions ended (a ban, a deletion): any
 * stored pair of the account `endedToken` names is then of the ended session,
 * whichever session it is (tokenClaims.isSameSession).
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
 *
 * A not-remembered tab that lets go of its OWN session this way (to follow
 * the remembered pair, or to reload onto it) abandons it: see
 * endAbandonedSession.
 */
function followRememberedPair(apiOrigin: string): 'followed' | 'reloading' {
  if (reloadPending()) return 'reloading';
  const pair = markedOwn(SESSION_ORIGIN_KEY, apiOrigin) ? readPair(localStorage) : null;
  if (pair) {
    const changed = pair.accessToken !== memory.accessToken || pair.refreshToken !== memory.refreshToken;
    const own = !memory.remembered && memory.accessToken !== null && memory.refreshToken !== null
      ? { accessToken: memory.accessToken, refreshToken: memory.refreshToken }
      : null;
    if (changed && belongsToAnotherAccount(pair)) {
      memory = { ...memory, accessToken: null, refreshToken: null };
      endAbandonedSession(own, pair);
      console.info('[Session] Another tab signed in to another account — reloading onto it');
      reloadAfterSessionChange();
      return 'reloading';
    }
    memory = { ...memory, accessToken: pair.accessToken, refreshToken: pair.refreshToken, remembered: true };
    endAbandonedSession(own, pair);
  } else if (memory.remembered) {
    memory = { ...memory, accessToken: null, refreshToken: null };
  }
  return 'followed';
}

/**
 * The not-remembered session this tab just let go of to follow a remembered
 * pair (`abandoned`, null when it held none), when that is another session
 * than the one it follows (`followed`): nothing of this page uses it again,
 * and every other tab of it follows the same remembered pair. So its copy
 * leaves this tab's sessionStorage (a reload would load it back, as a session
 * this tab already ended), and the server is told to end it, fire and forget
 * (services/sessionRevocation.ts). A pair that names no session is left alone:
 * one issued before sessions may be what the followed session was upgraded
 * from, and its sign-out would end that session too.
 */
function endAbandonedSession(abandoned: TokenPair | null, followed: TokenPair): void {
  if (!abandoned || sessionIdOf(abandoned.refreshToken) === null || isSameSession(followed, abandoned.refreshToken)) return;
  const copy = readPair(sessionStorage);
  if (copy && isSameSession(copy, abandoned.refreshToken)) removePair(sessionStorage);
  console.info('[Session] This tab follows the session another tab remembered — ending the one it held');
  endSessionOnServer(abandoned.refreshToken);
}

/**
 * Whether this tab holds, now, a pair of ANOTHER session of the same account
 * than the one `token` names: it let go of that session since, to follow
 * another (followRememberedPair, which asks the server to end the one it let
 * go of). An end of that session is then no end of anything this tab holds.
 * False when nothing is held, and for a token or a held pair that names no
 * session or no account (nothing tells them apart then).
 *
 * The shared storage is read again first (followSharedSession): the server
 * ends the session let go of, and tells its socket, as soon as another tab's
 * sign-in replaced it, which can be before this tab has handled the
 * `storage` event of that sign-in. The memory then still holds the session
 * let go of, and the end would be taken as this tab's own.
 */
export function holdsAnotherSessionOf(token: string | null): boolean {
  followSharedSession();
  const { accessToken, refreshToken } = memory;
  if (token === null || accessToken === null || refreshToken === null) return false;
  if (sessionIdOf(token) === null || sessionIdOf(refreshToken) === null) return false;
  if (isSameSession({ accessToken, refreshToken }, token)) return false;
  const owner = userIdOf(token);
  return owner !== null && owner === userIdOf(refreshToken);
}

/**
 * After a session ended and clearSessionTokens found another one stored in
 * its place ('replaced'), for a restore of the session at launch: the memory
 * takes up that stored session, read where this tab follows it (the
 * remembered pair, else this tab's own not-remembered one), so the restore
 * runs again on it instead of showing the sign-in page over a stored
 * session. Read once the queued writes have landed (the clear of the ended
 * session's copies is one of them): the caller flushes first. True when it
 * took a pair up. False, with nothing taken, in the desktop app (its memory
 * is its store, which only a reload reads again), while a reload is pending,
 * when nothing is stored, and for a pair of another account than the one on
 * screen (this page never holds one): the caller reloads then.
 */
export function takeUpStoredSession(): boolean {
  if (!isWebStore(store) || reloadPending()) return false;
  const { apiOrigin } = store;
  const remembered = markedOwn(SESSION_ORIGIN_KEY, apiOrigin) ? readPair(localStorage) : null;
  const pair = remembered ?? followedWebPair(apiOrigin);
  if (!pair || belongsToAnotherAccount(pair)) return false;
  memory = { ...memory, accessToken: pair.accessToken, refreshToken: pair.refreshToken, remembered: remembered !== null };
  followTrustedDeviceToken(apiOrigin);
  listenWhenNotRemembered();
  return true;
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

// ─── A credential change in flight, as every tab of the browser sees it ─────
//
// A password change or "sign out of all other sessions" moves the account to
// a new token version: once it commits, every refresh token of the old
// version is refused, and its answer carries the changing tab's new pair.
// Another tab of the account renewing meanwhile would send an old-version
// token, be refused, and clear the pair every tab shares. The Web Lock keeps
// the other tabs' renewals waiting while the change runs under it, but only
// for its bound (35 s, shorter than a change may take), and an origin without
// Web Locks has none. So the changing tab writes this mark into localStorage,
// which every tab of the browser build reads without a lock: "a change of
// this account is in flight until T". While it is live, a renewal in a tab
// holding a pair of that account waits for it, then takes what is stored
// (services/session.ts); a tab of another account ignores it.
//
// The mark is `<T>:<scope>`: T, a time on this device's clock in
// milliseconds, and the account's scope, the first 12 hexadecimal digits of
// the SHA-256 of a fixed label and the user id (accountScopeOf). Never the
// user id itself, never a token. The tab that wrote it removes it once its
// answer is stored (or the change failed), and when its session ends. A mark
// left behind (its tab was closed during the change) is removed by the first
// reader that finds it past its T, whatever its account, and only that very
// value (read, compared, removed: localStorage has no compare-and-remove, so
// a mark another tab writes between the read and the removal, in the same
// few microseconds, would go with it, and that change's tabs would not wait).
//
// Two changes of two accounts at once in one browser share the one key: the
// second mark replaces the first, and the first account's other tabs then no
// longer wait for its change. Their renewals may go out with tokens it makes
// old, be refused once it commits, and sign those tabs out (where Web Locks
// exist the two changes run one after the other under the renewal lock, so
// this takes an origin without them, or a change that outlasts the lock's
// bound). Each change's removal removes only its own mark.
//
// Nothing of this exists in the desktop app (one webview).

/** The localStorage key of a credential change in flight in a tab of this browser (the Cookie Policy lists it). */
const CREDENTIAL_CHANGE_MARK_KEY = 'voxium_credential_change';
/** A mark as this build writes it: T in milliseconds, a colon, the account's scope. */
const CREDENTIAL_CHANGE_MARK_RE = /^(\d{1,16}):([0-9a-f]{12})$/;
/** What the account's scope is a digest of, besides the user id: a scope matches no other digest of the id. */
const ACCOUNT_SCOPE_LABEL = 'voxium-credential-change:';
/**
 * A reader takes a mark's T as given only when it is at most this much
 * further ahead than a mark is ever written with: the device's clock may
 * have been set between the write and the read. A T further ahead is no mark
 * this app wrote (or a clock set far back) and is ignored rather than
 * holding the renewals for longer than a change can take.
 */
export const CREDENTIAL_CHANGE_MARK_TOLERANCE_MS = 5_000;
/** How often a wait for a mark reads it again, besides the `storage` events that tell of its removal. */
export const CREDENTIAL_CHANGE_MARK_POLL_MS = 250;

// The last scope computed (a wait reads the mark every 250 ms: one account, one digest)
let lastScope: { userId: string; scope: string } | null = null;

/**
 * The scope of an account in a credential change's mark: the first 12
 * hexadecimal digits of the SHA-256 of a fixed label and the user id. Short
 * and one-way: the mark tells the tabs of one account apart from another's
 * without writing the account down.
 */
export function accountScopeOf(userId: string): string {
  if (lastScope?.userId !== userId) lastScope = { userId, scope: sha256Hex(`${ACCOUNT_SCOPE_LABEL}${userId}`).slice(0, 12) };
  return lastScope.scope;
}

/** The account of the pair this tab holds (its refresh token's, else its access token's), decoded for routing only. */
function heldAccount(): string | null {
  return userIdOf(memory.refreshToken) ?? userIdOf(memory.accessToken);
}

/**
 * Publish, to every tab of the browser build, that a credential change of
 * this tab, for the account of the pair it holds, is in flight until `until`
 * (a time on this device's clock). Returns the removal, which removes the
 * mark only while it is still this one (another change may have written its
 * own since). Null in the desktop app, when the pair held names no account
 * (no tab could be told it is its account's), and when the page's storage
 * refuses the write (logged).
 */
export function markCredentialChange(until: number): (() => void) | null {
  if (!isWebStore(store)) return null;
  const account = heldAccount();
  if (account === null) return null;
  const value = `${Math.floor(until)}:${accountScopeOf(account)}`;
  try {
    localStorage.setItem(CREDENTIAL_CHANGE_MARK_KEY, value);
  } catch (err) {
    console.warn('[Session] The other tabs could not be told of the credential change:', describe(err));
    return null;
  }
  return () => removeMarkIfStill(value);
}

/** The mark, only while it is still `value` (see the section comment: read, compared, removed). */
function removeMarkIfStill(value: string): void {
  try {
    if (localStorage.getItem(CREDENTIAL_CHANGE_MARK_KEY) === value) localStorage.removeItem(CREDENTIAL_CHANGE_MARK_KEY);
  } catch (err) {
    console.warn('[Session] The mark of the credential change could not be removed:', describe(err));
  }
}

/**
 * The T of a credential change marked in flight in a tab of this browser for
 * the account of the pair this tab holds, while the mark is live: before T,
 * and T no further ahead than `maxAheadMs` (the longest a mark is written
 * for) plus the tolerance. Null otherwise: for a mark of another account,
 * for a tab whose pair names no account (or that holds none), for anything
 * that is not a mark this build writes, and in the desktop app. A mark past
 * its T is removed here, whatever its account: its tab never did.
 */
export function credentialChangeInFlightUntil(maxAheadMs: number, now: number = Date.now()): number | null {
  if (!isWebStore(store)) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(CREDENTIAL_CHANGE_MARK_KEY);
  } catch (err) {
    console.warn('[Session] The mark of a credential change could not be read:', describe(err));
    return null;
  }
  const mark = raw === null ? null : CREDENTIAL_CHANGE_MARK_RE.exec(raw);
  if (raw === null || mark === null) return null;
  const until = Number(mark[1]);
  if (until <= now) {
    removeMarkIfStill(raw);
    return null;
  }
  if (until - now > maxAheadMs + CREDENTIAL_CHANGE_MARK_TOLERANCE_MS) return null;
  const account = heldAccount();
  if (account === null || accountScopeOf(account) !== mark[2]) return null;
  return until;
}

/**
 * Wait while a credential change of this tab's account is marked in flight:
 * until its mark is removed (a `storage` event, or the next read every
 * CREDENTIAL_CHANGE_MARK_POLL_MS), or its T passes, whichever comes first
 * (at T the mark is read once more, which removes it if it is still there).
 * Resolves true when there was a change to wait for, false at once when there
 * was none (and in the desktop app). Never rejects.
 */
export function waitForCredentialChange(maxAheadMs: number): Promise<boolean> {
  const until = credentialChangeInFlightUntil(maxAheadMs);
  if (until === null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = () => {
      clearTimeout(deadline);
      clearInterval(poll);
      window.removeEventListener('storage', onStorage);
      resolve(true);
    };
    const check = () => {
      if (credentialChangeInFlightUntil(maxAheadMs) === null) done();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === CREDENTIAL_CHANGE_MARK_KEY || event.key === null)) check();
    };
    const deadline = setTimeout(() => {
      credentialChangeInFlightUntil(maxAheadMs);
      done();
    }, Math.max(0, until - Date.now()));
    const poll = setInterval(check, CREDENTIAL_CHANGE_MARK_POLL_MS);
    window.addEventListener('storage', onStorage);
  });
}

// The desktop app has one webview: nothing to follow there, and no twin
if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
  window.addEventListener('storage', followOtherTabs);
  // Back from the back-forward cache: the twins' messages of the meantime never arrived
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) askTwins();
  });
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
  twinSync = null;
  if (owedSyncAnswer) clearTimeout(owedSyncAnswer.timer);
  owedSyncAnswer = null;
  lastSyncAnswerAt = Number.NEGATIVE_INFINITY;
  lastScope = null;
}
