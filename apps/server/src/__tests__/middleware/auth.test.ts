import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ─── Environment ─────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-jwt-secret-for-auth-middleware';
process.env.JWT_SECRET = JWT_SECRET;

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockPrismaUser } = vi.hoisted(() => {
  const mockPrismaUser = {
    findUnique: vi.fn(),
  };
  return { mockPrismaUser };
});

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: mockPrismaUser,
  },
}));

// Import after mocks
import { authenticate, requireVerifiedEmail, requireConsent, consentIsRequired } from '../../middleware/auth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockReqResNext(): {
  req: Partial<Request>;
  res: Partial<Response>;
  next: ReturnType<typeof vi.fn>;
} {
  const req: Partial<Request> = {
    headers: {},
  };
  const res: Partial<Response> = {};
  const next = vi.fn();
  return { req, res, next };
}

function generateToken(payload: Record<string, unknown>, options?: jwt.SignOptions): string {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
    ...options,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authenticate middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes with valid JWT in Authorization header and attaches req.user', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    // DB check: user exists, not banned, matching tokenVersion
    mockPrismaUser.findUnique.mockResolvedValue({
      bannedAt: null,
      tokenVersion: 0,
      role: 'user',
      emailVerified: true,
    });

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    // next was called with no error argument
    expect(next).toHaveBeenCalledWith();
    // req.user should be populated
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('user-123');
    expect(req.user!.username).toBe('testuser');
    expect(req.user!.tokenVersion).toBe(0);
  });

  it('uses DB role instead of JWT role (role changes take effect immediately)', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user', // JWT says "user"
      tokenVersion: 0,
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    mockPrismaUser.findUnique.mockResolvedValue({
      bannedAt: null,
      tokenVersion: 0,
      role: 'admin', // DB says "admin" — should take precedence
      emailVerified: true,
    });

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(req.user!.role).toBe('admin');
  });

  it('rejects missing Authorization header (401)', async () => {
    const { req, res, next } = createMockReqResNext();
    req.headers = {};

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/authorization/i);
  });

  it('rejects malformed Authorization header (not Bearer)', async () => {
    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: 'Basic sometoken' };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
  });

  it('rejects expired JWT', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    };
    const token = jwt.sign(payload, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '0s',
    });

    // Small delay to ensure the token has expired
    await new Promise((r) => setTimeout(r, 50));

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/invalid or expired/i);
  });

  it('rejects JWT signed with wrong algorithm (algorithm confusion prevention)', async () => {
    // Sign with HS384 instead of the required HS256
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    };
    const token = jwt.sign(payload, JWT_SECRET, {
      algorithm: 'HS384',
      expiresIn: '15m',
    });

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
  });

  it('rejects token with `purpose` field (trusted-device/totp-verify tokens)', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
      purpose: 'trusted-device',
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/invalid token type/i);
  });

  it('rejects token with purpose=totp-verify', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
      purpose: 'totp-verify',
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/invalid token type/i);
  });

  it('rejects when user not found in DB', async () => {
    const payload = {
      userId: 'nonexistent-user',
      username: 'ghost',
      role: 'user',
      tokenVersion: 0,
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    mockPrismaUser.findUnique.mockResolvedValue(null);

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/user not found/i);
  });

  it('rejects banned users with 403', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    mockPrismaUser.findUnique.mockResolvedValue({
      bannedAt: new Date(),
      tokenVersion: 0,
      role: 'user',
      emailVerified: false,
    });

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/banned/i);
  });

  it('rejects when tokenVersion does not match (session invalidated)', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0, // JWT has version 0
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    mockPrismaUser.findUnique.mockResolvedValue({
      bannedAt: null,
      tokenVersion: 1, // DB has version 1 (password changed)
      role: 'user',
      emailVerified: false,
    });

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/invalidated/i);
  });

  it('attaches emailVerified from DB to req.user', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    };
    const token = generateToken(payload);

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    mockPrismaUser.findUnique.mockResolvedValue({
      bannedAt: null,
      tokenVersion: 0,
      role: 'user',
      emailVerified: true,
    });

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(req.user!.emailVerified).toBe(true);
  });

  it('rejects JWT signed with wrong secret', async () => {
    const payload = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
    };
    const token = jwt.sign(payload, 'wrong-secret', {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${token}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
  });
});

describe('requireVerifiedEmail middleware', () => {
  it('passes when user email is verified', () => {
    const { req, res, next } = createMockReqResNext();
    (req as Request).user = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
      emailVerified: true,
    };

    requireVerifiedEmail(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 when user email is not verified', () => {
    const { req, res, next } = createMockReqResNext();
    (req as Request).user = {
      userId: 'user-123',
      username: 'testuser',
      role: 'user',
      tokenVersion: 0,
      emailVerified: false,
    };

    requireVerifiedEmail(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/email not verified/i);
  });

  it('returns 403 when req.user is undefined', () => {
    const { req, res, next } = createMockReqResNext();
    // No user attached — simulate authenticate middleware not running

    requireVerifiedEmail(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
  });
});

// ─── Consent gate (CNIL/GDPR) ───────────────────────────────────────────────

describe('consentIsRequired', () => {
  it('is required until BOTH documents have been accepted', () => {
    const d = new Date();
    expect(consentIsRequired({ termsAcceptedAt: null, privacyAcceptedAt: null })).toBe(true);
    expect(consentIsRequired({ termsAcceptedAt: d, privacyAcceptedAt: null })).toBe(true);
    expect(consentIsRequired({ termsAcceptedAt: null, privacyAcceptedAt: d })).toBe(true);
    expect(consentIsRequired({ termsAcceptedAt: d, privacyAcceptedAt: d })).toBe(false);
  });
});

describe('requireConsent middleware', () => {
  it('passes an account that has consented', () => {
    const { req, res, next } = createMockReqResNext();
    (req as Request).user = { userId: 'u', username: 'u', role: 'user', tokenVersion: 0, emailVerified: true, consentRequired: false };

    requireConsent(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 for an account that has not — the pre-consent legacy case', () => {
    const { req, res, next } = createMockReqResNext();
    (req as Request).user = { userId: 'u', username: 'u', role: 'user', tokenVersion: 0, emailVerified: true, consentRequired: true };

    requireConsent(req as Request, res as Response, next as NextFunction);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/accept the Terms of Service and the Privacy Policy/);
  });
});

describe('authenticate — resolves consentRequired from the stored timestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
  });

  function tokenFor(userId: string) {
    return jwt.sign({ userId, username: 'u', role: 'user', tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
  }

  it('flags an account with null timestamps — one created before consent was collected at signup', async () => {
    mockPrismaUser.findUnique.mockResolvedValueOnce({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: null, privacyAcceptedAt: null });
    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${tokenFor('legacy')}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect((req as Request).user?.consentRequired).toBe(true);
    // The select asks for the two columns explicitly — a select that omits
    // them would read as "consented" for every account
    expect(mockPrismaUser.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ termsAcceptedAt: true, privacyAcceptedAt: true }),
    }));
  });

  it('does not flag an account that accepted both', async () => {
    mockPrismaUser.findUnique.mockResolvedValueOnce({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(), privacyAcceptedAt: new Date() });
    const { req, res, next } = createMockReqResNext();
    req.headers = { authorization: `Bearer ${tokenFor('fresh')}` };

    await authenticate(req as Request, res as Response, next as NextFunction);

    expect((req as Request).user?.consentRequired).toBe(false);
  });
});
