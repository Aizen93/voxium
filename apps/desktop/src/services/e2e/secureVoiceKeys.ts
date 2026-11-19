// Media-key lifecycle for secure voice channels (docs/e2e-dm-spec.md §21) —
// the callCrypto.ts sibling. Owns per-channel session state: our sender key
// and its generations, the vetted participant set, and the epoch/seq replay
// windows for inbound sealed key messages.
//
// Key rules (spec §21):
//  - ARRIVAL  → hash-ratchet our key (keyId+1), seal the POST-ratchet key to
//    the joiner only. Existing receivers trial-ratchet from the frames —
//    gapless, no wire flag.
//  - DEPARTURE / kick / device revocation / identity change → mint a FRESH
//    random key (keyId+1), seal to every remaining vetted participant.
//  - Membership truth comes ONLY from GET /e2e/channels/:id/devices (via
//    e2eService.fetchChannelDeviceLists) — socket events are hints.
//  - A sender key never survives a session restart, and seq is never
//    persisted (the IV-reuse firewall).
//
// REVIEW NOTE: this key lifecycle is cryptographic code outside the engine
// (spec §3, decided 2026-11-18, issue #175). It mints the raw 32-byte media
// keys (crypto.getRandomValues), ratchets them (ratchetVoiceKey, HKDF-SHA256)
// and hands them to the frame worker; a change here takes the same review as a
// change to packages/crypto-engine. What it must keep:
//  - Every key it installs with frames.setLocalKey() is new: a fresh random key
//    (session start at keyId 0; departure, exclusion and counter exhaustion,
//    each at keyId + 1) or the ratchet of the current one (an arrival, at
//    keyId + 1). The frame cipher starts a new IV counter for each new key and
//    recognises only the key in use (given again, it keeps its count), so a
//    key that has been replaced is never installed again.
//  - A joiner is keyed with a post-arrival generation only (no past audio), and
//    every departure rotates to a fresh key (no future audio); a departure
//    naming another session than the one held for a participant is not
//    theirs and changes nothing. After an exclusion the key in use is one the
//    excluded device was never sealed: a fresh rotation, except for a
//    participant who was never keyed, or one excluded while a fresh rotation
//    is sealing (it replaces the key they held). A membership check excludes
//    everyone it holds who must go (an identity change, no longer a member, a
//    pinned device no longer published), and takes their one rotation, before
//    it keys anyone; a participant whose retried vet it refuses is excluded
//    without ever having been keyed. So nothing it seals derives from a key
//    an excluded device holds.
//  - A participant excluded during a session is not keyed again in it: the
//    epoch they were excluded under is recorded, and only an announcement
//    with a new epoch is vetted again.
//  - Neither a key nor seq is ever persisted. Teardown zero-fills only the
//    current key; superseded generations, the peers' keys decoded here and the
//    base64 copies sealed into Olm plaintexts are left to the garbage collector.
//    A rotation for a session that has ended mints nothing, and a fresh key
//    whose session ends while it is being sealed is never installed (it is the
//    current key, which the teardown zero-filled).
//  - Session epochs (mintEpoch) carry 96 random bits (16 random bytes, each
//    mapped to one of 64 characters): their unpredictability is what stops an
//    envelope withheld from an earlier session from installing.
//
// NOTE: stores are imported DYNAMICALLY inside functions (resetStores
// eval-order rule, same as callCrypto.ts / dmCrypto.ts).
import {
  buildVoiceKeyPlaintext,
  parseVoiceKeyPlaintext,
  e2eVoiceScope,
  VOICE_KEY_ID_MAX,
  type VoiceUser,
} from '@voxium/shared';
import { getE2EService, E2EIdentityChangedError } from './e2eService';
import { isE2ESessionEnded } from './session';
import { getSocket } from '../socket';
import {
  createFrameCryptoSession,
  isSecureVoiceSupported,
  type FrameCryptoSession,
} from './voiceFrameTransform';
import { ratchetVoiceKey } from './voiceFrameCipher';

export { E2EIdentityChangedError, isSecureVoiceSupported };

export type SecureVoiceErrorKind =
  | 'unsupported-platform'
  | 'peer-not-e2e'
  | 'binding-mismatch'
  | 'legacy-key'
  | 'device-revoked'
  | 'no-key';

/** This join was superseded before it claimed the session — abort quietly. */
export class SecureVoiceSupersededError extends Error {
  constructor() {
    super('secure voice join superseded');
    this.name = 'SecureVoiceSupersededError';
  }
}

/** A session-fatal security condition — the caller must leave voice, loudly. */
export class SecureVoiceError extends Error {
  constructor(
    public readonly kind: SecureVoiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SecureVoiceError';
  }
}

interface PeerState {
  deviceId: string;
  /** THEIR session epoch, echoed as `recipientEpoch` in every key we seal. */
  epoch: string;
  vetted: boolean;
  /**
   * The generation (keyId) our frames were using when this participant's
   * arrival reached the session, or null for an occupant already present when
   * we joined. They are only ever sealed a LATER generation (spec §21.4):
   * whichever path keys them first, keyParticipantLocked ratchets past it.
   */
  arrivedAtKeyId: number | null;
  recvEpoch: string | null;
  recvSeq: number;
}

