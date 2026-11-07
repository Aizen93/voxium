import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    ipBan: { findUnique: vi.fn() },
    ipRecord: { upsert: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../../utils/email', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  describeEmailError: vi.fn((e: unknown) => String(e)),
  // A real class: the service tells it apart with instanceof
  MailSuppressedError: class MailSuppressedError extends Error {
    constructor() { super('Mail to this address is blocked'); this.name = 'MailSuppressedError'; }
  },
}));

// The suppression list ("Not you? Block Voxium mail to this address"), asked
// by the resend path before it spends a cap or rewrites a token.
const { mailSuppressed } = vi.hoisted(() => ({ mailSuppressed: vi.fn().mockResolvedValue(false) }));
vi.mock('../../utils/mailSuppression', () => ({ isMailSuppressed: (...a: unknown[]) => mailSuppressed(...a) }));

const redisIncr = vi.fn();
const redisExpire = vi.fn();
const redisGet = vi.fn();
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ incr: redisIncr, expire: redisExpire, get: redisGet }),
}));

const { mailCap } = vi.hoisted(() => ({
  mailCap: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../middleware/rateLimiter', async (importOriginal) => {
  // normalizeIp is a pure function with no store behind it — the real one is
  // exactly what loginUser's key agreement must be tested against, so it is
  // NOT stubbed. (Registration's own suite is signupService.test.ts.)
  const actual = await importOriginal<typeof import('../../middleware/rateLimiter')>();
  return {
    normalizeIp: actual.normalizeIp,
    consumeMailCap: mailCap,
  };
});

vi.mock('../../utils/sanitize', () => ({
  sanitizeText: vi.fn((str: unknown) => typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : ''),
}));

import { prisma } from '../../utils/prisma';
import {
  loginUser,
  generateTokens,
  verifyEmail,
  resendVerificationEmail,
  requestPasswordReset,
  resetPassword,
  changePassword,
} from '../../services/authService';

// ─── Setup ──────────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure JWT secrets are set
  savedEnv.JWT_SECRET = process.env.JWT_SECRET;
  savedEnv.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing-12345';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-jwt-refresh-secret-key-12345';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('authService — verification email hygiene', () => {
  it('verifyEmail stamps emailVerifiedAt', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    await verifyEmail('a'.repeat(64));

    const update = vi.mocked(prisma.user.update).mock.calls[0][0] as any;
    expect(update.data.emailVerified).toBe(true);
    expect(update.data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('caps verification emails PER CANONICAL INBOX — a bot-owned account cannot drip-harass the real mailbox owner', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1', email: 'j.doe@gmail.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);

    mailCap.mockResolvedValueOnce(false);
    await expect(resendVerificationEmail('user-1'))
      .rejects.toThrow('Too many verification emails requested');
    // Keyed on the CANONICAL inbox (gmail dots stripped), in the 'rl:' bucket
    // the e2e fixture and the admin rate-limit API can both reach.
    expect(mailCap).toHaveBeenCalledWith('verifyMail', 'jdoe@gmail.com');

    mailCap.mockResolvedValueOnce(true);
    await expect(resendVerificationEmail('user-1')).resolves.toBeUndefined();
  });

  it('the cap FAILS OPEN on store errors — a broken counter must not lock users out of verifying', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', email: 'someone@example.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    // consumeMailCap swallows store failures and answers "allowed" — the
    // fail-open contract now lives in the helper, asserted in its own suite.
    mailCap.mockResolvedValueOnce(true);

    await expect(resendVerificationEmail('user-1')).resolves.toBeUndefined();
  });
});

describe('authService — a mailbox that blocked Voxium mail', () => {
  beforeEach(() => {
    mailSuppressed.mockReset().mockResolvedValue(false);
    mailCap.mockClear();
  });

  it('resend answers a 400 that says how to undo the block, BEFORE any cap is spent or token rewritten', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', email: 'victim+7@outlook.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockClear();
    mailSuppressed.mockResolvedValueOnce(true);

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Mail to this address is blocked — use the link in an earlier Voxium email to allow it again',
    });
    expect(mailSuppressed).toHaveBeenCalledWith('victim+7@outlook.com');
    expect(mailCap).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    const { sendVerificationEmail } = await import('../../utils/email');
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('resend maps the sender\'s own refusal (a block landing between the check and the send) to the same 400', async () => {
    const { sendVerificationEmail, MailSuppressedError } = await import('../../utils/email');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', email: 'victim@example.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new MailSuppressedError());

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 400, message: /blocked/ });
  });

  it('resend still surfaces a transport failure as the error it is', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', email: 'victim@example.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('relay refused'));

    await expect(resendVerificationEmail('user-1')).rejects.toThrow('relay refused');
  });


  it('password reset answers as always and logs the skipped mail at WARN', async () => {
    const { sendPasswordResetEmail, MailSuppressedError } = await import('../../utils/email');
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(new MailSuppressedError());
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'victim@example.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(requestPasswordReset('victim@example.com')).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));

    expect(warn).toHaveBeenCalledWith('[Auth] Password-reset mail skipped: the mailbox blocked Voxium mail');
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});


