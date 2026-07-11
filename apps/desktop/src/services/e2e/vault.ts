// Per-account local vault for E2E state (docs/e2e-dm-spec.md §7).
//
// Stores, per logged-in user, in IndexedDB `voxium-e2e-{userId}`:
//   - the Olm account pickle (encrypted by vodozemac with the pickle key)
//   - session pickles per peer (same encryption)
//   - pinned peer identities (public keys — TOFU + safety-number verification)
//   - the decrypted-plaintext message cache (ratchet keys are one-shot; a
//     ciphertext refetched from the server can never be decrypted again)
//
// The 32-byte pickle key is the only secret JS touches. In the Tauri app it
// lives in the OS keychain; browser dev builds fall back to localStorage
// (spec §7.3, providers in ./pickleKeyProvider). Keys never leave the device
// either way.
import { defaultPickleKeyProvider, type PickleKeyProvider } from './pickleKeyProvider';

export type { PickleKeyProvider };

const KV_STORE = 'kv';

export interface PinnedIdentity {
  curve25519Key: string;
  ed25519Key: string;
  verified: boolean; // true once the user compared safety numbers
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

export class E2EVault {
  private db: IDBDatabase | null = null;
  private pickleKeyBytes: Uint8Array | null = null;

  constructor(
    private readonly userId: string,
    private readonly keyProvider: PickleKeyProvider = defaultPickleKeyProvider()
  ) {}

  async open(): Promise<void> {
    if (this.db) return;
    const req = indexedDB.open(`voxium-e2e-${this.userId}`, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KV_STORE)) {
        req.result.createObjectStore(KV_STORE);
      }
    };
    this.db = await requestToPromise(req as IDBRequest<IDBDatabase>);
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
    const stored = await this.keyProvider.load(this.userId);
    if (stored) {
      const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
      if (raw.length === 32) return raw;
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

  private async get<T>(key: string): Promise<T | undefined> {
    return requestToPromise(this.store('readonly').get(key)) as Promise<T | undefined>;
  }

  private async put(key: string, value: unknown): Promise<void> {
    await requestToPromise(this.store('readwrite').put(value, key));
  }

  private async delete(key: string): Promise<void> {
    await requestToPromise(this.store('readwrite').delete(key));
  }

  // ── Account pickle ──
  getAccountPickle(): Promise<string | undefined> {
    return this.get('account');
  }
  putAccountPickle(pickle: string): Promise<void> {
    return this.put('account', pickle);
  }

  // ── Session pickles (one Olm session per peer in MVP) ──
  getSessionPickle(peerUserId: string): Promise<string | undefined> {
    return this.get(`session:${peerUserId}`);
  }
  putSessionPickle(peerUserId: string, pickle: string): Promise<void> {
    return this.put(`session:${peerUserId}`, pickle);
  }
  deleteSession(peerUserId: string): Promise<void> {
    return this.delete(`session:${peerUserId}`);
  }

  // ── Pinned peer identities ──
  getIdentity(peerUserId: string): Promise<PinnedIdentity | undefined> {
    return this.get(`identity:${peerUserId}`);
  }
  putIdentity(peerUserId: string, identity: PinnedIdentity): Promise<void> {
    return this.put(`identity:${peerUserId}`, identity);
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
      const range = IDBKeyRange.bound('pt:', 'pt:￿');
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
