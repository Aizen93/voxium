// Per-account local vault for E2E state (docs/e2e-dm-spec.md §7, §12).
//
// One IndexedDB database per logged-in user (`voxium-e2e-v2-{userId}`, with
// the server's digest appended in a desktop build for another server: see
// serverVaultNamespace), a single key/value object store, and these key
// namespaces:
//
//   device_id                        this install's device id (spec §12, D2)
//   account                          Olm account pickle (vodozemac-encrypted)
//   master_secret                    OUR account master key, SEALED (spec §14)
//   master:{userId}                  pinned account master key (TOFU, §14 D7)
//   session:{userId}:{deviceId}      pairwise Olm session pickle, per DEVICE
//   session:{userId}                 legacy pre-multi-device session pickle
//   identity:{userId}:{deviceId}     pinned device identity (TOFU, per device)
//   identity:{userId}                legacy pre-multi-device pinned identity
//   dlv:{userId}                     last seen/acknowledged device-list version
//   gs:{conversationId}              our outbound Megolm session for a DM
//   igs:{sessionId}                  an inbound Megolm session + its attribution
//   pks:{createdAt}|{shareId}        a claimed key share not imported yet (§12.3)
//   pka:{shareId}                    an acknowledgement of a claimed share still owed to the server (§12.3)
//   history_pull                     where an unfinished history pull stands (§16.3)
//   pt:{messageId}                   decrypted-plaintext cache entry
//   ptpurge:{mark}:{scope}           a purge of the `pt:` entries of a scope that ended (purgeCachedPlaintexts);
//                                    under `cleared`, with the floor it purged up to
//   claim_sent                       when a claim of the key-share inbox last left (its page may still be leased)
//   repair:{name}                    a repair that ran on this vault (E2EService), and when; `fallback-key-uploaded`:
//                                    when this device last made a fallback key to be sent (written before the
//                                    request that may send it, and again once the server took it)
//   vault_owner                      the token of the page that owns the vault (vaultOwnership.ts):
//                                    every write checks it in its own transaction (the fence)
//
// `master_secret` holds the Ed25519 master private key that cross-signs this
// account's devices. Like every other secret it is stored SEALED (AES-256-GCM
// inside the engine, under the same pickle key) — raw key material must never
// sit in IndexedDB (§7). `master:{userId}` stores only public material.
//
// Megolm ciphertext is re-decryptable, so `pt:` is an optimization for the
// group path (search/previews depend on it) but remains the ONLY way to read
// legacy olm1 history — Olm message keys are one-shot.
//
// The 32-byte pickle key guards every pickle and the sealed master secret
// (what else JS holds, the unsealed `pt:` cache included, is listed in spec
// §3). In the Tauri app it
// lives in the OS keychain; browser dev builds fall back to localStorage
// (spec §7.3, providers in ./pickleKeyProvider). Keys never leave the device
// either way.
import { defaultPickleKeyProvider, type PickleKeyProvider } from './pickleKeyProvider';
import { BUILD_API_ORIGIN, isOfficialOrigin } from '../sessionOrigin';
import { sha256Hex } from '../../utils/sha256';

export type { PickleKeyProvider };

const KV_STORE = 'kv';
/** Upper bound for prefix range scans (highest BMP code point). */
const KEY_MAX = '￿';
/**
 * Where the token of the page that owns the vault is kept (vaultOwnership.ts).
 * Outside every prefix the vault scans or deletes by range.
 */
export const VAULT_OWNER_KEY = 'vault_owner';

export interface PinnedIdentity {
  curve25519Key: string;
  ed25519Key: string;
  verified: boolean; // true once the user compared safety numbers
}

/**
 * A user's pinned ACCOUNT master key (spec §14, D7). Pinned on first sight like
 * a device identity; a change is an account identity change, not a new device.
 * `verified` means the account safety number was compared out of band — every
 * cross-signed device of that account inherits it (D9).
 */
export interface PinnedMasterKey {
  masterKey: string;
  verified: boolean;
}

/**
 * What we last saw of a user's published device list. `acknowledged*` is what
 * the local user has confirmed in the UI — a divergence means "this account
 * added or removed a device since you last looked".
 */
export interface DeviceListState {
  version: number;
  deviceIds: string[];
  acknowledgedVersion: number;
  acknowledgedDeviceIds: string[];
  /**
   * Union of every device id seen since the last acknowledgement. Sticky on
   * purpose: a server that adds a device and then removes it again would
   * otherwise erase the warning while the device keeps the session key it was
   * already given. Cleared ONLY by acknowledgeDeviceList — and, since
   * cross-signing, only for devices the account's master key vouches for
   * (spec §14, D8): acknowledgement alone can never bless an unsigned device.
   */
  unacknowledgedDeviceIds?: string[];
  /**
   * The account master key seen with this list, or null when the account has
   * not bootstrapped cross-signing (pre-§14 devices). Recorded so
   * acknowledge/status can reason about signatures without a round trip.
   */
  masterKey?: string | null;
  /**
   * The master key under which the user last acknowledged this device list.
   * Cross-signed devices are auto-trusted ONLY under this key: a key that has
   * merely been *seen* (possibly served by a hostile server alongside the very
   * devices it signs) must not be able to bless anything.
   */
  acknowledgedMasterKey?: string | null;
  /** Device ids carrying a VALID cross-signature at the last fetch (§14 D8). */
  crossSignedDeviceIds?: string[];
}

/** Our outbound Megolm session for one conversation (spec §12, D9). */
export interface OutboundGroupSessionRecord {
  pickle: string;
  sessionId: string;
  /** epoch ms — drives the max-age rotation trigger */
  createdAt: number;
  messageCount: number;
  /** device-list version per participant when the session was created */
  deviceListVersions: Record<string, number>;
  /**
   * Sorted device-id fingerprint per participant when the session was created.
   * Rotation keys off THIS, not the server-supplied version: a server that
   * injects a device without bumping listVersion must still force a re-key.
   */
  deviceListFingerprints?: Record<string, string>;
  /** `${userId}|${deviceId}` entries whose key share could not be delivered */
  pendingShareFailures: string[];
  /**
   * Attempts made to deliver `pendingShareFailures`. Retrying forever would
   * hammer the bundle endpoint for a target that can never be served.
   */
  shareRetryCount?: number;
  /** epoch ms of the last share-retry attempt (backoff) */
  lastShareAttemptAt?: number;
}