interface SecureVoiceSessionState {
  channelId: string;
  epoch: string;
  sendSeq: number;
  keyId: number;
  currentKey: Uint8Array;
  frames: FrameCryptoSession;
  peers: Map<string, PeerState>;
  /** Authoritative member ids, refreshed from the endpoint. */
  members: Set<string>;
  /**
   * Inbound sealed keys that arrived before their sender was vetted — a key
   * can beat the participant event onto the chain (the DM pre-pin-buffer
   * problem). Drained after each successful vet; dropping instead would
   * silently deafen us to that sender until their next rotation.
   *
   * Keyed PER SENDER: a single flat buffer lets any co-present member spend
   * the whole budget on junk envelopes during our join window and push out the
   * honest keys we actually need (the relay accepts 120/min per sender).
   */
  pendingKeys: Map<string, Array<{ fromDeviceId: string; envelope: unknown }>>;
  /**
   * Sender epochs already seen, per userId, for the WHOLE session — NOT inside
   * PeerState. A peer's PeerState is destroyed and rebuilt on every one of
   * their reconnects (voice:join force-leaves first, so we see left+joined),
   * and rebuilding the history empty would let an envelope withheld from one
   * of their earlier sessions install a dead generation afterwards. This is
   * the mirror of the `recipientEpoch` guard, which only covers OUR restarts.
   */
  seenSenderEpochs: Map<string, Set<string>>;
  /**
   * The epochs each participant was excluded under in this session, for cause
   * (a failed vet, an identity change, a legacy key payload, a revoked device,
   * removal from the channel). A participant excluded during a session is not
   * keyed again in it until they are announced with a new epoch, which is a
   * new session of theirs and goes through vetting like any arrival.
   */
  excludedEpochs: Map<string, Set<string>>;
  /** Watchdog bookkeeping per sender: last key_request + un-healed timer. */
  keyRequests: Map<string, { lastAt: number; timer: ReturnType<typeof setTimeout> | null }>;
  /** Periodic re-confirmation of membership AND pinned devices. */
  confirmTimer: ReturnType<typeof setInterval> | null;
  /**
   * Set when our encrypt transform is attached, the first moment a frame can
   * exist under one of our generations. The replay of the occupants present at
   * our join precedes it, so anyone announced from then on is keyed as an
   * arrival.
   */
  sending: boolean;
  /** Serializes ALL key mutations + seals so wire order matches state order. */
  chain: Promise<void>;
  ended: boolean;
}

/** Per-sender pending-key slots — 2 covers an arrival/rotation race. */
const PENDING_KEYS_PER_SENDER = 3;
/** Minimum spacing between key_requests to one sender. */
const KEY_REQUEST_COOLDOWN_MS = 10_000;
/** How long a stalled sender stays unreported while a re-seal is in flight. */
const KEY_REQUEST_GRACE_MS = 8_000;
/** Re-check membership + pinned devices while a call is live (revocations
 *  emit no event of their own, so nothing else would ever notice one). */
const MEMBERSHIP_RECHECK_MS = 60_000;

// Per-channel module state — crypto bookkeeping that must survive store
// snapshots/resets untouched (the callCrypto rule).
const sessions = new Map<string, SecureVoiceSessionState>();

const EPOCH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
function mintEpoch(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => EPOCH_CHARS[b % 64]).join('');
}

function mintKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

async function flagIdentityChanged(peerUserId: string): Promise<void> {
  const { useE2EStore } = await import('../../stores/e2eStore');
  useE2EStore.getState().flagIdentityChanged(peerUserId);
}

/** Append a step to the session's serial chain (never leaves it rejected). */
function enqueue(state: SecureVoiceSessionState, step: () => Promise<void>): void {
  state.chain = state.chain.then(async () => {
    if (state.ended) return;
    await step();
  }).catch((err) => {
    // A step the logout overtook (the service it held was disposed, or the
    // account is no longer the signed-in one) is not a key failure: the call
    // ends with the session anyway.
    if (isE2ESessionEnded(err)) {
      console.debug('[SecureVoice] Key chain step ended with the session:', err instanceof Error ? err.message : err);
      return;
    }
    console.error('[SecureVoice] Key chain step failed:', err);
  });
}

/**
 * Confirm a participant against the AUTHORITATIVE member list and the
 * verified device list, then mark them vetted. Throws SecureVoiceError /
 * E2EIdentityChangedError on security conditions (flag-and-rethrow).
 */
async function vetParticipant(state: SecureVoiceSessionState, userId: string, deviceId: string): Promise<void> {
  const selfId = await currentUserId();
  if (!selfId) throw new Error('Not authenticated');
  const service = getE2EService(selfId);

  if (!state.members.has(userId)) {
    // The socket event claimed a participant the authoritative list doesn't
    // know — refetch once (they may have JUST been invited), then fail closed.
    // The list verifies every member and is read collecting identity changes:
    // each member it names is flagged, and only a change of the participant's
    // own is a verdict on them; another member's does not hold their vet up.
    const { members, identityChangedUserIds = [] } = await service.fetchChannelDeviceLists(
      state.channelId,
      { collectIdentityChanges: true },
    );
    for (const changed of identityChangedUserIds) await flagIdentityChanged(changed);
    state.members = new Set(members.map((m) => m.userId));
    if (identityChangedUserIds.includes(userId)) throw new E2EIdentityChangedError(userId);
    if (!state.members.has(userId)) {
      throw new SecureVoiceError('binding-mismatch', `${userId} is not a member of channel ${state.channelId}`);
    }
  }

  try {
    const list = await service.fetchDeviceList(userId, true);
    if (list.servedDeviceCount === 0) {
      throw new SecureVoiceError('peer-not-e2e', `${userId} has no E2E devices`);
    }
    if (!list.devices.some((d) => d.deviceId === deviceId)) {
      throw new SecureVoiceError('binding-mismatch', `device ${deviceId} is not a verified device of ${userId}`);
    }
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) await flagIdentityChanged(err.peerUserId);
    throw err;
  }
}

