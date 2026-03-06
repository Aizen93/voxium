import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { BadRequestError, UnauthorizedError } from '../utils/errors';
import { LIMITS } from '@voxium/shared';

const APP_NAME = 'Voxium';
const ENCRYPTION_ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer | null {
  const key = process.env.TOTP_ENCRYPTION_KEY;
  if (!key) return null;
  return Buffer.from(key, 'hex');
}

function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext; // Fallback: store unencrypted if no key configured
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

function parseBackupCodes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) return parsed;
  } catch { /* malformed */ }
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
  if (delta !== null) return true;

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
