// One page owns each E2E vault (docs/e2e-dm-spec.md §7.4).
//
// Two tabs of one account used to run an E2E service each on ONE IndexedDB
// vault: each kept its own copy of the Olm account, the pairwise sessions and
// the outbound group sessions in memory, and the vault held whichever copy
// was saved last. So one page owns a vault at a time, and only that page
// starts a service on it:
//
// - LOCK MODE (navigator.locks, every secure context): an exclusive Web Lock
//   named after the vault, held by the page across every service of that
//   account it starts, and released only once the page is no longer signed
//   in to the account and its last service has finished its teardown. A page
//   that finds the lock taken waits in the lock's queue while it is visible
//   (and takes over by itself when the owner closes, crashes or signs out); a
//   hidden one leaves the queue until it is shown. Asked, the owner gives it
//   up ("Use it here"), and an owner that does not answer can be overtaken
//   ("Take over anyway", a steal). A first request that does not settle in
//   time leaves the page waiting, as a second tab does; a steal that does
//   not settle leaves it in fence mode for that vault.
// - FENCE MODE (no Web Locks: a page served over plain http; or a lock
//   manager that refused, or a steal that did not settle): the newest start
//   wins. It asks the other tabs first (a call running there is the person's
//   to end), then writes its token and tells them, and they stop; two starts
//   at once settle on the one whose token is on disk.
//
// In both, the vault itself refuses a write unless the token it holds is the
// page's (the fence, vault.ts): a page that has not heard yet that another
// one took over cannot write a ratchet, a session, a kept share or an
// acknowledgement, and every path that hands out ciphertext writes first.
//
// The BroadcastChannel carries courtesy messages only, never a secret: a
// digest of the vault's name (which account), a random id of the sending
// page, a random nonce per question, and, in an owner's answer, which kind of
// call it has running ('none', 'voice' or 'dm'). No token, no key, no user
// id. Nothing here decides safety on a message alone.
//
// Module state, one per page: services, stores and the gate (the screen
// shown instead of the app) all read the same ownership.
import {
  E2EVaultNotOwnedError,
  stampVaultOwner,
  vaultDbName,
  type VaultFence,
  type VaultOwnerStamp,
} from './vault';
import { currentE2ESessionUser } from './session';
import { sha256Hex } from '../../utils/sha256';

/** The call a page has running, as it answers a tab that asks before taking over. */
export type VaultCall = 'none' | 'voice' | 'dm';

/**
 * Where this page stands with a vault: never asked ('none'), finding out,
 * owning it, waiting for another tab to let it go, or having given it up
 * (only a reload comes back from that).
 */
export type VaultOwnershipState = 'none' | 'acquiring' | 'owned' | 'waiting' | 'lost';

/** Why a page gave a vault up. */
export type VaultLossReason = 'released' | 'stolen' | 'fenced' | 'taken' | 'bfcache';

export type VaultOwnershipMode = 'lock' | 'fence';

/** The part of the Web Locks API used here (injectable for tests). */
export interface VaultLockManager {
  request(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown
  ): Promise<unknown>;
}

/** The part of BroadcastChannel used here (injectable for tests). */
export interface VaultChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What the module reaches of the page; one injectable value, so a test fixes it. */
export interface VaultOwnershipEnvironment {
  locks: VaultLockManager | null;
  openChannel: (() => VaultChannel) | null;
  stamp: (vaultName: string, token: string, mode: 'claim' | 'keep') => Promise<VaultOwnerStamp>;
  visibility: () => 'visible' | 'hidden' | null;
  /** Calls `onChange` at every visibility change; returns the unsubscribe. */
  watchVisibility: (onChange: () => void) => () => void;
  /** Installs the pagehide / pageshow handlers (once). */
  watchPageLifecycle: (onHide: (persisted: boolean) => void, onShow: (persisted: boolean) => void) => void;
  session: () => StorageLike | null;
  local: () => StorageLike | null;
  reload: () => void;
}

/** The Web Lock of a vault: `voxium-e2e-vault:` and the vault's database name. */
export const VAULT_LOCK_PREFIX = 'voxium-e2e-vault:';
export const VAULT_CHANNEL_NAME = 'voxium-e2e-vault';
/** A tab that starts hidden asks for the lock this much later, or once shown: the visible tab of a restored session wins. */
export const HIDDEN_START_DELAY_MS = 2_000;
/** How long a tab waits for the owner to answer a question or to agree to let go. */
export const OWNER_REPLY_TIMEOUT_MS = 5_000;
/**
 * A lock request that must settle at once (ifAvailable, steal) and has not
 * after this long is abandoned: granted later, it is released at once and
 * held by nothing. The page's first request then leaves it waiting, as a
 * second tab does (in the queue while it is visible), never with nothing on
 * screen; a steal ("Take over anyway") leaves it in fence mode for that vault.
 */
export const LOCK_REQUEST_SETTLE_MS = 5_000;
/**
 * Fence mode: how long a start waits for a tab that owns the vault to say
 * which call it has running, before it claims the vault. Short, since the
 * newest start wins anyway; nothing is waited for without a channel.
 */
export const FENCE_START_QUERY_MS = 300;
/** After agreeing, how long the owner may take to finish its teardown before the asker offers to take over anyway. */
export const RELEASE_WAIT_MS = 30_000;
/** The longest an owner waits for its services' teardown before it lets the lock go (the fence covers what comes later). */
export const TEARDOWN_WAIT_MAX_MS = 30_000;
/** After a hand-over, how long the owner keeps the lock for the tab that asked (it takes it by a steal), before releasing it to the queue. */
export const HANDOVER_STEAL_WAIT_MS = 10_000;
/** sessionStorage: "Use it here" in a tab that lost its vault, across the reload that follows. */
export const TAKEOVER_INTENT_KEY = 'voxium_vault_takeover';
export const TAKEOVER_INTENT_MAX_AGE_MS = 60_000;
/** localStorage (fence mode only): the start that is making a vault's pickle key; the others wait. */
export const START_CLAIM_PREFIX = 'voxium_vault_start_claim:';
export const START_CLAIM_STALE_MS = 15_000;
export const START_CLAIM_WAIT_MAX_MS = 20_000;
const START_CLAIM_SETTLE_MS = 50;
const START_CLAIM_POLL_MS = 200;

type ReplyType = 'status' | 'releasing' | 'released';

type OwnershipMessage =
  | { v: 1; type: 'query'; vault: string; from: string; nonce: string }
  | { v: 1; type: 'status'; vault: string; to: string; nonce: string; call: VaultCall }
  | { v: 1; type: 'release'; vault: string; from: string; nonce: string }
  | { v: 1; type: 'releasing'; vault: string; to: string; nonce: string }
  | { v: 1; type: 'released'; vault: string; to: string; nonce: string }
  | { v: 1; type: 'taken'; vault: string; from: string };

