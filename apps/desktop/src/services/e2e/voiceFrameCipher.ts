// Frame-level cipher core for secure voice channels (docs/e2e-dm-spec.md §21).
//
// Pure WebCrypto AES-256-GCM over ENCODED Opus frames — DOM-free and
// worker-agnostic so it unit-tests without a Worker and runs identically in
// the frame-crypto worker. NO Olm/vodozemac here: key DISTRIBUTION lives on
// the main thread (secureVoiceKeys.ts); this module only ever sees raw
// 32-byte media keys.
//
// Wire format (shared constants are the single source of truth):
//   [1B header: version nibble | keyId mod 16] [4B BE seq] [ciphertext][16B tag]
//   IV  = seq(4 BE) || keyId(1) || 0x00×7   — unique per (key, frame): every
//         generation is a distinct key and seq is strictly monotonic within it
//   AAD = utf8("voxv1|chv:{channelId}|{senderUserId}") || the 5-byte header
import {
  VOICE_FRAME_VERSION,
  VOICE_FRAME_HEADER_BYTES,
  VOICE_FRAME_MIN_BYTES,
  VOICE_FRAME_SEQ_ROTATE_AT,
  voiceFrameAadPrefix,
} from '@voxium/shared';

const RATCHET_SALT = new TextEncoder().encode('voxium-voice-ratchet');
const RATCHET_INFO = new TextEncoder().encode('voxv1-sender-key');
/** current + 2 previous generations survive rotation races and reorder. */
const KEY_RING_SIZE = 3;
/** SRTP-style anti-replay window, in frames. */
const REPLAY_WINDOW = 128n;

/** One hash-ratchet step: HKDF-SHA256(ikm=key, salt, info) → next 32-byte key. */
export async function ratchetVoiceKey(raw: Uint8Array): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: RATCHET_SALT, info: RATCHET_INFO },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

function buildHeader(keyId: number, seq: number): Uint8Array {
  const header = new Uint8Array(VOICE_FRAME_HEADER_BYTES);
  header[0] = ((VOICE_FRAME_VERSION & 0x0f) << 4) | (keyId & 0x0f);
  new DataView(header.buffer).setUint32(1, seq >>> 0, false);
  return header;
}

function buildIv(keyId: number, seq: number): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(0, seq >>> 0, false);
  iv[4] = keyId & 0xff;
  return iv;
}

function buildAad(prefix: Uint8Array, header: Uint8Array): Uint8Array {
  const aad = new Uint8Array(prefix.length + header.length);
  aad.set(prefix, 0);
  aad.set(header, prefix.length);
  return aad;
}

async function importGcmKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [usage]);
}

// ─── Sender ─────────────────────────────────────────────────────────────────

export interface SenderCipher {
  setKey(keyId: number, raw: Uint8Array): Promise<void>;
  /** Encrypt one encoded frame. Null = DROP (no key yet, or counter spent). */
  encrypt(frame: ArrayBuffer): Promise<ArrayBuffer | null>;
  currentKeyId(): number;
  /** Frames left before the caller must rotate. */
  framesRemaining(): number;
}

export function createSenderCipher(
  channelId: string,
  selfUserId: string,
  // initialSeq exists ONLY so exhaustion tests can start near the ceiling —
  // production callers must never pass it (the IV-reuse firewall is seq=0 on
  // every fresh key).
  opts?: { initialSeqForTest?: number },
): SenderCipher {
  const aadPrefix = new TextEncoder().encode(voiceFrameAadPrefix(channelId, selfUserId));
  const initialSeq = opts?.initialSeqForTest ?? 0;
  let key: CryptoKey | null = null;
  let keyId = -1;
  let seq = initialSeq;

  return {
    async setKey(nextKeyId: number, raw: Uint8Array): Promise<void> {
      key = await importGcmKey(raw, 'encrypt');
      keyId = nextKeyId;
      seq = initialSeq; // fresh generation ⇒ fresh counter ⇒ fresh IV space
    },
    async encrypt(frame: ArrayBuffer): Promise<ArrayBuffer | null> {
      if (!key || keyId < 0) return null; // never pass plaintext through
      if (seq >= VOICE_FRAME_SEQ_ROTATE_AT) return null; // exhausted — rotation pending
      const frameSeq = seq++;
      const header = buildHeader(keyId, frameSeq);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: buildIv(keyId, frameSeq) as BufferSource, additionalData: buildAad(aadPrefix, header) as BufferSource },
        key,
        frame,
      );
      const out = new Uint8Array(header.length + ct.byteLength);
      out.set(header, 0);
      out.set(new Uint8Array(ct), header.length);
      return out.buffer;
    },
    currentKeyId: () => keyId,
    framesRemaining: () => Math.max(0, VOICE_FRAME_SEQ_ROTATE_AT - seq),
  };
}

// ─── Receiver ───────────────────────────────────────────────────────────────

export interface ReceiverStats {
  ok: number;
  tagFailed: number;
  unknownKey: number;
  malformed: number;
  replayed: number;
  ratcheted: number;
}

export interface ReceiverCipher {
  setKey(keyId: number, raw: Uint8Array): Promise<void>;
  /** Decrypt one frame. Null = DROP (bad tag / unknown key / replay / short). */
  decrypt(frame: ArrayBuffer): Promise<ArrayBuffer | null>;
  stats(): ReceiverStats;
}

