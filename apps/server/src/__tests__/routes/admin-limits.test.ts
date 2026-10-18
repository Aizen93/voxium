import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// The admin resource-limit routes (GET/PUT /admin/limits/global, GET/PUT/DELETE
// /admin/limits/servers/:serverId): every hand-written field map carries
// maxWebhooksPerServer, clamped to 0..100 (0 freezes webhook creation), and
// every write is audited with the five fields before and after it.

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
import { logAuditEvent } from '../../utils/auditLog';

const audit = vi.mocked(logAuditEvent);

/** The upsert that WRITES (the last one): PUT /limits/global first reads the
 *  values in force through getGlobalLimits(), itself an upsert with update {}. */
function globalWrite() {
  const calls = prismaMock.globalConfig.upsert.mock.calls;
  return calls[calls.length - 1][0];
}

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
    expect(globalWrite().update).toEqual({ maxWebhooksPerServer: expected });
    expect(res.body.data.maxWebhooksPerServer).toBe(expected);
  });

  it('leaves the field alone when omitted', async () => {
    const res = await put({ maxChannelsPerServer: 30 });
    expect(globalWrite().update).toEqual({ maxChannelsPerServer: 30 });
    expect(res.body.data.maxWebhooksPerServer).toBe(10);
  });

  it.each([[null], [''], ['abc'], [2.5], [true]])('refuses %s with a 400: never a silent 0, which would freeze creation platform-wide', async (input) => {
    const res = await put({ maxWebhooksPerServer: input });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'maxWebhooksPerServer must be an integer' });
    expect(prismaMock.globalConfig.upsert).not.toHaveBeenCalled();
  });

  it.each([['maxChannelsPerServer'], ['maxVoiceUsersPerChannel'], ['maxCategoriesPerServer'], ['maxMembersPerServer']])('the older field %s is a whole number or a 400 too (text and fractions used to reach Prisma as NaN or 2.5)', async (field) => {
    for (const input of ['abc', 2.5, null]) {
      const res = await put({ [field]: input });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: `${field} must be an integer` });
    }
    expect(prismaMock.globalConfig.upsert).not.toHaveBeenCalled();
    const ok = await put({ [field]: '7' });
    expect(ok.status).toBe(200);
    // the route reads the limits in force first (an upsert with an empty update): the write is the LAST call
    expect(prismaMock.globalConfig.upsert.mock.calls.at(-1)![0].update).toEqual({ [field]: 7 });
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

  it('a fraction is a 400 (never a Prisma 500); text still means "use global"', async () => {
    const res = await put({ maxWebhooksPerServer: 2.5 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Limits must be whole numbers' });
    expect(prismaMock.serverLimits.upsert).not.toHaveBeenCalled();
  });

  it('leaves the field out of the write when omitted', async () => {
    await put({ maxChannelsPerServer: 40 });
    expect(prismaMock.serverLimits.upsert.mock.calls[0][0].update).toEqual({ maxChannelsPerServer: 40 });
  });
});

// ─── Audit ──────────────────────────────────────────────────────────────────