/** An imported Megolm session plus the attribution it was received under. */
/**
 * Bumped when a release invalidates every local vault. `v2` is the always-on
 * cutover: the server truncated all E2E key material, so a v1 vault holds
 * pickles, pinned identities and a plaintext cache for keys that no longer
 * exist anywhere.
 */
const VAULT_DB_PREFIX = 'voxium-e2e-v2-';
const SUPERSEDED_DB_PREFIXES = ['voxium-e2e-'];

/**
 * The namespace a build names its vaults with, so that builds for different
 * servers keep separate vaults: none in a browser build or the official
 * desktop build (their vaults keep the name they always had), and in a
 * desktop build for another server `s` and the first 16 hex digits of the
 * SHA-256 of its API origin, the label of the identifier that build is made
 * with (scripts/tauriSelfHosted.mjs).
 *
 * A vault is named after a user id the build's own server supplies. In the
 * desktop app such a build has a webview data folder of its own, as Tauri
 * derives it from the identifier on Windows and Linux; the name carries the
 * server as well, for any platform where a data folder would be shared. A
 * browser's storage is already the page origin's own, and a new name there
 * would orphan every vault a self-hosted web client already holds.
 */
export function serverVaultNamespace(inTauri: boolean, apiOrigin: string): string | undefined {
  if (!inTauri || isOfficialOrigin(apiOrigin)) return undefined;
  return `s${sha256Hex(apiOrigin).slice(0, 16)}`;
}

/** This build's namespace: the one every vault it opens, and every vault it drops, is named with. */
export const BUILD_VAULT_NAMESPACE: string | undefined = serverVaultNamespace(
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  BUILD_API_ORIGIN
);

/**
 * The IndexedDB name of an account's vault on this device: with this build's
 * namespace unless the caller names one (tests, two vaults of one account in
 * one process), which takes its place.
 */
export function vaultDbName(userId: string, namespace: string | undefined = BUILD_VAULT_NAMESPACE): string {
  return `${VAULT_DB_PREFIX}${userId}${namespace ? `-${namespace}` : ''}`;
}

/** Best-effort removal of pre-cutover vaults. Never blocks opening the new one. */
function dropSupersededVaults(userId: string, namespace?: string): void {
  const suffix = `${userId}${namespace ? `-${namespace}` : ''}`;
  for (const prefix of SUPERSEDED_DB_PREFIXES) {
    const name = `${prefix}${suffix}`;
    if (name === `${VAULT_DB_PREFIX}${suffix}`) continue;
    try {
      indexedDB.deleteDatabase(name);
    } catch (err) {
      // An open handle elsewhere blocks deletion; the data is unreachable
      // either way because nothing reads that name any more.
      console.warn('e2e: could not remove a superseded vault:', err instanceof Error ? err.message : err);
    }
  }
}

export interface InboundGroupSessionRecord {
  pickle: string;
  sessionId: string;
  conversationId: string;
  /** Author every message under this session MUST have (spec §12, D6). */
  senderUserId: string;
  senderDeviceId: string;
}

/**
 * A key share as the inbox handed it out, kept until it is imported (spec
 * §12.3). Written before anything is done with it: a leasing claim leaves the
 * share on the server until this device acknowledges it, but only for as long
 * as its lease runs before handing it out again, and a server from before
 * leases deleted it when it answered. The body is the Olm ciphertext addressed
 * to this device: what the server held, no more.
 */
export interface PendingKeyShare {
  share: Record<string, unknown>;
  /** Imports that had to wait because the sender could not be looked up. */
  attempts: number;
  receivedAt: number;
  /**
   * Handed out by a leasing claim: the server keeps the share until this
   * device acknowledges it. Absent (records kept before leases, a server from
   * before them): the claim deleted it, and there is nothing to acknowledge.
   */
  leased?: boolean;
}

/** A key share this device is done with, whose acknowledgement the server has not confirmed (spec §12.3). */
export interface OwedShareAck {
  /** The share's row id, as the inbox handed it out. */
  id: string;
  /** When it was settled: one older than the server's retention is dropped unsent. */
  at: number;
}

/**
 * A message-key history pull that has not reached its end (spec §16.3): the
 * account key it reads under (public half only), the cursor of the page it
 * reads next (null: from the start), and how many page requests it has made
 * so far, across starts (the page cap bounds them all). Public material, a
 * row id and a count.
 */
export interface HistoryPullMarker {
  masterKey: string;
  cursor: string | null;
  pages: number;
}

export interface CachedPlaintext {
  conversationId: string;
  text: string;
  /** Version marker: an edit is a fresh ciphertext for the same message id,
   *  so cache entries are only valid for the editedAt they were decrypted at. */
  editedAt?: string | null;
  /** Display metadata for client-side search of E2E history (server search
   *  can't see ciphertext). Entries written before Phase C lack these. */
  authorId?: string;
  createdAt?: string;
  failed?: boolean;
  /** Ratchet position of the latest version accepted for this id. The reverse
   *  index of the `mi:` bindings: an unbound position of the SAME session at or
   *  below it is an older ciphertext presented as a newer version (rollback). */
  sessionId?: string;
  messageIndex?: number;
}

/**
 * What a purge of the plaintext cache decides on, per entry: its scope (a
 * conversation id, or `ch:{channelId}`), who wrote it (an entry that records
 * no author says nothing about it), which message it is, and when it was
 * created and last edited. Never the text.
 */
export interface PlaintextPurgeEntry {
  scope: string;
  messageId: string;
  authorId?: string;
  createdAt?: string;
  editedAt: string | null;
}

/**
 * A purge that ended for one scope (`ptpurge:{mark}:{scope}`): when, and for
 * a levelled mark the level its walk purged up to (a cleared history's floor,
 * ms since the epoch). Nothing else: no text, no ids but the scope's.
 */
interface PurgeRecord {
  at: number;
  level?: number;
}

/** One Megolm ratchet position: the session and the index within it. */
export interface MessagePosition {
  sessionId: string;
  messageIndex: number;
}

/**
 * What a ratchet position was shown as: one version of one message. A Megolm
 * ciphertext stays decryptable forever, so without this the server could
 * re-serve an authentic old ciphertext under a new id, or as an edit that
 * never happened, and it would render as genuine.
 */
export interface MessagePositionBinding {
  messageId: string;
  editedAt: string | null;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}


/**
 * Is this the browser having taken the IndexedDB connection away?
 *
 * Chrome/WebView2 raise InvalidStateError ("The database connection is
 * closing") and Safari/WKWebView raise a plain error mentioning the same; both
 * mean "reopen", not "the data is bad". Matched by name first and message
 * second so a genuine fault is never mistaken for a reconnectable one.
 */