describe('authService — password-reset mail cap', () => {
  it('SILENTLY stops sending once the inbox is capped (no enumeration signal)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'j.doe@gmail.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);

    mailCap.mockResolvedValueOnce(false);
    // Same resolved outcome as success — the response must not change
    await expect(requestPasswordReset('j.doe@gmail.com')).resolves.toBeUndefined();
    expect(mailCap).toHaveBeenCalledWith('resetMail', 'jdoe@gmail.com'); // canonical key
    // ...but no token was stored and no mail went out
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('sends normally under the cap and when the store is unreachable (fail open)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'someone@example.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);

    mailCap.mockResolvedValueOnce(true);
    await requestPasswordReset('someone@example.com');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);

    // consumeMailCap answers "allowed" on a store failure — see its own suite
    mailCap.mockResolvedValueOnce(true);
    await requestPasswordReset('someone@example.com');
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
  });
});

describe('authService — loginUser', () => {
  it('tells the client whether the account still has to accept the legal documents', async () => {
    const bcrypt = await import('bcryptjs');
    const password = await bcrypt.hash('ValidPass123', 4);
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...mockUser, password, termsAcceptedAt: null, privacyAcceptedAt: null } as any);
    const legacy = await loginUser('test@example.com', 'ValidPass123');
    expect((legacy as { user: { consentRequired: boolean } }).user.consentRequired).toBe(true);

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...mockUser, password, termsAcceptedAt: new Date(), privacyAcceptedAt: new Date() } as any);
    const fresh = await loginUser('test@example.com', 'ValidPass123');
    const user = (fresh as { user: Record<string, unknown> }).user;
    expect(user.consentRequired).toBe(false);
    // The timestamps are an accountability record, not a client field
    expect(user).not.toHaveProperty('termsAcceptedAt');
  });


  const mockUser = {
    id: 'user-1',
    username: 'testuser',
    displayName: 'testuser',
    email: 'test@example.com',
    avatarUrl: null,
    bio: null,
    status: 'online',
    role: 'user',
    password: '$2a$12$LJ3m4ys3zCBSVxI.DH0MWui0I/QhGSQFM6d9fKGFxBIFe6Y5IcUmK', // "ValidPass123" hashed
    totpEnabled: false,
    emailVerified: true,
    isSupporter: false,
    supporterTier: null,
    tokenVersion: 0,
    bannedAt: null,
    banReason: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.ipRecord.upsert).mockResolvedValue({} as any);
  });

  it('returns tokens on valid credentials', async () => {
    // Need to create a real bcrypt hash
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('ValidPass123', 4);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      ...mockUser,
      password: hash,
    } as any);

    const result = await loginUser('test@example.com', 'ValidPass123');
    expect(result).toHaveProperty('accessToken');
    expect(result).toHaveProperty('refreshToken');
    expect(result).toHaveProperty('user');
    // Password should not be in result
    expect((result as any).user?.password).toBeUndefined();
  });

  it('normalizes email to lowercase', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('ValidPass123', 4);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      ...mockUser,
      password: hash,
    } as any);

    await loginUser('TEST@EXAMPLE.COM', 'ValidPass123');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'test@example.com' } }),
    );
  });

  it('matches IP bans on the SAME canonical address every other control uses', async () => {
    // loginUser carried the last private copy of the `::ffff:` strip:
    // case-sensitive, blind to zone ids and to the hex IPv4-mapped form. An
    // `::FFFF:` client reached ipBan as an IPv6 string no ban row is written
    // as, so the ban silently stopped applying — and nothing on the happy path
    // notices a keyed control that fails open.
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('ValidPass123', 4);

    for (const raw of ['::ffff:203.0.113.7', '::FFFF:203.0.113.7', '203.0.113.7']) {
      vi.mocked(prisma.ipBan.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...mockUser, password: hash } as any);
      await loginUser('test@example.com', 'ValidPass123', true, raw);
      expect(prisma.ipBan.findUnique, raw).toHaveBeenCalledWith({ where: { ip: '203.0.113.7' } });
      vi.mocked(prisma.ipBan.findUnique).mockClear();
    }
  });

  it('rejects invalid credentials (wrong password)', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('ValidPass123', 4);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      ...mockUser,
      password: hash,
    } as any);

    await expect(loginUser('test@example.com', 'WrongPassword1'))
      .rejects.toThrow(/Invalid credentials/);
  });

  it('rejects non-existent user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    await expect(loginUser('nobody@example.com', 'ValidPass123'))
      .rejects.toThrow(/Invalid credentials/);
  });

  it('returns totpRequired when TOTP is enabled', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('ValidPass123', 4);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      ...mockUser,
      password: hash,
      totpEnabled: true,
    } as any);

    const result = await loginUser('test@example.com', 'ValidPass123');
    expect(result).toHaveProperty('totpRequired', true);
    expect(result).toHaveProperty('totpToken');
    // Should NOT return user/accessToken
    expect((result as any).user).toBeUndefined();
  });

  it('rejects banned user', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('ValidPass123', 4);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      ...mockUser,
      password: hash,
      bannedAt: new Date(),
      banReason: 'TOS violation',
    } as any);

    await expect(loginUser('test@example.com', 'ValidPass123'))
      .rejects.toThrow(/banned/i);
  });

  it('rejects IP-banned user', async () => {
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValueOnce({
      ip: '1.2.3.4',
      reason: 'Spam',
    } as any);

    await expect(loginUser('test@example.com', 'ValidPass123', true, '1.2.3.4'))
      .rejects.toThrow(/banned/i);
  });
});

