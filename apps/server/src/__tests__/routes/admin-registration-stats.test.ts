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

const { hygieneRun, hygieneHistory } = vi.hoisted(() => ({
  hygieneRun: vi.fn(),
  hygieneHistory: vi.fn(),
}));
vi.mock('../../utils/registrationHygiene', () => ({
  runRegistrationHygieneLocked: hygieneRun,
  getHygieneHistory: hygieneHistory,
  UNVERIFIED_ACCOUNT_TTL_DAYS: 7,
}));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));

const { orphanRun, orphanScheduled } = vi.hoisted(() => ({
  orphanRun: vi.fn(),
  orphanScheduled: vi.fn(),
}));
vi.mock('../../utils/orphanCleanup', () => ({
  runOrphanCleanup: orphanRun,
  runScheduledOrphanCleanup: orphanScheduled,
}));

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

// ─── Registration hygiene sweep ─────────────────────────────────────────────

describe('admin registration hygiene sweep', () => {
  const RUN = {
    at: '2026-08-21T04:30:00.000Z',
    durationMs: 412,
    trigger: 'manual' as const,
    actorId: 'admin-1',
    nodeId: 'node-1',
    deletedUsers: 112,
    deletedAvatars: 0,
    deletedIpRecords: 0,
    dryRun: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminAuth();
    hygieneHistory.mockResolvedValue({ lastRun: RUN, history: [RUN] });
    prismaMock.user.count.mockResolvedValue(112);
    hygieneRun.mockResolvedValue(RUN);
  });

  it('GET reports when it last ran and what is queued for the next sweep', async () => {
    // Before this endpoint the ONLY evidence the job had ever run was a log
    // line that appeared solely when it deleted something.
    const res = await request(createApp())
      .get('/api/v1/admin/registration/hygiene')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      lastRun: { deletedUsers: 112, trigger: 'manual' },
      pendingDeletions: 112,
      ttlDays: 7,
    });
    expect(res.body.data.history).toHaveLength(1);
  });

  it('GET says so plainly when the sweep has never run', async () => {
    hygieneHistory.mockResolvedValue({ lastRun: null, history: [] });

    const res = await request(createApp())
      .get('/api/v1/admin/registration/hygiene')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.lastRun).toBeNull();
  });

  it('POST runs the sweep as a MANUAL trigger attributed to the caller', async () => {
    const res = await request(createApp())
      .post('/api/v1/admin/registration/hygiene')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(hygieneRun).toHaveBeenCalledWith({ trigger: 'manual', actorId: 'admin-1', dryRun: false });
    expect(res.body.data.deletedUsers).toBe(112);
  });

  it('POST ?dryRun=1 asks for a dry run', async () => {
    hygieneRun.mockResolvedValue({ ...RUN, dryRun: true });

    const res = await request(createApp())
      .post('/api/v1/admin/registration/hygiene?dryRun=1')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(hygieneRun).toHaveBeenCalledWith({ trigger: 'manual', actorId: 'admin-1', dryRun: true });
    expect(res.body.data.dryRun).toBe(true);
  });

  it('POST answers 409 when a sweep already holds the cluster lock', async () => {
    // Saying "already running" is more use to an operator than a success
    // response reporting zero deletions.
    hygieneRun.mockResolvedValue({ skipped: 'locked' });

    const res = await request(createApp())
      .post('/api/v1/admin/registration/hygiene')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('rejects a non-admin', async () => {
    mockAdminAuth('user');

    const res = await request(createApp())
      .post('/api/v1/admin/registration/hygiene')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
    expect(hygieneRun).not.toHaveBeenCalled();
  });
});

// ─── Orphan sweep trigger ───────────────────────────────────────────────────

describe('POST /api/v1/admin/storage/cleanup-orphans', () => {
  const EMPTY = { scanned: 0, orphaned: 0, deleted: 0, tooYoung: 0, foreign: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    orphanRun.mockResolvedValue(EMPTY);
    orphanScheduled.mockResolvedValue(EMPTY);
  });

  it('takes the cluster lock for a destructive run, like the nightly one does', async () => {
    // Two concurrent full-bucket destructive scans, from two different
    // snapshots, is exactly what the lock exists to prevent — an operator
    // clicking Run must not be the way around it.
    mockAdminAuth();

    const res = await request(createApp())
      .post('/api/v1/admin/storage/cleanup-orphans')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(orphanScheduled).toHaveBeenCalledTimes(1);
    expect(orphanRun).not.toHaveBeenCalled();
  });

  it('answers 409 while a sweep is already running', async () => {
    // More use to an operator than a success response reporting zero deletions
    // — and a 504 from nginx on a large bucket makes retrying the obvious move.
    mockAdminAuth();
    orphanScheduled.mockResolvedValue({ ...EMPTY, skipped: 'not-leader' });

    const res = await request(createApp())
      .post('/api/v1/admin/storage/cleanup-orphans')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('runs a dry run WITHOUT the lock, since it deletes nothing', async () => {
    // Looking must never be blocked by a sweep in progress.
    mockAdminAuth();

    const res = await request(createApp())
      .post('/api/v1/admin/storage/cleanup-orphans?dryRun=1')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(orphanRun).toHaveBeenCalledWith({ dryRun: true });
    expect(orphanScheduled).not.toHaveBeenCalled();
  });

  it('rejects a non-admin', async () => {
    mockAdminAuth('user');

    const res = await request(createApp())
      .post('/api/v1/admin/storage/cleanup-orphans')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
    expect(orphanScheduled).not.toHaveBeenCalled();
  });
});
