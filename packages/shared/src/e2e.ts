// ─── E2E DM encryption — shared protocol pieces (docs/e2e-dm-spec.md) ────────
//
// This module defines everything the client and server must agree on byte-for-
// byte: the ciphertext envelope format and the canonical strings that device /
// prekey signatures are computed over. No crypto happens here — only encoding
// and validation.

/**
 * Engine identifier for envelope `e` field.
 * `olm1` = pairwise Olm (legacy 1:1 sessions + key-share transport),
 * `megolm1` = per-conversation group ratchet (multi-device, spec §12).
 */
export const E2E_ENGINE_OLM1 = 'olm1';
export const E2E_ENGINE_MEGOLM1 = 'megolm1';

export const E2E_LIMITS = {
  /** Max length of the serialized envelope stored as message content. */
  ENVELOPE_MAX: 32_768,
  /** Max stored one-time keys per device (server-enforced). */
  MAX_STORED_OTKS: 100,
  /** Max one-time keys per upload request. */
  OTK_UPLOAD_MAX: 50,
  /** Client keeps the server stocked up to this many OTKs… */
  OTK_TARGET: 50,
  /** …and replenishes when the count drops below this. */
  OTK_LOW_WATER: 20,
  /** Max registered devices per user (server-enforced). */
  MAX_DEVICES: 5,
  /** Rotate the outbound group session after this many messages… */
  GROUP_SESSION_MAX_MESSAGES: 100,
  /** …or once it reaches this age (7 days). */
  GROUP_SESSION_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  /** Max key shares per POST /e2e/keyshares batch. */
  KEYSHARE_BATCH_MAX: 50,
  /** Max stored shares per (sender, recipient device) — eviction is scoped to
   *  the sender so nobody can flush another sender's pending session keys. */
  KEYSHARE_STORE_CAP_PER_SENDER: 100,
  /** Undelivered shares are swept after this long (cleanup job). */
  KEYSHARE_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  /** Max key shares returned (and deleted) by one GET /e2e/keyshares claim. */
  KEYSHARE_CLAIM_MAX: 100,
  /**
   * Max serialized key-share body. A real Olm pre-key share is ~600 bytes;
   * allowing the full ENVELOPE_MAX here would let a sender inflate the shared
   * mailbox 50x for free.
   */
  KEYSHARE_BODY_MAX: 2048,
  /** Max pending shares one sender may hold across ALL recipients. */
  KEYSHARE_SENDER_TOTAL_CAP: 2000,
  /** Max master-secret transfers per POST /e2e/master-transfers batch (§14). */
  MASTER_TRANSFER_BATCH_MAX: 5,
  /**
   * Max stored (and per-read returned) master-secret transfers per recipient
   * device. Tiny on purpose: this mailbox only ever carries a handful of
   * device-approval handshakes, never bulk traffic. Overflow evicts oldest.
   * Reads do not consume (§14.4), so this is also what bounds a mailbox whose
   * acks never arrive — until the retention sweep clears it.
   */
  MASTER_TRANSFER_STORE_CAP: 10,
  /**
   * Max length of the encrypted key-backup blob (spec §15). Generous on
   * purpose and still tiny: the plaintext is a single sealed 32-byte secret
   * plus framing, so a few hundred bytes is the real shape — the headroom is
   * for a future payload revision, not for bulk storage. One row per account,
   * so this is also the whole per-account storage cost of the feature.
   */
  KEY_BACKUP_MAX: 4096,
  /**
   * Max backed-up session keys per account (spec §16). Unlike every other E2E
   * table nothing can ever sweep these — that is the point of the feature — so
   * the cap is the only bound on an account's storage.
   *
   * Reaching it REFUSES new uploads rather than evicting old ones. Eviction
   * would silently destroy the ability to read the oldest history, which is
   * precisely the loss the feature exists to prevent; refusing is visible and
   * costs only the newest keys, which the device still holds locally. A
   * conversation rotates its session every 100 messages or 7 days, so this is
   * years of heavy use, and hitting it means something is wrong.
   */
  MESSAGE_KEY_STORE_CAP: 20_000,
  /**
   * Max message-key backups per POST /e2e/message-keys batch (plan §4.4). A
   * device catching up seals every inbound Megolm session it holds, so the
   * upload is naturally bulk — but each entry is an independent upsert, so the
   * batch also bounds how much work one request can ask of the database.
   */
  MESSAGE_KEY_BATCH_MAX: 100,
  /**
   * Max message-key backups returned by one GET /e2e/message-keys page. An
   * account accumulates one row per conversation per session rotation, so the
   * collection grows without bound and the download MUST be paginated — this is
   * what makes a page cheap enough to serve. Larger than the upload batch
   * because a restoring device wants the whole set as fast as it can get it.
   */
  MESSAGE_KEY_PAGE_MAX: 200,
  /**
   * Max members of a secure channel (creator included). Bounds key-share
   * fanout: a rotation delivers one pairwise-Olm share per member device, so
   * the worst case is CAP × MAX_DEVICES = 125 shares (3 KEYSHARE_BATCH_MAX
   * posts) — comfortably inside KEYSHARE_SENDER_TOTAL_CAP even with several
   * channels rotating while their recipients are offline.
   */
  SECURE_CHANNEL_MEMBER_CAP: 25,
} as const;

