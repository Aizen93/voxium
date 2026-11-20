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
    // The account-row lock a password change takes first (accountRowLocks.ts)
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

// The sessions the sign-ins open: the session service has its own suite
// (sessionService.test.ts); here, what each sign-in hands it.
const sessions = vi.hoisted(() => ({
  createSession: vi.fn(),
  openSession: vi.fn(),
  rekeySession: vi.fn(),
  trimSessions: vi.fn(),
  endOtherSessions: vi.fn(),
  revokeSession: vi.fn(),
}));
vi.mock('../../services/sessionService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sessionService')>()),
  createSession: (...a: unknown[]) => sessions.createSession(...a),
  openSession: (...a: unknown[]) => sessions.openSession(...a),
  rekeySession: (...a: unknown[]) => sessions.rekeySession(...a),
  trimSessions: (...a: unknown[]) => sessions.trimSessions(...a),
  endOtherSessions: (...a: unknown[]) => sessions.endOtherSessions(...a),
  revokeSession: (...a: unknown[]) => sessions.revokeSession(...a),
}));

// The sockets of the other sessions, after a sign-out of them (its own suite: sessionRevocation.test.ts)
const sockets = vi.hoisted(() => ({ revokeOthers: vi.fn() }));
vi.mock('../../utils/sessionRevocation', () => ({
  revokeOtherSessionSockets: (...a: unknown[]) => sockets.revokeOthers(...a),
  revokeUserSessions: vi.fn(),
  revokeSessionSockets: vi.fn(),
}));

// The two-factor step's code check (totpService has its own suite)
const { totpVerify } = vi.hoisted(() => ({ totpVerify: vi.fn() }));
vi.mock('../../services/totpService', () => ({ verifyTOTP: (...a: unknown[]) => totpVerify(...a) }));

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

import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';
import { LOCK_WAIT_TRANSACTION_OPTIONS } from '../../utils/transactionRetry';
import { PasswordStepUpError, UnauthorizedError } from '../../utils/errors';
import { TEST_JWT_SECRET } from '../helpers/testSecrets';
import {
  loginUser,
  verifyLoginTOTP,
  verifyEmail,
  resendVerificationEmail,
  requestPasswordReset,
  resetPassword,
  changePassword,
  revokeOtherSessions,
  revokeOneSession,
} from '../../services/authService';

// ─── Setup ──────────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

const LABEL = { kind: 'desktop', os: 'windows' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  sessions.createSession.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  sessions.openSession.mockResolvedValue({ sessionId: 'sid-new', tokens: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
  sessions.rekeySession.mockResolvedValue({ accessToken: 'access-3', refreshToken: 'refresh-3' });
  sessions.trimSessions.mockResolvedValue(undefined);
  vi.mocked(prisma.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) => fn(prisma)) as never);
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
    const legacy = await loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL);
    expect((legacy as { user: { consentRequired: boolean } }).user.consentRequired).toBe(true);

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...mockUser, password, termsAcceptedAt: new Date(), privacyAcceptedAt: new Date() } as any);
    const fresh = await loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL);
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

    const result = await loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL);
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

    await loginUser('TEST@EXAMPLE.COM', 'ValidPass123', true, undefined, undefined, LABEL);
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
      await loginUser('test@example.com', 'ValidPass123', true, raw, undefined, LABEL);
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

    await expect(loginUser('test@example.com', 'WrongPassword1', true, undefined, undefined, LABEL))
      .rejects.toThrow(/Invalid credentials/);
  });

  it('rejects non-existent user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    await expect(loginUser('nobody@example.com', 'ValidPass123', true, undefined, undefined, LABEL))
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

    const result = await loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL);
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

    await expect(loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL))
      .rejects.toThrow(/banned/i);
  });

  it('rejects IP-banned user', async () => {
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValueOnce({
      ip: '1.2.3.4',
      reason: 'Spam',
    } as any);

    await expect(loginUser('test@example.com', 'ValidPass123', true, '1.2.3.4', undefined, LABEL))
      .rejects.toThrow(/banned/i);
  });
});

