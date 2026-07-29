// E2E DM service (docs/e2e-dm-spec.md, multi-device in §12). Orchestrates the
// WASM engine, the local vault, and the server's key-distribution API.
//
// Message crypto is Megolm ("megolm1"): one outbound group session per
// conversation, whose session key is fanned out to EVERY device of both
// participants over pairwise Olm ("olm1") key shares. Olm therefore survives
// only as (a) the key-share transport and (b) the decoder for pre-multi-device
// history. A sender imports its own session key as an inbound session, so its
// own messages stay readable without a self-share (D7).
//
// All engine-state mutations run through a serial queue: account / session /
// group-session pickles must be persisted in the same order the ratchets
// advance, or a crash could roll state back.
import {
  E2E_LIMITS,
  E2E_ENGINE_OLM1,
  E2E_ENGINE_MEGOLM1,
  E2E_DEVICE_ID_RE,
  e2eDeviceCanonical,
  e2eKeyCanonical,
  parseE2EEnvelope,
  buildE2EEnvelope,
  buildMegolmEnvelope,
  parseE2EPlaintext,
} from '@voxium/shared';
import type {
  E2EDeviceEntry,
  E2EKeyBundle,
  E2EKeySharePayload,
  E2EOlmEnvelope,
  E2EPreKey,
} from '@voxium/shared';
import { api as defaultApi } from '../api';
import {
  initEngine,
  EngineAccount,
  EngineSession,
  EngineGroupSession,
  EngineInboundGroupSession,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
} from './engine';
import {
  E2EVault,
  type InboundGroupSessionRecord,
  type OutboundGroupSessionRecord,
  type PickleKeyProvider,
  type PinnedIdentity,
} from './vault';

interface OneTimeKeyPair {
  keyId: string;
  key: string;
}

export interface DecryptResult {
  text: string;
  failed?: boolean;
}

/** One published device of a user, after signature verification + TOFU pinning. */
export interface E2EDeviceIdentity {
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  verified: boolean;
}

export interface E2EPinnedDeviceList {
  devices: E2EDeviceIdentity[];
  listVersion: number;
}

/** UI signal: this peer's device list changed since the user acknowledged it. */
export interface E2EDeviceListStatus {
  version: number;
  deviceIds: string[];
  /** devices present now that were not there at the last acknowledgement */
  newDeviceIds: string[];
  changed: boolean;
}

export interface E2EDeviceSafetyNumber {
  deviceId: string;
  digits: string;
  verified: boolean;
}

/** A device of ours as the server knows it (device management UI). */
export interface E2EOwnDevices {
  currentDeviceId: string;
  devices: E2EDeviceEntry[];
  listVersion: number;
}

/** The peer registered a new identity for a known device — trust must be re-confirmed. */
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
  /** Test hook / multi-instance isolation: suffix for the IndexedDB name. */
  vaultNamespace?: string;
  /** How long a fetched device list may be reused before re-checking (ms). */
  deviceListCacheMs?: number;
}

/** Re-poll the key-share inbox for a still-unknown session at most this often. */
const SHARE_CLAIM_RETRY_MS = 15_000;
/** Default freshness window for device lists (rotation-trigger input). */
const DEVICE_LIST_CACHE_MS = 10_000;
/** Undelivered key shares are retried on the SAME session at most this often. */
const SHARE_RETRY_BACKOFF_MS = 30_000;

/** Client-generated, stable per install (D2): 22 chars of base64url randomness. */
function generateDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function shareKey(userId: string, deviceId: string): string {
  return `${userId}|${deviceId}`;
}