describe('limits audit: PUT /admin/limits/global', () => {
  const put = (body: object) => request(app).put('/api/v1/admin/limits/global').set(auth()).send(body);
  const { id: _id, ...GLOBAL_FIELDS } = GLOBAL_ROW;

  it('logs limits.update_global with the five fields before and after, and nothing else', async () => {
    const res = await put({ maxWebhooksPerServer: 25, maxChannelsPerServer: 40 });
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'limits.update_global',
      targetType: 'global_config',
      targetId: 'global',
      metadata: {
        before: GLOBAL_FIELDS,
        after: { ...GLOBAL_FIELDS, maxWebhooksPerServer: 25, maxChannelsPerServer: 40 },
      },
    });
    const { metadata } = audit.mock.calls[0][0];
    expect(Object.keys(metadata!)).toEqual(['before', 'after']);
    // `after` is exactly what the response answers (no row id rides along)
    expect((metadata as { after: unknown }).after).toEqual(res.body.data);
  });

  it('reads `before` through getGlobalLimits() BEFORE the write (the values in force, defaults for a missing row)', async () => {
    // The row as it stood: the read answers it, the write then changes it
    prismaMock.globalConfig.upsert.mockImplementationOnce(async () => ({ ...GLOBAL_ROW, maxWebhooksPerServer: 4 }));
    await put({ maxWebhooksPerServer: 6 });

    const calls = prismaMock.globalConfig.upsert.mock.calls;
    expect(calls).toHaveLength(2);
    // first: getGlobalLimits()'s create-if-missing read; second: the write
    expect(calls[0][0]).toEqual({ where: { id: 'global' }, create: { id: 'global' }, update: {} });
    expect(calls[1][0].update).toEqual({ maxWebhooksPerServer: 6 });
    const { before, after } = audit.mock.calls[0][0].metadata as Record<string, Record<string, number>>;
    expect(before.maxWebhooksPerServer).toBe(4);
    expect(after.maxWebhooksPerServer).toBe(6);
  });

  it('a refused body (400) reads nothing, writes nothing and logs nothing', async () => {
    const res = await put({ maxWebhooksPerServer: 'abc' });
    expect(res.status).toBe(400);
    expect(prismaMock.globalConfig.upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a failed write is a 500 and logs nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.globalConfig.upsert
      .mockImplementationOnce(async () => GLOBAL_ROW)
      .mockRejectedValueOnce(new Error('db gone'));
    const res = await put({ maxWebhooksPerServer: 6 });
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a non-admin is refused before anything is logged', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'admin-1', role: 'user', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
    expect((await put({ maxWebhooksPerServer: 5 })).status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('limits audit: PUT /admin/limits/servers/:serverId', () => {
  const put = (body: object) => request(app).put('/api/v1/admin/limits/servers/srv-1').set(auth()).send(body);

  it('a first override: `before` is all null (no row), `after` the stored row\'s five fields', async () => {
    const res = await put({ maxWebhooksPerServer: 3 });
    expect(res.status).toBe(200);
    expect(prismaMock.serverLimits.findUnique).toHaveBeenCalledWith({ where: { serverId: 'srv-1' } });
    expect(prismaMock.serverLimits.findUnique.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.serverLimits.upsert.mock.invocationCallOrder[0]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'limits.update_server',
      targetType: 'server',
      targetId: 'srv-1',
      metadata: { before: NULL_OVERRIDES, after: { ...NULL_OVERRIDES, maxWebhooksPerServer: 3 } },
    });
    // the row's serverId column never rides in the metadata
    expect(JSON.stringify(audit.mock.calls[0][0].metadata)).not.toContain('srv-1');
    expect(res.body.data).toEqual({ ...NULL_OVERRIDES, maxWebhooksPerServer: 3 });
  });

  it('an existing override: `before` is that row\'s five fields, never its other columns', async () => {
    prismaMock.serverLimits.findUnique.mockResolvedValue({
      id: 'sl-1', serverId: 'srv-1', ...NULL_OVERRIDES, maxChannelsPerServer: 50, maxWebhooksPerServer: 2,
    });
    await put({ maxWebhooksPerServer: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'limits.update_server',
      metadata: {
        before: { ...NULL_OVERRIDES, maxChannelsPerServer: 50, maxWebhooksPerServer: 2 },
        after: { ...NULL_OVERRIDES, maxWebhooksPerServer: null },
      },
    }));
  });

  it('an unknown server (404) reads no override and logs nothing', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    const res = await put({ maxWebhooksPerServer: 3 });
    expect(res.status).toBe(404);
    expect(prismaMock.serverLimits.findUnique).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a failed write is a 500 and logs nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.serverLimits.upsert.mockRejectedValueOnce(new Error('db gone'));
    const res = await put({ maxWebhooksPerServer: 3 });
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('DELETE /admin/limits/servers/:serverId', () => {
  const del = () => request(app).delete('/api/v1/admin/limits/servers/srv-1').set(auth());

  beforeEach(() => {
    prismaMock.serverLimits.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('removes the override and logs limits.reset_server with the row\'s five fields as `before`', async () => {
    prismaMock.serverLimits.findUnique.mockResolvedValue({
      id: 'sl-1', serverId: 'srv-1', ...NULL_OVERRIDES, maxMembersPerServer: 500, maxWebhooksPerServer: 0,
    });
    const res = await del();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Server limits reset to global defaults' });
    expect(prismaMock.serverLimits.deleteMany).toHaveBeenCalledWith({ where: { serverId: 'srv-1' } });
    expect(prismaMock.serverLimits.findUnique.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.serverLimits.deleteMany.mock.invocationCallOrder[0]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'limits.reset_server',
      targetType: 'server',
      targetId: 'srv-1',
      metadata: { before: { ...NULL_OVERRIDES, maxMembersPerServer: 500, maxWebhooksPerServer: 0 } },
    });
  });

  it('without an override row: still a 200 reset, `before` all null', async () => {
    prismaMock.serverLimits.deleteMany.mockResolvedValue({ count: 0 });
    const res = await del();
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'limits.reset_server',
      metadata: { before: NULL_OVERRIDES },
    }));
  });

  it('a failed delete is a 500 and logs nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.serverLimits.deleteMany.mockRejectedValueOnce(new Error('db gone'));
    const res = await del();
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