// ─── E2E scopes ──────────────────────────────────────────────────────────────
//
// Group-session state (vault records, key-share payloads, message-key backups)
// is keyed by a SCOPE string. For DMs the scope is the bare conversation id;
// for secure channels it is `ch:{channelId}`. Cuids never contain `:`, so the
// two namespaces cannot collide, and everywhere a scope is embedded in an
// AEAD's AAD (message-key backup) the separation is cryptographic, not just
// lexical. Server-side, the scope decides which authorization gate a key share
// passes through (DM participant check vs. secure-channel membership check).

/** Prefix marking a group-session scope as a secure channel. */
export const E2E_CHANNEL_SCOPE_PREFIX = 'ch:';

/**
 * Prefix marking a scope as a secure VOICE channel's media-key context
 * (spec §21). Deliberately distinct from `ch:` so a sealed media key can never
 * be confused with a message key-share for the same channel — the separation
 * is enforced in every strict parser and rides inside AEAD AADs.
 */
export const E2E_VOICE_SCOPE_PREFIX = 'chv:';

/** Build the group-session scope id for a secure channel. */
export function e2eChannelScope(channelId: string): string {
  return `${E2E_CHANNEL_SCOPE_PREFIX}${channelId}`;
}

/** Build the media-key scope id for a secure voice channel. */
export function e2eVoiceScope(channelId: string): string {
  return `${E2E_VOICE_SCOPE_PREFIX}${channelId}`;
}

/** Split a scope string into its kind and raw id. */
export function parseE2EScope(
  scope: string,
):
  | { kind: 'channel'; channelId: string }
  | { kind: 'voice-channel'; channelId: string }
  | { kind: 'dm'; conversationId: string } {
  // 'chv:' first — it does not lexically collide with 'ch:' ('chv'[2] !== ':')
  // but explicit ordering keeps that from ever becoming load-bearing.
  if (scope.startsWith(E2E_VOICE_SCOPE_PREFIX)) {
    return { kind: 'voice-channel', channelId: scope.slice(E2E_VOICE_SCOPE_PREFIX.length) };
  }
  if (scope.startsWith(E2E_CHANNEL_SCOPE_PREFIX)) {
    return { kind: 'channel', channelId: scope.slice(E2E_CHANNEL_SCOPE_PREFIX.length) };
  }
  return { kind: 'dm', conversationId: scope };
}

/** 32-byte key, unpadded standard base64 (vodozemac canonical encoding). */
export const E2E_KEY_B64_RE = /^[A-Za-z0-9+/]{43}$/;
/** 64-byte Ed25519 signature, unpadded standard base64. */
export const E2E_SIGNATURE_B64_RE = /^[A-Za-z0-9+/]{86}$/;
/** vodozemac KeyId, unpadded standard base64 (short). */
export const E2E_KEY_ID_B64_RE = /^[A-Za-z0-9+/]{1,32}$/;
/** Client-generated device id — stable per install, URL-safe. */
export const E2E_DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
/** Megolm session id, unpadded standard base64. */
export const E2E_SESSION_ID_B64_RE = /^[A-Za-z0-9+/]{1,64}$/;
/** Envelope body: unpadded standard base64 ciphertext. */
const E2E_BODY_B64_RE = /^[A-Za-z0-9+/]+$/;