/** Order-independent device-set comparison (server list order is not trusted). */
function sameDeviceSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/** Canonical fingerprint of a device list — the rotation trigger (see D9). */
function deviceSetFingerprint(deviceIds: string[]): string {
  return [...deviceIds].sort().join(',');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class E2EService {
  private readonly api: typeof defaultApi;
  private readonly vault: E2EVault;
  private readonly wasmInput?: BufferSource;
  private readonly deviceListCacheMs: number;

  private account: EngineAccount | null = null;
  private myDeviceId: string | null = null;
  /** pairwise Olm sessions, keyed `${userId}|${deviceId}` */
  private olmSessions = new Map<string, EngineSession>();
  /** outbound group sessions, keyed by conversationId */
  private outbound = new Map<string, { session: EngineGroupSession; record: OutboundGroupSessionRecord }>();
  /** inbound group sessions, keyed by megolm session id */
  private inbound = new Map<string, { session: EngineInboundGroupSession; record: InboundGroupSessionRecord }>();
  private deviceListCache = new Map<string, { at: number; list: E2EPinnedDeviceList }>();

  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private claimInFlight: Promise<number> | null = null;
  /** session id → last time we drained the inbox looking for it */
  private missingSessions = new Map<string, number>();
  private deviceListListeners = new Set<(userId: string) => void>();

  constructor(
    private readonly userId: string,
    opts: E2EServiceOptions = {}
  ) {
    this.api = opts.api ?? defaultApi;
    this.vault = new E2EVault(userId, opts.keyProvider, opts.vaultNamespace);
    this.wasmInput = opts.wasmInput;
    this.deviceListCacheMs = opts.deviceListCacheMs ?? DEVICE_LIST_CACHE_MS;
  }

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

    let deviceId = await this.vault.getDeviceId();
    if (!deviceId || !E2E_DEVICE_ID_RE.test(deviceId)) {
      deviceId = generateDeviceId();
      await this.vault.putDeviceId(deviceId);
    }
    this.myDeviceId = deviceId;

    const pickle = await this.vault.getAccountPickle();
    if (pickle) {
      try {
        this.account = EngineAccount.fromPickle(pickle, this.vault.pickleKey());
      } catch (err) {
        // Pickle key lost (e.g. localStorage cleared) — the old account is
        // unrecoverable. Start a fresh identity; peers will see a safety
        // number change, which is the honest signal for exactly this event.
        console.warn('e2e: account pickle unreadable — generating a new identity:', errText(err));
        this.account = new EngineAccount();
        await this.persistAccount();
      }
    } else {
      this.account = new EngineAccount();
      await this.persistAccount();
    }

    await this.ensureRegistered();
    this.initialized = true;

    // Neither of these may block the UI: key shares are re-claimed lazily on a
    // decrypt miss, and replenishment only matters for future peers.
    this.enqueue(() => this.claimKeyShares()).catch((err) => {
      console.warn('e2e: initial key-share claim failed:', errText(err));
    });
    this.replenishOneTimeKeys().catch((err) => {
      console.warn('e2e: one-time key replenishment failed:', errText(err));
    });
  }

  dispose(): void {
    this.account?.free();
    this.account = null;
    for (const session of this.olmSessions.values()) session.free();
    this.olmSessions.clear();
    for (const { session } of this.outbound.values()) session.free();
    this.outbound.clear();
    for (const { session } of this.inbound.values()) session.free();
    this.inbound.clear();
    this.deviceListCache.clear();
    this.vault.close();
    this.initialized = false;
  }

  /** This install's device id (spec §12, D2). */
  get deviceId(): string {
    if (!this.myDeviceId) throw new Error('e2e service not initialized');
    return this.myDeviceId;
  }

  private requireAccount(): EngineAccount {
    if (!this.account) throw new Error('e2e service not initialized');
    return this.account;
  }

  private async persistAccount(): Promise<void> {
    if (!this.account) throw new Error('e2e account not initialized');
    await this.vault.putAccountPickle(this.account.pickle(this.vault.pickleKey()));
  }

  private async persistOlmSession(userId: string, deviceId: string, session: EngineSession): Promise<void> {
    await this.vault.putSessionPickle(userId, deviceId, session.pickle(this.vault.pickleKey()));
  }

  // ─── Device registration & key upkeep ───────────────────────────────────────

  private signedPreKey(account: EngineAccount, k: OneTimeKeyPair): E2EPreKey {
    return {
      keyId: k.keyId,
      key: k.key,
      signature: account.sign(
        e2eKeyCanonical(this.userId, this.deviceId, account.curve25519Key(), k.keyId, k.key)
      ),
    };
  }

  /**
   * Publish THIS device if the server doesn't have it (or has different keys
   * for it). Other devices of the account are untouched — the server keys the
   * slot on (userId, deviceId).
   */
  private async ensureRegistered(): Promise<void> {
    const account = this.requireAccount();
    const res = await this.api.get(`/e2e/devices/me?deviceId=${encodeURIComponent(this.deviceId)}`);
    const status = res.data.data as { registered: boolean; deviceId?: string; curve25519Key?: string };

    if (status.registered && status.deviceId === this.deviceId && status.curve25519Key === account.curve25519Key()) {
      return;
    }

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
      deviceId: this.deviceId,
      curve25519Key: account.curve25519Key(),
      ed25519Key: account.ed25519Key(),
      deviceSignature: account.sign(
        e2eDeviceCanonical(this.userId, this.deviceId, account.curve25519Key(), account.ed25519Key())
      ),
      oneTimeKeys: otks.map((k) => this.signedPreKey(account, k)),
      fallbackKey: this.signedPreKey(account, fallback),
    });

    account.markKeysAsPublished();
    await this.persistAccount();
    // our own list version just changed — force a refetch on the next send
    this.deviceListCache.delete(this.userId);
  }

  async replenishOneTimeKeys(): Promise<void> {
    return this.enqueue(async () => {
      const account = this.requireAccount();
      const res = await this.api.get(`/e2e/devices/me?deviceId=${encodeURIComponent(this.deviceId)}`);
      const status = res.data.data as { registered: boolean; oneTimeKeyCount?: number };
      if (!status.registered) return;
      const count = status.oneTimeKeyCount ?? 0;
      if (count >= E2E_LIMITS.OTK_LOW_WATER) return;

      account.generateOneTimeKeys(Math.min(E2E_LIMITS.OTK_TARGET - count, E2E_LIMITS.OTK_UPLOAD_MAX));
      const fresh = account.oneTimeKeys() as OneTimeKeyPair[];
      if (fresh.length === 0) return;
      await this.persistAccount();
      await this.api.post('/e2e/devices/me/keys', {
        deviceId: this.deviceId,
        oneTimeKeys: fresh.map((k) => this.signedPreKey(account, k)),
      });
      account.markKeysAsPublished();
      await this.persistAccount();
    });
  }

  // ─── Device lists & identity pinning (spec §4, §12) ─────────────────────────

  /**
   * Pin-or-compare one device identity (TOFU per device, D10). Throws
   * E2EIdentityChangedError when a device we already trust published different
   * keys — the user must re-accept before any session is built with it.
   */
  private async pinDevice(
    userId: string,
    entry: { deviceId: string; curve25519Key: string; ed25519Key: string }
  ): Promise<PinnedIdentity> {
    const pinned = await this.vault.getIdentity(userId, entry.deviceId);
    if (pinned) {
      if (pinned.curve25519Key !== entry.curve25519Key || pinned.ed25519Key !== entry.ed25519Key) {
        throw new E2EIdentityChangedError(userId);
      }
      return pinned;
    }
    // Carry the verified flag over from the pre-multi-device pin when the keys
    // are literally the same account (the device just gained an id).
    const legacy = await this.vault.getLegacyIdentity(userId);
    const verified =
      !!legacy &&
      legacy.verified &&
      legacy.curve25519Key === entry.curve25519Key &&
      legacy.ed25519Key === entry.ed25519Key;
    const fresh: PinnedIdentity = {
      curve25519Key: entry.curve25519Key,
      ed25519Key: entry.ed25519Key,
      verified,
    };
    await this.vault.putIdentity(userId, entry.deviceId, fresh);
    return fresh;
  }

  /**
   * Fetch a user's published device list, verifying EVERY device's binding
   * signature (v2 canonical, D4) before it can be used. Devices with a broken
   * signature are dropped, never trusted — the server is untrusted storage.
   */
  async fetchDeviceList(userId: string, force = false): Promise<E2EPinnedDeviceList> {
    const cached = this.deviceListCache.get(userId);
    if (!force && cached && Date.now() - cached.at < this.deviceListCacheMs) return cached.list;

    const res = await this.api.get(`/e2e/devices/${userId}`);
    const data = res.data.data as { devices?: E2EDeviceEntry[]; listVersion?: number };
    const devices: E2EDeviceIdentity[] = [];

    for (const entry of data.devices ?? []) {
      if (
        typeof entry?.deviceId !== 'string' ||
        !E2E_DEVICE_ID_RE.test(entry.deviceId) ||
        typeof entry.curve25519Key !== 'string' ||
        typeof entry.ed25519Key !== 'string' ||
        typeof entry.deviceSignature !== 'string'
      ) {
        console.warn(`e2e: dropping malformed device entry for ${userId}`);
        continue;
      }
      try {
        verify_ed25519(
          entry.ed25519Key,
          e2eDeviceCanonical(userId, entry.deviceId, entry.curve25519Key, entry.ed25519Key),
          entry.deviceSignature
        );
      } catch (err) {
        console.warn(`e2e: device ${entry.deviceId} of ${userId} has an invalid signature — ignored:`, errText(err));
        continue;
      }
      // Our own current device needs no pin: we hold its private keys.
      if (userId === this.userId && entry.deviceId === this.myDeviceId) {
        devices.push({
          deviceId: entry.deviceId,
          curve25519Key: entry.curve25519Key,
          ed25519Key: entry.ed25519Key,
          verified: true,
        });
        continue;
      }
      const pinned = await this.pinDevice(userId, entry);
      devices.push({
        deviceId: entry.deviceId,
        curve25519Key: pinned.curve25519Key,
        ed25519Key: pinned.ed25519Key,
        verified: pinned.verified,
      });
    }

    const list: E2EPinnedDeviceList = { devices, listVersion: data.listVersion ?? 0 };
    await this.recordDeviceListState(userId, list);
    this.deviceListCache.set(userId, { at: Date.now(), list });
    return list;
  }

  private async recordDeviceListState(userId: string, list: E2EPinnedDeviceList): Promise<void> {
    const deviceIds = list.devices.map((d) => d.deviceId);
    const state = await this.vault.getDeviceListState(userId);
    if (!state) {
      // First sight of this user's devices: nothing to warn about yet (TOFU).
      await this.vault.putDeviceListState(userId, {
        version: list.listVersion,
        deviceIds,
        acknowledgedVersion: list.listVersion,
        acknowledgedDeviceIds: deviceIds,
      });
      return;
    }
    if (state.version === list.listVersion && sameDeviceSet(state.deviceIds, deviceIds)) return;
    await this.vault.putDeviceListState(userId, { ...state, version: list.listVersion, deviceIds });
    this.emitDeviceListChanged(userId);
  }

  /**
   * UI: did this user add/remove devices since the local user acknowledged?
   *
   * The device SET — not the server-supplied version — is authoritative. A
   * malicious server can inject a device while replaying the old listVersion
   * (or roll the version back); either way the set differs from what the user
   * acknowledged, so the warning still fires.
   */
  async deviceListStatus(userId: string): Promise<E2EDeviceListStatus> {
    const state = await this.vault.getDeviceListState(userId);
    if (!state) return { version: 0, deviceIds: [], newDeviceIds: [], changed: false };
    const newDeviceIds = state.deviceIds.filter((id) => !state.acknowledgedDeviceIds.includes(id));
    const setChanged = !sameDeviceSet(state.deviceIds, state.acknowledgedDeviceIds);
    return {
      version: state.version,
      deviceIds: state.deviceIds,
      newDeviceIds,
      changed: setChanged || state.acknowledgedVersion !== state.version,
    };
  }

  // ── Device-list change notifications (so the UI warns without polling) ──

  /** Subscribe to "this peer's device list changed" events. Returns an unsubscribe. */
  onDeviceListChanged(listener: (userId: string) => void): () => void {
    this.deviceListListeners.add(listener);
    return () => this.deviceListListeners.delete(listener);
  }

  private emitDeviceListChanged(userId: string): void {
    for (const listener of this.deviceListListeners) {
      try {
        listener(userId);
      } catch (err) {
        console.warn('e2e: device-list listener threw:', errText(err));
      }
    }
  }

  /** UI: the user has seen the current device list — stop warning about it. */
  async acknowledgeDeviceList(userId: string): Promise<void> {
    const state = await this.vault.getDeviceListState(userId);
    if (!state) return;
    await this.vault.putDeviceListState(userId, {
      ...state,
      acknowledgedVersion: state.version,
      acknowledgedDeviceIds: [...state.deviceIds],
    });
  }

  /**
   * Accept a peer's changed device identity: re-pin every device, drop the dead
   * pairwise sessions and force a group-session re-key (their old session key
   * may have gone to a device we no longer trust).
   */
  async acceptNewIdentity(peerUserId: string): Promise<void> {
    return this.enqueue(async () => {
      const res = await this.api.get(`/e2e/devices/${peerUserId}`);
      const data = res.data.data as { devices?: E2EDeviceEntry[]; listVersion?: number };
      const entries = data.devices ?? [];
      if (entries.length === 0) throw new Error('peer has no E2E device');

      for (const [key, session] of this.olmSessions) {
        if (key.startsWith(`${peerUserId}|`)) {
          session.free();
          this.olmSessions.delete(key);
        }
      }
      await this.vault.deleteSessionsForUser(peerUserId);

      for (const entry of entries) {
        if (typeof entry?.deviceId !== 'string' || !E2E_DEVICE_ID_RE.test(entry.deviceId)) continue;
        try {
          verify_ed25519(
            entry.ed25519Key,
            e2eDeviceCanonical(peerUserId, entry.deviceId, entry.curve25519Key, entry.ed25519Key),
            entry.deviceSignature
          );
        } catch (err) {
          console.warn(`e2e: refusing to pin device ${entry.deviceId} with an invalid signature:`, errText(err));
          continue;
        }
        // re-pinned as UNVERIFIED: the safety number changed, so any earlier
        // out-of-band verification is void
        await this.vault.putIdentity(peerUserId, entry.deviceId, {
          curve25519Key: entry.curve25519Key,
          ed25519Key: entry.ed25519Key,
          verified: false,
        });
      }

      // Inbound sessions imported from the OLD identity must go too: whoever
      // holds those keys could keep publishing into them and it would render
      // as an authentic peer message.
      const droppedSessions = await this.vault.deleteInboundGroupSessionsFrom(peerUserId);
      for (const sessionId of droppedSessions) {
        this.inbound.get(sessionId)?.session.free();
        this.inbound.delete(sessionId);
      }

      this.deviceListCache.delete(peerUserId);
      await this.acknowledgeDeviceList(peerUserId);
      await this.clearOutboundGroupSessions();
    });
  }

  /** Drop every pairwise session with a user so the next share re-establishes. */
  async resetSession(peerUserId: string): Promise<void> {
    return this.enqueue(async () => {
      for (const [key, session] of this.olmSessions) {
        if (key.startsWith(`${peerUserId}|`)) {
          session.free();
          this.olmSessions.delete(key);
        }
      }
      await this.vault.deleteSessionsForUser(peerUserId);
    });
  }

  // ─── Pairwise Olm sessions (key-share transport) ────────────────────────────

  private async loadOlmSession(userId: string, deviceId: string): Promise<EngineSession | null> {
    const key = shareKey(userId, deviceId);
    const cached = this.olmSessions.get(key);
    if (cached) return cached;
    const pickle = await this.vault.getSessionPickle(userId, deviceId);
    if (!pickle) return null;
    let session: EngineSession;
    try {
      session = EngineSession.fromPickle(pickle, this.vault.pickleKey());
    } catch (err) {
      // Unreadable pickle (rotated/lost pickle key) — drop it; the next share
      // establishes a fresh session from a new bundle.
      console.warn(`e2e: session pickle for ${key} unreadable — discarding:`, errText(err));
      await this.vault.deleteSession(userId, deviceId);
      return null;
    }
    this.olmSessions.set(key, session);
    return session;
  }

  /** Reuse or establish the pairwise session used to ship group-session keys. */
  private async ensureOlmSession(userId: string, deviceId: string): Promise<EngineSession> {
    const existing = await this.loadOlmSession(userId, deviceId);
    if (existing) return existing;

    const account = this.requireAccount();
    const path = `/e2e/bundles/${userId}/${deviceId}`;
    const url =
      userId === this.userId ? `${path}?fromDeviceId=${encodeURIComponent(this.deviceId)}` : path;
    const res = await this.api.post(url);
    const bundle = res.data.data as E2EKeyBundle;
    if (bundle.deviceId !== deviceId) throw new Error('bundle is for a different device');

    // 1. device binding: Ed25519 signature over (userId | deviceId | curve | ed)
    verify_ed25519(
      bundle.ed25519Key,
      e2eDeviceCanonical(userId, deviceId, bundle.curve25519Key, bundle.ed25519Key),
      bundle.deviceSignature
    );
    // 2. pin-or-compare against the trusted identity
    const identity = await this.pinDevice(userId, {
      deviceId,
      curve25519Key: bundle.curve25519Key,
      ed25519Key: bundle.ed25519Key,
    });
    // 3. pre-key binding: signed by that same device identity
    verify_ed25519(
      bundle.ed25519Key,
      e2eKeyCanonical(userId, deviceId, bundle.curve25519Key, bundle.preKey.keyId, bundle.preKey.key),
      bundle.preKey.signature
    );

    const session = account.createOutboundSession(identity.curve25519Key, bundle.preKey.key);
    this.olmSessions.set(shareKey(userId, deviceId), session);
    await this.persistOlmSession(userId, deviceId, session);
    return session;
  }

  /** Decrypt an olm1 body known to come from one specific device. */
  private async olmDecryptFromDevice(
    userId: string,
    deviceId: string,
    envelope: E2EOlmEnvelope
  ): Promise<string | null> {
    const identity = await this.vault.getIdentity(userId, deviceId);
    if (!identity) return null;
    const account = this.requireAccount();
    const session = await this.loadOlmSession(userId, deviceId);

    if (envelope.t === 0) {
      // Pre-key message: either continues the session it announces, or
      // establishes a new inbound session (bound to the pinned identity —
      // vodozemac rejects a mismatch).
      if (session && prekey_message_session_id(envelope.b) === session.sessionId()) {
        const text = session.decrypt(envelope.t, envelope.b);
        await this.persistOlmSession(userId, deviceId, session);
        return text;
      }
      const inbound = account.createInboundSession(identity.curve25519Key, envelope.b);
      const text = inbound.plaintext;
      const fresh = inbound.takeSession();
      session?.free();
      this.olmSessions.set(shareKey(userId, deviceId), fresh);
      await this.persistOlmSession(userId, deviceId, fresh);
      await this.persistAccount(); // the used one-time key was consumed
      return text;
    }

    if (!session) return null;
    const text = session.decrypt(envelope.t, envelope.b);
    await this.persistOlmSession(userId, deviceId, session);
    return text;
  }

  /**
   * Decrypt an olm1 message when the sending device isn't identified (legacy
   * history): try every pinned device of the author, then the pre-multi-device
   * session slot.
   */
  private async olmDecryptFromUser(userId: string, envelope: E2EOlmEnvelope): Promise<string | null> {
    let pinned = await this.vault.listIdentities(userId);
    if (pinned.length === 0) {
      try {
        await this.fetchDeviceList(userId);
        pinned = await this.vault.listIdentities(userId);
      } catch (err) {
        console.warn(`e2e: could not fetch devices of ${userId}:`, errText(err));
      }
    }
    for (const { deviceId } of pinned) {
      try {
        const text = await this.olmDecryptFromDevice(userId, deviceId, envelope);
        if (text !== null) return text;
      } catch {
        // wrong device for this ciphertext — try the next one
      }
    }
    return this.olmDecryptLegacy(userId, envelope);
  }

  /** Pre-multi-device slot (`session:{userId}` / `identity:{userId}`). */
  private async olmDecryptLegacy(userId: string, envelope: E2EOlmEnvelope): Promise<string | null> {
    const identity = await this.vault.getLegacyIdentity(userId);
    const pickle = await this.vault.getLegacySessionPickle(userId);
    if (!identity && !pickle) return null;
    const account = this.requireAccount();
    let session: EngineSession | null = null;
    if (pickle) {
      try {
        session = EngineSession.fromPickle(pickle, this.vault.pickleKey());
      } catch (err) {
        console.warn(`e2e: legacy session pickle for ${userId} unreadable:`, errText(err));
      }
    }
    try {
      if (envelope.t === 0) {
        if (session && prekey_message_session_id(envelope.b) === session.sessionId()) {
          const text = session.decrypt(envelope.t, envelope.b);
          await this.vault.putLegacySessionPickle(userId, session.pickle(this.vault.pickleKey()));
          return text;
        }
        if (!identity) return null;
        const inbound = account.createInboundSession(identity.curve25519Key, envelope.b);
        const text = inbound.plaintext;
        const fresh = inbound.takeSession();
        await this.vault.putLegacySessionPickle(userId, fresh.pickle(this.vault.pickleKey()));
        fresh.free();
        await this.persistAccount();
        return text;
      }
      if (!session) return null;
      const text = session.decrypt(envelope.t, envelope.b);
      await this.vault.putLegacySessionPickle(userId, session.pickle(this.vault.pickleKey()));
      return text;
    } finally {
      session?.free();
    }
  }

  // ─── Group sessions (Megolm, spec §12) ──────────────────────────────────────

  private async loadOutbound(
    conversationId: string
  ): Promise<{ session: EngineGroupSession; record: OutboundGroupSessionRecord } | null> {
    const cached = this.outbound.get(conversationId);
    if (cached) return cached;
    const record = await this.vault.getOutboundGroupSession(conversationId);
    if (!record) return null;
    try {
      const session = EngineGroupSession.fromPickle(record.pickle, this.vault.pickleKey());
      const entry = { session, record };
      this.outbound.set(conversationId, entry);
      return entry;
    } catch (err) {
      console.warn(`e2e: outbound group session for ${conversationId} unreadable — re-keying:`, errText(err));
      await this.vault.deleteOutboundGroupSession(conversationId);
      return null;
    }
  }

  private async loadInbound(
    sessionId: string
  ): Promise<{ session: EngineInboundGroupSession; record: InboundGroupSessionRecord } | null> {
    const cached = this.inbound.get(sessionId);
    if (cached) return cached;
    const record = await this.vault.getInboundGroupSession(sessionId);
    if (!record) return null;
    try {
      const session = EngineInboundGroupSession.fromPickle(record.pickle, this.vault.pickleKey());
      const entry = { session, record };
      this.inbound.set(sessionId, entry);
      return entry;
    } catch (err) {
      console.warn(`e2e: inbound group session ${sessionId} unreadable:`, errText(err));
      return null;
    }
  }

  private async importInboundGroupSession(
    sessionKey: string,
    meta: { sessionId: string; conversationId: string; senderUserId: string; senderDeviceId: string }
  ): Promise<boolean> {
    const existing = await this.loadInbound(meta.sessionId);
    if (existing) return false; // already imported (shares may be re-delivered)
    const session = EngineInboundGroupSession.fromSessionKey(sessionKey);
    if (session.sessionId() !== meta.sessionId) {
      session.free();
      throw new Error('session key does not match the announced session id');
    }
    const record: InboundGroupSessionRecord = {
      pickle: session.pickle(this.vault.pickleKey()),
      sessionId: meta.sessionId,
      conversationId: meta.conversationId,
      senderUserId: meta.senderUserId,
      senderDeviceId: meta.senderDeviceId,
    };
    this.inbound.set(meta.sessionId, { session, record });
    await this.vault.putInboundGroupSession(meta.sessionId, record);
    return true;
  }

  private needsRotation(
    record: OutboundGroupSessionRecord,
    peerUserId: string,
    peer: E2EPinnedDeviceList,
    own: E2EPinnedDeviceList
  ): boolean {
    // Device SET, not the server-supplied version: a server that adds a device
    // while replaying the old listVersion must still force a re-key. (Records
    // written before fingerprints existed have none → one extra rotation.)
    const fingerprints = record.deviceListFingerprints ?? {};
    if (fingerprints[peerUserId] !== deviceSetFingerprint(peer.devices.map((d) => d.deviceId))) return true;
    if (fingerprints[this.userId] !== deviceSetFingerprint(own.devices.map((d) => d.deviceId))) return true;
    if (record.messageCount >= E2E_LIMITS.GROUP_SESSION_MAX_MESSAGES) return true;
    if (Date.now() - record.createdAt >= E2E_LIMITS.GROUP_SESSION_MAX_AGE_MS) return true;
    // NOTE: pendingShareFailures deliberately does NOT rotate — a transient
    // upload failure would then re-key on every single message, burning peer
    // one-time keys and flooding their share inbox. Retries reuse this session
    // (retryPendingShares), which is also lossless for the recipient.
    return false;
  }

  /** Olm-encrypt one session key to each target device and upload the batch. */
  private async deliverShares(
    targets: Array<{ userId: string; deviceId: string }>,
    payload: E2EKeySharePayload
  ): Promise<string[]> {
    const body = JSON.stringify(payload);
    const pending: string[] = [];
    const shares: Array<{
      recipientUserId: string;
      recipientDeviceId: string;
      conversationId: string;
      sessionId: string;
      body: string;
    }> = [];

    for (const target of targets) {
      try {
        const olm = await this.ensureOlmSession(target.userId, target.deviceId);
        const { messageType, body: ciphertext } = olm.encrypt(body) as { messageType: 0 | 1; body: string };
        await this.persistOlmSession(target.userId, target.deviceId, olm);
        shares.push({
          recipientUserId: target.userId,
          recipientDeviceId: target.deviceId,
          conversationId: payload.conversationId,
          sessionId: payload.sessionId,
          body: buildE2EEnvelope(messageType, ciphertext),
        });
      } catch (err) {
        console.warn(`e2e: could not build a key share for ${target.userId}/${target.deviceId}:`, errText(err));
        pending.push(shareKey(target.userId, target.deviceId));
      }
    }

    for (let i = 0; i < shares.length; i += E2E_LIMITS.KEYSHARE_BATCH_MAX) {
      const chunk = shares.slice(i, i + E2E_LIMITS.KEYSHARE_BATCH_MAX);
      try {
        await this.api.post('/e2e/keyshares', { deviceId: this.deviceId, shares: chunk });
      } catch (err) {
        console.warn('e2e: key-share upload failed — will retry on the next send:', errText(err));
        for (const s of chunk) pending.push(shareKey(s.recipientUserId, s.recipientDeviceId));
      }
    }
    return pending;
  }

  /**
   * Re-attempt undelivered shares for the CURRENT session (rate-limited by
   * SHARE_RETRY_BACKOFF_MS). Uses the stored index-0 key, so a device that
   * recovers can still read the whole session — no rotation, no amplification.
   */
  private async retryPendingShares(
    conversationId: string,
    entry: { session: EngineGroupSession; record: OutboundGroupSessionRecord }
  ): Promise<void> {
    const { record } = entry;
    if (record.pendingShareFailures.length === 0 || !record.initialSessionKey) return;
    if (Date.now() - (record.lastShareAttemptAt ?? 0) < SHARE_RETRY_BACKOFF_MS) return;

    const targets = record.pendingShareFailures
      .map((key) => {
        const sep = key.lastIndexOf('|');
        return { userId: key.slice(0, sep), deviceId: key.slice(sep + 1) };
      })
      .filter((t) => t.userId && t.deviceId);

    const stillPending = await this.deliverShares(targets, {
      v: 2,
      conversationId,
      sessionId: record.sessionId,
      sessionKey: record.initialSessionKey,
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    record.pendingShareFailures = stillPending;
    record.lastShareAttemptAt = Date.now();
    await this.vault.putOutboundGroupSession(conversationId, record);
  }

  /**
   * Create a fresh outbound session and fan its key out to every device of both
   * participants (except this one, which imports the key directly — D7).
   * Undeliverable shares are remembered so the next send re-keys and retries.
   */
  private async rotateGroupSession(
    conversationId: string,
    peerUserId: string,
    peer: E2EPinnedDeviceList,
    own: E2EPinnedDeviceList,
    previous: { session: EngineGroupSession; record: OutboundGroupSessionRecord } | null
  ): Promise<{ session: EngineGroupSession; record: OutboundGroupSessionRecord }> {
    const session = new EngineGroupSession();
    const sessionId = session.sessionId();
    // MUST be exported before the first encrypt so importers start at index 0
    const sessionKey = session.sessionKey();

    // Decrypt-to-self: this device never receives its own share.
    await this.importInboundGroupSession(sessionKey, {
      sessionId,
      conversationId,
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    const targets = [
      ...peer.devices.map((d) => ({ userId: peerUserId, deviceId: d.deviceId })),
      ...own.devices.filter((d) => d.deviceId !== this.deviceId).map((d) => ({ userId: this.userId, deviceId: d.deviceId })),
    ];

    const pending = await this.deliverShares(targets, {
      v: 2,
      conversationId,
      sessionId,
      sessionKey,
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    const record: OutboundGroupSessionRecord = {
      pickle: session.pickle(this.vault.pickleKey()),
      sessionId,
      createdAt: Date.now(),
      messageCount: 0,
      deviceListVersions: { [peerUserId]: peer.listVersion, [this.userId]: own.listVersion },
      deviceListFingerprints: {
        [peerUserId]: deviceSetFingerprint(peer.devices.map((d) => d.deviceId)),
        [this.userId]: deviceSetFingerprint(own.devices.map((d) => d.deviceId)),
      },
      pendingShareFailures: pending,
      initialSessionKey: sessionKey,
      lastShareAttemptAt: Date.now(),
    };

    previous?.session.free();
    const entry = { session, record };
    this.outbound.set(conversationId, entry);
    await this.vault.putOutboundGroupSession(conversationId, record);
    return entry;
  }

  private async ensureGroupSession(
    conversationId: string,
    peerUserId: string
  ): Promise<{ session: EngineGroupSession; record: OutboundGroupSessionRecord }> {
    // force: the rotation decision must not run on a stale cached list —
    // a revoked device would keep receiving keys for the cache window.
    const [peer, own] = await Promise.all([
      this.fetchDeviceList(peerUserId, true),
      this.fetchDeviceList(this.userId, true),
    ]);
    const current = await this.loadOutbound(conversationId);
    if (current && !this.needsRotation(current.record, peerUserId, peer, own)) {
      await this.retryPendingShares(conversationId, current);
      return current;
    }
    return this.rotateGroupSession(conversationId, peerUserId, peer, own, current);
  }

  private async clearOutboundGroupSessions(): Promise<void> {
    for (const { session } of this.outbound.values()) session.free();
    this.outbound.clear();
    await this.vault.deleteAllOutboundGroupSessions();
  }

  // ─── Key-share inbox ────────────────────────────────────────────────────────

  /**
   * Claim (and thereby delete) this device's pending key shares and import the
   * group sessions they carry. Olm pre-key bodies are one-shot, so the server
   * hands each share out exactly once — everything that fails here is lost, and
   * the sender recovers by rotating.
   *
   * Callers must already hold the serial queue (this mutates Olm state).
   */
  private async claimKeyShares(): Promise<number> {
    if (this.claimInFlight) return this.claimInFlight;
    const run = (async () => {
      const res = await this.api.get(`/e2e/keyshares?deviceId=${encodeURIComponent(this.deviceId)}`);
      const shares = (res.data.data as { shares?: unknown[] }).shares;
      if (!Array.isArray(shares) || shares.length === 0) return 0;
      let imported = 0;
      for (const share of shares) {
        try {
          if (await this.importKeyShare(share as Record<string, unknown>)) imported++;
        } catch (err) {
          console.warn('e2e: discarding an unusable key share:', errText(err));
        }
      }
      return imported;
    })().finally(() => {
      this.claimInFlight = null;
    });
    this.claimInFlight = run;
    return run;
  }

  private async importKeyShare(share: Record<string, unknown>): Promise<boolean> {
    const senderUserId = share.senderUserId;
    const senderDeviceId = share.senderDeviceId;
    const conversationId = share.conversationId;
    const sessionId = share.sessionId;
    if (
      typeof senderUserId !== 'string' ||
      typeof senderDeviceId !== 'string' ||
      !E2E_DEVICE_ID_RE.test(senderDeviceId) ||
      typeof conversationId !== 'string' ||
      typeof sessionId !== 'string' ||
      typeof share.body !== 'string'
    ) {
      throw new Error('malformed key share');
    }
    const envelope = parseE2EEnvelope(share.body);
    if (!envelope || envelope.e !== E2E_ENGINE_OLM1) throw new Error('key share body is not an olm1 envelope');

    // The sender may be a device we have never seen — fetch and verify its
    // list before trusting anything it says.
    let identity = await this.vault.getIdentity(senderUserId, senderDeviceId);
    if (!identity) {
      await this.fetchDeviceList(senderUserId, true);
      identity = await this.vault.getIdentity(senderUserId, senderDeviceId);
    }
    if (!identity) throw new Error(`unknown sender device ${senderUserId}/${senderDeviceId}`);

    const plaintext = await this.olmDecryptFromDevice(senderUserId, senderDeviceId, envelope);
    if (plaintext === null) throw new Error('no Olm session for this key share');

    const payload = JSON.parse(plaintext) as E2EKeySharePayload;
    if (
      payload?.v !== 2 ||
      typeof payload.sessionKey !== 'string' ||
      payload.sessionId !== sessionId ||
      payload.conversationId !== conversationId ||
      // attribution is authenticated by the Olm session it arrived over
      payload.senderUserId !== senderUserId ||
      payload.senderDeviceId !== senderDeviceId
    ) {
      throw new Error('key share payload does not match its envelope');
    }

    return this.importInboundGroupSession(payload.sessionKey, {
      sessionId,
      conversationId,
      senderUserId,
      senderDeviceId,
    });
  }

  // ─── Encrypt / decrypt ──────────────────────────────────────────────────────

  /**
   * Encrypt one DM under the conversation's group session, re-keying (and
   * re-sharing) first whenever a rotation trigger fired (D9).
   */
  async encryptMessage(conversationId: string, peerUserId: string, plaintext: string): Promise<string> {
    return this.enqueue(async () => {
      const { session, record } = await this.ensureGroupSession(conversationId, peerUserId);
      const body = session.encrypt(plaintext);
      record.messageCount += 1;
      record.pickle = session.pickle(this.vault.pickleKey());
      await this.vault.putOutboundGroupSession(conversationId, record);
      return buildMegolmEnvelope(record.sessionId, body);
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
   * Decrypt an encrypted DM. The plaintext cache is consulted first: Megolm is
   * re-decryptable so this is only an optimization there, but it is the ONLY
   * way to read legacy olm1 history (one-shot ratchet keys). Failures return a
   * marker instead of throwing so one bad message can't break the timeline.
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
    // cache miss OR a stale pre-edit entry: the edit is a fresh ciphertext, so
    // it decrypts like any new message and replaces the entry

    const envelope = parseE2EEnvelope(message.content);
    if (!envelope) return { text: '', failed: true };
    if (envelope.e === E2E_ENGINE_OLM1 && message.authorId === this.userId) {
      // Own legacy message missing from the cache (cleared vault / other
      // install): Olm doesn't encrypt to self, so it is unrecoverable here.
      return { text: '', failed: true };
    }

    return this.enqueue(async () => {
      try {
        const text =
          envelope.e === E2E_ENGINE_MEGOLM1
            ? await this.decryptGroupMessage(message, envelope.sid, envelope.b)
            : await this.olmDecryptFromUser(message.authorId, envelope);
        if (text === null) return { text: '', failed: true };

        await this.vault.putPlaintext(message.id, {
          conversationId: message.conversationId,
          text,
          editedAt: version,
          authorId: message.authorId,
          ...(message.createdAt && { createdAt: message.createdAt }),
        });
        return { text };
      } catch (err) {
        console.warn(`e2e: failed to decrypt message ${message.id}:`, errText(err));
        return { text: '', failed: true };
      }
    });
  }

  private async decryptGroupMessage(
    message: { id: string; conversationId: string; authorId: string },
    sessionId: string,
    body: string
  ): Promise<string | null> {
    let entry = await this.loadInbound(sessionId);
    if (!entry) {
      // The key share may still be sitting in this device's inbox. One drain
      // per unknown session (retried after SHARE_CLAIM_RETRY_MS) — a backlog of
      // undecryptable messages must not turn into a request storm.
      const lastAttempt = this.missingSessions.get(sessionId);
      if (lastAttempt === undefined || Date.now() - lastAttempt >= SHARE_CLAIM_RETRY_MS) {
        this.missingSessions.set(sessionId, Date.now());
        await this.claimKeyShares();
        entry = await this.loadInbound(sessionId);
      }
    }
    if (!entry) return null;
    this.missingSessions.delete(sessionId);

    // A session speaks for exactly one sender in exactly one conversation:
    // without these checks a relayed session could forge another user's
    // messages, or be replayed into a different DM (D6).
    if (entry.record.senderUserId !== message.authorId) {
      console.warn(`e2e: message ${message.id} claims an author the group session does not belong to`);
      return null;
    }
    if (message.conversationId && entry.record.conversationId !== message.conversationId) {
      console.warn(`e2e: message ${message.id} uses a session from another conversation`);
      return null;
    }

    const result = entry.session.decrypt(body);
    const text = result.plaintext;
    result.free();
    entry.record.pickle = entry.session.pickle(this.vault.pickleKey());
    await this.vault.putInboundGroupSession(sessionId, entry.record);
    return text;
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

  // ─── Device management for the UI ───────────────────────────────────────────

  /** This account's registered devices, as the server sees them. */
  async listOwnDevices(): Promise<E2EOwnDevices> {
    const res = await this.api.get(`/e2e/devices/me?deviceId=${encodeURIComponent(this.deviceId)}`);
    const data = res.data.data as { devices?: E2EDeviceEntry[]; listVersion?: number };
    return {
      currentDeviceId: this.deviceId,
      devices: data.devices ?? [],
      listVersion: data.listVersion ?? 0,
    };
  }

  /**
   * Revoke one of our other devices. Every outbound group session is dropped
   * afterwards so the next send re-keys — the revoked device must not be able
   * to read anything sent from now on.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    if (deviceId === this.deviceId) throw new Error('Cannot revoke the device you are using');
    return this.enqueue(async () => {
      await this.api.delete(`/e2e/devices/me/${encodeURIComponent(deviceId)}`);
      const key = shareKey(this.userId, deviceId);
      this.olmSessions.get(key)?.free();
      this.olmSessions.delete(key);
      await this.vault.deleteSession(this.userId, deviceId);
      await this.vault.deleteIdentity(this.userId, deviceId);
      this.deviceListCache.delete(this.userId);
      await this.clearOutboundGroupSessions();
    });
  }

  // ─── Safety numbers (spec §8, per device in §12) ────────────────────────────

  /** One safety number per device of the peer (D10). */
  async perDeviceSafetyNumbers(peerUserId: string): Promise<E2EDeviceSafetyNumber[]> {
    const account = this.requireAccount();
    let devices: E2EDeviceIdentity[];
    try {
      devices = (await this.fetchDeviceList(peerUserId)).devices;
    } catch (err) {
      if (err instanceof E2EIdentityChangedError) throw err;
      console.warn(`e2e: falling back to pinned devices for ${peerUserId}:`, errText(err));
      devices = (await this.vault.listIdentities(peerUserId)).map(({ deviceId, identity }) => ({
        deviceId,
        ...identity,
      }));
    }
    return devices.map((device) => ({
      deviceId: device.deviceId,
      digits: safety_number(
        this.userId,
        account.ed25519Key(),
        account.curve25519Key(),
        peerUserId,
        device.ed25519Key,
        device.curve25519Key
      ),
      verified: device.verified,
    }));
  }

  /** Mark ONE device of a peer as verified out of band. */
  async markDeviceVerified(peerUserId: string, deviceId: string): Promise<void> {
    const identity = await this.vault.getIdentity(peerUserId, deviceId);
    if (!identity) return;
    await this.vault.putIdentity(peerUserId, deviceId, { ...identity, verified: true });
    this.deviceListCache.delete(peerUserId);
  }

  /**
   * Single-device view kept for the current UI: the peer's first device.
   * Returns null when they have no usable device.
   */
  async safetyNumber(peerUserId: string): Promise<{ digits: string; verified: boolean } | null> {
    const all = await this.perDeviceSafetyNumbers(peerUserId);
    if (all.length === 0) return null;
    return { digits: all[0].digits, verified: all.every((d) => d.verified) };
  }

  /** Mark every currently pinned device of a peer as verified. */
  async markIdentityVerified(peerUserId: string): Promise<void> {
    const pinned = await this.vault.listIdentities(peerUserId);
    for (const { deviceId, identity } of pinned) {
      if (identity.verified) continue;
      await this.vault.putIdentity(peerUserId, deviceId, { ...identity, verified: true });
    }
    this.deviceListCache.delete(peerUserId);
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
