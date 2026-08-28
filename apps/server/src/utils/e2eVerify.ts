import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// DER prefix for a raw 32-byte Ed25519 public key wrapped as SPKI
// (SEQUENCE → AlgorithmIdentifier(id-Ed25519) → BIT STRING). Lets node:crypto
// verify vodozemac's raw base64 keys without extra dependencies.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify an Ed25519 signature over a UTF-8 message with a raw base64 public
 * key (unpadded, vodozemac encoding). Server-side hygiene check on key
 * uploads — the authoritative verification happens on clients (spec §4);
 * this only stops broken/malicious clients from publishing key material that
 * every peer would reject.
 */
export function verifyEd25519Signature(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const rawKey = Buffer.from(publicKeyB64, 'base64');
    if (rawKey.length !== 32) return false;
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch (err) {
    // Malformed key material — treat as verification failure, log for diagnosis
    console.warn('e2e: ed25519 verification threw:', err instanceof Error ? err.message : err);
    return false;
  }
}
