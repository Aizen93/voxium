import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { Router } from 'express';
import { TEST_JWT_SECRET, TEST_JWT_REFRESH_SECRET } from '../helpers/testSecrets';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Environment variables (must be set before any app import) ───────────────

// The suite's own test-only secrets (setup.ts assigns the same)
const JWT_SECRET = TEST_JWT_SECRET;
const JWT_REFRESH_SECRET = TEST_JWT_REFRESH_SECRET;

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

// Mock Prisma — must be declared before app import. A transaction runs its
// callback on the same mocks (a password change bumps the version in one).
vi.mock('../../utils/prisma', () => {
  const prisma = {
    user: mockPrismaUser,
    ipBan: mockPrismaIpBan,
    ipRecord: mockPrismaIpRecord,
    mailSuppression: mockPrismaMailSuppression,
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

// The sessions' statements (utils/sessionStore.ts, proven against a real
// PostgreSQL elsewhere): the routes and the real session service are under
// test here. Defaults: a sign-in writes generation 1, nothing else is found.
const { sessionStore } = vi.hoisted(() => {
  const exp = () => Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    sessionStore: {
      insertSession: vi.fn(async (_db: unknown, row: { id: string; rememberMe: boolean }) => ({ id: row.id, generation: 1, rememberMe: row.rememberMe, exp: exp() })),
      readSessionForRefresh: vi.fn().mockResolvedValue(null),
      rotateSession: vi.fn(async (_db: unknown, a: { sid: string; toGeneration: number }) => ({ id: a.sid, generation: a.toGeneration, rememberMe: true, exp: exp() })),
      rekeySession: vi.fn(async (_db: unknown, a: { sid: string }) => ({ id: a.sid, generation: 2, rememberMe: true, exp: exp() })),
      deleteSession: vi.fn().mockResolvedValue(1),
      deleteStaleSession: vi.fn().mockResolvedValue(1),
      deleteExpiredSession: vi.fn().mockResolvedValue(1),
      evictSessionsBeyond: vi.fn().mockResolvedValue([]),
      readLegacyRedemption: vi.fn().mockResolvedValue(null),
      claimLegacyRedemption: vi.fn().mockResolvedValue(true),
      linkLegacyRedemption: vi.fn().mockResolvedValue(1),
      spendLegacyRedemption: vi.fn().mockResolvedValue([]),
      listLiveSessions: vi.fn().mockResolvedValue([]),
      deleteOtherSessions: vi.fn().mockResolvedValue([]),
    },
  };
});
vi.mock('../../utils/sessionStore', () => sessionStore);

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
vi.mock('../../utils/email', async (importOriginal) => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  describeEmailError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  failedBeforeAnyRecipient: (await importOriginal<typeof import('../../utils/email')>()).failedBeforeAnyRecipient,
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
const revokeSessionSocketsMock = vi.hoisted(() => vi.fn());
const revokeOtherSessionSocketsMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sessionRevocation', () => ({
  revokeUserSessions: (...a: unknown[]) => revokeUserSessionsMock(...a),
  revokeSessionSockets: (...a: unknown[]) => revokeSessionSocketsMock(...a),
  revokeOtherSessionSockets: (...a: unknown[]) => revokeOtherSessionSocketsMock(...a),
}));
vi.mock('../../routes/admin', () => ({ adminRouter: Router() }));
vi.mock('../../routes/support', () => ({ supportRouter: Router() }));
vi.mock('../../routes/roles', () => ({ roleRouter: Router() }));

