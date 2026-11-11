import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // the platform-ban disarm (utils/webhookLifecycle.ts): holds none unless a test says so
  webhook: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  serverJoinRequest: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  messageAttachment: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  serverMember: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue({}),
  },
  // The resolution is one interactive transaction; the callback gets this client
  $transaction: vi.fn((arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg))),
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
const mockFetchSockets = vi.fn().mockResolvedValue([]);
const mockDisconnectSockets = vi.fn();
const mockLocalDisconnectSockets = vi.fn();
const mockIn = vi.fn(() => ({ fetchSockets: mockFetchSockets, disconnectSockets: mockDisconnectSockets }));
const mockLocalIn = vi.fn(() => ({ disconnectSockets: mockLocalDisconnectSockets }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
    local: { in: mockLocalIn },
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
const mockEmitToModerators = vi.fn();
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: (...a: any[]) => mockEmitToModerators(...a) }));
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: (...args: any[]) => mockBroadcastMemberLeft(...args),
}));

// S3
const mockDeleteMultipleFromS3 = vi.fn(async (keys: string[]) => keys.length);
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
  deleteMultipleFromS3: (keys: string[]) => mockDeleteMultipleFromS3(keys),
}));

// Audit log
// The fire-and-forget writer is observed; the row a ban commits with is the real shape
vi.mock('../../utils/auditLog', async (importOriginal) => ({
  auditLogData: (await importOriginal<typeof import('../../utils/auditLog')>()).auditLogData,
  logAuditEvent: vi.fn(),
}));

// Feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Directory listing column (a report-resolve ban is the third place bannedAt is set)
const mockRecomputeListedForOwner = vi.fn().mockResolvedValue(0);
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: vi.fn().mockResolvedValue(true),
  recomputeListedForOwner: (...args: any[]) => mockRecomputeListedForOwner(...args),
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
    prismaMock.serverJoinRequest.findMany.mockResolvedValueOnce([{ serverId: 's3' }]);

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
    // ...and, same as the canonical ban route, their servers leave the directory
    expect(mockRecomputeListedForOwner).toHaveBeenCalledWith('target-1');
    // ...and their pending join requests are withdrawn, the moderators told
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { userId: 'target-1' } });
    expect(mockEmitToModerators).toHaveBeenCalledWith('s3', 'server:join_request_resolved', { serverId: 's3', userId: 'target-1', outcome: 'cancelled' });
    // ...and signed out everywhere through the shared revocation helper:
    // room-filtered disconnects, never a per-socket walk
    expect(mockTo).toHaveBeenCalledWith('user:target-1');
    expect(mockEmit).toHaveBeenCalledWith('force:logout', { reason: 'Your account has been banned' });
    expect(mockLocalIn).toHaveBeenCalledWith('user:target-1');
    expect(mockLocalDisconnectSockets).toHaveBeenCalledWith(true);
    expect(mockIn).toHaveBeenCalledWith('user:target-1');
    expect(mockDisconnectSockets).toHaveBeenCalledWith(true);
    expect(mockFetchSockets).not.toHaveBeenCalled();
  });

  it('signs the banned account out right after the ban commits, and a fan-out that fails after it still answers 200', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    mockPendingReport('target-1');
    const order: string[] = [];
    prismaMock.user.update.mockImplementation(async () => { order.push('ban'); return {}; });
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      const r = await arg(prismaMock);
      order.push('commit');
      return r;
    });
    mockEmit.mockImplementation((ev: string) => { order.push(ev); });
    mockDisconnectSockets.mockImplementation(() => { order.push('disconnect'); });
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's1' }]);
    mockBroadcastMemberLeft.mockRejectedValueOnce(new Error('adapter gone'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ resolution: 'Spam confirmed', action: 'ban' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Report resolved' });
    expect(mockEmit).toHaveBeenCalledWith('force:logout', { reason: 'Your account has been banned' });
    expect(mockLocalDisconnectSockets).toHaveBeenCalledWith(true);
    expect(mockDisconnectSockets).toHaveBeenCalledWith(true);
    expect(order.indexOf('force:logout')).toBeGreaterThan(order.indexOf('commit'));
    expect(order.indexOf('commit')).toBeGreaterThan(order.indexOf('ban'));
    expect(order.indexOf('disconnect')).toBeGreaterThan(order.indexOf('force:logout'));
    expect(consoleSpy).toHaveBeenCalledWith('[Admin] User target-1 banned, but the member:left broadcast to s1 failed:', 'adapter gone');
    // The pending-report count still went out after the failed step
    expect(order).toContain('report:new');
    consoleSpy.mockRestore();
    mockEmit.mockReset();
    mockDisconnectSockets.mockReset();
    prismaMock.$transaction.mockImplementation((arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)));
  });

  describe('the audit rows commit with the resolution', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
      mockPendingReport('target-1');
      prismaMock.auditLog.create.mockReset().mockResolvedValue({});
      consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
      prismaMock.$transaction.mockImplementation((arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)));
      mockRecomputeListedForOwner.mockReset().mockResolvedValue(0);
    });

    const resolve = (body: Record<string, unknown> = { resolution: 'Spam confirmed', action: 'ban' }) => request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(body);

    it('writes user.ban and report.resolve INSIDE the transaction that resolves the report and bans the account', async () => {
      const order: string[] = [];
      prismaMock.$transaction.mockImplementation(async (arg: any) => {
        order.push('tx:start');
        const r = await arg(prismaMock);
        order.push('tx:end');
        return r;
      });
      prismaMock.report.update.mockImplementation(async () => { order.push('report'); return {}; });
      prismaMock.user.update.mockImplementation(async () => { order.push('ban'); return {}; });
      prismaMock.auditLog.create.mockImplementation(async ({ data }: any) => { order.push(`audit:${data.action}`); return {}; });
      prismaMock.webhook.findMany.mockResolvedValueOnce([{ serverId: 's-1' }]);

      const res = await resolve();

      expect(res.status).toBe(200);
      expect(order).toEqual(['tx:start', 'report', 'ban', 'audit:user.ban', 'audit:report.resolve', 'tx:end']);
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1', action: 'user.ban', targetType: 'user', targetId: 'target-1',
          metadata: { reason: 'Report resolved: Spam confirmed', webhooksDisarmed: 1 },
        },
      });
      expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1', action: 'report.resolve', targetType: 'report', targetId: 'rep-1',
          metadata: { resolution: 'Spam confirmed', action: 'ban', messageDeleted: false },
        },
      });
    });

    it('a resolution whose transaction fails records nothing, bans nobody and signs nobody out', async () => {
      prismaMock.$transaction.mockRejectedValueOnce(new Error('db gone'));

      const res = await resolve();

      expect(res.status).toBe(500);
      expect(mockEmit).not.toHaveBeenCalledWith('force:logout', expect.anything());
      expect(mockRecomputeListedForOwner).not.toHaveBeenCalled();
    });

    it.each([
      ['the directory recompute', () => mockRecomputeListedForOwner.mockRejectedValueOnce(new Error('step failed'))],
      ['the join-request withdrawal notice to s-9', () => {
        prismaMock.serverJoinRequest.findMany.mockResolvedValueOnce([{ serverId: 's-9' }]);
        mockEmitToModerators.mockRejectedValueOnce(new Error('step failed'));
      }],
      ['the membership read', () => prismaMock.serverMember.findMany.mockRejectedValueOnce(new Error('step failed'))],
    ])('a rejecting step after the commit (%s) is logged and the resolution still answers 200', async (step, arrange) => {
      arrange();

      const res = await resolve();

      expect(res.status).toBe(200);
      expect(consoleSpy).toHaveBeenCalledWith(`[Admin] User target-1 banned, but ${step} failed:`, 'step failed');
      expect(mockEmit).toHaveBeenCalledWith('force:logout', { reason: 'Your account has been banned' });
      expect(mockEmit).toHaveBeenCalledWith('report:new', { total: 0 });
    });

    it('a pending-report count that fails is logged and the resolution still answers 200', async () => {
      prismaMock.report.count.mockRejectedValueOnce(new Error('db gone'));

      const res = await resolve({ resolution: 'Not actionable' });

      expect(res.status).toBe(200);
      expect(consoleSpy).toHaveBeenCalledWith('[Admin] Report rep-1 resolved, but the pending-report count update failed:', 'db gone');
    });
  });

  it('resolving WITHOUT a ban leaves the directory alone', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    mockPendingReport('target-1');

    const res = await request(app)
      .post('/api/v1/admin/reports/rep-1/resolve')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ resolution: 'Not actionable' });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(mockRecomputeListedForOwner).not.toHaveBeenCalled();
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

