import crypto from 'crypto';

/**
 * AES-256-GCM secret box for small server-held secrets (the GitHub signing
 * secret of an incoming webhook), lifted from services/totpService.ts and
 * keyed by the same TOTP_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 *
 * Stored format, byte-identical to what totpService writes:
 *   enc:<iv hex (12 bytes)>:<auth tag hex (16 bytes)>:<ciphertext hex>
 *
 * Two TOTP-only leniencies are deliberately NOT lifted:
 * - sealSecret() never falls back to plaintext, in any environment: without a
 *   usable key it throws SecretBoxUnavailableError and the caller stores
 *   nothing (dev without a key simply cannot create such secrets).
 * - openSecret() never treats a value without the `enc:` prefix as a legacy
 *   plaintext secret: it refuses it.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PREFIX = 'enc:';
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

/** No usable TOTP_ENCRYPTION_KEY: nothing can be sealed or opened. */
export class SecretBoxUnavailableError extends Error {
  constructor(message = 'TOTP_ENCRYPTION_KEY is not configured (64 hex characters required)') {
    super(message);
    this.name = 'SecretBoxUnavailableError';
    Object.setPrototypeOf(this, SecretBoxUnavailableError.prototype);
  }
}

/** Decoded exactly as totpService decodes it, so one key opens both. */
function getKey(): Buffer | null {
  const hex = process.env.TOTP_ENCRYPTION_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  return key.length === KEY_LENGTH ? key : null;
}

/** Whether a key is present and decodes to 32 bytes. */
export function isSecretBoxConfigured(): boolean {
  return getKey() !== null;
}

/** Seal `plaintext`; throws SecretBoxUnavailableError without a usable key. */
export function sealSecret(plaintext: string): string {
  const key = getKey();
  if (!key) throw new SecretBoxUnavailableError();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Open a value sealed by sealSecret() (or by totpService). Throws on a value
 * without the `enc:` prefix, a malformed value, a missing key
 * (SecretBoxUnavailableError) and a failed authentication tag (wrong key or
 * tampered value). Never returns anything it could not authenticate.
 */
export function openSecret(stored: string): string {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) {
    throw new Error('Refusing to open a value that is not sealed');
  }
  const parts = stored.split(':');
  if (parts.length !== 4 || !parts.slice(1).every((p) => HEX_RE.test(p))) {
    throw new Error('Malformed sealed value');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const encrypted = Buffer.from(parts[3], 'hex');
  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Malformed sealed value');
  }
  const key = getKey();
  if (!key) throw new SecretBoxUnavailableError();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error('Sealed value failed authentication', { cause: err });
  }
}
