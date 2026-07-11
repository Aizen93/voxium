// E2E DM service (docs/e2e-dm-spec.md). Orchestrates the WASM engine, the
// local vault, and the server's key-distribution API. All Olm state mutations
// run through a serial queue: account/session pickles must be persisted in the
// same order the ratchet advances, or a crash could roll the ratchet back.
import { E2E_LIMITS, e2eDeviceCanonical, e2eKeyCanonical, parseE2EEnvelope, buildE2EEnvelope, parseE2EPlaintext } from '@voxium/shared';
import type { E2EKeyBundle, E2EPreKey } from '@voxium/shared';
import { api as defaultApi } from '../api';
import {
  initEngine,
  EngineAccount,
  EngineSession,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
} from './engine';
import { E2EVault, type PickleKeyProvider, type PinnedIdentity } from './vault';

interface OneTimeKeyPair {
  keyId: string;
  key: string;
}

export interface DecryptResult {
  text: string;
  failed?: boolean;
}

/** The peer registered a new device — sessions and safety numbers changed. */
export class E2EIdentityChangedError extends Error {
  constructor(public readonly peerUserId: string) {
    super('Peer identity key changed');
    this.name = 'E2EIdentityChangedError';
  }
}

export interface E2EServiceOptions {
  api?: typeof defaultApi;
  keyProvider?: PickleKeyProvider;
  /** Test hook: raw wasm bytes for node environments. */
  wasmInput?: BufferSource;
}

