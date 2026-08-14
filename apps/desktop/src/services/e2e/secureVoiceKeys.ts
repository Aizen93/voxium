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
  | 'legacy-key';

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
  vetted: boolean;
  recvEpoch: string | null;
  recvSeq: number;
  seenRecvEpochs: Set<string>;
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
   */
  pendingKeys: Array<{ from: string; fromDeviceId: string; envelope: unknown }>;
  /** Serializes ALL key mutations + seals so wire order matches state order. */
  chain: Promise<void>;
  ended: boolean;
}

const PENDING_KEYS_CAP = 16;

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
    const { members } = await service.fetchChannelDeviceLists(state.channelId);
    state.members = new Set(members.map((m) => m.userId));
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

/** Seal our CURRENT key to one vetted participant device and emit it. */
async function sealKeyTo(state: SecureVoiceSessionState, userId: string, reason: 'initial' | 'ratchet' | 'fresh'): Promise<void> {
  const peer = state.peers.get(userId);
  if (!peer || !peer.vetted) return;
  const selfId = await currentUserId();
  if (!selfId) return;
  const service = getE2EService(selfId);

  const plaintext = buildVoiceKeyPlaintext({
    v: 1,
    scope: e2eVoiceScope(state.channelId),
    senderUserId: selfId,
    senderDeviceId: service.deviceId,
    epoch: state.epoch,
    seq: state.sendSeq++,
    keyId: state.keyId,
    keyB64: toB64(state.currentKey),
    reason,
  });

  try {
    const envelope = await service.encryptToDevice(userId, peer.deviceId, plaintext);
    getSocket()?.emit('voice:e2e:key', { to: userId, envelope });
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      await flagIdentityChanged(err.peerUserId);
      throw err;
    }
    // Transient seal failure: one retry, then give up — the peer's
    // key_request / decrypt watchdog heals a missed key.
    console.warn(`[SecureVoice] Sealing key to ${userId} failed, retrying once:`, err);
    const envelope = await service.encryptToDevice(userId, peer.deviceId, plaintext);
    getSocket()?.emit('voice:e2e:key', { to: userId, envelope });
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the E2E media session for a secure voice channel. MUST complete
 * before `voice:join` is emitted — a session that cannot start must abort the
 * join (no plaintext fallback). Returns the frame session for transport
 * attachment plus our announced deviceId.
 */
export async function beginSecureVoiceSession(channelId: string): Promise<{ frames: FrameCryptoSession; deviceId: string }> {
  if (!isSecureVoiceSupported()) {
    throw new SecureVoiceError('unsupported-platform', 'encoded-frame transforms are not available in this runtime');
  }
  const selfId = await currentUserId();
  if (!selfId) throw new Error('Not authenticated');
  const service = getE2EService(selfId);

  // Authoritative member list up front — also proves WE are a member and the
  // E2E stack is alive before any media plumbing exists.
  const { members } = await service.fetchChannelDeviceLists(channelId);

  // A previous session for this channel (reconnect) is torn down completely:
  // fresh key, fresh epoch, seq=0 — the IV-reuse firewall.
  endSecureVoiceSession(channelId);

  const frames = createFrameCryptoSession(channelId, selfId);
  const state: SecureVoiceSessionState = {
    channelId,
    epoch: mintEpoch(),
    sendSeq: 0,
    keyId: 0,
    currentKey: mintKey(),
    frames,
    peers: new Map(),
    members: new Set(members.map((m) => m.userId)),
    pendingKeys: [],
    chain: Promise.resolve(),
    ended: false,
  };
  frames.setLocalKey(state.keyId, state.currentKey);
  frames.onCounterLow(() => rotateFresh(channelId, 'counter'));
  sessions.set(channelId, state);
  if (import.meta.env.DEV) {
    // Diagnostics surface for the Playwright ciphertext proof — DEV builds only
    (globalThis as { __voxSecureVoiceDiag?: () => Promise<unknown> }).__voxSecureVoiceDiag = () => frames.getDiagnostics();
  }
  return { frames, deviceId: service.deviceId };
}

export function getSecureVoiceSession(channelId: string): FrameCryptoSession | null {
  return sessions.get(channelId)?.frames ?? null;
}

/**
 * A participant appeared (voice:channel_users replay or voice:user_joined).
 * Vets them, then — for genuine ARRIVALS (not the initial replay) — ratchets
 * our key forward so they can never decrypt past audio.
 */
export function onParticipantJoined(channelId: string, user: Pick<VoiceUser, 'id' | 'deviceId'>, opts: { initialReplay: boolean }): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    if (state.peers.has(user.id)) return; // duplicate event
    if (!user.deviceId) {
      // An un-updated client in a secure voice channel cannot exchange keys.
      // Excluding them (never keying them) is participant-fatal, not
      // session-fatal: everyone else keeps talking.
      console.warn(`[SecureVoice] ${user.id} joined without an E2E device — they will not be keyed`);
      return;
    }
    const peer: PeerState = {
      deviceId: user.deviceId,
      vetted: false,
      recvEpoch: null,
      recvSeq: -1,
      seenRecvEpochs: new Set(),
    };
    state.peers.set(user.id, peer);
    try {
      await vetParticipant(state, user.id, user.deviceId);
      peer.vetted = true;
    } catch (err) {
      state.peers.delete(user.id);
      console.error(`[SecureVoice] Vetting ${user.id} failed — excluded from the session:`, err);
      await notifyPeerExcluded(channelId, user.id, err);
      return;
    }

    if (opts.initialReplay) {
      // Existing occupant seen during OUR join: they need our current key.
      await sealKeyTo(state, user.id, 'initial');
    } else {
      // Genuine arrival: ratchet forward, then key the joiner with the
      // POST-ratchet key. Frames switch AFTER the ratchet is installed;
      // existing receivers trial-ratchet from the frames themselves.
      state.currentKey = await ratchetVoiceKey(state.currentKey);
      state.keyId += 1;
      state.frames.setLocalKey(state.keyId, state.currentKey);
      await sealKeyTo(state, user.id, 'ratchet');
    }

    // Drain any of THEIR keys that arrived before the vet completed
    const buffered = state.pendingKeys.filter((k) => k.from === user.id);
    state.pendingKeys = state.pendingKeys.filter((k) => k.from !== user.id);
    for (const k of buffered) {
      await processInboundKeyLocked(state, peer, k.from, k.fromDeviceId, k.envelope);
    }
  });
}