function isConnectionGone(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'InvalidStateError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /database connection is closing|connection is closing|InvalidStateError/i.test(message);
}

/**
 * The vault was closed on purpose: close() runs when the E2E service is
 * disposed (logout, account switch, account deletion). Unlike a connection the
 * browser took away, it is never reopened, and work still in flight stops at
 * its next access instead of bringing the database back.
 */
export class E2EVaultClosedError extends Error {
  constructor(message = 'E2E vault closed') {
    super(message);
    this.name = 'E2EVaultClosedError';
  }
}

/**
 * Another page owns the vault now: a write found a token other than this
 * page's (or none), or this page gave the vault up. The vault refuses every
 * access from then on, like a closed one, and the service that used it ends
 * as if it had been disposed. A kind of E2EVaultClosedError, so that every
 * path that stops quietly at a dispose stops quietly here too.
 */
export class E2EVaultFencedError extends E2EVaultClosedError {
  constructor() {
    super('Another page owns this E2E vault');
    this.name = 'E2EVaultFencedError';
  }
}

/**
 * This page does not own the vault (vaultOwnership.ts), so no service of it
 * may open the vault. A kind of E2EVaultClosedError, for the same reason.
 */
export class E2EVaultNotOwnedError extends E2EVaultClosedError {
  constructor() {
    super('This page does not own the E2E vault');
    this.name = 'E2EVaultNotOwnedError';
  }
}

/**
 * What the vault asks of the page-level ownership (vaultOwnership.ts) before
 * it writes. One page owns a vault at a time; the fence is what makes a page
 * that lost it (a takeover it has not heard of yet) unable to write.
 */
export interface VaultFence {
  /**
   * Make this page the vault's owner if nothing has yet (a first use outside
   * the screen that acquires it before the app starts); rejects
   * E2EVaultNotOwnedError when another page owns it or this one gave it up.
   */
  ensure(): Promise<void>;
  /** This page's owner token while it owns the vault; null once it does not (every write refused). */
  token(): string | null;
  /** The vault found another owner's token, or none: this page no longer owns it. */
  fenced(): void;
  /** Runs the creation of a missing pickle key: one start at a time where the lock cannot order them. */
  serializeKeyCreation<T>(create: () => Promise<T>): Promise<T>;
}

/**
 * How a stamp of the owner token ended (stampVaultOwner): written (`stamped`,
 * a claim), or what a check found: the page's own token (`kept`), another
 * page's (`other`), or none at all, the database included (`missing`).
 */
export type VaultOwnerStamp = 'stamped' | 'kept' | 'other' | 'missing';

/**
 * Write or check the owner token of the vault `name`, on a connection of its
 * own, closed afterwards (an account deletion's delete request must not wait
 * on it).
 *
 * - `claim`: an acquisition. The token is written whatever is there, in one
 *   read-write transaction (the database is made when there is none): the
 *   newest owner wins, and the page it replaced is fenced at its next write.
 * - `keep`: a check, for a page that owns the vault already (a service start,
 *   a takeover notice, the read-back of a claim). It never writes and never
 *   makes the database: an open that would make it (or upgrade it) is
 *   abandoned before anything is made, and the token is read in a read-only
 *   transaction. The page keeps the vault only on `kept`; `other` and
 *   `missing` are for the caller to give the vault up on. Rejects when the
 *   database cannot be read.
 */
export function stampVaultOwner(name: string, token: string, mode: 'claim' | 'keep'): Promise<VaultOwnerStamp> {
  return mode === 'claim' ? claimVaultOwner(name, token) : checkVaultOwner(name, token);
}

function claimVaultOwner(name: string, token: string): Promise<VaultOwnerStamp> {
  return new Promise<VaultOwnerStamp>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KV_STORE)) req.result.createObjectStore(KV_STORE);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      let tx: IDBTransaction;
      try {
        tx = db.transaction(KV_STORE, 'readwrite');
      } catch (err) {
        db.close();
        reject(err);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve('stamped');
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('IndexedDB owner stamp aborted'));
      };
      tx.objectStore(KV_STORE).put(token, VAULT_OWNER_KEY);
    };
  });
}

function checkVaultOwner(name: string, token: string): Promise<VaultOwnerStamp> {
  return new Promise<VaultOwnerStamp>((resolve, reject) => {
    let wouldMake = false;
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      // No database at this version (deleted, or never made): the open is
      // abandoned, which leaves nothing behind, and the check answers so
      wouldMake = true;
      try {
        req.transaction?.abort();
      } catch (err) {
        // already finishing: the open then fails, and is answered below
        console.debug('e2e: the open of an owner check could not be abandoned:', err instanceof Error ? err.message : err);
      }
    };
    req.onerror = () => {
      if (wouldMake) resolve('missing');
      else reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (wouldMake || !db.objectStoreNames.contains(KV_STORE)) {
        db.close();
        resolve('missing');
        return;
      }
      let read: IDBRequest;
      try {
        read = db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(VAULT_OWNER_KEY);
      } catch (err) {
        db.close();
        reject(err);
        return;
      }
      read.onsuccess = () => {
        db.close();
        const stored: unknown = read.result;
        resolve(stored === token ? 'kept' : stored === undefined ? 'missing' : 'other');
      };
      read.onerror = () => {
        db.close();
        reject(read.error ?? new Error('IndexedDB owner check failed'));
      };
    };
  });
}

export class E2EVault {
  private db: IDBDatabase | null = null;
  private pickleKeyBytes: Uint8Array | null = null;
  /** Set by close(), never cleared. */
  private closedForGood = false;
  /** Set by stopReopening() (or close()): a lost connection stays lost. */
  private reopenRefused = false;
  /**
   * The connection close() kept for one late write of claimed key shares (see
   * closeKeepingConnectionForPendingShares); null once used, released, or
   * taken away by the browser.
   */
  private lateDb: IDBDatabase | null = null;
  /** Set when the fence refused this page (trip), never cleared: every access fails from then on. */
  private fencedForGood = false;
  /** A connection was opened once: from then on a task start compares the stored owner token (assertOwner). */
  private everOpened = false;