// Mock rate limiters — pass through all requests for most tests
// The registration limiters are spies, so each route's chain can be observed.
const {
  rateLimitRegisterMock, rateLimitRegisterAttemptMock, rateLimitRegisterAttemptSubnetMock,
  rateLimitRegisterCompleteMock, rateLimitRegisterResendMock, chargeRegistrationBudgetsMock, rateLimitLogoutMock,
  rateLimitSessionsReadMock, rateLimitPasswordStepUpMock, rateLimitChangePasswordMock,
} = vi.hoisted(() => {
  const spy = () => vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
  return {
    rateLimitLogoutMock: spy(),
    rateLimitSessionsReadMock: spy(),
    rateLimitPasswordStepUpMock: spy(),
    rateLimitChangePasswordMock: spy(),
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
  rateLimitLogout: rateLimitLogoutMock,
  rateLimitSessionsRead: rateLimitSessionsReadMock,
  rateLimitPasswordStepUp: rateLimitPasswordStepUpMock,
  STEP_UP_REFUSED_LOCAL: 'stepUpRefused',
  rateLimitChangePassword: rateLimitChangePasswordMock,
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
  rateLimitE2EShareAck: passthroughMiddleware,
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
    // #148: the display name has no other check, and one after the PoW would burn the challenge
    ['a display name over the length limit', { displayName: 'x'.repeat(65) }, 'Display name must be at most 64 characters'],
  ])('refuses %s with a 400 before the PoW is verified', async (_label, patch, message) => {
    const res = await request(app).post('/api/v1/auth/register').send({ ...START_BODY, ...patch });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: message });
    expect(mockVerifyPow).not.toHaveBeenCalled();
    expect(startRegistrationMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/register — the display name is judged after its unsupported characters are stripped (#148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a name at the limit plus zero-width characters passes the check (the service stores it stripped)', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ ...START_BODY, displayName: `${'x'.repeat(64)}${String.fromCharCode(0x200b, 0x202e)}` });

    expect(res.status).toBe(202);
    expect(mockVerifyPow).toHaveBeenCalled();
    expect(startRegistrationMock).toHaveBeenCalled();
  });

  it('a name made only of them is not refused: an empty display name falls back to the username', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ ...START_BODY, displayName: String.fromCharCode(0x200b, 0x202e) });

    expect(res.status).toBe(202);
    expect(startRegistrationMock).toHaveBeenCalled();
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
    // The session it opens is labelled from the request (no Origin, no user agent here)
    expect(completeRegistrationMock).toHaveBeenCalledWith('p'.repeat(22), '123456', undefined, expect.any(String), { kind: 'unknown', os: 'other' });
  });

  it('forwards a new username with the same code, and the raw values for the service to check', async () => {
    await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 'p'.repeat(22), code: '123456', username: 'other_name' });
    expect(completeRegistrationMock).toHaveBeenLastCalledWith('p'.repeat(22), '123456', 'other_name', expect.any(String), expect.objectContaining({ kind: expect.any(String) }));

    await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ pendingId: 7, code: 123456 });
    expect(completeRegistrationMock).toHaveBeenLastCalledWith(7, 123456, undefined, expect.any(String), expect.objectContaining({ kind: expect.any(String) }));
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
    // A token of the shape issued before sessions (generateRefreshToken
    // above): upgraded into a new session at its first presentation
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
    const renewed = jwt.verify(res.body.data.refreshToken, JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(renewed).toMatchObject({ userId: MOCK_USER.id, tokenVersion: 0, rememberMe: true, gen: 1 });
    expect(sessionStore.claimLegacyRedemption).toHaveBeenCalledTimes(1);
    expect(sessionStore.insertSession).toHaveBeenCalledTimes(1);
    expect(sessionStore.linkLegacyRedemption).toHaveBeenCalledWith(expect.anything(), expect.any(String), renewed.sid);
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

    // A banned account renews nothing, answered like every refusal of the
    // refresh: 401 (never 403)
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid refresh token');
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
  /** What the route left on the response when it finished (the bucket keeps the charge only when it is true). */
  let stepUpRefused: unknown;
  let chain: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stepUpRefused = undefined;
    chain = [];
    rateLimitChangePasswordMock.mockImplementation((_req: unknown, _res: unknown, next: () => void) => { chain.push('address'); next(); });
    rateLimitPasswordStepUpMock.mockImplementation((_req: unknown, res: { on: (e: string, f: () => void) => void; locals: Record<string, unknown> }, next: () => void) => {
      chain.push('session');
      res.on('finish', () => { stepUpRefused = res.locals.stepUpRefused; });
      next();
    });
  });

  const changeBody = { currentPassword: 'currentpassword', newPassword: 'newpassword123' };
  const authedAs = () => generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
  const authRow = { bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false };

  it('the address limiter runs first, then the session\'s wrong-password bucket, both after authenticate; an unauthenticated call reaches neither', async () => {
    const anon = await request(app).post('/api/v1/auth/change-password').send(changeBody);
    expect(anon.status).toBe(401);
    expect(chain).toEqual([]);

    mockPrismaUser.findUnique.mockResolvedValueOnce(authRow);
    await request(app).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${authedAs()}`).send({ newPassword: 'newpassword123' });
    expect(chain).toEqual(['address', 'session']);
    expect(rateLimitChangePasswordMock).toHaveBeenCalledTimes(1);
    expect(rateLimitPasswordStepUpMock).toHaveBeenCalledTimes(1);
  });

  it('a wrong current password: 400 with the sentence clients map, and the session\'s charge is kept', async () => {
    mockPrismaUser.findUnique
      .mockResolvedValueOnce(authRow)
      .mockResolvedValueOnce({ ...MOCK_USER, password: await bcrypt.hash('correctpassword', 4) });

    const res = await request(app).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${authedAs()}`).send({ currentPassword: 'wrongpassword', newPassword: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Current password is incorrect' });
    expect(stepUpRefused).toBe(true);
  });

  it('every other outcome gives the charge back: success, a refused new password, a missing field, a 401 from the service, a 500', async () => {
    const hashedCurrent = await bcrypt.hash('currentpassword', 4);
    const send = (body: Record<string, unknown> = changeBody) =>
      request(app).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${authedAs()}`).send(body);

    // Success
    mockPrismaUser.findUnique
      .mockResolvedValueOnce(authRow)
      .mockResolvedValueOnce({ ...MOCK_USER, password: hashedCurrent })
      .mockResolvedValueOnce({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 0 });
    mockPrismaUser.update.mockResolvedValue({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 1 });
    expect((await send()).status).toBe(200);
    expect(stepUpRefused).toBeUndefined();

    // A new password the validator refuses (400 before the current one is compared)
    mockPrismaUser.findUnique.mockResolvedValueOnce(authRow);
    const weak = await send({ currentPassword: 'currentpassword', newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error).not.toBe('Current password is incorrect');
    expect(stepUpRefused).toBeUndefined();

    // A missing field
    mockPrismaUser.findUnique.mockResolvedValueOnce(authRow);
    expect((await send({ newPassword: 'newpassword123' })).status).toBe(400);
    expect(stepUpRefused).toBeUndefined();

    // 401 from the service: a reset or a ban committed meanwhile
    mockPrismaUser.findUnique
      .mockResolvedValueOnce(authRow)
      .mockResolvedValueOnce({ ...MOCK_USER, password: hashedCurrent })
      .mockResolvedValueOnce({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 1 });
    const stale = await send();
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe('Session invalidated');
    expect(stepUpRefused).toBeUndefined();

    // 401 from the service: the account row is gone
    mockPrismaUser.findUnique.mockResolvedValueOnce(authRow).mockResolvedValueOnce(null);
    expect((await send()).status).toBe(401);
    expect(stepUpRefused).toBeUndefined();

    // 500
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrismaUser.findUnique.mockResolvedValueOnce(authRow).mockRejectedValueOnce(new Error('connection lost'));
    expect((await send()).status).toBe(500);
    expect(stepUpRefused).toBeUndefined();
    err.mockRestore();
  });

  it('the two sign-outs and the change mount the one limiter (one shared budget)', async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ ...authRow, sessions: [{ tokenVersion: 0, expiresAt: new Date(Date.now() + 3_600_000) }] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bearer = `Bearer ${authedAs()}`;
    await request(app).post('/api/v1/auth/change-password').set('Authorization', bearer).send(changeBody);
    await request(app).post('/api/v1/auth/sessions/revoke-others').set('Authorization', bearer).send({});
    await request(app).delete('/api/v1/auth/sessions/Other00000000000000000').set('Authorization', bearer).send({});
    err.mockRestore();
    expect(rateLimitPasswordStepUpMock).toHaveBeenCalledTimes(3);
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
      })
      // changePassword — the account under the transaction's lock, at the admitted version
      .mockResolvedValueOnce({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 0 });

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
      .mockResolvedValueOnce({ ...MOCK_USER, password: hashedCurrent })
      .mockResolvedValueOnce({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 0 });
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

  it('a reset or a ban that committed while the password was hashed: 401 Session invalidated, nothing written, no socket touched', async () => {
    const hashedCurrent = await bcrypt.hash('currentpassword', 4);
    const token = generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
    mockPrismaUser.update.mockClear();
    mockPrismaUser.findUnique
      .mockResolvedValueOnce({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: false })
      .mockResolvedValueOnce({ ...MOCK_USER, password: hashedCurrent })
      // Under the lock the account is at version 1: the caller was admitted at 0
      .mockResolvedValueOnce({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 1 });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'currentpassword', newPassword: 'newpassword123' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Session invalidated' });
    expect(mockPrismaUser.update).not.toHaveBeenCalled();
    expect(sessionStore.rekeySession).not.toHaveBeenCalled();
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
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
    expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({ where: { resetToken: HASHED }, select: { id: true, resetTokenExpiresAt: true } });
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
    expect(mockPrismaUser.update).toHaveBeenCalledWith({ where: { id: MOCK_USER.id }, data: { resetToken: null, resetTokenExpiresAt: null }, select: { id: true } });
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

  it('answers byte for byte the same whether the address is unknown, the mail went out, provably reached nobody, or was refused', async () => {
    const { sendPasswordResetEmail } = await import('../../utils/email');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answers: { status: number; body: string; type: string | undefined }[] = [];
    const ask = async () => {
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'test@example.com' });
      answers.push({ status: res.status, body: res.text, type: res.headers['content-type'] });
    };
    try {
      mockPrismaUser.update.mockResolvedValue({});

      mockPrismaUser.findUnique.mockResolvedValueOnce(null);
      await ask();
      mockPrismaUser.findUnique.mockResolvedValueOnce({ id: MOCK_USER.id, email: 'test@example.com' });
      await ask();
      mockPrismaUser.findUnique.mockResolvedValueOnce({ id: MOCK_USER.id, email: 'test@example.com' });
      vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' }));
      await ask();
      mockPrismaUser.findUnique.mockResolvedValueOnce({ id: MOCK_USER.id, email: 'test@example.com' });
      vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(Object.assign(new Error('550 <test@example.com> rejected'), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }));
      await ask();
      await new Promise((r) => setImmediate(r));

      expect(answers).toHaveLength(4);
      for (const answer of answers) expect(answer).toEqual(answers[0]);
      expect(answers[0].status).toBe(200);
      // Only the provably unsent one gave the mailbox its point back, after its answer
      const { refundRateLimit } = await import('../../middleware/rateLimiter');
      expect(refundRateLimit).toHaveBeenCalledTimes(1);
      expect(refundRateLimit).toHaveBeenCalledWith('resetMail', 'test@example.com');
    } finally {
      errorLog.mockRestore();
    }
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

  it('a deletion that finds the account owning a space after the check (a transfer to it) answers the owned-spaces 409 with its list', async () => {
    const token = mockAccount({});
    const { OwnedServersError } = await import('../../utils/errors');
    deleteUserAccountMock.mockRejectedValueOnce(new OwnedServersError([{ id: 's-9', name: 'Handed over' }]));

    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.data).toEqual({ ownedServers: [{ id: 's-9', name: 'Handed over' }] });
    expect(logAuditEventMock).not.toHaveBeenCalled();
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

// ─── Sign-in sessions: the renewal of a session, and the sign-out ───────────

describe('POST /api/v1/auth/refresh — a token that names its session', () => {
  const SID = 'Qm9vdHN0cmFwU2Vzc2lvbg';
  const sessionToken = (gen: number) => jwt.sign(
    { userId: MOCK_USER.id, tokenVersion: 0, rememberMe: true, sid: SID, gen, exp: Math.floor(Date.now() / 1000) + 30 * 86400 },
    JWT_REFRESH_SECRET,
    { algorithm: 'HS256' },
  );
  const sessionRow = (over: Record<string, unknown> = {}) => ({
    generation: 3, rowVersion: 0, rememberMe: true, clientKind: 'desktop', expired: false, withinGrace: false,
    secondsSinceRotation: 600, exp: Math.floor(Date.now() / 1000) + 29 * 86400, username: MOCK_USER.username, role: 'user',
    accountVersion: 0, banned: false, ...over,
  });
  /** The reuse flag, set explicitly by every test that reaches it (this file's flag mock answers true for any name). */
  const reuseMode = (enforce: boolean) =>
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) => (name === 'refresh_reuse_revocation' ? enforce : true));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFeatureEnabled).mockImplementation(() => true);
  });

  it('rotates the current generation and answers the next one', async () => {
    sessionStore.readSessionForRefresh.mockResolvedValueOnce(sessionRow());

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessionToken(3), client: 'desktop' });

    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.data.refreshToken, JWT_REFRESH_SECRET, { algorithms: ['HS256'] })).toMatchObject({ sid: SID, gen: 4 });
    expect(jwt.verify(res.body.data.accessToken, JWT_SECRET, { algorithms: ['HS256'] })).toMatchObject({ userId: MOCK_USER.id, sid: SID });
    expect(sessionStore.rotateSession).toHaveBeenCalledTimes(1);
  });

  it('the body\'s `client` field is only written into the reuse line (present / absent); a bad one is ignored', async () => {
    reuseMode(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sessionStore.readSessionForRefresh.mockResolvedValueOnce(sessionRow({ generation: 5 })).mockResolvedValueOnce(sessionRow({ generation: 5 }));

    const hinted = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessionToken(2), client: 'web' });
    const bad = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessionToken(2), client: 'toaster' });

    expect(hinted.status).toBe(200);
    expect(bad.status).toBe(200);
    expect(warn.mock.calls[0][0]).toContain('client field present');
    expect(warn.mock.calls[1][0]).toContain('client field absent');
    // The label of the session is never changed by a renewal
    expect(sessionStore.insertSession).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reuse in enforce mode: the session ended, its sockets with it, then 401 Invalid refresh token', async () => {
    reuseMode(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sessionStore.readSessionForRefresh.mockResolvedValueOnce(sessionRow({ generation: 5 }));

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessionToken(2) });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Invalid refresh token' });
    expect(sessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), SID, MOCK_USER.id);
    expect(revokeSessionSocketsMock).toHaveBeenCalledWith(MOCK_USER.id, SID, 'Your session has ended');
    warn.mockRestore();
  });

  it('a failure of the server answers 500, never 401: the client keeps its tokens', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStore.readSessionForRefresh.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessionToken(3) });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    error.mockRestore();
  });

  describe('a client that has gone before the rotation (a real HTTP connection)', () => {
    /** Posts a refresh on a real socket; the read waits until it is released. */
    async function refreshOverTheWire(destroyBeforeRelease: boolean) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let readDone!: () => void;
      const readFinished = new Promise<void>((resolve) => { readDone = resolve; });
      sessionStore.readSessionForRefresh.mockImplementationOnce(async () => {
        await gate;
        readDone();
        return sessionRow();
      });
      const server = http.createServer(app).listen(0, '127.0.0.1');
      // The server's side of the connection: its close is what the route reads
      let serverSide: import('net').Socket | undefined;
      server.on('connection', (socket) => { serverSide = socket; });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ refreshToken: sessionToken(3) });
      let status: number | undefined;
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/v1/auth/refresh', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        status = res.statusCode;
        res.resume();
      });
      req.on('error', () => { /* the destroyed request reports its own reset */ });
      req.end(body);
      // The route is inside the read: the body has been parsed
      await vi.waitFor(() => expect(sessionStore.readSessionForRefresh).toHaveBeenCalled());
      if (destroyBeforeRelease) {
        const closed = new Promise<void>((resolve) => {
          if (serverSide!.destroyed) resolve();
          else serverSide!.once('close', () => resolve());
        });
        req.destroy();
        // Until the server has seen the connection close
        await closed;
        expect(serverSide!.destroyed).toBe(true);
      }
      release();
      await readFinished;
      // Until the route has done what it does after the read: the answer
      // arrived, or (the client gone) the route returned without one
      if (destroyBeforeRelease) {
        // Everything after the read is promise continuations: two turns of
        // the event loop run them all (no timer, nothing to race)
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      } else {
        await vi.waitFor(() => expect(status).toBeDefined(), { timeout: 5000 });
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return status;
    }

    it('the body read by the parser does not count as gone: the rotation happens and the answer arrives', async () => {
      const status = await refreshOverTheWire(false);
      expect(status).toBe(200);
      expect(sessionStore.rotateSession).toHaveBeenCalledTimes(1);
    });

    it('a connection closed by the client: nothing rotated behind it, so its next attempt with the same token works', async () => {
      await refreshOverTheWire(true);
      expect(sessionStore.rotateSession).not.toHaveBeenCalled();
      expect(sessionStore.deleteSession).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/v1/auth/logout', () => {
  const SID = 'Qm9vdHN0cmFwU2Vzc2lvbg';
  const sessionToken = (over: Record<string, unknown> = {}, secret = JWT_REFRESH_SECRET) => jwt.sign(
    { userId: MOCK_USER.id, tokenVersion: 0, rememberMe: true, sid: SID, gen: 7, exp: Math.floor(Date.now() / 1000) + 30 * 86400, ...over },
    secret,
    { algorithm: 'HS256' },
  );
  /** What a caller can observe of an answer: everything but the headers that differ per request. */
  const observable = (res: request.Response) => {
    const { date: _d, 'x-request-id': _r, ...headers } = res.headers;
    return { status: res.status, text: res.text, headers };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.deleteSession.mockResolvedValue(1);
    sessionStore.spendLegacyRedemption.mockResolvedValue([]);
  });

  it('ends the session the token names (any generation), its sockets told and closed: 204, nothing in the body', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: sessionToken({ gen: 2 }) });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(sessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), SID, MOCK_USER.id);
    expect(revokeSessionSocketsMock).toHaveBeenCalledWith(MOCK_USER.id, SID, 'Your session has ended');
    expect(rateLimitLogoutMock).toHaveBeenCalledTimes(1);
  });

  it('needs no access token: it is authenticated by the refresh token alone (the access token may have expired)', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: sessionToken() });
    expect(res.status).toBe(204);
    expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
  });

  it('answers the SAME 204 for a valid, forged, expired, garbage, unknown or already-ended token, and one issued before sessions', async () => {
    const valid = await request(app).post('/api/v1/auth/logout').send({ refreshToken: sessionToken() });
    sessionStore.deleteSession.mockResolvedValueOnce(0);
    const gone = await request(app).post('/api/v1/auth/logout').send({ refreshToken: sessionToken({ sid: 'unknownSessionId000000' }) });
    const forged = await request(app).post('/api/v1/auth/logout').send({ refreshToken: sessionToken({}, 'not-the-secret') });
    const expired = await request(app).post('/api/v1/auth/logout').send({ refreshToken: sessionToken({ exp: Math.floor(Date.now() / 1000) - 60 }) });
    const garbage = await request(app).post('/api/v1/auth/logout').send({ refreshToken: 'garbage' });
    const access = await request(app).post('/api/v1/auth/logout').send({ refreshToken: generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username }) });
    const legacy = await request(app).post('/api/v1/auth/logout').send({ refreshToken: generateRefreshToken({ userId: MOCK_USER.id, username: MOCK_USER.username }) });

    const answers = [valid, gone, forged, expired, garbage, access, legacy].map(observable);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0].status).toBe(204);
    // Only the parseable ones reached a statement: one delete each, the legacy one spent
    expect(sessionStore.deleteSession).toHaveBeenCalledTimes(2);
    expect(sessionStore.spendLegacyRedemption).toHaveBeenCalledTimes(1);
    // A socket is ended only for a session that was there
    expect(revokeSessionSocketsMock).toHaveBeenCalledTimes(1);
  });

  it('a token issued before sessions is spent (its digest recorded), and the session it became, if any, ended', async () => {
    const legacy = generateRefreshToken({ userId: MOCK_USER.id, username: MOCK_USER.username });
    sessionStore.spendLegacyRedemption.mockResolvedValueOnce([SID]);

    const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: legacy });

    expect(res.status).toBe(204);
    expect(sessionStore.spendLegacyRedemption).toHaveBeenCalledWith(
      expect.anything(), crypto.createHash('sha256').update(legacy).digest('hex'), (jwt.decode(legacy) as { exp: number }).exp, MOCK_USER.id,
    );
    expect(revokeSessionSocketsMock).toHaveBeenCalledWith(MOCK_USER.id, [SID], 'Your session has ended');
  });

  it.each([
    ['missing', {}],
    ['not a string', { refreshToken: 42 }],
    ['empty', { refreshToken: '' }],
    ['longer than any refresh token', { refreshToken: 'x'.repeat(4097) }],
  ])('a body whose token is %s: 400 Refresh token is required, nothing read', async (_what, body) => {
    const res = await request(app).post('/api/v1/auth/logout').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Refresh token is required' });
    expect(sessionStore.deleteSession).not.toHaveBeenCalled();
  });

  it('a database failure answers 500: the client knows the session was not ended, and the token is never logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = sessionToken();
    sessionStore.deleteSession.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: token });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(revokeSessionSocketsMock).not.toHaveBeenCalled();
    for (const call of error.mock.calls) expect(JSON.stringify(call)).not.toContain(token.split('.')[2]);
    error.mockRestore();
  });
});

// ─── The account's own sign-in sessions ─────────────────────────────────────

describe('the account\'s own sign-in sessions: GET /auth/sessions, DELETE /auth/sessions/:sessionId, POST /auth/sessions/revoke-others', () => {
  const SID = 'Qm9vdHN0cmFwU2Vzc2lvbg';
  const OTHER = 'T3RoZXJTZXNzaW9uMDAwMA';
  const FUTURE = () => new Date(Date.now() + 3_600_000);
  let hash: string;
  let lockedVersion: number;
  /** What the route's step-up left on the response (the bucket keeps the charge only when it is true). */
  let stepUpRefused: unknown;

  beforeEach(async () => {
    vi.clearAllMocks();
    hash = hash || await bcrypt.hash('RightPassword1', 4);
    lockedVersion = 0;
    stepUpRefused = undefined;
    rateLimitPasswordStepUpMock.mockImplementation((_req: unknown, res: { on: (e: string, f: () => void) => void; locals: Record<string, unknown> }, next: () => void) => {
      res.on('finish', () => { stepUpRefused = res.locals.stepUpRefused; });
      next();
    });
    // authenticate's read of the account (and of the session, for a token naming one); the
    // step-up's read of the hash; the transaction's read of the account under its lock
    mockPrismaUser.findUnique.mockImplementation(async (args: { select: Record<string, unknown> }) => {
      if (args.select.password) return { password: hash };
      if (args.select.username) return { id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: lockedVersion };
      return {
        bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
        ...(args.select.sessions ? { sessions: [{ tokenVersion: 0, expiresAt: FUTURE() }] } : {}),
      };
    });
    mockPrismaUser.update.mockResolvedValue({ id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 1 });
    sessionStore.deleteSession.mockResolvedValue(1);
    sessionStore.deleteOtherSessions.mockResolvedValue([{ id: OTHER, live: true }, { id: 'dead', live: false }]);
    sessionStore.listLiveSessions.mockResolvedValue([]);
  });

  const withSid = () => jwt.sign({ userId: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 0, sid: SID }, JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
  const legacy = () => generateAccessToken({ userId: MOCK_USER.id, username: MOCK_USER.username, tokenVersion: 0 });
  const observable = (res: request.Response) => ({ status: res.status, body: res.body });

  describe('GET /auth/sessions', () => {
    it('the caller\'s live sessions as the list shows them, the caller\'s marked; authenticate before the list\'s own bucket', async () => {
      const h = (n: number) => Date.UTC(2026, 10, 20, n) / 1000;
      sessionStore.listLiveSessions.mockResolvedValueOnce([
        { id: SID, clientKind: 'desktop', clientOs: 'windows', signedInAt: h(0), lastActiveAt: h(14) },
        { id: OTHER, clientKind: 'web', clientOs: 'macos', signedInAt: h(0), lastActiveAt: h(3) },
      ]);
      const res = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${withSid()}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          sessions: [
            { id: SID, clientKind: 'desktop', clientOs: 'windows', signedInAt: '2026-11-20T00:00:00.000Z', lastActiveAt: '2026-11-20T14:00:00.000Z', current: true },
            { id: OTHER, clientKind: 'web', clientOs: 'macos', signedInAt: '2026-11-20T00:00:00.000Z', lastActiveAt: '2026-11-20T03:00:00.000Z', current: false },
          ],
        },
      });
      expect(sessionStore.listLiveSessions).toHaveBeenCalledWith(expect.anything(), MOCK_USER.id, SID, 50);
      expect(rateLimitSessionsReadMock).toHaveBeenCalledTimes(1);
      expect(rateLimitPasswordStepUpMock).not.toHaveBeenCalled();
    });

    it('a token that names no session: the list with none marked', async () => {
      sessionStore.listLiveSessions.mockResolvedValueOnce([{ id: SID, clientKind: 'web', clientOs: 'linux', signedInAt: 0, lastActiveAt: 0 }]);
      const res = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${legacy()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.sessions[0].current).toBe(false);
      expect(sessionStore.listLiveSessions).toHaveBeenCalledWith(expect.anything(), MOCK_USER.id, null, 50);
    });

    it('unauthenticated: 401 before the bucket; a failing statement: 500, never 401', async () => {
      const anon = await request(app).get('/api/v1/auth/sessions');
      expect(anon.status).toBe(401);
      expect(rateLimitSessionsReadMock).not.toHaveBeenCalled();

      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      sessionStore.listLiveSessions.mockRejectedValueOnce(new Error('connection lost'));
      const failed = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${withSid()}`);
      expect(failed.status).toBe(500);
      err.mockRestore();
    });

    it('the session check of authenticate applies: a caller whose own session ended gets 401 Session invalidated', async () => {
      mockPrismaUser.findUnique.mockImplementationOnce(async () => ({
        bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0), sessions: [],
      }));
      const res = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${withSid()}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Session invalidated');
    });
  });

  describe('DELETE /auth/sessions/:sessionId', () => {
    const del = (id: string, body: Record<string, unknown> = { password: 'RightPassword1' }, token = withSid()) =>
      request(app).delete(`/api/v1/auth/sessions/${encodeURIComponent(id)}`).set('Authorization', `Bearer ${token}`).send(body);

    it('ends one other session of the account: 200 { revoked: 1 }, its sockets told and closed; the step-up bucket gives the point back', async () => {
      const res = await del(OTHER);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { revoked: 1 } });
      expect(sessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), OTHER, MOCK_USER.id);
      expect(revokeSessionSocketsMock).toHaveBeenCalledWith(MOCK_USER.id, OTHER, 'You were signed out from another device');
      expect(rateLimitPasswordStepUpMock).toHaveBeenCalledTimes(1);
      expect(stepUpRefused).toBeUndefined();
    });

    it('a wrong password: 400 Password is incorrect, nothing deleted, the charge kept; the same answer whatever the id', async () => {
      const answers = [];
      for (const id of [OTHER, 'unknownSession000000000', SID, 'has:colon']) {
        const res = await del(id, { password: 'WrongPassword1' });
        answers.push(observable(res));
        expect(stepUpRefused).toBe(true);
      }
      for (const a of answers) expect(a).toEqual({ status: 400, body: { success: false, error: 'Password is incorrect' } });
      expect(sessionStore.deleteSession).not.toHaveBeenCalled();
      expect(revokeSessionSocketsMock).not.toHaveBeenCalled();
    });

    it('a missing or non-string password: 400 Password is required, nothing checked, the charge given back', async () => {
      for (const body of [{}, { password: '' }, { password: 42 }, { password: ['x'] }]) {
        const res = await del(OTHER, body as Record<string, unknown>);
        expect(observable(res)).toEqual({ status: 400, body: { success: false, error: 'Password is required' } });
        expect(stepUpRefused).toBeUndefined();
      }
      expect(sessionStore.deleteSession).not.toHaveBeenCalled();
    });

    it('an unknown id, another account\'s id and an id no session can carry answer the same 404 Session not found, after the password', async () => {
      sessionStore.deleteSession.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      const unknown = await del('unknownSession000000000');
      // Another account's session: the delete is bound to the caller's account, so it finds nothing
      const foreign = await del('U29tZW9uZUVsc2VzU2Vzcw');
      const malformed = await del('has:colon');
      for (const res of [unknown, foreign, malformed]) {
        expect(observable(res)).toEqual({ status: 404, body: { success: false, error: 'Session not found' } });
      }
      expect(sessionStore.deleteSession).toHaveBeenCalledTimes(2);
      for (const call of sessionStore.deleteSession.mock.calls) expect(call[2]).toBe(MOCK_USER.id);
      expect(revokeSessionSocketsMock).not.toHaveBeenCalled();
      expect(stepUpRefused).toBeUndefined();
    });

    it('the caller\'s own session: 400 (signing out ends it), nothing deleted', async () => {
      const res = await del(SID);
      expect(observable(res)).toEqual({ status: 400, body: { success: false, error: 'This is the session you are using: sign out to end it' } });
      expect(sessionStore.deleteSession).not.toHaveBeenCalled();
    });

    it('unauthenticated: 401, the step-up bucket never reached', async () => {
      const res = await request(app).delete(`/api/v1/auth/sessions/${OTHER}`).send({ password: 'RightPassword1' });
      expect(res.status).toBe(401);
      expect(rateLimitPasswordStepUpMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/sessions/revoke-others', () => {
    const post = (body: Record<string, unknown> = { password: 'RightPassword1' }, token = withSid()) =>
      request(app).post('/api/v1/auth/sessions/revoke-others').set('Authorization', `Bearer ${token}`).send(body);

    it('bumps the version, re-keys the caller\'s session from its admitted version, deletes the others; answers the live count and the fresh pair; the other sockets ended after the commit', async () => {
      const order: string[] = [];
      mockPrismaUser.update.mockImplementationOnce(async () => { order.push('bump'); return { id: MOCK_USER.id, username: MOCK_USER.username, role: 'user', tokenVersion: 1 }; });
      revokeOtherSessionSocketsMock.mockImplementationOnce(() => { order.push('sockets'); });

      const res = await post();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.revoked).toBe(1);
      const access = jwt.verify(res.body.data.accessToken, JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
      const refresh = jwt.verify(res.body.data.refreshToken, JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
      expect(access).toMatchObject({ sid: SID, tokenVersion: 1 });
      expect(refresh).toMatchObject({ sid: SID, tokenVersion: 1 });
      expect(res.body.data).not.toHaveProperty('trustedDeviceToken');
      expect(sessionStore.rekeySession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sid: SID, userId: MOCK_USER.id, fromTokenVersion: 0, tokenVersion: 1 }));
      expect(sessionStore.deleteOtherSessions).toHaveBeenCalledWith(expect.anything(), MOCK_USER.id, SID, 0);
      expect(revokeOtherSessionSocketsMock).toHaveBeenCalledWith(MOCK_USER.id, SID, 'You were signed out from another device');
      expect(order).toEqual(['bump', 'sockets']);
      expect(stepUpRefused).toBeUndefined();
    });

    it('a wrong password: 400 Password is incorrect, the charge kept, nothing written, no socket touched', async () => {
      const res = await post({ password: 'WrongPassword1' });
      expect(observable(res)).toEqual({ status: 400, body: { success: false, error: 'Password is incorrect' } });
      expect(stepUpRefused).toBe(true);
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
      expect(revokeOtherSessionSocketsMock).not.toHaveBeenCalled();
    });

    it('the version moved since the caller was admitted: 401 Session invalidated, nothing written, the charge given back', async () => {
      lockedVersion = 1;
      const res = await post();
      expect(observable(res)).toEqual({ status: 401, body: { success: false, error: 'Session invalidated' } });
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
      expect(sessionStore.deleteOtherSessions).not.toHaveBeenCalled();
      expect(revokeOtherSessionSocketsMock).not.toHaveBeenCalled();
      expect(stepUpRefused).toBeUndefined();
    });

    it('a caller whose token names no session: a new session at the new version, kept while the others go', async () => {
      const res = await post({ password: 'RightPassword1', rememberMe: false, client: 'web' }, legacy());
      expect(res.status).toBe(200);
      const access = jwt.decode(res.body.data.accessToken) as { sid: string; tokenVersion: number };
      expect(access.tokenVersion).toBe(1);
      expect(sessionStore.insertSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: access.sid, tokenVersion: 1, rememberMe: false, clientKind: 'web' }));
      expect(sessionStore.deleteOtherSessions).toHaveBeenCalledWith(expect.anything(), MOCK_USER.id, access.sid, 0);
      expect(revokeOtherSessionSocketsMock).toHaveBeenCalledWith(MOCK_USER.id, undefined, 'You were signed out from another device');
    });

    it('a valid trusted-device token of the old version comes back re-issued under the new one; any other is ignored', async () => {
      const old = jwt.sign({ userId: MOCK_USER.id, purpose: 'trusted-device', tokenVersion: 0 }, JWT_SECRET, { expiresIn: '30d' });
      const res = await post({ password: 'RightPassword1', trustedDeviceToken: old });
      const fresh = jwt.verify(res.body.data.trustedDeviceToken, JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
      expect(fresh).toMatchObject({ userId: MOCK_USER.id, purpose: 'trusted-device', tokenVersion: 1, exp: (jwt.decode(old) as { exp: number }).exp });

      const stale = jwt.sign({ userId: MOCK_USER.id, purpose: 'trusted-device', tokenVersion: 5 }, JWT_SECRET, { expiresIn: '30d' });
      const ignored = await post({ password: 'RightPassword1', trustedDeviceToken: stale });
      expect(ignored.status).toBe(200);
      expect(ignored.body.data).not.toHaveProperty('trustedDeviceToken');
    });

    it.each([
      ['a trusted-device token that is not a string', { password: 'RightPassword1', trustedDeviceToken: 42 }, 'Invalid trusted device token'],
      ['a trusted-device token far longer than one', { password: 'RightPassword1', trustedDeviceToken: 'x'.repeat(4097) }, 'Invalid trusted device token'],
      ['a rememberMe that is not a boolean', { password: 'RightPassword1', rememberMe: 'yes' }, 'rememberMe must be true or false'],
      ['no password', { trustedDeviceToken: 'x' }, 'Password is required'],
    ])('%s: 400, nothing checked or written, the charge given back', async (_what, body, error) => {
      const res = await post(body as Record<string, unknown>);
      expect(observable(res)).toEqual({ status: 400, body: { success: false, error } });
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
      expect(stepUpRefused).toBeUndefined();
    });

    it('a failing statement: 500 (never 401), no socket touched', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      sessionStore.deleteOtherSessions.mockRejectedValueOnce(new Error('connection lost'));
      const res = await post();
      expect(res.status).toBe(500);
      expect(revokeOtherSessionSocketsMock).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('unauthenticated: 401, the bucket never reached', async () => {
      const res = await request(app).post('/api/v1/auth/sessions/revoke-others').send({ password: 'RightPassword1' });
      expect(res.status).toBe(401);
      expect(rateLimitPasswordStepUpMock).not.toHaveBeenCalled();
    });
  });

  it('the sentences clients map by their exact text come from the shared constants, written once: the route and the service build none of their own', async () => {
    const shared = await import('@voxium/shared');
    const { SessionNotFoundError } = await import('../../utils/errors');
    expect(shared.SESSION_NOT_FOUND_MESSAGE).toBe('Session not found');
    expect(shared.TRUSTED_DEVICE_TOKEN_INVALID_MESSAGE).toBe('Invalid trusted device token');
    expect(shared.REMEMBER_ME_INVALID_MESSAGE).toBe('rememberMe must be true or false');
    expect(new SessionNotFoundError()).toMatchObject({ statusCode: 404, message: shared.SESSION_NOT_FOUND_MESSAGE });
    const route = readFileSync(resolve(__dirname, '../../routes/auth.ts'), 'utf8');
    const service = readFileSync(resolve(__dirname, '../../services/authService.ts'), 'utf8');
    for (const text of [shared.TRUSTED_DEVICE_TOKEN_INVALID_MESSAGE, shared.REMEMBER_ME_INVALID_MESSAGE]) expect(route).not.toContain(`'${text}'`);
    expect(route).toContain('error: TRUSTED_DEVICE_TOKEN_INVALID_MESSAGE');
    expect(route).toContain('error: REMEMBER_ME_INVALID_MESSAGE');
    expect(service).not.toMatch(/NotFoundError\('Session'\)/);
    expect(service.match(/new SessionNotFoundError\(\)/g)).toHaveLength(2);
  });
});