describe('authService — every sign-in opens a session through the session service', () => {
  const account = {
    id: 'user-1', username: 'testuser', displayName: 'testuser', email: 'test@example.com', avatarUrl: null, bio: null,
    status: 'online', role: 'admin', totpEnabled: false, emailVerified: true, isSupporter: false, supporterTier: null,
    tokenVersion: 4, bannedAt: null, banReason: null, createdAt: new Date(), termsAcceptedAt: new Date(), privacyAcceptedAt: new Date(),
  };

  beforeEach(() => {
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.ipRecord.upsert).mockResolvedValue({} as any);
  });

  it('a password sign-in: the account read, its "Remember me" and the label; the answer carries the session pair', async () => {
    const bcrypt = await import('bcryptjs');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...account, password: await bcrypt.hash('ValidPass123', 4) } as any);

    const result = await loginUser('test@example.com', 'ValidPass123', false, undefined, undefined, LABEL);

    expect(sessions.createSession).toHaveBeenCalledWith(
      { userId: 'user-1', username: 'testuser', role: 'admin', tokenVersion: 4 },
      { rememberMe: false, label: LABEL, accountGoneMessage: 'Invalid credentials' },
    );
    expect(result).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('a sign-in whose account is deleted while it runs answers what a wrong password does', async () => {
    const bcrypt = await import('bcryptjs');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...account, password: await bcrypt.hash('ValidPass123', 4) } as any);
    sessions.createSession.mockRejectedValueOnce(new UnauthorizedError('Invalid credentials'));

    await expect(loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL))
      .rejects.toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
  });

  it('a sign-in that needs its two-factor step opens no session and carries the label in the challenge', async () => {
    const bcrypt = await import('bcryptjs');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ ...account, totpEnabled: true, password: await bcrypt.hash('ValidPass123', 4) } as any);

    const result = await loginUser('test@example.com', 'ValidPass123', true, undefined, undefined, LABEL) as { totpToken: string };

    expect(sessions.createSession).not.toHaveBeenCalled();
    const challenge = jwt.verify(result.totpToken, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(challenge).toMatchObject({ userId: 'user-1', purpose: 'totp-verify', rememberMe: true, cl: { k: 'desktop', o: 'windows' } });
  });

  describe('the two-factor step', () => {
    const challenge = (extra: Record<string, unknown> = {}) =>
      jwt.sign({ userId: 'user-1', purpose: 'totp-verify', rememberMe: false, ...extra }, TEST_JWT_SECRET, { expiresIn: '5m' });

    beforeEach(() => {
      totpVerify.mockReset().mockResolvedValue(true);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...account, totpEnabled: true } as any);
    });

    it('opens the session with the label the challenge carries (the password step\'s request)', async () => {
      const result = await verifyLoginTOTP(challenge({ cl: { k: 'web', o: 'macos' } }), '123456', { kind: 'unknown', os: 'other' });

      expect(sessions.createSession).toHaveBeenCalledWith(
        { userId: 'user-1', username: 'testuser', role: 'admin', tokenVersion: 4 },
        { rememberMe: false, label: { kind: 'web', os: 'macos' }, accountGoneMessage: 'User not found' },
      );
      expect(result).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      expect(result.trustedDeviceToken).toEqual(expect.any(String));
    });

    it('a challenge without a label (issued before it was carried), or with one off the lists, takes this request\'s', async () => {
      for (const cl of [undefined, { k: 'phone', o: 'windows' }, { k: 'web', o: 'Windows 11' }, 'desktop']) {
        sessions.createSession.mockClear();
        await verifyLoginTOTP(challenge(cl === undefined ? {} : { cl }), '123456', LABEL);
        expect(sessions.createSession.mock.calls[0][1], JSON.stringify(cl)).toMatchObject({ label: LABEL });
      }
    });

    it('reads "Remember me" from the challenge as before: absent means yes, otherwise its truthiness', async () => {
      const cases: Array<[Record<string, unknown>, boolean]> = [
        [{ rememberMe: undefined }, true], [{ rememberMe: true }, true], [{ rememberMe: 'yes' }, true],
        [{ rememberMe: false }, false], [{ rememberMe: 0 }, false], [{ rememberMe: null }, false],
      ];
      for (const [extra, remembered] of cases) {
        sessions.createSession.mockClear();
        const token = jwt.sign({ userId: 'user-1', purpose: 'totp-verify', ...extra }, TEST_JWT_SECRET, { expiresIn: '5m' });
        await verifyLoginTOTP(token, '123456', LABEL);
        expect(sessions.createSession.mock.calls[0][1].rememberMe, JSON.stringify(extra)).toBe(remembered);
      }
    });

    it('a wrong code opens nothing', async () => {
      totpVerify.mockResolvedValueOnce(false);
      await expect(verifyLoginTOTP(challenge(), '000000', LABEL)).rejects.toThrow('Invalid verification code');
      expect(sessions.createSession).not.toHaveBeenCalled();
    });
  });
});