/**
 * Ciphertext envelope stored as `Message.content` when `Message.encrypted`.
 * `v` = envelope version, `e` = engine id, `b` = unpadded-base64 ciphertext.
 *
 * olm1 additionally carries `t` (Olm message type: 0 = pre-key, 1 = normal);
 * megolm1 carries `sid` (the group session id the body was encrypted under).
 */
export interface E2EOlmEnvelope {
  v: 1;
  e: typeof E2E_ENGINE_OLM1;
  t: 0 | 1;
  b: string;
}

export interface E2EMegolmEnvelope {
  v: 1;
  e: typeof E2E_ENGINE_MEGOLM1;
  sid: string;
  b: string;
}

export type E2EEnvelope = E2EOlmEnvelope | E2EMegolmEnvelope;

export function buildE2EEnvelope(messageType: 0 | 1, bodyB64: string): string {
  return JSON.stringify({ v: 1, e: E2E_ENGINE_OLM1, t: messageType, b: bodyB64 });
}

/** Megolm group-ratchet envelope: one ciphertext for every device in the room. */
export function buildMegolmEnvelope(sessionId: string, bodyB64: string): string {
  return JSON.stringify({ v: 1, e: E2E_ENGINE_MEGOLM1, sid: sessionId, b: bodyB64 });
}

/**
 * Strict structural validation. Returns the parsed envelope or null.
 * Used by the server before storing (never sanitizes/trusts ciphertext) and
 * by clients before attempting decryption. Both engines are accepted: olm1
 * remains valid for legacy history and for the pairwise key-share transport.
 */
export function parseE2EEnvelope(content: string): E2EEnvelope | null {
  if (typeof content !== 'string' || content.length === 0 || content.length > E2E_LIMITS.ENVELOPE_MAX) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length !== 4) return null;
  if (obj.v !== 1) return null;
  if (typeof obj.b !== 'string' || obj.b.length === 0 || !E2E_BODY_B64_RE.test(obj.b)) return null;

  if (obj.e === E2E_ENGINE_OLM1) {
    if (obj.t !== 0 && obj.t !== 1) return null;
    return { v: 1, e: E2E_ENGINE_OLM1, t: obj.t, b: obj.b };
  }
  if (obj.e === E2E_ENGINE_MEGOLM1) {
    if (typeof obj.sid !== 'string' || !E2E_SESSION_ID_B64_RE.test(obj.sid)) return null;
    return { v: 1, e: E2E_ENGINE_MEGOLM1, sid: obj.sid, b: obj.b };
  }
  return null;
}

// ─── E2E attachments (spec §13) ──────────────────────────────────────────────
// The encrypted blob goes to S3 under opaque metadata; the real fileName/
// mimeType/size plus the AES-256-GCM key+nonce travel INSIDE the message
// ciphertext as a structured plaintext payload.

/** What the server is allowed to see about an encrypted attachment. */
export const E2E_ATTACHMENT_MIME = 'application/octet-stream';
export const E2E_ATTACHMENT_NAME = 'encrypted.bin';
/** GCM auth tag — ciphertext is exactly plaintext + this many bytes. */
export const E2E_GCM_TAG_BYTES = 16;
/** 12-byte GCM nonce, unpadded standard base64. */
export const E2E_IV_B64_RE = /^[A-Za-z0-9+/]{16}$/;

/**
 * Structured-plaintext marker. Text-only messages encrypt the raw string
 * (unchanged from Phase B); messages with attachments encrypt
 * `{"v":1,"t":text,"a":[metas]}`. The control-character prefix cannot
 * be typed, so raw text and structured payloads never collide.
 */
export const E2E_PAYLOAD_PREFIX = '\u0001';

export interface E2EAttachmentMeta {
  s3Key: string;
  /** true file name (server only ever sees E2E_ATTACHMENT_NAME) */
  fileName: string;
  /** true plaintext size in bytes */
  fileSize: number;
  /** true mime type (server only ever sees E2E_ATTACHMENT_MIME) */
  mimeType: string;
  /** AES-256-GCM file key, unpadded base64 */
  key: string;
  /** 12-byte GCM nonce, unpadded base64 */
  iv: string;
}

