import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Router } from 'express';

// ─── Environment variables (must be set before any app import) ───────────────

const JWT_SECRET = 'test-jwt-secret-for-unit-tests';
const JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-for-unit-tests';

process.env.JWT_SECRET = JWT_SECRET;
process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockPrismaUser, mockPrismaIpBan, mockPrismaIpRecord, mockPrismaMailSuppression, mockRedisClient, passthroughMiddleware } = vi.hoisted(() => {
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

  const mockPrismaMailSuppression = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  };

  const mockPrismaIpRecord = {
    upsert: vi.fn(),
    // resolved value matters: the service calls .catch() on the returned
    // promise, and a bare vi.fn() returns undefined
    create: vi.fn().mockResolvedValue({}),
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

  return { mockPrismaUser, mockPrismaIpBan, mockPrismaIpRecord, mockPrismaMailSuppression, mockRedisClient, passthroughMiddleware };
});

// Mock Prisma — must be declared before app import
vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: mockPrismaUser,
    ipBan: mockPrismaIpBan,
    ipRecord: mockPrismaIpRecord,
    mailSuppression: mockPrismaMailSuppression,
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
  describeEmailError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  MailSuppressedError: class MailSuppressedError extends Error {},
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

// Self-service deletion: the shared core and the TOTP check are mocked so the
// route's own decisions (re-auth, owned-server refusal, audit row) are what
// the tests observe.
const { deleteUserAccountMock, verifyTOTPMock, logAuditEventMock } = vi.hoisted(() => ({
  deleteUserAccountMock: vi.fn().mockResolvedValue(undefined),
  verifyTOTPMock: vi.fn().mockResolvedValue(true),
  logAuditEventMock: vi.fn(),
}));
vi.mock('../../utils/accountDeletion', () => ({ deleteUserAccount: (...a: unknown[]) => deleteUserAccountMock(...a) }));
vi.mock('../../services/totpService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/totpService')>();
  return { ...actual, verifyTOTP: (...a: unknown[]) => verifyTOTPMock(...a) };
});
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: (...a: unknown[]) => logAuditEventMock(...a) }));
const revokeUserSessionsMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sessionRevocation', () => ({ revokeUserSessions: (...a: unknown[]) => revokeUserSessionsMock(...a) }));
vi.mock('../../routes/admin', () => ({ adminRouter: Router() }));
vi.mock('../../routes/support', () => ({ supportRouter: Router() }));
vi.mock('../../routes/roles', () => ({ roleRouter: Router() }));

// Mock rate limiters — pass through all requests for most tests
// The registration limiters are spies, so each route's chain can be observed.
const {
  rateLimitRegisterMock, rateLimitRegisterAttemptMock, rateLimitRegisterAttemptSubnetMock,
  rateLimitRegisterCompleteMock, rateLimitRegisterResendMock, chargeRegistrationBudgetsMock,
} = vi.hoisted(() => {
  const spy = () => vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
  return {
    rateLimitRegisterMock: spy(),
    rateLimitRegisterAttemptMock: spy(),
    rateLimitRegisterAttemptSubnetMock: spy(),
    rateLimitRegisterCompleteMock: spy(),
    rateLimitRegisterResendMock: spy(),
    chargeRegistrationBudgetsMock: spy(),
  };
});
vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitRegister: rateLimitRegisterMock,
  rateLimitRegisterAttempt: rateLimitRegisterAttemptMock,
  rateLimitRegisterAttemptSubnet: rateLimitRegisterAttemptSubnetMock,
  rateLimitRegisterComplete: rateLimitRegisterCompleteMock,
  rateLimitRegisterResend: rateLimitRegisterResendMock,
  chargeRegistrationBudgets: chargeRegistrationBudgetsMock,
  rateLimitPowChallenge: passthroughMiddleware,
  normalizeIp: (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip),
  subnetOf: (ip: string) => ip,
  consumeMailCap: vi.fn().mockResolvedValue(true),
  refundRateLimit: vi.fn().mockResolvedValue(undefined),
  getSubnetRegistrationPressure: vi.fn().mockResolvedValue(0),
  getDomainRegistrationCount: vi.fn().mockResolvedValue(0),
  countDomainRegistration: vi.fn().mockResolvedValue(undefined),
  domainRegistrationCap: vi.fn().mockReturnValue(10),
  rateLimitLogin: passthroughMiddleware,
  rateLimitLoginAccount: passthroughMiddleware,
  rateLimitLoginSubnet: passthroughMiddleware,
  rateLimitTotpAccount: passthroughMiddleware,
  rateLimitForgotPassword: passthroughMiddleware,
  rateLimitResetPassword: passthroughMiddleware,
  rateLimitRefresh: passthroughMiddleware,
  rateLimitChangePassword: passthroughMiddleware,
  rateLimitTOTP: passthroughMiddleware,
  rateLimitVerifyEmail: passthroughMiddleware,
  rateLimitMailBlock: passthroughMiddleware,
  rateLimitResendVerification: passthroughMiddleware,
  rateLimitConsent: passthroughMiddleware,
  rateLimitDeleteAccount: passthroughMiddleware,
  rateLimitGeneral: passthroughMiddleware,
  rateLimitMessageSend: passthroughMiddleware,
  rateLimitUpload: passthroughMiddleware,
  rateLimitFriendRequest: passthroughMiddleware,
  rateLimitMemberManage: passthroughMiddleware,
  rateLimitMemberLookup: passthroughMiddleware,
  rateLimitCategoryManage: passthroughMiddleware,
  rateLimitSearch: passthroughMiddleware,
  rateLimitStats: passthroughMiddleware,
  rateLimitAdmin: passthroughMiddleware,
  rateLimitReport: passthroughMiddleware,
  rateLimitSupport: passthroughMiddleware,
  rateLimitMarkRead: passthroughMiddleware,
  rateLimitRoleManage: passthroughMiddleware,
  rateLimitSecureChannelManage: passthroughMiddleware,
  rateLimitThemeManage: passthroughMiddleware,
  rateLimitThemeBrowse: passthroughMiddleware,
  rateLimitDiscoveryBrowse: passthroughMiddleware,
  rateLimitDiscoveryJoin: passthroughMiddleware,
  rateLimitE2EDevice: passthroughMiddleware,
  rateLimitE2EKeys: passthroughMiddleware,
  rateLimitE2EBundle: passthroughMiddleware,
  rateLimitE2EStatus: passthroughMiddleware,
  rateLimitE2EShares: passthroughMiddleware,
  rateLimitE2EApprove: passthroughMiddleware,
  rateLimitWebhookExecuteIp: passthroughMiddleware,
  rateLimitWebhookExecute: passthroughMiddleware,
  rateLimitWebhookSignature: () => passthroughMiddleware,
  rateLimitWebhookManage: passthroughMiddleware,
  rateLimitWebhookRead: passthroughMiddleware,
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