describe('authService — a password change keeps its caller signed in', () => {
  const ran: string[] = [];
  /** The account as the transaction reads it under its lock (version 7: the caller was admitted at 7). */
  let lockedVersion: number;

  beforeEach(async () => {
    ran.length = 0;
    lockedVersion = 7;
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('OldPassword123', 4);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { select: Record<string, unknown> }) => {
      // The hash read before the transaction; the account read under the lock inside it
      if (args.select.password) return { id: 'u-1', password: hash };
      ran.push('read');
      return { id: 'u-1', username: 'alice', role: 'user', tokenVersion: lockedVersion };
    }) as never);
    vi.mocked(prisma.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
      ran.push(strings.join('?').includes('FOR NO KEY UPDATE') ? 'lock' : 'other');
      return [{ id: 'u-1' }];
    }) as never);
    vi.mocked(prisma.user.update).mockImplementation((async () => {
      ran.push('bump');
      return { id: 'u-1', username: 'alice', role: 'user', tokenVersion: 8 };
    }) as never);
    sessions.rekeySession.mockImplementation(async () => { ran.push('rekey'); return { accessToken: 'access-3', refreshToken: 'refresh-3' }; });
    sessions.openSession.mockImplementation(async () => { ran.push('open'); return { sessionId: 'sid-new', tokens: { accessToken: 'access-2', refreshToken: 'refresh-2' } }; });
  });

  it('locks the account row and checks the admitted version, then bumps and re-keys the caller\'s own session, in ONE transaction with the lock-wait budget', async () => {
    const tokens = await changePassword('u-1', 'sid-mine', 7, 'OldPassword123', 'NewPassword123', true, LABEL);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), LOCK_WAIT_TRANSACTION_OPTIONS);
    expect(ran).toEqual(['lock', 'read', 'bump', 'rekey']);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u-1' },
      data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      select: { id: true, username: true, role: true, tokenVersion: true },
    }));
    // The account at its NEW version, on the transaction's client, from the admitted version
    expect(sessions.rekeySession).toHaveBeenCalledWith(prisma, { userId: 'u-1', username: 'alice', role: 'user', tokenVersion: 8 }, 'sid-mine', 7);
    expect(sessions.openSession).not.toHaveBeenCalled();
    expect(sessions.trimSessions).not.toHaveBeenCalled();
    expect(tokens).toEqual({ accessToken: 'access-3', refreshToken: 'refresh-3' });
  });

  it('a reset, a ban or another change that committed while the hash ran (the version moved): 401 Session invalidated, no password written, no session touched', async () => {
    lockedVersion = 8;
    await expect(changePassword('u-1', 'sid-mine', 7, 'OldPassword123', 'NewPassword123', true, LABEL))
      .rejects.toMatchObject({ statusCode: 401, message: 'Session invalidated' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessions.rekeySession).not.toHaveBeenCalled();
    expect(ran).toEqual(['lock', 'read']);
  });

  it('the same for a caller whose token names no session: no session opened for it', async () => {
    lockedVersion = 9;
    await expect(changePassword('u-1', undefined, 7, 'OldPassword123', 'NewPassword123', true, LABEL))
      .rejects.toMatchObject({ statusCode: 401, message: 'Session invalidated' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessions.openSession).not.toHaveBeenCalled();
    expect(sessions.trimSessions).not.toHaveBeenCalled();
  });

  it('an account deleted before the lock (nothing locked): 401 User not found, nothing written', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as never);
    await expect(changePassword('u-1', 'sid-mine', 7, 'OldPassword123', 'NewPassword123', true, LABEL))
      .rejects.toMatchObject({ statusCode: 401, message: 'User not found' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a caller whose access token names no session gets a new one in the same transaction, then the cap is kept', async () => {
    const tokens = await changePassword('u-1', undefined, 7, 'OldPassword123', 'NewPassword123', false, LABEL);

    expect(ran).toEqual(['lock', 'read', 'bump', 'open']);
    expect(sessions.openSession).toHaveBeenCalledWith(
      prisma,
      { userId: 'u-1', username: 'alice', role: 'user', tokenVersion: 8 },
      { rememberMe: false, label: LABEL, accountGoneMessage: 'User not found' },
    );
    expect(sessions.trimSessions).toHaveBeenCalledWith('u-1', 'sid-new');
    expect(tokens).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2' });
  });

  it('a caller whose session ended meanwhile is refused, and the transaction (the new password with it) rolls back', async () => {
    sessions.rekeySession.mockRejectedValueOnce(new UnauthorizedError('Session invalidated'));
    await expect(changePassword('u-1', 'sid-gone', 7, 'OldPassword123', 'NewPassword123', true, LABEL))
      .rejects.toMatchObject({ statusCode: 401, message: 'Session invalidated' });
    // The refusal is thrown inside the transaction's callback: Prisma rolls back on it
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('an account deleted between the check and the bump (P2025) answers User not found', async () => {
    vi.mocked(prisma.user.update).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'P2025' }));
    await expect(changePassword('u-1', 'sid-mine', 7, 'OldPassword123', 'NewPassword123', true, LABEL))
      .rejects.toMatchObject({ statusCode: 401, message: 'User not found' });
    expect(sessions.rekeySession).not.toHaveBeenCalled();
  });

  it('a deadlock victim runs again whole, the lock and the version check with it; a failed statement is thrown as it is (500)', async () => {
    vi.mocked(prisma.$transaction)
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }))
      .mockImplementationOnce(((fn: (tx: unknown) => unknown) => fn(prisma)) as never);
    await expect(changePassword('u-1', 'sid-mine', 7, 'OldPassword123', 'NewPassword123', true, LABEL)).resolves.toEqual({ accessToken: 'access-3', refreshToken: 'refresh-3' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(ran).toEqual(['lock', 'read', 'bump', 'rekey']);

    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('connection lost'));
    await expect(changePassword('u-1', 'sid-mine', 7, 'OldPassword123', 'NewPassword123', true, LABEL)).rejects.toThrow('connection lost');
  });

  it('a wrong current password changes nothing and touches no session', async () => {
    await expect(changePassword('u-1', 'sid-mine', 7, 'WrongPassword1', 'NewPassword123', true, LABEL)).rejects.toThrow('Current password is incorrect');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sessions.rekeySession).not.toHaveBeenCalled();
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

describe('authService — no reset, password or verification query loads a whole row', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const SECRET_COLUMNS = ['password', 'totpSecret', 'totpBackupCodes', 'resetToken', 'emailVerificationToken'];

  beforeEach(async () => {
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.update).mockReset().mockResolvedValue({ id: 'u-1', username: 'u', role: 'user', tokenVersion: 1 } as any);
    mailCap.mockReset().mockResolvedValue(true);
    mailSuppressed.mockReset().mockResolvedValue(false);
    const { sendVerificationEmail, sendPasswordResetEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendPasswordResetEmail).mockReset().mockResolvedValue(undefined);
  });

  /** Every read and write the flows made: each names its columns, none the secrets (but the hash where it must be compared). */
  const expectNarrow = (allowed: string[] = []) => {
    const calls = [...vi.mocked(prisma.user.findUnique).mock.calls, ...vi.mocked(prisma.user.update).mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls as [{ select?: Record<string, unknown> }][]) {
      expect(args.select).toBeDefined();
      for (const column of SECRET_COLUMNS) {
        if (!allowed.includes(column)) expect(args.select).not.toHaveProperty(column);
      }
    }
  };

  it('resetPassword, a live token: the lookup reads the id and expiry, the write returns the id', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', resetTokenExpiresAt: new Date(Date.now() + 60_000) } as any);

    await expect(resetPassword('a'.repeat(64), 'NewPassword123')).resolves.toEqual({ userId: 'u-1' });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, resetTokenExpiresAt: true } }));
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
    expectNarrow();
  });

  it('resetPassword, an expired token: the clearing write returns the id only', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', resetTokenExpiresAt: new Date(Date.now() - 60_000) } as any);

    await expect(resetPassword('a'.repeat(64), 'NewPassword123')).rejects.toThrow('Invalid or expired reset token');

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { resetToken: null, resetTokenExpiresAt: null }, select: { id: true } }));
    expectNarrow();
  });

  it('changePassword reads the hash it compares and nothing else of the row', async () => {
    const bcrypt = await import('bcryptjs');
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: 'u-1', password: await bcrypt.hash('OldPassword123', 4) } as any)
      // The account under the transaction's lock, at the admitted version
      .mockResolvedValueOnce({ id: 'u-1', username: 'u', role: 'user', tokenVersion: 0 } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ id: 'u-1' }] as never);

    await changePassword('u-1', 'sid-1', 0, 'OldPassword123', 'NewPassword123', true, LABEL);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-1' }, select: { id: true, password: true } });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-1' }, select: { id: true, username: true, role: true, tokenVersion: true } });
    expectNarrow(['password']);
  });

  it('verifyEmail, a live and an expired link: both writes return the id only', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000) } as any);
    await verifyEmail('a'.repeat(64));
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', emailVerificationTokenExpiresAt: new Date(Date.now() - 60_000) } as any);
    await expect(verifyEmail('b'.repeat(64))).rejects.toThrow('Invalid or expired verification link');

    expect(vi.mocked(prisma.user.update).mock.calls).toHaveLength(2);
    for (const [args] of vi.mocked(prisma.user.update).mock.calls) expect((args as any).select).toEqual({ id: true });
    expectNarrow();
  });

  it('resendVerificationEmail: the token write returns the id only', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-1', email: 'someone@example.com', emailVerified: false, emailVerificationToken: null, emailVerificationTokenExpiresAt: null,
    } as any);

    await resendVerificationEmail('u-1');

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
    // Its read keeps the previous token's digest to restore it: allowed, it never leaves the function
    expectNarrow(['emailVerificationToken']);
  });

  it('requestPasswordReset: the background token write returns the id only', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'u-1', email: 'someone@example.com' } as any);

    await requestPasswordReset('someone@example.com');
    await flush();

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
    expectNarrow();
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

