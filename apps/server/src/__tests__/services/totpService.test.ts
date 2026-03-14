import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as OTPAuth from 'otpauth';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,fakeQR'),
  },
}));

import { prisma } from '../../utils/prisma';
import {
  setupTOTP,
  enableTOTP,
  disableTOTP,
  verifyTOTP,
} from '../../services/totpService';

// ─── Environment ────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv.TOTP_ENCRYPTION_KEY = process.env.TOTP_ENCRYPTION_KEY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('totpService — setupTOTP', () => {
  it('generates secret and QR code data URL', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await setupTOTP('user-1');

    expect(result.secret).toBeDefined();
    expect(typeof result.secret).toBe('string');
    expect(result.secret.length).toBeGreaterThan(0);
    expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects if TOTP is already enabled', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpEnabled: true,
    } as any);

    await expect(setupTOTP('user-1'))
      .rejects.toThrow(/already enabled/i);
  });

  it('rejects if user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    await expect(setupTOTP('user-nonexistent'))
      .rejects.toThrow(/User not found/);
  });

  it('stores encrypted secret when TOTP_ENCRYPTION_KEY is set', async () => {
    // 32-byte key = 64 hex chars
    process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    await setupTOTP('user-1');

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    expect(updateCall.data.totpSecret).toMatch(/^enc:/);
  });

  it('stores unencrypted secret when TOTP_ENCRYPTION_KEY is not set', async () => {
    delete process.env.TOTP_ENCRYPTION_KEY;

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await setupTOTP('user-1');

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    // When no encryption key, stored value should be the raw base32 secret (no 'enc:' prefix)
    expect(updateCall.data.totpSecret).not.toMatch(/^enc:/);
    expect(updateCall.data.totpSecret).toBe(result.secret);
  });
});

describe('totpService — enableTOTP', () => {
  it('enables TOTP with a valid code and returns backup codes', async () => {
    // Generate a real secret and a valid code
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Voxium',
      label: 'testuser',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    const validCode = totp.generate();

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32, // unencrypted
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    // Clear encryption key so decryptSecret returns as-is
    delete process.env.TOTP_ENCRYPTION_KEY;

    const result = await enableTOTP('user-1', validCode);

    expect(result.backupCodes).toBeDefined();
    expect(result.backupCodes).toHaveLength(8); // TOTP_BACKUP_CODE_COUNT
    // Each backup code should be 8 hex chars
    for (const code of result.backupCodes) {
      expect(code).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('rejects invalid code', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32,
      totpEnabled: false,
    } as any);

    delete process.env.TOTP_ENCRYPTION_KEY;

    await expect(enableTOTP('user-1', '000000'))
      .rejects.toThrow(/Invalid verification code/);
  });

  it('rejects if TOTP already enabled', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: 'someSecret',
      totpEnabled: true,
    } as any);

    await expect(enableTOTP('user-1', '123456'))
      .rejects.toThrow(/already enabled/i);
  });

  it('rejects if no secret set up yet', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: null,
      totpEnabled: false,
    } as any);

    await expect(enableTOTP('user-1', '123456'))
      .rejects.toThrow(/set up/i);
  });
});

describe('totpService — verifyTOTP', () => {
  it('validates correct TOTP code', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Voxium',
      label: 'testuser',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    const validCode = totp.generate();

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32,
      totpBackupCodes: null,
    } as any);

    delete process.env.TOTP_ENCRYPTION_KEY;

    const result = await verifyTOTP('user-1', validCode);
    expect(result).toBe(true);
  });

  it('rejects incorrect TOTP code', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32,
      totpBackupCodes: null,
    } as any);

    delete process.env.TOTP_ENCRYPTION_KEY;

    const result = await verifyTOTP('user-1', '000000');
    expect(result).toBe(false);
  });

  it('returns false when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    const result = await verifyTOTP('user-nonexistent', '123456');
    expect(result).toBe(false);
  });

  it('returns false when no TOTP secret', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: null,
      totpBackupCodes: null,
    } as any);

    const result = await verifyTOTP('user-1', '123456');
    expect(result).toBe(false);
  });

  it('accepts valid backup code and consumes it', async () => {
    const bcrypt = await import('bcryptjs');
    const secret = new OTPAuth.Secret({ size: 20 });
    const backupCode = 'abcd1234';
    const hashedCode = await bcrypt.hash(backupCode, 4);
    const backupCodes = JSON.stringify([hashedCode, await bcrypt.hash('other1234', 4)]);

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32,
      totpBackupCodes: backupCodes,
    } as any);
    vi.mocked(prisma.user.updateMany).mockResolvedValueOnce({ count: 1 } as any);

    delete process.env.TOTP_ENCRYPTION_KEY;

    const result = await verifyTOTP('user-1', backupCode);
    expect(result).toBe(true);
    // Verify the backup code was consumed
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1', totpBackupCodes: backupCodes },
      }),
    );
  });
});

describe('totpService — disableTOTP', () => {
  it('disables TOTP with valid code', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Voxium',
      label: 'testuser',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    const validCode = totp.generate();

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32,
      totpEnabled: true,
      totpBackupCodes: null,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    delete process.env.TOTP_ENCRYPTION_KEY;

    await expect(disableTOTP('user-1', validCode)).resolves.not.toThrow();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          totpEnabled: false,
          totpSecret: null,
          totpBackupCodes: null,
        },
      }),
    );
  });

  it('rejects invalid code', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32,
      totpEnabled: true,
      totpBackupCodes: null,
    } as any);

    delete process.env.TOTP_ENCRYPTION_KEY;

    await expect(disableTOTP('user-1', '000000'))
      .rejects.toThrow(/Invalid verification code/);
  });

  it('rejects if TOTP not enabled', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: 'someSecret',
      totpEnabled: false,
      totpBackupCodes: null,
    } as any);

    await expect(disableTOTP('user-1', '123456'))
      .rejects.toThrow(/not enabled/i);
  });
});

describe('totpService — encrypt/decrypt roundtrip', () => {
  it('encrypted secret can be decrypted via setupTOTP + enableTOTP flow', async () => {
    // 32-byte key
    process.env.TOTP_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    // Setup captures the encrypted secret
    let storedSecret = '';
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args: any) => {
      storedSecret = args.data.totpSecret;
      return {} as any;
    });

    const setupResult = await setupTOTP('user-1');
    expect(storedSecret).toMatch(/^enc:/);

    // Now generate a valid code using the plain secret
    const totp = new OTPAuth.TOTP({
      issuer: 'Voxium',
      label: 'testuser',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setupResult.secret),
    });
    const validCode = totp.generate();

    // enableTOTP should be able to decrypt and validate
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: storedSecret, // encrypted!
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await enableTOTP('user-1', validCode);
    expect(result.backupCodes).toHaveLength(8);
  });
});

describe('totpService — unencrypted legacy secrets', () => {
  it('handles secrets without enc: prefix (legacy)', async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Voxium',
      label: 'testuser',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    const validCode = totp.generate();

    // Set encryption key, but the stored secret has no enc: prefix (legacy)
    process.env.TOTP_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      username: 'testuser',
      totpSecret: secret.base32, // plain, no enc: prefix
      totpEnabled: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await enableTOTP('user-1', validCode);
    expect(result.backupCodes).toHaveLength(8);
  });
});
