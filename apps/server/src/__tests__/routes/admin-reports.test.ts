import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'admin-1', username: 'admin', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  report: {
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    count: vi.fn().mockResolvedValue(0),
  },
  message: {
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  serverMember: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

// Socket.IO
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockIn = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough, normalizeIp: (ip: string) => ip };
});

// Redis
vi.mock('../../utils/redis', () => ({
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

// Voice handler
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));

// DM voice handler
vi.mock('../../websocket/dmVoiceHandler', () => ({
  getActiveDMCallCount: vi.fn().mockResolvedValue(0),
  getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0),
}));

// mediasoup manager
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getSfuStats: vi.fn().mockReturnValue({ workers: [], totalTransports: 0 }),
}));

// Server limits
vi.mock('../../utils/serverLimits', () => ({
  getGlobalLimits: vi.fn().mockResolvedValue({}),
}));

// Sanitize
vi.mock('../../utils/sanitize', () => ({
  sanitizeText: vi.fn((s: string) => s),
}));

// Member broadcast
const mockBroadcastMemberLeft = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: (...args: any[]) => mockBroadcastMemberLeft(...args),
}));

// S3
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Audit log
vi.mock('../../utils/auditLog', () => ({
  logAuditEvent: vi.fn(),
}));

// Feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * users[id] → row for prisma.user.findUnique — covers both the auth
 * middleware lookup (actor) and the resolve route's ban-target lookup.
 */
function mockUsers(users: Record<string, { role: string }>) {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    const row = users[where.id];
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id,
      bannedAt: null,
      tokenVersion: 0,
      emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      ...row,
    });
  });
}

function mockPendingReport(reportedUserId: string) {
  prismaMock.report.findUnique.mockResolvedValue({
    id: 'rep-1',
    status: 'pending',
    reportedUserId,
    messageId: null,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /admin/reports/:id/resolve — ban action hierarchy (HIGH-7)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.report.update.mockResolvedValue({});
    prismaMock.report.count.mockResolvedValue(0);
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.serverMember.findMany.mockResolvedValue([]);
    app = createApp();
  });

  it('admin can resolve with ban against a regular user', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    mockPendingReport('target-1');
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's1' }, { serverId: 's2' }]);

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ resolution: 'Spam confirmed', action: 'ban' });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'target-1' },
        data: expect.objectContaining({ bannedAt: expect.any(Date), tokenVersion: { increment: 1 } }),
      }),
    );
    // Same as the canonical ban route: banned user leaves every member list/room
    expect(mockBroadcastMemberLeft).toHaveBeenCalledWith('target-1', 's1');
    expect(mockBroadcastMemberLeft).toHaveBeenCalledWith('target-1', 's2');
  });

  it('admin CANNOT ban a peer admin via report resolution (only superadmins can)', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-admin': { role: 'admin' } });
    mockPendingReport('target-admin');

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ action: 'ban' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Only super admins can ban other admins');
    // Pre-validation: the report must be left untouched
    expect(prismaMock.report.update).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('superadmin CAN ban an admin via report resolution', async () => {
    mockUsers({ 'super-1': { role: 'superadmin' }, 'target-admin': { role: 'admin' } });
    mockPendingReport('target-admin');

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken({ userId: 'super-1', username: 'super' })}`)
      .send({ action: 'ban' });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'target-admin' } }),
    );
  });

  it('nobody can ban a superadmin via report resolution', async () => {
    mockUsers({ 'super-1': { role: 'superadmin' }, 'target-super': { role: 'superadmin' } });
    mockPendingReport('target-super');

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken({ userId: 'super-1', username: 'super' })}`)
      .send({ action: 'ban' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Cannot ban a super admin');
    expect(prismaMock.report.update).not.toHaveBeenCalled();
  });

  it('an admin cannot self-ban via a report against themselves', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });
    mockPendingReport('admin-1');

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ action: 'ban' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Cannot ban yourself');
    expect(prismaMock.report.update).not.toHaveBeenCalled();
  });

  it('resolving WITHOUT a ban action never touches the reported user', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    mockPendingReport('target-1');

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ resolution: 'No action needed' });

    expect(res.status).toBe(200);
    expect(prismaMock.report.update).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(mockBroadcastMemberLeft).not.toHaveBeenCalled();
  });

  it('returns 400 when the report is already processed', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });
    prismaMock.report.findUnique.mockResolvedValue({
      id: 'rep-1',
      status: 'resolved',
      reportedUserId: 'target-1',
      messageId: null,
    });

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ action: 'ban' });

    expect(res.status).toBe(400);
  });
});

describe('GET /admin/reports — evidence provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.report.count.mockResolvedValue(1);
  });

  function mockReportRow(contentSource: string) {
    prismaMock.report.findMany.mockResolvedValue([
      {
        id: 'rep-1',
        type: 'message',
        status: 'pending',
        reason: 'harassment in this DM',
        reporterId: 'user-2',
        reporter: { username: 'reporter' },
        reportedUserId: 'user-3',
        reportedUser: { username: 'accused' },
        messageId: 'msg-1',
        messageContent: 'the text a moderator will act on',
        contentSource,
        channelId: null,
        conversationId: 'conv-1',
        serverId: null,
        resolvedById: null,
        resolvedBy: null,
        resolution: null,
        createdAt: new Date('2026-07-30'),
        resolvedAt: null,
      },
    ]);
  }

  it('marks E2E evidence as reporter-supplied so moderators know it is unverifiable', async () => {
    // The server only holds ciphertext for E2E messages, so this text is the
    // reporter's claim. Losing the flag would let fabricated quotes read as
    // server-captured evidence.
    mockUsers({ 'admin-1': { role: 'admin' } });
    mockReportRow('reporter');

    const res = await request(createApp())
      .get('/api/v1/admin/reports')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].contentSource).toBe('reporter');
  });

  it('marks plaintext evidence as server-captured', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });
    mockReportRow('server');

    const res = await request(createApp())
      .get('/api/v1/admin/reports')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].contentSource).toBe('server');
  });
});