/** Remember the session a participant was excluded in (see `excludedEpochs`). */
function recordExclusion(state: SecureVoiceSessionState, userId: string, epoch: string): void {
  let epochs = state.excludedEpochs.get(userId);
  if (!epochs) {
    epochs = new Set();
    state.excludedEpochs.set(userId, epochs);
  }
  epochs.add(epoch);
}

/** Whether our current generation is one the participant must never be given. */
function predatesArrival(state: SecureVoiceSessionState, peer: PeerState): boolean {
  return peer.arrivedAtKeyId !== null && state.keyId <= peer.arrivedAtKeyId;
}

/**
 * Advance our key one hash-ratchet step (keyId+1) and switch our frames to it.
 * Existing receivers follow by trial-ratchet; only the sealed key reaches a
 * participant who did not hold the previous generation.
 */
async function ratchetLocked(state: SecureVoiceSessionState): Promise<void> {
  const next = await ratchetVoiceKey(state.currentKey);
  if (state.ended) {
    next.fill(0);
    return;
  }
  if (state.keyId + 1 >= VOICE_KEY_ID_MAX) {
    throw new Error('voice keyId space exhausted');
  }
  state.currentKey = next;
  state.keyId += 1;
  state.frames.setLocalKey(state.keyId, state.currentKey);
}

/**
 * Key one vetted participant. Every path that seals our key to a participant
 * other than a fresh rotation comes through here (the arrival, a later vet
 * after a transient failure, a key request): when our current generation was
 * already in use at their arrival, it ratchets first, so they are sealed a
 * generation that starts after it (spec §21.4). Arrivals announced at the same
 * generation share that one step, and once it is taken nothing more is needed
 * for them, so a re-seal never ratchets again.
 */
async function keyParticipantLocked(
  state: SecureVoiceSessionState,
  userId: string,
  reason: 'initial' | 'ratchet' | 'fresh',
): Promise<void> {
  const peer = state.peers.get(userId);
  if (!peer || !peer.vetted || state.ended) return;
  if (predatesArrival(state, peer)) {
    await ratchetLocked(state);
    if (state.ended) return;
    await sealKeyTo(state, userId, 'ratchet');
    return;
  }
  await sealKeyTo(state, userId, reason);
}

