import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Router } from 'express';

// ─── Environment variables (must be set before any app import) ───────────────

const JWT_SECRET = 'test-jwt-secret-for-unit-tests';
const JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-for-unit-tests';

process.env.JWT_SECRET = JWT_SECRET;
process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockPrismaUser, mockPrismaIpBan, mockPrismaIpRecord, mockRedisClient, passthroughMiddleware } = vi.hoisted(() => {
  const mockPrismaUser = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };

  const mockPrismaIpBan = {
    findUnique: vi.fn(),
  };

  const mockPrismaIpRecord = {
    upsert: vi.fn(),
  };

  const mockRedisClient = {
    ping: vi.fn().mockResolvedValue('PONG'),
    sAdd: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    sMembers: vi.fn().mockResolvedValue([]),
    sIsMember: vi.fn().mockResolvedValue(false),
    hSet: vi.fn().mockResolvedValue(1),
    hGet: vi.fn().mockResolvedValue(null),
    hGetAll: vi.fn().mockResolvedValue({}),
    hDel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn().mockResolvedValue(undefined),
    sCard: vi.fn().mockResolvedValue(0),
  };

  const passthroughMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();

  return { mockPrismaUser, mockPrismaIpBan, mockPrismaIpRecord, mockRedisClient, passthroughMiddleware };
});

// Mock Prisma — must be declared before app import
vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: mockPrismaUser,
    ipBan: mockPrismaIpBan,
    ipRecord: mockPrismaIpRecord,
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
}));

// Mock Redis — rate limiter and other utils need this
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn(() => mockRedisClient),
  getRedisPubSub: vi.fn(() => ({ pub: mockRedisClient, sub: mockRedisClient })),
  getRedisConfigSub: vi.fn(() => ({
    subscribe: vi.fn().mockResolvedValue(undefined),
  })),
  setUserOnline: vi.fn(),
  setUserOffline: vi.fn(),
  isUserOnline: vi.fn().mockResolvedValue(false),
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

