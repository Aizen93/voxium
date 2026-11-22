import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { BadRequestError, UnauthorizedError } from '../utils/errors';
import { LIMITS } from '@voxium/shared';
import { getRedis } from '../utils/redis';
import { readEncryptionKey, ENCRYPTION_KEY_UNUSABLE_MESSAGE } from '../utils/secretBox';
import { errorLabel } from '../utils/loggableError';

const APP_NAME = 'Voxium';
const ENCRYPTION_ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** The key as the secret box reads it; null when unset; a set key that cannot be used throws, by name, never falls back to plaintext. */
function getEncryptionKey(): Buffer | null {
  const read = readEncryptionKey();
  if (read.state === 'unset') return null;
  if (read.state === 'unusable') throw new Error(ENCRYPTION_KEY_UNUSABLE_MESSAGE);
  return read.key;
}

function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) {
    // Fail closed: never store a recoverable secret in plaintext in
    // production (index.ts also refuses to boot; this guards other entrypoints)
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TOTP_ENCRYPTION_KEY required in production');
    }
    console.warn('[TOTP] WARNING: TOTP_ENCRYPTION_KEY not set — TOTP secrets will be stored unencrypted. Set this env var in production!');
    return plaintext;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith('enc:')) return stored; // Unencrypted legacy value
  const key = getEncryptionKey();
  if (!key) throw new Error('TOTP_ENCRYPTION_KEY required to decrypt TOTP secrets');
  const parts = stored.split(':');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const encrypted = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

function createTOTP(secret: string, username: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: APP_NAME,
    label: username,
    algorithm: 'SHA1',
    digits: LIMITS.TOTP_CODE_LENGTH,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < LIMITS.TOTP_BACKUP_CODE_COUNT; i++) {
    // 8-character alphanumeric codes
    codes.push(crypto.randomBytes(4).toString('hex'));
  }
  return codes;
}

async function hashBackupCodes(codes: string[]): Promise<string> {
  const hashed = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
  return JSON.stringify(hashed);
}

/**
 * The stored backup codes as a list. Codes that cannot be read are lost to
 * the account, so the loss is logged once per call, by the error's name only
 * (a parse error's message quotes the stored text, which holds the hashes).
 */
function parseBackupCodes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) return parsed;
    console.warn('[TOTP] Stored backup codes are not a list of strings; treating the account as having none');
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    console.warn(`[TOTP] Stored backup codes could not be parsed (${name}); treating the account as having none`);
  }
  return [];
}

/** Generate a TOTP secret and QR code data URL for setup */
export async function setupTOTP(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, totpEnabled: true },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (user.totpEnabled) throw new BadRequestError('Two-factor authentication is already enabled');

  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: APP_NAME,
    label: user.username,
    algorithm: 'SHA1',
    digits: LIMITS.TOTP_CODE_LENGTH,
    period: 30,
    secret,
  });

  const uri = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(uri);

  // Store the secret encrypted (not enabled yet — user must verify first)
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: encryptSecret(secret.base32) },
  });

  return { secret: secret.base32, qrCodeDataUrl };
}

/** Verify a TOTP code and enable MFA */
export async function enableTOTP(userId: string, code: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, totpSecret: true, totpEnabled: true },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (user.totpEnabled) throw new BadRequestError('Two-factor authentication is already enabled');
  if (!user.totpSecret) throw new BadRequestError('Please set up two-factor authentication first');

  const totp = createTOTP(decryptSecret(user.totpSecret), user.username);
  const delta = totp.validate({ token: code, window: 1 });

  if (delta === null) throw new BadRequestError('Invalid verification code');

  // Generate backup codes
  const backupCodes = generateBackupCodes();
  const hashedCodes = await hashBackupCodes(backupCodes);

  await prisma.user.update({
    where: { id: userId },
    data: {
      totpEnabled: true,
      totpBackupCodes: hashedCodes,
    },
  });

  // Return plain backup codes (shown to user once)
  return { backupCodes };
}

/** Disable TOTP — requires a valid TOTP code or backup code */
export async function disableTOTP(userId: string, code: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, totpSecret: true, totpEnabled: true, totpBackupCodes: true },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (!user.totpEnabled) throw new BadRequestError('Two-factor authentication is not enabled');
  if (!user.totpSecret) throw new BadRequestError('TOTP secret not found');

  // Try regular TOTP code
  const totp = createTOTP(decryptSecret(user.totpSecret), user.username);
  const delta = totp.validate({ token: code, window: 1 });

  if (delta === null) {
    // Try backup codes
    let backupMatch = false;
    if (user.totpBackupCodes) {
      const hashedCodes = parseBackupCodes(user.totpBackupCodes);
      for (const hashedCode of hashedCodes) {
        if (await bcrypt.compare(code, hashedCode)) {
          backupMatch = true;
          break;
        }
      }
    }
    if (!backupMatch) throw new BadRequestError('Invalid verification code');
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      totpEnabled: false,
      totpSecret: null,
      totpBackupCodes: null,
    },
  });
}

