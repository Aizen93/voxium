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
  E2E_KEY_B64_RE,
  E2E_SIGNATURE_B64_RE,
  e2eDeviceCanonical,
  e2eDeviceCrossCanonical,
  e2eKeyCanonical,
  e2eMasterCanonical,
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
  generateRecoveryKey,
  linkingCode,
  isRecoveryKeyWellFormed,
  openMasterKeyBackup,
  initEngine,
  EngineAccount,
  EngineMasterKey,
  EngineSession,
  EngineGroupSession,
  EngineInboundGroupSession,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
  master_safety_number,
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
  /**
   * Out-of-band verified. Cross-signed devices INHERIT the account-level
   * verification of the master key that signed them (spec §14, D9).
   */
  verified: boolean;
  /** Carries a valid signature from the account master key (§14, D2/D7). */
  crossSigned: boolean;
}

export interface E2EPinnedDeviceList {
  devices: E2EDeviceIdentity[];
  listVersion: number;
  /** The account master key this list was verified against (§14), if any. */
  masterKey: string | null;
  /**
   * How many device entries the server returned BEFORE signature verification.
   * The difference between this and `devices.length` is the difference between
   * "this person has never opened the app" and "every device they publish
   * failed verification" — the first is routine, the second means the
   * directory is serving something wrong and must not be described as the
   * person simply not being set up yet.
   */
  servedDeviceCount: number;
}

/** UI signal: this peer's device list changed since the user acknowledged it. */
export interface E2EDeviceListStatus {
  version: number;
  deviceIds: string[];
  /** devices present now that were not there at the last acknowledgement */
  newDeviceIds: string[];
  /**
   * Devices of an account that HAS a master key but which that key does not
   * vouch for (spec §14, D8). Rendered as "not signed by <name>'s account key";
   * acknowledgement cannot clear them — only cross-signing or revocation can.
   */
  unsignedDeviceIds: string[];
  changed: boolean;
}

export interface E2EDeviceSafetyNumber {
  deviceId: string;
  digits: string;
  verified: boolean;
  /** signed by the account master key (§14) — false when unknown offline */
  crossSigned: boolean;
}

/** One of our devices as the server knows it, plus its cross-signing state. */
export interface E2EOwnDeviceEntry extends E2EDeviceEntry {
  crossSigned: boolean;
}

/** A device of ours as the server knows it (device management UI). */
export interface E2EOwnDevices {
  currentDeviceId: string;
  devices: E2EOwnDeviceEntry[];
  listVersion: number;
  /** This account's published master key, or null before bootstrap (§14). */
  masterKey: string | null;
  /** True when THIS device holds the master secret and can approve others. */
  canApprove: boolean;
  /**
   * Did the node that answered actually understand cross-signing? A response
   * that did not cannot report signatures, so "every device is unsigned" is
   * absence of evidence — never grounds for a destructive recovery.
   */
  capabilityServed: boolean;
}

/** The account-level safety number of a peer (spec §14, D3). */
export interface E2EAccountSafetyNumber {
  digits: string;
  /** the master key was compared out of band (D9) */
  verified: boolean;
}

/** The peer registered a new identity for a known device — trust must be re-confirmed. */
export class E2EIdentityChangedError extends Error {
  constructor(public readonly peerUserId: string) {
    super('Peer identity key changed');
    this.name = 'E2EIdentityChangedError';
  }
}

/**
 * A master-secret transfer that can never succeed, however often it is retried
 * — malformed, or already spent on a ratchet that has moved on. Only these may
 * be dropped from the mailbox: anything else (a device we cannot look up yet, a
 * failed request) has to survive, because the device it was meant for is
 * already cross-signed and has no other way to ever receive the key (§14.4).
 */
class E2EUnusableTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2EUnusableTransferError';
  }
}

/**
 * The recipient has no device that can receive encrypted messages yet.
 *
 * Not an error in the usual sense — it is a normal state for an account that
 * exists but has never opened the app on a device. Under always-on encryption
 * (docs/e2e-always-on-plan.md) it is also the ONLY reason a DM cannot be sent,
 * so it has to reach the UI as something a person can act on rather than as a
 * failure they will read as the app being broken. Registering keys needs a
 * verified email, so this window cannot be closed from the sender's side.
 */