describe('authService — generateTokens', () => {
  it('returns access and refresh tokens', () => {
    const tokens = generateTokens({
      userId: 'user-1',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    });

    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');
  });
});

describe('authService — requestPasswordReset', () => {
  it('refuses an address the mailer would read differently, before any lookup or mail', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    await expect(requestPasswordReset('victim@gmail.com(1)')).rejects.toThrow('Invalid email address');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('silently returns for non-existent email (prevents enumeration)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    // Should not throw
    await expect(requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
  });

  it('normalizes email to lowercase', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    await requestPasswordReset('TEST@EXAMPLE.COM');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'test@example.com' } }),
    );
  });

  it('does not wait for SMTP, so the clock cannot enumerate accounts', async () => {
    // The unknown-email branch returns after two in-process hashes. Awaiting an
    // unpooled SMTP transaction on the known-email branch answers hundreds of
    // milliseconds later — or after a full connect timeout when the relay is
    // down — while both return the identical body. The wording defence is
    // complete and the response TIME walks straight around it.
    const { sendPasswordResetEmail } = await import('../../utils/email');
    let releaseSmtp: () => void = () => {};
    vi.mocked(sendPasswordResetEmail).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSmtp = resolve; }),
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'test@example.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    // Resolves while the transport is still hanging
    await expect(requestPasswordReset('test@example.com')).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r)); // the detached token write, then the send
    expect(sendPasswordResetEmail).toHaveBeenCalled();

    releaseSmtp();
  });

  it('returns after the SAME work on both branches — the DB write is off the response path too', async () => {
    // Dropping the SMTP await left the known-email branch awaiting a Redis
    // consume and a DB UPDATE that the unknown-email branch skipped: the body
    // was identical, the latency was not. Now both branches consume the cap,
    // and the write is sequenced before the send inside the detached work.
    const { sendPasswordResetEmail } = await import('../../utils/email');
    let releaseUpdate: () => void = () => {};
    vi.mocked(prisma.user.update).mockImplementationOnce(
      () => new Promise<never>((resolve) => { releaseUpdate = resolve as () => void; }) as any,
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'test@example.com' } as any);
    mailCap.mockClear();

    // Known email: resolves while the UPDATE is still hanging
    await expect(requestPasswordReset('test@example.com')).resolves.toBeUndefined();
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    // ...and the mail is NOT sent until the token is stored
    await new Promise((r) => setImmediate(r));
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    releaseUpdate();
    await new Promise((r) => setImmediate(r));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith('test@example.com', expect.any(String));

    // Unknown email: pays the same cap consume, keyed on the address as asked
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    await requestPasswordReset('no.body@gmail.com');
    expect(mailCap).toHaveBeenCalledWith('resetMail', 'nobody@gmail.com');
    expect(mailCap).toHaveBeenCalledTimes(2);
  });

  it('reports a failed token write on its own, and does not send a link that would be dead on arrival', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    vi.mocked(sendPasswordResetEmail).mockClear();
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'test@example.com' } as any);
    vi.mocked(prisma.user.update).mockRejectedValueOnce(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await requestPasswordReset('test@example.com');
    await new Promise((r) => setImmediate(r));

    expect(error).toHaveBeenCalledWith('[Auth] Failed to store password reset token:', 'db gone');
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('still logs a send failure, now that nothing awaits it', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(new Error('relay refused'));
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'test@example.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await requestPasswordReset('test@example.com');
    await new Promise((r) => setImmediate(r)); // let the detached catch run

    expect(error).toHaveBeenCalledWith(
      '[Auth] Failed to send password reset email:',
      expect.anything(),
    );
    error.mockRestore();
  });
});

describe('authService — verifyEmail', () => {
  it('rejects empty token', async () => {
    await expect(verifyEmail('')).rejects.toThrow(/Verification token is required/);
  });

  it('rejects invalid token', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    await expect(verifyEmail('invalid-token-abcdef'))
      .rejects.toThrow(/Invalid or expired verification link/);
  });
});