// Mock the registration proof-of-work: verification has its own unit suite
// (registrationPow.test.ts); route tests only assert it is REQUIRED and wired.
const { mockVerifyPow, mockIssueChallenge } = vi.hoisted(() => ({
  mockVerifyPow: vi.fn().mockResolvedValue(undefined),
  mockIssueChallenge: vi.fn(() => ({ challenge: 'c'.repeat(32), difficulty: 4, expires: 4102444800000, sig: 's'.repeat(64) })),
}));
vi.mock('../../utils/registrationPow', () => ({
  issueRegistrationChallenge: mockIssueChallenge,
  verifyRegistrationPow: mockVerifyPow,
}));

// Verify-first registration: the service is mocked, the routes are under test
const { startRegistrationMock, completeRegistrationMock, resendRegistrationCodeMock } = vi.hoisted(() => ({
  startRegistrationMock: vi.fn(),
  completeRegistrationMock: vi.fn(),
  resendRegistrationCodeMock: vi.fn(),
}));
vi.mock('../../services/signupService', () => ({
  startRegistration: (...a: unknown[]) => startRegistrationMock(...a),
  completeRegistration: (...a: unknown[]) => completeRegistrationMock(...a),
  resendRegistrationCode: (...a: unknown[]) => resendRegistrationCodeMock(...a),
  purgeExpiredSignupState: vi.fn().mockResolvedValue({ pending: 0, ledger: 0 }),
}));

// Now import the app (after all mocks are set up)
import { app } from '../../app';
import { isFeatureEnabled } from '../../utils/featureFlags';
import { BadRequestError, ConflictError, ForbiddenError } from '../../utils/errors';
import { SIGNUP, USERNAME_TAKEN_MESSAGE, SIGNUP_CODE_INVALID_MESSAGE, SIGNUP_EMAIL_REGISTERED_MESSAGE } from '@voxium/shared';

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

describe('GET /api/v1/auth/register-challenge', () => {
  it('returns a signed proof-of-work challenge', async () => {
    const res = await request(app).get('/api/v1/auth/register-challenge');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ difficulty: expect.any(Number), sig: expect.any(String) });
    expect(mockIssueChallenge).toHaveBeenCalled();
  });
});

// ─── Verify-first registration (services/signupService.ts, mocked here) ──────
// The service has its own suite (signupService.test.ts); these tests observe
// what the ROUTES decide: the gates, their order, the limiters on each route,
// the status codes and the exact shapes.

const START_BODY = {
  username: 'testuser',
  email: 'test@example.com',
  password: 'password123',
  acceptTerms: true,
  acceptPrivacy: true,
};
const START_RESULT = { pendingId: 'p'.repeat(22), resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS };

/** Only the registration flag is turned off: other middleware may read other flags. */
function registrationDisabled() {
  vi.mocked(isFeatureEnabled).mockImplementation((name: string) => name !== 'registration');
}

const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

beforeEach(() => {
  vi.mocked(isFeatureEnabled).mockImplementation(() => true);
  startRegistrationMock.mockReset().mockResolvedValue(START_RESULT);
  completeRegistrationMock.mockReset();
  resendRegistrationCodeMock.mockReset().mockImplementation(async (pendingId: string) => ({
    pendingId, resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS,
  }));
});

describe('POST /api/v1/auth/register — consent (CNIL/GDPR)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['no consent at all', {}],
    ['terms only', { acceptTerms: true }],
    ['privacy only', { acceptPrivacy: true }],
    ['a truthy string is not acceptance', { acceptTerms: 'true', acceptPrivacy: 'true' }],
    ['explicit refusal', { acceptTerms: true, acceptPrivacy: false }],
  ])('refuses to start a registration with %s', async (_label, consent) => {
    const { acceptTerms: _t, acceptPrivacy: _p, ...body } = START_BODY;
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...body, ...consent });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accept the (Terms of Service|Privacy Policy)/);
    expect(startRegistrationMock).not.toHaveBeenCalled();
    // Refused with the other cheap validations, BEFORE the proof-of-work is
    // verified — a verify burns the challenge, and the client only refetches
    // one on expiry
    expect(mockVerifyPow).not.toHaveBeenCalled();
  });

  it('hands both acceptances to the service as the literal booleans it records', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(START_BODY);

    expect(res.status).toBe(202);
    expect(startRegistrationMock).toHaveBeenCalledWith(
      'testuser', 'test@example.com', 'password123', undefined, expect.any(String),
      { acceptTerms: true, acceptPrivacy: true },
    );
  });
});