export function buildE2EPlaintext(text: string, attachments?: E2EAttachmentMeta[]): string {
  if (!attachments || attachments.length === 0) return text;
  return E2E_PAYLOAD_PREFIX + JSON.stringify({ v: 1, t: text, a: attachments });
}

function isValidAttachmentMeta(a: unknown): a is E2EAttachmentMeta {
  if (typeof a !== 'object' || a === null) return false;
  const m = a as Record<string, unknown>;
  return (
    typeof m.s3Key === 'string' && m.s3Key.length > 0 && m.s3Key.length <= 512 &&
    typeof m.fileName === 'string' && m.fileName.length > 0 && m.fileName.length <= 300 &&
    typeof m.fileSize === 'number' && Number.isFinite(m.fileSize) && m.fileSize > 0 &&
    typeof m.mimeType === 'string' && m.mimeType.length > 0 && m.mimeType.length <= 100 &&
    typeof m.key === 'string' && E2E_KEY_B64_RE.test(m.key) &&
    typeof m.iv === 'string' && E2E_IV_B64_RE.test(m.iv)
  );
}

/**
 * Parse decrypted plaintext into display text + attachment metas.
 * Raw (legacy / text-only) plaintext passes through untouched; malformed
 * structured payloads yield empty content (rendered as undecryptable) and
 * individually invalid metas are dropped — a peer's client authored this, so
 * it is validated like any untrusted input.
 */
export function parseE2EPlaintext(plaintext: string): { text: string; attachments: E2EAttachmentMeta[] } {
  if (!plaintext.startsWith(E2E_PAYLOAD_PREFIX)) {
    return { text: plaintext, attachments: [] };
  }
  try {
    const obj = JSON.parse(plaintext.slice(1)) as Record<string, unknown>;
    if (obj?.v !== 1 || typeof obj.t !== 'string' || !Array.isArray(obj.a)) {
      return { text: '', attachments: [] };
    }
    return { text: obj.t, attachments: obj.a.filter(isValidAttachmentMeta) };
  } catch {
    return { text: '', attachments: [] };
  }
}

// ─── Canonical signature payloads ────────────────────────────────────────────
// Signed by the device's Ed25519 key. Pipe-separated with a versioned domain
// prefix; every field is included so neither the server nor a MITM can splice
// keys between users or identities. Verified client-side before any session is
// established (and server-side on upload as hygiene).

// v2 binds the deviceId too: with multiple devices per account, a signature
// that omitted it could be replayed by the server under a different device
// slot of the same user. There is no v1 verification path anywhere.
const E2E_SIG_DOMAIN = 'voxium-e2e-v2';

/** Binding of a user's device identity: Curve25519 (Olm) + Ed25519 (signing). */
export function e2eDeviceCanonical(
  userId: string,
  deviceId: string,
  curve25519Key: string,
  ed25519Key: string
): string {
  return `${E2E_SIG_DOMAIN}|device|${userId}|${deviceId}|${curve25519Key}|${ed25519Key}`;
}

/** Binding of a one-time or fallback key to the device identity that published it. */
export function e2eKeyCanonical(
  userId: string,
  deviceId: string,
  curve25519IdentityKey: string,
  keyId: string,
  publicKey: string
): string {
  return `${E2E_SIG_DOMAIN}|key|${userId}|${deviceId}|${curve25519IdentityKey}|${keyId}|${publicKey}`;
}

// ─── Cross-signing canonicals (spec §14) ─────────────────────────────────────
// The account-level master key (Ed25519) signs itself once — proving possession
// of the private half — and then signs each of the account's devices. A device
// carrying a valid master signature is trusted transitively: peers verify the
// master key ONCE (out-of-band safety number) instead of every device.
//
// Deviation from Matrix: there is no separate self-signing key. Our master
// private key lives in the same vault as everything else, so the extra layer
// would buy no isolation — the master key signs devices directly.

/** Self-signature payload proving possession of the master private key. */
export function e2eMasterCanonical(userId: string, masterKeyB64: string): string {
  return `${E2E_SIG_DOMAIN}|master|${userId}|${masterKeyB64}`;
}