/** Seal our CURRENT key to one vetted participant device and emit it. */
async function sealKeyTo(state: SecureVoiceSessionState, userId: string, reason: 'initial' | 'ratchet' | 'fresh'): Promise<void> {
  const peer = state.peers.get(userId);
  if (!peer || !peer.vetted) return;
  if (predatesArrival(state, peer)) {
    // Unreachable through keyParticipantLocked, and a fresh rotation always
    // lands past every vetted participant's arrival: refuse rather than seal.
    console.error(`[SecureVoice] Not sealing ${userId} a key generation in use before they arrived`);
    return;
  }
  const selfId = await currentUserId();
  // A teardown that lands mid-step must not seal: endSecureVoiceSession zeroes
  // currentKey IN PLACE, so a step resuming after it would serialize a 32-byte
  // all-zero key under our identity and emit it to peers.
  if (!selfId || state.ended) return;
  const service = getE2EService(selfId);

  const plaintext = buildVoiceKeyPlaintext({
    v: 1,
    scope: e2eVoiceScope(state.channelId),
    senderUserId: selfId,
    senderDeviceId: service.deviceId,
    epoch: state.epoch,
    recipientEpoch: peer.epoch,
    seq: state.sendSeq++,
    keyId: state.keyId,
    keyB64: toB64(state.currentKey),
    reason,
  });

  try {
    const envelope = await service.encryptToDevice(userId, peer.deviceId, plaintext);
    if (state.ended) return;
    getSocket()?.emit('voice:e2e:key', { to: userId, envelope });
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      await flagIdentityChanged(err.peerUserId);
      throw err;
    }
    // Transient seal failure: one retry, then give up — the peer's decrypt
    // watchdog asks for a re-seal (handleKeyRequest) if this key never lands.
    console.warn(`[SecureVoice] Sealing key to ${userId} failed, retrying once:`, err);
    try {
      const envelope = await service.encryptToDevice(userId, peer.deviceId, plaintext);
      if (state.ended) return;
      getSocket()?.emit('voice:e2e:key', { to: userId, envelope });
    } catch (retryErr) {
      // An identity change found by the retry is flagged like one found by the first attempt.
      if (retryErr instanceof E2EIdentityChangedError) await flagIdentityChanged(retryErr.peerUserId);
      throw retryErr;
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the E2E media session for a secure voice channel. MUST complete
 * before `voice:join` is emitted — a session that cannot start must abort the
 * join (no plaintext fallback). Returns the frame session for transport
 * attachment plus our announced deviceId.
 */
export async function beginSecureVoiceSession(
  channelId: string,
  // Supersession guard: two overlapping joins for the same channel both reach
  // the registry, and the LATER-resolving one would tear down the session the
  // winner already registered (killing a live call's worker). Checked after the
  // fetch, immediately before this call claims the registry.
  opts?: { isCurrent?: () => boolean },
): Promise<{ frames: FrameCryptoSession; deviceId: string; epoch: string }> {
  if (!isSecureVoiceSupported()) {
    throw new SecureVoiceError('unsupported-platform', 'encoded-frame transforms are not available in this runtime');
  }
  const selfId = await currentUserId();
  if (!selfId) throw new Error('Not authenticated');
  const service = getE2EService(selfId);

  // Authoritative member list up front — also proves WE are a member and the
  // E2E stack is alive before any media plumbing exists. Read collecting
  // identity changes, so one member's unaccepted change does not stop the
  // session from starting: each member it names is flagged, and stays in the
  // member list. Nobody is keyed at start; a named member in the call is
  // excluded by their vet, and a new session of theirs is vetted like any
  // arrival.
  const { members, identityChangedUserIds = [] } = await service.fetchChannelDeviceLists(
    channelId,
    { collectIdentityChanges: true },
  );
  for (const changed of identityChangedUserIds) await flagIdentityChanged(changed);
  if (opts?.isCurrent && !opts.isCurrent()) {
    throw new SecureVoiceSupersededError();
  }

  // A previous session for this channel (reconnect) is torn down completely:
  // fresh key, fresh epoch, seq=0 — the IV-reuse firewall.
  endSecureVoiceSession(channelId);

  const transforms = createFrameCryptoSession(channelId, selfId);
  // The handle given out is the frame session with one difference: attaching
  // the encrypt transform marks the session as sending (see `sending`).
  // Everything else is the frame session's own (its methods are closures).
  const frames: FrameCryptoSession = {
    ...transforms,
    attachSender(sender) {
      state.sending = true;
      transforms.attachSender(sender);
    },
  };
  const state: SecureVoiceSessionState = {
    channelId,
    epoch: mintEpoch(),
    sendSeq: 0,
    keyId: 0,
    currentKey: mintKey(),
    frames,
    peers: new Map(),
    members: new Set(members.map((m) => m.userId)),
    pendingKeys: new Map(),
    seenSenderEpochs: new Map(),
    excludedEpochs: new Map(),
    keyRequests: new Map(),
    confirmTimer: null,
    sending: false,
    chain: Promise.resolve(),
    ended: false,
  };
  frames.setLocalKey(state.keyId, state.currentKey);
  frames.onCounterLow(() => rotateFresh(channelId, 'counter'));
  frames.onDecryptStalled((senderUserId, stalled) => onDecryptStalled(state, senderUserId, stalled));
  // Revocations and directory changes emit no event we could subscribe to, so
  // the only way to notice one mid-call is to re-ask the authoritative endpoint.
  state.confirmTimer = setInterval(() => confirmMembership(channelId), MEMBERSHIP_RECHECK_MS);
  sessions.set(channelId, state);
  if (import.meta.env.DEV) {
    // Diagnostics surface for the Playwright ciphertext proof — DEV builds only
    (globalThis as { __voxSecureVoiceDiag?: () => Promise<unknown> }).__voxSecureVoiceDiag = () => frames.getDiagnostics();
  }
  return { frames, deviceId: service.deviceId, epoch: state.epoch };
}

/**
 * Decrypt watchdog (spec §21.4). A sender we hold no usable key for is
 * inaudible and otherwise indistinguishable from silence, so ask them once for
 * a re-seal and — if that does not heal it — surface them in the UI as a
 * member we cannot hear.
 */
function onDecryptStalled(state: SecureVoiceSessionState, senderUserId: string, stalled: boolean): void {
  if (state.ended) return;
  const entry = state.keyRequests.get(senderUserId) ?? { lastAt: Number.NEGATIVE_INFINITY, timer: null };

  if (!stalled) {
    if (entry.timer) clearTimeout(entry.timer);
    state.keyRequests.delete(senderUserId);
    void clearPeerIssue(state.channelId, senderUserId);
    return;
  }

  // performance.now() is monotonic: a wall-clock jump (NTP correction, user
  // changing the system time) must not disable the heal path for hours. It
  // starts near zero, so "never asked" is -Infinity rather than 0.
  const now = performance.now();
  if (now - entry.lastAt < KEY_REQUEST_COOLDOWN_MS) return;
  entry.lastAt = now;
  getSocket()?.emit('voice:e2e:key_request', { to: senderUserId });
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (state.ended) return;
    void notifyPeerExcluded(state.channelId, senderUserId, new SecureVoiceError('no-key', 'no usable media key for this member'));
  }, KEY_REQUEST_GRACE_MS);
  state.keyRequests.set(senderUserId, entry);
}

export function getSecureVoiceSession(channelId: string): FrameCryptoSession | null {
  return sessions.get(channelId)?.frames ?? null;
}

/**
 * A participant appeared (voice:channel_users replay or voice:user_joined).
 * Vets them, then keys them. A genuine ARRIVAL (anything but an occupant of
 * the replay at our own join) is keyed with a generation that starts after
 * the one in use at their arrival, so they can never decrypt past audio.
 */
