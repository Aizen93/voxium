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
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  },
  server: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  serverMember: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  ipRecord: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  ipBan: {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue({}),
  },
  // Ops are already in-flight promises (the model mocks resolve eagerly), so
  // Promise.all faithfully models "everything in the array ran in the txn".
  $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
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
  return { rateLimitAdmin: passthrough };
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

// Voice cluster
vi.mock('../../websocket/voiceCluster', () => ({
  broadcastServerVoiceCleanup: vi.fn().mockResolvedValue(undefined),
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
 * middleware lookup (actor) and the route's target lookup.
 */
function mockUsers(users: Record<string, { role?: string; bannedAt?: Date | null }>) {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    const row = users[where.id];
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id,
      bannedAt: null,
      tokenVersion: 0,
      emailVerified: true,
      role: 'user',
      ...row,
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /admin/users/:userId/ban — atomic IP bans (MED-13)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.serverMember.findMany.mockResolvedValue([]);
    prismaMock.ipRecord.findMany.mockResolvedValue([]);
    prismaMock.ipBan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    app = createApp();
  });

  it('banIps=true bans account + all known IPs in ONE transaction', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.ipRecord.findMany.mockResolvedValue([{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);
    prismaMock.ipBan.createMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .post('/api/v1/admin/users/target-1/ban')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reason: 'spam', banIps: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // ipsBanned in the message comes from createMany's { count }
    expect(res.body.message).toContain('2 IP(s)');

    // Exactly one transaction, holding both statements (user update + IP bans)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const txnOps = prismaMock.$transaction.mock.calls[0][0];
    expect(Array.isArray(txnOps)).toBe(true);
    expect(txnOps).toHaveLength(2);

    // Both statements were built for the transaction (invoked before $transaction resolved)
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'target-1' },
      data: expect.objectContaining({
        bannedAt: expect.any(Date),
        banReason: 'spam',
        tokenVersion: { increment: 1 },
      }),
    });
    expect(prismaMock.ipBan.createMany).toHaveBeenCalledWith({
      data: [
        { ip: '1.1.1.1', reason: 'spam', bannedBy: 'admin-1' },
        { ip: '2.2.2.2', reason: 'spam', bannedBy: 'admin-1' },
      ],
      skipDuplicates: true,
    });
  });
});

describe('POST /admin/users/:userId/unban — shared-IP-aware release (MED-13)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.ipBan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    app = createApp();
  });

  function mockUnbanTarget() {
    mockUsers({
      'admin-1': { role: 'admin' },
      'target-1': { role: 'user', bannedAt: new Date('2026-01-01T00:00:00Z') },
    });
  }

  it('releases only IPs not shared with another banned user, inside the transaction', async () => {
    mockUnbanTarget();
    // 1st call: the target's known IPs. 2nd call (has ip: { in }): IPs shared
    // with OTHER banned users → 2.2.2.2 must stay banned.
    prismaMock.ipRecord.findMany.mockImplementation(({ where }: any) => {
      if (where.ip) return Promise.resolve([{ ip: '2.2.2.2' }]);
      return Promise.resolve([{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);
    });

    const res = await request(app)
      .post('/api/v1/admin/users/target-1/unban')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The shared-IP resolution query filters by the target's IPs in ONE query
    expect(prismaMock.ipRecord.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.ipRecord.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        ip: { in: ['1.1.1.1', '2.2.2.2'] },
        userId: { not: 'target-1' },
      }),
    }));

    // Only the unshared IP is released
    expect(prismaMock.ipBan.deleteMany).toHaveBeenCalledWith({
      where: { ip: { in: ['1.1.1.1'] } },
    });

    // Unban + IP release happen in one transaction (user.update + deleteMany)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const txnOps = prismaMock.$transaction.mock.calls[0][0];
    expect(Array.isArray(txnOps)).toBe(true);
    expect(txnOps).toHaveLength(2);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'target-1' },
      data: { bannedAt: null, banReason: null },
    });
  });

  it('when ALL IPs are shared with other banned users, no deleteMany but the unban still runs', async () => {
    mockUnbanTarget();
    prismaMock.ipRecord.findMany.mockImplementation(({ where }: any) => {
      if (where.ip) return Promise.resolve([{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);
      return Promise.resolve([{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);
    });

    const res = await request(app)
      .post('/api/v1/admin/users/target-1/unban')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(prismaMock.ipBan.deleteMany).not.toHaveBeenCalled();

    // The transaction still runs the user update alone
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const txnOps = prismaMock.$transaction.mock.calls[0][0];
    expect(txnOps).toHaveLength(1);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'target-1' },
      data: { bannedAt: null, banReason: null },
    });
  });
});

