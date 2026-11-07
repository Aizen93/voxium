import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as OTPAuth from 'otpauth';

// totpService is imported for the interop tests (its private box must open
// with ours and vice versa); its I/O is mocked
vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue({
    set: vi.fn().mockResolvedValue('OK'),
  }),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,fakeQR') },
}));

import { prisma } from '../../utils/prisma';
import { setupTOTP, verifyTOTP } from '../../services/totpService';
import {
  isSecretBoxConfigured,
  sealSecret,
  openSecret,
  SecretBoxUnavailableError,
} from '../../utils/secretBox';

const KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const OTHER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const savedKey = process.env.TOTP_ENCRYPTION_KEY;
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TOTP_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  if (savedKey !== undefined) process.env.TOTP_ENCRYPTION_KEY = savedKey;
  else delete process.env.TOTP_ENCRYPTION_KEY;
  if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
  else delete process.env.NODE_ENV;
});

/** Flip one hex digit at `index` of the value. */
function flipHexAt(value: string, index: number): string {
  const c = value[index];
  return value.slice(0, index) + (c === '0' ? '1' : '0') + value.slice(index + 1);
}

describe('secretBox — isSecretBoxConfigured', () => {
  it('is true for a 64-hex-character key', () => {
    expect(isSecretBoxConfigured()).toBe(true);
  });

  it('is false without a key', () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    expect(isSecretBoxConfigured()).toBe(false);
  });

  it('is false for an empty key', () => {
    process.env.TOTP_ENCRYPTION_KEY = '';
    expect(isSecretBoxConfigured()).toBe(false);
  });

  it('is false for a key that does not decode to 32 bytes', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'ab'.repeat(16); // 16 bytes
    expect(isSecretBoxConfigured()).toBe(false);
    process.env.TOTP_ENCRYPTION_KEY = 'zz'.repeat(32); // not hex: decodes to 0 bytes
    expect(isSecretBoxConfigured()).toBe(false);
  });
});

describe('secretBox — sealSecret / openSecret', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('whsec_round-trip value');
    expect(openSecret(sealed)).toBe('whsec_round-trip value');
  });

  it('round-trips the empty string and non-ASCII text', () => {
    expect(openSecret(sealSecret(''))).toBe('');
    expect(openSecret(sealSecret('clé secrète 秘密'))).toBe('clé secrète 秘密');
  });

  it('writes the enc:iv:tag:ciphertext hex format (12-byte IV, 16-byte tag)', () => {
    const sealed = sealSecret('abc');
    expect(sealed).toMatch(/^enc:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]{6}$/);
  });

  it('never seals the same value to the same output (random IV)', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });

  it('never leaves the plaintext in the sealed value', () => {
    expect(sealSecret('plaintext-marker')).not.toContain('plaintext-marker');
  });

  it('throws on a tampered ciphertext, tag or IV', () => {
    const sealed = sealSecret('tamper me');
    const [prefix, iv, tag, ct] = sealed.split(':');
    expect(() => openSecret([prefix, iv, tag, flipHexAt(ct, 0)].join(':'))).toThrow('Sealed value failed authentication');
    expect(() => openSecret([prefix, iv, flipHexAt(tag, 5), ct].join(':'))).toThrow('Sealed value failed authentication');
    expect(() => openSecret([prefix, flipHexAt(iv, 3), tag, ct].join(':'))).toThrow('Sealed value failed authentication');
  });

  it('throws when opened with a different key', () => {
    const sealed = sealSecret('wrong key');
    process.env.TOTP_ENCRYPTION_KEY = OTHER_KEY;
    expect(() => openSecret(sealed)).toThrow('Sealed value failed authentication');
  });

  it('refuses a value without the enc: prefix (no legacy plaintext path)', () => {
    expect(() => openSecret('JBSWY3DPEHPK3PXP')).toThrow('Refusing to open a value that is not sealed');
    expect(() => openSecret('')).toThrow('Refusing to open a value that is not sealed');
    expect(() => openSecret('ENC:00:00:00')).toThrow('Refusing to open a value that is not sealed');
  });

  it('refuses a non-string value', () => {
    expect(() => openSecret(undefined as unknown as string)).toThrow('Refusing to open a value that is not sealed');
  });

  it('refuses malformed sealed values', () => {
    const sealed = sealSecret('x');
    const [, iv, tag, ct] = sealed.split(':');
    expect(() => openSecret(`enc:${iv}:${tag}`)).toThrow('Malformed sealed value');
    expect(() => openSecret(`enc:${iv}:${tag}:${ct}:extra`)).toThrow('Malformed sealed value');
    expect(() => openSecret(`enc:${iv}:${tag}:zz`)).toThrow('Malformed sealed value');
    expect(() => openSecret(`enc:${iv.slice(2)}:${tag}:${ct}`)).toThrow('Malformed sealed value');
    expect(() => openSecret(`enc:${iv}:${tag.slice(2)}:${ct}`)).toThrow('Malformed sealed value');
  });

  it('sealSecret throws SecretBoxUnavailableError without a key — in every environment, never plaintext', () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    for (const env of ['development', 'test', 'production']) {
      process.env.NODE_ENV = env;
      expect(() => sealSecret('no key')).toThrow(SecretBoxUnavailableError);
    }
  });

  it('sealSecret throws SecretBoxUnavailableError for a key of the wrong length', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'ab'.repeat(16);
    expect(() => sealSecret('short key')).toThrow(SecretBoxUnavailableError);
  });

  it('openSecret throws SecretBoxUnavailableError without a key', () => {
    const sealed = sealSecret('then the key goes away');
    delete process.env.TOTP_ENCRYPTION_KEY;
    expect(() => openSecret(sealed)).toThrow(SecretBoxUnavailableError);
  });

  it('SecretBoxUnavailableError is an Error with its own name', () => {
    const err = new SecretBoxUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SecretBoxUnavailableError);
    expect(err.name).toBe('SecretBoxUnavailableError');
  });
});

describe('secretBox — interop with totpService (same key, same format)', () => {
  it('opens a value sealed by totpService', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ username: 'alice', totpEnabled: false } as never);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

    const { secret } = await setupTOTP('user-1');
    const stored = vi.mocked(prisma.user.update).mock.calls[0][0].data.totpSecret as string;

    expect(stored).toMatch(/^enc:/);
    expect(openSecret(stored)).toBe(secret);
  });

  it('a value sealed here is accepted by totpService', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'alice',
      totpSecret: sealSecret(secret.base32),
      totpBackupCodes: null,
    } as never);
    const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret }).generate();

    await expect(verifyTOTP('user-1', code)).resolves.toBe(true);
  });
});