export function onParticipantJoined(channelId: string, user: Pick<VoiceUser, 'id' | 'deviceId' | 'epoch'>, opts: { initialReplay: boolean }): void {
  const state = sessions.get(channelId);
  if (!state) return;
  // Both read at the announcement, not when the queued step runs: the
  // generation in use NOW is the one they must never be given (arrivals
  // announced together then share one ratchet), and an occupant of the replay
  // at our join is one announced before our first frame.
  const keyIdAtAnnouncement = state.keyId;
  const presentAtOurJoin = opts.initialReplay && !state.sending;
  enqueue(state, async () => {
    // Read in the step: an exclusion recorded by an earlier step applies.
    const excludedEpochs = state.excludedEpochs.get(user.id);
    if (excludedEpochs && (!user.epoch || excludedEpochs.has(user.epoch))) {
      console.warn(`[SecureVoice] ${user.id} was excluded in this session — not keyed again until announced with a new epoch`);
      state.pendingKeys.delete(user.id);
      return;
    }
    const known = state.peers.get(user.id);
    let repinned = false;
    if (known) {
      // Same session announced again: a duplicate event, ignore it. A
      // DIFFERENT epoch means they restarted and their old keys are dead — we
      // pinned their previous session, so keep processing as a fresh arrival
      // instead of ignoring it, or their new keys would fail the epoch binding
      // for the rest of the call. (A forged downgrade to an epoch we already
      // retired is still caught by seenSenderEpochs.)
      if (!user.epoch || known.epoch === user.epoch) return;
      state.peers.delete(user.id);
      forgetPeer(state, user.id);
      repinned = true;
      // Their previous session has ended, as if we had seen it leave: the
      // departure rotates fresh (spec §21.4) and the new session is keyed as
      // an arrival.
      if (known.vetted) await rotateFreshLocked(state);
      if (state.ended) return;
    }
    if (!user.deviceId || !user.epoch) {
      // An un-updated client in a secure voice channel cannot exchange keys.
      // Excluding them (never keying them) is participant-fatal, not
      // session-fatal: everyone else keeps talking.
      console.warn(`[SecureVoice] ${user.id} joined without an E2E device/epoch — they will not be keyed`);
      state.pendingKeys.delete(user.id);
      return;
    }
    const peer: PeerState = {
      deviceId: user.deviceId,
      epoch: user.epoch,
      vetted: false,
      // A new session of someone already in the call is an arrival.
      arrivedAtKeyId: presentAtOurJoin && !repinned ? null : keyIdAtAnnouncement,
      recvEpoch: null,
      recvSeq: -1,
    };
    state.peers.set(user.id, peer);
    try {
      await vetParticipant(state, user.id, user.deviceId);
      if (state.ended) return;
      peer.vetted = true;
    } catch (err) {
      const isSecurityVerdict = err instanceof SecureVoiceError || err instanceof E2EIdentityChangedError;
      if (!isSecurityVerdict) {
        // A network blip, a 429 or a 5xx during a rolling restart is NOT a
        // security verdict. Excluding on it is unrecoverable: an excluded peer
        // is never re-vetted (the poll only removes), never sealed to, and
        // their key_requests are ignored — the pair goes mutually deaf for the
        // rest of the call. Leave them un-vetted so the next membership tick
        // retries, and say nothing to the user yet. The tick keys them
        // through the same step, arrival generation included.
        console.warn(`[SecureVoice] Vetting ${user.id} failed transiently — will retry:`, err);
        peer.vetted = false;
        return;
      }
      state.peers.delete(user.id);
      state.pendingKeys.delete(user.id);
      recordExclusion(state, user.id, peer.epoch);
      console.error(`[SecureVoice] Vetting ${user.id} failed — excluded from the session:`, err);
      await notifyPeerExcluded(channelId, user.id, err);
      return;
    }

    // An occupant seen during OUR join gets our current key. An arrival gets
    // the generation after the one in use when they arrived: ratcheted here
    // unless another arrival or a rotation already moved past it. Frames
    // switch AFTER the ratchet is installed; existing receivers trial-ratchet
    // from the frames themselves.
    await keyVettedParticipantLocked(state, user.id, peer, peer.arrivedAtKeyId === null ? 'initial' : 'ratchet');
  });
}

/**
 * The step after a participant passed vetting, wherever the vet ran: key them,
 * then drain any of THEIR keys that arrived before the vet completed. The drain
 * is in a `finally` because a failed seal must not strand them: nothing else
 * ever drains this buffer, so they would be dead weight for the session AND we
 * would stay deaf to a sender whose key we already hold.
 */
async function keyVettedParticipantLocked(
  state: SecureVoiceSessionState,
  userId: string,
  peer: PeerState,
  reason: 'initial' | 'ratchet' | 'fresh',
): Promise<void> {
  try {
    await keyParticipantLocked(state, userId, reason);
  } catch (err) {
    if (!(err instanceof E2EIdentityChangedError)) throw err;
    // The seal found their identity changed (already flagged). This was their
    // first key, and it never reached them: excluding them needs no rotation.
    state.peers.delete(userId);
    recordExclusion(state, userId, peer.epoch);
    forgetPeer(state, userId);
    await notifyPeerExcluded(state.channelId, userId, err);
  } finally {
    const buffered = state.pendingKeys.get(userId) ?? [];
    state.pendingKeys.delete(userId);
    for (const k of buffered) {
      await processInboundKeyLocked(state, peer, userId, k.fromDeviceId, k.envelope);
    }
  }
}

/**
 * A participant left / was evicted: fresh key for everyone remaining. `epoch`,
 * when the departure carries one, is the epoch of the session that left: a
 * departure naming another epoch than the one held for them (a late event of
 * their previous session, after a new one was announced) changes nothing.
 */
export function onParticipantLeft(channelId: string, userId: string, epoch?: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    // Read in the step: the announcement of their new session may be queued
    // ahead of this departure.
    const held = state.peers.get(userId);
    if (epoch && held && held.epoch !== epoch) {
      console.warn(`[SecureVoice] Departure of a previous session of ${userId} ignored`);
      return;
    }
    // Clear the badge FIRST: an already-excluded peer is not in `peers`, so
    // the early return below would otherwise leave "N members can't be keyed"
    // on screen for the rest of the call after they have gone.
    clearPeerIssueFor(channelId, userId);
    if (!state.peers.delete(userId)) return;
    forgetPeer(state, userId);
    await rotateFreshLocked(state);
  });
}

/** Drop every trace of a peer: receiver ring, buffered keys, watchdog timers. */
function forgetPeer(state: SecureVoiceSessionState, userId: string): void {
  state.frames.removeRemote(userId);
  state.pendingKeys.delete(userId);
  const req = state.keyRequests.get(userId);
  if (req?.timer) clearTimeout(req.timer);
  state.keyRequests.delete(userId);
  // NOTE: seenSenderEpochs is deliberately NOT cleared — it must outlive the
  // peer's reconnects to keep their dead sessions' keys uninstallable.
}

/** A member who is gone is not a member we "cannot hear" — drop the badge. */
function clearPeerIssueFor(channelId: string, userId: string): void {
  void clearPeerIssue(channelId, userId);
}