// ─── Signing out of one session, or of every other ──────────────────────────

describe('authService — signing out of every other session', () => {
  const ran: string[] = [];
  let lockedVersion: number;
  let hash: string;
  const input = (over: Partial<Parameters<typeof revokeOtherSessions>[0]> = {}) => ({
    userId: 'u-1', sid: 'sid-mine', admittedVersion: 7, password: 'RightPassword1', trustedDeviceToken: undefined,
    rememberMe: true, label: LABEL, ...over,
  });
  const trusted = (over: Record<string, unknown> = {}, opts: jwt.SignOptions = { expiresIn: '30d' }, secret = TEST_JWT_SECRET) =>
    jwt.sign({ userId: 'u-1', purpose: 'trusted-device', tokenVersion: 7, ...over }, secret, { algorithm: 'HS256', ...opts });

  beforeEach(async () => {
    ran.length = 0;
    lockedVersion = 7;
    const bcrypt = await import('bcryptjs');
    hash = hash || await bcrypt.hash('RightPassword1', 4);
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { select: Record<string, unknown> }) => {
      if (args.select.password) { ran.push('password'); return { password: hash }; }
      ran.push('read');
      return { id: 'u-1', username: 'alice', role: 'user', tokenVersion: lockedVersion };
    }) as never);
    vi.mocked(prisma.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
      ran.push(strings.join('?').includes('FOR NO KEY UPDATE') ? 'lock' : 'other');
      return [{ id: 'u-1' }];
    }) as never);
    vi.mocked(prisma.user.update).mockImplementation((async () => { ran.push('bump'); return { id: 'u-1', username: 'alice', role: 'user', tokenVersion: 8 }; }) as never);
    sessions.rekeySession.mockImplementation(async () => { ran.push('rekey'); return { accessToken: 'access-3', refreshToken: 'refresh-3' }; });
    sessions.openSession.mockImplementation(async () => { ran.push('open'); return { sessionId: 'sid-new', tokens: { accessToken: 'access-2', refreshToken: 'refresh-2' } }; });
    sessions.endOtherSessions.mockImplementation(async () => { ran.push('end-others'); return { ended: ['a', 'b', 'c'], live: 2 }; });
    sockets.revokeOthers.mockImplementation(() => { ran.push('sockets'); });
  });

  it('the password, then ONE transaction with the lock-wait budget: the account row locked at the admitted version, the bump, the caller\'s row re-keyed, every other session deleted; then the sockets', async () => {
    const out = await revokeOtherSessions(input());

    expect(ran).toEqual(['password', 'lock', 'read', 'bump', 'rekey', 'end-others', 'sockets']);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), LOCK_WAIT_TRANSACTION_OPTIONS);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-1' }, data: { tokenVersion: { increment: 1 } }, select: { id: true, username: true, role: true, tokenVersion: true } });
    expect(sessions.rekeySession).toHaveBeenCalledWith(prisma, { userId: 'u-1', username: 'alice', role: 'user', tokenVersion: 8 }, 'sid-mine', 7);
    expect(sessions.endOtherSessions).toHaveBeenCalledWith(prisma, 'u-1', 'sid-mine', 7);
    expect(sockets.revokeOthers).toHaveBeenCalledWith('u-1', 'sid-mine', 'You were signed out from another device');
    // The others that were live, and the caller's fresh pair; no trusted-device token asked, none given
    expect(out).toEqual({ revoked: 2, accessToken: 'access-3', refreshToken: 'refresh-3' });
  });

  it('a wrong password: 400 Password is incorrect (PasswordStepUpError), nothing read under a lock, nothing written', async () => {
    const err = await revokeOtherSessions(input({ password: 'WrongPassword1' })).catch((e) => e);
    expect(err).toBeInstanceOf(PasswordStepUpError);
    expect(err).toMatchObject({ statusCode: 400, message: 'Password is incorrect' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sockets.revokeOthers).not.toHaveBeenCalled();
  });

  it('an account gone since the caller was admitted: the same hash work against the equalizer, then 401 User not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null as never);
    const bcrypt = await import('bcryptjs');
    const compare = vi.spyOn(bcrypt.default, 'compare');
    await expect(revokeOtherSessions(input())).rejects.toMatchObject({ statusCode: 401, message: 'User not found' });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    compare.mockRestore();
  });

  it('the version moved since the caller was admitted (a reset, a ban, a password change or another of these): 401 Session invalidated, nothing written, no socket touched', async () => {
    lockedVersion = 8;
    await expect(revokeOtherSessions(input())).rejects.toMatchObject({ statusCode: 401, message: 'Session invalidated' });
    expect(ran).toEqual(['password', 'lock', 'read']);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sockets.revokeOthers).not.toHaveBeenCalled();
  });

  it('the caller\'s own session ended meanwhile: the re-key refuses and the whole transaction rolls back, no socket touched', async () => {
    sessions.rekeySession.mockRejectedValueOnce(new UnauthorizedError('Session invalidated'));
    await expect(revokeOtherSessions(input())).rejects.toMatchObject({ statusCode: 401, message: 'Session invalidated' });
    expect(sessions.endOtherSessions).not.toHaveBeenCalled();
    expect(sockets.revokeOthers).not.toHaveBeenCalled();
  });

  it('a caller whose token names no session: a new session opened in the same transaction and kept; its sockets spared none', async () => {
    const out = await revokeOtherSessions(input({ sid: undefined, rememberMe: false }));
    expect(ran).toEqual(['password', 'lock', 'read', 'bump', 'open', 'end-others', 'sockets']);
    expect(sessions.openSession).toHaveBeenCalledWith(prisma, { userId: 'u-1', username: 'alice', role: 'user', tokenVersion: 8 }, { rememberMe: false, label: LABEL, accountGoneMessage: 'User not found' });
    expect(sessions.endOtherSessions).toHaveBeenCalledWith(prisma, 'u-1', 'sid-new', 7);
    expect(sockets.revokeOthers).toHaveBeenCalledWith('u-1', undefined, 'You were signed out from another device');
    expect(out).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
  });

  it('a deadlock victim runs again whole, every check with it; a failed statement is thrown as it is (500), the sockets untouched', async () => {
    vi.mocked(prisma.$transaction)
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }))
      .mockImplementationOnce(((fn: (tx: unknown) => unknown) => fn(prisma)) as never);
    await expect(revokeOtherSessions(input())).resolves.toMatchObject({ revoked: 2 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    sockets.revokeOthers.mockClear();
    sessions.endOtherSessions.mockRejectedValueOnce(new Error('connection lost'));
    await expect(revokeOtherSessions(input())).rejects.toThrow('connection lost');
    expect(sockets.revokeOthers).not.toHaveBeenCalled();
  });

  it('a valid trusted-device token of this account at the old version: re-issued under the new version, with the same expiry', async () => {
    const old = trusted();
    const out = await revokeOtherSessions(input({ trustedDeviceToken: old }));
    const fresh = jwt.verify(out.trustedDeviceToken!, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(fresh).toMatchObject({ userId: 'u-1', purpose: 'trusted-device', tokenVersion: 8 });
    expect(fresh.exp).toBe((jwt.decode(old) as { exp: number }).exp);
  });

  it.each([
    ['of another account', () => trusted({ userId: 'u-2' })],
    ['of another version', () => trusted({ tokenVersion: 6 })],
    ['without a version', () => trusted({ tokenVersion: undefined })],
    ['of another purpose', () => trusted({ purpose: 'totp-verify' })],
    ['expired', () => trusted({ exp: Math.floor(Date.now() / 1000) - 60 }, {})],
    ['forged', () => trusted({}, { expiresIn: '30d' }, 'not-the-secret')],
    ['garbage', () => 'garbage'],
    ['an access token', () => jwt.sign({ userId: 'u-1', username: 'alice', role: 'user', tokenVersion: 7 }, TEST_JWT_SECRET, { expiresIn: '15m' })],
  ])('a trusted-device token %s: the sign-out goes through, and none is re-issued', async (_what, make) => {
    const out = await revokeOtherSessions(input({ trustedDeviceToken: make() }));
    expect(out.trustedDeviceToken).toBeUndefined();
    expect(out.revoked).toBe(2);
  });
});

