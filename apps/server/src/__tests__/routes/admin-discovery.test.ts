import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// PATCH /admin/servers/:serverId/discovery (feature / block, audited) and the
// directory columns + listed filter on GET /admin/servers.

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken() {
  return jwt.sign({ userId: 'admin-1', username: 'admin', tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  server: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  message: { groupBy: vi.fn().mockResolvedValue([]) },
  channel: { findMany: vi.fn().mockResolvedValue([]) },
  serverMember: { findMany: vi.fn().mockResolvedValue([]) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_t, prop) { return prismaMock[prop as string]; } }),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: mockTo, in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) })),
}));
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough, normalizeIp: (ip: string) => ip };
});
vi.mock('../../utils/redis', () => ({ getOnlineUsers: vi.fn().mockResolvedValue([]) }));
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(), getVoiceMediaCounts: vi.fn().mockReturnValue({}), getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0), getTotalVoiceUsers: vi.fn().mockResolvedValue(0), getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../websocket/voiceCluster', () => ({ broadcastServerVoiceCleanup: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../websocket/dmVoiceHandler', () => ({ getActiveDMCallCount: vi.fn().mockResolvedValue(0), getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0) }));
vi.mock('../../mediasoup/mediasoupManager', () => ({ getSfuStats: vi.fn().mockReturnValue({ workers: [] }) }));
vi.mock('../../utils/serverLimits', () => ({ getGlobalLimits: vi.fn().mockResolvedValue({}) }));
vi.mock('../../utils/sanitize', () => ({ sanitizeText: vi.fn((s: string) => s) }));
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: vi.fn(), broadcastMemberLeft: vi.fn() }));
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/, VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]), deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));
const mockLogAuditEvent = vi.fn();
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: (...a: any[]) => mockLogAuditEvent(...a) }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));
const mockRecomputeListed = vi.fn();
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: (...a: any[]) => mockRecomputeListed(...a),
  recomputeListedForOwner: vi.fn().mockResolvedValue(0),
}));

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const NOW = new Date('2026-10-09T12:00:00Z');
const SERVER_SHAPE = {
  id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: false, ownerId: 'o-1', createdAt: NOW,
  description: null, tags: [], discoverable: true, joinMode: 'approval',
};

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'admin-1', role: 'admin', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  });
  mockRecomputeListed.mockResolvedValue(true);
  prismaMock.server.update.mockImplementation(async ({ data }: any) => ({
    ...SERVER_SHAPE, discoveryListed: true, featuredAt: null, discoveryBlockedAt: null, ...data,
  }));
});

