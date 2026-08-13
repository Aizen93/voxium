// E2E-authenticated DM call signaling (docs/e2e-dm-spec.md §20) — the glue
// between voiceStore's WebRTC signaling and the E2E service, sibling of
// dmCrypto.ts. Every offer/answer/ICE candidate travels as a pairwise-Olm
// envelope sealed to ONE peer device; the DTLS fingerprints inside the SDP are
// thereby authenticated against the pinned identity, which is what defeats a
// signaling-relay MITM.
//
// NOTE: stores are imported DYNAMICALLY inside functions. resetStores.ts
// captures every account store's initial state at module-eval time, so a
// static store import from a service pulled in by voiceStore would create an
// eval-order cycle that crashes at boot (same rule as dmCrypto.ts).
import {
  buildCallSignalPlaintext,
  parseCallSignalPlaintext,
  type E2ECallSignal,
} from '@voxium/shared';
import { getE2EService, E2EIdentityChangedError } from './e2eService';

export { E2EIdentityChangedError };

export interface CallPeerDevice {
  userId: string;
  deviceId: string;
}

export type CallSecurityErrorKind = 'legacy-signal' | 'binding-mismatch' | 'peer-not-e2e';

/** A call-fatal security condition — the caller must ABORT the call, loudly. */
export class CallSecurityError extends Error {
  constructor(
    public readonly kind: CallSecurityErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CallSecurityError';
  }
}

interface CallSignalingState {
  peer: CallPeerDevice;
  /** Our outbound signaling session id — receiver resets seq tracking on change. */
  epoch: string;
  sendSeq: number;
  /** Peer's most recent epoch + highest seq seen within it. */
  recvEpoch: string | null;
  recvSeq: number;
  /** The peer device passed verified-device-list vetting (checked once per pin). */
  peerVetted: boolean;
}

// Per-conversation signaling state. Module-level (not store state): it is
// crypto bookkeeping, and it must survive store snapshots/resets untouched.
const callState = new Map<string, CallSignalingState>();

const EPOCH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function mintEpoch(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => EPOCH_CHARS[b % 64]).join('');
}

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

/**
 * Pin the peer device for a call and reset all seq/epoch state. Call when the
 * peer's call device becomes known (dm:voice:joined) and again if they rejoin
 * from a different device (fresh epoch, fresh counters).
 */
export function beginCallSignaling(conversationId: string, peer: CallPeerDevice): void {
  callState.set(conversationId, {
    peer,
    epoch: mintEpoch(),
    sendSeq: 0,
    recvEpoch: null,
    recvSeq: -1,
    peerVetted: false,
  });
}

/** Drop all signaling state for a call (hangup, abort, ended). */
export function endCallSignaling(conversationId: string): void {
  callState.delete(conversationId);
}

/** The currently pinned peer device for a call, if any. */
export function getCallPeerDevice(conversationId: string): CallPeerDevice | null {
  return callState.get(conversationId)?.peer ?? null;
}

/**
 * Seal one WebRTC signal to the pinned peer device. Throws:
 *  - CallSecurityError('peer-not-e2e')     — peer has published no devices
 *  - CallSecurityError('binding-mismatch') — claimed device not in the peer's
 *    verified device list (a server-invented device id dies here)
 *  - E2EIdentityChangedError               — pin mismatch (flagged for the UI
 *    first, then rethrown; the call must abort, never degrade)
 */
export async function encryptCallSignal(
  conversationId: string,
  peer: CallPeerDevice,
  signal: E2ECallSignal,
): Promise<string> {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not authenticated');
  const service = getE2EService(userId);

  let state = callState.get(conversationId);
  if (!state || state.peer.userId !== peer.userId || state.peer.deviceId !== peer.deviceId) {
    beginCallSignaling(conversationId, peer);
    state = callState.get(conversationId)!;
  }

  try {
    // Vet the claimed device against the peer's VERIFIED device list once per
    // pin — signature-checked and TOFU-pinned by fetchDeviceList, so a device
    // id the server invented (or one whose keys fail verification) is refused
    // before any session is built.
    if (!state.peerVetted) {
      const list = await service.fetchDeviceList(peer.userId, true);
      if (list.servedDeviceCount === 0) {
        throw new CallSecurityError('peer-not-e2e', `${peer.userId} has no E2E devices`);
      }
      if (!list.devices.some((d) => d.deviceId === peer.deviceId)) {
        throw new CallSecurityError('binding-mismatch', `device ${peer.deviceId} is not a verified device of ${peer.userId}`);
      }
      state.peerVetted = true;
    }

    const plaintext = buildCallSignalPlaintext({
      v: 1,
      conversationId,
      senderUserId: userId,
      senderDeviceId: service.deviceId,
      epoch: state.epoch,
      seq: state.sendSeq++,
      signal,
    });
    return await service.encryptToDevice(peer.userId, peer.deviceId, plaintext);
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      const { useE2EStore } = await import('../../stores/e2eStore');
      useE2EStore.getState().flagIdentityChanged(err.peerUserId);
    }
    throw err;
  }
}

/**
 * Open and verify one inbound signal envelope.
 *
 * Returns the signal when everything binds, or null for DROPPABLE failures
 * (undecryptable, malformed plaintext, mismatched binding fields, seq
 * regression) — one bad packet must not kill a call the legit peer is still
 * driving. Throws:
 *  - CallSecurityError('legacy-signal') — the payload is not an olm1 envelope
 *    at all: an un-updated (or downgrading) peer. The call must abort.
 *  - E2EIdentityChangedError — the sender device's identity changed (flagged,
 *    rethrown).
 */
export async function decryptCallSignal(
  conversationId: string,
  expectedPeer: CallPeerDevice,
  envelopeStr: unknown,
): Promise<E2ECallSignal | null> {
  // Hard cutover: anything that is not an olm1 envelope string is a legacy
  // (or stripped) signal — reject the call rather than downgrade.
  if (typeof envelopeStr !== 'string' || !envelopeStr.startsWith('{"v":1,"e":"olm1"')) {
    throw new CallSecurityError('legacy-signal', 'signal is not an olm1 envelope');
  }

  const userId = await currentUserId();
  if (!userId) return null;
  const service = getE2EService(userId);

  const state = callState.get(conversationId);
  if (!state) return null;
  if (state.peer.userId !== expectedPeer.userId || state.peer.deviceId !== expectedPeer.deviceId) return null;

  let raw: string | null;
  try {
    raw = await service.decryptFromDevice(expectedPeer.userId, expectedPeer.deviceId, envelopeStr);
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      const { useE2EStore } = await import('../../stores/e2eStore');
      useE2EStore.getState().flagIdentityChanged(err.peerUserId);
    }
    throw err;
  }
  if (raw === null) return null;

  const p = parseCallSignalPlaintext(raw);
  if (!p) return null;

  // Binding checks against OUR state — the plaintext is authenticated, but
  // its claims must match what we pinned (importKeyShare pattern)
  if (p.conversationId !== conversationId) return null;
  if (p.senderUserId !== expectedPeer.userId || p.senderDeviceId !== expectedPeer.deviceId) return null;

  // Epoch-aware strictly-increasing seq. A new epoch (reconnect/re-glare on
  // the peer's side) resets the expectation; within an epoch, replays and
  // stale reorders are dropped. Exact replay is already impossible at the Olm
  // layer — this is defense-in-depth and ordering hygiene.
  if (p.epoch !== state.recvEpoch) {
    state.recvEpoch = p.epoch;
    state.recvSeq = p.seq;
  } else {
    if (p.seq <= state.recvSeq) return null;
    state.recvSeq = p.seq;
  }

  return p.signal;
}