/** Binding of a device identity to the account master key (the cross-signature). */
export function e2eDeviceCrossCanonical(
  userId: string,
  deviceId: string,
  curve25519Key: string,
  ed25519Key: string
): string {
  return `${E2E_SIG_DOMAIN}|device-cross|${userId}|${deviceId}|${curve25519Key}|${ed25519Key}`;
}

// ─── Key distribution payload shapes ─────────────────────────────────────────

export interface E2EPreKey {
  keyId: string;
  key: string;
  signature: string;
}

export interface E2EDeviceRegistration {
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  oneTimeKeys: E2EPreKey[];
  fallbackKey: E2EPreKey;
}


/** One entry of a user's published device list. */
export interface E2EDeviceEntry {
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  /**
   * Cross-signature by the account master key over `e2eDeviceCrossCanonical`
   * (spec §14). `null` for devices registered before cross-signing, or not yet
   * approved from a device holding the master secret — such devices still work
   * (warn-not-block) but are surfaced as unsigned.
   */
  masterSignature?: string | null;
  createdAt: string;
}

/** A user's published account master key plus its self-signature (spec §14). */
export interface E2EMasterKeyInfo {
  masterKey: string;
  masterSignature: string;
}

/**
 * A user's full device list. `listVersion` is bumped on every add/revoke, on a
 * master-key publish/replace, and on any device signature change, so peers can
 * detect changes (and rotate their outbound group session).
 *
 * `masterKey`/`masterSignature` are the ACCOUNT-level pair (null when the user
 * has not bootstrapped cross-signing); each device's own `masterSignature` is
 * the cross-signature over that device.
 */
export interface E2EDeviceList {
  devices: E2EDeviceEntry[];
  listVersion: number;
  masterKey: string | null;
  masterSignature: string | null;
}

/**
 * Plaintext of a master-secret transfer (spec §14 / D6), encrypted pairwise
 * with Olm to another device of the SAME account before it leaves the device.
 * The server only ever stores the resulting olm1 envelope.
 *
 * The importer MUST derive the public key from `masterSecret` and check it
 * against the published master key before storing — any 32 bytes form a
 * syntactically valid Ed25519 secret.
 */
export interface E2EMasterTransferPayload {
  v: 1;
  /** Ed25519 master secret, unpadded base64. NEVER leaves a device unsealed. */
  masterSecret: string;
  /** Public half, for the pre-store consistency check. */
  masterKey: string;
}

/** One-shot key bundle for establishing an outbound session with ONE device. */
export interface E2EKeyBundle {
  userId: string;
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  preKey: E2EPreKey & { type: 'otk' | 'fallback' };
}

// ─── Group-session key distribution (spec §12) ───────────────────────────────

/**
 * Plaintext of a key share, encrypted pairwise with Olm before it ever leaves
 * the device. The server stores only the resulting olm1 envelope — it never
 * sees `sessionKey`. The importer must check `conversationId`/`sessionId`
 * against what it asked for and record `senderUserId` with the inbound
 * session, so a session can never be used to forge another user's messages.
 */
export interface E2EKeySharePayload {
  v: 2;
  /**
   * Group-session SCOPE, not always a literal conversation id: bare cuid for
   * a DM, `ch:{channelId}` for a secure channel (see parseE2EScope). The field
   * name predates secure channels and is kept for wire compatibility.
   */
  conversationId: string;
  sessionId: string;
  sessionKey: string;
  /**
   * How `sessionKey` is encoded. Absent/'session' = a fresh Megolm SessionKey.
   * 'exported' = an ExportedSessionKey re-derived from the sender's own copy
   * of the session (key-share retries — the sender keeps no raw key at rest).
   */
  keyType?: 'session' | 'exported';
  senderUserId: string;
  senderDeviceId: string;
}

// ─── E2E-authenticated call signaling (spec §20) ─────────────────────────────
//
// DM call media is P2P DTLS-SRTP (already end-to-end), but the DTLS handshake
// trusts fingerprints exchanged through the server's dm:voice:signal relay. So
// every signal payload (offer/answer/ICE candidate) travels as a pairwise-Olm
// olm1 envelope: fingerprints ride inside authenticated ciphertext, and a
// server substituting them fails against the pinned device identity. The
// structures below are the PLAINTEXT inside that envelope.

/** The WebRTC signal being carried. */
export type E2ECallSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: Record<string, unknown> };