describe('PATCH /admin/servers/:serverId/discovery', () => {
  const patch = (body: unknown) => request(app).patch('/api/v1/admin/servers/srv-1/discovery').set('Authorization', `Bearer ${makeToken()}`).send(body);

  it('validates the body: at least one boolean, booleans only', async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ featured: 'yes' })).status).toBe(400);
    expect((await patch({ blocked: 1 })).status).toBe(400);
    expect(prismaMock.server.update).not.toHaveBeenCalled();
  });

  it('is 404 for an unknown server', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    expect((await patch({ featured: true })).status).toBe(404);
  });

  it('feature requires the server to be LISTED (a Featured row of hidden servers would be a list of 404s)', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: false, featuredAt: null, discoveryBlockedAt: null });
    const res = await patch({ featured: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Only listed servers');
    expect(prismaMock.server.update).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('feature: sets featuredAt, recomputes, emits server:updated (Server shape only) and writes one audit row', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });

    const res = await patch({ featured: true });

    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'srv-1' }, data: { featuredAt: expect.any(Date) } }));
    expect(mockRecomputeListed).toHaveBeenCalledWith('srv-1');
    expect(mockTo).toHaveBeenCalledWith('server:srv-1');
    const emitted = mockEmit.mock.calls.find(([e]: any[]) => e === 'server:updated')![1];
    expect(emitted).toMatchObject({ id: 'srv-1', joinMode: 'approval' });
    expect(emitted).not.toHaveProperty('featuredAt');
    expect(emitted).not.toHaveProperty('discoveryBlockedAt');
    expect(emitted).not.toHaveProperty('discoveryListed');
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockLogAuditEvent).toHaveBeenCalledWith({ actorId: 'admin-1', action: 'server.discovery_feature', targetType: 'server', targetId: 'srv-1' });
    expect(res.body.data).toMatchObject({ id: 'srv-1', discoveryListed: true });
    expect(res.body.data.featuredAt).toBeTruthy();
  });

  it('feature twice is idempotent: no second audit row', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null });
    const res = await patch({ featured: true });
    expect(res.status).toBe(200);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('unfeature clears featuredAt and audits', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null });
    const res = await patch({ featured: false });
    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ data: { featuredAt: null } }));
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.discovery_unfeature' }));
  });

  it('block: clears discoverable and featuredAt, stamps discoveryBlockedAt, recomputes, audits block (+ unfeature when it was featured)', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null });
    mockRecomputeListed.mockResolvedValue(false);

    const res = await patch({ blocked: true });

    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { discoverable: false, featuredAt: null, discoveryBlockedAt: expect.any(Date) },
    }));
    expect(mockRecomputeListed).toHaveBeenCalledWith('srv-1');
    expect(res.body.data).toMatchObject({ discoverable: false, discoveryListed: false });
    const actions = mockLogAuditEvent.mock.calls.map(([e]: any[]) => e.action).sort();
    expect(actions).toEqual(['server.discovery_block', 'server.discovery_unfeature']);
  });

  it('a blocked server cannot be featured in the same call', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });
    const res = await patch({ blocked: true, featured: true });
    expect(res.status).toBe(400);
    expect(prismaMock.server.update).not.toHaveBeenCalled();
  });

  it('unblock clears the block only — the owner relists manually — and audits', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: false, featuredAt: null, discoveryBlockedAt: NOW });
    mockRecomputeListed.mockResolvedValue(false);

    const res = await patch({ blocked: false });

    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ data: { discoveryBlockedAt: null } }));
    expect(prismaMock.server.update.mock.calls[0][0].data).not.toHaveProperty('discoverable');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.discovery_unblock' }));
    expect(res.body.data.discoveryListed).toBe(false);
  });

  it('falls back to the stored listed value when the recompute could not run', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });
    mockRecomputeListed.mockResolvedValue(null);
    const res = await patch({ featured: true });
    expect(res.status).toBe(200);
    expect(res.body.data.discoveryListed).toBe(true);
  });
});

describe('GET /admin/servers — directory columns and the listed filter', () => {
  it('selects and returns the directory state per row', async () => {
    prismaMock.server.findMany.mockResolvedValue([{
      ...SERVER_SHAPE, discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null,
      owner: { username: 'owner' }, _count: { members: 3, channels: 2 },
    }]);
    prismaMock.server.count.mockResolvedValue(1);

    const res = await request(app).get('/api/v1/admin/servers').set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {},
      select: expect.objectContaining({ discoverable: true, discoveryListed: true, joinMode: true, featuredAt: true, discoveryBlockedAt: true, invitesLocked: true, description: true, tags: true }),
    }));
    expect(res.body.data[0]).toMatchObject({
      id: 'srv-1', discoverable: true, discoveryListed: true, joinMode: 'approval', featuredAt: NOW.toISOString(), discoveryBlockedAt: null, invitesLocked: false, tags: [],
    });
  });

  it('listed=1 narrows to servers currently in Explore', async () => {
    await request(app).get('/api/v1/admin/servers?listed=1').set('Authorization', `Bearer ${makeToken()}`);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { discoveryListed: true } }));
    expect(prismaMock.server.count).toHaveBeenCalledWith({ where: { discoveryListed: true } });
  });
});