describe('POST /api/v1/auth/register — proof-of-work gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies the PoW BEFORE the service runs — a failed solve never reaches it', async () => {
    mockVerifyPow.mockRejectedValueOnce(new BadRequestError('Registration challenge is invalid or expired — refresh and try again'));

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...START_BODY, username: 'bot', email: 'bot@example.com' });

    expect(mockVerifyPow).toHaveBeenCalled();
    expect(startRegistrationMock).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Registration challenge is invalid or expired — refresh and try again');
  });

  it('verifies the submitted solution against the caller\'s normalized address', async () => {
    const pow = { challenge: 'c'.repeat(32), difficulty: 4, expires: 4102444800000, sig: 's'.repeat(64), nonce: '42' };
    await request(app).post('/api/v1/auth/register').send({ ...START_BODY, pow });

    expect(mockVerifyPow).toHaveBeenCalledWith(expect.any(String), pow);
    expect(mockVerifyPow.mock.calls[0][0]).not.toMatch(/^::ffff:/i);
    expect(order(mockVerifyPow)).toBeLessThan(order(startRegistrationMock));
  });

  it.each([
    ['a missing username', { username: undefined }, 'Username is required'],
    ['a missing email', { email: undefined }, 'Email is required'],
    ['a missing password', { password: undefined }, 'Password is required'],
    ['a non-string username', { username: ['testuser'] }, 'Username is required'],
    ['a non-string display name', { displayName: { html: '<b>x</b>' } }, 'Display name must be a string'],
  ])('refuses %s with a 400 before the PoW is verified', async (_label, patch, message) => {
    const res = await request(app).post('/api/v1/auth/register').send({ ...START_BODY, ...patch });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: message });
    expect(mockVerifyPow).not.toHaveBeenCalled();
    expect(startRegistrationMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/register — the start of a verify-first registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 202 with the pending id and the resend delay, and NO account or tokens', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ ...START_BODY, displayName: 'Tester' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, data: START_RESULT });
    expect(startRegistrationMock).toHaveBeenCalledWith(
      'testuser', 'test@example.com', 'password123', 'Tester', expect.any(String),
      { acceptTerms: true, acceptPrivacy: true },
    );
    expect(mockPrismaUser.create).not.toHaveBeenCalled();
  });

  it('answers the same 202 for an address that already has an account (the service decides, the route says nothing)', async () => {
    const first = await request(app).post('/api/v1/auth/register').send(START_BODY);
    const second = await request(app).post('/api/v1/auth/register').send({ ...START_BODY, email: 'already@example.com' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(Object.keys(second.body.data).sort()).toEqual(Object.keys(first.body.data).sort());
  });

  it('a taken username is the one 409, with the public message', async () => {
    startRegistrationMock.mockRejectedValueOnce(new ConflictError(USERNAME_TAKEN_MESSAGE));

    const res = await request(app).post('/api/v1/auth/register').send({ ...START_BODY, username: 'Alice' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: USERNAME_TAKEN_MESSAGE });
  });

  it('passes the service\'s validation refusals and the IP ban through', async () => {
    startRegistrationMock.mockRejectedValueOnce(new BadRequestError('Invalid email address'));
    const invalid = await request(app).post('/api/v1/auth/register').send({ ...START_BODY, email: 'victim@gmail.com(1)' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Invalid email address');

    startRegistrationMock.mockRejectedValueOnce(new ForbiddenError('Account banned: bot wave'));
    const banned = await request(app).post('/api/v1/auth/register').send(START_BODY);
    expect(banned.status).toBe(403);
    expect(banned.body.error).toBe('Account banned: bot wave');
  });

  it('a disabled registration answers 403 before the PoW and the service', async () => {
    registrationDisabled();

    const res = await request(app).post('/api/v1/auth/register').send(START_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Registration is currently disabled' });
    expect(mockVerifyPow).not.toHaveBeenCalled();
    expect(startRegistrationMock).not.toHaveBeenCalled();
  });

  it('runs the attempt limiters, and NOT the success budgets (nothing is created here)', async () => {
    await request(app).post('/api/v1/auth/register').send(START_BODY);

    expect(rateLimitRegisterMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRegisterAttemptMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRegisterAttemptSubnetMock).toHaveBeenCalledTimes(1);
    expect(chargeRegistrationBudgetsMock).not.toHaveBeenCalled();
    expect(rateLimitRegisterCompleteMock).not.toHaveBeenCalled();
    expect(rateLimitRegisterResendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/register/complete', () => {
  const COMPLETE_RESULT = {
    user: {
      id: 'user-123', username: 'testuser', displayName: 'testuser', email: 'test@example.com',
      avatarUrl: null, bio: null, status: 'offline', role: 'user', totpEnabled: false,
      emailVerified: true, isSupporter: false, supporterTier: null, createdAt: '2026-10-30T00:00:00.000Z',
      consentRequired: false,
    },
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    completeRegistrationMock.mockResolvedValue(COMPLETE_RESULT);
  });

  it('answers 201 with the user and tokens — the answer the one-step registration gave', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: COMPLETE_RESULT });
    expect(completeRegistrationMock).toHaveBeenCalledWith('p'.repeat(22), '123456', undefined, expect.any(String));
  });

  it('forwards a new username with the same code, and the raw values for the service to check', async () => {
    await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456', username: 'other_name' });
    expect(completeRegistrationMock).toHaveBeenLastCalledWith('p'.repeat(22), '123456', 'other_name', expect.any(String));

    await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 7, code: 123456 });
    expect(completeRegistrationMock).toHaveBeenLastCalledWith(7, 123456, undefined, expect.any(String));
  });

  it.each([
    ['a refused code', new BadRequestError(SIGNUP_CODE_INVALID_MESSAGE), 400, SIGNUP_CODE_INVALID_MESSAGE],
    ['a taken username', new ConflictError(USERNAME_TAKEN_MESSAGE), 409, USERNAME_TAKEN_MESSAGE],
    ['an address that already has an account', new ConflictError(SIGNUP_EMAIL_REGISTERED_MESSAGE), 409, SIGNUP_EMAIL_REGISTERED_MESSAGE],
  ])('answers %s with its status and exact message', async (_label, err, status, message) => {
    completeRegistrationMock.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456' });

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ success: false, error: message });
  });

  it('a disabled registration answers 403 without completing anything', async () => {
    registrationDisabled();

    const res = await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Registration is currently disabled' });
    expect(completeRegistrationMock).not.toHaveBeenCalled();
  });

  it('runs its own limiter, then charges the success budgets — where an account is created', async () => {
    await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456' });

    expect(rateLimitRegisterCompleteMock).toHaveBeenCalledTimes(1);
    expect(chargeRegistrationBudgetsMock).toHaveBeenCalledTimes(1);
    expect(order(rateLimitRegisterCompleteMock)).toBeLessThan(order(chargeRegistrationBudgetsMock));
    expect(order(chargeRegistrationBudgetsMock)).toBeLessThan(order(completeRegistrationMock));
    // The start's attempt buckets are not charged again here, and no PoW is asked
    expect(rateLimitRegisterMock).not.toHaveBeenCalled();
    expect(rateLimitRegisterAttemptMock).not.toHaveBeenCalled();
    expect(rateLimitRegisterAttemptSubnetMock).not.toHaveBeenCalled();
    expect(mockVerifyPow).not.toHaveBeenCalled();
  });

  it('a spent success budget stops the request before the service', async () => {
    chargeRegistrationBudgetsMock.mockImplementationOnce((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    });

    const res = await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456' });

    expect(res.status).toBe(429);
    expect(completeRegistrationMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/register/resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always answers 202 with the pending id and the resend delay', async () => {
    const res = await request(app).post('/api/v1/auth/register/resend').send({ pendingId: 'p'.repeat(22) });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, data: { pendingId: 'p'.repeat(22), resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS } });
    expect(resendRegistrationCodeMock).toHaveBeenCalledWith('p'.repeat(22));
  });

  it.each([
    ['a missing id', {}],
    ['a numeric id', { pendingId: 42 }],
    ['an object id', { pendingId: { $ne: null } }],
  ])('hands the service an empty id for %s', async (_label, body) => {
    const res = await request(app).post('/api/v1/auth/register/resend').send(body);

    expect(res.status).toBe(202);
    expect(resendRegistrationCodeMock).toHaveBeenCalledWith('');
  });

  it('a disabled registration answers 403 without resending', async () => {
    registrationDisabled();

    const res = await request(app).post('/api/v1/auth/register/resend').send({ pendingId: 'p'.repeat(22) });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Registration is currently disabled' });
    expect(resendRegistrationCodeMock).not.toHaveBeenCalled();
  });

  it('runs its own limiter and charges no registration budget', async () => {
    await request(app).post('/api/v1/auth/register/resend').send({ pendingId: 'p'.repeat(22) });

    expect(rateLimitRegisterResendMock).toHaveBeenCalledTimes(1);
    expect(chargeRegistrationBudgetsMock).not.toHaveBeenCalled();
    expect(rateLimitRegisterCompleteMock).not.toHaveBeenCalled();
    expect(rateLimitRegisterMock).not.toHaveBeenCalled();
  });

  it('a service failure is an error response, not a silent 202', async () => {
    resendRegistrationCodeMock.mockRejectedValueOnce(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/api/v1/auth/register/resend').send({ pendingId: 'p'.repeat(22) });

    expect(res.status).toBe(500);
    error.mockRestore();
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
        acceptTerms: true,
        acceptPrivacy: true,
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
        acceptTerms: true,
        acceptPrivacy: true,
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('burns a bcrypt compare for unknown emails so timing matches a wrong password (MED-3)', async () => {
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    try {
      mockPrismaIpBan.findUnique.mockResolvedValue(null);
      mockPrismaUser.findUnique.mockResolvedValue(null); // unknown email

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'ghost@example.com',
          password: 'password123',
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
      // The timing-equalizer hash must be compared against even with no user
      // (the first such call also lazily builds the hash via one bcrypt.hash)
      expect(compareSpy).toHaveBeenCalled();
    } finally {
      compareSpy.mockRestore();
    }
  }, 20000); // first run pays a cost-12 bcrypt.hash for the equalizer hash

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
        acceptTerms: true,
        acceptPrivacy: true,
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
        acceptTerms: true,
        acceptPrivacy: true,
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
        acceptTerms: true,
        acceptPrivacy: true,
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

  it('answers 500, NOT 401, when the user lookup fails: the client keeps its session through a database blip', async () => {
    const refreshToken = generateRefreshToken({
      userId: MOCK_USER.id,
      username: MOCK_USER.username,
      tokenVersion: 0,
    });
    mockPrismaUser.findUnique.mockRejectedValueOnce(Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    error.mockRestore();
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

  it('returns 400 when refreshToken is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/refresh token/i);
  });

  it('returns 400 when refreshToken is not a string', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/refresh token/i);
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
        termsAcceptedAt: null,
        privacyAcceptedAt: null,
      });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(MOCK_USER.id);
    expect(res.body.data.username).toBe(MOCK_USER.username);
    expect(res.body.data.email).toBe(MOCK_USER.email);
    // The client gates on this flag; the timestamps themselves stay server-side
    expect(res.body.data.consentRequired).toBe(true);
    expect(res.body.data).not.toHaveProperty('termsAcceptedAt');
    expect(res.body.data).not.toHaveProperty('privacyAcceptedAt');
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
    // Every socket opened with the old tokens is disconnected, without a
    // force:logout (the caller keeps its session with the fresh pair)
    expect(revokeUserSessionsMock).toHaveBeenCalledTimes(1);
    expect(revokeUserSessionsMock).toHaveBeenCalledWith(MOCK_USER.id);
  });

  it('revokes the sessions only AFTER the new password and token version are written', async () => {
    const hashedCurrent = await bcrypt.hash('currentpassword', 4);
    const token = generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
    const order: string[] = [];
    mockPrismaUser.findUnique
      .mockResolvedValueOnce({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false })
      .mockResolvedValueOnce({ ...MOCK_USER, password: hashedCurrent });
    mockPrismaUser.update.mockImplementation(async () => {
      order.push('update');
      return { id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 1 };
    });
    revokeUserSessionsMock.mockImplementationOnce(() => { order.push('revoke'); });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'currentpassword', newPassword: 'newpassword123' });

    expect(res.status).toBe(200);
    expect(order).toEqual(['update', 'revoke']);
  });

  it('revokes nothing when the password change is refused', async () => {
    const token = generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
    mockPrismaUser.findUnique
      .mockResolvedValueOnce({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false })
      .mockResolvedValueOnce({ ...MOCK_USER, password: await bcrypt.hash('correctpassword', 4) });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrongpassword', newPassword: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
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

describe('POST /api/v1/auth/reset-password', () => {
  const RAW_TOKEN = 'a'.repeat(64);
  const HASHED = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets the password, bumps the token version and disconnects every live socket of the account', async () => {
    const order: string[] = [];
    mockPrismaUser.findUnique.mockResolvedValueOnce({ ...MOCK_USER, resetToken: HASHED, resetTokenExpiresAt: new Date(Date.now() + 60_000) });
    mockPrismaUser.update.mockImplementationOnce(async () => { order.push('update'); return {}; });
    revokeUserSessionsMock.mockImplementationOnce(() => { order.push('revoke'); });

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: RAW_TOKEN.toUpperCase(), password: 'brandnewpassword1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({ where: { resetToken: HASHED } });
    expect(mockPrismaUser.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: MOCK_USER.id },
      data: expect.objectContaining({ resetToken: null, resetTokenExpiresAt: null, tokenVersion: { increment: 1 } }),
    }));
    // The account's sockets go once the new token version is committed, with
    // no force:logout reason: the holder of the reset link signs in afresh
    expect(revokeUserSessionsMock).toHaveBeenCalledWith(MOCK_USER.id);
    expect(revokeUserSessionsMock.mock.calls[0]).toHaveLength(1);
    expect(order).toEqual(['update', 'revoke']);
  });

  it('answers 400 for an unknown token and revokes nothing', async () => {
    mockPrismaUser.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'brandnewpassword1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired reset token/i);
    expect(mockPrismaUser.update).not.toHaveBeenCalled();
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
  });

  it('answers 400 for an expired token, clears it, and revokes nothing', async () => {
    mockPrismaUser.findUnique.mockResolvedValueOnce({ ...MOCK_USER, resetToken: HASHED, resetTokenExpiresAt: new Date(Date.now() - 1000) });
    mockPrismaUser.update.mockResolvedValueOnce({});

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'brandnewpassword1' });

    expect(res.status).toBe(400);
    expect(mockPrismaUser.update).toHaveBeenCalledWith({ where: { id: MOCK_USER.id }, data: { resetToken: null, resetTokenExpiresAt: null } });
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a password the policy refuses, before any lookup', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'short' });

    expect(res.status).toBe(400);
    expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ password: 'brandnewpassword1' }, /reset token is required/i],
    [{ token: 42, password: 'brandnewpassword1' }, /reset token is required/i],
    [{ token: RAW_TOKEN }, /password is required/i],
  ])('answers 400 for a missing field (%o)', async (body, error) => {
    const res = await request(app).post('/api/v1/auth/reset-password').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(error);
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed write as an error, with no revocation', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrismaUser.findUnique.mockResolvedValueOnce({ ...MOCK_USER, resetToken: HASHED, resetTokenExpiresAt: new Date(Date.now() + 60_000) });
    mockPrismaUser.update.mockRejectedValueOnce(new Error('db gone'));

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'brandnewpassword1' });

    expect(res.status).toBe(500);
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
    err.mockRestore();
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

