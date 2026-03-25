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
    ipRecord: { upsert: vi.fn() },
  },
}));

vi.mock('../../utils/email', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
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