/**
 * Olm plaintext of one call signal. The binding fields are re-verified by the
 * receiver AGAINST ITS OWN state (active call + pinned peer device) — never
 * trusted from the envelope alone (importKeyShare-style).
 *
 * `epoch` is a random per-signaling-session id: a reconnecting peer resets its
 * send counter, and the stationary side has no other reset signal, so the
 * receiver restarts its seq expectation whenever the epoch changes. Exact
 * replay is already impossible at the Olm layer (one-shot ratchet keys);
 * epoch+seq is ordering/replay defense-in-depth.
 */
export interface E2ECallSignalPlaintext {
  v: 1;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  epoch: string;
  /** Strictly increasing within an epoch, starting at 0. */
  seq: number;
  signal: E2ECallSignal;
}

/** Random epoch id: URL-safe, matches E2E_CALL_EPOCH_RE. */
export const E2E_CALL_EPOCH_RE = /^[A-Za-z0-9_-]{8,32}$/;

/** Serialized-plaintext ceiling (an audio SDP is ~3-6 KB; candidates are tiny). */
export const E2E_CALL_SIGNAL_PLAINTEXT_MAX = 24_576;

export function buildCallSignalPlaintext(p: E2ECallSignalPlaintext): string {
  return JSON.stringify(p);
}

/** Strict parse of a decrypted call-signal plaintext. Null on any deviation. */
export function parseCallSignalPlaintext(raw: string): E2ECallSignalPlaintext | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > E2E_CALL_SIGNAL_PLAINTEXT_MAX) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const p = obj as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0 || p.conversationId.length > 64) return null;
  if (typeof p.senderUserId !== 'string' || p.senderUserId.length === 0 || p.senderUserId.length > 64) return null;
  if (typeof p.senderDeviceId !== 'string' || !E2E_DEVICE_ID_RE.test(p.senderDeviceId)) return null;
  if (typeof p.epoch !== 'string' || !E2E_CALL_EPOCH_RE.test(p.epoch)) return null;
  if (typeof p.seq !== 'number' || !Number.isInteger(p.seq) || p.seq < 0) return null;
  const signal = p.signal as Record<string, unknown> | null | undefined;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return null;
  if (signal.type === 'offer' || signal.type === 'answer') {
    if (typeof signal.sdp !== 'string' || signal.sdp.length === 0) return null;
  } else if (signal.type === 'ice-candidate') {
    if (!signal.candidate || typeof signal.candidate !== 'object' || Array.isArray(signal.candidate)) return null;
  } else {
    return null;
  }
  // Exactly the declared keys — extra fields are a smuggling channel
  const keys = Object.keys(p).sort();
  if (keys.length !== 7 || keys.join(',') !== 'conversationId,epoch,senderDeviceId,senderUserId,seq,signal,v') return null;
  return obj as E2ECallSignalPlaintext;
}

// ─── Secure voice channels: E2E media frames + sealed sender keys (spec §21) ─
//
// Secure voice channels encrypt every encoded Opus frame client-side (WebRTC
// encoded transforms) so the SFU forwards payloads it cannot read. Each
// participant has its own AES-256-GCM sender key; the structures below define
// the frame prefix constants and the Olm-sealed plaintext that distributes a
// sender key to one peer device.

/** Frame format version carried in the header's high nibble. */
export const VOICE_FRAME_VERSION = 1;
/** `[1B version|keyId-nibble][4B BE seq]` prefix on every encrypted frame. */
export const VOICE_FRAME_HEADER_BYTES = 5;
/** AES-GCM authentication tag length. */
export const VOICE_FRAME_TAG_BYTES = 16;
/** Smallest valid encrypted frame: header + tag (empty DTX payload). */
export const VOICE_FRAME_MIN_BYTES = VOICE_FRAME_HEADER_BYTES + VOICE_FRAME_TAG_BYTES;
/**
 * Sender seq ceiling. Rotation is forced well before the u32 wraps so an IV
 * can never repeat under one key even in a pathological session (~2.7 years
 * of continuous audio — enforced anyway).
 */
export const VOICE_FRAME_SEQ_ROTATE_AT = 2 ** 32 - 2 ** 16;
/**
 * The string half of the frame AAD: `voxv1|chv:{channelId}|{senderUserId}`.
 * The 5-byte frame header is appended at encrypt time, binding channel,
 * sender, key generation, and sequence into the GCM tag.
 */