describe('POST /api/v1/auth/mail-block — "Not you? Block Voxium mail to this address"', () => {
  // The real token helpers: this is the signature, purpose and digest check
  // the routes rely on, against the JWT_SECRET this file sets.
  let mailBlockToken: (email: string) => string;
  let mailboxDigest: (email: string) => string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ mailBlockToken, mailboxDigest } = await import('../../utils/mailSuppression'));
    mockPrismaMailSuppression.findUnique.mockResolvedValue(null);
    mockPrismaMailSuppression.upsert.mockResolvedValue({});
    mockPrismaMailSuppression.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('status answers whether the mailbox the token names is blocked', async () => {
    const token = mailBlockToken('victim+1@outlook.com');

    let res = await request(app).post('/api/v1/auth/mail-block/status').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { blocked: false } });
    expect(mockPrismaMailSuppression.findUnique).toHaveBeenCalledWith({
      where: { mailboxHash: mailboxDigest('victim@outlook.com') },
      select: { mailboxHash: true },
    });

    mockPrismaMailSuppression.findUnique.mockResolvedValue({ mailboxHash: mailboxDigest('victim@outlook.com') });
    res = await request(app).post('/api/v1/auth/mail-block/status').send({ token });
    expect(res.body).toEqual({ success: true, data: { blocked: true } });
  });

  it('block puts the mailbox digest on the list — one click, no session, no address in the request', async () => {
    const token = mailBlockToken('victim@example.com');
    const res = await request(app).post('/api/v1/auth/mail-block').send({ token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { blocked: true } });
    expect(mockPrismaMailSuppression.upsert).toHaveBeenCalledWith({
      where: { mailboxHash: mailboxDigest('victim@example.com') },
      create: { mailboxHash: mailboxDigest('victim@example.com') },
      update: {},
    });
    expect(JSON.stringify(mockPrismaMailSuppression.upsert.mock.calls)).not.toContain('victim@example.com');
  });

  it('unblock takes it off again (the mailbox owner can change their mind from the same link)', async () => {
    const token = mailBlockToken('victim@example.com');
    const res = await request(app).post('/api/v1/auth/mail-unblock').send({ token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { blocked: false } });
    expect(mockPrismaMailSuppression.deleteMany).toHaveBeenCalledWith({
      where: { mailboxHash: mailboxDigest('victim@example.com') },
    });
  });

  it.each(['/mail-block/status', '/mail-block', '/mail-unblock'])('%s answers one 400 for a missing, malformed, forged or foreign-purpose token', async (path) => {
    const forged = jwt.sign({ purpose: 'mail-block', m: 'a'.repeat(64) }, 'wrong-secret', { algorithm: 'HS256' });
    const access = jwt.sign({ userId: 'u-1', username: 'alice' }, JWT_SECRET, { algorithm: 'HS256' });
    const totp = jwt.sign({ userId: 'u-1', purpose: 'totp-verify' }, JWT_SECRET, { algorithm: 'HS256' });

    for (const body of [{}, { token: '' }, { token: 42 }, { token: 'garbage' }, { token: forged }, { token: access }, { token: totp }, { token: 'x'.repeat(1025) }]) {
      const res = await request(app).post(`/api/v1/auth${path}`).send(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Invalid or expired mail-block link' });
    }
    expect(mockPrismaMailSuppression.findUnique).not.toHaveBeenCalled();
    expect(mockPrismaMailSuppression.upsert).not.toHaveBeenCalled();
    expect(mockPrismaMailSuppression.deleteMany).not.toHaveBeenCalled();
  });

  it('a store failure is a 500, never a false "blocked" or a silent success', async () => {
    const token = mailBlockToken('victim@example.com');
    mockPrismaMailSuppression.upsert.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/api/v1/auth/mail-block').send({ token });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it('the token opens nothing else: /auth/me refuses it', async () => {
    const token = mailBlockToken('victim@example.com');
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
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
        acceptTerms: true,
        acceptPrivacy: true,
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

// ─── POST /api/v1/auth/consent — existing accounts accept the documents ─────

describe('POST /api/v1/auth/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaUser.updateMany = vi.fn().mockResolvedValue({ count: 1 });
  });

  function authAs(userId = MOCK_USER.id) {
    // Auth middleware lookup: a pre-consent account
    mockPrismaUser.findUnique.mockResolvedValueOnce({
      bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: null, privacyAcceptedAt: null,
    });
    return generateAccessToken({ userId, username: MOCK_USER.username, tokenVersion: 0 });
  }

  it('records both acceptances and clears the gate', async () => {
    const res = await request(app)
      .post('/api/v1/auth/consent')
      .set('Authorization', `Bearer ${authAs()}`)
      .send({ acceptTerms: true, acceptPrivacy: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ consentRequired: false });
    // Null-guarded writes: a FIRST acceptance is recorded, an existing
    // timestamp is never moved forward (it is the accountability record)
    expect(mockPrismaUser.updateMany).toHaveBeenCalledWith({
      where: { id: MOCK_USER.id, termsAcceptedAt: null }, data: { termsAcceptedAt: expect.any(Date) },
    });
    expect(mockPrismaUser.updateMany).toHaveBeenCalledWith({
      where: { id: MOCK_USER.id, privacyAcceptedAt: null }, data: { privacyAcceptedAt: expect.any(Date) },
    });
  });

  it.each([
    ['nothing', {}],
    ['terms only', { acceptTerms: true }],
    ['privacy only', { acceptPrivacy: true }],
    ['a truthy string', { acceptTerms: 'yes', acceptPrivacy: 'yes' }],
  ])('records nothing when given %s', async (_label, body) => {
    const res = await request(app)
      .post('/api/v1/auth/consent')
      .set('Authorization', `Bearer ${authAs()}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();
  });

  it('is reachable by a pre-consent account — it is the route that clears the gate', async () => {
    // Same auth row as above (consentRequired: true); a requireConsent on
    // this route would lock legacy accounts out permanently
    const res = await request(app)
      .post('/api/v1/auth/consent')
      .set('Authorization', `Bearer ${authAs()}`)
      .send({ acceptTerms: true, acceptPrivacy: true });
    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/consent').send({ acceptTerms: true, acceptPrivacy: true });
    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/v1/auth/account — self-service erasure ─────────────────────

describe('DELETE /api/v1/auth/account', () => {
  const PASSWORD = 'ValidPass123';
  let hash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // mockReset, not clear: a test that is refused before the service lookup
    // leaves its second queued row for the NEXT test's auth middleware
    mockPrismaUser.findUnique.mockReset();
    const bcrypt = await import('bcryptjs');
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  /** Auth lookup + the service's own lookup, in that order. */
  function mockAccount(row: Record<string, unknown>) {
    mockPrismaUser.findUnique
      // authenticate(): a pre-consent, unverified account — deletion must
      // still be reachable for it
      .mockResolvedValueOnce({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false, termsAcceptedAt: null, privacyAcceptedAt: null })
      .mockResolvedValueOnce({ id: MOCK_USER.id, password: hash, totpEnabled: false, ownedServers: [], ...row });
    return generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
  }

  it('deletes the account after re-authenticating with the password, and audits it as a self-deletion', async () => {
    const token = mockAccount({});
    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(deleteUserAccountMock).toHaveBeenCalledWith(MOCK_USER.id, expect.objectContaining({ reason: expect.any(String) }));
    expect(logAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      actorId: null, action: 'user.delete', targetId: MOCK_USER.id, metadata: { trigger: 'self' },
    }));
  });

  it('is reachable by an unverified, unconsented account — leaving must always be possible', async () => {
    // mockAccount's auth row is exactly that account
    const token = mockAccount({});
    const res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${token}`).send({ password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('refuses a wrong password — a stolen session is not enough to erase someone', async () => {
    const token = mockAccount({});
    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'not-it' });

    expect(res.status).toBe(400);
    expect(deleteUserAccountMock).not.toHaveBeenCalled();
  });

  it('requires the password at all', async () => {
    const token = mockAccount({});
    const res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(deleteUserAccountMock).not.toHaveBeenCalled();
  });

  it('with TOTP enabled, requires a valid code on top of the password', async () => {
    let token = mockAccount({ totpEnabled: true });
    let res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${token}`).send({ password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Two-factor/);
    expect(deleteUserAccountMock).not.toHaveBeenCalled();

    verifyTOTPMock.mockResolvedValueOnce(false);
    token = mockAccount({ totpEnabled: true });
    res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${token}`).send({ password: PASSWORD, totpCode: '000000' });
    expect(res.status).toBe(400);
    expect(deleteUserAccountMock).not.toHaveBeenCalled();

    verifyTOTPMock.mockResolvedValueOnce(true);
    token = mockAccount({ totpEnabled: true });
    res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${token}`).send({ password: PASSWORD, totpCode: '123 456' });
    expect(res.status).toBe(200);
    expect(verifyTOTPMock).toHaveBeenCalledWith(MOCK_USER.id, '123456');
    expect(deleteUserAccountMock).toHaveBeenCalledTimes(1);
  });

  it('answers 409 with the servers the account still owns — transfer or delete them first', async () => {
    const token = mockAccount({ ownedServers: [{ id: 's-1', name: 'My Guild' }, { id: 's-2', name: 'Study group' }] });
    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.data.ownedServers).toEqual([{ id: 's-1', name: 'My Guild' }, { id: 's-2', name: 'Study group' }]);
    expect(deleteUserAccountMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await request(app).delete('/api/v1/auth/account').send({ password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/resend-verification', () => {
  function authAs() {
    // Auth middleware lookup: a signed-in, not yet verified account
    mockPrismaUser.findUnique.mockResolvedValueOnce({
      bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    return generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaMailSuppression.findUnique.mockResolvedValue(null);
    mockPrismaUser.update.mockResolvedValue({});
    mockPrismaUser.updateMany = vi.fn().mockResolvedValue({ count: 1 });
  });

  const resend = (token: string) => request(app)
    .post('/api/v1/auth/resend-verification')
    .set('Authorization', `Bearer ${token}`);

  it('answers 200 when the mail goes out', async () => {
    const token = authAs();
    mockPrismaUser.findUnique.mockResolvedValueOnce({
      id: MOCK_USER.id, email: MOCK_USER.email, emailVerified: false,
      emailVerificationToken: null, emailVerificationTokenExpiresAt: null,
    });

    const res = await resend(token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Verification email sent.' });
  });

  it('answers 503 with the sentence the client maps when the mail cannot be sent, and restores the previous link', async () => {
    const { sendVerificationEmail } = await import('../../utils/email');
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExpiry = new Date('2026-11-12T09:00:00Z');
    const token = authAs();
    mockPrismaUser.findUnique.mockResolvedValueOnce({
      id: MOCK_USER.id, email: MOCK_USER.email, emailVerified: false,
      emailVerificationToken: 'c'.repeat(64), emailVerificationTokenExpiresAt: previousExpiry,
    });

    try {
      const res = await resend(token);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ success: false, error: 'The verification email could not be sent — please try again later' });
      expect(mockPrismaUser.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { emailVerificationToken: 'c'.repeat(64), emailVerificationTokenExpiresAt: previousExpiry },
      }));
    } finally {
      errorLog.mockRestore();
    }
  });
});
