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

  it('stores unencrypted secret when TOTP_ENCRYPTION_KEY is not set (non-production only)', async () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    // The plaintext fallback only exists outside production — pin the env so
    // this test stays valid if the suite ever runs with NODE_ENV=production
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    savedEnv.NODE_ENV = savedNodeEnv;

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

  it('a key that is set but does not give 32 bytes is refused by name, in every environment, never as plaintext (#51)', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    savedEnv.NODE_ENV = savedNodeEnv;
    for (const NODE_ENV of ['development', 'production']) {
      process.env.NODE_ENV = NODE_ENV;
      process.env.TOTP_ENCRYPTION_KEY = 'ab'.repeat(31); // 31 bytes
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ username: 'testuser', totpEnabled: false } as any);

      await expect(setupTOTP('user-1')).rejects.toThrow('TOTP_ENCRYPTION_KEY is set but cannot be used: it must be 64 hexadecimal characters (32 bytes)');
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
  });

  it('FAILS CLOSED in production when TOTP_ENCRYPTION_KEY is not set', async () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        username: 'testuser',
        totpEnabled: false,
      } as any);

      await expect(setupTOTP('user-1'))
        .rejects.toThrow(/TOTP_ENCRYPTION_KEY required in production/);
      // Nothing plaintext must reach the DB
      expect(prisma.user.update).not.toHaveBeenCalled();
    } finally {
      if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
      else delete process.env.NODE_ENV;
    }
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

describe('totpService — verifyTOTP replay protection (#103)', () => {
  // Fresh module state per test: the node-local record and the warning
  // throttle live in totpService's module scope
  async function freshService(set: (...args: unknown[]) => Promise<unknown>) {
    vi.resetModules();
    const { prisma: db } = await import('../../utils/prisma');
    const { getRedis } = await import('../../utils/redis');
    vi.mocked(getRedis).mockReturnValue({ set: vi.fn(set) } as never);
    const service = await import('../../services/totpService');
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: 'Voxium', label: 'testuser', algorithm: 'SHA1', digits: 6, period: 30, secret });
    vi.mocked(db.user.findUnique).mockResolvedValue({ username: 'testuser', totpSecret: secret.base32, totpBackupCodes: null } as never);
    delete process.env.TOTP_ENCRYPTION_KEY;
    return { verify: service.verifyTOTP, code: () => totp.generate(), secret: secret.base32, getRedis };
  }

  afterEach(() => { vi.useRealTimers(); });

  it('with Redis up, a second use of the same code is refused (SET NX finds the first)', async () => {
    const used = new Set<string>();
    const { verify, code } = await freshService(async (key) => {
      if (used.has(String(key))) return null;
      used.add(String(key));
      return 'OK';
    });
    const c = code();
    expect(await verify('user-r1', c)).toBe(true);
    expect(await verify('user-r1', c)).toBe(false);
  });

  it('with Redis failing, a code is accepted once and refused the second time on this node', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { verify, code } = await freshService(async () => { throw new Error('The client is closed'); });
      const c = code();
      expect(await verify('user-r2', c)).toBe(true);
      expect(await verify('user-r2', c)).toBe(false);
      // another account's use of the same digits is its own
      expect(await verify('user-r3', c)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the outage once a minute at most, with the error\'s name and message and never the code, the secret or the account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { verify, code, secret } = await freshService(async () => { throw Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' }); });
      const c = code();
      await verify('user-r4', c);
      await verify('user-r4', c);
      await verify('user-r5', c);
      const said = () => warn.mock.calls.filter((call) => String(call[0]).startsWith('[TOTP]'));
      expect(said()).toHaveLength(1);
      const line = said()[0].map(String).join(' ');
      expect(line).toContain('SocketClosedUnexpectedlyError');
      expect(line).toContain('Socket closed unexpectedly');
      expect(line).not.toContain(c);
      expect(line).not.toContain(secret);
      expect(line).not.toContain('user-r4');
      expect(line).not.toContain('totp:used');

      vi.setSystemTime(new Date('2026-11-16T10:01:01Z'));
      await verify('user-r6', code());
      expect(said()).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('a code accepted during the outage stays refused on this node once Redis answers again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let redisUp = false;
      const { verify, code } = await freshService(async () => {
        if (!redisUp) throw new Error('Connection timeout');
        return 'OK'; // Redis never saw the first use
      });
      const c = code();
      expect(await verify('user-r7', c)).toBe(true);
      redisUp = true;
      expect(await verify('user-r7', c)).toBe(false);
      // a fresh code goes through Redis as usual
      expect(await verify('user-r8', c)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a wrong code is refused without asking Redis', async () => {
    const set = vi.fn(async () => 'OK');
    const { verify } = await freshService(set);
    expect(await verify('user-r9', '000000')).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  describe('the node-local record: 90 seconds, at most 10,000 codes', () => {
    // Any code starting with "ok" is a valid TOTP code here, whatever the
    // clock says, so the record's own lifetime is what the tests observe
    async function serviceWithRedisDown() {
      vi.resetModules();
      vi.doMock('otpauth', () => ({
        Secret: { fromBase32: () => ({}) },
        TOTP: class { validate({ token }: { token: string }) { return token.startsWith('ok') ? 0 : null; } },
      }));
      const { prisma: db } = await import('../../utils/prisma');
      const { getRedis } = await import('../../utils/redis');
      vi.mocked(getRedis).mockReturnValue({ set: vi.fn(async () => { throw new Error('The client is closed'); }) } as never);
      vi.mocked(db.user.findUnique).mockResolvedValue({ username: 'testuser', totpSecret: 'JBSWY3DPEHPK3PXP', totpBackupCodes: null } as never);
      delete process.env.TOTP_ENCRYPTION_KEY;
      return (await import('../../services/totpService')).verifyTOTP;
    }

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => {
      warn.mockRestore();
      vi.doUnmock('otpauth');
      vi.useRealTimers();
    });

    it('a code is refused for 90 seconds after its use, and is a new use after that', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
      const verify = await serviceWithRedisDown();

      expect(await verify('user-e1', 'ok-111111')).toBe(true);
      vi.setSystemTime(new Date('2026-11-16T10:01:29.999Z'));
      expect(await verify('user-e1', 'ok-111111')).toBe(false);
      vi.setSystemTime(new Date('2026-11-16T10:01:30.001Z'));
      expect(await verify('user-e1', 'ok-111111')).toBe(true);
    });

    it('past 10,000 recorded codes the oldest is dropped first, and only it', async () => {
      const verify = await serviceWithRedisDown();
      for (let n = 0; n < 10_000; n++) {
        expect(await verify(`user-c${n}`, 'ok-222222')).toBe(true);
      }
      // the record is full: the oldest is still refused
      expect(await verify('user-c0', 'ok-222222')).toBe(false);
      // one more use pushes the oldest out
      expect(await verify('user-c10000', 'ok-222222')).toBe(true);
      expect(await verify('user-c0', 'ok-222222')).toBe(true);
      // ...and that re-recording pushed out the next oldest, not a newer one
      expect(await verify('user-c9999', 'ok-222222')).toBe(false);
      expect(await verify('user-c1', 'ok-222222')).toBe(true);
    });
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
