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
  E2E_ROW_ID_RE,
  E2E_SIGNATURE_B64_RE,
  e2eDeviceCanonical,
  e2eDeviceCrossCanonical,
  e2eKeyCanonical,
  e2eMasterCanonical,
  parseE2EEnvelope,
  buildE2EEnvelope,
  buildMegolmEnvelope,
  parseE2EPlaintext,
  e2eChannelScope,
  parseE2EScope,
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
  E2EVaultClosedError,
  type DeviceListState,
  type HistoryPullMarker,
  type InboundGroupSessionRecord,
  type MessagePosition,
  type OutboundGroupSessionRecord,
  type PendingKeyShare,
  type PickleKeyProvider,
  type PinnedIdentity,
  vaultDbName,
} from './vault';
import { pinSecure, securePinGeneration } from '../../utils/securePins';
import { currentE2ESessionUser, isE2ESessionEnded } from './session';

interface OneTimeKeyPair {
  keyId: string;
  key: string;
}

export interface DecryptResult {
  text: string;
  failed?: boolean;
}

/** Where a message sits in its group session's ratchet. */
export type E2EMessagePosition = MessagePosition;

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

/** Wire shape of one user's device-list payload (per-user GET and channel batch). */
interface E2EDeviceListPayload {
  devices?: E2EDeviceEntry[];
  listVersion?: number;
  masterKey?: string | null;
  masterSignature?: string | null;
  crossSigning?: boolean;
}

/**
 * A secure channel's member set with every member's VERIFIED device list —
 * the authoritative input for channel-session rotation decisions.
 */