export class E2EPeerNotReadyError extends Error {
  constructor(public readonly peerUserId: string) {
    super('Recipient has no device set up for encrypted messages');
    this.name = 'E2EPeerNotReadyError';
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
/** Give up on a target after this many failed retry rounds (see spec §12.4). */
const MAX_SHARE_RETRIES = 10;
/** Hard stop when draining the key-share inbox (guards a hostile server). */
const MAX_CLAIM_PAGES = 20;

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

/**
 * Canonical fingerprint of a device list — the rotation trigger (see D9).
 * Includes each device's identity key, so re-registering new keys under an
 * existing deviceId also forces a re-key (otherwise the peer would keep
 * sending on a session our side has already torn down).
 */
function deviceSetFingerprint(devices: Array<{ deviceId: string; curve25519Key: string }>): string {
  return devices
    .map((d) => `${d.deviceId}:${d.curve25519Key}`)
    .sort()
    .join(',');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The typed reason a restore never left the device: the key failed its own
 * checksum (§15.2). Distinguishing this from "the key did not open the blob"
 * is the entire point of putting a checksum on a recovery key — one is a typo
 * to correct, the other means this key is for a different account identity.
 * A class rather than a message so the UI never has to string-match.
 */
/**
 * A linking code matched more than one device. Impossible by accident — the
 * code is 80 bits — so it means someone registered a device engineered to
 * collide with the one the user is reading. Picking either would be picking
 * theirs half the time, so we pick neither.
 */
export class E2ELinkingKeysChangedError extends Error {
  constructor() {
    super('That device is no longer showing the code you confirmed');
    this.name = 'E2ELinkingKeysChangedError';
  }
}

export class E2ELinkingCodeAmbiguousError extends Error {
  constructor() {
    super('That code matches more than one device');
    this.name = 'E2ELinkingCodeAmbiguousError';
  }
}

export class E2ERecoveryKeyFormatError extends Error {
  constructor() {
    super('That does not look like a recovery key');
    this.name = 'E2ERecoveryKeyFormatError';
  }
}

export class E2EService {
  private readonly api: typeof defaultApi;
  private readonly vault: E2EVault;
  private readonly wasmInput?: BufferSource;
  private readonly deviceListCacheMs: number;

  private account: EngineAccount | null = null;
  /** This account's cross-signing master key — only if THIS device holds it. */
  private masterKey: EngineMasterKey | null = null;
  /** Set when the server serves a master key we can neither prove nor match. */
  private masterKeyConflict = false;
  /**
   * Has any response from this server advertised cross-signing? Once true, an
   * answer that omits the flag can no longer be excused as a pre-cross-signing
   * node, so it stops earning the rollout grace above.
   */
  private crossSigningSeen = false;
  /**
   * The account key our own list last SERVED, self-signature verified — as
   * opposed to the one we pinned. An approval hands over the key the account
   * publishes now, which after a §14.4 reset on a sibling is deliberately not
   * the one this device pinned.
   */
  private servedOwnMasterKey: string | null = null;
  private myDeviceId: string | null = null;
  /** pairwise Olm sessions, keyed `${userId}|${deviceId}` */
  private olmSessions = new Map<string, EngineSession>();
  /** outbound group sessions, keyed by conversationId */
  private outbound = new Map<string, { session: EngineGroupSession; record: OutboundGroupSessionRecord }>();
  /** inbound group sessions, keyed by megolm session id */
  private inbound = new Map<string, { session: EngineInboundGroupSession; record: InboundGroupSessionRecord }>();
  private deviceListCache = new Map<string, { at: number; list: E2EPinnedDeviceList }>();
  private deviceListInFlight = new Map<string, Promise<E2EPinnedDeviceList>>();

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
    // Cross-signing bootstrap (spec §14, D5). Never fatal: a device that cannot
    // publish or hold a master key still encrypts — it is only "unsigned".
    try {
      await this.bootstrapMasterKey();
    } catch (err) {
      console.warn('e2e: cross-signing bootstrap failed — this device stays unsigned:', errText(err));
    }
    this.initialized = true;

    // None of these may block the UI: key shares are re-claimed lazily on a
    // decrypt miss, replenishment only matters for future peers, and the master
    // secret only arrives once another device approves this one.
    this.enqueue(() => this.claimKeyShares()).catch((err) => {
      console.warn('e2e: initial key-share claim failed:', errText(err));
    });
    this.enqueue(() => this.claimMasterTransfersUnqueued()).catch((err) => {
      console.warn('e2e: initial master-transfer claim failed:', errText(err));
    });
    this.replenishOneTimeKeys().catch((err) => {
      console.warn('e2e: one-time key replenishment failed:', errText(err));
    });
    // Catch up on sessions that arrived while this device was offline. Best
    // effort by design: history backup falling behind must never stop the
    // client working, and the next launch tries again.
    this.backupMessageKeys().catch((err) => {
      console.warn('e2e: message-key backup pass failed:', errText(err));
    });
  }

  dispose(): void {
    this.account?.free();
    this.account = null;
    this.masterKey?.free();
    this.masterKey = null;
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

  // ─── Cross-signing: the account master key (spec §14) ───────────────────────

  /** True when THIS device holds the account master secret. */
  hasMasterSecret(): boolean {
    return this.masterKey !== null;
  }

  /** Only a device holding the master secret can approve another one (D6). */
  canApproveDevices(): boolean {
    return this.masterKey !== null;
  }

  /**
   * A published master key is only usable once its SELF-signature checks out
   * (D1) — otherwise the server could serve any key it likes and every device
   * "signed" by it would look account-approved. Returns null (= this account
   * has no master key) rather than throwing: cross-signing is warn-not-block.
   */
  private verifiedMasterKey(userId: string, masterKey: unknown, masterSignature: unknown): string | null {
    if (typeof masterKey !== 'string' || !E2E_KEY_B64_RE.test(masterKey)) return null;
    if (typeof masterSignature !== 'string' || !E2E_SIGNATURE_B64_RE.test(masterSignature)) return null;
    try {
      verify_ed25519(masterKey, e2eMasterCanonical(userId, masterKey), masterSignature);
      return masterKey;
    } catch (err) {
      console.warn(`e2e: master key of ${userId} has an invalid self-signature — ignored:`, errText(err));
      return null;
    }
  }

  /** Does `masterKey` vouch for this device (D2)? Never throws. */
  private hasValidCrossSignature(
    userId: string,
    entry: { deviceId: string; curve25519Key: string; ed25519Key: string; masterSignature?: string | null },
    masterKey: string | null
  ): boolean {
    if (!masterKey) return false;
    const signature = entry.masterSignature;
    if (typeof signature !== 'string' || !E2E_SIGNATURE_B64_RE.test(signature)) return false;
    try {
      verify_ed25519(
        masterKey,
        e2eDeviceCrossCanonical(userId, entry.deviceId, entry.curve25519Key, entry.ed25519Key),
        signature
      );
      return true;
    } catch (err) {
      console.warn(`e2e: device ${entry.deviceId} of ${userId} carries an invalid cross-signature:`, errText(err));
      return false;
    }
  }

  /**
   * Bootstrap this account's cross-signing state (D5), run once per initialize:
   *
   * - no master key published → generate one, seal it, publish it, and
   *   cross-sign THIS device (the first device is trusted from the start);
   * - published and we hold the secret → make sure this device is signed;
   * - published and we do NOT hold the secret → register normally and stay
   *   UNSIGNED until another device approves us (D6). Never a failure.
   *
   * A published master key is NEVER silently replaced: that is an account
   * identity change and every peer would see a new safety number.
   */
  /**
   * Establish this device's relationship to the account's cross-signing key
   * (spec §14). The ordering of these cases is the whole security model:
   *
   *   the secret we hold  >  the key we pinned earlier  >  what the server says
   *
   * The server is untrusted storage. It must never be able to make us adopt a
   * master key we cannot prove, discard one we hold, or mint a replacement for
   * one we already pinned — each of those would silently re-root account trust.
   */
  private async bootstrapMasterKey(): Promise<void> {
    const sealed = await this.vault.getMasterSecret();
    if (sealed && !this.masterKey) {
      try {
        this.masterKey = EngineMasterKey.fromSealed(sealed, this.vault.pickleKey());
      } catch (err) {
        // Pickle key lost/rotated — the sealed copy is gone for good. The
        // account key itself survives on whichever device still holds it.
        console.warn('e2e: master secret unreadable — this device can no longer approve devices:', errText(err));
        await this.vault.deleteMasterSecret();
      }
    }

    const res = await this.api.get(`/e2e/devices/me?deviceId=${encodeURIComponent(this.deviceId)}`);
    const data = res.data.data as {
      devices?: E2EDeviceEntry[];
      masterKey?: string | null;
      masterSignature?: string | null;
      crossSigning?: boolean;
    };
    // A node that predates cross-signing simply omits these fields, which is
    // indistinguishable from "this account has no master key" — and acting on
    // that reading would mint a replacement key, resetting trust for every
    // peer. During a rolling deploy some nodes are always old, so bootstrap
    // only ever runs against a node that says it supports cross-signing.
    if (data.crossSigning !== true) {
      console.warn('e2e: server does not advertise cross-signing — deferring account key setup');
      return;
    }
    this.crossSigningSeen = true;
    // Sign OUR OWN keys, never the server's copy of them. We hold this device's
    // private halves, so there is no reason to take the server's word for the
    // public ones — and doing so would let a server collect a valid account
    // signature over an Olm identity it generated, which every peer who
    // compared the account safety number would then trust silently.
    const account = this.requireAccount();
    const own = {
      deviceId: this.deviceId,
      curve25519Key: account.curve25519Key(),
      ed25519Key: account.ed25519Key(),
      // the published signature, to be checked AGAINST our real keys below
      masterSignature: (data.devices ?? []).find((d) => d?.deviceId === this.deviceId)?.masterSignature,
    };
    const published = this.verifiedMasterKey(this.userId, data.masterKey, data.masterSignature);
    const pinned = await this.vault.getMasterIdentity(this.userId);

    // ── A. We hold the secret: it is the account key, full stop. ──
    if (this.masterKey) {
      const mine = this.masterKey.publicKey();
      if (pinned?.masterKey !== mine) {
        await this.vault.putMasterIdentity(this.userId, { masterKey: mine, verified: true });
      }
      if (!published) {
        // Server has none yet (fresh account, or it lost the row): publish ours.
        await this.publishMasterKey(this.masterKey, [own]);
        this.deviceListCache.delete(this.userId);
      } else if (published !== mine) {
        // A key we did not create is published under our account. Do NOT delete
        // our secret and do NOT adopt theirs — either would hand the account to
        // whoever produced it. Surface it and stop.
        this.masterKeyConflict = true;
        console.error('e2e: the account has a published master key this device did not create — refusing to adopt it');
      } else if (!this.hasValidCrossSignature(this.userId, own, mine)) {
        // We hold the key but this device is not signed by it (approved
        // elsewhere, or registered before cross-signing existed).
        await this.crossSignOwnDevice(this.masterKey, own);
        this.deviceListCache.delete(this.userId);
      }
      return;
    }

    // ── B. No secret, but we already know our account key. ──
    if (pinned) {
      if (published && published !== pinned.masterKey) {
        // Someone replaced the account key without us. Never adopt it silently:
        // adopting is exactly the "trust reset" a hostile server wants.
        this.masterKeyConflict = true;
        console.error('e2e: the published account master key differs from the pinned one');
      }
      // Either way this device stays unsigned until an existing device approves
      // it. Minting a replacement here would reset trust for every peer.
      return;
    }

    // ── C. No secret, no pin, but the account already has a key. ──
    if (published) {
      // Trust on first use for our OWN account — we cannot prove this key is
      // ours, so it is pinned UNVERIFIED and this device stays unsigned until
      // another device approves it. (Marking it verified here would let a
      // server-supplied key silently bless server-injected devices.)
      await this.vault.putMasterIdentity(this.userId, { masterKey: published, verified: false });
      return;
    }

    // ── D. Genuinely the first device on this account: mint the key. ──
    const master = new EngineMasterKey();
    this.masterKey = master;
    // Sealed BEFORE publishing: a crash between the two would otherwise publish
    // a key nobody holds, and it can never be replaced silently.
    await this.vault.putMasterSecret(master.seal(this.vault.pickleKey()));
    await this.publishMasterKey(master, [own]);
    await this.vault.putMasterIdentity(this.userId, { masterKey: master.publicKey(), verified: true });
    this.deviceListCache.delete(this.userId);
  }

  /**
   * Deliberately start a new account identity (spec §14.4 recovery).
   *
   * The only way out when no device holds the account key any more — a
   * single-device reinstall, a lost keychain, or a published key this device
   * cannot prove. Minting is safe HERE precisely because the user asked for
   * it: the danger the bootstrap guards against is a SERVER provoking a mint.
   * Peers see the account safety number change, which is the honest signal.
   */
  async resetAccountIdentity(): Promise<void> {
    return this.enqueue(async () => {
      const account = this.requireAccount();
      // Re-publish rather than replace when this device still holds the account
      // key: it restores the account with NO safety-number change, so nobody
      // has to re-verify. Minting here would throw away a working identity to
      // fix a server-side edit.
      const held = this.masterKey;
      const master = held ?? new EngineMasterKey();
      // Publish BEFORE overwriting what this device holds. The mint path seals
      // first (there is nothing to lose and an unpublished key self-heals on
      // the next launch); a reset can be replacing a WORKING key, so a failed
      // publish must leave the device exactly as it was rather than destroying
      // the key it still had. If the publish lands and the seal below fails,
      // the account is in the "published key we do not hold" state — which is
      // visible, and which this very action can clear.
      await this.publishMasterKey(master, [
        {
          deviceId: this.deviceId,
          curve25519Key: account.curve25519Key(),
          ed25519Key: account.ed25519Key(),
        },
      ]);
      if (!held) {
        try {
          await this.vault.putMasterSecret(master.seal(this.vault.pickleKey()));
        } catch (err) {
          // Published but not sealed: the account now advertises a key this
          // device cannot use. Say so rather than carrying on with the old one.
          master.free();
          this.masterKeyConflict = true;
          throw err;
        }
        this.masterKey?.free();
        this.masterKey = master;
      }
      await this.vault.putMasterIdentity(this.userId, { masterKey: master.publicKey(), verified: true });
      this.masterKeyConflict = false;
      if (!held) {
        // The backup subkey is derived from the master key, so every stored
        // session key just became undecryptable. Leaving them would bill the
        // user storage for rows nothing can ever read.
        await this.api.delete('/e2e/message-keys').catch((err) => {
          console.warn('e2e: could not drop message keys the new identity orphaned:', errText(err));
        });
        // The old backup decrypts to a key this account no longer publishes,
        // so restoring from it could only ever fail. Leaving it would hand the
        // user a recovery key that looks like a way back and is not.
        await this.api.delete('/e2e/backup').catch((err) => {
          console.warn('e2e: could not drop the superseded key backup:', errText(err));
        });
      }
      this.deviceListCache.delete(this.userId);
      await this.fetchDeviceList(this.userId, true);
    });
  }

  /** Publish (or re-publish) our master key, optionally signing devices with it. */
  private async publishMasterKey(
    master: EngineMasterKey,
    devices: Array<{ deviceId: string; curve25519Key: string; ed25519Key: string }>
  ): Promise<void> {
    const masterKey = master.publicKey();
    const deviceSignatures = devices.map((device) => ({
      deviceId: device.deviceId,
      signature: master.sign(
        e2eDeviceCrossCanonical(this.userId, device.deviceId, device.curve25519Key, device.ed25519Key)
      ),
    }));
    await this.api.put('/e2e/master-key', {
      masterKey,
      masterSignature: master.sign(e2eMasterCanonical(this.userId, masterKey)),
      ...(deviceSignatures.length > 0 && { deviceSignatures }),
    });
  }

  private async crossSignOwnDevice(
    master: EngineMasterKey,
    device: { deviceId: string; curve25519Key: string; ed25519Key: string }
  ): Promise<void> {
    await this.api.post(`/e2e/devices/${encodeURIComponent(device.deviceId)}/signature`, {
      signature: master.sign(
        e2eDeviceCrossCanonical(this.userId, device.deviceId, device.curve25519Key, device.ed25519Key)
      ),
    });
  }

  /**
   * Pin OUR OWN account master key. Holding the secret is proof the key is
   * ours, so that case always (re)pins; without the secret a differing key is
   * left unpinned, and fetchDeviceList then raises E2EIdentityChangedError —
   * the same honest signal peers get.
   */

  /**
   * Approve another device of THIS account (D6): cross-sign it, publish the
   * signature, then hand it the master secret over the pairwise Olm channel so
   * it can approve future devices in turn. The secret is encrypted end-to-end
   * between our two devices — the server only ever relays an olm1 envelope.
   */
  async approveDevice(deviceId: string, expectedLinkingCode?: string): Promise<void> {
    if (deviceId === this.deviceId) throw new Error('This device is already approved');
    if (!E2E_DEVICE_ID_RE.test(deviceId)) throw new Error('Invalid device id');
    return this.enqueue(async () => {
      const master = this.masterKey;
      if (!master) throw new Error('This device does not hold the account key and cannot approve devices');

      const list = await this.fetchDeviceList(this.userId, true);
      const target = list.devices.find((d) => d.deviceId === deviceId);
      if (!target) throw new Error(`Unknown device ${deviceId}`);

      // The typed code authenticated a device by its KEYS; everything after
      // travels by device id. Those are two different questions to the server,
      // and it may answer the second one differently: same id, attacker keys,
      // valid self-signature. Then the master secret below is sealed to the
      // attacker's curve25519 and cross-signed under the account key, and the
      // code the user carefully compared bound nothing at all.
      //
      // Recomputing here is what makes the code load-bearing rather than
      // decorative — it is checked against the very entry the secret is about
      // to be sealed to.
      if (expectedLinkingCode !== undefined) {
        let actual: string;
        try {
          actual = linkingCode(this.userId, deviceId, target.curve25519Key, target.ed25519Key);
        } catch {
          throw new E2ELinkingKeysChangedError();
        }
        if (actual.replace(/-/g, '') !== expectedLinkingCode.replace(/[\s-]/g, '').toUpperCase()) {
          throw new E2ELinkingKeysChangedError();
        }
      }

      // Order matters: queue the secret FIRST, publish the signature second.
      // The reverse leaves a device that everyone treats as fully trusted but
      // which never received the key — and the approve button disappears with
      // it, because approval is offered only for unsigned devices. Failing
      // before the signature just means the user retries.
      // The payload is assembled inside the engine: the private half never
      // becomes a JS string (spec §7 — the pickle key is the only secret JS
      // handles).
      const olm = await this.ensureOlmSession(this.userId, deviceId);
      const { messageType, body } = olm.encryptMasterSecret(master) as { messageType: 0 | 1; body: string };
      await this.persistOlmSession(this.userId, deviceId, olm);
      await this.api.post('/e2e/master-transfers', {
        deviceId: this.deviceId,
        transfers: [{ recipientDeviceId: deviceId, body: buildE2EEnvelope(messageType, body) }],
      });

      await this.crossSignOwnDevice(master, target);

      // The device is trusted from now on — re-read so the local warning state
      // drops it (a cross-signed device is acknowledged automatically, D8).
      this.deviceListCache.delete(this.userId);
      await this.fetchDeviceList(this.userId, true);
    });
  }

  /**
   * Claim this device's pending master-secret transfers (D6). Returns true when
   * one was accepted — after which this device can approve others.
   */
  async claimMasterTransfers(): Promise<boolean> {
    return this.enqueue(() => this.claimMasterTransfersUnqueued());
  }

  /** Callers must already hold the serial queue (this advances Olm state). */
  private async claimMasterTransfersUnqueued(): Promise<boolean> {
    if (this.masterKey) return false; // already approved — nothing to import

    // Learn the expected key BEFORE reading the mailbox. Reading is harmless
    // now that it no longer deletes, but a failure here would still waste the
    // round trip — and the ordering keeps the "never import a secret we cannot
    // check against the published key" rule impossible to get wrong.
    // Check the payload against what the account PUBLISHES, not against what
    // this device pinned. They differ exactly when a sibling has just run the
    // §14.4 reset — the sanctioned recovery — and using the stale pin there
    // would reject the very approval meant to rescue this device, then delete
    // it as unusable. Holding the secret is what proves the key, and the
    // engine still checks the payload derives to this exact key.
    const list = await this.fetchDeviceList(this.userId, true);
    const published = this.servedOwnMasterKey ?? list.masterKey;
    if (!published) {
      console.warn('e2e: this account publishes no master key — leaving any transfer for later');
      return false;
    }

    const res = await this.api.get(`/e2e/master-transfers?deviceId=${encodeURIComponent(this.deviceId)}`);
    const transfers = (res.data.data as { transfers?: unknown[] }).transfers;
    if (!Array.isArray(transfers) || transfers.length === 0) return false;

    // Rows are deleted only once they have been dealt with. A read that
    // consumed them would make every transient failure permanent: the device
    // is already cross-signed by then, so it looks approved to everyone, the
    // approve button is gone, and nothing would ever hand it the key again.
    const done: string[] = [];
    let imported = false;
    for (const transfer of transfers) {
      const id = (transfer as { id?: unknown }).id;
      try {
        if (await this.importMasterTransfer(transfer as Record<string, unknown>, published)) {
          if (typeof id === 'string') done.push(id);
          imported = true;
          break;
        }
      } catch (err) {
        // Only drop a row we can be sure will never work. Dropping on ANY
        // failure would put the stranding back exactly where it was, with the
        // client doing the deleting instead of the server: the device is
        // already cross-signed by this point, so a row discarded over a lookup
        // or network hiccup leaves it trusted by every peer, holding no key,
        // and no longer offered for approval. A kept row costs nothing — the
        // mailbox is capped per device and swept.
        if (typeof id === 'string' && err instanceof E2EUnusableTransferError) done.push(id);
        console.warn('e2e: master-secret transfer not imported:', errText(err));
      }
    }
    if (imported) {
      // Linking is the PRIMARY way a device joins an account, so it has to pull
      // history the same way recovery does. Without this, message-key backup
      // only ever worked for someone who had lost every device — the rarer
      // path — and a freshly linked one showed empty conversations.
      try {
        await this.restoreMessageKeys();
      } catch (err) {
        console.warn('e2e: linked device has the account key but not its history yet:', errText(err));
      }
    }
    if (done.length > 0) {
      await this.api
        .post('/e2e/master-transfers/ack', { deviceId: this.deviceId, ids: done })
        .catch((err) => {
          // Harmless: the rows stay until the next claim or the sweep, and
          // re-importing the same secret is idempotent.
          console.warn('e2e: could not clear claimed master transfers:', errText(err));
        });
    }
    return imported;
  }

  private async importMasterTransfer(
    transfer: Record<string, unknown>,
    publishedMasterKey: string
  ): Promise<boolean> {
    const senderDeviceId = transfer.senderDeviceId;
    if (
      typeof senderDeviceId !== 'string' ||
      !E2E_DEVICE_ID_RE.test(senderDeviceId) ||
      typeof transfer.body !== 'string'
    ) {
      throw new E2EUnusableTransferError('malformed master-secret transfer');
    }
    if (senderDeviceId === this.deviceId) {
      throw new E2EUnusableTransferError('master-secret transfer attributed to this device');
    }
    const envelope = parseE2EEnvelope(transfer.body);
    if (!envelope || envelope.e !== E2E_ENGINE_OLM1) {
      throw new E2EUnusableTransferError('master-secret transfer body is not an olm1 envelope');
    }

    // Authenticated by the sending device's pinned identity, exactly like a key
    // share: only a device of this account can produce readable ciphertext.
    let identity = await this.vault.getIdentity(this.userId, senderDeviceId);
    if (!identity) {
      await this.fetchDeviceList(this.userId, true);
      identity = await this.vault.getIdentity(this.userId, senderDeviceId);
    }
    if (!identity) throw new Error(`unknown sender device ${senderDeviceId}`);

    // Decrypted inside the engine, which also enforces that the secret derives
    // to the published account key — JS never sees the private half and cannot
    // skip the check.
    //
    // Everything from here on is past the point of no return: decrypting
    // advances the Olm ratchet, so this row can never be read again whether we
    // succeed or not. That — not "an error happened" — is what makes it safe
    // to drop.
    let master: EngineMasterKey | null;
    try {
      master = await this.olmDecryptMasterSecret(senderDeviceId, envelope, publishedMasterKey);
    } catch (err) {
      throw new E2EUnusableTransferError(errText(err));
    }
    if (!master) throw new Error('no Olm session for this master-secret transfer');

    try {
      await this.vault.putMasterSecret(master.seal(this.vault.pickleKey()));
    } catch (err) {
      master.free();
      throw new E2EUnusableTransferError(errText(err));
    }
    this.masterKey?.free();
    this.masterKey = master;
    // We hold the secret now, which is the strongest proof there is that this
    // is the account key — stronger than the pin it may be replacing. Without
    // this, a device rescued by the §14.4 reset would keep the superseded pin
    // and report a conflict against the key it is itself holding.
    const mine = master.publicKey();
    const pinned = await this.vault.getMasterIdentity(this.userId);
    if (pinned?.masterKey !== mine || !pinned.verified) {
      await this.vault.putMasterIdentity(this.userId, { masterKey: mine, verified: true });
    }
    this.masterKeyConflict = false;
    this.deviceListCache.delete(this.userId);
    return true;
  }

  // ─── Encrypted key backup (spec §15) ──────────────────────────────────────

  /** Does this account have a backup, and when was it last written? */
  async keyBackupInfo(): Promise<{ exists: boolean; updatedAt: string | null }> {
    const res = await this.api.get('/e2e/backup');
    const data = res.data.data as { exists?: boolean; updatedAt?: string | null };
    return { exists: data.exists === true, updatedAt: data.updatedAt ?? null };
  }

  /**
   * Back the account key up under a fresh recovery key, and return that key —
   * ONCE. It is never stored, never sent, and cannot be re-derived: the whole
   * point is that the server holds a blob it has no way to open.
   *
   * Only a device that holds the account key can do this, which is what stops
   * an attacker with a session token from minting a backup of a key nobody has.
   */
  async createKeyBackup(): Promise<string> {
    return this.enqueue(async () => {
      const master = this.masterKey;
      if (!master) throw new Error('This device does not hold the account key');
      // Mirror of the restore-side rule (§15.4): back up only a key the account
      // actually publishes. Holding one is not the same as it being live — a
      // bootstrap that minted a key and then failed to publish it would
      // otherwise have the user write down a recovery key for an identity that
      // never existed, and only find out when they came to use it.
      const list = await this.fetchDeviceList(this.userId, true);
      const published = this.servedOwnMasterKey ?? list.masterKey;
      if (published && published !== master.publicKey()) {
        throw new Error('This account publishes a different key — resolve that before backing up');
      }
      const recoveryKey = generateRecoveryKey();
      // Sealed in the engine: the private half never becomes a JS string, and
      // neither does the recovery key beyond the one we hand back to be shown.
      const blob = master.sealForBackup(recoveryKey);
      await this.api.put('/e2e/backup', { blob });
      return recoveryKey;
    });
  }

  /** Forget the backup. The recovery key that opened it becomes useless. */
  async deleteKeyBackup(): Promise<void> {
    await this.api.delete('/e2e/backup');
  }

  /**
   * Recover the account key from backup instead of starting a new identity
   * (§14.4's other exit). On success this device holds the account key, is
   * cross-signed by it, and can approve the user's other devices — no peer
   * sees a safety-number change, because the identity never changed.
   */
  async restoreKeyBackup(recoveryKey: string): Promise<void> {
    // Checked before the request: a typo should say "that is not your recovery
    // key", not "decryption failed" after a round trip.
    if (!isRecoveryKeyWellFormed(recoveryKey)) throw new E2ERecoveryKeyFormatError();
    await this.enqueue(async () => {
      const account = this.requireAccount();
      const res = await this.api.get('/e2e/backup');
      const data = res.data.data as { exists?: boolean; blob?: string | null };
      if (data.exists !== true || typeof data.blob !== 'string') {
        throw new Error('This account has no key backup');
      }

      // Judge the blob against what the account PUBLISHES, exactly as an
      // incoming device approval is judged: a server that substituted a blob of
      // its own making must not be able to have us install the key inside it.
      const list = await this.fetchDeviceList(this.userId, true);
      const published = this.servedOwnMasterKey ?? list.masterKey;
      if (!published) throw new Error('This account publishes no master key to restore');

      const master = openMasterKeyBackup(data.blob, recoveryKey, published);
      await this.vault.putMasterSecret(master.seal(this.vault.pickleKey()));
      this.masterKey?.free();
      this.masterKey = master;
      // Holding the secret proves the key, so the pin becomes verified.
      await this.vault.putMasterIdentity(this.userId, { masterKey: master.publicKey(), verified: true });
      this.masterKeyConflict = false;

      // This device is almost certainly unsigned — that is why it needed
      // recovering — so sign it now rather than leaving every peer warning.
      await this.crossSignOwnDevice(master, {
        deviceId: this.deviceId,
        curve25519Key: account.curve25519Key(),
        ed25519Key: account.ed25519Key(),
      });
      this.deviceListCache.delete(this.userId);
      await this.fetchDeviceList(this.userId, true);
    });

    // Recovering the identity without the history leaves the user staring at
    // empty conversations: the account is back and everything in it is still
    // unreadable. Not fatal if it fails — the identity IS recovered, and the
    // next launch retries.
    try {
      await this.restoreMessageKeys();
    } catch (err) {
      console.warn('e2e: recovered the account key but not its history yet:', errText(err));
    }
  }

  // ─── Device linking (spec §17) ────────────────────────────────────────────

  /**
   * The code THIS device shows so another one can approve it.
   *
   * Derived from this device's own published keys, so it is stable, carries no
   * secret, and is worth nothing to anyone who reads it over the user's
   * shoulder — approving still requires the other device to hold the account
   * key and its user to confirm.
   */
  linkingCode(): string {
    const account = this.requireAccount();
    return linkingCode(this.userId, this.deviceId, account.curve25519Key(), account.ed25519Key());
  }

  /**
   * Find the device a linking code names, so it can be approved.
   *
   * The code is recomputed from the keys the SERVER served for each device.
   * That is what makes this safer than picking from a list: a device the server
   * injected has keys of its own, so it produces a different code and cannot be
   * reached by a user typing what their new device is showing.
   */
  async findLinkableDevice(
    code: string
  ): Promise<{ deviceId: string; createdAt: string; linkingCode: string } | null> {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    const own = await this.listOwnDevices();
    const matches: Array<{ deviceId: string; createdAt: string; linkingCode: string }> = [];
    for (const device of own.devices) {
      // Already vouched for: there is nothing to link, and offering it would
      // invite a second approval of a device that is already trusted.
      if (device.crossSigned) continue;
      if (device.deviceId === this.deviceId) continue;
      let candidate: string;
      try {
        candidate = linkingCode(this.userId, device.deviceId, device.curve25519Key, device.ed25519Key);
      } catch {
        continue; // malformed keys cannot be linked to
      }
      if (candidate.replace(/-/g, '') === normalized) {
        // Carry the code forward, not just the id. The id is what the server
        // will be asked about again at approval time, and it is free to answer
        // with different keys — so the id alone binds nothing.
        matches.push({
          deviceId: device.deviceId,
          createdAt: device.createdAt,
          linkingCode: candidate,
        });
      }
    }
    // Never take the first of several: the server chooses the order, so
    // "first match" would let it put its own device ahead of the real one.
    if (matches.length > 1) throw new E2ELinkingCodeAmbiguousError();
    return matches[0] ?? null;
  }

  // ─── Message-key backup (spec §16) ────────────────────────────────────────
  //
  // Without this, a device that joins the account later reads nothing that was
  // sent before it existed — and once DMs are always encrypted there is no
  // plaintext history to fall back on. Session keys are sealed under a subkey
  // of the account master key, so exactly the devices that can read new
  // messages can read old ones, and the recovery key already restores both.

  /**
   * Back up the session keys this device holds that the account has not stored
   * yet. Safe to call often: what is already uploaded is remembered locally,
   * so a steady state costs nothing.
   */
  async backupMessageKeys(): Promise<number> {
    const master = this.masterKey;
    if (!master) return 0; // only a device holding the account key can seal

    const records = await this.vault.listInboundGroupSessions();
    const uploaded = await this.vault.getBackedUpSessionIds();
    const pending = records.filter((r) => !uploaded.includes(r.sessionId));
    if (pending.length === 0) return 0;

    let stored = 0;
    for (let i = 0; i < pending.length; i += E2E_LIMITS.MESSAGE_KEY_BATCH_MAX) {
      const batch = pending.slice(i, i + E2E_LIMITS.MESSAGE_KEY_BATCH_MAX);
      const keys: Array<{ conversationId: string; sessionId: string; blob: string; firstKnownIndex: number }> = [];
      for (const record of batch) {
        const loaded = await this.loadInbound(record.sessionId);
        if (!loaded) continue;
        // Exported at the FIRST known index: a restoring device must be able to
        // read the whole session, not just from wherever this device joined it.
        // WHO sent the session travels inside the ciphertext, not as a column:
        // the restoring device needs it to attribute the session correctly (a
        // session restored as our own cannot decrypt a peer's messages), and
        // the server has no business learning it.
        const payload = JSON.stringify({
          k: loaded.session.exportAtFirstKnownIndex(),
          u: record.senderUserId,
          d: record.senderDeviceId,
        });
        keys.push({
          conversationId: record.conversationId,
          sessionId: record.sessionId,
          blob: master.sealSessionKey(payload, `${record.conversationId}|${record.sessionId}`),
          // Sent in the clear so the SERVER can refuse a key that would move
          // the session forwards: a device that joined late holds less of it,
          // and overwriting an earlier device's key would destroy the messages
          // in between.
          firstKnownIndex: loaded.session.firstKnownIndex(),
        });
      }
      if (keys.length === 0) continue;
      await this.api.post('/e2e/message-keys', { keys });
      await this.vault.addBackedUpSessionIds(keys.map((k) => k.sessionId));
      stored += keys.length;
    }
    return stored;
  }

  /**
   * Pull every backed-up session key and import what this device is missing.
   * Run after linking or recovery — it is what turns a blank new device into
   * one that shows the account's history.
   */
  async restoreMessageKeys(): Promise<number> {
    const master = this.masterKey;
    if (!master) throw new Error('This device does not hold the account key');

    let cursor: string | null = null;
    let imported = 0;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await this.api.get(`/e2e/message-keys${query}`);
      const data = res.data.data as {
        keys?: Array<{ conversationId?: unknown; sessionId?: unknown; blob?: unknown }>;
        nextCursor?: string | null;
      };
      for (const row of data.keys ?? []) {
        const { conversationId, sessionId, blob } = row;
        if (typeof conversationId !== 'string' || typeof sessionId !== 'string' || typeof blob !== 'string') {
          console.warn('e2e: dropping a malformed message-key backup row');
          continue;
        }
        try {
          const opened = master.openSessionKey(blob, `${conversationId}|${sessionId}`);
          const payload = JSON.parse(opened) as { k?: unknown; u?: unknown; d?: unknown };
          if (
            typeof payload.k !== 'string' ||
            typeof payload.u !== 'string' ||
            typeof payload.d !== 'string'
          ) {
            throw new Error('malformed backed-up session payload');
          }
          // Same import path as a key share, so the session-id check that
          // stops a mislabelled key applies here too.
          const added = await this.importInboundGroupSession(payload.k, {
            sessionId,
            conversationId,
            senderUserId: payload.u,
            senderDeviceId: payload.d,
            keyType: 'exported',
          });
          if (added) imported += 1;
        } catch (err) {
          // One unreadable row must not abandon the rest of someone's history.
          console.warn(`e2e: skipping an unusable backed-up session key:`, errText(err));
        }
      }
      cursor = data.nextCursor ?? null;
    } while (cursor);

    return imported;
  }

  /** Our own account master key (held or pinned), for safety numbers. */
  private async ownMasterKey(): Promise<string | null> {
    if (this.masterKey) return this.masterKey.publicKey();
    const pinned = await this.vault.getMasterIdentity(this.userId);
    return pinned?.masterKey ?? null;
  }

  /** UI: the server published an account key we cannot prove or match (§14). */
  hasMasterKeyConflict(): boolean {
    return this.masterKeyConflict;
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
  async fetchDeviceList(
    userId: string,
    freshness: boolean | number = false
  ): Promise<E2EPinnedDeviceList> {
    // `freshness`: false = normal cache, true = force a round trip, or a
    // max-age in ms. The send path passes a small max-age instead of forcing —
    // two uncached GETs per message would exhaust the per-user rate limit
    // during fast typing and start failing sends outright.
    const maxAge =
      freshness === true ? 0 : freshness === false ? this.deviceListCacheMs : freshness;
    const cached = this.deviceListCache.get(userId);
    if (cached && Date.now() - cached.at < maxAge) return cached.list;

    // Coalesce concurrent fetches for the same user (parallel sends, or a send
    // racing the UI refresh) into a single request.
    const inFlight = this.deviceListInFlight.get(userId);
    if (inFlight) return inFlight;
    const run = this.fetchDeviceListUncached(userId).finally(() => {
      this.deviceListInFlight.delete(userId);
    });
    this.deviceListInFlight.set(userId, run);
    return run;
  }

  private async fetchDeviceListUncached(userId: string): Promise<E2EPinnedDeviceList> {
    const res = await this.api.get(`/e2e/devices/${userId}`);
    const data = res.data.data as {
      devices?: E2EDeviceEntry[];
      listVersion?: number;
      masterKey?: string | null;
      masterSignature?: string | null;
      crossSigning?: boolean;
    };
    const devices: E2EDeviceIdentity[] = [];

    // ── D7 step 1+2: authenticate and TOFU-pin the ACCOUNT master key ──
    // A master key whose self-signature does not verify is treated as absent.
    // A CHANGED master key is an account identity change, not a new device.
    //
    // An old node (mid-rollout) omits the cross-signing fields entirely. Read
    // literally that says "every device just lost its signature", so instead we
    // carry the last known state forward and change nothing until a node that
    // supports cross-signing answers.
    //
    // Carrying forward is only ever right while this client has NEVER been
    // answered by a capable node. Once one has answered, an omission is not an
    // old node any more — it is a server withholding signatures, and carrying
    // forward would turn the "these devices are not signed" warning into
    // silence at exactly the moment it matters. After that point the response
    // is read literally and the user is warned.
    const crossSigningServed = data.crossSigning === true;
    if (crossSigningServed) this.crossSigningSeen = true;
    const rolloutGrace = !crossSigningServed && !this.crossSigningSeen;
    const priorState = rolloutGrace ? await this.vault.getDeviceListState(userId) : null;
    const priorCrossSigned = new Set(priorState?.crossSignedDeviceIds ?? []);
    const served = crossSigningServed
      ? this.verifiedMasterKey(userId, data.masterKey, data.masterSignature)
      : null;
    const pinnedMaster = await this.vault.getMasterIdentity(userId);
    if (userId === this.userId) this.servedOwnMasterKey = served;
    if (pinnedMaster && served && pinnedMaster.masterKey !== served) {
      if (userId === this.userId) {
        // Our OWN account. Throwing here would be fatal rather than
        // informative: the send path re-reads our own list on every message,
        // so one bad answer would make encrypted DMs unsendable forever. Keep
        // the key we pinned, flag the conflict, and let the user resolve it.
        this.masterKeyConflict = true;
        console.error('e2e: the published account master key differs from the pinned one');
      } else {
        throw new E2EIdentityChangedError(userId);
      }
    } else if (userId === this.userId && served && pinnedMaster?.masterKey === served) {
      // Resolved: the account publishes the key we pinned after all. Latching
      // the flag would leave a warning badge — and the destructive reset
      // affordance behind it — on an account that is perfectly healthy.
      this.masterKeyConflict = false;
    }
    if (!pinnedMaster && served) {
      await this.vault.putMasterIdentity(userId, { masterKey: served, verified: false });
    }
    // Cross-signatures are checked against the PINNED key: a server that
    // withdraws the master key cannot strip trust from devices it already
    // signed, it can only fail to add new ones.
    const masterKey = pinnedMaster?.masterKey ?? served;
    const masterVerified = pinnedMaster?.verified ?? false;

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
      // D7 step 3: does the account's master key vouch for this device?
      const crossSigned = rolloutGrace
        ? priorCrossSigned.has(entry.deviceId)
        : this.hasValidCrossSignature(userId, entry, masterKey);

      // Our own current device needs no pin: we hold its private keys.
      if (userId === this.userId && entry.deviceId === this.myDeviceId) {
        devices.push({
          deviceId: entry.deviceId,
          curve25519Key: entry.curve25519Key,
          ed25519Key: entry.ed25519Key,
          verified: true,
          crossSigned,
        });
        continue;
      }
      const pinned = await this.pinDevice(userId, entry);
      devices.push({
        deviceId: entry.deviceId,
        curve25519Key: pinned.curve25519Key,
        ed25519Key: pinned.ed25519Key,
        // D9: a cross-signed device inherits the account-level verification —
        // one out-of-band comparison covers every device the master key signs.
        verified: pinned.verified || (crossSigned && masterVerified),
        crossSigned,
      });
    }

    const list: E2EPinnedDeviceList = {
      devices,
      servedDeviceCount: (data.devices ?? []).length,
      listVersion: data.listVersion ?? 0,
      // Without a cross-signing-capable node we do not know the account key is
      // absent, only that this answer cannot tell us — keep what we had.
      masterKey: (rolloutGrace ? (priorState?.masterKey ?? masterKey) : masterKey) ?? null,
    };
    await this.recordDeviceListState(userId, list);
    this.deviceListCache.set(userId, { at: Date.now(), list });
    return list;
  }

  private async recordDeviceListState(userId: string, list: E2EPinnedDeviceList): Promise<void> {
    const deviceIds = list.devices.map((d) => d.deviceId);
    const crossSigned = new Set(list.devices.filter((d) => d.crossSigned).map((d) => d.deviceId));
    const state = await this.vault.getDeviceListState(userId);
    if (!state) {
      // First sight of this user's devices: nothing to warn about yet (TOFU).
      await this.vault.putDeviceListState(userId, {
        version: list.listVersion,
        deviceIds,
        acknowledgedVersion: list.listVersion,
        acknowledgedDeviceIds: deviceIds,
        masterKey: list.masterKey,
        acknowledgedMasterKey: list.masterKey,
        crossSignedDeviceIds: [...crossSigned],
      });
      return;
    }

    // D8: a device the account's master key vouches for is trusted transitively
    // — acknowledged automatically (no "new device" warning, peer or own) and
    // never in the sticky set.
    //
    // BUT only under a master key the user has actually acknowledged (or
    // verified out of band). A key that first appears in the SAME response as
    // the devices it signs proves nothing: a hostile server can mint one and
    // sign its own device with it. Seeing a key twice is not acknowledgement
    // either, so this compares against acknowledgedMasterKey, not masterKey.
    const pinnedMaster = await this.vault.getMasterIdentity(userId);
    const masterTrusted =
      !!list.masterKey &&
      ((state.acknowledgedMasterKey ?? null) === list.masterKey || !!pinnedMaster?.verified);
    const autoTrusted = (id: string) => masterTrusted && crossSigned.has(id);

    const acknowledgedDeviceIds = [
      ...new Set([...state.acknowledgedDeviceIds, ...deviceIds.filter(autoTrusted)]),
    ];
    // Sticky: remember every unsigned id seen since the last acknowledgement. A
    // server that adds a device and then withdraws it must not be able to erase
    // the warning — the device keeps whatever session key it was already given.
    const unacknowledged = new Set(
      (state.unacknowledgedDeviceIds ?? []).filter((id) => !autoTrusted(id))
    );
    for (const id of deviceIds) {
      if (autoTrusted(id)) continue;
      if (!acknowledgedDeviceIds.includes(id)) unacknowledged.add(id);
    }

    const unchanged =
      state.version === list.listVersion &&
      sameDeviceSet(state.deviceIds, deviceIds) &&
      sameDeviceSet(acknowledgedDeviceIds, state.acknowledgedDeviceIds) &&
      sameDeviceSet([...unacknowledged], state.unacknowledgedDeviceIds ?? []) &&
      // A device LOSING its cross-signature is a change, and one that matters:
      // leaving it out here meant a server could withdraw a signature and have
      // the stored state keep calling the device signed, so the warning never
      // fired no matter how often the list was re-read.
      sameDeviceSet([...crossSigned], state.crossSignedDeviceIds ?? []) &&
      (state.masterKey ?? null) === list.masterKey;
    if (unchanged) return;

    // Claim the version only when nothing is outstanding, so the arrival of a
    // cross-signed device does not leave `changed` stuck on the version alone.
    const settled = unacknowledged.size === 0 && deviceIds.every((id) => acknowledgedDeviceIds.includes(id));
    await this.vault.putDeviceListState(userId, {
      ...state,
      version: list.listVersion,
      deviceIds,
      acknowledgedDeviceIds,
      acknowledgedVersion: settled ? list.listVersion : state.acknowledgedVersion,
      unacknowledgedDeviceIds: [...unacknowledged],
      masterKey: list.masterKey,
      // Advanced ONLY by acknowledgeDeviceList — never here. Advancing it on a
      // quiet response would hand a server the H2 attack back in two steps:
      // publish a forged account key alone (nothing outstanding, so it looks
      // settled), then add a device signed by it (now "transitively trusted").
      // The user has to have acknowledged the key for it to vouch for anything.
      acknowledgedMasterKey: state.acknowledgedMasterKey ?? null,
      crossSignedDeviceIds: [...crossSigned],
    });
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
    if (!state) return { version: 0, deviceIds: [], newDeviceIds: [], unsignedDeviceIds: [], changed: false };
    const crossSigned = new Set(state.crossSignedDeviceIds ?? []);
    // Only meaningful once the account HAS a master key: before cross-signing
    // is bootstrapped every device is unsigned, which is not a signal (D11).
    const unsignedDeviceIds = state.masterKey ? state.deviceIds.filter((id) => !crossSigned.has(id)) : [];
    // Union of "here now" and "seen since the last acknowledgement": a device
    // that appeared and vanished again still has to be reported.
    const newDeviceIds = [
      ...new Set([
        ...state.deviceIds.filter((id) => !state.acknowledgedDeviceIds.includes(id)),
        ...(state.unacknowledgedDeviceIds ?? []).filter((id) => !state.acknowledgedDeviceIds.includes(id)),
      ]),
    ];
    const setChanged = !sameDeviceSet(state.deviceIds, state.acknowledgedDeviceIds);
    return {
      version: state.version,
      deviceIds: state.deviceIds,
      newDeviceIds,
      unsignedDeviceIds,
      changed: newDeviceIds.length > 0 || setChanged || state.acknowledgedVersion !== state.version,
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

  /**
   * UI: the user has seen these devices — stop warning about them.
   *
   * `seenDeviceIds` is what the UI actually rendered. Anything that appeared
   * after the render (the send path refreshes lists constantly) stays
   * unacknowledged, so one confirmation can never bless a change the user was
   * not shown.
   *
   * Since cross-signing (D8) acknowledgement is NOT enough for a device the
   * account's master key does not vouch for: those stay flagged until they are
   * approved or revoked. Clicking "I've seen it" cannot manufacture trust.
   */
  async acknowledgeDeviceList(userId: string, seenDeviceIds?: string[]): Promise<void> {
    return this.enqueue(() => this.acknowledgeDeviceListUnqueued(userId, seenDeviceIds));
  }

  /** Queue-free variant for callers that already hold the serial queue. */
  private async acknowledgeDeviceListUnqueued(userId: string, seenDeviceIds?: string[]): Promise<void> {
    {
      const state = await this.vault.getDeviceListState(userId);
      if (!state) return;
      const crossSigned = new Set(state.crossSignedDeviceIds ?? []);
      // Accounts without a master key keep the pre-cross-signing behaviour
      // (D11) — there is nothing they could be signed by.
      const acknowledgeable = (id: string) => !state.masterKey || crossSigned.has(id);
      const acknowledged = seenDeviceIds
        ? state.acknowledgedDeviceIds.concat(seenDeviceIds.filter((id) => state.deviceIds.includes(id)))
        : [...state.deviceIds];
      const acknowledgedDeviceIds = [
        ...new Set(acknowledged.filter((id) => state.acknowledgedDeviceIds.includes(id) || acknowledgeable(id))),
      ];
      const stillUnacknowledged = (state.unacknowledgedDeviceIds ?? []).filter(
        (id) => !acknowledgedDeviceIds.includes(id)
      );
      const fullyAcknowledged = sameDeviceSet(acknowledgedDeviceIds, state.deviceIds);
      await this.vault.putDeviceListState(userId, {
        ...state,
        // only claim the version when the whole current set is acknowledged
        acknowledgedVersion: fullyAcknowledged ? state.version : state.acknowledgedVersion,
        // acknowledging these devices also acknowledges the account key that
        // vouches for them — that is what makes future cross-signed devices
        // trustworthy without another prompt (the D8 payoff)
        acknowledgedMasterKey: fullyAcknowledged
          ? (state.masterKey ?? null)
          : (state.acknowledgedMasterKey ?? null),
        acknowledgedDeviceIds,
        unacknowledgedDeviceIds: stillUnacknowledged,
      });
    }
  }

  /**
   * Accept a peer's changed device identity: re-pin every device, drop the dead
   * pairwise sessions and force a group-session re-key (their old session key
   * may have gone to a device we no longer trust).
   */
  async acceptNewIdentity(peerUserId: string): Promise<void> {
    return this.enqueue(async () => {
      const res = await this.api.get(`/e2e/devices/${peerUserId}`);
      const data = res.data.data as {
        devices?: E2EDeviceEntry[];
        listVersion?: number;
        masterKey?: string | null;
        masterSignature?: string | null;
        crossSigning?: boolean;
      };
      if (data.crossSigning === true) this.crossSigningSeen = true;
      const entries = data.devices ?? [];
      if (entries.length === 0) throw new Error('peer has no E2E device');

      // Re-pin the ACCOUNT master key too (spec §14): a changed master key is
      // exactly what this recovery path exists for, and leaving the old pin
      // would make every subsequent fetch throw again. Unverified — the account
      // safety number changed, so any earlier comparison is void.
      const master = this.verifiedMasterKey(peerUserId, data.masterKey, data.masterSignature);
      if (master) {
        await this.vault.putMasterIdentity(peerUserId, { masterKey: master, verified: false });
      }

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
      // Refresh before acknowledging: the stored cross-signing state is what
      // decides which devices an acknowledgement may clear (D8), and it was
      // recorded under the identity we just replaced.
      try {
        await this.fetchDeviceList(peerUserId, true);
      } catch (err) {
        console.warn(`e2e: could not re-read the device list of ${peerUserId} after acceptance:`, errText(err));
      }
      await this.acknowledgeDeviceListUnqueued(peerUserId);
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
  /**
   * Olm-decrypt a device-approval payload from one of OUR devices straight into
   * a master key. Mirrors olmDecryptFromDevice, but the plaintext (which holds
   * the account private key) never crosses into JS.
   */
  private async olmDecryptMasterSecret(
    senderDeviceId: string,
    envelope: E2EOlmEnvelope,
    expectedMasterKey: string
  ): Promise<EngineMasterKey | null> {
    const identity = await this.vault.getIdentity(this.userId, senderDeviceId);
    if (!identity) return null;
    const account = this.requireAccount();
    const session = await this.loadOlmSession(this.userId, senderDeviceId);

    if (envelope.t === 0) {
      if (session && prekey_message_session_id(envelope.b) === session.sessionId()) {
        const master = session.decryptMasterSecret(envelope.t, envelope.b, expectedMasterKey);
        await this.persistOlmSession(this.userId, senderDeviceId, session);
        return master;
      }
      const inbound = account.createInboundSessionForMasterSecret(
        identity.curve25519Key,
        envelope.b,
        expectedMasterKey
      );
      const fresh = inbound.takeSession();
      const master = inbound.takeMasterKey();
      session?.free();
      this.olmSessions.set(shareKey(this.userId, senderDeviceId), fresh);
      await this.persistOlmSession(this.userId, senderDeviceId, fresh);
      await this.persistAccount(); // the used one-time key was consumed
      return master;
    }

    if (!session) return null;
    const master = session.decryptMasterSecret(envelope.t, envelope.b, expectedMasterKey);
    await this.persistOlmSession(this.userId, senderDeviceId, session);
    return master;
  }

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
      } catch (err) {
        // Expected while probing: a pre-key body only decrypts under the one
        // device session it was created for. Logged at debug volume so a real
        // fault (e.g. a corrupt pickle) is still visible.
        console.debug(`e2e: share probe against / failed:`, errText(err));
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
    meta: {
      sessionId: string;
      conversationId: string;
      senderUserId: string;
      senderDeviceId: string;
      keyType?: 'session' | 'exported';
    }
  ): Promise<boolean> {
    const existing = await this.loadInbound(meta.sessionId);
    if (existing) return false; // already imported (shares may be re-delivered)
    // A re-shared key arrives as an EXPORTED key (the sender no longer holds
    // the original in the clear); both forms yield the same session id.
    const session =
      meta.keyType === 'exported'
        ? EngineInboundGroupSession.fromExportedSessionKey(sessionKey)
        : EngineInboundGroupSession.fromSessionKey(sessionKey);
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
    if (fingerprints[peerUserId] !== deviceSetFingerprint(peer.devices)) return true;
    if (fingerprints[this.userId] !== deviceSetFingerprint(own.devices)) return true;
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
    if (record.pendingShareFailures.length === 0) return;
    if (Date.now() - (record.lastShareAttemptAt ?? 0) < SHARE_RETRY_BACKOFF_MS) return;
    if ((record.shareRetryCount ?? 0) >= MAX_SHARE_RETRIES) return;

    // Re-derive the index-0 key from our OWN inbound copy of this session,
    // which lives in the vault as an encrypted pickle. Keeping the raw key in
    // the record would leave Megolm key material readable in IndexedDB without
    // the OS-keychain pickle key (spec §7.3).
    const own = await this.loadInbound(record.sessionId);
    if (!own) {
      console.warn(`e2e: no local copy of session ${record.sessionId} — cannot retry key shares`);
      return;
    }
    const exportedKey = own.session.exportAtFirstKnownIndex();

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
      sessionKey: exportedKey,
      keyType: 'exported',
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    record.pendingShareFailures = stillPending;
    record.shareRetryCount = stillPending.length > 0 ? (record.shareRetryCount ?? 0) + 1 : 0;
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
        [peerUserId]: deviceSetFingerprint(peer.devices),
        [this.userId]: deviceSetFingerprint(own.devices),
      },
      pendingShareFailures: pending,
      shareRetryCount: 0,
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
    // BOTH lists are fetched fresh. Stale peer data would keep feeding session
    // keys to a revoked device; stale OWN data silently skips the fanout to a
    // device the user just added, leaving those messages permanently
    // unreadable there (caught by the live multi-device test). In-flight
    // coalescing collapses concurrent sends into one request, and e2eStatus is
    // budgeted (300/min) for two reads per message.
    const [peer, own] = await Promise.all([
      this.fetchDeviceList(peerUserId, true),
      this.fetchDeviceList(this.userId, true),
    ]);
    // Every device of the peer failed signature verification (or they revoked
    // them all): encrypting anyway would produce ciphertext nobody can read,
    // while the UI reported the message as sent.
    if (peer.devices.length === 0) {
      // Nothing published at all: a normal state for an account that has not
      // opened the app yet. If they DID publish devices and none survived
      // verification, that is a different and much less reassuring story, and
      // it keeps its own error rather than being reported as "not set up".
      if (peer.servedDeviceCount === 0) throw new E2EPeerNotReadyError(peerUserId);
      throw new Error(`no usable E2E device for ${peerUserId}`);
    }

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
      let imported = 0;
      // Drain every page: the inbox is oldest-first and capped per response, so
      // stopping at one page would let queued older shares delay a live one.
      for (let page = 0; page < MAX_CLAIM_PAGES; page++) {
        const res = await this.api.get(`/e2e/keyshares?deviceId=${encodeURIComponent(this.deviceId)}`);
        const shares = (res.data.data as { shares?: unknown[] }).shares;
        if (!Array.isArray(shares) || shares.length === 0) break;
        for (const share of shares) {
          try {
            if (await this.importKeyShare(share as Record<string, unknown>)) imported++;
          } catch (err) {
            console.warn('e2e: discarding an unusable key share:', errText(err));
          }
        }
        if (shares.length < E2E_LIMITS.KEYSHARE_CLAIM_MAX) break;
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
      keyType: payload.keyType === 'exported' ? 'exported' : 'session',
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
    const data = res.data.data as {
      devices?: E2EDeviceEntry[];
      listVersion?: number;
      masterKey?: string | null;
      masterSignature?: string | null;
      crossSigning?: boolean;
    };
    if (data.crossSigning === true) this.crossSigningSeen = true;
    // Verified locally, never taken on the server's word: an "approved" badge
    // must mean a signature this client checked (§14).
    // Judge against the pinned account key, never one served in this response:
    // this list is exactly where the user decides whether to revoke a device.
    const served = this.verifiedMasterKey(this.userId, data.masterKey, data.masterSignature);
    const pinnedMaster = await this.vault.getMasterIdentity(this.userId);
    const masterKey = pinnedMaster?.masterKey ?? served;
    // Same rollout grace as fetchDeviceList, and for the same reason: if these
    // two disagreed about what "cross-signed" means, the device manager would
    // show every device as unsigned while the badge stayed green — and that
    // disagreement lands on the reset-identity affordance.
    const rolloutGrace = data.crossSigning !== true && !this.crossSigningSeen;
    const priorCrossSigned = new Set(
      rolloutGrace ? ((await this.vault.getDeviceListState(this.userId))?.crossSignedDeviceIds ?? []) : []
    );
    return {
      currentDeviceId: this.deviceId,
      devices: (data.devices ?? []).map((entry) => ({
        ...entry,
        crossSigned: rolloutGrace
          ? priorCrossSigned.has(entry.deviceId)
          : this.hasValidCrossSignature(this.userId, entry, masterKey),
      })),
      listVersion: data.listVersion ?? 0,
      masterKey,
      canApprove: this.canApproveDevices(),
      capabilityServed: data.crossSigning === true,
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

      // Revoking IS the user dealing with the device: drop it from the sticky
      // unacknowledged set, or the warning would keep firing for a device that
      // no longer exists.
      const state = await this.vault.getDeviceListState(this.userId);
      if (state) {
        await this.vault.putDeviceListState(this.userId, {
          ...state,
          deviceIds: state.deviceIds.filter((id) => id !== deviceId),
          // device ids are client-chosen and reusable: leaving a revoked id in
          // the acknowledged set would silently bless a re-registration of it
          acknowledgedDeviceIds: state.acknowledgedDeviceIds.filter((id) => id !== deviceId),
          // …and out of the cross-signed set, which the rollout grace uses IN
          // PLACE OF checking a signature. Left behind, a re-registered device
          // id would be reported signed without one ever being verified.
          crossSignedDeviceIds: (state.crossSignedDeviceIds ?? []).filter((id) => id !== deviceId),
          unacknowledgedDeviceIds: (state.unacknowledgedDeviceIds ?? []).filter((id) => id !== deviceId),
        });
      }
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
        crossSigned: false, // unknown offline — the list is what carries proof
      }));
    }
    return devices.map((device) => ({
      deviceId: device.deviceId,
      crossSigned: device.crossSigned,
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

  /**
   * The ACCOUNT-level safety number (spec §14, D3) — the primary UX. One
   * 60-digit number per peer, derived from both master keys, stable across
   * every device either side adds as long as the account keys do not change.
   * Null when either account has not bootstrapped cross-signing.
   */
  async accountSafetyNumber(peerUserId: string): Promise<E2EAccountSafetyNumber | null> {
    const own = await this.ownMasterKey();
    if (!own) return null;
    try {
      await this.fetchDeviceList(peerUserId);
    } catch (err) {
      if (err instanceof E2EIdentityChangedError) throw err;
      // fall back to the pin: an offline client must still show the number
      console.warn(`e2e: falling back to the pinned master key of ${peerUserId}:`, errText(err));
    }
    const pinned = await this.vault.getMasterIdentity(peerUserId);
    if (!pinned) return null;
    return {
      digits: master_safety_number(this.userId, own, peerUserId, pinned.masterKey),
      verified: pinned.verified,
    };
  }

  /** Has the peer's ACCOUNT key been compared out of band (D9)? */
  async isAccountVerified(peerUserId: string): Promise<boolean> {
    return (await this.vault.getMasterIdentity(peerUserId))?.verified ?? false;
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

  /**
   * The user compared a peer's number out of band (D9). This now marks the
   * ACCOUNT master key verified — every cross-signed device inherits it,
   * including ones the peer adds later. Devices pinned today are still marked
   * individually so accounts without a master key (D11) keep working.
   */
  async markIdentityVerified(peerUserId: string): Promise<void> {
    const master = await this.vault.getMasterIdentity(peerUserId);
    if (master && !master.verified) {
      await this.vault.putMasterIdentity(peerUserId, { ...master, verified: true });
    }
    // Comparing the account number says "this master key is really theirs" —
    // nothing more. Devices the key vouches for inherit that at read time
    // (fetchDeviceList ORs crossSigned && masterVerified), so the only devices
    // to stamp here are the ones an account key cannot speak for: peers who
    // have no master key at all (D11, the pre-cross-signing behaviour). Marking
    // the rest would put "Verified" on precisely the device the account key
    // refuses to sign — the one thing this feature exists to expose.
    const state = await this.vault.getDeviceListState(peerUserId);
    const accountHasMasterKey = !!(master?.masterKey ?? state?.masterKey);
    if (!accountHasMasterKey) {
      const pinned = await this.vault.listIdentities(peerUserId);
      for (const { deviceId, identity } of pinned) {
        if (identity.verified) continue;
        await this.vault.putIdentity(peerUserId, deviceId, { ...identity, verified: true });
      }
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