interface OwnershipRecord {
  readonly vaultName: string;
  /** What the messages name the vault by: a digest of its name, never the user id. */
  readonly vaultKey: string;
  readonly userId: string;
  mode: VaultOwnershipMode;
  state: Exclude<VaultOwnershipState, 'none'>;
  /** The page's owner token while it owns the vault (or retires from it, below), null otherwise. */
  token: string | null;
  /**
   * The token is not written yet: owned through the queue (the first use of
   * the vault writes it, after the screen has checked the session), or its
   * write at the acquisition failed. The first use (ensureOwned) writes it in
   * the claiming mode; until then the fence answers no token, so nothing
   * reads or writes the vault.
   */
  claimPending: boolean;
  /**
   * Given up to a tab that asked for it ("Use it here"), and waiting for this
   * page's teardowns: the token stays for them (a key-share claim in flight
   * writes what it was handed), until they have settled and `released` is
   * sent. Nothing new starts meanwhile (the state is 'lost'). A steal, a
   * fenced write, a `taken` notice or the back/forward cache ends it at once.
   */
  retiring: boolean;
  /** Fence mode: another start's `taken` came while this page was writing its own token. */
  takenWhileAcquiring: boolean;
  /**
   * Fence mode: the call the owner named when this page's start asked
   * (claimInFenceMode), the reason it waits; null when it named none, or the
   * page waits for another reason (its start lost to one written after it).
   */
  callAtStart: VaultCall | null;
  lostReason: VaultLossReason | null;
  /** Ends the held lock's callback (the lock is released). Null when no lock is held. */
  releaseLock: (() => void) | null;
  /** Settles when the held lock is gone, released or stolen. */
  lockGone: Promise<void> | null;
  /** Numbers each lock request of this record. */
  lockEpoch: number;
  /** The request whose grant this page holds now; null while it holds none. Only its loss ends the ownership. */
  heldEpoch: number | null;
  /** A steal of this page on its way, not settled yet: the grant it takes from this page's own is no loss. */
  pendingSteal: number | null;
  /** takeOverVault is running: the page is out of the queue (a request there would wait behind its own lock). */
  takingOver: boolean;
  /** Aborts the queued request of a waiting page. */
  waitAbort: AbortController | null;
  acquiring: Promise<'owned' | 'busy' | 'lost'> | null;
  /** Bumped by every acquisition: a release decided before it drops nothing. */
  generation: number;
  /** The teardowns of this page's services on the vault, awaited before the lock is let go. */
  quiet: Set<Promise<void>>;
}

/**
 * What the page does about its calls. Each hook is given the account of the
 * vault concerned, and is called only for the account the page is signed in
 * to now: a question or a release about the vault of an account this page
 * signed out of (its teardown still pending) answers 'none' and ends nothing.
 */
export interface VaultOwnershipHooks {
  /** Which call this page has running, answered to a tab that asks. */
  liveCall?: (userId: string) => VaultCall;
  /** Runs first when the page gives a vault up, before its services stop: ends its calls. */
  beforeLoss?: (reason: VaultLossReason, userId: string) => void;
}

const noop = (): void => {};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function storageOf(read: () => Storage | undefined): () => StorageLike | null {
  return () => {
    try {
      return read() ?? null;
    } catch (err) {
      // blocked site data throws on the property itself
      console.warn('e2e: web storage is not available to the vault ownership:', errText(err));
      return null;
    }
  };
}

/** The page's own APIs, read from `window` only: a node test process has no page, and runs in fence mode. */
function browserEnvironment(): VaultOwnershipEnvironment {
  const win = typeof window !== 'undefined' ? window : undefined;
  const locks = (win?.navigator as { locks?: VaultLockManager } | undefined)?.locks;
  const Channel = win?.BroadcastChannel;
  return {
    locks: locks && typeof locks.request === 'function' ? locks : null,
    openChannel: typeof Channel === 'function' ? () => new Channel(VAULT_CHANNEL_NAME) as unknown as VaultChannel : null,
    stamp: stampVaultOwner,
    visibility: () => (typeof document !== 'undefined' ? document.visibilityState === 'hidden' ? 'hidden' : 'visible' : null),
    watchVisibility: (onChange) => {
      if (typeof document === 'undefined') return noop;
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    watchPageLifecycle: (onHide, onShow) => {
      if (!win) return;
      win.addEventListener('pagehide', (event) => onHide((event as PageTransitionEvent).persisted === true));
      win.addEventListener('pageshow', (event) => onShow((event as PageTransitionEvent).persisted === true));
    },
    session: storageOf(() => win?.sessionStorage),
    local: storageOf(() => win?.localStorage),
    reload: () => win?.location.reload(),
  };
}

let environment: VaultOwnershipEnvironment | null = null;
function env(): VaultOwnershipEnvironment {
  environment ??= browserEnvironment();
  return environment;
}

/** A random id of this page, for the messages: not stored anywhere. */
let pageId = randomId();
const records = new Map<string, OwnershipRecord>();
const lossListeners = new Map<string, Set<() => Promise<void> | void>>();
const subscribers = new Set<() => void>();
const replyWaiters = new Map<string, (message: OwnershipMessage) => void>();
let channel: VaultChannel | null = null;
let channelTried = false;
let lifecycleWatched = false;
let visibilityWatched = false;
let lostToBackForwardCache = false;
let hooks: VaultOwnershipHooks = {};

function vaultKeyOf(vaultName: string): string {
  return sha256Hex(vaultName).slice(0, 32);
}

function lockName(record: OwnershipRecord): string {
  return `${VAULT_LOCK_PREFIX}${record.vaultName}`;
}

/** The mode a new record starts in: lock mode wherever Web Locks exist. */
export function vaultOwnershipMode(): VaultOwnershipMode {
  return env().locks ? 'lock' : 'fence';
}

/**
 * The mode this page uses for the vault of `userId`: the mode it started in,
 * or fence mode once the lock manager refused a request or a steal did not
 * settle; before any acquisition, the mode a new one would start in.
 */
export function vaultOwnershipModeOf(userId: string, vaultName: string = vaultDbName(userId)): VaultOwnershipMode {
  return records.get(vaultName)?.mode ?? vaultOwnershipMode();
}

function notify(): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber();
    } catch (err) {
      console.error('e2e: a vault ownership subscriber failed:', errText(err));
    }
  }
}