export class E2EService {
  private readonly api: typeof defaultApi;
  private readonly vault: E2EVault;
  private account: EngineAccount | null = null;
  private sessions = new Map<string, EngineSession>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly userId: string,
    opts: E2EServiceOptions = {}
  ) {
    this.api = opts.api ?? defaultApi;
    this.vault = new E2EVault(userId, opts.keyProvider);
    this.wasmInput = opts.wasmInput;
  }

  private readonly wasmInput?: BufferSource;

  /** Serialize all crypto-state mutations (ratchet advance ⇒ pickle persist). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await initEngine(this.wasmInput);
    await this.vault.open();

    const pickle = await this.vault.getAccountPickle();
    if (pickle) {
      try {
        this.account = EngineAccount.fromPickle(pickle, this.vault.pickleKey());
      } catch (err) {
        // Pickle key lost (e.g. localStorage cleared) — the old account is
        // unrecoverable. Start a fresh identity; peers will see a safety
        // number change, which is the honest signal for exactly this event.
        console.warn('e2e: account pickle unreadable — generating a new identity:', err instanceof Error ? err.message : err);
        this.account = new EngineAccount();
        await this.persistAccount();
      }
    } else {
      this.account = new EngineAccount();
      await this.persistAccount();
    }

    await this.ensureRegistered();
    this.initialized = true;
    // Replenishment can lag initialization — never block the UI on it
    this.replenishOneTimeKeys().catch((err) => {
      console.warn('e2e: one-time key replenishment failed:', err instanceof Error ? err.message : err);
    });
  }

  dispose(): void {
    this.account?.free();
    this.account = null;
    for (const session of this.sessions.values()) session.free();
    this.sessions.clear();
    this.vault.close();
    this.initialized = false;
  }

  private async persistAccount(): Promise<void> {
    if (!this.account) throw new Error('e2e account not initialized');
    await this.vault.putAccountPickle(this.account.pickle(this.vault.pickleKey()));
  }

  private async persistSession(peerUserId: string, session: EngineSession): Promise<void> {
    await this.vault.putSessionPickle(peerUserId, session.pickle(this.vault.pickleKey()));
  }

  private requireAccount(): EngineAccount {
    if (!this.account) throw new Error('e2e service not initialized');
    return this.account;
  }

  // ─── Device registration & key upkeep ───────────────────────────────────────

  private signedPreKey(account: EngineAccount, k: OneTimeKeyPair): E2EPreKey {
    return {
      keyId: k.keyId,
      key: k.key,
      signature: account.sign(e2eKeyCanonical(this.userId, account.curve25519Key(), k.keyId, k.key)),
    };
  }

  private async ensureRegistered(): Promise<void> {
    const account = this.requireAccount();
    const res = await this.api.get('/e2e/devices/me');
    const status = res.data.data as { registered: boolean; curve25519Key?: string };

    // Registered with OUR identity → nothing to do. A different identity means
    // another install owns the server slot; we cannot use its private keys, so
    // we re-register (invalidating it — single-device MVP, spec §4.4).
    if (status.registered && status.curve25519Key === account.curve25519Key()) return;

    // Reuse unpublished keys if a previous registration attempt failed mid-way
    let otks = account.oneTimeKeys() as OneTimeKeyPair[];
    if (otks.length < E2E_LIMITS.OTK_TARGET) {
      account.generateOneTimeKeys(E2E_LIMITS.OTK_TARGET - otks.length);
      otks = account.oneTimeKeys() as OneTimeKeyPair[];
    }
    let fallback = account.fallbackKey() as OneTimeKeyPair | null;
    if (!fallback) {
      account.generateFallbackKey();
      fallback = account.fallbackKey() as OneTimeKeyPair | null;
      if (!fallback) throw new Error('failed to generate fallback key');
    }
    await this.persistAccount();

    await this.api.put('/e2e/devices', {
      curve25519Key: account.curve25519Key(),
      ed25519Key: account.ed25519Key(),
      deviceSignature: account.sign(e2eDeviceCanonical(this.userId, account.curve25519Key(), account.ed25519Key())),
      oneTimeKeys: otks.map((k) => this.signedPreKey(account, k)),
      fallbackKey: this.signedPreKey(account, fallback),
    });

    account.markKeysAsPublished();
    await this.persistAccount();
  }

  async replenishOneTimeKeys(): Promise<void> {
    return this.enqueue(async () => {
      const account = this.requireAccount();
      const res = await this.api.get('/e2e/devices/me');
      const status = res.data.data as { registered: boolean; oneTimeKeyCount?: number };
      if (!status.registered) return;
      const count = status.oneTimeKeyCount ?? 0;
      if (count >= E2E_LIMITS.OTK_LOW_WATER) return;

      account.generateOneTimeKeys(Math.min(E2E_LIMITS.OTK_TARGET - count, E2E_LIMITS.OTK_UPLOAD_MAX));
      const fresh = account.oneTimeKeys() as OneTimeKeyPair[];
      if (fresh.length === 0) return;
      await this.persistAccount();
      await this.api.post('/e2e/devices/me/keys', {
        oneTimeKeys: fresh.map((k) => this.signedPreKey(account, k)),
      });
      account.markKeysAsPublished();
      await this.persistAccount();
    });
  }

  // ─── Peer identity (authenticated key distribution, spec §4) ────────────────

  /**
   * Verify a bundle's signature chain and reconcile with the pinned identity.
   * Throws E2EIdentityChangedError when the peer's keys changed — the UI must
   * surface this and the user re-accepts before any new session is built.
   */
  private async verifyAndPinIdentity(peerUserId: string, bundle: {
    curve25519Key: string;
    ed25519Key: string;
    deviceSignature: string;
  }): Promise<PinnedIdentity> {
    // 1. device binding: Ed25519 signature over (userId | curve | ed)
    verify_ed25519(
      bundle.ed25519Key,
      e2eDeviceCanonical(peerUserId, bundle.curve25519Key, bundle.ed25519Key),
      bundle.deviceSignature
    );

    // 2. pin-or-compare (TOFU; safety numbers upgrade trust to verified)
    const pinned = await this.vault.getIdentity(peerUserId);
    if (!pinned) {
      const fresh: PinnedIdentity = {
        curve25519Key: bundle.curve25519Key,
        ed25519Key: bundle.ed25519Key,
        verified: false,
      };
      await this.vault.putIdentity(peerUserId, fresh);
      return fresh;
    }
    if (pinned.curve25519Key !== bundle.curve25519Key || pinned.ed25519Key !== bundle.ed25519Key) {
      throw new E2EIdentityChangedError(peerUserId);
    }
    return pinned;
  }

  /** Fetch (and pin) a peer's published identity. Null when they have no device. */
  async fetchPeerIdentity(peerUserId: string): Promise<PinnedIdentity | null> {
    const res = await this.api.get(`/e2e/devices/${peerUserId}`);
    const data = res.data.data as {
      hasDevice: boolean;
      curve25519Key?: string;
      ed25519Key?: string;
      deviceSignature?: string;
    };
    if (!data.hasDevice) return null;
    return this.verifyAndPinIdentity(peerUserId, {
      curve25519Key: data.curve25519Key!,
      ed25519Key: data.ed25519Key!,
      deviceSignature: data.deviceSignature!,
    });
  }

  /** Accept a changed peer identity: re-pin and drop the dead session. */
  async acceptNewIdentity(peerUserId: string): Promise<void> {
    return this.enqueue(async () => {
      const res = await this.api.get(`/e2e/devices/${peerUserId}`);
      const data = res.data.data as {
        hasDevice: boolean;
        curve25519Key?: string;
        ed25519Key?: string;
        deviceSignature?: string;
      };
      if (!data.hasDevice) throw new Error('peer has no E2E device');
      verify_ed25519(
        data.ed25519Key!,
        e2eDeviceCanonical(peerUserId, data.curve25519Key!, data.ed25519Key!),
        data.deviceSignature!
      );
      await this.vault.putIdentity(peerUserId, {
        curve25519Key: data.curve25519Key!,
        ed25519Key: data.ed25519Key!,
        verified: false,
      });
      this.sessions.get(peerUserId)?.free();
      this.sessions.delete(peerUserId);
      await this.vault.deleteSession(peerUserId);
    });
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  private async loadSession(peerUserId: string): Promise<EngineSession | null> {
    const cached = this.sessions.get(peerUserId);
    if (cached) return cached;
    const pickle = await this.vault.getSessionPickle(peerUserId);
    if (!pickle) return null;
    let session: EngineSession;
    try {
      session = EngineSession.fromPickle(pickle, this.vault.pickleKey());
    } catch (err) {
      // Unreadable pickle (rotated/lost pickle key) — drop it; the next send
      // establishes a fresh session from a new bundle.
      console.warn(`e2e: session pickle for ${peerUserId} unreadable — discarding:`, err instanceof Error ? err.message : err);
      await this.vault.deleteSession(peerUserId);
      return null;
    }
    this.sessions.set(peerUserId, session);
    return session;
  }

  private async createOutboundSession(peerUserId: string): Promise<EngineSession> {
    const account = this.requireAccount();
    const res = await this.api.post(`/e2e/bundles/${peerUserId}`);
    const bundle = res.data.data as E2EKeyBundle;

    const identity = await this.verifyAndPinIdentity(peerUserId, bundle);
    // 3. pre-key binding: signed by the same device identity
    verify_ed25519(
      bundle.ed25519Key,
      e2eKeyCanonical(peerUserId, bundle.curve25519Key, bundle.preKey.keyId, bundle.preKey.key),
      bundle.preKey.signature
    );

    const session = account.createOutboundSession(identity.curve25519Key, bundle.preKey.key);
    this.sessions.set(peerUserId, session);
    await this.persistSession(peerUserId, session);
    return session;
  }

  /** Drop the session so the next send re-establishes from a fresh bundle. */
  async resetSession(peerUserId: string): Promise<void> {
    return this.enqueue(async () => {
      this.sessions.get(peerUserId)?.free();
      this.sessions.delete(peerUserId);
      await this.vault.deleteSession(peerUserId);
    });
  }

  // ─── Encrypt / decrypt ──────────────────────────────────────────────────────

  async encryptMessage(peerUserId: string, plaintext: string): Promise<string> {
    return this.enqueue(async () => {
      const session = (await this.loadSession(peerUserId)) ?? (await this.createOutboundSession(peerUserId));
      const { messageType, body } = session.encrypt(plaintext) as { messageType: 0 | 1; body: string };
      await this.persistSession(peerUserId, session);
      return buildE2EEnvelope(messageType, body);
    });
  }

  /** Cache plaintext under the server-assigned message id (spec §7.2). */
  async cachePlaintext(
    messageId: string,
    conversationId: string,
    text: string,
    editedAt?: string | null,
    meta?: { authorId?: string; createdAt?: string }
  ): Promise<void> {
    await this.vault.putPlaintext(messageId, {
      conversationId,
      text,
      editedAt: editedAt ?? null,
      ...(meta?.authorId && { authorId: meta.authorId }),
      ...(meta?.createdAt && { createdAt: meta.createdAt }),
    });
  }

  /**
   * Read cached plaintext. Pass `editedAt` to require that exact version
   * (edits produce new ciphertext under the same id); omit it to accept
   * whichever version is cached (e.g. reply previews).
   */
  async getCachedPlaintext(messageId: string, editedAt?: string | null): Promise<string | null> {
    const cached = await this.vault.getPlaintext(messageId);
    if (!cached || cached.failed) return null;
    if (editedAt !== undefined && (cached.editedAt ?? null) !== (editedAt ?? null)) return null;
    return cached.text;
  }

  /**
   * Decrypt an incoming encrypted DM. Idempotent: the plaintext cache is
   * consulted first, so socket echoes and history refetches never re-run the
   * (one-shot) ratchet. Failures return a marker instead of throwing so one
   * bad message can't break timeline rendering.
   */
  async decryptMessage(message: {
    id: string;
    conversationId: string;
    authorId: string;
    content: string;
    editedAt?: string | null;
    createdAt?: string;
  }): Promise<DecryptResult> {
    const version = message.editedAt ?? null;
    const cached = await this.vault.getPlaintext(message.id);
    if (cached && (cached.editedAt ?? null) === version) {
      return { text: cached.text, failed: cached.failed };
    }
    // cache miss OR a stale pre-edit entry: the edit is a fresh ratchet
    // ciphertext, so it decrypts like any new message and replaces the entry

    if (message.authorId === this.userId) {
      // Own message missing from the cache (cleared vault / other install):
      // Olm doesn't encrypt to self, so this history is unrecoverable here.
      return { text: '', failed: true };
    }

    return this.enqueue(async () => {
      try {
        const envelope = parseE2EEnvelope(message.content);
        if (!envelope) return { text: '', failed: true };

        const account = this.requireAccount();
        const identity =
          (await this.vault.getIdentity(message.authorId)) ?? (await this.fetchPeerIdentity(message.authorId));
        if (!identity) return { text: '', failed: true };

        let text: string;
        let session = await this.loadSession(message.authorId);

        if (envelope.t === 0) {
          // Pre-key message: either continues the session it announces, or
          // establishes a new inbound session (verified against the pinned
          // identity — vodozemac rejects mismatches).
          if (session && prekey_message_session_id(envelope.b) === session.sessionId()) {
            text = session.decrypt(envelope.t, envelope.b);
            await this.persistSession(message.authorId, session);
          } else {
            const inbound = account.createInboundSession(identity.curve25519Key, envelope.b);
            text = inbound.plaintext;
            session?.free();
            session = inbound.takeSession();
            this.sessions.set(message.authorId, session);
            await this.persistSession(message.authorId, session);
            await this.persistAccount(); // the used one-time key was consumed
          }
        } else {
          if (!session) return { text: '', failed: true };
          text = session.decrypt(envelope.t, envelope.b);
          await this.persistSession(message.authorId, session);
        }

        await this.vault.putPlaintext(message.id, {
          conversationId: message.conversationId,
          text,
          editedAt: version,
          authorId: message.authorId,
          ...(message.createdAt && { createdAt: message.createdAt }),
        });
        return { text };
      } catch (err) {
        console.warn(`e2e: failed to decrypt message ${message.id}:`, err instanceof Error ? err.message : err);
        return { text: '', failed: true };
      }
    });
  }

  /**
   * Client-side search over locally decrypted E2E history (spec §9 — server
   * search is structurally blind to ciphertext). Case-insensitive substring
   * match, newest first; entries cached before Phase C sort last (no
   * createdAt). Results are only as complete as this device's cache.
   */
  async searchDecrypted(
    conversationId: string,
    query: string,
    limit = 50
  ): Promise<Array<{ messageId: string; text: string; authorId?: string; createdAt?: string; editedAt?: string | null }>> {
    const needle = query.toLowerCase();
    const all = await this.vault.listPlaintexts(conversationId);
    return all
      .map(({ messageId, entry }) => {
        // entries hold raw plaintext — structured payloads carry text + metas
        const { text, attachments } = parseE2EPlaintext(entry.text);
        return { messageId, entry, text, attachments };
      })
      .filter(({ text, attachments }) =>
        text.toLowerCase().includes(needle) ||
        attachments.some((a) => a.fileName.toLowerCase().includes(needle))
      )
      .sort((a, b) => {
        if (!a.entry.createdAt) return 1;
        if (!b.entry.createdAt) return -1;
        return b.entry.createdAt.localeCompare(a.entry.createdAt);
      })
      .slice(0, limit)
      .map(({ messageId, entry, text }) => ({
        messageId,
        text,
        authorId: entry.authorId,
        createdAt: entry.createdAt,
        editedAt: entry.editedAt,
      }));
  }

  // ─── Safety numbers (spec §8) ───────────────────────────────────────────────

  async safetyNumber(peerUserId: string): Promise<{ digits: string; verified: boolean } | null> {
    const account = this.requireAccount();
    const identity = (await this.vault.getIdentity(peerUserId)) ?? (await this.fetchPeerIdentity(peerUserId));
    if (!identity) return null;
    const digits = safety_number(
      this.userId,
      account.ed25519Key(),
      account.curve25519Key(),
      peerUserId,
      identity.ed25519Key,
      identity.curve25519Key
    );
    return { digits, verified: identity.verified };
  }

  async markIdentityVerified(peerUserId: string): Promise<void> {
    const identity = await this.vault.getIdentity(peerUserId);
    if (identity) await this.vault.putIdentity(peerUserId, { ...identity, verified: true });
  }
}

// ─── App-level singleton (one service per logged-in account) ─────────────────

let activeService: E2EService | null = null;
let activeUserId: string | null = null;

export function getE2EService(userId: string): E2EService {
  if (!activeService || activeUserId !== userId) {
    activeService?.dispose();
    activeService = new E2EService(userId);
    activeUserId = userId;
  }
  return activeService;
}

export function disposeE2EService(): void {
  activeService?.dispose();
  activeService = null;
  activeUserId = null;
}