  constructor(
    private readonly userId: string,
    private readonly keyProvider: PickleKeyProvider = defaultPickleKeyProvider(),
    /** Isolates two vaults for the same account in one process (tests / multi-instance); by default this build's (see vaultDbName). */
    private readonly namespace: string | undefined = BUILD_VAULT_NAMESPACE,
    /**
     * What a connection must wait for before it opens the database: the
     * teardown of an earlier service on the same vault (see E2EService).
     */
    private readonly openAfter?: () => Promise<void> | undefined,
    /**
     * The page-level ownership every write is checked against (VaultFence).
     * The service always gives one; a vault made without it (a test of the
     * vault alone) checks nothing.
     */
    private readonly fence?: VaultFence
  ) {}

  /** Throw if close() ran or the fence refused this page: called before every access and after every await. */
  private assertNotClosed(): void {
    if (this.fencedForGood) throw new E2EVaultFencedError();
    if (this.closedForGood) throw new E2EVaultClosedError();
  }

  /** Is `stored` this page's owner token? Never while this page owns nothing. */
  private ownsStored(stored: unknown): boolean {
    const mine = this.fence?.token() ?? null;
    return mine !== null && stored === mine;
  }

  /**
   * This page does not own the vault any more: refuse everything from now on,
   * drop the connections, and tell the ownership (once). Returns the error the
   * refused access throws.
   */
  private trip(): E2EVaultFencedError {
    if (!this.fencedForGood) {
      this.fencedForGood = true;
      this.reopenRefused = true;
      this.db?.close();
      this.db = null;
      this.lateDb?.close();
      this.lateDb = null;
      try {
        this.fence?.fenced();
      } catch (err) {
        console.error('e2e: the vault ownership could not be told it was lost:', err instanceof Error ? err.message : err);
      }
    }
    return new E2EVaultFencedError();
  }