// ─── Replay protection ──────────────────────────────────────────────────────
// A code that passed is recorded for the length of its validity window
// (`SET NX EX` in Redis, one key per account and code). While Redis cannot be
// asked, each node records the codes it accepts in memory for the same
// window, and the outage is logged at most once a minute.

const REPLAY_WINDOW_S = 90;
const LOCAL_REPLAY_MAX = 10_000;
const REPLAY_WARN_INTERVAL_MS = 60_000;

// replay key → expiry (ms). Insertion order is expiry order: every entry
// lives the same window, and a key is only inserted when absent.
const localUses = new Map<string, number>();
let lastReplayWarnAt = -Infinity;

function dropExpiredLocalUses(now: number): void {
  for (const [key, expiresAt] of localUses) {
    if (expiresAt > now) break;
    localUses.delete(key);
  }
}

function usedLocally(replayKey: string): boolean {
  if (localUses.size === 0) return false;
  const now = Date.now();
  dropExpiredLocalUses(now);
  return localUses.has(replayKey);
}

/** Record a use on this node: true for the first use within the window, false for a replay. */
function recordLocalUse(replayKey: string): boolean {
  const now = Date.now();
  dropExpiredLocalUses(now);
  if (localUses.has(replayKey)) return false;
  // Bounded: past the cap the oldest record goes first
  if (localUses.size >= LOCAL_REPLAY_MAX) {
    const oldest = localUses.keys().next().value;
    if (oldest !== undefined) localUses.delete(oldest);
  }
  localUses.set(replayKey, now + REPLAY_WINDOW_S * 1000);
  return true;
}

/** Redis down or refusing the write, once a minute at most: the error's name and string code, never its message (it can name the Redis host and port), the key (it holds the code) nor the account. */
function warnReplayCheckUnavailable(err: unknown): void {
  const now = Date.now();
  if (now - lastReplayWarnAt < REPLAY_WARN_INTERVAL_MS) return;
  lastReplayWarnAt = now;
  console.warn(`[TOTP] Redis did not record the replay check (${errorLabel(err)}); codes are checked against this node's memory until it does`);
}

/** Verify TOTP code during login */
export async function verifyTOTP(userId: string, code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, totpSecret: true, totpBackupCodes: true },
  });
  if (!user || !user.totpSecret) return false;

  // Try regular TOTP code first
  const totp = createTOTP(decryptSecret(user.totpSecret), user.username);
  const delta = totp.validate({ token: code, window: 1 });
  if (delta !== null) {
    // Replay protection: reject codes already used within the validity window
    const replayKey = `totp:used:${userId}:${code}`;
    // A use this node recorded while Redis could not be asked: Redis never
    // saw it, so it is refused here whatever Redis answers now
    if (usedLocally(replayKey)) return false;
    try {
      const redis = getRedis();
      const alreadyUsed = await redis.set(replayKey, '1', { NX: true, EX: REPLAY_WINDOW_S });
      if (!alreadyUsed) return false; // Code already used within the window
    } catch (err) {
      // Fail OPEN, like the rate limiters: a Redis outage must not lock every
      // 2FA account out of sign-in. The use is recorded on this node instead,
      // so a second use of the code here is still refused.
      warnReplayCheckUnavailable(err);
      return recordLocalUse(replayKey);
    }
    return true;
  }

  // Try backup codes — use optimistic concurrency to prevent concurrent reuse
  if (user.totpBackupCodes) {
    const hashedCodes = parseBackupCodes(user.totpBackupCodes);
    for (let i = 0; i < hashedCodes.length; i++) {
      const match = await bcrypt.compare(code, hashedCodes[i]);
      if (match) {
        // Atomically remove the used code only if totpBackupCodes hasn't changed
        const remaining = [...hashedCodes];
        remaining.splice(i, 1);
        const result = await prisma.user.updateMany({
          where: { id: userId, totpBackupCodes: user.totpBackupCodes },
          data: { totpBackupCodes: JSON.stringify(remaining) },
        });
        // If count is 0, a concurrent request already consumed/changed the codes
        if (result.count > 0) return true;
      }
    }
  }

  return false;
}