describe('POST /admin/reports/:id/resolve — deleting the reported message', () => {
  const KEY = 'attachments/ch-chan1/clmsg1-photo.png';

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.report.update.mockResolvedValue({});
    prismaMock.report.count.mockResolvedValue(0);
    prismaMock.report.findUnique.mockResolvedValue({ id: 'rep-1', status: 'pending', reportedUserId: 'target-1', messageId: 'msg-1' });
    prismaMock.message.findUnique.mockResolvedValue({ id: 'msg-1', channelId: 'chan1', conversationId: null });
    prismaMock.message.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.messageAttachment.findMany.mockReset().mockResolvedValue([]);
    mockDeleteMultipleFromS3.mockReset().mockImplementation(async (keys: string[]) => keys.length);
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
  });

  const resolve = () => request(createApp())
    .post('/api/v1/admin/reports/rep-1/resolve')
    .set('Authorization', `Bearer ${makeToken()}`)
    .send({ resolution: 'Removed', deleteMessage: true });

  it('reads its attachment keys before the row and deletes the files after it', async () => {
    prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);

    const res = await resolve();

    expect(res.status).toBe(200);
    expect(prismaMock.message.deleteMany).toHaveBeenCalledWith({ where: { id: 'msg-1' } });
    expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { expired: false, message: { id: 'msg-1' } },
    }));
    expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([KEY]);
    const deleteOrder = prismaMock.message.deleteMany.mock.invocationCallOrder[0];
    expect(prismaMock.messageAttachment.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
    expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
    expect(mockEmit).toHaveBeenCalledWith('message:delete', { messageId: 'msg-1', channelId: 'chan1' });
  });

  it('touches storage not at all for a message without attachments', async () => {
    const res = await resolve();

    expect(res.status).toBe(200);
    expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
  });

  it('a resolution whose transaction fails deletes no file and announces no delete', async () => {
    prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);
    prismaMock.message.deleteMany.mockRejectedValueOnce(new Error('db gone'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await resolve();

      expect(res.status).toBe(500);
      expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalledWith('message:delete', expect.anything());
    } finally {
      errorLog.mockRestore();
    }
  });

  it('a message its author deleted meanwhile still resolves the report, with nothing to announce', async () => {
    prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);
    prismaMock.message.deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await resolve();

    expect(res.status).toBe(200);
    expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalledWith('message:delete', expect.anything());
  });

  it('a delete notice that throws still answers 200 and the files still go', async () => {
    prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);
    mockEmit.mockImplementationOnce(() => { throw new Error('adapter gone'); });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await resolve();

      expect(res.status).toBe(200);
      expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([KEY]);
      expect(errorLog).toHaveBeenCalledWith('[Admin] Report rep-1 resolved, but the message delete notice failed:', 'adapter gone');
    } finally {
      errorLog.mockRestore();
      mockEmit.mockReset();
    }
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
