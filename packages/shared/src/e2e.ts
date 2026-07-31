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
} as const;

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