/** Called whenever any vault's ownership in this page changes; returns the unsubscribe. */
export function subscribeVaultOwnership(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function getVaultOwnershipState(userId: string, vaultName: string = vaultDbName(userId)): VaultOwnershipState {
  return records.get(vaultName)?.state ?? 'none';
}

/**
 * Without Web Locks: the call the tab that owns the vault named when this
 * page's start asked it, which is why the page waits instead of claiming it;
 * null when the page waits for another reason, or does not wait.
 */
export function getVaultCallAtStart(userId: string, vaultName: string = vaultDbName(userId)): VaultCall | null {
  const record = records.get(vaultName);
  return record?.state === 'waiting' ? record.callAtStart : null;
}

/** Install what this page answers and does when it gives a vault up (the app's calls); returns the uninstall. */
export function registerVaultOwnershipHooks(next: VaultOwnershipHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

// ─── Messages ────────────────────────────────────────────────────────────────

function post(message: OwnershipMessage): void {
  if (!channel) return;
  try {
    channel.postMessage(message);
  } catch (err) {
    console.warn('e2e: a vault ownership message could not be sent:', errText(err));
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** A message of this protocol, its fields checked; anything else is dropped. */
function parseMessage(data: unknown): OwnershipMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.v !== 1 || !isText(m.vault)) return null;
  switch (m.type) {
    case 'query':
    case 'release':
      return isText(m.from) && isText(m.nonce) ? (m as unknown as OwnershipMessage) : null;
    case 'status':
      return isText(m.to) && isText(m.nonce) && (m.call === 'none' || m.call === 'voice' || m.call === 'dm')
        ? (m as unknown as OwnershipMessage)
        : null;
    case 'releasing':
    case 'released':
      return isText(m.to) && isText(m.nonce) ? (m as unknown as OwnershipMessage) : null;
    case 'taken':
      return isText(m.from) ? (m as unknown as OwnershipMessage) : null;
    default:
      return null;
  }
}

function ownedRecordFor(vaultKey: string): OwnershipRecord | null {
  for (const record of records.values()) {
    if (record.vaultKey === vaultKey && record.state === 'owned') return record;
  }
  return null;
}

/**
 * Is `record` the vault of the account this page is signed in to now? Not
 * after an account switch, while the previous account's teardown is still
 * pending: the calls this page runs are the new account's. Without a
 * registered session (a page outside the app) every record counts as current.
 */
function isCurrentAccount(record: OwnershipRecord): boolean {
  const signedIn = currentE2ESessionUser();
  return signedIn === undefined || signedIn === record.userId;
}

/** The call this page answers for `record`: its own only for the account it is signed in to now. */
function liveCallFor(record: OwnershipRecord): VaultCall {
  if (!isCurrentAccount(record)) return 'none';
  try {
    return hooks.liveCall?.(record.userId) ?? 'none';
  } catch (err) {
    console.warn('e2e: the call state could not be read for another tab:', errText(err));
    return 'none';
  }
}

/**
 * Another page says it took the vault over. In lock mode, or for a vault
 * whose token this page has not written, that is enough (its lock was stolen
 * too, or it claimed a vault this page holds no token in). In fence mode two
 * starts at once each claimed the vault and told the other: the token on disk
 * is the one that won, so this page keeps the vault only when that token is
 * its own. Read with 'keep', a check that writes nothing and never makes the
 * database: another page's token, none, no database (the tab that took over
 * deleted the account) or a failed read, and this page gives the vault up.
 */
function yieldToTaken(record: OwnershipRecord): void {
  const token = record.token;
  if (record.mode !== 'fence' || record.claimPending || !token) {
    lose(record, 'taken');
    return;
  }
  const stillMine = () => record.state === 'owned' && record.token === token;
  void env()
    .stamp(record.vaultName, token, 'keep')
    .then(
      (stamp) => {
        if (stamp !== 'kept' && stillMine()) lose(record, 'taken');
      },
      (err: unknown) => {
        console.warn('e2e: the vault owner token could not be read after a takeover notice:', errText(err));
        if (stillMine()) lose(record, 'taken');
      }
    );
}

function onMessage(data: unknown): void {
  const message = parseMessage(data);
  if (!message) return;
  switch (message.type) {
    case 'query': {
      const record = ownedRecordFor(message.vault);
      if (!record) return;
      const call = liveCallFor(record);
      post({ v: 1, type: 'status', vault: message.vault, to: message.from, nonce: message.nonce, call });
      return;
    }
    case 'release': {
      const record = ownedRecordFor(message.vault);
      if (!record) return;
      // the answer first: the asker's clock measures this, not the teardown
      post({ v: 1, type: 'releasing', vault: message.vault, to: message.from, nonce: message.nonce });
      lose(record, 'released', { to: message.from, nonce: message.nonce });
      return;
    }
    case 'taken': {
      if (message.from === pageId) return;
      for (const record of [...records.values()]) {
        if (record.vaultKey !== message.vault) continue;
        if (record.state === 'acquiring') record.takenWhileAcquiring = true;
        else if (record.state === 'owned') yieldToTaken(record);
        else if (record.retiring) lose(record, 'taken');
      }
      return;
    }
    case 'status':
    case 'releasing':
    case 'released': {
      if (message.to !== pageId) return;
      const waiter = replyWaiters.get(`${message.type}:${message.nonce}`);
      waiter?.(message);
      return;
    }
  }
}

function ensureChannel(): void {
  if (channelTried) return;
  channelTried = true;
  const open = env().openChannel;
  if (!open) return;
  try {
    channel = open();
    channel.onmessage = (event) => onMessage(event.data);
  } catch (err) {
    // No courtesy messages: a waiting tab still takes over when the lock
    // frees, and can take over anyway; the fence still holds
    console.warn('e2e: no channel to the other tabs of this browser:', errText(err));
    channel = null;
  }
}

/** The reply of `type` to the question `nonce`, or null after `timeoutMs`. */
function waitForReply(type: ReplyType, nonce: string, timeoutMs: number): { reply: Promise<OwnershipMessage | null>; cancel: () => void } {
  const key = `${type}:${nonce}`;
  let cancel = noop;
  const reply = new Promise<OwnershipMessage | null>((resolve) => {
    const timer = setTimeout(() => {
      replyWaiters.delete(key);
      resolve(null);
    }, timeoutMs);
    replyWaiters.set(key, (message) => {
      clearTimeout(timer);
      replyWaiters.delete(key);
      resolve(message);
    });
    cancel = () => {
      clearTimeout(timer);
      replyWaiters.delete(key);
      resolve(null);
    };
  });
  return { reply, cancel };
}

// ─── Page lifecycle ──────────────────────────────────────────────────────────

function ensureLifecycle(): void {
  if (lifecycleWatched) return;
  lifecycleWatched = true;
  try {
    env().watchPageLifecycle(
      (persisted) => {
        // Going into the back/forward cache: a page there is frozen with its
        // state, and nothing says when it comes back. It gives every vault
        // up now, its lock at once (there is no teardown to wait for in a
        // frozen page; the fence covers anything later)
        if (!persisted) return;
        for (const record of [...records.values()]) {
          // a hand-over still waiting for its teardowns ends here too
          if (record.state === 'lost' && !record.retiring) continue;
          lostToBackForwardCache = true;
          lose(record, 'bfcache');
        }
      },
      (persisted) => {
        // Back from that cache: a fresh page, not the frozen one
        if (persisted && lostToBackForwardCache) env().reload();
      }
    );
  } catch (err) {
    console.warn('e2e: the page lifecycle could not be watched:', errText(err));
  }
}

/**
 * A waiting page is in the lock's queue only while it is visible: the first
 * in the queue gets the lock when its owner lets go, and an owner that
 * reloads lets go. Left there, a tab in the background would take the vault
 * from the tab the person reloaded, which would come back showing the
 * screen. Hidden, a waiting page leaves the queue; shown again, it queues
 * again, and takes the vault at once when it is free.
 */
function ensureVisibilityWatch(): void {
  if (visibilityWatched) return;
  visibilityWatched = true;
  try {
    env().watchVisibility(() => {
      const hidden = env().visibility() === 'hidden';
      for (const record of [...records.values()]) {
        if (record.state !== 'waiting' || record.mode !== 'lock') continue;
        if (hidden) leaveQueue(record);
        else joinQueue(record);
      }
    });
  } catch (err) {
    // A waiting page then stays in the queue whatever its visibility, as it
    // would without this watch: it takes over when the owner lets go
    console.warn('e2e: the page visibility could not be watched:', errText(err));
    visibilityWatched = false;
  }
}

function waitWhileHidden(): Promise<void> {
  if (env().visibility() !== 'hidden') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let stop = noop;
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, HIDDEN_START_DELAY_MS);
    stop = env().watchVisibility(() => {
      if (env().visibility() === 'hidden') return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

// ─── The lock ────────────────────────────────────────────────────────────────

type LockOutcome = 'granted' | 'unavailable' | 'timedOut' | 'failed';

/**
 * One request for the vault's lock. A grant is held by a callback that never
 * settles until the page releases it (record.releaseLock), and the request
 * it answered is recorded as the one held (record.heldEpoch). That grant
 * taken away without the page letting it go (another tab's steal) ends the
 * page's ownership, unless a steal of this page's own is on its way, which
 * takes the lock next; a rejection of any other request of this page ends
 * nothing. `unavailable`: ifAvailable found it held, or this page aborted its
 * own wait. `timedOut`: a request that must settle at once (ifAvailable,
 * steal: `settleWithin`) had not after that long; it is abandoned, and
 * granted later it is released at once, held by nothing. `failed`: the Web
 * Locks API itself refused (thrown, or a rejection that is not an abort).
 */
function requestLock(
  record: OwnershipRecord,
  options: { mode: 'exclusive'; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
  settleWithin?: number
): Promise<LockOutcome> {
  const locks = env().locks;
  if (!locks) return Promise.resolve('failed');
  const epoch = ++record.lockEpoch;
  if (options.steal) record.pendingSteal = epoch;
  return new Promise<LockOutcome>((resolveOutcome) => {
    let granted = false;
    let abandoned = false;
    let decided = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: LockOutcome) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      if (record.pendingSteal === epoch) record.pendingSteal = null;
      resolveOutcome(outcome);
    };
    if (settleWithin !== undefined) {
      timer = setTimeout(() => {
        if (decided) return;
        abandoned = true;
        console.warn('e2e: a request for the vault lock did not settle in time, and is abandoned');
        settle('timedOut');
      }, settleWithin);
    }
    let markGone = noop;
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    let request: Promise<unknown>;
    try {
      request = locks.request(lockName(record), options, (lock) => {
        // given up already: whatever came, it is let go at once
        if (abandoned) return undefined;
        if (!lock) {
          settle('unavailable');
          return undefined;
        }
        granted = true;
        return new Promise<void>((release) => {
          record.heldEpoch = epoch;
          record.releaseLock = () => {
            record.releaseLock = null;
            if (record.heldEpoch === epoch) record.heldEpoch = null;
            release();
          };
          record.lockGone = gone;
          settle('granted');
        });
      });
    } catch (err) {
      console.warn('e2e: the vault lock could not be requested — this page uses the vault fence alone:', errText(err));
      settle('failed');
      return;
    }
    request.then(
      () => {
        if (granted && record.lockGone === gone) record.lockGone = null;
        if (record.heldEpoch === epoch) record.heldEpoch = null;
        markGone();
      },
      (err: unknown) => {
        markGone();
        if (!granted) {
          if (isAbort(err)) settle('unavailable');
          else {
            console.warn('e2e: the vault lock request failed — this page uses the vault fence alone:', errText(err));
            settle('failed');
          }
          return;
        }
        if (record.lockGone === gone) record.lockGone = null;
        // not the grant this page holds now (one its own steal replaced)
        if (record.heldEpoch !== epoch) return;
        record.heldEpoch = null;
        record.releaseLock = null;
        // this page's own steal took it, and is granted next
        if (record.pendingSteal !== null && record.pendingSteal > epoch) return;
        // A page in fence mode owns by its token alone: the fence and the
        // takeover notice decide its loss. A grant it still held being taken
        // (its own abandoned steal landing late included) ends nothing
        if (record.mode === 'fence') return;
        // Granted, then taken away without this page letting it go: another
        // tab took the vault over ("Take over anyway"), or the hand-over this
        // page agreed to (it gave the vault up already)
        lose(record, 'stolen');
      }
    );
  });
}

/**
 * The vault is this page's now. Its token is written at once (`stampNow`):
 * at the start, and after a steal, where it is what fences the page it was
 * taken from. A grant through the queue writes it at the vault's first use
 * instead (claimPending): the owner let go of its own accord, its services
 * stopped, and this page has not checked its session yet; an owner that let
 * go because it deleted the account must not have its database made again.
 * A write that fails here is made at the first use too, in the claiming mode
 * (a token this tab's previous page load left is no other tab's).
 *
 * Fence mode, a start that heard another start's `taken` while it wrote its
 * own token: the token on disk decides which of the two owns the vault
 * (yieldToTaken), read back with a check that writes nothing and never makes
 * the database. This start owns it only when that token is its own; another
 * page's, none, no database or a failed read, and it waits instead (`busy`).
 */
async function becomeOwner(record: OwnershipRecord, announce: boolean, stampNow = true): Promise<'owned' | 'busy' | 'lost'> {
  const token = randomId();
  let written = false;
  if (stampNow) {
    try {
      await env().stamp(record.vaultName, token, 'claim');
      written = true;
    } catch (err) {
      // The service's start writes it again (ensureOwned), and fails as a vault
      // failure if it cannot: E2E unavailable, never the screen of a lost vault
      console.warn('e2e: the vault owner token could not be written:', errText(err));
    }
  }
  if (written && record.mode === 'fence' && record.takenWhileAcquiring) {
    record.takenWhileAcquiring = false;
    let verdict: VaultOwnerStamp | 'unread';
    try {
      verdict = await env().stamp(record.vaultName, token, 'keep');
    } catch (err) {
      console.warn('e2e: the vault owner token could not be read back — this start waits:', errText(err));
      verdict = 'unread';
    }
    if (verdict !== 'kept' && record.state === 'acquiring' && records.get(record.vaultName) === record) {
      record.state = 'waiting';
      notify();
      return 'busy';
    }
  }
  if (record.state === 'lost' || records.get(record.vaultName) !== record) {
    // taken away while the token was written, or let go (a sign-out)
    record.releaseLock?.();
    return 'lost';
  }
  // the page owns it now: no request of its own may wait behind its lock
  record.waitAbort?.abort();
  record.waitAbort = null;
  record.token = token;
  record.claimPending = !written;
  record.state = 'owned';
  record.lostReason = null;
  record.takenWhileAcquiring = false;
  record.generation++;
  if (announce) post({ v: 1, type: 'taken', vault: record.vaultKey, from: pageId });
  notify();
  return 'owned';
}

/**
 * Wait for the lock: the owner closing, crashing or signing out hands it to
 * this page, if it is in the queue then, which it is only while visible
 * (ensureVisibilityWatch). In fence mode there is no queue: the page waits
 * for "Use it here".
 */
function startWaiting(record: OwnershipRecord): void {
  record.state = 'waiting';
  if (record.mode !== 'lock') return;
  ensureVisibilityWatch();
  if (visibilityWatched && env().visibility() === 'hidden') return;
  joinQueue(record);
}

/**
 * Queue a waiting page for the lock (once); granted, the vault is this page's,
 * its token written at the first use. Never while the page takes the vault
 * over: its steal takes the lock, and a request queued meanwhile would wait
 * behind this page's own lock.
 */
function joinQueue(record: OwnershipRecord): void {
  if (record.waitAbort || record.takingOver || record.state !== 'waiting') return;
  const abort = new AbortController();
  record.waitAbort = abort;
  void requestLock(record, { mode: 'exclusive', signal: abort.signal }).then(async (outcome) => {
    if (record.waitAbort === abort) record.waitAbort = null;
    if (outcome !== 'granted') return;
    if (record.state !== 'waiting' || records.get(record.vaultName) !== record) {
      record.releaseLock?.();
      return;
    }
    await becomeOwner(record, false, false);
  });
}

/** Withdraw a waiting page's queued request: it stays waiting, out of the queue. */
function leaveQueue(record: OwnershipRecord): void {
  record.waitAbort?.abort();
  record.waitAbort = null;
}

function newRecord(vaultName: string, userId: string): OwnershipRecord {
  return {
    vaultName,
    vaultKey: vaultKeyOf(vaultName),
    userId,
    mode: vaultOwnershipMode(),
    state: 'acquiring',
    token: null,
    claimPending: false,
    retiring: false,
    takenWhileAcquiring: false,
    callAtStart: null,
    lostReason: null,
    releaseLock: null,
    lockGone: null,
    lockEpoch: 0,
    heldEpoch: null,
    pendingSteal: null,
    takingOver: false,
    waitAbort: null,
    acquiring: null,
    generation: 0,
    quiet: new Set(),
  };
}

function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.warn('e2e: a vault teardown failed before its lock was let go:', errText(err));
        resolve();
      }
    );
  });
}