export function voiceFrameAadPrefix(channelId: string, senderUserId: string): string {
  return `voxv1|${e2eVoiceScope(channelId)}|${senderUserId}`;
}

/** Relay cap for a sealed voice-key envelope (olm1 string on the socket). */
export const VOICE_KEY_ENVELOPE_MAX = 16_384;
/** Serialized-plaintext ceiling for a sealed voice-key message. */
export const E2E_VOICE_KEY_PLAINTEXT_MAX = 1_024;
/** Key generation ceiling (full counter; the wire nibble is keyId mod 16). */
export const VOICE_KEY_ID_MAX = 2 ** 31;

/**
 * Olm plaintext distributing one sender media key to one peer device.
 * Binding fields are re-verified by the receiver AGAINST ITS OWN state
 * (active secure voice session + vetted participant device) — never trusted
 * from the envelope alone. `epoch` + `seq` follow the call-signal semantics:
 * receivers keep per-sender epoch/seq replay state and never accept a
 * superseded epoch again.
 */
export interface E2EVoiceKeyPlaintext {
  v: 1;
  /** `chv:{channelId}` — must parse as kind 'voice-channel'. */
  scope: string;
  senderUserId: string;
  senderDeviceId: string;
  epoch: string;
  /**
   * The RECIPIENT's session epoch, echoed from their voice:join announcement.
   * Without it, a key sealed to us in an earlier session still satisfies every
   * other binding after we rejoin (fresh sessions start with empty replay
   * state), so a server that WITHHELD an envelope could deliver it later and
   * re-install a dead generation — then replay the frames it recorded under
   * it, which still carry valid tags and AAD. Receivers accept only their
   * own current epoch, which no other party can predict.
   */
  recipientEpoch: string;
  /** Strictly increasing per epoch, starting at 0. */
  seq: number;
  /** Full key-generation counter for the sender's key. */
  keyId: number;
  /** 32-byte AES-256-GCM key, unpadded standard base64. */
  keyB64: string;
  /** Why this key exists — receivers use it for diagnostics only; the
   *  trial-ratchet on frames is what actually disambiguates transitions. */
  reason: 'initial' | 'ratchet' | 'fresh';
}

export function buildVoiceKeyPlaintext(p: E2EVoiceKeyPlaintext): string {
  return JSON.stringify(p);
}

/** Strict parse of a decrypted voice-key plaintext. Null on any deviation. */
export function parseVoiceKeyPlaintext(raw: string): E2EVoiceKeyPlaintext | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > E2E_VOICE_KEY_PLAINTEXT_MAX) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const p = obj as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.scope !== 'string' || parseE2EScope(p.scope).kind !== 'voice-channel') return null;
  if (p.scope.length > 64 + E2E_VOICE_SCOPE_PREFIX.length) return null;
  if (typeof p.senderUserId !== 'string' || p.senderUserId.length === 0 || p.senderUserId.length > 64) return null;
  if (typeof p.senderDeviceId !== 'string' || !E2E_DEVICE_ID_RE.test(p.senderDeviceId)) return null;
  if (typeof p.epoch !== 'string' || !E2E_CALL_EPOCH_RE.test(p.epoch)) return null;
  if (typeof p.recipientEpoch !== 'string' || !E2E_CALL_EPOCH_RE.test(p.recipientEpoch)) return null;
  if (typeof p.seq !== 'number' || !Number.isInteger(p.seq) || p.seq < 0) return null;
  if (typeof p.keyId !== 'number' || !Number.isInteger(p.keyId) || p.keyId < 0 || p.keyId >= VOICE_KEY_ID_MAX) return null;
  if (typeof p.keyB64 !== 'string' || !E2E_KEY_B64_RE.test(p.keyB64)) return null;
  if (p.reason !== 'initial' && p.reason !== 'ratchet' && p.reason !== 'fresh') return null;
  // Exactly the declared keys — extra fields are a smuggling channel
  const keys = Object.keys(p).sort();
  if (keys.length !== 10 || keys.join(',') !== 'epoch,keyB64,keyId,reason,recipientEpoch,scope,senderDeviceId,senderUserId,seq,v') return null;
  return obj as E2EVoiceKeyPlaintext;
}
