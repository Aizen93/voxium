import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// The admin resource-limit routes (GET/PUT /admin/limits/global, GET/PUT
// /admin/limits/servers/:serverId): every hand-written field map carries
// maxWebhooksPerServer, clamped to 0..100 (0 freezes webhook creation).

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken() {
  return jwt.sign({ userId: 'admin-1', username: 'admin', tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  server: { findUnique: vi.fn() },
  globalConfig: { upsert: vi.fn(), findUnique: vi.fn() },
  serverLimits: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_t, prop) { return prismaMock[prop as string]; } }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) })),
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
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: vi.fn(), broadcastMemberLeft: vi.fn() }));
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9/_.-]+$/, VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]), deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: vi.fn().mockResolvedValue(true),
  recomputeListedForOwner: vi.fn().mockResolvedValue(0),
}));
// utils/serverLimits is NOT mocked: GET /limits/global goes through the real
// getGlobalLimits(), so its field map is covered too.

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const GLOBAL_ROW = {
  id: 'global',
  maxChannelsPerServer: 20,
  maxVoiceUsersPerChannel: 12,
  maxCategoriesPerServer: 12,
  maxMembersPerServer: 0,
  maxWebhooksPerServer: 10,
};

const NULL_OVERRIDES = {
  maxChannelsPerServer: null,
  maxVoiceUsersPerChannel: null,
  maxCategoriesPerServer: null,
  maxMembersPerServer: null,
  maxWebhooksPerServer: null,
};

let app: express.Express;
const auth = () => ({ Authorization: `Bearer ${makeToken()}` });

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'admin-1', role: 'admin', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  });
  prismaMock.globalConfig.upsert.mockImplementation(async ({ update }: any) => ({ ...GLOBAL_ROW, ...update }));
  prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1' });
  prismaMock.serverLimits.findUnique.mockResolvedValue(null);
  prismaMock.serverLimits.upsert.mockImplementation(async ({ update }: any) => ({ serverId: 'srv-1', ...NULL_OVERRIDES, ...update }));
});

describe('admin limits: access', () => {
  it('non-admins are refused', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'admin-1', role: 'user', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    const res = await request(app).put('/api/v1/admin/limits/global').set(auth()).send({ maxWebhooksPerServer: 5 });
    expect(res.status).toBe(403);
    expect(prismaMock.globalConfig.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /admin/limits/global', () => {
  it('includes maxWebhooksPerServer', async () => {
    prismaMock.globalConfig.upsert.mockResolvedValue({ ...GLOBAL_ROW, maxWebhooksPerServer: 7 });
    const res = await request(app).get('/api/v1/admin/limits/global').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      maxChannelsPerServer: 20,
      maxVoiceUsersPerChannel: 12,
      maxCategoriesPerServer: 12,
      maxMembersPerServer: 0,
      maxWebhooksPerServer: 7,
    });
  });
});

describe('PUT /admin/limits/global', () => {
  const put = (body: object) => request(app).put('/api/v1/admin/limits/global').set(auth()).send(body);

  it('writes maxWebhooksPerServer and returns it with the other four', async () => {
    const res = await put({ maxWebhooksPerServer: 25 });
    expect(res.status).toBe(200);
    expect(prismaMock.globalConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'global' },
      create: { id: 'global', maxWebhooksPerServer: 25 },
      update: { maxWebhooksPerServer: 25 },
    });
    expect(res.body.data).toEqual({
      maxChannelsPerServer: 20,
      maxVoiceUsersPerChannel: 12,
      maxCategoriesPerServer: 12,
      maxMembersPerServer: 0,
      maxWebhooksPerServer: 25,
    });
  });

  it.each([
    [-5, 0],
    [500, 100],
    [0, 0],
    [100, 100],
    ['7', 7],
  ])('clamps %s to %s (0 is kept: it freezes creation)', async (input, expected) => {
    const res = await put({ maxWebhooksPerServer: input });
    expect(prismaMock.globalConfig.upsert.mock.calls[0][0].update).toEqual({ maxWebhooksPerServer: expected });
    expect(res.body.data.maxWebhooksPerServer).toBe(expected);
  });

  it('leaves the field alone when omitted', async () => {
    const res = await put({ maxChannelsPerServer: 30 });
    expect(prismaMock.globalConfig.upsert.mock.calls[0][0].update).toEqual({ maxChannelsPerServer: 30 });
    expect(res.body.data.maxWebhooksPerServer).toBe(10);
  });

  it.each([[null], [''], ['abc'], [2.5], [true]])('refuses %s with a 400: never a silent 0, which would freeze creation platform-wide', async (input) => {
    const res = await put({ maxWebhooksPerServer: input });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'maxWebhooksPerServer must be an integer' });
    expect(prismaMock.globalConfig.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /admin/limits/servers/:serverId', () => {
  it('answers null for every field (webhooks included) when there is no override row', async () => {
    const res = await request(app).get('/api/v1/admin/limits/servers/srv-1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(NULL_OVERRIDES);
  });

  it('returns the stored override, 0 included', async () => {
    prismaMock.serverLimits.findUnique.mockResolvedValue({ serverId: 'srv-1', ...NULL_OVERRIDES, maxWebhooksPerServer: 0 });
    const res = await request(app).get('/api/v1/admin/limits/servers/srv-1').set(auth());
    expect(res.body.data).toEqual({ ...NULL_OVERRIDES, maxWebhooksPerServer: 0 });
  });
});

describe('PUT /admin/limits/servers/:serverId', () => {
  const put = (body: object) => request(app).put('/api/v1/admin/limits/servers/srv-1').set(auth()).send(body);

  it('404 for an unknown server', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    const res = await put({ maxWebhooksPerServer: 3 });
    expect(res.status).toBe(404);
    expect(prismaMock.serverLimits.upsert).not.toHaveBeenCalled();
  });

  it('round-trips an override through PUT then GET', async () => {
    const res = await put({ maxWebhooksPerServer: 3 });
    expect(res.status).toBe(200);
    expect(prismaMock.serverLimits.upsert).toHaveBeenCalledWith({
      where: { serverId: 'srv-1' },
      create: { serverId: 'srv-1', maxWebhooksPerServer: 3 },
      update: { maxWebhooksPerServer: 3 },
    });
    expect(res.body.data).toEqual({ ...NULL_OVERRIDES, maxWebhooksPerServer: 3 });

    prismaMock.serverLimits.findUnique.mockResolvedValue(await prismaMock.serverLimits.upsert.mock.results[0].value);
    const get = await request(app).get('/api/v1/admin/limits/servers/srv-1').set(auth());
    expect(get.body.data).toEqual({ ...NULL_OVERRIDES, maxWebhooksPerServer: 3 });
  });

  it.each([
    [-5, 0],
    [500, 100],
    [0, 0],
    ['12', 12],
    [null, null],
    ['', null],
    ['abc', null],
  ])('maps %s to %s (null falls back to the global value)', async (input, expected) => {
    const res = await put({ maxWebhooksPerServer: input });
    expect(prismaMock.serverLimits.upsert.mock.calls[0][0].update).toEqual({ maxWebhooksPerServer: expected });
    expect(res.body.data.maxWebhooksPerServer).toBe(expected);
  });

  it('leaves the field out of the write when omitted', async () => {
    await put({ maxChannelsPerServer: 40 });
    expect(prismaMock.serverLimits.upsert.mock.calls[0][0].update).toEqual({ maxChannelsPerServer: 40 });
  });
});
