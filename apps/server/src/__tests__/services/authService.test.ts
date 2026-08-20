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

const { domainCount, domainConsume } = vi.hoisted(() => ({
  domainCount: vi.fn().mockResolvedValue(0),
  domainConsume: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../middleware/rateLimiter', () => ({
  getDomainRegistrationCount: domainCount,
  countDomainRegistration: domainConsume,
  domainRegistrationCap: () => 10,
}));

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

describe('authService — registerUser', () => {
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

    const result = await registerUser('testuser', 'test@example.com', 'ValidPass123');

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

    await registerUser('testuser', 'Test@EXAMPLE.COM', 'ValidPass123');

    const createCall = vi.mocked(prisma.user.create).mock.calls[0][0];
    expect(createCall.data.email).toBe('test@example.com');
  });

  it('rejects duplicate username or email', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing' } as any);

    await expect(registerUser('testuser', 'test@example.com', 'ValidPass123'))
      .rejects.toThrow('Username or email already in use');
  });

  it('rejects invalid username (too short)', async () => {
    await expect(registerUser('ab', 'test@example.com', 'ValidPass123'))
      .rejects.toThrow(/Username/);
  });

  it('rejects invalid email', async () => {
    await expect(registerUser('testuser', 'not-an-email', 'ValidPass123'))
      .rejects.toThrow(/email/i);
  });

  it('rejects password exceeding 72 chars (bcrypt limit)', async () => {
    const longPassword = 'A'.repeat(73);
    await expect(registerUser('testuser', 'test@example.com', longPassword))
      .rejects.toThrow(/Password/);
  });

  it('rejects password below minimum length', async () => {
    await expect(registerUser('testuser', 'test@example.com', 'short'))
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

    await registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, '::ffff:203.0.113.9');

    expect(prisma.ipBan.findUnique).toHaveBeenCalledWith({ where: { ip: '203.0.113.9' } });
    expect(prisma.ipRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', ip: '203.0.113.9', kind: 'register' }),
    }));
  });

  it('REFUSES registration from a banned IP — the gap the bots walked through', async () => {
    vi.mocked(prisma.ipBan.findUnique).mockResolvedValueOnce({ id: 'ban-1', ip: '203.0.113.9', reason: 'bot wave' } as any);

    await expect(registerUser('testuser', 'test@example.com', 'ValidPass123', undefined, '203.0.113.9'))
      .rejects.toThrow('Account banned: bot wave');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('dedupes on the CANONICAL email — dotted-gmail aliases cannot mint accounts', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing' } as any);

    await expect(registerUser('newuser', 'J.o.h.n.D.o.e+bot@GMAIL.com', 'ValidPass123'))
      .rejects.toThrow('Username or email already in use');

    const where = vi.mocked(prisma.user.findFirst).mock.calls[0][0]!.where as any;
    expect(where.OR).toContainEqual({ emailCanonical: 'johndoe@gmail.com' });
  });

  it('stores emailCanonical on the created user', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreatedUser();

    await registerUser('testuser', 'John.Doe+x@gmail.com', 'ValidPass123');

    const createCall = vi.mocked(prisma.user.create).mock.calls[0][0] as any;
    expect(createCall.data.emailCanonical).toBe('johndoe@gmail.com');
    expect(createCall.data.email).toBe('john.doe+x@gmail.com'); // as typed (lowercased)
  });

  it('rejects disposable-email domains with the SAME generic error (no oracle)', async () => {
    await expect(registerUser('testuser', 'bot@mailinator.com', 'ValidPass123'))
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

  it('caps verification emails PER CANONICAL INBOX at 5/day — a bot-owned account cannot drip-harass the real mailbox owner', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1', email: 'j.doe@gmail.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);

    redisIncr.mockResolvedValueOnce(6);
    await expect(resendVerificationEmail('user-1'))
      .rejects.toThrow('Too many verification emails requested');
    expect(redisIncr).toHaveBeenCalledWith('verifymail:jdoe@gmail.com'); // canonical key

    redisIncr.mockResolvedValueOnce(1);
    await expect(resendVerificationEmail('user-1')).resolves.toBeUndefined();
    expect(redisExpire).toHaveBeenCalledWith('verifymail:jdoe@gmail.com', 24 * 60 * 60);
  });

  it('the cap FAILS OPEN on Redis errors — a broken counter must not lock users out of verifying', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1', email: 'someone@example.com', emailVerified: false,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    redisIncr.mockRejectedValueOnce(new Error('redis down'));

    await expect(resendVerificationEmail('user-1')).resolves.toBeUndefined();
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

    await expect(registerUser('testuser', 'bot@catchall.example', 'ValidPass123'))
      .rejects.toThrow('Too many registrations from this email domain');
    expect(domainCount).toHaveBeenCalledWith('catchall.example');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(domainConsume).not.toHaveBeenCalled();
  });

  it('counts the budget only AFTER a successful create — garbage attempts cannot burn a legit domain', async () => {
    // Duplicate username: fails BEFORE the domain budget is ever consumed
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing' } as any);
    await expect(registerUser('taken', 'a@smallcorp.example', 'ValidPass123')).rejects.toThrow();
    expect(domainConsume).not.toHaveBeenCalled();

    // Successful create: counted
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreated();
    await registerUser('testuser', 'b@smallcorp.example', 'ValidPass123');
    expect(domainConsume).toHaveBeenCalledWith('smallcorp.example');
  });

  it('EXEMPTS major consumer providers — gmail signs up unbounded users/day', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    mockCreated();
    await registerUser('testuser', 'human@gmail.com', 'ValidPass123');
    expect(domainCount).not.toHaveBeenCalled();
    expect(domainConsume).not.toHaveBeenCalled();
  });

  it('fails OPEN when the budget read fails — registration availability wins', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    domainCount.mockResolvedValueOnce(0); // the helper itself fails soft to 0
    mockCreated();
    await expect(registerUser('testuser', 'x@newdomain.example', 'ValidPass123')).resolves.toBeDefined();
  });
});

describe('authService — password-reset mail cap', () => {
  it('SILENTLY stops sending after 5 resets to one canonical inbox in a day (no enumeration signal)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'j.doe@gmail.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);

    redisIncr.mockResolvedValueOnce(6);
    // Same resolved outcome as success — the response must not change
    await expect(requestPasswordReset('j.doe@gmail.com')).resolves.toBeUndefined();
    expect(redisIncr).toHaveBeenCalledWith('resetmail:jdoe@gmail.com'); // canonical key
    // ...but no token was stored and no mail went out
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('sends normally under the cap and fails open on Redis errors', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'someone@example.com' } as any);
    vi.mocked(prisma.user.update).mockResolvedValue({} as any);

    redisIncr.mockResolvedValueOnce(1);
    await requestPasswordReset('someone@example.com');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);

    redisIncr.mockRejectedValueOnce(new Error('redis down'));
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