describe('GET /admin/export/users — cursor batching (MED-12)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('pages through users in 1000-row batches and returns the full dataset', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });

    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `u${i}`, username: `user${i}` }));
    const page2 = [{ id: 'z1' }, { id: 'z2' }, { id: 'z3' }];
    prismaMock.user.findMany.mockImplementation((args: any) =>
      Promise.resolve(args.cursor ? page2 : page1));

    const res = await request(app)
      .get('/api/v1/admin/export/users')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1003);

    expect(prismaMock.user.findMany).toHaveBeenCalledTimes(2);
    // First page: stable id ordering, bounded batch, no cursor
    expect(prismaMock.user.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: { id: 'asc' },
      take: 1000,
    }));
    expect(prismaMock.user.findMany.mock.calls[0][0].cursor).toBeUndefined();
    // Second page: cursor on the last id of page 1, skipping the cursor row
    expect(prismaMock.user.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: { id: 'asc' },
      take: 1000,
      cursor: { id: 'u999' },
      skip: 1,
    }));
  });
});

describe('GET /admin/top-servers — subquery aggregation (MED-12)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('returns plain Numbers and aggregates via GROUP BY subqueries, not COUNT(DISTINCT) over a cartesian join', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { id: 's1', name: 'Big Server', message_count: 5n, member_count: 3n },
    ]);

    const res = await request(app)
      .get('/api/v1/admin/top-servers')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 's1', name: 'Big Server', messageCount: 5, memberCount: 3 },
    ]);
    expect(typeof res.body.data[0].messageCount).toBe('number');
    expect(typeof res.body.data[0].memberCount).toBe('number');

    // Regression guard: messages aggregated per server in a subquery — the old
    // double LEFT JOIN + COUNT(DISTINCT) produced a cartesian rowset
    const sql = prismaMock.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('GROUP BY c.server_id');
    expect(sql).not.toContain('COUNT(DISTINCT');
  });
});

// NOTE: this route has a 60-second in-module cache (topUploadersCache) that
// persists across tests in this file — keep it to a SINGLE test so the second
// hit never silently asserts against a cached response.
describe('GET /admin/storage/top-uploaders — SQL aggregation + top-N name resolution (MED-12)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('aggregates attachments in two grouped queries and resolves names for only the top entities', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });
    prismaMock.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('m.author_id')) {
        return Promise.resolve([{ entity_id: 'u1', file_count: 2n, total_size: 100n }]);
      }
      return Promise.resolve([{ entity_id: 'srv1', file_count: 1n, total_size: 50n }]);
    });
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', username: 'alice' }]);
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', name: 'My Server' }]);

    const res = await request(app)
      .get('/api/v1/admin/storage/top-uploaders')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);

    // Two grouped queries: per-user rows + per-server rows
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);

    // Names are looked up for ONLY the ranked top entities' ids
    expect(prismaMock.user.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['u1'] } },
    }));
    expect(prismaMock.server.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['srv1'] } },
    }));

    // Sorted by totalSize desc, names resolved, bigints converted to Numbers
    expect(res.body.data).toEqual([
      { entityId: 'u1', type: 'user', fileCount: 2, totalSize: 100, entityName: 'alice' },
      { entityId: 'srv1', type: 'server', fileCount: 1, totalSize: 50, entityName: 'My Server' },
    ]);
    expect(typeof res.body.data[0].fileCount).toBe('number');
    expect(typeof res.body.data[0].totalSize).toBe('number');
  });
});