/**
 * This page gives a vault up. In this order: nothing new may start on it (the
 * state is 'lost': no service starts, and the services stop below), the
 * page's calls end (hooks.beforeLoss, for the account it is signed in to
 * now), its services on the vault stop (they listen through onLost), the
 * screens are told; then, once those services have finished their teardown,
 * the lock is let go: to the tab that asked for it when this is a hand-over
 * (`released`, and that tab takes it by a steal), else to the queue. A page
 * that lost a vault never owns it again; a reload does.
 *
 * The token goes at once (the vault refuses every write from here, vault.ts),
 * except in a hand-over ('released'): there it stays until the teardowns have
 * settled (`retiring`), so that a key-share claim in flight writes the page it
 * was handed instead of leaving it leased on the server; the asker takes the
 * vault only after `released`, so the two never write at once. A steal, a
 * fenced write, a `taken` notice or the back/forward cache in that window
 * clears it at once.
 */
function lose(record: OwnershipRecord, reason: VaultLossReason, handover?: { to: string; nonce: string }): void {
  if (record.state === 'lost') {
    if (record.retiring && reason !== 'released') {
      record.retiring = false;
      record.token = null;
      console.warn(`e2e: the hand-over of the encrypted vault ended early (${reason})`);
      if (reason === 'bfcache') record.releaseLock?.();
    }
    return;
  }
  const handingOver = reason === 'released';
  record.state = 'lost';
  record.lostReason = reason;
  record.retiring = handingOver;
  if (!handingOver) record.token = null;
  record.waitAbort?.abort();
  record.waitAbort = null;
  console.warn(`e2e: this page gave its encrypted vault up (${reason})`);
  if (isCurrentAccount(record)) {
    try {
      hooks.beforeLoss?.(reason, record.userId);
    } catch (err) {
      console.error('e2e: ending the calls of a page that gave its vault up failed:', errText(err));
    }
  }
  const teardowns: Promise<unknown>[] = [...record.quiet];
  for (const listener of [...(lossListeners.get(record.vaultName) ?? [])]) {
    try {
      const done = listener();
      if (done) teardowns.push(done);
    } catch (err) {
      console.error('e2e: a service could not be stopped when its page gave the vault up:', errText(err));
    }
  }
  notify();
  if (reason === 'bfcache') {
    record.releaseLock?.();
    return;
  }
  void settleWithin(Promise.all(teardowns), TEARDOWN_WAIT_MAX_MS).then(async () => {
    // ended early by a steal, a fenced write or a notice: someone else has
    // the vault, and the asker is not told to take it
    const stillHandingOver = record.retiring;
    record.retiring = false;
    record.token = null;
    if (handover && stillHandingOver) {
      post({ v: 1, type: 'released', vault: record.vaultKey, to: handover.to, nonce: handover.nonce });
      const gone = record.lockGone;
      if (gone && record.releaseLock) await settleWithin(gone, HANDOVER_STEAL_WAIT_MS);
    }
    record.releaseLock?.();
  });
}