describe('authService — signing out of one other session', () => {
  let hash: string;
  beforeEach(async () => {
    const bcrypt = await import('bcryptjs');
    hash = hash || await bcrypt.hash('RightPassword1', 4);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ password: hash } as never);
    sessions.revokeSession.mockResolvedValue(true);
  });

  it('the password, then the session of THIS account ended with the reason its device is told', async () => {
    await expect(revokeOneSession('u-1', 'sid-mine', 'sid-other-000000000000', 'RightPassword1')).resolves.toBeUndefined();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-1' }, select: { password: true } });
    expect(sessions.revokeSession).toHaveBeenCalledWith('u-1', 'sid-other-000000000000', 'You were signed out from another device');
  });

  it('a wrong password: 400 Password is incorrect before anything that depends on the id, whatever the id', async () => {
    for (const id of ['sid-other-000000000000', 'sid-mine', 'a:b', 'unknown-000000000000000']) {
      const err = await revokeOneSession('u-1', 'sid-mine', id, 'WrongPassword1').catch((e) => e);
      expect(err).toBeInstanceOf(PasswordStepUpError);
    }
    expect(sessions.revokeSession).not.toHaveBeenCalled();
  });

  it('an unknown id, another account\'s id, or an id no session can carry: the same 404 Session not found', async () => {
    sessions.revokeSession.mockResolvedValueOnce(false);
    const unknown = await revokeOneSession('u-1', 'sid-mine', 'unknown-000000000000000', 'RightPassword1').catch((e) => e);
    const malformed = await revokeOneSession('u-1', 'sid-mine', 'has:colon', 'RightPassword1').catch((e) => e);
    for (const err of [unknown, malformed]) expect(err).toMatchObject({ statusCode: 404, message: 'Session not found' });
    // The malformed one reached no statement
    expect(sessions.revokeSession).toHaveBeenCalledTimes(1);
  });

  it('the caller\'s own session: 400 (signing out is what ends it), nothing ended', async () => {
    await expect(revokeOneSession('u-1', 'sid-mine', 'sid-mine', 'RightPassword1')).rejects.toMatchObject({
      statusCode: 400, message: 'This is the session you are using: sign out to end it',
    });
    expect(sessions.revokeSession).not.toHaveBeenCalled();
  });

  it('a caller whose token names no session can end any of its sessions', async () => {
    await expect(revokeOneSession('u-1', undefined, 'sid-mine', 'RightPassword1')).resolves.toBeUndefined();
    expect(sessions.revokeSession).toHaveBeenCalledWith('u-1', 'sid-mine', 'You were signed out from another device');
  });

  it('a failing statement is thrown as it is (500)', async () => {
    sessions.revokeSession.mockRejectedValueOnce(new Error('connection lost'));
    await expect(revokeOneSession('u-1', 'sid-mine', 'sid-other-000000000000', 'RightPassword1')).rejects.toThrow('connection lost');
  });
});