/** Force a fresh rotation (counter exhaustion, membership confirmation). */
export function rotateFresh(channelId: string, why: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    console.log(`[SecureVoice] Fresh key rotation (${why}) for channel ${channelId}`);
    await rotateFreshLocked(state);
  });
}

async function rotateFreshLocked(state: SecureVoiceSessionState): Promise<void> {
  // A session that has ended rotates nothing: no key is minted for it.
  if (state.ended) return;
  state.currentKey = mintKey();
  state.keyId += 1;
  if (state.keyId >= VOICE_KEY_ID_MAX) {
    // Unreachable in practice; fail closed rather than wrap.
    throw new Error('voice keyId space exhausted');
  }
  // Seal to everyone BEFORE switching our frames — shrinks the receiver gap
  // to the socket-vs-RTP skew instead of adding our sealing latency to it.
  const identityChanged: Array<{ userId: string; peer: PeerState; err: E2EIdentityChangedError }> = [];
  for (const [userId, peer] of state.peers) {
    try {
      await sealKeyTo(state, userId, 'fresh');
    } catch (err) {
      if (err instanceof E2EIdentityChangedError) {
        identityChanged.push({ userId, peer, err });
        continue;
      }
      console.error(`[SecureVoice] Fresh-key seal to ${userId} failed:`, err);
    }
  }
  // A session that ended while the key was being sealed never installs it:
  // it is the current key, which the teardown zero-filled.
  if (state.ended) return;
  state.frames.setLocalKey(state.keyId, state.currentKey);
  // A participant whose identity the seal found changed (the seal flagged it)
  // is excluded once our frames have switched. The fresh key never reached
  // them, so their exclusion needs no further rotation.
  for (const { userId, peer, err } of identityChanged) {
    console.warn(`[SecureVoice] ${userId}'s identity changed — excluded at the fresh rotation`);
    state.peers.delete(userId);
    recordExclusion(state, userId, peer.epoch);
    forgetPeer(state, userId);
    await notifyPeerExcluded(state.channelId, userId, err);
  }
}

/**
 * Membership hint (CHANNEL_MEMBERS_UPDATED) — refetch the authoritative list;
 * peers that are no longer members are treated as departures. The server also
 * force-evicts them; this is belt-and-braces (a dropped socket event fails
 * closed at the next hint or rotation).
 */
export function confirmMembership(channelId: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    const selfId = await currentUserId();
    if (!selfId) return;

    // The fetch verifies EVERY member's identity. Asked to collect, it names
    // the members whose identity changed instead of failing on the first, so
    // the checks below run for everyone else whatever one member's state.
    const { members, lists, identityChangedUserIds = [] } = await getE2EService(selfId).fetchChannelDeviceLists(
      channelId,
      { collectIdentityChanges: true },
    );
    if (state.ended) return;
    state.members = new Set(members.map((m) => m.userId));

    // A member whose identity changed since it was accepted is flagged, in the
    // call or not. They stay in the member list: a new session of theirs goes
    // through vetting like any arrival.
    const identityChanged = new Set(identityChangedUserIds);
    for (const userId of identityChangedUserIds) {
      await flagIdentityChanged(userId);
      if (state.ended) return;
    }

    // Everyone held who must go is excluded before anyone is keyed in the
    // pass: an identity change, a participant no longer a member, a pinned
    // device no longer published. When one of them had been keyed, one fresh
    // rotation follows (spec §21.4), so nothing keyed below derives from a key
    // an excluded device holds. A participant never keyed takes none, and one
    // whose retried vet is refused below is excluded without having been keyed.
    let keyedExcluded = false;
    for (const [userId, peer] of [...state.peers.entries()]) {
      let notice: unknown;
      if (identityChanged.has(userId)) {
        notice = new E2EIdentityChangedError(userId);
      } else if (!state.members.has(userId)) {
        // Keyed: removed without a notice, like a departure. Never vetted: the
        // notice their vet gives a non-member.
        notice = peer.vetted
          ? undefined
          : new SecureVoiceError('binding-mismatch', `${userId} is not a member of channel ${channelId}`);
      } else if (peer.vetted && devicePublished(lists, userId, peer.deviceId) === false) {
        // The device we pinned at vet time may since have been REVOKED — the
        // stolen-laptop response. Revocation is not a membership change, so no
        // event fires and the server never evicts them; without this check we
        // would keep sealing every future key to a device its owner disowned.
        console.warn(`[SecureVoice] Pinned device of ${userId} is no longer published — excluding`);
        notice = new SecureVoiceError('device-revoked', 'the pinned device was revoked');
      } else {
        continue;
      }
      if (peer.vetted) keyedExcluded = true;
      state.peers.delete(userId);
      recordExclusion(state, userId, peer.epoch);
      forgetPeer(state, userId);
      if (notice) await notifyPeerExcluded(channelId, userId, notice);
    }
    if (state.ended) return;
    if (keyedExcluded) await rotateFreshLocked(state);
    if (state.ended) return;

    // Retry peers whose vet failed transiently (a blip, a 429, a node
    // restarting). They are still in the channel and will never re-announce,
    // so this poll is their only way back into the session. An arrival among
    // them is keyed past the generation in use when they arrived, exactly as
    // if their first vet had passed. Their device is checked against this
    // pass's list too, whatever their vet answered, and before any key: one
    // the list no longer publishes is excluded as revoked, with no rotation
    // (they were never keyed).
    for (const [userId, peer] of [...state.peers.entries()]) {
      if (peer.vetted) continue;
      try {
        await vetParticipant(state, userId, peer.deviceId);
      } catch (err) {
        if (err instanceof SecureVoiceError || err instanceof E2EIdentityChangedError) {
          state.peers.delete(userId);
          recordExclusion(state, userId, peer.epoch);
          forgetPeer(state, userId);
          await notifyPeerExcluded(channelId, userId, err);
          continue;
        }
        if (devicePublished(lists, userId, peer.deviceId) !== false) {
          console.warn(`[SecureVoice] Re-vetting ${userId} failed transiently — retried at the next membership check:`, err);
          continue;
        }
      }
      if (state.ended) return;
      if (devicePublished(lists, userId, peer.deviceId) === false) {
        console.warn(`[SecureVoice] Pinned device of ${userId} is no longer published — excluding`);
        state.peers.delete(userId);
        recordExclusion(state, userId, peer.epoch);
        forgetPeer(state, userId);
        await notifyPeerExcluded(channelId, userId, new SecureVoiceError('device-revoked', 'the pinned device was revoked'));
        continue;
      }
      peer.vetted = true;
      try {
        await keyVettedParticipantLocked(state, userId, peer, 'fresh');
      } catch (err) {
        // Vetted, so no later check retries them. A seal that did not reach
        // them is recovered by their key request, and a buffered key of
        // theirs we could not install by ours (the decrypt watchdogs).
        console.warn(`[SecureVoice] Keying ${userId} after a passed re-vet failed — not retried here; recovery comes from the key requests:`, err);
      }
    }
  });
}

