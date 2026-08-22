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
}));

const redisIncr = vi.fn();
const redisExpire = vi.fn();
const redisGet = vi.fn();
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ incr: redisIncr, expire: redisExpire, get: redisGet }),
}));

const { domainCount, domainConsume, mailCap } = vi.hoisted(() => ({
  domainCount: vi.fn().mockResolvedValue(0),
  domainConsume: vi.fn().mockResolvedValue(undefined),
  mailCap: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../middleware/rateLimiter', async (importOriginal) => {
  // normalizeIp / subnetOf are pure functions with no store behind them — the
  // real ones are exactly what registerUser's key agreement must be tested
  // against, so they are NOT stubbed.
  const actual = await importOriginal<typeof import('../../middleware/rateLimiter')>();
  return {
    normalizeIp: actual.normalizeIp,
    getDomainRegistrationCount: domainCount,
    countDomainRegistration: domainConsume,
    domainRegistrationCap: () => 10,
    consumeMailCap: mailCap,
  };
});

vi.mock('../../utils/sanitize', () => ({
  sanitizeText: vi.fn((str: unknown) => typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : ''),
}));

import { prisma } from '../../utils/prisma';
import {
  registerUser,
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

const CONSENT = { acceptTerms: true, acceptPrivacy: true };

describe('authService — registerUser', () => {
  // The route answers 400 for missing consent; this is the service's OWN
  // guard, so no other caller (a script, a future admin tool) can mint an
  // account without recorded consent.
  it.each([
    ['no consent', undefined],
    ['terms only', { acceptTerms: true, acceptPrivacy: false }],
    ['privacy only', { acceptTerms: false, acceptPrivacy: true }],
  ])('refuses to create an account with %s', async (_label, consent) => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, undefined, consent as never))
      .rejects.toThrow(/accept the Terms of Service and the Privacy Policy/);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates a user with hashed password', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.create).mockResolvedValueOnce({
      id: 'user-1',
      username: 'testuser',
      displayName: 'testuser',
      email: 'test@example.com',
      avatarUrl: null,
      bio: null,
      status: 'offline',
      role: 'user',
      totpEnabled: false,
      emailVerified: false,
      isSupporter: false,
      supporterTier: null,
      tokenVersion: 0,
      createdAt: new Date(),
    } as any);

    const result = await registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, undefined, CONSENT);

    expect(result.user).toBeDefined();
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user.username).toBe('testuser');

    // Password should NOT be in the returned user
    expect((result.user as any).password).toBeUndefined();
    expect((result.user as any).tokenVersion).toBeUndefined();

    // Verify the create call used a hashed password (not plaintext)
    const createCall = vi.mocked(prisma.user.create).mock.calls[0][0];
    expect(createCall.data.password).not.toBe('ValidPass123');
    expect(createCall.data.password).toMatch(/^\$2[ab]\$/); // bcrypt hash format
  });

  it('normalizes email to lowercase', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.create).mockResolvedValueOnce({
      id: 'user-1', username: 'testuser', displayName: 'testuser',
      email: 'test@example.com', avatarUrl: null, bio: null, status: 'offline',
      role: 'user', totpEnabled: false, emailVerified: false,
      isSupporter: false, supporterTier: null, tokenVersion: 0, createdAt: new Date(),
    } as any);

    await registerUser('testuser', 'Test@EXAMPLE.COM', 'ValidPass123', undefined, undefined, CONSENT);

    const createCall = vi.mocked(prisma.user.create).mock.calls[0][0];
    expect(createCall.data.email).toBe('test@example.com');
  });

  it('rejects duplicate username or email', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing' } as any);

    await expect(registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow('Username or email already in use');
  });

  it('rejects invalid username (too short)', async () => {
    await expect(registerUser('ab', 'test@example.com', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow(/Username/);
  });

  it('rejects invalid email', async () => {
    await expect(registerUser('testuser', 'not-an-email', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow(/email/i);
  });

  it('rejects password exceeding 72 chars (bcrypt limit)', async () => {
    const longPassword = 'A'.repeat(73);
    await expect(registerUser('testuser', 'test@example.com', longPassword, undefined, undefined, CONSENT))
      .rejects.toThrow(/Password/);
  });

  it('rejects password below minimum length', async () => {
    await expect(registerUser('testuser', 'test@example.com', 'short', undefined, undefined, CONSENT))
      .rejects.toThrow(/Password/);
  });
});

describe('authService — registration abuse defenses', () => {
  const mockCreatedUser = () => vi.mocked(prisma.user.create).mockResolvedValueOnce({
      id: 'user-1', username: 'testuser', displayName: 'testuser',
      email: 'test@example.com', avatarUrl: null, bio: null, status: 'offline',
      role: 'user', totpEnabled: false, emailVerified: false,
      isSupporter: false, supporterTier: null, tokenVersion: 0, createdAt: new Date(),
    } as any);

  it('records the REGISTRATION IP with kind register (normalized from IPv4-mapped IPv6)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.ipRecord.create).mockResolvedValueOnce({} as any);
    mockCreatedUser();

    await registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, '::ffff:203.0.113.9', CONSENT);

    expect(prisma.ipBan.findUnique).toHaveBeenCalledWith({ where: { ip: '203.0.113.9' } });
    expect(prisma.ipRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', ip: '203.0.113.9', kind: 'register' }),
    }));
  });

  it('REFUSES registration from a banned IP — the gap the bots walked through', async () => {
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValueOnce({ id: 'ban-1', ip: '203.0.113.9', reason: 'bot wave' } as any);

    await expect(registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, '203.0.113.9', CONSENT))
      .rejects.toThrow('Account banned: bot wave');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('dedupes on the CANONICAL email — dotted-gmail aliases cannot mint accounts', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing' } as any);

    await expect(registerUser('newuser', 'J.o.h.n.D.o.e+bot@GMAIL.com', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow('Username or email already in use');

    const where = vi.mocked(prisma.user.findFirst).mock.calls[0][0]!.where as any;
    expect(where.OR).toContainEqual({ emailCanonical: 'johndoe@gmail.com' });
  });

  it('stores emailCanonical on the created user', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreatedUser();

    await registerUser('testuser', 'John.Doe+x@gmail.com', 'ValidPass123', undefined, undefined, CONSENT);

    const createCall = vi.mocked(prisma.user.create).mock.calls[0][0] as any;
    expect(createCall.data.emailCanonical).toBe('johndoe@gmail.com');
    expect(createCall.data.email).toBe('john.doe+x@gmail.com'); // as typed (lowercased)
  });

  it('rejects disposable-email domains with the SAME generic error (no oracle)', async () => {
    await expect(registerUser('testuser', 'bot@mailinator.com', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow('Username or email already in use');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

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

describe('authService — registerUser conflict handling', () => {
  const mockCreated = () => vi.mocked(prisma.user.create).mockResolvedValueOnce({
    id: 'user-1', username: 'testuser', displayName: 'testuser',
    email: 'x@gmail.com', avatarUrl: null, bio: null, status: 'offline',
    role: 'user', totpEnabled: false, emailVerified: false,
    isSupporter: false, supporterTier: null, tokenVersion: 0, createdAt: new Date(),
  } as any);

  it('normalizes an IPv4-mapped address for ban matching and attribution', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreated();
    vi.mocked(prisma.ipRecord.create).mockResolvedValueOnce({} as any);

    await registerUser('testuser', 'x@gmail.com', 'ValidPass123', undefined, '::ffff:203.0.113.5', CONSENT);

    expect(prisma.ipBan.findUnique).toHaveBeenCalledWith({ where: { ip: '203.0.113.5' } });
    const record = vi.mocked(prisma.ipRecord.create).mock.calls[0][0] as any;
    expect(record.data.ip).toBe('203.0.113.5');
  });

  it('surfaces a unique-constraint race as the SAME generic conflict, never a 500', async () => {
    // F11: the findFirst pre-check is friendly, not enforcement — two
    // concurrent signups both see it empty. The DB index is what holds, and
    // its P2002 must not escape as a raw Prisma error (a 500 plus the
    // constraint name in the logs, and a response distinguishable from an
    // ordinary duplicate).
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['users_username_lower_key'] },
    });
    vi.mocked(prisma.user.create).mockRejectedValueOnce(p2002);

    await expect(registerUser('Alice', 'alice@gmail.com', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow('Username or email already in use');
    expect(domainConsume).not.toHaveBeenCalled();
  });

  it('does not swallow non-constraint database errors', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.create).mockRejectedValueOnce(new Error('connection reset'));

    await expect(registerUser('testuser', 'x@gmail.com', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow('connection reset');
  });
});

describe('authService — novel-domain registration cap', () => {
  const mockCreated = () => vi.mocked(prisma.user.create).mockResolvedValueOnce({
    id: 'user-1', username: 'testuser', displayName: 'testuser',
    email: 'x@newdomain.example', avatarUrl: null, bio: null, status: 'offline',
    role: 'user', totpEnabled: false, emailVerified: false,
    isSupporter: false, supporterTier: null, tokenVersion: 0, createdAt: new Date(),
  } as any);

  it('REFUSES the 11th registration from a non-provider domain in a day', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    domainCount.mockResolvedValueOnce(10);

    await expect(registerUser('testuser', 'bot@catchall.example', 'ValidPass123', undefined, undefined, CONSENT))
      .rejects.toThrow('Too many registrations from this email domain');
    expect(domainCount).toHaveBeenCalledWith('catchall.example');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(domainConsume).not.toHaveBeenCalled();
  });

  it('counts the budget only AFTER a successful create — garbage attempts cannot burn a legit domain', async () => {
    // Duplicate username: fails BEFORE the domain budget is ever consumed
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing' } as any);
    await expect(registerUser('taken', 'a@smallcorp.example', 'ValidPass123', undefined, undefined, CONSENT)).rejects.toThrow();
    expect(domainConsume).not.toHaveBeenCalled();

    // Successful create: counted
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreated();
    await registerUser('testuser', 'b@smallcorp.example', 'ValidPass123', undefined, undefined, CONSENT);
    expect(domainConsume).toHaveBeenCalledWith('smallcorp.example');
  });

  it('EXEMPTS major consumer providers — gmail signs up unbounded users/day', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreated();
    await registerUser('testuser', 'human@gmail.com', 'ValidPass123', undefined, undefined, CONSENT);
    expect(domainCount).not.toHaveBeenCalled();
    expect(domainConsume).not.toHaveBeenCalled();
  });

  it('fails OPEN when the budget read fails — registration availability wins', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    domainCount.mockResolvedValueOnce(0); // the helper itself fails soft to 0
    mockCreated();
    await expect(registerUser('testuser', 'x@newdomain.example', 'ValidPass123', undefined, undefined, CONSENT)).resolves.toBeDefined();
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