// ─── Acquisition ─────────────────────────────────────────────────────────────

/**
 * Make this page the owner of the vault of `userId`, if it can: single-flight
 * per vault, never undone by a screen unmounting. In lock mode, the lock if
 * nobody holds it (a hidden page first waits HIDDEN_START_DELAY_MS, or until
 * it is shown, when `deferWhenHidden`), else `busy`, and the page waits from
 * then on, in the queue while it is visible. A request that has not settled
 * within LOCK_REQUEST_SETTLE_MS is abandoned and the page waits the same way
 * (`busy`): a lock that is free reaches it through the queue, and a healthy
 * owner keeps its vault. Only a lock manager that refuses the request (it
 * throws, or rejects with anything but an abort) leaves the page in fence
 * mode. In fence mode the newest start wins, once it has asked the owner
 * (claimInFenceMode): `busy` when a call runs there. A page that owns it
 * already answers `owned` (a sign-in back: a release decided before is void);
 * one that lost it answers `lost`. Every acquisition first removes a start
 * claim an interrupted start left behind (removeStaleStartClaim).
 */
export function acquireVaultOwnership(
  userId: string,
  opts: { vaultName?: string; deferWhenHidden?: boolean } = {}
): Promise<'owned' | 'busy' | 'lost'> {
  const vaultName = opts.vaultName ?? vaultDbName(userId);
  const existing = records.get(vaultName);
  if (existing) {
    if (existing.acquiring) return existing.acquiring;
    if (existing.state === 'owned') {
      existing.generation++;
      return Promise.resolve('owned');
    }
    if (existing.state === 'lost') return Promise.resolve('lost');
    return Promise.resolve('busy');
  }
  const record = newRecord(vaultName, userId);
  records.set(vaultName, record);
  ensureChannel();
  ensureLifecycle();
  const run = (async (): Promise<'owned' | 'busy' | 'lost'> => {
    removeStaleStartClaim(record.vaultKey);
    if (record.mode === 'lock') {
      if (opts.deferWhenHidden) await waitWhileHidden();
      const outcome = await requestLock(record, { mode: 'exclusive', ifAvailable: true }, LOCK_REQUEST_SETTLE_MS);
      if (outcome === 'granted') return becomeOwner(record, false);
      if (outcome === 'unavailable' || outcome === 'timedOut') {
        // Held by another tab, or no answer in time (that request abandoned):
        // the page waits as a second tab does, and takes nothing from a tab
        // that may own the vault
        if (record.state !== 'acquiring') return record.state === 'owned' ? 'owned' : 'lost';
        startWaiting(record);
        return 'busy';
      }
      record.mode = 'fence';
    }
    return claimInFenceMode(record);
  })();
  record.acquiring = run;
  void run.then(
    () => {
      record.acquiring = null;
      // Signed out of this account while it was acquired: let it go again
      const signedIn = currentE2ESessionUser();
      if (record.state !== 'lost' && signedIn !== undefined && signedIn !== record.userId) drop(record);
      notify();
    },
    (err: unknown) => {
      record.acquiring = null;
      console.error('e2e: the vault ownership could not be acquired:', errText(err));
      notify();
    }
  );
  notify();
  return run;
}