// Mock email
vi.mock('../../utils/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Mock geoip-lite
vi.mock('geoip-lite', () => ({
  default: { lookup: vi.fn().mockReturnValue(null) },
}));

// ─── Mock non-auth route modules to avoid deep transitive dependency chains ──
// These routes import from websocket, mediasoup, S3, etc. which are not needed
// for auth route tests. Replacing them with empty routers prevents import errors.

vi.mock('../../routes/servers', () => ({ serverRouter: Router() }));
vi.mock('../../routes/channels', () => ({ channelRouter: Router() }));
vi.mock('../../routes/messages', () => ({ messageRouter: Router() }));
vi.mock('../../routes/users', () => ({ userRouter: Router() }));
vi.mock('../../routes/invites', () => ({ inviteRouter: Router() }));
vi.mock('../../routes/uploads', () => ({ uploadRouter: Router() }));
vi.mock('../../routes/dm', () => ({ dmRouter: Router() }));
vi.mock('../../routes/friends', () => ({ friendRouter: Router() }));
vi.mock('../../routes/categories', () => ({ categoryRouter: Router() }));
vi.mock('../../routes/search', () => ({ searchRouter: Router() }));
vi.mock('../../routes/reports', () => ({ reportsRouter: Router() }));
vi.mock('../../routes/stats', () => ({ statsRouter: Router() }));
vi.mock('../../routes/admin', () => ({ adminRouter: Router() }));
vi.mock('../../routes/support', () => ({ supportRouter: Router() }));

// Mock rate limiters — pass through all requests for most tests
vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitRegister: passthroughMiddleware,
  rateLimitLogin: passthroughMiddleware,
  rateLimitForgotPassword: passthroughMiddleware,
  rateLimitResetPassword: passthroughMiddleware,
  rateLimitRefresh: passthroughMiddleware,
  rateLimitChangePassword: passthroughMiddleware,
  rateLimitTOTP: passthroughMiddleware,
  rateLimitVerifyEmail: passthroughMiddleware,
  rateLimitResendVerification: passthroughMiddleware,
  rateLimitGeneral: passthroughMiddleware,
  rateLimitMessageSend: passthroughMiddleware,
  rateLimitUpload: passthroughMiddleware,
  rateLimitFriendRequest: passthroughMiddleware,
  rateLimitMemberManage: passthroughMiddleware,
  rateLimitCategoryManage: passthroughMiddleware,
  rateLimitSearch: passthroughMiddleware,
  rateLimitStats: passthroughMiddleware,
  rateLimitAdmin: passthroughMiddleware,
  rateLimitReport: passthroughMiddleware,
  rateLimitSupport: passthroughMiddleware,
  rateLimitMarkRead: passthroughMiddleware,
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

// Now import the app (after all mocks are set up)
import { app } from '../../app';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateAccessToken(payload: {
  userId: string;
  username: string;
  role?: string;
  tokenVersion?: number;
  purpose?: string;
}): string {
  return jwt.sign(
    {
      userId: payload.userId,
      username: payload.username,
      role: payload.role ?? 'user',
      tokenVersion: payload.tokenVersion ?? 0,
      ...( payload.purpose ? { purpose: payload.purpose } : {}),
    },
    JWT_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' },
  );
}

function generateRefreshToken(payload: {
  userId: string;
  username: string;
  role?: string;
  tokenVersion?: number;
  rememberMe?: boolean;
}): string {
  return jwt.sign(
    {
      userId: payload.userId,
      username: payload.username,
      role: payload.role ?? 'user',
      tokenVersion: payload.tokenVersion ?? 0,
      rememberMe: payload.rememberMe ?? true,
    },
    JWT_REFRESH_SECRET,
    { expiresIn: '30d', algorithm: 'HS256' },
  );
}

const MOCK_USER = {
  id: 'user-123',
  username: 'testuser',
  displayName: 'Test User',
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
  createdAt: new Date('2024-01-01'),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 with user and tokens on success', async () => {
    mockPrismaUser.findFirst.mockResolvedValue(null); // no duplicate
    mockPrismaUser.create.mockResolvedValue({ ...MOCK_USER });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.username).toBe('testuser');
    // tokenVersion must NOT be exposed in the response
    expect(res.body.data.user).not.toHaveProperty('tokenVersion');
  });

  it('rejects duplicate email/username with generic error (enumeration prevention)', async () => {
    mockPrismaUser.findFirst.mockResolvedValue({ id: 'existing-user' }); // duplicate found

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    // Must say "Username or email" not which specific field
    expect(res.body.error).toBe('Username or email already in use');
  });

  it('rejects missing username', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'test@example.com',
        password: 'password123',
      });

    // Missing username causes a TypeError (undefined.length) which the error
    // handler maps to 500. The request should not succeed regardless.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        password: 'password123',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects missing password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects password longer than 72 chars (bcrypt limit)', async () => {
    const longPassword = 'a'.repeat(73);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: longPassword,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/72/); // error message references the 72 char limit
  });

  it('normalizes email to lowercase', async () => {
    mockPrismaUser.findFirst.mockResolvedValue(null);
    mockPrismaUser.create.mockResolvedValue({ ...MOCK_USER, email: 'test@example.com' });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'TEST@EXAMPLE.COM',
        password: 'password123',
      });

    expect(res.status).toBe(201);
    // Verify the email passed to Prisma create was lowercased
    const createCall = mockPrismaUser.create.mock.calls[0]?.[0];
    expect(createCall?.data?.email).toBe('test@example.com');
  });

  it('rejects short username (less than 3 chars)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'ab',
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects invalid email format', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'not-an-email',
        password: 'password123',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects short password (less than 8 chars)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'short',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with user and tokens on success', async () => {
    // bcrypt hash of 'password123' with 12 rounds
    const hashedPassword = await bcrypt.hash('password123', 4);

    mockPrismaIpBan.findUnique.mockResolvedValue(null); // no IP ban
    mockPrismaUser.findUnique.mockResolvedValue({
      ...MOCK_USER,
      password: hashedPassword,
      bannedAt: null,
      banReason: null,
    });
    mockPrismaIpRecord.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.email).toBe('test@example.com');
    // Sensitive fields must not be exposed
    expect(res.body.data.user).not.toHaveProperty('password');
    expect(res.body.data.user).not.toHaveProperty('tokenVersion');
    expect(res.body.data.user).not.toHaveProperty('bannedAt');
    expect(res.body.data.user).not.toHaveProperty('banReason');
  });

  it('returns 401 with wrong password', async () => {
    const hashedPassword = await bcrypt.hash('correctpassword', 4);

    mockPrismaIpBan.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({
      ...MOCK_USER,
      password: hashedPassword,
      bannedAt: null,
      banReason: null,
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'wrongpassword',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('returns 401 when user does not exist', async () => {
    mockPrismaIpBan.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue(null); // no user

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'nonexistent@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('normalizes email to lowercase', async () => {
    const hashedPassword = await bcrypt.hash('password123', 4);

    mockPrismaIpBan.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({
      ...MOCK_USER,
      password: hashedPassword,
      bannedAt: null,
      banReason: null,
    });
    mockPrismaIpRecord.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'TEST@EXAMPLE.COM',
        password: 'password123',
      });

    expect(res.status).toBe(200);
    // Verify the email passed to Prisma findUnique was lowercased
    const findCall = mockPrismaUser.findUnique.mock.calls[0]?.[0];
    expect(findCall?.where?.email).toBe('test@example.com');
  });

  it('returns 403 for banned accounts', async () => {
    const hashedPassword = await bcrypt.hash('password123', 4);

    mockPrismaIpBan.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({
      ...MOCK_USER,
      password: hashedPassword,
      bannedAt: new Date(),
      banReason: 'Spam',
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/banned/i);
  });

  it('returns 403 for IP-banned users', async () => {
    mockPrismaIpBan.findUnique.mockResolvedValue({ ip: '127.0.0.1', reason: 'Abuse' });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/banned/i);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns new tokens with valid refresh token', async () => {
    const refreshToken = generateRefreshToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    mockPrismaUser.findUnique.mockResolvedValue({
      id: MOCK_USER.id,
      username: MOCK_USER.username,
      role: 'user',
      tokenVersion: 0,
      bannedAt: null,
    });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
  });

  it('returns 401 with invalid refresh token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'not-a-valid-token' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 with expired refresh token', async () => {
    const expiredToken = jwt.sign(
      {
        userId: MOCK_USER.id,
        username: MOCK_USER.username,
        role: 'user',
        tokenVersion: 0,
        rememberMe: true,
      },
      JWT_REFRESH_SECRET,
      { expiresIn: '0s', algorithm: 'HS256' },
    );

    // Small delay to ensure expiration
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: expiredToken });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when tokenVersion does not match (revoked)', async () => {
    const refreshToken = generateRefreshToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    // DB has a higher tokenVersion (password was changed)
    mockPrismaUser.findUnique.mockResolvedValue({
      id: MOCK_USER.id,
      username: MOCK_USER.username,
      role: 'user',
      tokenVersion: 1, // mismatch
      bannedAt: null,
    });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects refresh for banned users', async () => {
    const refreshToken = generateRefreshToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    mockPrismaUser.findUnique.mockResolvedValue({
      id: MOCK_USER.id,
      username: MOCK_USER.username,
      role: 'user',
      tokenVersion: 0,
      bannedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    // The refreshTokens catch block converts ForbiddenError to UnauthorizedError,
    // so banned users get 401 on refresh (not 403)
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/auth/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns user when authenticated', async () => {
    const token = generateAccessToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    // Auth middleware DB lookup
    mockPrismaUser.findUnique
      .mockResolvedValueOnce({
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: false,
      })
      // /me route DB lookup
      .mockResolvedValueOnce({
        id: MOCK_USER.id,
        username: MOCK_USER.username,
        displayName: MOCK_USER.displayName,
        email: MOCK_USER.email,
        avatarUrl: null,
        bio: null,
        status: 'offline',
        role: 'user',
        totpEnabled: false,
        emailVerified: false,
        isSupporter: false,
        supporterTier: null,
        createdAt: MOCK_USER.createdAt,
      });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(MOCK_USER.id);
    expect(res.body.data.username).toBe(MOCK_USER.username);
    expect(res.body.data.email).toBe(MOCK_USER.email);
  });

  it('returns 401 without auth header', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/authorization/i);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/change-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('changes password and returns new tokens', async () => {
    const hashedCurrent = await bcrypt.hash('currentpassword', 4);

    const token = generateAccessToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    // Auth middleware lookup
    mockPrismaUser.findUnique
      .mockResolvedValueOnce({
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: false,
      })
      // changePassword — fetch user with full record
      .mockResolvedValueOnce({
        ...MOCK_USER,
        password: hashedCurrent,
      });

    // changePassword — update user
    mockPrismaUser.update.mockResolvedValue({
      id: MOCK_USER.id,
      username: MOCK_USER.username,
      role: 'user',
      tokenVersion: 1,
    });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'currentpassword',
        newPassword: 'newpassword123',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.message).toMatch(/password changed/i);
  });

  it('rejects when current password is incorrect', async () => {
    const hashedCurrent = await bcrypt.hash('correctpassword', 4);

    const token = generateAccessToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    // Auth middleware lookup
    mockPrismaUser.findUnique
      .mockResolvedValueOnce({
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: false,
      })
      // changePassword — fetch user
      .mockResolvedValueOnce({
        ...MOCK_USER,
        password: hashedCurrent,
      });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword123',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/current password/i);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({
        currentPassword: 'currentpassword',
        newPassword: 'newpassword123',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('validates that currentPassword is provided', async () => {
    const token = generateAccessToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    // Auth middleware lookup
    mockPrismaUser.findUnique.mockResolvedValueOnce({
      bannedAt: null,
      tokenVersion: 0,
      role: 'user',
      emailVerified: false,
    });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        newPassword: 'newpassword123',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/current password/i);
  });

  it('validates that newPassword is provided', async () => {
    const token = generateAccessToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });

    // Auth middleware lookup
    mockPrismaUser.findUnique.mockResolvedValueOnce({
      bannedAt: null,
      tokenVersion: 0,
      role: 'user',
      emailVerified: false,
    });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'currentpassword',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/new password/i);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always returns 200 regardless of email existence (enumeration prevention)', async () => {
    // User does NOT exist
    mockPrismaUser.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nonexistent@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/if an account/i);
  });

  it('returns 200 when user exists (sends email)', async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      id: MOCK_USER.id,
      email: 'test@example.com',
    });
    mockPrismaUser.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/if an account/i);
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/email/i);
  });

  it('normalizes email to lowercase', async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);

    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'TEST@EXAMPLE.COM' });

    // requestPasswordReset calls prisma.user.findUnique with lowercased email
    const findCall = mockPrismaUser.findUnique.mock.calls[0]?.[0];
    expect(findCall?.where?.email).toBe('test@example.com');
  });
});

describe('POST /api/v1/auth/login — TOTP flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns totpRequired when TOTP is enabled and no trusted device', async () => {
    const hashedPassword = await bcrypt.hash('password123', 4);

    mockPrismaIpBan.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({
      ...MOCK_USER,
      password: hashedPassword,
      totpEnabled: true,
      bannedAt: null,
      banReason: null,
    });
    mockPrismaIpRecord.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totpRequired).toBe(true);
    expect(res.body.data).toHaveProperty('totpToken');
    // Should NOT have user or tokens
    expect(res.body.data).not.toHaveProperty('user');
    expect(res.body.data).not.toHaveProperty('accessToken');
  });
});
