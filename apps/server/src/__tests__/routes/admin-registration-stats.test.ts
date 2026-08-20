import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'admin-1', username: 'admin', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn(), count: vi.fn() },
  ipRecord: { groupBy: vi.fn() },
  $queryRaw: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      if (prop === '$queryRaw') return prismaMock.$queryRaw;
      return prismaMock[prop as string];
    },
  }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn() })),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough };
});

vi.mock('../../utils/redis', () => ({
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../websocket/dmVoiceHandler', () => ({
  getActiveDMCallCount: vi.fn().mockResolvedValue(0),
  getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../mediasoup/mediasoupManager', () => ({
  getSfuStats: vi.fn().mockReturnValue({ workers: [], totalTransports: 0 }),
}));

vi.mock('../../utils/serverLimits', () => ({
  getGlobalLimits: vi.fn().mockResolvedValue({}),
  getEffectiveLimits: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../utils/sanitize', () => ({ sanitizeText: vi.fn((s: string) => s) }));
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn(),
  broadcastMemberLeft: vi.fn(),
}));
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));

// ─── App ────────────────────────────────────────────────────────────────────

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

function mockAdminAuth(role = 'admin') {
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'admin-1', bannedAt: null, tokenVersion: 0, role, emailVerified: true,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/registration-stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns windows, backlog, top IPs and top domains (bigint made JSON-safe)', async () => {
    mockAdminAuth();
    prismaMock.user.count
      .mockResolvedValueOnce(3)    // last hour
      .mockResolvedValueOnce(41)   // last 24h
      .mockResolvedValueOnce(12);  // unverified backlog
    prismaMock.ipRecord.groupBy.mockResolvedValueOnce([
      { ip: '203.0.113.9', _count: { ip: 7 } },
    ]);
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { domain: 'catchall.example', registrations: 9n }, // raw SQL COUNT is a bigint
      { domain: 'gmail.com', registrations: 4n },
    ]);

    const res = await request(createApp())
      .get('/api/v1/admin/registration-stats')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      lastHour: 3,
      last24h: 41,
      unverifiedTotal: 12,
      topRegisterIps: [{ ip: '203.0.113.9', registrations: 7 }],
      topDomains: [
        { domain: 'catchall.example', registrations: 9 },
        { domain: 'gmail.com', registrations: 4 },
      ],
    });

    // Only register-kind sightings feed the IP list, bounded at 10
    const groupByArgs = prismaMock.ipRecord.groupBy.mock.calls[0][0];
    expect(groupByArgs.where.kind).toBe('register');
    expect(groupByArgs.take).toBe(10);
  });

  it('requires admin — a plain user is refused', async () => {
    mockAdminAuth('user');

    const res = await request(createApp())
      .get('/api/v1/admin/registration-stats')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
    expect(prismaMock.user.count).not.toHaveBeenCalled();
  });
});
