import crypto from 'crypto';

/**
 * AES-256-GCM secret box for small server-held secrets (the GitHub signing
 * secret of an incoming webhook), copied from services/totpService.ts (which
 * keeps its own, with its legacy leniencies) and keyed by the same
 * TOTP_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 *
 * Stored format, byte-identical to what totpService writes:
 *   enc:<iv hex (12 bytes)>:<auth tag hex (16 bytes)>:<ciphertext hex>
 *
 * Two TOTP-only leniencies are deliberately NOT copied:
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

const CANONICAL_KEY_RE = /^[0-9a-fA-F]{64}$/;

/** What every consumer of TOTP_ENCRYPTION_KEY says of a key that is set but cannot be used. */
export const ENCRYPTION_KEY_UNUSABLE_MESSAGE = 'TOTP_ENCRYPTION_KEY is set but cannot be used: it must be 64 hexadecimal characters (32 bytes)';

export type EncryptionKeyState =
  | { state: 'unset' }
  | { state: 'unusable' }
  /** `canonical`: exactly 64 hexadecimal characters, nothing after them */
  | { state: 'usable'; key: Buffer; canonical: boolean };

/**
 * TOTP_ENCRYPTION_KEY as every consumer reads it: this box, totpService and
 * the boot check (checkEncryptionKeyAtBoot), so the three never disagree on a
 * key. Unset when missing or empty. Decoded as hex, which stops at the first
 * character that is not part of a hex pair: usable when that gives exactly 32
 * bytes. A value that carries characters after its 64 hex ones (a trailing
 * CR or space from an env file) gives the same 32 bytes as without them, so
 * it stays usable, and is reported as not canonical.
 */
export function readEncryptionKey(value: string | undefined = process.env.TOTP_ENCRYPTION_KEY): EncryptionKeyState {
  if (!value) return { state: 'unset' };
  const key = Buffer.from(value, 'hex');
  if (key.length !== KEY_LENGTH) return { state: 'unusable' };
  return { state: 'usable', key, canonical: CANONICAL_KEY_RE.test(value) };
}

/** What index.ts says of the key before it starts anything: stop on `fatal`, print `warning`. */
export interface EncryptionKeyBootCheck {
  fatal: string | null;
  warning: string | null;
}

/**
 * The start-up check of TOTP_ENCRYPTION_KEY. Unset: production refuses to
 * start (TOTP secrets would be stored in plaintext), elsewhere a warning, as
 * before. Set but unusable: no environment starts, since every TOTP
 * enrolment and every GitHub webhook would fail on it. Usable with
 * characters after the key: starts, with a warning. No message repeats the
 * value or anything derived from it.
 */
export function checkEncryptionKeyAtBoot(env: NodeJS.ProcessEnv): EncryptionKeyBootCheck {
  const generate = 'Generate one with: openssl rand -hex 32';
  const read = readEncryptionKey(env.TOTP_ENCRYPTION_KEY);
  if (read.state === 'unset') {
    if (env.NODE_ENV === 'production') {
      return { fatal: `TOTP_ENCRYPTION_KEY is not set — refusing to start in production (TOTP secrets would be stored UNENCRYPTED). ${generate}`, warning: null };
    }
    return { fatal: null, warning: 'TOTP_ENCRYPTION_KEY is not set. TOTP secrets will be stored UNENCRYPTED in the database. Set this to a 32-byte hex string (64 characters) for production use.' };
  }
  if (read.state === 'unusable') {
    return { fatal: `${ENCRYPTION_KEY_UNUSABLE_MESSAGE} — refusing to start. ${generate}`, warning: null };
  }
  if (!read.canonical) {
    return { fatal: null, warning: 'TOTP_ENCRYPTION_KEY has characters after its first 64 hexadecimal characters; they are ignored. Set it to exactly 64 hexadecimal characters.' };
  }
  return { fatal: null, warning: null };
}

/** The usable key, or null (unset or unusable: the box is not configured). */
function getKey(): Buffer | null {
  const read = readEncryptionKey();
  return read.state === 'usable' ? read.key : null;
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