/**
 * Fence mode: the newest start wins, but a call running in the tab that owns
 * the vault is the person's to end. That tab is asked first, for at most
 * FENCE_START_QUERY_MS (nothing is waited for without a channel): no answer,
 * or no call, and the vault is claimed now; a call, and this page waits
 * (`busy`) for "Use it here", which the screen asks the person about first.
 */
async function claimInFenceMode(record: OwnershipRecord): Promise<'owned' | 'busy' | 'lost'> {
  const answer = await askOwner(record.vaultKey, FENCE_START_QUERY_MS);
  if (records.get(record.vaultName) !== record) return 'lost'; // let go meanwhile (a sign-out)
  if (record.state !== 'acquiring') return record.state === 'owned' ? 'owned' : 'lost';
  if (answer && answer.call !== 'none') {
    record.state = 'waiting';
    record.callAtStart = answer.call;
    return 'busy';
  }
  return becomeOwner(record, true);
}

/**
 * Take the vault over now: "Take over anyway", or the end of a hand-over the
 * owner agreed to. A steal in lock mode (the owner's lock is taken away and
 * its writes are fenced from then on), a claim in fence mode; either way the
 * other tabs are told. A steal the lock manager refuses, or that has not
 * settled within LOCK_REQUEST_SETTLE_MS (abandoned), leaves the page in fence
 * mode: the person chose to take over, and the claim fences the owner. The
 * page stays out of the lock's queue until this is done. A page that gave the
 * vault up itself reloads instead.
 */
export async function takeOverVault(userId: string, vaultName: string = vaultDbName(userId)): Promise<'owned' | 'lost'> {
  let record = records.get(vaultName);
  if (record?.acquiring) await record.acquiring;
  record = records.get(vaultName);
  if (!record) {
    record = newRecord(vaultName, userId);
    records.set(vaultName, record);
    ensureChannel();
    ensureLifecycle();
  }
  if (record.state === 'owned') return 'owned';
  if (record.state === 'lost') return 'lost';
  const taking = record;
  taking.takingOver = true;
  try {
    if (taking.mode === 'lock') {
      // the place in the queue goes: this page takes the lock directly
      taking.waitAbort?.abort();
      taking.waitAbort = null;
      const outcome = await requestLock(taking, { mode: 'exclusive', steal: true }, LOCK_REQUEST_SETTLE_MS);
      if (outcome === 'timedOut') {
        console.warn('e2e: the steal of the vault lock did not settle — this page takes the vault by the fence alone');
      }
      if (outcome === 'failed' || outcome === 'timedOut') taking.mode = 'fence';
      else if (outcome !== 'granted') return getVaultOwnershipState(userId, vaultName) === 'owned' ? 'owned' : 'lost';
    }
    // (`busy` comes only out of an acquisition)
    return (await becomeOwner(taking, true)) === 'owned' ? 'owned' : 'lost';
  } finally {
    taking.takingOver = false;
    // still waiting (nothing was taken): back in the queue, while visible
    if (taking.state === 'waiting' && taking.mode === 'lock' && records.get(vaultName) === taking) startWaiting(taking);
  }
}

/** The owner's answer to "which call do you run?" about the vault `vaultKey`, or null after `timeoutMs` (at once without a channel). */
async function askOwner(vaultKey: string, timeoutMs: number): Promise<{ call: VaultCall } | null> {
  ensureChannel();
  if (!channel) return null;
  const nonce = randomId();
  const { reply } = waitForReply('status', nonce, timeoutMs);
  post({ v: 1, type: 'query', vault: vaultKey, from: pageId, nonce });
  const answer = await reply;
  return answer && answer.type === 'status' ? { call: answer.call } : null;
}

/**
 * Ask the tab that owns the vault which call it has running, before taking
 * over ("Use it here"). Null when no tab answers within `timeoutMs` (none is
 * open, it is frozen, or there is no channel).
 */