/** Whether a member's device list publishes this device; undefined when the list does not hold theirs. */
function devicePublished(
  lists: Map<string, { devices: Array<{ deviceId: string }> }>,
  userId: string,
  deviceId: string,
): boolean | undefined {
  const list = lists.get(userId);
  if (!list) return undefined;
  return list.devices.some((d) => d.deviceId === deviceId);
}

/**
 * An inbound sealed key message. Droppable failures return silently; security
 * conditions exclude the sender (participant-fatal) — decrypted media from
 * them simply stops, which the UI surfaces via the decrypt watchdog.
 */
export function handleInboundKey(channelId: string, from: string, fromDeviceId: string, envelope: unknown): void {
  // DEV-only Playwright hook (secure-voice.spec.ts ciphertext proof): a
  // member that drops every inbound key MUST hear nothing — proving the SFU
  // forwards frames that are undecodable without keys. import.meta.env.DEV
  // is compile-time false in production builds, so this branch is
  // dead-code-eliminated and has no production surface.
  if (import.meta.env.DEV && (globalThis as { __VOX_SECURE_VOICE_TEST__?: { dropInboundKeys?: boolean } }).__VOX_SECURE_VOICE_TEST__?.dropInboundKeys) {
    return;
  }
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    const peer = state.peers.get(from);
    if (!peer || !peer.vetted) {
      // The key beat the participant event onto the chain — buffer it; the
      // vet path drains this once the sender is confirmed. Dropping would
      // deafen us to them until their next rotation. Per-sender slots, so a
      // flood from one member cannot displace anyone else's key.
      const slots = state.pendingKeys.get(from) ?? [];
      if (slots.length < PENDING_KEYS_PER_SENDER) {
        slots.push({ fromDeviceId, envelope });
        state.pendingKeys.set(from, slots);
      } else {
        console.warn('[SecureVoice] Pending-key slots full — dropping key from', from);
      }
      return;
    }
    await processInboundKeyLocked(state, peer, from, fromDeviceId, envelope);
  });
}

async function processInboundKeyLocked(
  state: SecureVoiceSessionState,
  peer: PeerState,
  from: string,
  fromDeviceId: string,
  envelope: unknown,
): Promise<void> {
  // Only for the participant the key was received for, while they are still
  // in the session: a buffered key drained after an earlier one of the same
  // buffer excluded them is not processed.
  if (state.peers.get(from) !== peer) return;
  const channelId = state.channelId;
  {
    if (fromDeviceId && fromDeviceId !== peer.deviceId) return; // routing hint mismatch

    // Hard cutover: a non-envelope payload is an un-updated or downgrading
    // peer — exclude them, never accept a plaintext key.
    if (typeof envelope !== 'string' || !envelope.startsWith('{"v":1,"e":"olm1"')) {
      console.warn(`[SecureVoice] Non-envelope key payload from ${from} — excluding sender (legacy-key)`);
      state.peers.delete(from);
      recordExclusion(state, from, peer.epoch);
      forgetPeer(state, from);
      await notifyPeerExcluded(channelId, from, new SecureVoiceError('legacy-key', 'key payload is not an olm1 envelope'));
      // Excluding a peer we already keyed means our current key is in hands we
      // no longer trust — rotate so they cannot follow the rest of the call.
      await rotateFreshLocked(state);
      return;
    }

    const selfId = await currentUserId();
    if (!selfId) return;
    const service = getE2EService(selfId);

    let raw: string | null;
    try {
      raw = await service.decryptFromDevice(from, peer.deviceId, envelope);
    } catch (err) {
      if (err instanceof E2EIdentityChangedError) {
        await flagIdentityChanged(err.peerUserId);
        state.peers.delete(from);
        recordExclusion(state, from, peer.epoch);
        forgetPeer(state, from);
        await notifyPeerExcluded(channelId, from, err);
        // Spec §21.4 lists identity change as a FRESH-rotation trigger: the
        // device we just stopped trusting already holds our current key, and
        // the server keeps forwarding our audio to it (an identity change is
        // not a membership change, so nothing evicts them).
        await rotateFreshLocked(state);
        return;
      }
      throw err;
    }
    if (raw === null) return; // droppable

    const p = parseVoiceKeyPlaintext(raw);
    if (!p) return;
    // Binding checks against OUR state (importKeyShare pattern)
    if (p.scope !== e2eVoiceScope(channelId)) return;
    if (p.senderUserId !== from || p.senderDeviceId !== peer.deviceId) return;
    // Sealed for THIS session of ours. Our epoch is minted per session and
    // unpredictable, so an envelope the server withheld from an earlier
    // session cannot be delivered now: without this, every other binding
    // still holds after we rejoin (fresh sessions start with empty replay
    // state), letting a dead generation be re-installed and the frames
    // recorded under it replayed as live audio.
    if (p.recipientEpoch !== state.epoch) return;
    // ...and sent from the session the peer is in RIGHT NOW. This is the
    // mirror guard: recipientEpoch only covers our own restarts, while a peer
    // reconnect (which happens on any blip) rebuilds their PeerState, so
    // without this an envelope withheld from THEIR earlier session would sail
    // through afterwards. The epoch they announced at voice:join is the same
    // value they stamp into every envelope, so a stale one cannot match —
    // and a server that forges the announcement to fit only breaks the peer's
    // own keys, which fails loudly instead of replaying audio.
    if (p.epoch !== peer.epoch) return;

    // Epoch-aware replay/ordering — superseded epochs never come back. The
    // history is SESSION-scoped (survives their reconnects), not per-PeerState.
    let seenEpochs = state.seenSenderEpochs.get(from);
    if (!seenEpochs) {
      seenEpochs = new Set();
      state.seenSenderEpochs.set(from, seenEpochs);
    }
    if (p.epoch !== peer.recvEpoch) {
      if (seenEpochs.has(p.epoch)) return;
      seenEpochs.add(p.epoch);
      peer.recvEpoch = p.epoch;
      peer.recvSeq = p.seq;
    } else {
      if (p.seq <= peer.recvSeq) return;
      peer.recvSeq = p.seq;
    }

    state.frames.setRemoteKey(from, p.keyId, fromB64(p.keyB64));
  }
}