  /**
   * Run `run` in `store`'s read-write transaction only if the vault's owner
   * token is this page's, judged in that same transaction: IndexedDB runs
   * read-write transactions over the same store one at a time, so no other
   * page's token can land between the check and the write. `run` is called
   * from the check's success callback, while the transaction is still active,
   * and nothing else is issued before it; on another token (or none) the
   * transaction is aborted with nothing written, and the vault refuses this
   * page from then on.
   */
  private runFenced<T>(store: IDBObjectStore, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = store.get(VAULT_OWNER_KEY);
      check.onsuccess = () => {
        if (!this.ownsStored(check.result)) {
          try {
            store.transaction.abort();
          } catch (err) {
            // already finishing: it holds no request of ours either way
            console.debug('e2e: a refused vault transaction could not be aborted:', err instanceof Error ? err.message : err);
          }
          reject(this.trip());
          return;
        }
        let pending: Promise<T>;
        try {
          pending = run(store);
        } catch (err) {
          reject(err);
          return;
        }
        pending.then(resolve, reject);
      };
      check.onerror = () => reject(check.error ?? new Error('IndexedDB owner check failed'));
    });
  }

  /**
   * Is the vault still this page's? A read of the owner token, for the start
   * of every task of the service and before every request it sends: what a
   * task asks the server before its first write is not covered by the fence.
   * Before the first open nothing is read (open() checks it): only whether the
   * page owns the vault at all.
   */
  async assertOwner(): Promise<void> {
    this.assertNotClosed();
    if (!this.fence) return;
    if (!this.db && !this.everOpened) {
      await this.ensureOwnedBeforeOpen();
      return;
    }
    if (this.fence.token() === null) throw this.trip();
    const stored = await this.withStore('readonly', (s) => requestToPromise(s.get(VAULT_OWNER_KEY)));
    if (!this.ownsStored(stored)) throw this.trip();
  }

  /**
   * Before a first open: the page owns the vault, acquired now if nothing
   * acquired it yet; refused (E2EVaultNotOwnedError) when another page owns
   * it or this one gave it up. A vault this page once had and lost is not
   * acquired again here: its token went with it, and that trips the fence.
   */
  private async ensureOwnedBeforeOpen(): Promise<void> {
    if (!this.fence || this.fence.token() !== null) return;
    if (this.everOpened) throw this.trip();
    await this.fence.ensure();
    this.assertNotClosed();
    if (this.fence.token() === null) throw this.trip();
  }

  async open(): Promise<void> {
    this.assertNotClosed();
    if (this.db) return;
    // A page that does not own the vault opens nothing: the open below can
    // write (the pickle key, in open()), outside any transaction the fence sees
    await this.ensureOwnedBeforeOpen();
    if (this.db) return;
    const before = this.openAfter?.();
    if (before) {
      await before;
      this.assertNotClosed();
      if (this.db) return;
    }
    const name = vaultDbName(this.userId, this.namespace);
    // Anything under an older prefix belongs to key material the server no
    // longer has (the always-on cutover truncated it), so it can only produce
    // sessions that decrypt nothing. Dropped rather than left orphaned: it is
    // pickled key material sitting on disk with no purpose.
    void dropSupersededVaults(this.userId, this.namespace);
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KV_STORE)) {
        req.result.createObjectStore(KV_STORE);
      }
    };
    const db = await requestToPromise(req as IDBRequest<IDBDatabase>);
    if (this.closedForGood) {
      // closed while this connection was being opened: it is not ours to keep
      db.close();
      throw new E2EVaultClosedError();
    }
    // A page that gets backgrounded can have its IndexedDB connection closed
    // out from under it — the browser freezes or discards hidden tabs, and the
    // Tauri webview does the same when the window is hidden. The handle stays
    // in hand but every `transaction()` on it throws InvalidStateError from
    // then on, so the vault was permanently dead after the first hide/restore
    // and only a reload brought it back.
    //
    // Dropping the reference here means the next access reopens instead. Also
    // on `versionchange`, where another tab upgrading the database needs this
    // connection to let go or it blocks forever.
    db.onclose = () => {
      console.warn('e2e: vault connection was closed by the browser — will reopen on next use');
      if (this.db === db) this.db = null;
      if (this.lateDb === db) this.lateDb = null;
    };
    db.onversionchange = () => {
      // also the kept connection, at once: an account deletion is waiting on it
      db.close();
      if (this.db === db) this.db = null;
      if (this.lateDb === db) this.lateDb = null;
    };
    this.db = db;
    this.everOpened = true;
    // Still this page's vault, before anything is read from it or the pickle
    // key is made: a database made again under this page (deleted meanwhile)
    // holds no token, and another page's token means it took the vault over
    if (this.fence) {
      const stored = await requestToPromise(db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(VAULT_OWNER_KEY));
      this.assertNotClosed();
      if (!this.ownsStored(stored)) throw this.trip();
    }
    // Resolve the pickle key up-front (keychain access is async) so crypto
    // paths keep a synchronous accessor after open()
    if (!this.pickleKeyBytes) {
      const key = await this.loadOrCreatePickleKey();
      // close() already dropped the connection; keep nothing it would have freed
      this.assertNotClosed();
      this.pickleKeyBytes = key;
    }
  }

  /** The 32-byte vodozemac pickle key for this account (resolved in open()). */
  pickleKey(): Uint8Array {
    if (!this.pickleKeyBytes) throw new Error('vault not opened');
    return this.pickleKeyBytes;
  }

  private async loadOrCreatePickleKey(): Promise<Uint8Array> {
    const found = await this.loadPickleKey();
    if (found) return found;
    // None yet (a first start): made one start at a time, and looked up again
    // first, so that two starts never each make and save a key of their own
    const create = async (): Promise<Uint8Array> => (await this.loadPickleKey()) ?? (await this.createPickleKey());
    return this.fence ? this.fence.serializeKeyCreation(create) : create();
  }

  /** The stored pickle key, or null when there is none (or it is malformed). */
  private async loadPickleKey(): Promise<Uint8Array | null> {
    // Deliberately NOT caught: PickleKeyUnavailableError means the store did
    // not answer, and open() failing is the correct outcome — the caller
    // retries, and the next launch finds the real key. Swallowing it here is
    // how a transient keychain outage turns into a new identity.
    const stored = await this.keyProvider.load(this.userId);
    // Closed meanwhile: a key minted now would be saved for a session that has
    // ended, and could replace one another session stored in the meantime.
    this.assertNotClosed();
    if (stored) {
      let raw: Uint8Array | null = null;
      try {
        raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
      } catch (err) {
        // Same failure as the wrong-length case below: a value we cannot decode
        // is a corrupt entry, not an absent one. atob throws on non-base64, and
        // an unhandled throw here would have escaped as an opaque vault error.
        console.warn(
          'e2e: stored pickle key is not valid base64:',
          err instanceof Error ? err.message : err
        );
      }
      if (raw && raw.length === 32) return raw;
      console.warn('e2e: stored pickle key is malformed — generating a new one (existing pickles become unreadable)');
    }
    return null;
  }

  /** A new pickle key, saved before it is used. */
  private async createPickleKey(): Promise<Uint8Array> {
    // Still this page's vault right before the save, which no transaction fences
    if (this.fence) await this.assertOwner();
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    await this.keyProvider.save(this.userId, btoa(String.fromCharCode(...fresh)));
    return fresh;
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    this.assertNotClosed();
    if (!this.db) throw new Error('vault not opened');
    return this.db.transaction(KV_STORE, mode).objectStore(KV_STORE);
  }

  /**
   * Run one store operation, reopening the vault once if the connection died.
   *
   * `onclose` covers the case where the browser tells us. It does not always:
   * the handle can already be unusable by the time we look, and `transaction()`
   * then throws InvalidStateError synchronously. Both paths land here, and both
   * are retried exactly once — a second failure is a real fault and is raised.
   *
   * A vault closed on purpose is never reopened, and an operation that was
   * running when close() came fails rather than returning: its caller holds
   * engine objects that were freed with the service, and must go no further.
   *
   * Every read-write transaction goes through the fence (runFenced) when the
   * vault has one: it writes only while the stored owner token is this
   * page's. Once the fence refused the page, every operation fails with
   * E2EVaultFencedError, whatever the browser answered it.
   */
  private async withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>
  ): Promise<T> {
    this.assertNotClosed();
    if (!this.db) {
      if (this.reopenRefused) throw this.fencedForGood ? new E2EVaultFencedError() : new E2EVaultClosedError();
      await this.open();
    }
    const attempt = (): Promise<T> => {
      const store = this.store(mode);
      return mode === 'readwrite' && this.fence ? this.runFenced(store, run) : run(store);
    };
    try {
      const result = await attempt();
      this.assertNotClosed();
      return result;
    } catch (err) {
      // the fence first: the connection it closed fails its siblings with an
      // error that would otherwise read as one to reopen
      if (this.fencedForGood) throw err instanceof E2EVaultFencedError ? err : new E2EVaultFencedError();
      if (this.closedForGood) throw err instanceof E2EVaultClosedError ? err : new E2EVaultClosedError();
      if (!isConnectionGone(err)) throw err;
      if (this.reopenRefused) throw new E2EVaultClosedError();
      console.warn('e2e: vault connection was gone — reopening and retrying once');
      this.db?.close();
      this.db = null;
      await this.open();
      const result = await attempt();
      this.assertNotClosed();
      return result;
    }
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return this.withStore('readonly', (s) => requestToPromise(s.get(key))) as Promise<T | undefined>;
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.withStore('readwrite', (s) => requestToPromise(s.put(value, key)));
  }

  private async delete(key: string): Promise<void> {
    await this.withStore('readwrite', (s) => requestToPromise(s.delete(key)));
  }

  private async keysWithPrefix(prefix: string): Promise<string[]> {
    const range = IDBKeyRange.bound(prefix, prefix + KEY_MAX);
    const keys = await this.withStore('readonly', (s) => requestToPromise(s.getAllKeys(range)));
    return keys.map(String);
  }

  private async deleteWithPrefix(prefix: string): Promise<void> {
    // One request over the key range, in one fenced transaction
    const range = IDBKeyRange.bound(prefix, prefix + KEY_MAX);
    await this.withStore('readwrite', (s) => requestToPromise(s.delete(range)));
  }

  // ── This install's device id (spec §12, D2) ──
  getDeviceId(): Promise<string | undefined> {
    return this.get('device_id');
  }
  putDeviceId(deviceId: string): Promise<void> {
    return this.put('device_id', deviceId);
  }

  // ── Account pickle ──
  getAccountPickle(): Promise<string | undefined> {
    return this.get('account');
  }
  putAccountPickle(pickle: string): Promise<void> {
    return this.put('account', pickle);
  }

  // ── Account master key (cross-signing, spec §14) ──
  /** Our own master private key, SEALED with the pickle key (never raw). */
  getMasterSecret(): Promise<string | undefined> {
    return this.get('master_secret');
  }
  putMasterSecret(sealed: string): Promise<void> {
    return this.put('master_secret', sealed);
  }
  deleteMasterSecret(): Promise<void> {
    return this.delete('master_secret');
  }

  /** Pinned account master key of a user (TOFU, public material only). */
  getMasterIdentity(userId: string): Promise<PinnedMasterKey | undefined> {
    return this.get(`master:${userId}`);
  }
  putMasterIdentity(userId: string, pinned: PinnedMasterKey): Promise<void> {
    return this.put(`master:${userId}`, pinned);
  }

  // ── Pairwise Olm session pickles (one per REMOTE DEVICE, plus a fallback
  //    slot for the session displaced by establishment glare — both sides of a
  //    call create sessions simultaneously, and each keeps decrypting the
  //    peer's chain through its fallback; see olmDecryptFromDevice) ──
  getSessionPickle(userId: string, deviceId: string): Promise<string | undefined> {
    return this.get(`session:${userId}:${deviceId}`);
  }
  putSessionPickle(userId: string, deviceId: string, pickle: string): Promise<void> {
    return this.put(`session:${userId}:${deviceId}`, pickle);
  }
  // Suffixed under the session: prefix so deleteSessionsForUser covers it
  // (device ids cannot contain ':', so the keys never collide).
  getFallbackSessionPickle(userId: string, deviceId: string): Promise<string | undefined> {
    return this.get(`session:${userId}:${deviceId}:fb`);
  }
  putFallbackSessionPickle(userId: string, deviceId: string, pickle: string): Promise<void> {
    return this.put(`session:${userId}:${deviceId}:fb`, pickle);
  }
  deleteFallbackSession(userId: string, deviceId: string): Promise<void> {
    return this.delete(`session:${userId}:${deviceId}:fb`);
  }
  async deleteSession(userId: string, deviceId: string): Promise<void> {
    await this.delete(`session:${userId}:${deviceId}`);
    await this.delete(`session:${userId}:${deviceId}:fb`);
  }
  /** Drop every device session with one user (identity change / explicit reset). */
  deleteSessionsForUser(userId: string): Promise<void> {
    return this.deleteWithPrefix(`session:${userId}:`);
  }
  /** Pre-multi-device session pickle, kept readable for legacy olm1 history. */
  getLegacySessionPickle(userId: string): Promise<string | undefined> {
    return this.get(`session:${userId}`);
  }
  putLegacySessionPickle(userId: string, pickle: string): Promise<void> {
    return this.put(`session:${userId}`, pickle);
  }

  // ── Pinned device identities (TOFU, per device) ──
  getIdentity(userId: string, deviceId: string): Promise<PinnedIdentity | undefined> {
    return this.get(`identity:${userId}:${deviceId}`);
  }
  putIdentity(userId: string, deviceId: string, identity: PinnedIdentity): Promise<void> {
    return this.put(`identity:${userId}:${deviceId}`, identity);
  }
  deleteIdentity(userId: string, deviceId: string): Promise<void> {
    return this.delete(`identity:${userId}:${deviceId}`);
  }
  /** Pre-multi-device pin — only consulted to carry over the verified flag. */
  getLegacyIdentity(userId: string): Promise<PinnedIdentity | undefined> {
    return this.get(`identity:${userId}`);
  }

  /** Every device of `userId` this device has pinned, in no particular order. */
  async listIdentities(userId: string): Promise<Array<{ deviceId: string; identity: PinnedIdentity }>> {
    const prefix = `identity:${userId}:`;
    const keys = await this.keysWithPrefix(prefix);
    const out: Array<{ deviceId: string; identity: PinnedIdentity }> = [];
    for (const key of keys) {
      const identity = await this.get<PinnedIdentity>(key);
      if (identity) out.push({ deviceId: key.slice(prefix.length), identity });
    }
    return out;
  }

  // ── Device-list version tracking ──
  getDeviceListState(userId: string): Promise<DeviceListState | undefined> {
    return this.get(`dlv:${userId}`);
  }
  putDeviceListState(userId: string, state: DeviceListState): Promise<void> {
    return this.put(`dlv:${userId}`, state);
  }

  // ── Outbound Megolm sessions (one per conversation) ──
  getOutboundGroupSession(conversationId: string): Promise<OutboundGroupSessionRecord | undefined> {
    return this.get(`gs:${conversationId}`);
  }
  putOutboundGroupSession(conversationId: string, record: OutboundGroupSessionRecord): Promise<void> {
    return this.put(`gs:${conversationId}`, record);
  }
  deleteOutboundGroupSession(conversationId: string): Promise<void> {
    return this.delete(`gs:${conversationId}`);
  }
  /** Force a re-key of every conversation (device revoked / identity accepted). */
  deleteAllOutboundGroupSessions(): Promise<void> {
    return this.deleteWithPrefix('gs:');
  }

  // ── Inbound Megolm sessions (keyed by session id) ──
  getInboundGroupSession(sessionId: string): Promise<InboundGroupSessionRecord | undefined> {
    return this.get(`igs:${sessionId}`);
  }
  putInboundGroupSession(sessionId: string, record: InboundGroupSessionRecord): Promise<void> {
    return this.put(`igs:${sessionId}`, record);
  }
  /**
   * Drop every inbound session attributed to a user. Used when their identity
   * changes: whoever holds the old keys could otherwise keep publishing into
   * sessions we already trust, and it would render as authentic.
   */
  /**
   * Session ids this device has already uploaded to the message-key backup.
   * Local-only bookkeeping: losing it re-uploads, which the server upserts, so
   * it is an optimisation rather than state anything depends on.
   */
  async getBackedUpSessionIds(): Promise<string[]> {
    return (await this.get<string[]>('bku:sessions')) ?? [];
  }

  async addBackedUpSessionIds(sessionIds: string[]): Promise<void> {
    const known = new Set(await this.getBackedUpSessionIds());
    for (const id of sessionIds) known.add(id);
    await this.put('bku:sessions', [...known]);
  }

  // ── Repairs that ran on this vault (repair:{name}: when, nothing else) ──
  getRepair(name: string): Promise<{ at: number } | undefined> {
    return this.get(`repair:${name}`);
  }
  putRepair(name: string): Promise<void> {
    return this.put(`repair:${name}`, { at: Date.now() });
  }

  // ── When a claim of the key-share inbox last left (claim_sent: when, nothing else) ──
  getClaimSent(): Promise<{ at: number } | undefined> {
    return this.get('claim_sent');
  }
  putClaimSent(): Promise<void> {
    return this.put('claim_sent', { at: Date.now() });
  }

  // ── Where an unfinished message-key history pull stands (spec §16.3) ──
  getHistoryPull(): Promise<HistoryPullMarker | undefined> {
    return this.get('history_pull');
  }
  putHistoryPull(marker: HistoryPullMarker): Promise<void> {
    return this.put('history_pull', marker);
  }
  deleteHistoryPull(): Promise<void> {
    return this.delete('history_pull');
  }

  // ── Key shares claimed but not imported yet (spec §12.3) ──

  /** Keep a claimed page in one transaction, before any of it is processed. */
  putPendingShares(entries: Array<{ key: string; record: PendingKeyShare }>): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return this.withStore('readwrite', (s) =>
      Promise.all(entries.map((e) => requestToPromise(s.put(e.record, e.key)))).then(() => undefined)
    );
  }

  putPendingShare(key: string, record: PendingKeyShare): Promise<void> {
    return this.put(key, record);
  }

  deletePendingShare(key: string): Promise<void> {
    return this.delete(key);
  }

  /** Oldest first (the key starts with the share's creation time), in one transaction. */
  listPendingShares(): Promise<Array<{ key: string; record: PendingKeyShare }>> {
    const range = IDBKeyRange.bound('pks:', `pks:${KEY_MAX}`);
    return this.withStore('readonly', async (s) => {
      // both requests issued in this tick: one transaction, the same key order
      const [keys, values] = await Promise.all([
        requestToPromise(s.getAllKeys(range)),
        requestToPromise(s.getAll(range)),
      ]);
      return keys.map((key, i) => ({ key: String(key), record: values[i] as PendingKeyShare }));
    });
  }

  // ── Acknowledgements owed for claimed key shares (spec §12.3) ──
  // Share ids only (`pka:{shareId}`): what the server already holds, no more.

  /** Note that this device owes the server an acknowledgement of this share. */
  putShareAck(id: string): Promise<void> {
    const owed: OwedShareAck = { id, at: Date.now() };
    return this.put(`pka:${id}`, owed);
  }

  /** Every acknowledgement owed, in one transaction. */
  listShareAcks(): Promise<OwedShareAck[]> {
    const range = IDBKeyRange.bound('pka:', `pka:${KEY_MAX}`);
    return this.withStore('readonly', (s) => requestToPromise(s.getAll(range))) as Promise<OwedShareAck[]>;
  }

  /** Forget acknowledgements the server has confirmed (or that are past its retention), in one transaction. */
  deleteShareAcks(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.withStore('readwrite', (s) =>
      Promise.all(ids.map((id) => requestToPromise(s.delete(`pka:${id}`)))).then(() => undefined)
    );
  }

  /**
   * Every inbound group session this device holds (spec §16 backup), read in
   * ONE transaction: the backup pass runs this at every start, and a read per
   * session made it cost one transaction per session ever received.
   */
  listInboundGroupSessions(): Promise<InboundGroupSessionRecord[]> {
    const range = IDBKeyRange.bound('igs:', `igs:${KEY_MAX}`);
    return this.withStore('readonly', (s) => requestToPromise(s.getAll(range))) as Promise<InboundGroupSessionRecord[]>;
  }

  async deleteInboundGroupSessionsFrom(userId: string): Promise<string[]> {
    const keys = await this.keysWithPrefix('igs:');
    const removed: string[] = [];
    for (const key of keys) {
      const record = await this.get<InboundGroupSessionRecord>(key);
      if (record?.senderUserId === userId) {
        await this.delete(key);
        removed.push(key.slice('igs:'.length));
      }
    }
    return removed;
  }

  // ── Decrypted plaintext cache ──
  getPlaintext(messageId: string): Promise<CachedPlaintext | undefined> {
    return this.get(`pt:${messageId}`);
  }
  putPlaintext(messageId: string, entry: CachedPlaintext): Promise<void> {
    return this.put(`pt:${messageId}`, entry);
  }
  deletePlaintext(messageId: string): Promise<void> {
    return this.delete(`pt:${messageId}`);
  }

  // ── Ratchet-position bindings (replay / rollback firewall) ──
  getMessagePosition(sessionId: string, messageIndex: number): Promise<MessagePositionBinding | undefined> {
    return this.get(`mi:${sessionId}:${messageIndex}`);
  }
  putMessagePosition(sessionId: string, messageIndex: number, binding: MessagePositionBinding): Promise<void> {
    return this.put(`mi:${sessionId}:${messageIndex}`, binding);
  }

  /**
   * Scan all cached plaintexts of one conversation (client-side E2E search).
   * Cursor over the `pt:` key range — DM history volumes make a linear scan
   * cheap, and it avoids a schema migration for a dedicated index.
   */
  listPlaintexts(conversationId: string): Promise<Array<{ messageId: string; entry: CachedPlaintext }>> {
    // Through withStore like every other access: a connection the browser
    // dropped is reopened, and a vault closed on purpose is not
    return this.withStore('readonly', (store) =>
      new Promise((resolve, reject) => {
        const results: Array<{ messageId: string; entry: CachedPlaintext }> = [];
        const range = IDBKeyRange.bound('pt:', `pt:${KEY_MAX}`);
        const cursorReq = store.openCursor(range);
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('IndexedDB cursor failed'));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          const entry = cursor.value as CachedPlaintext;
          if (entry.conversationId === conversationId && !entry.failed) {
            results.push({ messageId: String(cursor.key).slice(3), entry });
          }
          cursor.continue();
        };
      })
    );
  }

  /**
   * One batch of a purge of the plaintext cache (E2EService.purgeCachedPlaintexts):
   * ONE readwrite cursor over the `pt:` range, starting after the key `after`
   * (from the start when null), that visits at most `limit` entries of any
   * scope, deletes those of `scopes` for which `remove` answers true, and stops.
   * Answers how many it deleted and the key to resume after, or `next: null`
   * once the range is done. Settles when the transaction has committed.
   *
   * `remove` runs synchronously inside the transaction (nothing may be awaited
   * there, or IndexedDB commits it); one that throws aborts the batch, so it
   * deletes nothing.
   */
  purgePlaintextBatch(
    scopes: ReadonlySet<string>,
    remove: (entry: PlaintextPurgeEntry) => boolean,
    after: string | null,
    limit: number,
  ): Promise<{ removed: number; next: string | null }> {
    return this.withStore('readwrite', (store) =>
      new Promise((resolve, reject) => {
        const tx = store.transaction;
        const upper = `pt:${KEY_MAX}`;
        const range = after === null ? IDBKeyRange.bound('pt:', upper) : IDBKeyRange.bound(after, upper, true, false);
        let removed = 0;
        let visited = 0;
        let next: string | null = null;
        let failure: unknown = null;
        tx.oncomplete = () => resolve({ removed, next });
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('IndexedDB purge transaction aborted'));
        const cursorReq = store.openCursor(range);
        cursorReq.onerror = () => {
          failure = cursorReq.error ?? new Error('IndexedDB cursor failed');
        };
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            next = null;
            return;
          }
          const key = String(cursor.key);
          const entry = cursor.value as CachedPlaintext | undefined;
          visited += 1;
          if (entry && scopes.has(entry.conversationId)) {
            let drop: boolean;
            try {
              drop = remove({
                scope: entry.conversationId,
                messageId: key.slice(3),
                ...(entry.authorId !== undefined && { authorId: entry.authorId }),
                ...(entry.createdAt !== undefined && { createdAt: entry.createdAt }),
                editedAt: entry.editedAt ?? null,
              });
            } catch (err) {
              failure = err;
              tx.abort();
              return;
            }
            if (drop) {
              cursor.delete();
              removed += 1;
            }
          }
          if (visited >= limit) {
            next = key;
            return;
          }
          cursor.continue();
        };
      })
    );
  }

  // ── Purges that ended, per scope (ptpurge:{mark}:{scope}) ──
  // `mark` names what the purge removed, so a later session skips the walk
  // for a scope already done; nothing but the time is stored, and for a
  // LEVELLED mark (`levels`: a cleared history's floor) the level the walk
  // purged up to as well.

  /**
   * The scopes among `scopes` a purge under `mark` has not ended for yet, in
   * one transaction. With `levels`, a scope whose record holds no level, or a
   * level below the one asked, has not.
   */
  scopesNotPurged(mark: string, scopes: readonly string[], levels?: ReadonlyMap<string, number>): Promise<string[]> {
    if (scopes.length === 0) return Promise.resolve([]);
    return this.withStore('readonly', async (s) => {
      // every request issued in this tick: one transaction
      const done = await Promise.all(scopes.map((scope) => requestToPromise(s.get(`ptpurge:${mark}:${scope}`))));
      return scopes.filter((scope, i) => {
        const record = done[i] as PurgeRecord | undefined;
        if (record === undefined) return true;
        if (!levels) return false;
        const asked = levels.get(scope);
        return typeof record.level !== 'number' || asked === undefined || record.level < asked;
      });
    });
  }

  /** Every scope a purge under `mark` has ended for: one range read of `ptpurge:{mark}:`. */
  async listPurgedScopes(mark: string): Promise<string[]> {
    const prefix = `ptpurge:${mark}:`;
    return (await this.keysWithPrefix(prefix)).map((key) => key.slice(prefix.length));
  }

  /** Forget that a purge under `mark` ended for `scope`: the next session walks it again. */
  deletePurgeMark(mark: string, scope: string): Promise<void> {
    return this.delete(`ptpurge:${mark}:${scope}`);
  }

  /**
   * Record that a purge under `mark` ended for `scopes`, in one transaction.
   * With `levels`, each record holds its scope's level, and a record already
   * holding a higher one keeps it (a level never moves back).
   */
  putScopesPurged(mark: string, scopes: readonly string[], levels?: ReadonlyMap<string, number>): Promise<void> {
    if (scopes.length === 0) return Promise.resolve();
    const at = Date.now();
    if (!levels) {
      return this.withStore('readwrite', (s) =>
        Promise.all(scopes.map((scope) => requestToPromise(s.put({ at }, `ptpurge:${mark}:${scope}`)))).then(() => undefined)
      );
    }
    const asked = scopes.map((scope) => levels.get(scope));
    if (asked.some((level) => level === undefined || !Number.isFinite(level))) {
      return Promise.reject(new Error('a levelled purge record needs a level for every scope'));
    }
    // ONE transaction: each write is issued from its read's success callback,
    // while the transaction is still active (never after an await, where it
    // may already have committed); a failed request aborts it whole
    return this.withStore('readwrite', (s) =>
      new Promise<void>((resolve, reject) => {
        const tx = s.transaction;
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB purge record transaction aborted'));
        scopes.forEach((scope, i) => {
          const key = `ptpurge:${mark}:${scope}`;
          const level = asked[i] as number;
          const read = s.get(key);
          read.onsuccess = () => {
            const record = read.result as PurgeRecord | undefined;
            const kept = typeof record?.level === 'number' && record.level > level ? record.level : level;
            s.put({ at, level: kept } satisfies PurgeRecord, key);
          };
        });
      })
    );
  }

  /**
   * Keep the open connection usable, but never open another one. For the
   * stretch between a dispose and the close() that follows a key-share claim
   * still in flight: if the browser drops the connection meanwhile (an account
   * deletion's deleteDatabase does exactly that), reopening would recreate the
   * database being deleted.
   */
  stopReopening(): void {
    this.reopenRefused = true;
  }

  /**
   * close(), except that the open connection is kept for ONE late write of
   * claimed key shares (writePendingSharesLate), then released. Every other
   * access fails exactly as after close(). For a teardown that runs while a
   * claim's answer is still on its way: a server from before leases deleted
   * the shares it returned, so that answer has to land somewhere when it
   * comes, and a leasing one would hand them out again only once the lease
   * passed, while written here the next start imports them at once.
   */
  closeKeepingConnectionForPendingShares(): void {
    this.lateDb = this.db;
    this.db = null; // so close() leaves it open
    this.close();
  }

  /**
   * The late write, on the kept connection; releases it either way. Fenced
   * like every other write: a page that gave the vault up meanwhile (another
   * page took it over) writes nothing into it.
   */
  async writePendingSharesLate(entries: Array<{ key: string; record: PendingKeyShare }>): Promise<void> {
    if (this.fencedForGood) throw new E2EVaultFencedError();
    const db = this.lateDb;
    if (!db) throw new E2EVaultClosedError(); // released, or the browser took it
    try {
      if (entries.length === 0) return;
      const store = db.transaction(KV_STORE, 'readwrite').objectStore(KV_STORE);
      const write = (s: IDBObjectStore) =>
        Promise.all(entries.map((e) => requestToPromise(s.put(e.record, e.key)))).then(() => undefined);
      await (this.fence ? this.runFenced(store, write) : write(store));
    } finally {
      this.releaseLateConnection();
    }
  }

  /** Drop the connection kept for a late write that will not come. */
  releaseLateConnection(): void {
    this.lateDb?.close();
    this.lateDb = null;
  }

  /** Close for good (the service is being disposed); see E2EVaultClosedError. */
  close(): void {
    this.closedForGood = true;
    this.reopenRefused = true;
    this.db?.close();
    this.db = null;
    this.pickleKeyBytes = null;
  }
}