export function askVaultOwner(
  userId: string,
  timeoutMs: number = OWNER_REPLY_TIMEOUT_MS,
  vaultName: string = vaultDbName(userId)
): Promise<{ call: VaultCall } | null> {
  return askOwner(vaultKeyOf(vaultName), timeoutMs);
}

/**
 * "Use it here", once the person agreed: ask the owner to let the vault go,
 * and take it over when it has (its calls ended, its services torn down).
 * `noReply`: it did not agree within OWNER_REPLY_TIMEOUT_MS, or did not finish
 * within RELEASE_WAIT_MS after agreeing; the screen then offers to take over
 * anyway. In fence mode there is nothing to wait for: the vault is claimed.
 */
export async function requestVaultRelease(userId: string, vaultName: string = vaultDbName(userId)): Promise<'owned' | 'lost' | 'noReply'> {
  if (!records.get(vaultName)) {
    const outcome = await acquireVaultOwnership(userId, { vaultName });
    if (outcome !== 'busy') return outcome;
  }
  const record = records.get(vaultName);
  if (!record || record.state === 'lost') return 'lost';
  if (record.state === 'owned') return 'owned';
  if (record.mode === 'fence') return takeOverVault(userId, vaultName);
  ensureChannel();
  if (!channel) return 'noReply';
  const nonce = randomId();
  const agreed = waitForReply('releasing', nonce, OWNER_REPLY_TIMEOUT_MS);
  const done = waitForReply('released', nonce, OWNER_REPLY_TIMEOUT_MS + RELEASE_WAIT_MS);
  post({ v: 1, type: 'release', vault: record.vaultKey, from: pageId, nonce });
  if (!(await agreed.reply)) {
    done.cancel();
    return getVaultOwnershipState(userId, vaultName) === 'owned' ? 'owned' : 'noReply';
  }
  const released = await done.reply;
  const now = getVaultOwnershipState(userId, vaultName);
  if (now === 'owned' || now === 'lost') return now;
  if (!released) return 'noReply';
  return takeOverVault(userId, vaultName);
}

/** Remember "Use it here" across the reload a tab that lost its vault needs, and reload. */
export function requestTakeoverByReload(userId: string): void {
  try {
    env().session()?.setItem(TAKEOVER_INTENT_KEY, JSON.stringify({ vault: vaultKeyOf(vaultDbName(userId)), at: Date.now() }));
  } catch (err) {
    // the fresh page shows its screen instead, where "Use it here" asks in place
    console.warn('e2e: the takeover could not be remembered across the reload:', errText(err));
  }
  env().reload();
}

/** Reload the page: a tab now signed in to another account starts again as that one (the gate). */
export function reloadPage(): void {
  env().reload();
}

/** Whether this page was loaded by "Use it here" for this account (read once, then forgotten). */
export function consumeTakeoverIntent(userId: string): boolean {
  const store = env().session();
  if (!store) return false;
  try {
    const raw = store.getItem(TAKEOVER_INTENT_KEY);
    if (raw === null) return false;
    store.removeItem(TAKEOVER_INTENT_KEY);
    const intent = JSON.parse(raw) as { vault?: unknown; at?: unknown };
    return (
      intent.vault === vaultKeyOf(vaultDbName(userId)) &&
      typeof intent.at === 'number' &&
      Date.now() - intent.at >= 0 &&
      Date.now() - intent.at < TAKEOVER_INTENT_MAX_AGE_MS
    );
  } catch (err) {
    console.warn('e2e: a remembered takeover could not be read:', errText(err));
    return false;
  }
}

// ─── Release ─────────────────────────────────────────────────────────────────

function drop(record: OwnershipRecord): void {
  if (records.get(record.vaultName) !== record) return;
  records.delete(record.vaultName);
  record.token = null;
  record.waitAbort?.abort();
  record.waitAbort = null;
  record.releaseLock?.();
  notify();
}

/**
 * Let go of every vault this page holds or waits for that it is not signed in
 * to any more: after a logout or an account switch (disposeE2EService), once
 * the teardown of its last service on that vault has run and the key-share
 * claim that teardown kept a connection for has settled (bounded by
 * TEARDOWN_WAIT_MAX_MS). Signed in to it again by then (a sign-in back), the
 * page keeps it: nobody ever sees this page's own vault as open elsewhere.
 */
export function releaseVaultOwnershipNotInUse(): void {
  for (const record of [...records.values()]) {
    if (record.state !== 'lost') releaseWhenQuiet(record, record.generation, Date.now() + TEARDOWN_WAIT_MAX_MS);
  }
}

/**
 * Drop `record` once the teardowns noted for it have settled, unless it was
 * acquired again since `generation` or the page is signed in to it. A
 * teardown noted while the ones before were awaited (a second service of the
 * account, signed out of again) is waited for too, until `deadline`.
 */
function releaseWhenQuiet(record: OwnershipRecord, generation: number, deadline: number): void {
  const pending = [...record.quiet, record.acquiring ?? Promise.resolve()];
  void settleWithin(Promise.all(pending), Math.max(0, deadline - Date.now())).then(() => {
    if (record.generation !== generation || records.get(record.vaultName) !== record) return;
    if (record.state === 'lost' || record.state === 'acquiring') return;
    if (currentE2ESessionUser() === record.userId) return;
    if (record.quiet.size > 0 && Date.now() < deadline) {
      releaseWhenQuiet(record, generation, deadline);
      return;
    }
    drop(record);
  });
}

/** Note the teardown of a service on `vaultName`: a release waits for it. */
export function noteVaultTeardown(vaultName: string, quiet: Promise<void>): void {
  const record = records.get(vaultName);
  if (!record) return;
  const tracked: Promise<void> = quiet
    .catch((err: unknown) => {
      console.warn('e2e: a service teardown failed:', errText(err));
    })
    .finally(() => {
      record.quiet.delete(tracked);
    });
  record.quiet.add(tracked);
}

// ─── Fence mode: one pickle key made at a time ───────────────────────────────