interface RingEntry {
  raw: Uint8Array;
  key: CryptoKey;
  highestSeq: bigint;
  /** Bitmap of the REPLAY_WINDOW frames below highestSeq (bit 0 = highestSeq). */
  windowMask: bigint;
}

export function createReceiverCipher(channelId: string, senderUserId: string): ReceiverCipher {
  const aadPrefix = new TextEncoder().encode(voiceFrameAadPrefix(channelId, senderUserId));
  const ring = new Map<number, RingEntry>(); // full keyId → entry
  const stats: ReceiverStats = { ok: 0, tagFailed: 0, unknownKey: 0, malformed: 0, replayed: 0, ratcheted: 0 };

  function highestKeyId(): number {
    let max = -1;
    for (const id of ring.keys()) if (id > max) max = id;
    return max;
  }

  function pruneRing(): void {
    while (ring.size > KEY_RING_SIZE) {
      let min = Infinity;
      for (const id of ring.keys()) if (id < min) min = id;
      ring.delete(min);
    }
  }

  function sameKeyBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  async function install(keyId: number, raw: Uint8Array): Promise<void> {
    // Re-delivery of a generation we already hold (a key_request re-seal, or a
    // duplicated envelope) must NOT reset the replay window: doing so would let
    // the SFU re-inject the frames it already forwarded under this key — they
    // still carry valid tags and AAD, so a wiped window replays them as live
    // audio. Different bytes for the same keyId IS a new generation (a peer
    // restarted their session), so that case still installs fresh state.
    const existing = ring.get(keyId);
    if (existing && sameKeyBytes(existing.raw, raw)) return;

    ring.set(keyId, {
      raw,
      key: await importGcmKey(raw, 'decrypt'),
      highestSeq: -1n,
      windowMask: 0n,
    });
    pruneRing();
  }

  /** SRTP-style replay check; records the seq when it is fresh. */
  function checkAndRecordSeq(entry: RingEntry, seq: bigint): boolean {
    if (seq > entry.highestSeq) {
      const shift = seq - entry.highestSeq;
      entry.windowMask = shift >= REPLAY_WINDOW ? 1n : ((entry.windowMask << shift) | 1n) & ((1n << REPLAY_WINDOW) - 1n);
      entry.highestSeq = seq;
      return true;
    }
    const offset = entry.highestSeq - seq;
    if (offset >= REPLAY_WINDOW) return false; // pre-window: too old to judge
    const bit = 1n << offset;
    if (entry.windowMask & bit) return false;  // duplicate
    entry.windowMask |= bit;
    return true;
  }

  async function tryDecrypt(entry: RingEntry, keyId: number, seq: number, header: Uint8Array, body: ArrayBuffer): Promise<ArrayBuffer | null> {
    try {
      return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buildIv(keyId, seq) as BufferSource, additionalData: buildAad(aadPrefix, header) as BufferSource },
        entry.key,
        body,
      );
    } catch {
      return null;
    }
  }

  return {
    setKey: install,
    async decrypt(frame: ArrayBuffer): Promise<ArrayBuffer | null> {
      if (frame.byteLength < VOICE_FRAME_MIN_BYTES) { stats.malformed++; return null; }
      const bytes = new Uint8Array(frame, 0, VOICE_FRAME_HEADER_BYTES);
      const version = bytes[0] >> 4;
      const nibble = bytes[0] & 0x0f;
      if (version !== VOICE_FRAME_VERSION) { stats.malformed++; return null; }
      const seq = new DataView(frame).getUint32(1, false);
      const header = bytes.slice();
      const body = frame.slice(VOICE_FRAME_HEADER_BYTES);

      // Resolve the wire nibble against the ring (full ids, newest first)
      const candidates = [...ring.keys()].filter((id) => (id & 0x0f) === nibble).sort((a, b) => b - a);
      for (const keyId of candidates) {
        const entry = ring.get(keyId)!;
        const plain = await tryDecrypt(entry, keyId, seq, header, body);
        if (plain !== null) {
          if (!checkAndRecordSeq(entry, BigInt(seq))) { stats.replayed++; return null; }
          stats.ok++;
          return plain;
        }
      }

      // Tag-verified TRIAL-RATCHET (spec §21): a frame one generation ahead of
      // everything we know may be an arrival ratchet — derive the candidate
      // and let the GCM tag decide. Success installs it with zero audio gap;
      // failure means a FRESH rotation whose sealed key hasn't arrived yet.
      const top = highestKeyId();
      if (top >= 0 && ((top + 1) & 0x0f) === nibble) {
        const derived = await ratchetVoiceKey(ring.get(top)!.raw);
        const candidateEntry: RingEntry = {
          raw: derived,
          key: await importGcmKey(derived, 'decrypt'),
          highestSeq: -1n,
          windowMask: 0n,
        };
        const plain = await tryDecrypt(candidateEntry, top + 1, seq, header, body);
        if (plain !== null) {
          ring.set(top + 1, candidateEntry);
          pruneRing();
          checkAndRecordSeq(candidateEntry, BigInt(seq));
          stats.ratcheted++;
          stats.ok++;
          return plain;
        }
      }

      if (candidates.length === 0) stats.unknownKey++;
      else stats.tagFailed++;
      return null;
    },
    stats: () => ({ ...stats }),
  };
}