export interface E2EChannelDeviceLists {
  members: Array<{ userId: string; isCreator: boolean }>;
  lists: Map<string, E2EPinnedDeviceList>;
  /** Members whose published devices all failed verification (not "no devices"). */
  unverifiableUserIds: string[];
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
 * A key share that cannot be imported NOW: its sender's device is not pinned
 * and their list cannot be read (signed out, offline, refused). The share is
 * kept in the vault and retried, never discarded and never acknowledged —
 * nothing about the share itself is wrong, and the server may already have
 * deleted it (a server from before leases) or will hand it out again.
 */
class E2EShareDeferredError extends Error {
  constructor(
    message: string,
    /**
     * The server refused the look-up outright (403/404): the only answer that
     * counts toward MAX_PENDING_SHARE_ATTEMPTS. Signed out, rate limited,
     * offline or disposed say nothing about the sender and are never counted.
     */
    readonly definitive = false
  ) {
    super(message);
    this.name = 'E2EShareDeferredError';
  }
}

/**
 * The browser's storage failed a write (a full disk, a storage error): says
 * nothing about the data being written. Not E2EVaultClosedError, which a
 * dispose causes and callers check for first.
 */
function isStorageFailure(err: unknown): boolean {
  return typeof DOMException !== 'undefined' && err instanceof DOMException;
}

/** A 403 or 404 from the server: an answer about the request, not about the connection. */
function isDefinitiveRefusal(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return status === 403 || status === 404;
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

/**
 * The service was disposed (logout, account switch, account deletion) while
 * this work was waiting. Its engine handles are freed and its vault is closed,
 * so the work stops here rather than touching either.
 */
export class E2EServiceDisposedError extends Error {
  constructor() {
    super('E2E service disposed');
    this.name = 'E2EServiceDisposedError';
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
  /** Test hook: how long dispose() waits for a key-share claim in flight (ms). */
  teardownDeadlineMs?: number;
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
/**
 * Hard stop for the message-key history pull (guards a hostile server's
 * endless cursor): as many pages as the server holds for one account, plus
 * two. The server checks its cap before it inserts, without a lock, so two
 * devices backing up at once can leave an account a little over it, and
 * those last rows would otherwise never be read.
 */
const MAX_RESTORE_PAGES = Math.ceil(E2E_LIMITS.MESSAGE_KEY_STORE_CAP / E2E_LIMITS.MESSAGE_KEY_PAGE_MAX) + 2;
/**
 * A kept key share whose sender's look-up the server has refused (403/404) in
 * this many starts is dropped: its sender rotates on a later send, and a share
 * that can never be checked must not be kept forever. A failure that says
 * nothing about the sender (signed out, rate limited, offline) is not counted,
 * and a start counts at most once however many claim runs it makes.
 */
const MAX_PENDING_SHARE_ATTEMPTS = 5;
/** How long a dispose waits for a key-share claim in flight before tearing down anyway. */
const TEARDOWN_DEADLINE_MS = 10_000;

const noop = (): void => {};

/**
 * Teardowns still to run, by vault database name: a disposed service whose
 * key-share claim holds its teardown back may still write that vault (what
 * the claim imports, the account pickle among it). A service for the same
 * account opens the vault only after that teardown, which the teardown
 * deadline bounds. Otherwise a sign-in back to the same account within that
 * window loads the account, the old service saves the one its claim
 * advanced, and the new one's next save brings back the one-time key the
 * claim used.
 */
const pendingTeardowns = new Map<string, Promise<void>>();

/**
 * Late raw pages written so far, by vault database name: a torn-down service
 * whose claim was answered after the teardown deadline writes that page beside
 * whatever newer service now uses the vault. A newer service's kept-share
 * index (keptShares) is unknown again once this moved past the count it was
 * filled at, so its next device-sealed decrypt lists the vault again.
 */
const lateShareWrites = new Map<string, number>();

/**
 * Vault key of a claimed key share: its creation time first, so a listing
 * returns shares oldest first (the order their Olm messages were sent in).
 */
function pendingShareKey(share: Record<string, unknown>): string {
  const createdAt = typeof share.createdAt === 'string' ? share.createdAt : '';
  const id = typeof share.id === 'string' ? share.id : generateDeviceId();
  return `pks:${createdAt}|${id}`;
}

/**
 * A claimed page as vault entries. Tolerant by necessity: a server from before
 * leases deleted the page when it answered, so one malformed element (logged
 * and skipped) must not cost the others, and an answer without a page is an
 * empty one. `served` is what the server sent, malformed elements included.
 * An answer that names its lease (`leaseMs`) came from a leasing claim: its
 * shares stay on the server until this device acknowledges them (spec §12.3).
 */
function claimedPageEntries(res: unknown): {
  served: number;
  entries: Array<{ key: string; record: PendingKeyShare }>;
} {
  const data = (res as { data?: { data?: { shares?: unknown; leaseMs?: unknown } } } | null)?.data?.data;
  const shares = data?.shares;
  const leased = typeof data?.leaseMs === 'number';
  const page: unknown[] = Array.isArray(shares) ? shares : [];
  const receivedAt = Date.now();
  const entries: Array<{ key: string; record: PendingKeyShare }> = [];
  for (const element of page) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      console.warn('e2e: skipping a malformed key share in a claimed page');
      continue;
    }
    const share = element as Record<string, unknown>;
    const record: PendingKeyShare = leased ? { share, attempts: 0, receivedAt, leased } : { share, attempts: 0, receivedAt };
    entries.push({ key: pendingShareKey(share), record });
  }
  return { served: page.length, entries };
}

/**
 * The id a kept share is acknowledged by: only one a leasing claim handed out
 * (a server from before leases deleted the rest when it answered), and only an
 * id of the shape the server takes back, since one malformed id refuses the
 * whole acknowledgement.
 */
function shareAckId(record: PendingKeyShare): string | null {
  const id = record.share.id;
  return record.leased === true && typeof id === 'string' && E2E_ROW_ID_RE.test(id) ? id : null;
}

/** The sender device a kept share names, as `userId|deviceId` (fields as the inbox served them). */
function keptShareSender(record: PendingKeyShare): string {
  const { senderUserId, senderDeviceId } = record.share;
  return `${typeof senderUserId === 'string' ? senderUserId : ''}|${typeof senderDeviceId === 'string' ? senderDeviceId : ''}`;
}

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
 * A stored device-list state that records no device (now, acknowledged, or
 * outstanding) and no account key. Earlier builds wrote one on the first look
 * at a user who had published nothing yet; it carries nothing to compare a
 * later list against.
 */
function holdsNoIdentity(state: DeviceListState): boolean {
  return (
    state.deviceIds.length === 0 &&
    state.acknowledgedDeviceIds.length === 0 &&
    (state.unacknowledgedDeviceIds ?? []).length === 0 &&
    !state.masterKey &&
    !state.acknowledgedMasterKey
  );
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
  /** The unguarded client: only for the key-share claim's GET (see claimKeyShares). */
  private readonly client: typeof defaultApi;
  /**
   * The vault itself: for the serial queue, start-up, and the key-share claim.
   * Work off the queue goes through liveVault instead.
   */
  private readonly vault: E2EVault;
  /** The vault as work off the queue reaches it: refused once dispose() ran (see guardedVault). */
  private readonly liveVault: E2EVault;
  /** The account's secure-pin generation when this service began (securePinGeneration). */
  private readonly pinGeneration: number;
  /** The vault's database name: the key of pendingTeardowns. */
  private readonly vaultName: string;
  /** This service's deferred teardown, while a claim holds it back (see dispose()). */
  private teardownDone: Promise<void> | null = null;
  private readonly wasmInput?: BufferSource;
  private readonly deviceListCacheMs: number;
  private readonly teardownDeadlineMs: number;

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
  /**
   * Sessions displaced by establishment glare, same keying. When both sides
   * create outbound sessions simultaneously (a DM call's offer glare does this
   * every time), each side's prekey message replaces the other's active
   * session — WITHOUT this slot both directions go deaf on every follow-up
   * message (invalid MAC). Each side keeps sending on its own session and
   * decrypts the peer's chain through the fallback.
   */
  private olmFallbackSessions = new Map<string, EngineSession>();
  /** outbound group sessions, keyed by conversationId */
  private outbound = new Map<string, { session: EngineGroupSession; record: OutboundGroupSessionRecord }>();
  /** inbound group sessions, keyed by megolm session id */
  private inbound = new Map<string, { session: EngineInboundGroupSession; record: InboundGroupSessionRecord }>();
  private deviceListCache = new Map<string, { at: number; list: E2EPinnedDeviceList }>();
  private deviceListInFlight = new Map<string, Promise<E2EPinnedDeviceList>>();

  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  /** The run of initialize() in progress: concurrent callers share it. */
  private initInFlight: Promise<void> | null = null;
  /** Set by dispose(), never cleared: a disposed service is not restarted. */
  private disposed = false;
  /**
   * Set once the engine objects are freed and the vault is closed. Usually at
   * dispose(); later when a key-share claim is in flight (see dispose()).
   */
  private tornDown = false;
  private claimInFlight: Promise<number> | null = null;
  /** A claim's GET is on its way: a teardown keeps one vault connection for its answer. */
  private claimPageInFlight = false;
  /** session id → last time we drained the inbox looking for it */
  private missingSessions = new Map<string, number>();
  /** Kept shares whose refused look-up was already counted in this start (see processPendingShares). */
  private deferralsCounted = new Set<string>();
  /**
   * The key shares the vault keeps (`pks:`), in memory: each one's vault key
   * and its sender device (`userId|deviceId`), so a device-sealed decrypt
   * from a device with none costs no vault read (importKeptSharesFrom). Null
   * until a listing of the vault fills it, refilled by every listing, and kept
   * in step by every write and delete of a kept share, all on the queue. It
   * may still name a share that is gone, never miss one that is kept: a page
   * an earlier service on this vault writes late, raw, after this one listed
   * (dispose()), makes the index unknown again (lateShareWrites).
   */
  private keptShares: Map<string, string> | null = null;
  /**
   * Ids of the key shares this device is done with whose acknowledgement the
   * server has not confirmed (spec §12.3): the vault's `pka:` entries, read
   * back at the start of every claim run, which sends them before it claims.
   */
  private shareAcksOwed = new Set<string>();
  /** The latest history pull started (pullHistory): an older one stops at its next page. */
  private historyPull = 0;
  /** lateShareWrites of this vault when keptShares was last filled. */
  private keptSharesLateWrites = 0;
  private deviceListListeners = new Set<(userId: string) => void>();

  constructor(
    private readonly userId: string,
    opts: E2EServiceOptions = {}
  ) {
    this.client = opts.api ?? defaultApi;
    this.api = this.guardedApi(this.client);
    this.vaultName = vaultDbName(userId, opts.vaultNamespace);
    // an account deleted later: what this service still imports pins nothing for it
    this.pinGeneration = securePinGeneration(userId);
    this.vault = new E2EVault(userId, opts.keyProvider, opts.vaultNamespace, () => {
      // an earlier service's teardown on this vault, never this one's own
      const pending = pendingTeardowns.get(this.vaultName);
      return pending && pending !== this.teardownDone ? pending : undefined;
    });
    this.liveVault = this.guardedVault(this.vault);
    this.wasmInput = opts.wasmInput;
    this.deviceListCacheMs = opts.deviceListCacheMs ?? DEVICE_LIST_CACHE_MS;
    this.teardownDeadlineMs = opts.teardownDeadlineMs ?? TEARDOWN_DEADLINE_MS;
  }

  /**
   * Every request this service makes, checked against dispose() on both sides
   * of its await: none goes out once dispose() ran, and an answer that comes
   * back after it is dropped. Together with the vault (which fails any access
   * after it was closed) and liveVault, this is the liveness check after each
   * await of every task: work that was waiting on the network when the service
   * was disposed stops there, before it touches a freed engine object or
   * writes anything.
   *
   * The one request that may still be answered after a dispose is a key-share
   * claim's GET, already on its way (its answer holds session keys this
   * device has not stored yet): it uses the unguarded client (claimKeyShares).
   * Everything else the claim would ask the server afterwards, such as the
   * look-up of a sender it does not know or the acknowledgement of what it
   * imported, is refused here: logout has dropped the tokens by then, and the
   * client attaches whatever bearer is current, which after a new sign-in is
   * the next account's. The share it was for is kept, and the acknowledgement
   * owed, for the next start.
   */
  private guardedApi(client: typeof defaultApi): typeof defaultApi {
    const guard = async <R>(call: () => Promise<R>): Promise<R> => {
      this.assertLive();
      const res = await call();
      this.assertLive();
      return res;
    };
    const guarded = {
      get: (...args: Parameters<typeof client.get>) => guard(() => client.get(...args)),
      put: (...args: Parameters<typeof client.put>) => guard(() => client.put(...args)),
      post: (...args: Parameters<typeof client.post>) => guard(() => client.post(...args)),
      delete: (...args: Parameters<typeof client.delete>) => guard(() => client.delete(...args)),
    };
    // Only these four verbs are used here; the cast keeps the client's type.
    return guarded as unknown as typeof defaultApi;
  }

  /**
   * The vault, checked against dispose() on both sides of every call, like the
   * guarded client: for every path that does not run on the serial queue (the
   * UI's reads and marks, the device-list fetch, the cache reads in front of a
   * decrypt).
   *
   * The vault refuses everything once it is closed, but a key-share claim in
   * flight holds that back until the claim is done (dispose()). Until then the
   * claim may still store and import the page it holds, through `vault`, and
   * nothing else may read or write: the queue starts nothing for a disposed
   * service and the claim is the only task still running on it, and every
   * other path reaches the vault through here.
   */
  private guardedVault(vault: E2EVault): E2EVault {
    return new Proxy(vault, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          this.assertLive();
          const result: unknown = (value as (...callArgs: unknown[]) => unknown).apply(target, args);
          if (!(result instanceof Promise)) return result;
          return result.then((resolved: unknown) => {
            this.assertLive();
            return resolved;
          });
        };
      },
    });
  }

  /** Serialize all crypto-state mutations (ratchet advance ⇒ pickle persist). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      // Queued before a dispose, started after it: refused, whether or not the
      // teardown has freed what it would touch yet (a claim can hold it back)
      this.assertLive();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Throw if dispose() ran. Called after every await on the start-up path and
   * at the start of every entry point that does not run on the queue: the
   * engine objects held across that await may have been freed meanwhile, and
   * the next step would publish keys for a session that has ended, or read
   * and write a vault that only the claim in flight may still use.
   */
  private assertLive(): void {
    if (this.disposed) throw new E2EServiceDisposedError();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Single-flight: every caller gets the same run. Two runs over an empty
   * vault would each mint a device id and an account and register both, and
   * the second registration replaces the identity the first one published.
   * A failed run clears the slot, so the next call tries again.
   */
  initialize(): Promise<void> {
    // disposed first: until the teardown runs (a claim can hold it back) the
    // service still reads as initialized
    if (this.disposed) return Promise.reject(new E2EServiceDisposedError());
    if (this.initialized) return Promise.resolve();
    if (!this.initInFlight) {
      this.initInFlight = this.initializeOnce()
        .catch((err: unknown) => {
          // Whatever stopped a run that a dispose overtook (a closed vault, a
          // refused request), the caller is told it was the dispose; what it
          // actually was is logged, since that is the only place it survives.
          if (this.disposed && !(err instanceof E2EServiceDisposedError)) {
            console.warn('e2e: initialization stopped after a dispose:', errText(err));
            throw new E2EServiceDisposedError();
          }
          throw err;
        })
        .finally(() => {
          this.initInFlight = null;
        });
    }
    return this.initInFlight;
  }

  private async initializeOnce(): Promise<void> {
    await initEngine(this.wasmInput);
    this.assertLive();
    // A dispose during open() closes the vault, and open() then drops the
    // connection it was making and throws (E2EVaultClosedError).
    await this.vault.open();
    this.assertLive();

    let deviceId = await this.vault.getDeviceId();
    this.assertLive();
    if (!deviceId || !E2E_DEVICE_ID_RE.test(deviceId)) {
      deviceId = generateDeviceId();
      await this.vault.putDeviceId(deviceId);
      this.assertLive();
    }
    this.myDeviceId = deviceId;

    const pickle = await this.vault.getAccountPickle();
    this.assertLive();
    // A retry after a failed run: that run's account is replaced below, and a
    // replaced wrapper still holds its engine memory until it is freed.
    this.account?.free();
    this.account = null;
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
    this.assertLive();

    await this.ensureRegistered();
    this.assertLive();
    // Cross-signing bootstrap (spec §14, D5). Never fatal: a device that cannot
    // publish or hold a master key still encrypts — it is only "unsigned".
    // A dispose is not a bootstrap failure, though: swallowing it here would
    // mark a disposed service initialized.
    try {
      await this.bootstrapMasterKey();
    } catch (err) {
      if (err instanceof E2EServiceDisposedError) throw err;
      console.warn('e2e: cross-signing bootstrap failed — this device stays unsigned:', errText(err));
    }
    this.assertLive();
    this.initialized = true;

    // None of these may block the UI: key shares are re-claimed lazily on a
    // decrypt miss, replenishment only matters for future peers, and the master
    // secret only arrives once another device approves this one.
    this.enqueue(() => this.claimKeyShares()).catch((err) => {
      this.logStartupTaskFailure('initial key-share claim', err);
    });
    this.claimMasterTransfers().catch((err) => {
      this.logStartupTaskFailure('initial master-transfer claim', err);
    });
    this.replenishOneTimeKeys().catch((err) => {
      this.logStartupTaskFailure('one-time key replenishment', err);
    });
    // Catch up on sessions that arrived while this device was offline. Best
    // effort by design: history backup falling behind must never stop the
    // client working, and the next launch tries again.
    this.backupMessageKeys().catch((err) => {
      this.logStartupTaskFailure('message-key backup pass', err);
    });
    // A history pull an earlier start left unfinished goes on where it stopped.
    this.resumeHistoryPull().catch((err) => {
      this.logStartupTaskFailure('history pull resume', err);
    });
  }

  /** A start-up task a dispose stopped ended on purpose: not a warning. */
  private logStartupTaskFailure(task: string, err: unknown): void {
    if (this.disposed && isE2ESessionEnded(err)) {
      console.debug(`e2e: ${task} stopped by a dispose`);
      return;
    }
    console.warn(`e2e: ${task} failed:`, errText(err));
  }

  /**
   * End this service: no new work starts, no request goes out, and the engine
   * objects are freed and the vault closed.
   *
   * Except while a key-share claim is in flight. A claim answered after this
   * point holds session keys this device has not stored: the server keeps
   * them under a lease until they are acknowledged, but hands them out again
   * only once it passes, and a server from before leases deleted them when it
   * answered. The teardown then waits for the claim to import them, or to
   * keep the ones it cannot (pks:, see claimKeyShares), where the next start
   * of this account finds them; the claim reads no further page and asks the
   * server nothing more, its acknowledgements included (they stay owed in the
   * vault, and the next start sends them before it claims).
   * Until the teardown, that claim is the only thing that touches the vault:
   * in this service the queue starts nothing, a decrypt that waited on the
   * claim stops there, and every path off the queue is refused by the guarded
   * client and liveVault from this call on; a new service for the same
   * account (a sign-in back) opens the vault only after the teardown
   * (pendingTeardowns). The one write that can still come later is a page
   * answered after the deadline, raw, of kept shares only.
   *
   * Resolves once the teardown has run.
   */
  dispose(): Promise<void> {
    // First, so work resuming after this point sees it before any freed handle
    this.disposed = true;
    if (this.teardownDone) return this.teardownDone;
    const claim = this.claimInFlight;
    if (!claim) {
      this.teardownLogged();
      return Promise.resolve();
    }
    // the claim may use the open connection, never a new one
    this.vault.stopReopening();
    // Bounded: a request can hang (the client sets no timeout). At the
    // deadline the teardown runs anyway, and what the claim had not imported
    // stays kept in the vault for the next start.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.teardownDeadlineMs);
    });
    const done = Promise.race([claim.then(noop, noop), deadline]).then(() => {
      clearTimeout(timer);
      this.teardownLogged();
    });
    // A service for the same account opens this vault only after it (pendingTeardowns)
    this.teardownDone = done;
    pendingTeardowns.set(this.vaultName, done);
    void done.then(() => {
      if (pendingTeardowns.get(this.vaultName) === done) pendingTeardowns.delete(this.vaultName);
    });
    return done;
  }

  /**
   * teardown(), logging a failure: dispose() runs from logout and account
   * switches, which must not fail on it, and the deferred path has nobody
   * awaiting it to report one.
   */
  private teardownLogged(): void {
    try {
      this.teardown();
    } catch (err) {
      console.error('e2e: teardown failed after dispose:', errText(err));
    }
  }

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.account?.free();
    this.account = null;
    this.masterKey?.free();
    this.masterKey = null;
    for (const session of this.olmSessions.values()) session.free();
    this.olmSessions.clear();
    for (const session of this.olmFallbackSessions.values()) session.free();
    this.olmFallbackSessions.clear();
    for (const { session } of this.outbound.values()) session.free();
    this.outbound.clear();
    for (const { session } of this.inbound.values()) session.free();
    this.inbound.clear();
    this.deviceListCache.clear();
    // A claim's answer still on its way holds shares this device has not
    // stored: one connection stays open for writing that page, raw, and
    // nothing else (claimKeyShares). A version change closes it at once.
    if (this.claimPageInFlight) this.vault.closeKeepingConnectionForPendingShares();
    else this.vault.close();
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

  private async persistOlmFallbackSession(userId: string, deviceId: string, session: EngineSession): Promise<void> {
    await this.vault.putFallbackSessionPickle(userId, deviceId, session.pickle(this.vault.pickleKey()));
  }

  /** The glare-displaced session for a device, if any (see olmFallbackSessions). */
  private async loadOlmFallbackSession(userId: string, deviceId: string): Promise<EngineSession | null> {
    const key = shareKey(userId, deviceId);
    const cached = this.olmFallbackSessions.get(key);
    if (cached) return cached;
    const pickle = await this.vault.getFallbackSessionPickle(userId, deviceId);
    if (!pickle) return null;
    let session: EngineSession;
    try {
      session = EngineSession.fromPickle(pickle, this.vault.pickleKey());
    } catch (err) {
      console.warn(`e2e: fallback session pickle for ${key} unreadable — discarding:`, errText(err));
      await this.vault.deleteFallbackSession(userId, deviceId);
      return null;
    }
    this.olmFallbackSessions.set(key, session);
    return session;
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
    // `account` is held across the awaits below; assertLive() after each one is
    // what keeps a dispose landing meanwhile from reaching a freed handle.
    const account = this.requireAccount();
    const res = await this.api.get(`/e2e/devices/me?deviceId=${encodeURIComponent(this.deviceId)}`);
    this.assertLive();
    const status = res.data.data as { registered: boolean; deviceId?: string; curve25519Key?: string };

    if (status.registered && status.deviceId === this.deviceId && status.curve25519Key === account.curve25519Key()) {
      // The slot holds this identity, so the upload that registered it landed.
      // Keys the account still lists as unpublished come from an upload cut
      // short after it was sent (this registration's, or a replenish batch).
      // The server reports how many keys it holds, not which, but marking them
      // is right either way: a key the server has is published, and one it
      // never received can simply never be claimed. Left unmarked, they would
      // ride along with the next replenish batch, past OTK_UPLOAD_MAX.
      if ((account.oneTimeKeys() as OneTimeKeyPair[]).length > 0) {
        account.markKeysAsPublished();
        await this.persistAccount();
        this.assertLive();
      }
      return;
    }

    // Reuse unpublished keys if a previous registration attempt failed mid-way,
    // never more than one upload may carry (the server refuses the whole batch)
    let otks = account.oneTimeKeys() as OneTimeKeyPair[];
    if (otks.length < E2E_LIMITS.OTK_TARGET) {
      account.generateOneTimeKeys(E2E_LIMITS.OTK_TARGET - otks.length);
      otks = account.oneTimeKeys() as OneTimeKeyPair[];
    }
    otks = otks.slice(0, E2E_LIMITS.OTK_UPLOAD_MAX);
    let fallback = account.fallbackKey() as OneTimeKeyPair | null;
    if (!fallback) {
      account.generateFallbackKey();
      fallback = account.fallbackKey() as OneTimeKeyPair | null;
      if (!fallback) throw new Error('failed to generate fallback key');
    }
    await this.persistAccount();
    this.assertLive();

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
    // Disposed during the upload: the keys are on the server, but the account
    // that would mark them published is freed, so the pickle saved above still
    // lists them as unpublished. The next start finds the slot registered with
    // this identity and marks them there (the early return above).
    this.assertLive();

    // Marks every unpublished key, the ones past the cap included: those were
    // never sent, so no peer can claim them, and replenishment tops the pool
    // up from the count the server reports.
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

      // A batch whose upload failed is still in the account, unpublished, and
      // goes out with this one: generate only what it does not already cover,
      // and never send more than one upload may carry, or the server refuses
      // the batch on every attempt and the pool drains to the fallback key.
      const wanted = Math.min(E2E_LIMITS.OTK_TARGET - count, E2E_LIMITS.OTK_UPLOAD_MAX);
      const pending = (account.oneTimeKeys() as OneTimeKeyPair[]).length;
      if (pending < wanted) account.generateOneTimeKeys(wanted - pending);
      const fresh = (account.oneTimeKeys() as OneTimeKeyPair[]).slice(0, E2E_LIMITS.OTK_UPLOAD_MAX);
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
    // Runs inside initialize(): every await below is followed by assertLive()
    // before the next handle use or write, like the rest of start-up.
    const sealed = await this.vault.getMasterSecret();
    this.assertLive();
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
    this.assertLive();
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
    this.assertLive();

    // ── A. We hold the secret: it is the account key, full stop. ──
    if (this.masterKey) {
      const mine = this.masterKey.publicKey();
      if (pinned?.masterKey !== mine) {
        await this.vault.putMasterIdentity(this.userId, { masterKey: mine, verified: true });
        this.assertLive();
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
    this.assertLive();
    await this.publishMasterKey(master, [own]);
    // Published, then disposed: the sealed copy above makes the next start
    // take path A with this same key, so nothing is lost by stopping here.
    this.assertLive();
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
    const imported = await this.enqueue(() => this.claimMasterTransfersUnqueued());
    if (imported) {
      // Linking is the PRIMARY way a device joins an account, so it has to pull
      // history the same way recovery does. Without this, message-key backup
      // only ever worked for someone who had lost every device — the rarer
      // path — and a freshly linked one showed empty conversations. After the
      // queued part: the pull takes the queue one page at a time.
      try {
        await this.restoreMessageKeys();
      } catch (err) {
        console.warn('e2e: linked device has the account key but not its history yet:', errText(err));
      }
    }
    return imported;
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
    await this.notePullDue(master);
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
      await this.notePullDue(master);
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
    // next start goes on from where the pull stopped (resumeHistoryPull).
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
    this.assertLive();
    // The check runs off the queue and costs two reads; this runs at every
    // start, and nothing pending is the common case, which must not hold up
    // the first send or decrypt behind it.
    if (!this.masterKey) return 0;
    if ((await this.sessionsPendingBackup()).length === 0) return 0;
    // The pass itself is on the queue: it holds the master key across vault
    // reads and uploads, and the queue is what keeps a dispose, or a
    // master-key replacement (restore, reset, transfer), from freeing that key
    // under it.
    return this.enqueue(() => this.backupMessageKeysUnqueued());
  }

  /** Session records not uploaded yet: two reads (one transaction each), through liveVault for the check off the queue. */
  private async sessionsPendingBackup(): Promise<InboundGroupSessionRecord[]> {
    const [records, uploaded] = await Promise.all([
      this.liveVault.listInboundGroupSessions(),
      this.liveVault.getBackedUpSessionIds(),
    ]);
    const done = new Set(uploaded);
    return records.filter((r) => !done.has(r.sessionId));
  }

  private async backupMessageKeysUnqueued(): Promise<number> {
    const master = this.masterKey;
    if (!master) return 0; // only a device holding the account key can seal

    // read again on the queue: what the check saw may have changed meanwhile
    const pending = await this.sessionsPendingBackup();
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
   *
   * One page per step of the serial queue. Each step holds the account key
   * across its request and its imports, and the queue keeps a master-key
   * replacement (only another restore: a reset keeps a key the device holds)
   * or a dispose from freeing that key under it; between two steps the queue
   * serves whatever else waits (a send, a decrypt, a call signal), so a long
   * history does not hold them up. A step that finds the key replaced since
   * the pull began stops the pull: the replacement brought its own
   * (restoreKeyBackup), and the old key opens nothing the account publishes
   * any more.
   *
   * A pull that does not reach its end (the app closed, a dispose, a failed
   * request) resumes at the next start where it stopped (resumeHistoryPull):
   * before each page request the vault records the account key it reads
   * under, that page's cursor and the number of page requests made so far,
   * this one included (`history_pull`); the record is dropped at the end. The
   * count carries across starts, so MAX_RESTORE_PAGES bounds every request
   * the pull makes, however many starts it spans and whatever fails: once it
   * is reached the record is dropped and the pull stops for good. A newer
   * pull supersedes a running one: it reads the history from its own start,
   * and owns that record from then on.
   */
  async restoreMessageKeys(): Promise<number> {
    return this.pullHistory(null);
  }

  /** restoreMessageKeys, from the start or (resume) from where an earlier pull stopped. */
  private async pullHistory(resume: HistoryPullMarker | null): Promise<number> {
    const pull = ++this.historyPull;
    let master: EngineMasterKey | null = null;
    let cursor: string | null = resume?.cursor ?? null;
    // page requests this pull has made, across starts: the cap bounds them all
    let requested = resume && Number.isInteger(resume.pages) && resume.pages > 0 ? resume.pages : 0;
    let imported = 0;
    for (let first = true; ; first = false) {
      const step = await this.enqueue(async () => {
        if (pull !== this.historyPull) return null; // a newer pull reads it all
        if (first) {
          master = this.masterKey;
          if (resume && master?.publicKey() !== resume.masterKey) {
            // left by a pull under another account key: nothing this one reads
            await this.vault.deleteHistoryPull();
            return null;
          }
        } else if (this.masterKey !== master) {
          console.debug('e2e: the account key was replaced during the history pull; the pull stops here');
          return null;
        }
        const key = master;
        if (!key) throw new Error('This device does not hold the account key');
        if (requested >= MAX_RESTORE_PAGES) {
          console.warn(`e2e: the history pull asked for ${MAX_RESTORE_PAGES} pages without reaching the end; it stops for good`);
          await this.vault.deleteHistoryPull();
          return null;
        }
        // Counted before it is sent: a page that fails, or a start that ends
        // here, leaves this page for the next start to ask for once more, and
        // no start or failure takes the pull past the cap.
        await this.vault.putHistoryPull({ masterKey: key.publicKey(), cursor, pages: requested + 1 });
        requested += 1;
        const result = await this.restoreMessageKeyPage(key, cursor);
        if (!result.next) await this.vault.deleteHistoryPull();
        return result;
      });
      if (!step) return imported; // superseded, the key replaced, or the cap reached
      imported += step.imported;
      cursor = step.next;
      if (!cursor) return imported;
    }
  }

  /**
   * Record a history pull from the start as due under a key just sealed on
   * this device (a restore, an incoming transfer), in the step that installs
   * it: the pull itself starts after that step, and an app closed in between
   * would otherwise leave that key's history unread for good. Best effort:
   * the pull writes the record again before its first page.
   */
  private async notePullDue(master: EngineMasterKey): Promise<void> {
    try {
      await this.vault.putHistoryPull({ masterKey: master.publicKey(), cursor: null, pages: 0 });
    } catch (err) {
      if (isE2ESessionEnded(err)) throw err;
      console.warn('e2e: could not note the history pull of a new account key:', errText(err));
    }
  }

  /**
   * Go on with a history pull an earlier start of this account left
   * unfinished, from its next page, if this device still holds the account
   * key it read under (pullHistory drops the record otherwise).
   */
  private async resumeHistoryPull(): Promise<void> {
    const before = this.historyPull;
    const marker = await this.enqueue(() => this.vault.getHistoryPull());
    // a pull started while the record was read reads from its own start: it is the newer one
    if (!marker || this.historyPull !== before) return;
    await this.pullHistory(marker);
  }

  /** One page of restoreMessageKeys. Callers must hold the serial queue. */
  private async restoreMessageKeyPage(
    master: EngineMasterKey,
    cursor: string | null
  ): Promise<{ imported: number; next: string | null }> {
    let imported = 0;
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
        // the session ended (a dispose closed the vault): not a bad row, and the rest would fail alike
        if (isE2ESessionEnded(err)) throw err;
        // One unreadable row must not abandon the rest of someone's history.
        console.warn(`e2e: skipping an unusable backed-up session key:`, errText(err));
      }
    }
    return { imported, next: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null };
  }

  /** Our own account master key (held or pinned), for safety numbers. */
  private async ownMasterKey(): Promise<string | null> {
    if (this.masterKey) return this.masterKey.publicKey();
    const pinned = await this.liveVault.getMasterIdentity(this.userId);
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
   *
   * Through liveVault: the device-list fetch that calls it runs off the queue
   * (the bundle claim calls it on the queue, where that changes nothing).
   */
  private async pinDevice(
    userId: string,
    entry: { deviceId: string; curve25519Key: string; ed25519Key: string }
  ): Promise<PinnedIdentity> {
    const pinned = await this.liveVault.getIdentity(userId, entry.deviceId);
    if (pinned) {
      if (pinned.curve25519Key !== entry.curve25519Key || pinned.ed25519Key !== entry.ed25519Key) {
        throw new E2EIdentityChangedError(userId);
      }
      return pinned;
    }
    // Carry the verified flag over from the pre-multi-device pin when the keys
    // are literally the same account (the device just gained an id).
    const legacy = await this.liveVault.getLegacyIdentity(userId);
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
    await this.liveVault.putIdentity(userId, entry.deviceId, fresh);
    return fresh;
  }

  /**
   * Fetch a user's published device list, verifying EVERY device's binding
   * signature (v2 canonical, D4) before it can be used. Devices with a broken
   * signature are dropped, never trusted — the server is untrusted storage.
   *
   * Refused once the service is disposed, cached answer included; so is the
   * whole path behind it (the request, the pinning, the recorded state). That
   * holds for a key-share claim still finishing after a dispose too: the
   * sender it cannot look up any more keeps its share for the next start.
   */
  async fetchDeviceList(
    userId: string,
    freshness: boolean | number = false
  ): Promise<E2EPinnedDeviceList> {
    this.assertLive();
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
    return this.processDeviceListPayload(userId, res.data.data as E2EDeviceListPayload);
  }

  /**
   * Verify, pin and cache ONE user's device-list payload. Single source of
   * truth for device trust: the per-user GET and the secure-channel batch
   * endpoint both feed their responses through here, so a channel member's
   * devices get exactly the verification a DM peer's would. Reads and writes
   * through liveVault: both are fetched off the queue.
   */
  private async processDeviceListPayload(
    userId: string,
    data: E2EDeviceListPayload
  ): Promise<E2EPinnedDeviceList> {
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
    const priorState = rolloutGrace ? await this.liveVault.getDeviceListState(userId) : null;
    const priorCrossSigned = new Set(priorState?.crossSignedDeviceIds ?? []);
    const served = crossSigningServed
      ? this.verifiedMasterKey(userId, data.masterKey, data.masterSignature)
      : null;
    const pinnedMaster = await this.liveVault.getMasterIdentity(userId);
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
      await this.liveVault.putMasterIdentity(userId, { masterKey: served, verified: false });
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

  /**
   * Fetch a secure channel's member set + every member's device list in ONE
   * request, then run each payload through the exact per-user verification
   * path (processDeviceListPayload). The response is the AUTHORITATIVE member
   * list for rotation — socket events are UI hints, never the trigger.
   *
   * An E2EIdentityChangedError for any member propagates and blocks the send,
   * exactly like the DM path: sending anyway would either leak to keys the
   * user has not accepted or silently exclude a member.
   */
  async fetchChannelDeviceLists(channelId: string): Promise<E2EChannelDeviceLists> {
    const res = await this.api.get(`/e2e/channels/${encodeURIComponent(channelId)}/devices`);
    const data = res.data.data as {
      members?: Array<{ userId?: unknown; isCreator?: unknown }>;
      deviceLists?: Array<E2EDeviceListPayload & { userId?: unknown }>;
    };
    const members = (data.members ?? [])
      .filter((m): m is { userId: string; isCreator: boolean } => typeof m?.userId === 'string')
      .map((m) => ({ userId: m.userId, isCreator: m.isCreator === true }));

    const payloadByUser = new Map<string, E2EDeviceListPayload>();
    for (const entry of data.deviceLists ?? []) {
      if (typeof entry?.userId === 'string') payloadByUser.set(entry.userId, entry);
    }

    const lists = new Map<string, E2EPinnedDeviceList>();
    const unverifiableUserIds: string[] = [];
    for (const member of members) {
      const payload = payloadByUser.get(member.userId) ?? { devices: [], listVersion: 0 };
      const list = await this.processDeviceListPayload(member.userId, payload);
      lists.set(member.userId, list);
      if (list.devices.length === 0 && list.servedDeviceCount > 0) {
        // Published devices exist but none survived verification — a directory
        // problem, not an un-onboarded member (see servedDeviceCount docs)
        unverifiableUserIds.push(member.userId);
      }
    }
    return { members, lists, unverifiableUserIds };
  }

  private async recordDeviceListState(userId: string, list: E2EPinnedDeviceList): Promise<void> {
    const deviceIds = list.devices.map((d) => d.deviceId);
    const crossSigned = new Set(list.devices.filter((d) => d.crossSigned).map((d) => d.deviceId));
    const stored = await this.liveVault.getDeviceListState(userId);
    // A list that names no device and no account key names no identity: it is
    // what the server answers for someone who has not started the app yet.
    // Trust on first use pins the first identity SEEN (spec §4.4), so neither
    // such an answer nor a stored state built from one can be the baseline —
    // otherwise the peer's first device would read as one added since.
    const state = stored && !holdsNoIdentity(stored) ? stored : undefined;
    if (!state) {
      if (deviceIds.length === 0 && !list.masterKey) return;
      // First sight of this user's devices: nothing to warn about yet (TOFU).
      await this.liveVault.putDeviceListState(userId, {
        version: list.listVersion,
        deviceIds,
        acknowledgedVersion: list.listVersion,
        acknowledgedDeviceIds: deviceIds,
        masterKey: list.masterKey,
        acknowledgedMasterKey: list.masterKey,
        crossSignedDeviceIds: [...crossSigned],
      });
      // Nothing is NEW, but the status is not empty: a device the account key
      // does not vouch for is unsigned from the first look, and for our own
      // list that includes this very device before anyone approved it. The
      // first look is often the only event of a session, so it is announced.
      this.emitDeviceListChanged(userId);
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
    const pinnedMaster = await this.liveVault.getMasterIdentity(userId);
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
    await this.liveVault.putDeviceListState(userId, {
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
    const state = await this.liveVault.getDeviceListState(userId);
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

      this.dropOlmSessionsInMemory(peerUserId);
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
        // disposed meanwhile: go no further (the acknowledgement would write)
        if (isE2ESessionEnded(err)) throw err;
        console.warn(`e2e: could not re-read the device list of ${peerUserId} after acceptance:`, errText(err));
      }
      await this.acknowledgeDeviceListUnqueued(peerUserId);
      await this.clearOutboundGroupSessions();
    });
  }

  /** Drop every pairwise session with a user so the next share re-establishes. */
  async resetSession(peerUserId: string): Promise<void> {
    return this.enqueue(async () => {
      this.dropOlmSessionsInMemory(peerUserId);
      await this.vault.deleteSessionsForUser(peerUserId);
    });
  }

  /** Free + forget every in-memory pairwise session (active AND fallback) with a user. */
  private dropOlmSessionsInMemory(peerUserId: string): void {
    for (const map of [this.olmSessions, this.olmFallbackSessions]) {
      for (const [key, session] of map) {
        if (key.startsWith(`${peerUserId}|`)) {
          session.free();
          map.delete(key);
        }
      }
    }
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
    const staged = await this.olmDecryptStaged(userId, deviceId, envelope);
    if (!staged) return null;
    await staged.commit()();
    return staged.text;
  }

  /**
   * The Olm decrypt, made on a COPY of the state it would advance (the
   * session, or the account for a new inbound session), so the live state
   * moves past the message only once the caller commits it. `commit()`
   * repeats the decrypt on the live objects (the same state gives the same
   * result) and hands back the writes of what it advanced.
   *
   * A key share is committed once its group session is stored (importKeyShare).
   * Until then the live Olm state still holds the message's key, so a share
   * kept because that store failed loses nothing to whatever else this session
   * writes meanwhile: the account (another sender's pre-key share, a
   * replenishment) or this pairwise session (a reply, a call signal). Its
   * writes come after the group session's, so a run cut in between leaves the
   * old Olm state on disk, under which the same message decrypts again.
   */
  private async olmDecryptStaged(
    userId: string,
    deviceId: string,
    envelope: E2EOlmEnvelope
  ): Promise<{ text: string; commit: () => () => Promise<void> } | null> {
    const identity = await this.vault.getIdentity(userId, deviceId);
    if (!identity) return null;
    const key = shareKey(userId, deviceId);
    const session = await this.loadOlmSession(userId, deviceId);
    const pickleKey = this.vault.pickleKey();
    const decryptOnCopy = (live: EngineSession): string => {
      const copy = EngineSession.fromPickle(live.pickle(pickleKey), pickleKey);
      try {
        return copy.decrypt(envelope.t, envelope.b);
      } finally {
        copy.free();
      }
    };
    const liveObjects = () => {
      // committed right after an await of the caller's: never on what a teardown freed
      if (this.tornDown) throw new E2EServiceDisposedError();
    };
    /** A message one existing session decrypts: committing advances that session. */
    const onSession = (live: EngineSession, persist: () => Promise<void>) => ({
      text: decryptOnCopy(live),
      commit: () => {
        liveObjects();
        live.decrypt(envelope.t, envelope.b);
        return persist;
      },
    });

    if (envelope.t === 0) {
      // Pre-key message: either continues a session we know (active or
      // fallback), or establishes a new inbound session (bound to the pinned
      // identity — vodozemac rejects a mismatch).
      const incomingSessionId = prekey_message_session_id(envelope.b);
      if (session && incomingSessionId === session.sessionId()) {
        return onSession(session, () => this.persistOlmSession(userId, deviceId, session));
      }
      const fallback = await this.loadOlmFallbackSession(userId, deviceId);
      if (fallback && incomingSessionId === fallback.sessionId()) {
        return onSession(fallback, () => this.persistOlmFallbackSession(userId, deviceId, fallback));
      }
      // A new inbound session consumes a one-time key of the account: tried on
      // a copy of the account, then made for real on commit.
      const scratch = EngineAccount.fromPickle(this.requireAccount().pickle(pickleKey), pickleKey);
      let text: string;
      try {
        const probe = scratch.createInboundSession(identity.curve25519Key, envelope.b);
        text = probe.plaintext;
        probe.takeSession().free();
        probe.free();
      } finally {
        scratch.free();
      }
      return {
        text,
        commit: () => {
          liveObjects();
          const inbound = this.requireAccount().createInboundSession(identity.curve25519Key, envelope.b);
          const fresh = inbound.takeSession();
          inbound.free();
          const writes: Array<() => Promise<void>> = [];
          if (session) {
            // GLARE: our own outbound session crossed the peer's prekey message
            // in flight (both sides of a call establish simultaneously). DEMOTE
            // it instead of discarding — the peer keeps decrypting our sends
            // through their copy of it, and we decrypt theirs through this new
            // inbound. Discarding deafened BOTH directions on every call.
            fallback?.free();
            this.olmFallbackSessions.set(key, session);
            writes.push(() => this.persistOlmFallbackSession(userId, deviceId, session));
          }
          this.olmSessions.set(key, fresh);
          writes.push(() => this.persistOlmSession(userId, deviceId, fresh));
          writes.push(() => this.persistAccount()); // the used one-time key was consumed
          return async () => {
            for (const write of writes) await write();
          };
        },
      };
    }

    // Normal message: try the active session, then the glare fallback —
    // after crossed establishment each side sends on its own session.
    if (session) {
      try {
        return onSession(session, () => this.persistOlmSession(userId, deviceId, session));
      } catch (primaryErr) {
        const fallback = await this.loadOlmFallbackSession(userId, deviceId);
        if (!fallback) throw primaryErr;
        // both failing throws to the caller
        return onSession(fallback, () => this.persistOlmFallbackSession(userId, deviceId, fallback));
      }
    }
    const fallback = await this.loadOlmFallbackSession(userId, deviceId);
    if (!fallback) return null;
    return onSession(fallback, () => this.persistOlmFallbackSession(userId, deviceId, fallback));
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
        if (isE2ESessionEnded(err)) throw err;
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
    // Held in memory only once it is stored. A copy that lived only here
    // would read as "already imported" to the retry of the key share that
    // carried it, which would then drop the one copy the next start needs.
    try {
      await this.vault.putInboundGroupSession(meta.sessionId, record);
    } catch (err) {
      session.free();
      throw err;
    }
    this.inbound.set(meta.sessionId, { session, record });
    this.pinSecureScope(meta.conversationId);
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

  /**
   * Olm-encrypt one session key to each target device and upload the batch.
   * Returns the targets that must be retried, plus whether EVERY failure this
   * round was a rate limit (429) — a large first fanout can legitimately
   * overrun per-minute budgets, and those attempts say nothing about the
   * payload, so they must not consume the bounded retry budget.
   */
  private async deliverShares(
    targets: Array<{ userId: string; deviceId: string }>,
    payload: E2EKeySharePayload
  ): Promise<{ pending: string[]; onlyRateLimited: boolean }> {
    const isRateLimited = (err: unknown): boolean =>
      !!err && typeof err === 'object' &&
      (err as { response?: { status?: number } }).response?.status === 429;

    const body = JSON.stringify(payload);
    const pending: string[] = [];
    let hardFailures = 0;
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
        if (!isRateLimited(err)) hardFailures++;
      }
    }

    for (let i = 0; i < shares.length; i += E2E_LIMITS.KEYSHARE_BATCH_MAX) {
      const chunk = shares.slice(i, i + E2E_LIMITS.KEYSHARE_BATCH_MAX);
      try {
        await this.api.post('/e2e/keyshares', { deviceId: this.deviceId, shares: chunk });
        // Shares the server SKIPPED (a channel recipient removed between our
        // member fetch and the server's in-tx gate) are deliberately NOT
        // pending: the removal is authoritative, retrying can never succeed,
        // and a re-added member is covered by the member-set rotation.
      } catch (err) {
        console.warn('e2e: key-share upload failed — will retry on the next send:', errText(err));
        for (const s of chunk) pending.push(shareKey(s.recipientUserId, s.recipientDeviceId));
        if (!isRateLimited(err)) hardFailures++;
      }
    }
    return { pending, onlyRateLimited: pending.length > 0 && hardFailures === 0 };
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

    const { pending: stillPending, onlyRateLimited } = await this.deliverShares(targets, {
      v: 2,
      conversationId,
      sessionId: record.sessionId,
      sessionKey: exportedKey,
      keyType: 'exported',
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    record.pendingShareFailures = stillPending;
    // Rate-limited rounds do not consume the bounded budget: a 429 says
    // nothing about the target, and a large first fanout can take several
    // backoff windows to drain within per-minute limits.
    record.shareRetryCount =
      stillPending.length === 0 ? 0
      : onlyRateLimited ? (record.shareRetryCount ?? 0)
      : (record.shareRetryCount ?? 0) + 1;
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

    const { pending } = await this.deliverShares(targets, {
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

  // ─── Secure-channel group sessions (scope `ch:{channelId}`) ────────────────
  //
  // Same Megolm machinery as DMs, generalized from one peer to a member set.
  // The one NEW rotation trigger is a member-set change, and it is what makes
  // the product guarantees structural:
  //  - member REMOVED → the next send creates a session the removed member
  //    never receives (they keep at most the old session = messages they were
  //    already entitled to read);
  //  - member ADDED → the next send creates a fresh session, and the invitee
  //    never receives any earlier session key → no history, by construction.

  private needsChannelRotation(
    record: OutboundGroupSessionRecord,
    lists: Map<string, E2EPinnedDeviceList>
  ): boolean {
    const fingerprints = record.deviceListFingerprints ?? {};
    // Member-set compare: the fingerprint map's keys ARE the member set the
    // session was keyed for (every member gets an entry at rotation, even
    // device-less ones). Extra key or missing key → membership changed.
    const recordedMembers = Object.keys(fingerprints).sort();
    const currentMembers = [...lists.keys()].sort();
    if (
      recordedMembers.length !== currentMembers.length ||
      recordedMembers.some((id, i) => id !== currentMembers[i])
    ) {
      return true;
    }
    for (const [userId, list] of lists) {
      if (fingerprints[userId] !== deviceSetFingerprint(list.devices)) return true;
    }
    if (record.messageCount >= E2E_LIMITS.GROUP_SESSION_MAX_MESSAGES) return true;
    if (Date.now() - record.createdAt >= E2E_LIMITS.GROUP_SESSION_MAX_AGE_MS) return true;
    return false;
  }

  private async rotateChannelGroupSession(
    scope: string,
    lists: Map<string, E2EPinnedDeviceList>,
    previous: { session: EngineGroupSession; record: OutboundGroupSessionRecord } | null
  ): Promise<{ session: EngineGroupSession; record: OutboundGroupSessionRecord }> {
    const session = new EngineGroupSession();
    const sessionId = session.sessionId();
    // MUST be exported before the first encrypt so importers start at index 0
    const sessionKey = session.sessionKey();

    // Decrypt-to-self: this device never receives its own share.
    await this.importInboundGroupSession(sessionKey, {
      sessionId,
      conversationId: scope,
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    const targets: Array<{ userId: string; deviceId: string }> = [];
    const deviceListVersions: Record<string, number> = {};
    const deviceListFingerprints: Record<string, string> = {};
    for (const [userId, list] of lists) {
      deviceListVersions[userId] = list.listVersion;
      deviceListFingerprints[userId] = deviceSetFingerprint(list.devices);
      for (const d of list.devices) {
        if (userId === this.userId && d.deviceId === this.deviceId) continue;
        targets.push({ userId, deviceId: d.deviceId });
      }
    }

    const { pending } = await this.deliverShares(targets, {
      v: 2,
      conversationId: scope,
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
      deviceListVersions,
      deviceListFingerprints,
      pendingShareFailures: pending,
      shareRetryCount: 0,
      lastShareAttemptAt: Date.now(),
    };

    previous?.session.free();
    const entry = { session, record };
    this.outbound.set(scope, entry);
    await this.vault.putOutboundGroupSession(scope, record);
    return entry;
  }

  private async ensureChannelGroupSession(
    channelId: string
  ): Promise<{
    session: EngineGroupSession;
    record: OutboundGroupSessionRecord;
    notReadyUserIds: string[];
  }> {
    const scope = e2eChannelScope(channelId);
    // Authoritative, per-send: rotation-on-removal must never depend on a
    // socket event having been delivered.
    const { members, lists, unverifiableUserIds } = await this.fetchChannelDeviceLists(channelId);
    if (members.length === 0) throw new Error(`not a member of channel ${channelId}`);
    if (members.length > E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP) {
      throw new Error('channel exceeds the secure member cap');
    }
    if (unverifiableUserIds.length > 0) {
      // Same stance as the DM path's "no usable E2E device": a directory that
      // serves only unverifiable devices for a member is not a member who
      // hasn't onboarded, and quietly excluding them would hide it.
      throw new Error(`no usable E2E device for ${unverifiableUserIds.join(', ')}`);
    }

    // Members with NO published devices (never opened the app since E2E): the
    // room keeps working — they simply cannot read until they onboard, and the
    // UI surfaces who. (Blocking the whole channel on one dormant account
    // would let any invitee accidentally freeze the room.)
    const notReadyUserIds = members
      .map((m) => m.userId)
      .filter((id) => id !== this.userId && (lists.get(id)?.devices.length ?? 0) === 0);

    const current = await this.loadOutbound(scope);
    if (current && !this.needsChannelRotation(current.record, lists)) {
      await this.retryPendingShares(scope, current);
      return { ...current, notReadyUserIds };
    }
    const rotated = await this.rotateChannelGroupSession(scope, lists, current);
    return { ...rotated, notReadyUserIds };
  }

  private async clearOutboundGroupSessions(): Promise<void> {
    for (const { session } of this.outbound.values()) session.free();
    this.outbound.clear();
    await this.vault.deleteAllOutboundGroupSessions();
  }

  // ─── Key-share inbox ────────────────────────────────────────────────────────

  /**
   * Claim this device's pending key shares under a lease and import the group
   * sessions they carry (spec §12.3). Olm pre-key bodies are one-shot, so the
   * server hands a share to one claim at a time; it deletes one only when this
   * device acknowledges it (POST /e2e/keyshares/ack), and hands out again,
   * once its lease has passed, one that never was. A server from before
   * leases ignores the request for one and deletes what it hands out: its
   * answer carries no lease, and nothing of it is acknowledged.
   *
   * Every claimed page is written to the vault (`pks:`) before anything is
   * done with it, and each share leaves it only once it is imported, found
   * imported already, or found unusable, which is also when its
   * acknowledgement is owed (`pka:`): a run cut short (a logout, the teardown
   * deadline, a closed window) leaves the rest there, and the next run starts
   * with them. So does a share whose sender cannot be looked up right now (see
   * E2EShareDeferredError), up to MAX_PENDING_SHARE_ATTEMPTS runs, and one
   * whose session could not be stored (its Olm decrypt is not committed, see
   * olmDecryptStaged); neither is acknowledged meanwhile, so the server hands
   * it out again after its lease, and the run that gets it leaves the kept
   * copy as it is (notHeldYet). Acknowledgements go out once per page and once
   * before the first claim of a run (sendShareAcks), never after a dispose.
   *
   * A kept share is imported before any newer Olm message of its sender
   * device (importKeptSharesFrom), unless that import fails: the message is
   * then decrypted anyway. Known residual (docs/e2e-dm-spec.md §12.3): a share
   * still in the inbox has no such guard, and neither has one whose store or
   * import keeps failing. A call signal or a voice key of that device
   * decrypted ahead of it leaves its message only to vodozemac's skipped
   * message keys (40 per receiving chain, 5 chains per session), and past
   * those bounds it is discarded as unusable once claimed.
   *
   * Callers must already hold the serial queue (this mutates Olm state).
   */
  private async claimKeyShares(): Promise<number> {
    if (this.claimInFlight) return this.claimInFlight;
    // No disposal check of its own: every caller runs on the queue, which
    // starts nothing for a disposed service, and a closed vault fails first.
    const run = (async () => {
      // Senders whose shares wait in this run: a later share of theirs waits
      // behind, since it may ride the Olm session an earlier one sets up.
      const deferredSenders = new Set<string>();
      // What earlier runs and starts still owe the server, as the vault has it
      await this.loadShareAcks();
      // Kept shares first: they are older than anything still on the server.
      let imported = await this.processPendingShares(await this.listKeptShares(), deferredSenders);
      // Before the first claim: the server would hand out again what these are for
      await this.sendShareAcks();
      // Drain every page: the inbox is oldest-first and capped per response, so
      // stopping at one page would let queued older shares delay a live one.
      for (let page = 0; page < MAX_CLAIM_PAGES; page++) {
        // Disposed meanwhile: this page is imported (dispose() waits for it),
        // the next one stays on the server.
        if (this.disposed) break;
        // The unguarded client: an answer that comes back after the teardown
        // (the dispose deadline passed) still holds shares this device has not
        // stored, and must reach the vault rather than be thrown away.
        this.claimPageInFlight = true;
        const res = await this.client
          .get(`/e2e/keyshares?deviceId=${encodeURIComponent(this.deviceId)}&lease=1`)
          .catch((err: unknown) => {
            // no answer to write: the connection kept for one is not needed
            if (this.tornDown) this.vault.releaseLateConnection();
            throw err;
          })
          .finally(() => {
            this.claimPageInFlight = false;
          });
        if (this.tornDown) {
          // Torn down while the answer was on its way: write it raw on the
          // connection the teardown kept for it, for the next start, and stop.
          // The release covers the parsing too: a malformed answer must not
          // keep that connection open.
          try {
            await this.vault.writePendingSharesLate(this.notHeldYet(claimedPageEntries(res).entries));
          } finally {
            this.vault.releaseLateConnection();
            // a newer service on this vault has not listed these (lateShareWrites)
            lateShareWrites.set(this.vaultName, (lateShareWrites.get(this.vaultName) ?? 0) + 1);
          }
          throw new E2EServiceDisposedError();
        }
        // Written before anything else is done
        const { served, entries } = claimedPageEntries(res);
        if (served === 0) break;
        const fresh = this.notHeldYet(entries);
        await this.keepShares(fresh);
        imported += await this.processPendingShares(fresh, deferredSenders);
        // Not once disposed: the next start sends what this page settled
        await this.sendShareAcks();
        // the server's count, malformed elements included, decides whether more pages wait
        if (served < E2E_LIMITS.KEYSHARE_CLAIM_MAX) break;
      }
      return imported;
    })().finally(() => {
      this.claimInFlight = null;
    });
    this.claimInFlight = run;
    return run;
  }

  // Every read, write and delete of a kept share goes through these three, so
  // keptShares stays in step with the vault. All of them run on the queue.

  /** Every kept share, oldest first; refills keptShares from what the vault holds. */
  private async listKeptShares(): Promise<Array<{ key: string; record: PendingKeyShare }>> {
    // read before the listing: a late page landing during it moves the count again
    const lateWrites = lateShareWrites.get(this.vaultName) ?? 0;
    const kept = await this.vault.listPendingShares();
    this.keptShares = new Map(kept.map(({ key, record }) => [key, keptShareSender(record)]));
    this.keptSharesLateWrites = lateWrites;
    return kept;
  }

  /** Keep claimed shares (or rewrite kept ones); noted before the write, so a failed write only over-reports. */
  private async keepShares(entries: Array<{ key: string; record: PendingKeyShare }>): Promise<void> {
    for (const { key, record } of entries) this.keptShares?.set(key, keptShareSender(record));
    await this.vault.putPendingShares(entries);
  }

  /**
   * Drop one kept share this device is done with (imported, imported already,
   * unusable, or dropped at the attempt cap); forgotten only once the vault has
   * dropped it. One a leasing claim handed out is still on the server: its
   * acknowledgement is noted as owed first, so a run cut in between leaves
   * both and never neither (the next run settles the kept copy again).
   */
  private async forgetKeptShare(key: string, record: PendingKeyShare): Promise<void> {
    const ackId = shareAckId(record);
    if (ackId) {
      await this.vault.putShareAck(ackId);
      this.shareAcksOwed.add(ackId);
    }
    await this.vault.deletePendingShare(key);
    this.keptShares?.delete(key);
  }

  /**
   * The entries of a claimed page this device does not hold yet. A leasing
   * claim hands a share out again once its lease has passed, and two kinds of
   * share come back that way. One kept here unacknowledged (its sender could
   * not be checked yet, its session could not be stored) keeps the record it
   * has, its refused look-ups counted, and is left to the kept pass of a run,
   * which went through it at the start of this one: written again it would
   * start its count over, and the share would be kept forever. One this
   * device is done with but still owes the acknowledgement of is acknowledged
   * with the rest of the page, never processed again. Anything else that comes
   * back (an acknowledgement confirmed, a record lost) is processed, and
   * recognised there by its session if it was imported (processPendingShares).
   * A share whose kept copy a failed write left unwritten still has an entry
   * in keptShares until the next run lists the vault: it is skipped here,
   * unacknowledged, and comes back once more after its lease.
   */
  private notHeldYet(entries: Array<{ key: string; record: PendingKeyShare }>): Array<{ key: string; record: PendingKeyShare }> {
    return entries.filter(({ key, record }) => {
      if (this.keptShares?.has(key)) return false;
      const id = record.share.id;
      return !(typeof id === 'string' && this.shareAcksOwed.has(id));
    });
  }

  /**
   * Read back the acknowledgements owed (the vault is the record: what a run a
   * dispose cut short, or an earlier start, noted there is sent by this one).
   * One older than the server's retention is dropped unsent: the share it was
   * for has been swept.
   */
  private async loadShareAcks(): Promise<void> {
    const cutoff = Date.now() - E2E_LIMITS.KEYSHARE_MAX_AGE_MS;
    const owed = new Set<string>();
    const stale: string[] = [];
    for (const entry of await this.vault.listShareAcks()) {
      if (typeof entry?.id !== 'string') continue;
      if (typeof entry.at === 'number' && entry.at >= cutoff) owed.add(entry.id);
      else stale.push(entry.id);
    }
    this.shareAcksOwed = owed;
    if (stale.length > 0) await this.vault.deleteShareAcks(stale);
  }

  /**
   * Acknowledge the key shares this device is done with (spec §12.3), a page
   * of ids per request, so the server deletes them. Never once disposed: the
   * claim in flight asks the server nothing more, and the vault keeps them for
   * the next start. Never a failure of its own: an acknowledgement the server
   * did not confirm stays owed and goes out with the next claim run, before
   * its first claim. A confirmed id is done with whatever the server counted
   * for it (it may have gone already: acknowledged before, swept, evicted).
   */
  private async sendShareAcks(): Promise<void> {
    while (this.shareAcksOwed.size > 0 && !this.disposed) {
      const ids = [...this.shareAcksOwed].slice(0, E2E_LIMITS.KEYSHARE_ACK_MAX);
      try {
        await this.api.post('/e2e/keyshares/ack', { deviceId: this.deviceId, ids });
      } catch (err) {
        // a dispose that overtook it is not a failure to report
        if (!(this.disposed && isE2ESessionEnded(err))) {
          console.warn('e2e: could not acknowledge claimed key shares (sent again by the next claim):', errText(err));
        }
        return;
      }
      for (const id of ids) this.shareAcksOwed.delete(id);
      try {
        await this.vault.deleteShareAcks(ids);
      } catch (err) {
        if (isE2ESessionEnded(err)) return;
        // read back and sent again by the next run, which the server counts as nothing
        console.warn('e2e: could not forget acknowledged key shares:', errText(err));
      }
    }
  }

  /**
   * Import kept key shares in order, removing each one that is done with. One
   * whose session reached this device already is dropped without being
   * decrypted again: a share a leasing claim handed out again (its
   * acknowledgement was lost, so its Olm message is spent), a re-share, a
   * restored backup, or a kept copy a run cut short left behind.
   */
  private async processPendingShares(
    entries: Array<{ key: string; record: PendingKeyShare }>,
    deferredSenders: Set<string>
  ): Promise<number> {
    let imported = 0;
    for (const { key, record } of entries) {
      const { share } = record;
      const sender = typeof share.senderUserId === 'string' ? share.senderUserId : '';
      try {
        if (typeof share.sessionId === 'string' && (await this.loadInbound(share.sessionId))) {
          await this.forgetKeptShare(key, record);
          continue;
        }
        if (deferredSenders.has(sender)) {
          throw new E2EShareDeferredError(`an earlier share from ${sender} is still waiting`);
        }
        const outcome = await this.importKeyShare(share);
        if (outcome.imported) imported++;
        // The group session is stored and the decrypt committed: the kept
        // copy goes, and only then the Olm state its message advanced is
        // written. Cut before this point, the share is still kept and still
        // decrypts from the state on disk.
        await this.forgetKeptShare(key, record);
        try {
          await outcome.persistOlm();
        } catch (err) {
          if (this.tornDown || err instanceof E2EServiceDisposedError || err instanceof E2EVaultClosedError) throw err;
          console.warn('e2e: could not save the Olm state a key share advanced:', errText(err));
        }
      } catch (err) {
        if (err instanceof E2EShareDeferredError) {
          deferredSenders.add(sender);
          // Counted only for a refusal, and once per start of the service:
          // every decrypt miss starts a claim run, and a page of messages
          // under unknown sessions would otherwise spend all the attempts in
          // one burst of runs.
          if (!err.definitive || this.deferralsCounted.has(key)) continue; // kept as it is
          this.deferralsCounted.add(key);
          const attempts = record.attempts + 1;
          if (attempts >= MAX_PENDING_SHARE_ATTEMPTS) {
            console.warn(`e2e: dropping a key share after ${attempts} refused look-ups of its sender:`, errText(err));
            await this.forgetKeptShare(key, record);
          } else {
            await this.keepShares([{ key, record: { ...record, attempts } }]);
          }
          continue;
        }
        // The service went away under this run: what is left stays kept
        if (this.tornDown || err instanceof E2EServiceDisposedError || err instanceof E2EVaultClosedError) {
          throw err;
        }
        if (isStorageFailure(err)) {
          // Nothing wrong with the share, only with the disk. Its Olm decrypt
          // was not committed (importKeyShare), so it is kept as it is and
          // retried by the next claim, its sender's later shares behind it.
          deferredSenders.add(sender);
          console.warn('e2e: keeping a key share whose session could not be stored (retried by the next claim):', errText(err));
          continue;
        }
        console.warn('e2e: discarding an unusable key share:', errText(err));
        await this.forgetKeptShare(key, record);
      }
    }
    return imported;
  }

  private async importKeyShare(
    share: Record<string, unknown>
  ): Promise<{ imported: boolean; persistOlm: () => Promise<void> }> {
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
      try {
        await this.fetchDeviceList(senderUserId, true);
      } catch (err) {
        // A changed identity is a verdict on the sender; anything else (signed
        // out, offline, refused, disposed) only means "not now", and the share
        // is kept for a later run rather than lost.
        if (err instanceof E2EIdentityChangedError) throw err;
        throw new E2EShareDeferredError(
          `sender ${senderUserId} could not be looked up: ${errText(err)}`,
          isDefinitiveRefusal(err)
        );
      }
      identity = await this.vault.getIdentity(senderUserId, senderDeviceId);
    }
    if (!identity) throw new Error(`unknown sender device ${senderUserId}/${senderDeviceId}`);

    // Decrypted on a copy of the Olm state; the live state moves past the
    // message once the group session is stored, and is written by the caller
    // after the kept copy is removed (olmDecryptStaged)
    const staged = await this.olmDecryptStaged(senderUserId, senderDeviceId, envelope);
    if (staged === null) throw new Error('no Olm session for this key share');

    try {
      const payload = JSON.parse(staged.text) as E2EKeySharePayload;
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

      const imported = await this.importInboundGroupSession(payload.sessionKey, {
        keyType: payload.keyType === 'exported' ? 'exported' : 'session',
        sessionId,
        conversationId,
        senderUserId,
        senderDeviceId,
      });
      // stored: only now does the live Olm state move past this message
      return { imported, persistOlm: staged.commit() };
    } catch (err) {
      // An unusable share is discarded, so its message is consumed and the
      // Olm state it advanced saved now. A run cut short (the service went
      // away) or a storage failure commits nothing: the share stays kept, and
      // its message still decrypts, in this session as from the state on disk.
      const keptForLater =
        this.tornDown || err instanceof E2EServiceDisposedError || err instanceof E2EVaultClosedError || isStorageFailure(err);
      if (!keptForLater) await staged.commit()();
      throw err;
    }
  }

  // ─── Encrypt / decrypt ──────────────────────────────────────────────────────

  /**
   * Encrypt one DM under the conversation's group session, re-keying (and
   * re-sharing) first whenever a rotation trigger fired (D9).
   */
  async encryptMessage(
    conversationId: string,
    peerUserId: string,
    plaintext: string
  ): Promise<{ envelope: string; position: E2EMessagePosition }> {
    return this.enqueue(async () => {
      const { session, record } = await this.ensureGroupSession(conversationId, peerUserId);
      // Read BEFORE encrypt(), which advances the ratchet: this is the index a
      // receiver's decrypt reports. The send path binds it to the id the POST
      // returns (cachePlaintext) — our own sends are read from the cache, never
      // decrypted, so nothing else would stop a replay of our own old message.
      const messageIndex = session.messageIndex();
      const body = session.encrypt(plaintext);
      record.messageCount += 1;
      record.pickle = session.pickle(this.vault.pickleKey());
      await this.vault.putOutboundGroupSession(conversationId, record);
      return {
        envelope: buildMegolmEnvelope(record.sessionId, body),
        position: { sessionId: record.sessionId, messageIndex },
      };
    });
  }

  /**
   * Encrypt one secure-channel message. `notReadyUserIds` lists members with
   * no published E2E device (they cannot read until they onboard) so the UI
   * can say who, instead of the room failing or lying.
   */
  async encryptChannelMessage(
    channelId: string,
    plaintext: string
  ): Promise<{ envelope: string; position: E2EMessagePosition; notReadyUserIds: string[] }> {
    return this.enqueue(async () => {
      const scope = e2eChannelScope(channelId);
      const { session, record, notReadyUserIds } = await this.ensureChannelGroupSession(channelId);
      // before encrypt(): see encryptMessage
      const messageIndex = session.messageIndex();
      const body = session.encrypt(plaintext);
      record.messageCount += 1;
      record.pickle = session.pickle(this.vault.pickleKey());
      await this.vault.putOutboundGroupSession(scope, record);
      return {
        envelope: buildMegolmEnvelope(record.sessionId, body),
        position: { sessionId: record.sessionId, messageIndex },
        notReadyUserIds,
      };
    });
  }

  // ─── Device-sealed payloads (call signaling, spec §20) ─────────────────────

  /**
   * Olm-encrypt an arbitrary payload to ONE specific device and return the
   * olm1 envelope string. The session establishment path verifies the
   * device's binding signature and TOFU-pins its identity, so this throws
   * E2EIdentityChangedError on a pin mismatch and E2EPeerNotReadyError when
   * the peer has published nothing — callers abort, never degrade.
   */
  async encryptToDevice(userId: string, deviceId: string, plaintext: string): Promise<string> {
    return this.enqueue(async () => {
      const olm = await this.ensureOlmSession(userId, deviceId);
      const { messageType, body } = olm.encrypt(plaintext) as { messageType: 0 | 1; body: string };
      await this.persistOlmSession(userId, deviceId, olm);
      return buildE2EEnvelope(messageType, body);
    });
  }

  /**
   * Decrypt an olm1 envelope that MUST come from one specific device. Returns
   * null on any failure (bad envelope, wrong device, tampered ciphertext,
   * replay) — the sender-device binding is what makes a server-substituted
   * payload fail instead of silently succeeding.
   *
   * The one exception to null: an unknown sender device whose fetch reveals a
   * PIN MISMATCH throws E2EIdentityChangedError — that is "the person you are
   * talking to changed", which callers must surface, never swallow as a
   * dropped packet.
   */
  async decryptFromDevice(userId: string, deviceId: string, envelopeStr: string): Promise<string | null> {
    const envelope = parseE2EEnvelope(envelopeStr);
    if (!envelope || envelope.e !== E2E_ENGINE_OLM1) return null;
    // First contact with this sender device: verify + TOFU-pin its identity
    // via the device list (importKeyShare pattern) — inbound pre-key sessions
    // bind to the PINNED curve25519 key, so an unpinned device cannot decrypt.
    // Off the queue, hence liveVault.
    if (!(await this.liveVault.getIdentity(userId, deviceId))) {
      await this.fetchDeviceList(userId, true);
    }
    return this.enqueue(async () => {
      try {
        // older messages of this device first (see importKeptSharesFrom)
        try {
          await this.importKeptSharesFrom(userId, deviceId);
        } catch (err) {
          if (isE2ESessionEnded(err)) throw err;
          // The shares stay kept for the next claim; the message given here
          // is decrypted anyway (a dropped call signal stalls the call).
          console.warn(
            `e2e: could not import the kept key shares of ${userId}/${deviceId} before its message:`,
            errText(err)
          );
        }
        return await this.olmDecryptFromDevice(userId, deviceId, envelope as E2EOlmEnvelope);
      } catch (err) {
        console.warn(`e2e: device-sealed decrypt from ${userId}/${deviceId} failed:`, errText(err));
        return null;
      }
    });
  }

  /**
   * Import the key shares of one sender device still kept from a claim (its
   * look-up failed then), oldest first, before a newer Olm message of that
   * device is decrypted. They ride the same pairwise session, and the socket
   * brings a call's signals or a voice key ahead of them: decrypted first,
   * those would leave a kept share's message only to vodozemac's skipped
   * message keys, whose receiving chains a few turns of a call push out
   * (spec §12.3). The device is pinned by now (decryptFromDevice), so this
   * asks the server nothing, not even the acknowledgement of what it imports:
   * that is owed, and the next claim run sends it before it claims, never a
   * request on the way to a call signal. Callers must hold the serial queue.
   */
  private async importKeptSharesFrom(userId: string, deviceId: string): Promise<void> {
    const sender = `${userId}|${deviceId}`;
    // nothing kept from this device: no vault read on the way to every call signal
    // (an index an earlier service's late page outdated counts as unknown)
    const index = this.keptShares;
    const current = this.keptSharesLateWrites === (lateShareWrites.get(this.vaultName) ?? 0);
    if (index && current && ![...index.values()].includes(sender)) return;
    const kept = (await this.listKeptShares()).filter(({ record }) => keptShareSender(record) === sender);
    if (kept.length > 0) await this.processPendingShares(kept, new Set());
  }

  /**
   * Cache plaintext under the server-assigned message id (spec §7.2). With a
   * `position` (an own send or edit, from encryptMessage/encryptChannelMessage)
   * the ratchet position is bound to this id + version as well: own messages
   * are read from this cache and never decrypted, so nothing else would bind
   * them, and the server could re-serve our own old ciphertext under a new id.
   */
  async cachePlaintext(
    messageId: string,
    conversationId: string,
    text: string,
    editedAt?: string | null,
    meta?: { authorId?: string; createdAt?: string; position?: E2EMessagePosition }
  ): Promise<void> {
    const version = editedAt ?? null;
    const position = meta?.position;
    // Serialised with the decrypt path: the socket echo of this very message
    // can be mid-decrypt, and its position check must see either none of this
    // write or all of it — half of it reads as an older version of itself.
    return this.enqueue(async () => {
      if (position) {
        const bound = await this.vault.getMessagePosition(position.sessionId, position.messageIndex);
        // The socket echo may have been decrypted (and bound) before the POST
        // answered: the same binding, left as it is.
        if (!bound || bound.messageId !== messageId || bound.editedAt !== version) {
          if (bound) {
            // A position produced moments ago already names another message: the
            // server showed our ciphertext under two ids. Our own POST/PATCH
            // answer is the send-time truth.
            console.warn(
              `e2e: own message ${messageId} rebinds a ratchet position the server showed as ${bound.messageId}`
            );
          }
          await this.vault.putMessagePosition(position.sessionId, position.messageIndex, {
            messageId,
            editedAt: version,
          });
        }
      }
      await this.vault.putPlaintext(messageId, {
        conversationId,
        text,
        editedAt: version,
        ...(meta?.authorId && { authorId: meta.authorId }),
        ...(meta?.createdAt && { createdAt: meta.createdAt }),
        ...(position && { sessionId: position.sessionId, messageIndex: position.messageIndex }),
      });
    });
  }

  /**
   * Whether a plaintext-cache entry may answer for a message id the SERVER
   * named. The entry answers only for the scope (conversation id, or
   * `ch:{channelId}`) it was decrypted under and, when it recorded one, for
   * the author who wrote it — otherwise a server that relabels an authentic
   * message's author, or moves its id into another container, would have the
   * cache vouch for the forgery that the ratchet's own bindings
   * (decryptGroupMessage) refuse. `editedAt` given requires that exact version
   * (edits produce new ciphertext under the same id); omitted, any version
   * answers (e.g. reply previews).
   */
  private cacheEntryAnswers(
    cached: { conversationId: string; authorId?: string; editedAt?: string | null },
    expected: { scope: string; authorId?: string; editedAt?: string | null },
  ): boolean {
    if (cached.conversationId !== expected.scope) return false;
    if (expected.authorId !== undefined && cached.authorId !== undefined && cached.authorId !== expected.authorId) return false;
    if (expected.editedAt !== undefined && (cached.editedAt ?? null) !== (expected.editedAt ?? null)) return false;
    return true;
  }

  /** Read cached plaintext for a message id the SERVER named (see cacheEntryAnswers). */
  async getCachedPlaintext(
    messageId: string,
    expected: { scope: string; authorId?: string; editedAt?: string | null },
  ): Promise<string | null> {
    const cached = await this.liveVault.getPlaintext(messageId);
    if (!cached || cached.failed) return null;
    return this.cacheEntryAnswers(cached, expected) ? cached.text : null;
  }

  /**
   * Decrypt an encrypted DM. The plaintext cache is consulted first: Megolm is
   * re-decryptable so this is only an optimization there, but it is the ONLY
   * way to read legacy olm1 history (one-shot ratchet keys). Failures return a
   * marker instead of throwing so one bad message can't break the timeline.
   * The end of the session is not a failure of the message: a dispose before
   * or during the decrypt rejects (E2EServiceDisposedError, or
   * E2EVaultClosedError from the vault), which the display gate settles as
   * nothing to show (decryptMessageForDisplay).
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
    // off the queue: liveVault
    const cached = await this.liveVault.getPlaintext(message.id);
    // Scope-checked: a cache entry only answers for the scope it was decrypted
    // under. Without this, a server that relabels a DM message id as a
    // secure-channel message (or vice versa) would have the cache serve the
    // plaintext into the wrong container — the ratchet's scope binding
    // (decryptGroupMessage) would refuse, but the cache must not bypass it.
    //
    // Author-checked too: the entry records who wrote it, and decryptGroupMessage
    // binds the session to its sender — a cache hit must not skip that binding
    // for a row whose author the server relabelled. Version-checked always: an
    // edit is a fresh ciphertext under the same id.
    if (cached && this.cacheEntryAnswers(cached, { scope: message.conversationId, authorId: message.authorId, editedAt: version })) {
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
        // olm1 (legacy pairwise) carries no ratchet position to bind
        const decrypted =
          envelope.e === E2E_ENGINE_MEGOLM1
            ? await this.decryptGroupMessage(message, envelope.sid, envelope.b)
            : { text: await this.olmDecryptFromUser(message.authorId, envelope), position: undefined };
        if (decrypted === null || decrypted.text === null) return { text: '', failed: true };
        const { text, position } = decrypted;

        await this.vault.putPlaintext(message.id, {
          conversationId: message.conversationId,
          text,
          editedAt: version,
          authorId: message.authorId,
          ...(message.createdAt && { createdAt: message.createdAt }),
          ...(position && { sessionId: position.sessionId, messageIndex: position.messageIndex }),
        });
        return { text };
      } catch (err) {
        // the session ended under this decrypt: said as such, never as a marker
        if (isE2ESessionEnded(err)) throw err;
        console.warn(`e2e: failed to decrypt message ${message.id}:`, errText(err));
        return { text: '', failed: true };
      }
    });
  }

  /**
   * A group session under a `ch:` scope is a member's device saying "this
   * channel is end-to-end encrypted" — the one signal about a secure channel
   * that does not come from the channel list. Pinned on this device
   * (utils/securePins.ts) so a later list that drops the flag cannot downgrade
   * the channel; for a new device this is the first-contact pin source.
   */
  private pinSecureScope(scope: string): void {
    const parsed = parseE2EScope(scope);
    // for this service's account: a claim finishing after a logout must not pin for the next one
    if (parsed.kind === 'channel') pinSecure(parsed.channelId, this.userId, this.pinGeneration);
  }

  /**
   * Decrypt one megolm1 body and bind its ratchet position. The session checks
   * say WHO wrote it and WHERE; the position binding says WHICH message it is.
   * Every refusal returns null, so the caller renders the same "unable to
   * decrypt" marker as for a failed decrypt.
   */
  private async decryptGroupMessage(
    message: { id: string; conversationId: string; authorId: string; editedAt?: string | null },
    sessionId: string,
    body: string
  ): Promise<{ text: string; position: E2EMessagePosition } | null> {
    let entry = await this.loadInbound(sessionId);
    if (!entry) {
      // The key share may still be sitting in this device's inbox. One drain
      // per unknown session (retried after SHARE_CLAIM_RETRY_MS) — a backlog of
      // undecryptable messages must not turn into a request storm.
      const lastAttempt = this.missingSessions.get(sessionId);
      if (lastAttempt === undefined || Date.now() - lastAttempt >= SHARE_CLAIM_RETRY_MS) {
        this.missingSessions.set(sessionId, Date.now());
        await this.claimKeyShares();
        // The claim may be the one a dispose was waiting for. What it stored
        // is the next start's; this decrypt goes no further, neither into the
        // vault (still open until the teardown, which runs as the claim
        // settles) nor into the engine objects that teardown frees.
        this.assertLive();
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
    // The scope is required, never "unscoped": a row served without one would
    // otherwise decrypt with any session its author ever shared, in whichever
    // conversation the server chose to show it.
    if (!message.conversationId || entry.record.conversationId !== message.conversationId) {
      console.warn(`e2e: message ${message.id} uses a session from another conversation`);
      return null;
    }

    const result = entry.session.decrypt(body);
    const text = result.plaintext;
    const messageIndex = result.messageIndex;
    result.free();
    entry.record.pickle = entry.session.pickle(this.vault.pickleKey());
    await this.vault.putInboundGroupSession(sessionId, entry.record);
    this.pinSecureScope(entry.record.conversationId);

    // A Megolm ciphertext decrypts forever, so the checks above cannot tell a
    // new message from an authentic old one the server re-served: each
    // position is shown as exactly one version of one message.
    const version = message.editedAt ?? null;
    const bound = await this.vault.getMessagePosition(sessionId, messageIndex);
    if (bound && (bound.messageId !== message.id || bound.editedAt !== version)) {
      // a replay under a new id, or the original ciphertext labelled as an edit
      console.warn(
        bound.messageId === message.id
          ? `e2e: message ${message.id} is served under a version its ciphertext was never shown as`
          : `e2e: message ${message.id} re-serves the ciphertext of message ${bound.messageId}`
      );
      return null;
    }
    // The id's cache entry holds the position of the newest version accepted.
    // An older position of the SAME session served as the current one reverts
    // an edit the author made — bound (the original re-served as unedited) or
    // not (an older ciphertext with a fresh editedAt). Across a session
    // rotation the index spaces are unrelated: a documented residual.
    const latest = await this.vault.getPlaintext(message.id);
    if (
      latest &&
      !latest.failed &&
      latest.sessionId === sessionId &&
      typeof latest.messageIndex === 'number' &&
      (bound ? latest.messageIndex > messageIndex : latest.messageIndex >= messageIndex)
    ) {
      console.warn(`e2e: message ${message.id} is served as an older version than this device has shown`);
      return null;
    }
    if (!bound) {
      await this.vault.putMessagePosition(sessionId, messageIndex, { messageId: message.id, editedAt: version });
    }
    return { text, position: { sessionId, messageIndex } };
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
    const all = await this.liveVault.listPlaintexts(conversationId);
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
    const pinnedMaster = await this.liveVault.getMasterIdentity(this.userId);
    const masterKey = pinnedMaster?.masterKey ?? served;
    // Same rollout grace as fetchDeviceList, and for the same reason: if these
    // two disagreed about what "cross-signed" means, the device manager would
    // show every device as unsigned while the badge stayed green — and that
    // disagreement lands on the reset-identity affordance.
    const rolloutGrace = data.crossSigning !== true && !this.crossSigningSeen;
    const priorCrossSigned = new Set(
      rolloutGrace ? ((await this.liveVault.getDeviceListState(this.userId))?.crossSignedDeviceIds ?? []) : []
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
      this.olmFallbackSessions.get(key)?.free();
      this.olmFallbackSessions.delete(key);
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
    this.assertLive();
    let devices: E2EDeviceIdentity[];
    try {
      devices = (await this.fetchDeviceList(peerUserId)).devices;
    } catch (err) {
      // a changed identity is the answer; a session that ended has no pins to fall back on
      if (err instanceof E2EIdentityChangedError || isE2ESessionEnded(err)) throw err;
      console.warn(`e2e: falling back to pinned devices for ${peerUserId}:`, errText(err));
      devices = (await this.liveVault.listIdentities(peerUserId)).map(({ deviceId, identity }) => ({
        deviceId,
        ...identity,
        crossSigned: false, // unknown offline — the list is what carries proof
      }));
    }
    // Read after the awaits, never held across them: a dispose meanwhile frees
    // the account (a cached list answers without any request to stop at).
    this.assertLive();
    const account = this.requireAccount();
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
    this.assertLive();
    const own = await this.ownMasterKey();
    if (!own) return null;
    try {
      await this.fetchDeviceList(peerUserId);
    } catch (err) {
      if (err instanceof E2EIdentityChangedError || isE2ESessionEnded(err)) throw err;
      // fall back to the pin: an offline client must still show the number
      console.warn(`e2e: falling back to the pinned master key of ${peerUserId}:`, errText(err));
    }
    const pinned = await this.liveVault.getMasterIdentity(peerUserId);
    if (!pinned) return null;
    return {
      digits: master_safety_number(this.userId, own, peerUserId, pinned.masterKey),
      verified: pinned.verified,
    };
  }

  /** Has the peer's ACCOUNT key been compared out of band (D9)? */
  async isAccountVerified(peerUserId: string): Promise<boolean> {
    return (await this.liveVault.getMasterIdentity(peerUserId))?.verified ?? false;
  }

  /** Mark ONE device of a peer as verified out of band. */
  async markDeviceVerified(peerUserId: string, deviceId: string): Promise<void> {
    const identity = await this.liveVault.getIdentity(peerUserId, deviceId);
    if (!identity) return;
    await this.liveVault.putIdentity(peerUserId, deviceId, { ...identity, verified: true });
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
    const master = await this.liveVault.getMasterIdentity(peerUserId);
    if (master && !master.verified) {
      await this.liveVault.putMasterIdentity(peerUserId, { ...master, verified: true });
    }
    // Comparing the account number says "this master key is really theirs" —
    // nothing more. Devices the key vouches for inherit that at read time
    // (fetchDeviceList ORs crossSigned && masterVerified), so the only devices
    // to stamp here are the ones an account key cannot speak for: peers who
    // have no master key at all (D11, the pre-cross-signing behaviour). Marking
    // the rest would put "Verified" on precisely the device the account key
    // refuses to sign — the one thing this feature exists to expose.
    const state = await this.liveVault.getDeviceListState(peerUserId);
    const accountHasMasterKey = !!(master?.masterKey ?? state?.masterKey);
    if (!accountHasMasterKey) {
      const pinned = await this.liveVault.listIdentities(peerUserId);
      for (const { deviceId, identity } of pinned) {
        if (identity.verified) continue;
        await this.liveVault.putIdentity(peerUserId, deviceId, { ...identity, verified: true });
      }
    }
    this.deviceListCache.delete(peerUserId);
  }
}

// ─── App-level singleton (one service per logged-in account) ─────────────────

let activeService: E2EService | null = null;
let activeUserId: string | null = null;

/**
 * The signed-in account's service, created on first use. Refused
 * (E2EServiceDisposedError) for anyone else: a caller that read its user id
 * before an await can come back after that user signed out, and a service made
 * for it would open, after an account deletion recreate, the vault of an
 * account nobody is signed in to.
 */
export function getE2EService(userId: string): E2EService {
  if (activeService && activeUserId === userId) return activeService;
  const signedIn = currentE2ESessionUser();
  if (signedIn !== undefined && signedIn !== userId) throw new E2EServiceDisposedError();
  void activeService?.dispose();
  activeService = new E2EService(userId);
  activeUserId = userId;
  return activeService;
}

export function disposeE2EService(): void {
  void activeService?.dispose();
  activeService = null;
  activeUserId = null;
}

/**
 * Drop this device's local E2E state for an account that no longer exists.
 * Logout deliberately KEEPS the vault (device keys persist like a trusted
 * device), but after self-service deletion the server has purged every key
 * this vault pairs with, so what remains is pickled key material and a
 * plaintext cache with no owner. Best effort; the vault name is the one
 * E2EVault.open() builds.
 */
export function forgetLocalE2EState(userId: string): void {
  if (activeUserId === userId) disposeE2EService();
  try {
    indexedDB.deleteDatabase(vaultDbName(userId));
  } catch (err) {
    console.warn('e2e: could not drop the local vault of the deleted account:', errText(err));
  }
}
