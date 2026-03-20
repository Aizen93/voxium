import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'superadmin-1', username: 'superadmin', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn(),
  },
  server: { count: vi.fn().mockResolvedValue(0) },
  message: { count: vi.fn().mockResolvedValue(0) },
  report: { count: vi.fn().mockResolvedValue(0) },
  supportTicket: { count: vi.fn().mockResolvedValue(0) },
  conversation: { count: vi.fn().mockResolvedValue(0) },
  friendship: { count: vi.fn().mockResolvedValue(0) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  infraServer: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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
  return {
    rateLimitAdmin: passthrough,
  };
});

// Redis
vi.mock('../../utils/redis', () => ({
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

// Voice handler
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0, transports: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockReturnValue({}),
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
  getEffectiveLimits: vi.fn().mockResolvedValue({
    maxChannelsPerServer: 20,
    maxVoiceUsersPerChannel: 12,
    maxCategoriesPerServer: 12,
    maxMembersPerServer: 0,
  }),
}));

// Sanitize
vi.mock('../../utils/sanitize', () => ({
  sanitizeText: vi.fn((s: string) => s),
}));

// Member broadcast
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: vi.fn().mockResolvedValue(undefined),
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

function mockSuperAdminUser() {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id === 'superadmin-1') {
      return Promise.resolve({
        id: 'superadmin-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'superadmin',
        emailVerified: true,
      });
    }
    return Promise.resolve(null);
  });
}

const sampleInfraServer = {
  id: 'infra-1',
  name: 'EU-West-1',
  country: 'France',
  city: 'Paris',
  provider: 'OVH',
  latitude: 48.86,
  longitude: 2.35,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Admin Infrastructure Server Routes', () => {
  let app: express.Express;
  const token = makeToken();

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSuperAdminUser();
  });

  // ── GET /admin/infra-servers ─────────────────────────────────────────

  describe('GET /admin/infra-servers', () => {
    it('returns all infrastructure servers', async () => {
      prismaMock.infraServer.findMany.mockResolvedValue([sampleInfraServer]);

      const res = await request(app)
        .get('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('EU-West-1');
      expect(prismaMock.infraServer.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'asc' } });
    });

    it('returns empty array when no servers exist', async () => {
      prismaMock.infraServer.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── POST /admin/infra-servers ────────────────────────────────────────

  describe('POST /admin/infra-servers', () => {
    it('creates an infrastructure server with valid data', async () => {
      prismaMock.infraServer.create.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'EU-West-1', country: 'France', city: 'Paris', provider: 'OVH', latitude: 48.86, longitude: 2.35 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('EU-West-1');
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ country: 'France', city: 'Paris', provider: 'OVH', latitude: 48.86, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    it('rejects missing country', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'EU-West-1', city: 'Paris', provider: 'OVH', latitude: 48.86, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/country/i);
    });

    it('rejects missing city', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'EU-West-1', country: 'France', provider: 'OVH', latitude: 48.86, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/city/i);
    });

    it('rejects missing provider', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'EU-West-1', country: 'France', city: 'Paris', latitude: 48.86, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/provider/i);
    });

    it('rejects invalid latitude (out of range)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test', country: 'France', city: 'Paris', provider: 'OVH', latitude: 91, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/latitude/i);
    });

    it('rejects invalid latitude (negative out of range)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test', country: 'France', city: 'Paris', provider: 'OVH', latitude: -91, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/latitude/i);
    });

    it('rejects invalid longitude (out of range)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test', country: 'France', city: 'Paris', provider: 'OVH', latitude: 48.86, longitude: 181 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/longitude/i);
    });

    it('rejects non-string name', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 123, country: 'France', city: 'Paris', provider: 'OVH', latitude: 48.86, longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    it('rejects non-number latitude', async () => {
      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test', country: 'France', city: 'Paris', provider: 'OVH', latitude: 'abc', longitude: 2.35 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/latitude/i);
    });

    it('accepts boundary latitude values', async () => {
      prismaMock.infraServer.create.mockResolvedValue({ ...sampleInfraServer, latitude: 90, longitude: 180 });

      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Boundary', country: 'Test', city: 'Test', provider: 'AWS', latitude: 90, longitude: 180 });

      expect(res.status).toBe(201);
    });

    it('accepts negative boundary values', async () => {
      prismaMock.infraServer.create.mockResolvedValue({ ...sampleInfraServer, latitude: -90, longitude: -180 });

      const res = await request(app)
        .post('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'South Pole', country: 'Test', city: 'Test', provider: 'AWS', latitude: -90, longitude: -180 });

      expect(res.status).toBe(201);
    });
  });

  // ── PATCH /admin/infra-servers/:id ───────────────────────────────────

  describe('PATCH /admin/infra-servers/:id', () => {
    it('updates an infrastructure server', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);
      prismaMock.infraServer.update.mockResolvedValue({ ...sampleInfraServer, name: 'EU-West-2' });

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'EU-West-2' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('EU-West-2');
    });

    it('returns 404 for non-existent server', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/nonexistent')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });

    it('rejects empty update', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no fields/i);
    });

    it('rejects invalid latitude in update', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: 100 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/latitude/i);
    });

    it('rejects invalid longitude in update', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ longitude: 200 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/longitude/i);
    });

    it('rejects non-string name in update', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name must be a string/i);
    });

    it('rejects non-string country in update', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ country: 42 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/country must be a string/i);
    });

    it('updates multiple fields at once', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);
      const updated = { ...sampleInfraServer, city: 'Lyon', latitude: 45.76 };
      prismaMock.infraServer.update.mockResolvedValue(updated);

      const res = await request(app)
        .patch('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ city: 'Lyon', latitude: 45.76 });

      expect(res.status).toBe(200);
      expect(res.body.data.city).toBe('Lyon');
      expect(res.body.data.latitude).toBe(45.76);
    });
  });

  // ── DELETE /admin/infra-servers/:id ──────────────────────────────────

  describe('DELETE /admin/infra-servers/:id', () => {
    it('deletes an infrastructure server', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(sampleInfraServer);
      prismaMock.infraServer.delete.mockResolvedValue(sampleInfraServer);

      const res = await request(app)
        .delete('/api/v1/admin/infra-servers/infra-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/deleted/i);
      expect(prismaMock.infraServer.delete).toHaveBeenCalledWith({ where: { id: 'infra-1' } });
    });

    it('returns 404 for non-existent server', async () => {
      prismaMock.infraServer.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/admin/infra-servers/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  // ── Auth checks ──────────────────────────────────────────────────────

  describe('Auth checks', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .get('/api/v1/admin/infra-servers');

      expect(res.status).toBe(401);
    });

    it('rejects non-admin users', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const userToken = makeToken({ userId: 'user-1', username: 'regular' });
      const res = await request(app)
        .get('/api/v1/admin/infra-servers')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });
  });
});
