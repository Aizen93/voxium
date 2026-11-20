import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// The admin announcement routes: an announcement may name one legal document
// (privacy, terms or cookies). The value is validated at runtime before
// anything is written, then stored, returned in every shape and audited.

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const broadcast = vi.hoisted(() => ({ emit: vi.fn() }));

function makeToken() {
  return jwt.sign({ userId: 'admin-1', username: 'admin', tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  server: { findUnique: vi.fn(), findMany: vi.fn() },
  announcement: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_t, prop) { return prismaMock[prop as string]; } }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    emit: broadcast.emit,
    to: vi.fn(() => ({ emit: broadcast.emit })),
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
  })),
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

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';
import { logAuditEvent } from '../../utils/auditLog';

const audit = vi.mocked(logAuditEvent);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const auth = () => ({ Authorization: `Bearer ${makeToken()}` });
const BASE = { title: 'Policy change', content: 'Line one\nLine two', type: 'info', scope: 'global' };

function row(data: any) {
  return {
    id: 'ann-1', title: data.title, content: data.content, type: data.type, scope: data.scope,
    serverIds: data.serverIds ?? [], createdById: 'admin-1', createdBy: { username: 'admin' },
    publishedAt: data.publishedAt ?? null, expiresAt: null, createdAt: new Date(0), legalDoc: data.legalDoc ?? null,
  };
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'admin-1', role: 'admin', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  });
  prismaMock.announcement.create.mockImplementation(async ({ data }: any) => row(data));
});

describe('POST /admin/announcements legalDoc', () => {
  it.each(['privacy', 'terms', 'cookies'])('stores and returns %s', async (legalDoc) => {
    const res = await request(app).post('/api/v1/admin/announcements').set(auth()).send({ ...BASE, legalDoc });
    expect(res.status).toBe(201);
    expect(prismaMock.announcement.create.mock.calls[0][0].data.legalDoc).toBe(legalDoc);
    expect(res.body.data.legalDoc).toBe(legalDoc);
  });

  it.each([[null], [''], [undefined]])('stores null for %j', async (legalDoc) => {
    const res = await request(app).post('/api/v1/admin/announcements').set(auth()).send({ ...BASE, legalDoc });
    expect(res.status).toBe(201);
    expect(prismaMock.announcement.create.mock.calls[0][0].data.legalDoc).toBeNull();
    expect(res.body.data.legalDoc).toBeNull();
  });

  it('stores null when the field is absent', async () => {
    const res = await request(app).post('/api/v1/admin/announcements').set(auth()).send(BASE);
    expect(res.status).toBe(201);
    expect(prismaMock.announcement.create.mock.calls[0][0].data.legalDoc).toBeNull();
  });

  it.each([['imprint'], ['Privacy'], [7], [{ a: 1 }], [['privacy']], [true], [0]])('refuses %j and writes nothing', async (legalDoc) => {
    const res = await request(app).post('/api/v1/admin/announcements').set(auth()).send({ ...BASE, legalDoc, publish: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/legalDoc must be one of: privacy, terms, cookies/);
    expect(prismaMock.announcement.create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(broadcast.emit).not.toHaveBeenCalled();
  });

  it('puts it in the audit row of a draft', async () => {
    await request(app).post('/api/v1/admin/announcements').set(auth()).send({ ...BASE, legalDoc: 'terms' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'announcement.create',
      metadata: expect.objectContaining({ legalDoc: 'terms' }),
    }));
  });

  it('audits a missing document as null', async () => {
    await request(app).post('/api/v1/admin/announcements').set(auth()).send(BASE);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'announcement.create',
      metadata: expect.objectContaining({ legalDoc: null }),
    }));
  });

  it('carries it in the announcement:new payload and the publish audit row', async () => {
    await request(app).post('/api/v1/admin/announcements').set(auth()).send({ ...BASE, legalDoc: 'cookies', publish: true });
    expect(broadcast.emit).toHaveBeenCalledWith('announcement:new', expect.objectContaining({ legalDoc: 'cookies' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'announcement.publish',
      metadata: expect.objectContaining({ legalDoc: 'cookies' }),
    }));
  });
});

describe('GET /admin/announcements legalDoc', () => {
  it('lists the document, and null for a row without one or with an unknown stored value', async () => {
    prismaMock.announcement.findMany.mockResolvedValue([
      row({ ...BASE, legalDoc: 'privacy' }),
      row({ ...BASE, legalDoc: null }),
      row({ ...BASE, legalDoc: 'bogus' }),
    ]);
    prismaMock.announcement.count.mockResolvedValue(3);
    const res = await request(app).get('/api/v1/admin/announcements').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: any) => a.legalDoc)).toEqual(['privacy', null, null]);
  });
});