/**
 * A peer asked for our current key (their watchdog / a lost message). Only a
 * vetted participant is answered, and never with a generation in use before
 * their arrival.
 */
export function handleKeyRequest(channelId: string, from: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    const peer = state.peers.get(from);
    try {
      await keyParticipantLocked(state, from, 'fresh');
    } catch (err) {
      if (!(err instanceof E2EIdentityChangedError) || !peer) throw err;
      // The seal found their identity changed (the seal flagged it). They are
      // excluded as at their first seal and, since they may hold the key in
      // use, it is rotated fresh for everyone remaining (spec §21.4).
      console.warn(`[SecureVoice] ${from}'s identity changed — excluded at their key request`);
      state.peers.delete(from);
      recordExclusion(state, from, peer.epoch);
      forgetPeer(state, from);
      await notifyPeerExcluded(channelId, from, err);
      if (state.ended) return;
      await rotateFreshLocked(state);
    }
  });
}

/** Full teardown. Safe to call for channels without a session. */
export function endSecureVoiceSession(channelId: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  endSessionState(state);
}

/**
 * Tear down a specific session object. Callers holding a session handle must
 * use this rather than the by-channel form: a superseded join whose session was
 * already replaced would otherwise destroy the LIVE session registered under
 * the same channel id.
 */
export function endSecureVoiceSessionFor(channelId: string, frames: FrameCryptoSession): void {
  const state = sessions.get(channelId);
  if (state && state.frames === frames) {
    endSessionState(state);
    return;
  }
  // Not the registered session (superseded) — destroy just this handle.
  frames.destroy();
}

/**
 * What the unit tests of this module wait on; nothing in the app does. The
 * serial key chain of the channel's session, which settles once every step
 * queued on it so far has run, or one settled promise, the same on every
 * call, when the channel has no session. It never rejects (see `enqueue`).
 */
export function secureVoiceKeyChain(channelId: string): Promise<void> {
  return sessions.get(channelId)?.chain ?? NO_CHAIN;
}

/** What secureVoiceKeyChain answers for a channel with no chain to wait on. */
const NO_CHAIN: Promise<void> = Promise.resolve();

function endSessionState(state: SecureVoiceSessionState): void {
  state.ended = true;
  if (sessions.get(state.channelId) === state) sessions.delete(state.channelId);
  if (state.confirmTimer) clearInterval(state.confirmTimer);
  state.confirmTimer = null;
  for (const req of state.keyRequests.values()) if (req.timer) clearTimeout(req.timer);
  state.keyRequests.clear();
  state.pendingKeys.clear();
  state.currentKey.fill(0);
  state.frames.destroy();
}

async function notifyPeerExcluded(channelId: string, userId: string, err: unknown): Promise<void> {
  try {
    const { useVoiceStore } = await import('../../stores/voiceStore');
    // Optional until the store integration phase lands the action — the
    // session itself is already correct without the UI surface.
    const store = useVoiceStore.getState() as {
      markSecureVoicePeerExcluded?: (channelId: string, userId: string, kind: SecureVoiceErrorKind | 'identity-changed') => void;
    };
    store.markSecureVoicePeerExcluded?.(channelId, userId, err instanceof SecureVoiceError ? err.kind : 'identity-changed');
  } catch (notifyErr) {
    console.warn('[SecureVoice] Could not surface peer exclusion to the UI:', notifyErr);
  }
}

/** A previously un-hearable member started decrypting — drop the warning. */
async function clearPeerIssue(channelId: string, userId: string): Promise<void> {
  try {
    const { useVoiceStore } = await import('../../stores/voiceStore');
    const store = useVoiceStore.getState() as {
      clearSecureVoicePeerIssue?: (channelId: string, userId: string) => void;
    };
    store.clearSecureVoicePeerIssue?.(channelId, userId);
  } catch (err) {
    console.warn('[SecureVoice] Could not clear a peer issue in the UI:', err);
  }
}