function readClaim(store: StorageLike, key: string): { id: string; at: number } | null {
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    const claim = JSON.parse(raw) as { id?: unknown; at?: unknown };
    return typeof claim.id === 'string' && typeof claim.at === 'number' ? { id: claim.id, at: claim.at } : null;
  } catch (err) {
    console.warn('e2e: a malformed vault start claim is ignored:', errText(err));
    return null;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A start claim left behind by a start that was interrupted (closed while it
 * made the key) would stay in localStorage for good: only a start that makes
 * a key reads it. Each acquisition of the vault, in either mode, removes one
 * older than START_CLAIM_STALE_MS (or dated that far ahead, or malformed); a
 * claim in progress in another tab is younger and stays.
 */
function removeStaleStartClaim(vaultKey: string): void {
  const store = env().local();
  if (!store) return;
  const key = `${START_CLAIM_PREFIX}${vaultKey}`;
  try {
    if (store.getItem(key) === null) return;
    const claim = readClaim(store, key);
    if (!claim || Math.abs(Date.now() - claim.at) > START_CLAIM_STALE_MS) store.removeItem(key);
  } catch (err) {
    console.warn('e2e: a stale vault start claim could not be removed:', errText(err));
  }
}

/**
 * Without Web Locks, two tabs starting on a vault that has no pickle key yet
 * would each make one, and the one saved last would leave the other's pickles
 * unreadable. The making is held behind a localStorage claim instead: a
 * random id and a time, written, read back after a moment, and taken only if
 * it is still ours. A claim older than START_CLAIM_STALE_MS is a start that
 * died; past START_CLAIM_WAIT_MAX_MS this start goes ahead anyway. Without
 * localStorage, it goes ahead at once.
 */
async function withStartClaim<T>(vaultKey: string, create: () => Promise<T>): Promise<T> {
  const store = env().local();
  if (!store) return create();
  const key = `${START_CLAIM_PREFIX}${vaultKey}`;
  const id = randomId();
  const deadline = Date.now() + START_CLAIM_WAIT_MAX_MS;
  let held = false;
  try {
    while (!held) {
      const current = readClaim(store, key);
      if (!current || Date.now() - current.at > START_CLAIM_STALE_MS || Date.now() >= deadline) {
        store.setItem(key, JSON.stringify({ id, at: Date.now() }));
        await delay(START_CLAIM_SETTLE_MS);
        held = readClaim(store, key)?.id === id || Date.now() >= deadline;
        if (held) break;
      }
      await delay(START_CLAIM_POLL_MS);
    }
  } catch (err) {
    console.warn('e2e: the vault start claim could not be taken — going ahead:', errText(err));
  }
  try {
    return await create();
  } finally {
    try {
      if (readClaim(store, key)?.id === id) store.removeItem(key);
    } catch (err) {
      console.warn('e2e: the vault start claim could not be removed (it goes stale):', errText(err));
    }
  }
}

// ─── What a service holds ────────────────────────────────────────────────────

/** The ownership a service of the vault reads (E2EService): the fence, the start check and the loss. */
export interface VaultOwnershipHandle extends VaultFence {
  /**
   * Resolve once this page owns the vault, and its token is the one on disk:
   * acquiring it first when nothing did (a start outside the gate). Rejects
   * E2EVaultNotOwnedError when another page owns it, this page gave it up, or
   * the token on disk is not this page's (the page gives the vault up then).
   */
  ensure(): Promise<void>;
  /** Called when this page gives the vault up; may return its teardown, which the release waits for. Returns the unsubscribe. */
  onLost(listener: () => Promise<void> | void): () => void;
  /** A teardown of the service the release of the vault waits for. */
  noteTeardown(quiet: Promise<void>): void;
}

async function ensureOwned(userId: string, vaultName: string): Promise<void> {
  let record = records.get(vaultName);
  if (!record) {
    const outcome = await acquireVaultOwnership(userId, { vaultName });
    if (outcome !== 'owned') throw new E2EVaultNotOwnedError();
  } else if (record.acquiring) {
    await record.acquiring;
  }
  record = records.get(vaultName);
  if (!record || record.state !== 'owned' || !record.token) throw new E2EVaultNotOwnedError();
  // a service starts on it: a release decided before is void
  record.generation++;
  const token = record.token;
  // Granted through the queue, or its write at the acquisition failed: the
  // token is written now, over whatever is there (the page that let go, this
  // tab's previous page load). Otherwise it is checked, never written, and no
  // database is made for it: the start goes on only when the token on disk
  // is this page's. Another page's means it took the vault over; none, or no
  // database, means the vault was deleted under this page (or made again
  // without its token): the page gives the vault up either way. May throw
  // (IndexedDB unusable): the start fails as a vault failure, and the next
  // start writes or checks again.
  const claim = record.claimPending;
  const stamp = await env().stamp(vaultName, token, claim ? 'claim' : 'keep');
  if (record.state !== 'owned' || record.token !== token) throw new E2EVaultNotOwnedError();
  if (claim) record.claimPending = false;
  if (stamp === 'other' || stamp === 'missing') {
    lose(record, 'fenced');
    throw new E2EVaultNotOwnedError();
  }
}

export function vaultOwnershipFor(userId: string, vaultName: string = vaultDbName(userId)): VaultOwnershipHandle {
  return {
    ensure: () => ensureOwned(userId, vaultName),
    token: () => {
      const record = records.get(vaultName);
      if (!record) return null;
      // a hand-over waiting for this page's teardowns: their writes still land (lose)
      if (record.retiring) return record.token;
      return record.state === 'owned' && !record.claimPending ? record.token : null;
    },
    fenced: () => {
      const record = records.get(vaultName);
      if (record) lose(record, 'fenced');
    },
    serializeKeyCreation: <T>(create: () => Promise<T>): Promise<T> =>
      records.get(vaultName)?.mode === 'fence' ? withStartClaim(vaultKeyOf(vaultName), create) : create(),
    onLost: (listener) => {
      let set = lossListeners.get(vaultName);
      if (!set) {
        set = new Set();
        lossListeners.set(vaultName, set);
      }
      set.add(listener);
      return () => {
        const current = lossListeners.get(vaultName);
        current?.delete(listener);
        if (current?.size === 0) lossListeners.delete(vaultName);
      };
    },
    noteTeardown: (quiet) => noteVaultTeardown(vaultName, quiet),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/** @internal tests: the page this module sees (merged over the browser's) */
export function _setVaultOwnershipEnvironmentForTests(next: Partial<VaultOwnershipEnvironment>): void {
  environment = { ...browserEnvironment(), ...next };
}

/** @internal tests: forget every vault, message and listener; a new page id */
export function _resetVaultOwnershipForTests(): void {
  for (const record of records.values()) {
    record.waitAbort?.abort();
    record.releaseLock?.();
  }
  records.clear();
  lossListeners.clear();
  subscribers.clear();
  replyWaiters.clear();
  try {
    channel?.close();
  } catch (err) {
    console.warn('vaultOwnership: the test channel could not be closed:', errText(err));
  }
  channel = null;
  channelTried = false;
  lifecycleWatched = false;
  visibilityWatched = false;
  lostToBackForwardCache = false;
  hooks = {};
  environment = null;
  pageId = randomId();
}

/** @internal tests: this page's id in the messages */
export function _vaultOwnershipPageIdForTests(): string {
  return pageId;
}

/** @internal tests: the digest the messages name a vault by */
export function _vaultKeyForTests(vaultName: string): string {
  return vaultKeyOf(vaultName);
}