/** A participant left / was evicted: fresh key for everyone remaining. */
export function onParticipantLeft(channelId: string, userId: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    if (!state.peers.delete(userId)) return;
    state.frames.removeRemote(userId);
    await rotateFreshLocked(state);
  });
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
  state.currentKey = mintKey();
  state.keyId += 1;
  if (state.keyId >= VOICE_KEY_ID_MAX) {
    // Unreachable in practice; fail closed rather than wrap.
    throw new Error('voice keyId space exhausted');
  }
  // Seal to everyone BEFORE switching our frames — shrinks the receiver gap
  // to the socket-vs-RTP skew instead of adding our sealing latency to it.
  for (const userId of state.peers.keys()) {
    try {
      await sealKeyTo(state, userId, 'fresh');
    } catch (err) {
      console.error(`[SecureVoice] Fresh-key seal to ${userId} failed:`, err);
    }
  }
  state.frames.setLocalKey(state.keyId, state.currentKey);
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
    const { members } = await getE2EService(selfId).fetchChannelDeviceLists(channelId);
    state.members = new Set(members.map((m) => m.userId));
    let removed = false;
    for (const userId of [...state.peers.keys()]) {
      if (!state.members.has(userId)) {
        state.peers.delete(userId);
        state.frames.removeRemote(userId);
        removed = true;
      }
    }
    if (removed) await rotateFreshLocked(state);
  });
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
      // deafen us to them until their next rotation.
      if (state.pendingKeys.length < PENDING_KEYS_CAP) {
        state.pendingKeys.push({ from, fromDeviceId, envelope });
      } else {
        console.warn('[SecureVoice] Pending-key buffer full — dropping key from', from);
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
  const channelId = state.channelId;
  {
    if (fromDeviceId && fromDeviceId !== peer.deviceId) return; // routing hint mismatch

    // Hard cutover: a non-envelope payload is an un-updated or downgrading
    // peer — exclude them, never accept a plaintext key.
    if (typeof envelope !== 'string' || !envelope.startsWith('{"v":1,"e":"olm1"')) {
      console.warn(`[SecureVoice] Non-envelope key payload from ${from} — excluding sender (legacy-key)`);
      state.peers.delete(from);
      state.frames.removeRemote(from);
      await notifyPeerExcluded(channelId, from, new SecureVoiceError('legacy-key', 'key payload is not an olm1 envelope'));
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
        state.frames.removeRemote(from);
        await notifyPeerExcluded(channelId, from, err);
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

    // Epoch-aware replay/ordering — superseded epochs never come back
    if (p.epoch !== peer.recvEpoch) {
      if (peer.seenRecvEpochs.has(p.epoch)) return;
      peer.seenRecvEpochs.add(p.epoch);
      peer.recvEpoch = p.epoch;
      peer.recvSeq = p.seq;
    } else {
      if (p.seq <= peer.recvSeq) return;
      peer.recvSeq = p.seq;
    }

    state.frames.setRemoteKey(from, p.keyId, fromB64(p.keyB64));
  }
}

/** A peer asked for our current key (their watchdog / a lost message). */
export function handleKeyRequest(channelId: string, from: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  enqueue(state, async () => {
    await sealKeyTo(state, from, 'fresh');
  });
}

/** Full teardown. Safe to call for channels without a session. */
export function endSecureVoiceSession(channelId: string): void {
  const state = sessions.get(channelId);
  if (!state) return;
  state.ended = true;
  sessions.delete(channelId);
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
