import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ipBan: { findUnique: vi.fn() },
    ipRecord: { upsert: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../../utils/email', async (importOriginal) => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  describeEmailError: vi.fn((e: unknown) => String(e)),
  // The real classifier: which send failures prove no recipient was reached
  failedBeforeAnyRecipient: (await importOriginal<typeof import('../../utils/email')>()).failedBeforeAnyRecipient,
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

const { mailCap, refund } = vi.hoisted(() => ({
  mailCap: vi.fn().mockResolvedValue(true),
  refund: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../middleware/rateLimiter', async (importOriginal) => {
  // normalizeIp is a pure function with no store behind it — the real one is
  // exactly what loginUser's key agreement must be tested against, so it is
  // NOT stubbed. (Registration's own suite is signupService.test.ts.)
  const actual = await importOriginal<typeof import('../../middleware/rateLimiter')>();
  return {
    normalizeIp: actual.normalizeIp,
    consumeMailCap: mailCap,
    refundRateLimit: refund,
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

  it('resend gives the point back and restores the previous link when the sender refuses a blocked mailbox', async () => {
    const { sendVerificationEmail, MailSuppressedError } = await import('../../utils/email');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', email: 'victim@example.com', emailVerified: false,
      emailVerificationToken: 'a'.repeat(64), emailVerificationTokenExpiresAt: new Date('2026-11-12T10:00:00Z'),
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new MailSuppressedError());
    refund.mockClear();
    vi.mocked(prisma.user.updateMany).mockClear();

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 400, message: /blocked/ });
    expect(refund).toHaveBeenCalledWith('verifyMail', 'victim@example.com');
    expect(prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { emailVerificationToken: 'a'.repeat(64), emailVerificationTokenExpiresAt: new Date('2026-11-12T10:00:00Z') },
    }));
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

describe('authService — a verification resend whose mail cannot be sent', () => {
  const PREVIOUS_DIGEST = 'b'.repeat(64);
  const PREVIOUS_EXPIRY = new Date('2026-11-12T08:30:00Z');
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mailSuppressed.mockReset().mockResolvedValue(false);
    mailCap.mockReset().mockResolvedValue(true);
    refund.mockReset().mockResolvedValue(undefined);
    vi.mocked(prisma.user.update).mockReset().mockResolvedValue({} as any);
    vi.mocked(prisma.user.updateMany).mockReset().mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.user.findUnique).mockReset().mockResolvedValue({
      id: 'user-1', email: 'J.Doe@gmail.com', emailVerified: false,
      emailVerificationToken: PREVIOUS_DIGEST, emailVerificationTokenExpiresAt: PREVIOUS_EXPIRY,
    } as any);
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockReset().mockResolvedValue(undefined);
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  /** The digest the resend wrote before it tried to send. */
  const writtenDigest = () => (vi.mocked(prisma.user.update).mock.calls[0][0] as any).data.emailVerificationToken as string;

  it('answers a 503 the client can show, instead of a bare 500', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({
      statusCode: 503,
      message: 'The verification email could not be sent — please try again later',
    });
  });

  it('gives the mailbox its daily point back, keyed on the canonical inbox the consume used', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 503 });

    expect(mailCap).toHaveBeenCalledWith('verifyMail', 'jdoe@gmail.com');
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith('verifyMail', 'jdoe@gmail.com');
  });

  it('puts the previous link back in force, only while the row still holds the token this resend wrote', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 503 });

    // Written first (a link never arrives before its token), then restored
    expect(writtenDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(writtenDigest()).not.toBe(PREVIOUS_DIGEST);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', emailVerificationToken: writtenDigest() },
      data: { emailVerificationToken: PREVIOUS_DIGEST, emailVerificationTokenExpiresAt: PREVIOUS_EXPIRY },
    });
    expect(vi.mocked(prisma.user.updateMany).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(prisma.user.update).mock.invocationCallOrder[0]);
  });

  it('restores an account that had no live link to no link (the row is as it was)', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1', email: 'someone@example.com', emailVerified: false,
      emailVerificationToken: null, emailVerificationTokenExpiresAt: null,
    } as any);
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 503 });

    expect(prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { emailVerificationToken: null, emailVerificationTokenExpiresAt: null },
    }));
  });

  it('logs the log-safe summary of the failure, never the error object (an SMTP refusal quotes the address)', async () => {
    const { sendVerificationEmail, describeEmailError } = await import('../../utils/email');
    const smtpError = Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 <j.doe@gmail.com>'), {
      code: 'EENVELOPE', responseCode: 550, envelope: { to: ['j.doe@gmail.com'] },
    });
    vi.mocked(describeEmailError).mockReturnValueOnce('EENVELOPE (SMTP 550)');
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(smtpError);

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 503 });

    expect(describeEmailError).toHaveBeenCalledWith(smtpError);
    expect(errorLog).toHaveBeenCalledWith('[Auth] Failed to send verification email:', 'EENVELOPE (SMTP 550)');
    for (const call of errorLog.mock.calls) {
      for (const arg of call) expect(typeof arg).toBe('string');
    }
  });

  it('still answers the failed send when putting the previous link back fails, and logs that on its own', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    vi.mocked(prisma.user.updateMany).mockRejectedValueOnce(new Error('db gone'));

    await expect(resendVerificationEmail('user-1')).rejects.toMatchObject({ statusCode: 503 });

    expect(refund).toHaveBeenCalledWith('verifyMail', 'jdoe@gmail.com');
    expect(errorLog).toHaveBeenCalledWith('[Auth] Failed to restore the previous verification link after a failed send:', 'db gone');
  });

  it('a token write that fails sends nothing, refunds the point and keeps the previous link (nothing to restore)', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(prisma.user.update).mockRejectedValueOnce(new Error('db gone'));

    await expect(resendVerificationEmail('user-1')).rejects.toThrow('db gone');

    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledWith('verifyMail', 'jdoe@gmail.com');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('a send that goes out keeps the new link and the spent point', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');

    await expect(resendVerificationEmail('user-1')).resolves.toBeUndefined();

    expect(sendVerificationEmail).toHaveBeenCalledWith('J.Doe@gmail.com', expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(refund).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('the daily cap still answers before any token is written', async () => {
    mailCap.mockResolvedValueOnce(false);

    await expect(resendVerificationEmail('user-1')).rejects.toThrow('Too many verification emails requested');

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
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

  it('reads only the two fields it uses, never the password hash or the two-factor secret (#105)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'test@example.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    await requestPasswordReset('test@example.com');

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' }, select: { id: true, email: true } });
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

describe('authService — a password-reset mail that provably reached nobody refunds the mailbox', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const smtpError = (fields: Record<string, unknown>) => Object.assign(new Error('send failed'), fields);
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.update).mockReset().mockResolvedValue({} as any);
    vi.mocked(prisma.user.updateMany).mockClear();
    mailCap.mockReset().mockResolvedValue(true);
    refund.mockReset().mockResolvedValue(undefined);
    const { sendPasswordResetEmail } = await import('../../utils/email');
    vi.mocked(sendPasswordResetEmail).mockReset().mockResolvedValue(undefined);
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  const resetWithSendFailure = async (err: unknown) => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(err);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'j.doe@gmail.com' } as any);
    await expect(requestPasswordReset('J.Doe@gmail.com')).resolves.toBeUndefined();
    await flush();
    await flush();
  };

  // The shapes nodemailer's smtp-connection produces (its _onError / _formatError calls)
  it.each([
    ['a DNS failure', { code: 'EDNS', command: 'CONN', originalCode: 'ENOTFOUND' }],
    ['a refused connection', { code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' }],
    ['a connect timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' }],
    ['a greeting that never came', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'GREETING_TIMEOUT' }],
    ['the greeting refused', { code: 'ECONNECTION', command: 'EHLO', responseCode: 421 }],
    ['STARTTLS', { code: 'ETLS', command: 'STARTTLS' }],
    ['a TLS handshake timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'UPGRADE_TIMEOUT' }],
    ['the login', { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }],
    ['missing credentials', { code: 'EAUTH', command: 'API' }],
  ])('refunds the point after %s, keyed on the canonical inbox the consume used', async (_what, fields) => {
    await resetWithSendFailure(smtpError(fields));

    expect(mailCap).toHaveBeenCalledWith('resetMail', 'jdoe@gmail.com');
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith('resetMail', 'jdoe@gmail.com');
  });

  it.each([
    ['a refused recipient', { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }],
    ['a refused sender', { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553 }],
    // nodemailer reports every inactivity timeout, DATA included, as CONN
    ['a socket timeout (any phase, DATA included)', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' }],
    // ...and every close, before the greeting or during DATA alike
    ['a closed connection', { code: 'ECONNECTION', command: 'CONN' }],
    ['the server closing during the send', { code: 'ECONNECTION', command: 'CONN', responseCode: 421 }],
    ['a reset socket', { code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNRESET' }],
    ['a refused message', { code: 'EMESSAGE', command: 'DATA', responseCode: 554 }],
    ['a timeout naming no phase', { code: 'ETIMEDOUT' }],
    ['the transport\'s own "Connection closed"', {}],
  ])('keeps the point after %s: no proof that nobody got the mail', async (_what, fields) => {
    await resetWithSendFailure(smtpError(fields));

    expect(refund).not.toHaveBeenCalled();
  });

  it('never restores the previous reset token, whatever the failure', async () => {
    await resetWithSendFailure(smtpError({ code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' }));

    // The one write is the new token; nothing writes an older one back
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect((vi.mocked(prisma.user.update).mock.calls[0][0] as any).data.resetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('a token write that fails sends nothing and refunds the point', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    vi.mocked(prisma.user.update).mockRejectedValueOnce(new Error('db gone'));
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'j.doe@gmail.com' } as any);

    await requestPasswordReset('j.doe@gmail.com');
    await flush();

    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledWith('resetMail', 'jdoe@gmail.com');
  });

  it('a mailbox that blocked Voxium mail keeps the point (the cap does not matter to a mailbox that gets nothing)', async () => {
    const { MailSuppressedError } = await import('../../utils/email');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await resetWithSendFailure(new MailSuppressedError());

      expect(refund).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('answers before the send settles, so neither the failure nor the refund can move the response', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    let fail: (err: unknown) => void = () => {};
    vi.mocked(sendPasswordResetEmail).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'j.doe@gmail.com' } as any);

    // Resolves with the send still pending: nothing after it is on the response path
    await expect(requestPasswordReset('j.doe@gmail.com')).resolves.toBeUndefined();
    await flush();
    expect(sendPasswordResetEmail).toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();

    fail(smtpError({ code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' }));
    await flush();
    await flush();
    expect(refund).toHaveBeenCalledWith('resetMail', 'jdoe@gmail.com');
  });

  it('every branch resolves the same way after the same awaited work: unknown, sent, provably unsent', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    const awaitedBeforeAnswer = async (arrange: () => void) => {
      vi.mocked(prisma.user.findUnique).mockClear();
      mailCap.mockClear();
      arrange();
      const answer = await requestPasswordReset('j.doe@gmail.com');
      // What the call awaited before answering: one lookup, one cap consume
      return { answer, lookups: vi.mocked(prisma.user.findUnique).mock.calls.length, consumes: mailCap.mock.calls.length, refundsYet: refund.mock.calls.length };
    };

    const unknown = await awaitedBeforeAnswer(() => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    });
    const sent = await awaitedBeforeAnswer(() => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'j.doe@gmail.com' } as any);
    });
    const unsent = await awaitedBeforeAnswer(() => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'j.doe@gmail.com' } as any);
      vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(smtpError({ code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' }));
    });

    expect(unknown).toEqual({ answer: undefined, lookups: 1, consumes: 1, refundsYet: 0 });
    expect(sent).toEqual(unknown);
    expect(unsent).toEqual(unknown);
    await flush();
    await flush();
    // The refund came after the answer, on the provably unsent branch only
    expect(refund).toHaveBeenCalledTimes(1);
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
