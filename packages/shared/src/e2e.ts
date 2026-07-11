// ─── E2E DM encryption — shared protocol pieces (docs/e2e-dm-spec.md) ────────
//
// This module defines everything the client and server must agree on byte-for-
// byte: the ciphertext envelope format and the canonical strings that device /
// prekey signatures are computed over. No crypto happens here — only encoding
// and validation.

/** Engine identifier for envelope `e` field. v1 = Olm via vodozemac. */
export const E2E_ENGINE_OLM1 = 'olm1';

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
} as const;

/** 32-byte key, unpadded standard base64 (vodozemac canonical encoding). */
export const E2E_KEY_B64_RE = /^[A-Za-z0-9+/]{43}$/;
/** 64-byte Ed25519 signature, unpadded standard base64. */
export const E2E_SIGNATURE_B64_RE = /^[A-Za-z0-9+/]{86}$/;
/** vodozemac KeyId, unpadded standard base64 (short). */
export const E2E_KEY_ID_B64_RE = /^[A-Za-z0-9+/]{1,32}$/;
/** Envelope body: unpadded standard base64 ciphertext. */
const E2E_BODY_B64_RE = /^[A-Za-z0-9+/]+$/;

/**
 * Ciphertext envelope stored as `Message.content` when `Message.encrypted`.
 * `v` = envelope version, `e` = engine id, `t` = Olm message type
 * (0 = pre-key, 1 = normal), `b` = unpadded-base64 ciphertext.
 */
export interface E2EEnvelope {
  v: 1;
  e: typeof E2E_ENGINE_OLM1;
  t: 0 | 1;
  b: string;
}

export function buildE2EEnvelope(messageType: 0 | 1, bodyB64: string): string {
  return JSON.stringify({ v: 1, e: E2E_ENGINE_OLM1, t: messageType, b: bodyB64 });
}

/**
 * Strict structural validation. Returns the parsed envelope or null.
 * Used by the server before storing (never sanitizes/trusts ciphertext) and
 * by clients before attempting decryption.
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
  if (obj.e !== E2E_ENGINE_OLM1) return null;
  if (obj.t !== 0 && obj.t !== 1) return null;
  if (typeof obj.b !== 'string' || obj.b.length === 0 || !E2E_BODY_B64_RE.test(obj.b)) return null;
  return { v: 1, e: E2E_ENGINE_OLM1, t: obj.t, b: obj.b };
}

// ─── Canonical signature payloads ────────────────────────────────────────────
// Signed by the device's Ed25519 key. Pipe-separated with a versioned domain
// prefix; every field is included so neither the server nor a MITM can splice
// keys between users or identities. Verified client-side before any session is
// established (and server-side on upload as hygiene).

const E2E_SIG_DOMAIN = 'voxium-e2e-v1';

/** Binding of a user's device identity: Curve25519 (Olm) + Ed25519 (signing). */
export function e2eDeviceCanonical(userId: string, curve25519Key: string, ed25519Key: string): string {
  return `${E2E_SIG_DOMAIN}|device|${userId}|${curve25519Key}|${ed25519Key}`;
}

/** Binding of a one-time or fallback key to the device identity that published it. */
export function e2eKeyCanonical(
  userId: string,
  curve25519IdentityKey: string,
  keyId: string,
  publicKey: string
): string {
  return `${E2E_SIG_DOMAIN}|key|${userId}|${curve25519IdentityKey}|${keyId}|${publicKey}`;
}

// ─── Key distribution payload shapes ─────────────────────────────────────────

export interface E2EPreKey {
  keyId: string;
  key: string;
  signature: string;
}

export interface E2EDeviceRegistration {
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  oneTimeKeys: E2EPreKey[];
  fallbackKey: E2EPreKey;
}

/** Public device info (identity pinning + "can this user do E2E?"). */
export interface E2EDeviceInfo {
  userId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  updatedAt: string;
}

/** One-shot key bundle for establishing an outbound session. */
export interface E2EKeyBundle {
  userId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  preKey: E2EPreKey & { type: 'otk' | 'fallback' };
}
