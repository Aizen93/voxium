// Per-account local vault for E2E state (docs/e2e-dm-spec.md §7, §12).
//
// One IndexedDB database per logged-in user (`voxium-e2e-{userId}`), a single
// key/value object store, and these key namespaces:
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
//   pt:{messageId}                   decrypted-plaintext cache entry
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
// The 32-byte pickle key is the only secret JS touches. In the Tauri app it
// lives in the OS keychain; browser dev builds fall back to localStorage
// (spec §7.3, providers in ./pickleKeyProvider). Keys never leave the device
// either way.
import { defaultPickleKeyProvider, type PickleKeyProvider } from './pickleKeyProvider';

export type { PickleKeyProvider };

const KV_STORE = 'kv';
/** Upper bound for prefix range scans (highest BMP code point). */
const KEY_MAX = '￿';

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

/** The IndexedDB name of an account's vault on this device. */
export function vaultDbName(userId: string, namespace?: string): string {
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

export class E2EVault {
  private db: IDBDatabase | null = null;
  private pickleKeyBytes: Uint8Array | null = null;

  constructor(
    private readonly userId: string,
    private readonly keyProvider: PickleKeyProvider = defaultPickleKeyProvider(),
    /** Isolates two vaults for the same account in one process (tests / multi-instance). */
    private readonly namespace?: string
  ) {}

  async open(): Promise<void> {
    if (this.db) return;
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
    };
    db.onversionchange = () => {
      db.close();
      if (this.db === db) this.db = null;
    };
    this.db = db;
    // Resolve the pickle key up-front (keychain access is async) so crypto
    // paths keep a synchronous accessor after open()
    if (!this.pickleKeyBytes) {
      this.pickleKeyBytes = await this.loadOrCreatePickleKey();
    }
  }

  /** The 32-byte vodozemac pickle key for this account (resolved in open()). */
  pickleKey(): Uint8Array {
    if (!this.pickleKeyBytes) throw new Error('vault not opened');
    return this.pickleKeyBytes;
  }

  private async loadOrCreatePickleKey(): Promise<Uint8Array> {
    // Deliberately NOT caught: PickleKeyUnavailableError means the store did
    // not answer, and open() failing is the correct outcome — the caller
    // retries, and the next launch finds the real key. Swallowing it here is
    // how a transient keychain outage turns into a new identity.
    const stored = await this.keyProvider.load(this.userId);
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
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    await this.keyProvider.save(this.userId, btoa(String.fromCharCode(...fresh)));
    return fresh;
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
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
   */
  private async withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>
  ): Promise<T> {
    if (!this.db) await this.open();
    try {
      return await run(this.store(mode));
    } catch (err) {
      if (!isConnectionGone(err)) throw err;
      console.warn('e2e: vault connection was gone — reopening and retrying once');
      this.db?.close();
      this.db = null;
      await this.open();
      return run(this.store(mode));
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
    const keys = await this.keysWithPrefix(prefix);
    if (keys.length === 0) return;
    // One transaction: every request is issued synchronously in this tick, so
    // the transaction cannot auto-close between them.
    const store = this.store('readwrite');
    await Promise.all(keys.map((key) => requestToPromise(store.delete(key))));
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

  /** Every inbound group session this device holds (spec §16 backup). */
  async listInboundGroupSessions(): Promise<InboundGroupSessionRecord[]> {
    const keys = await this.keysWithPrefix('igs:');
    const records: InboundGroupSessionRecord[] = [];
    for (const key of keys) {
      const record = await this.get<InboundGroupSessionRecord>(key);
      if (record) records.push(record);
    }
    return records;
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

  /**
   * Scan all cached plaintexts of one conversation (client-side E2E search).
   * Cursor over the `pt:` key range — DM history volumes make a linear scan
   * cheap, and it avoids a schema migration for a dedicated index.
   */
  listPlaintexts(conversationId: string): Promise<Array<{ messageId: string; entry: CachedPlaintext }>> {
    return new Promise((resolve, reject) => {
      const results: Array<{ messageId: string; entry: CachedPlaintext }> = [];
      const range = IDBKeyRange.bound('pt:', `pt:${KEY_MAX}`);
      const cursorReq = this.store('readonly').openCursor(range);
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
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.pickleKeyBytes = null;
  }
}
