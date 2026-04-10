import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Environment ────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'user-1', username: 'testuser', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockHasServerPermission = vi.fn().mockResolvedValue(true);
const mockHasChannelPermission = vi.fn().mockResolvedValue(true);

vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
  hasChannelPermission: (...args: unknown[]) => mockHasChannelPermission(...args),
  filterVisibleChannels: vi.fn().mockImplementation((_u: unknown, _s: unknown, ch: unknown[]) => Promise.resolve(ch)),
}));

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  channel: { findUnique: vi.fn() },
  channelDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  ipBan: { findUnique: vi.fn().mockResolvedValue(null) },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_t, p) { return prismaMock[p as string]; },
  }),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: mockTo })),
}));

vi.mock('../../websocket/collabHandler', () => ({
  collabDocs: new Map(),
  canvasSnapshots: new Map(),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitCategoryManage: passthrough,
    rateLimitCollabDoc: passthrough,
    rateLimitMarkRead: passthrough,
    socketRateLimit: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue({ hGetAll: vi.fn().mockResolvedValue({}) }),
}));

// ─── App ────────────────────────────────────────────────────────────────────

import { collabRouter } from '../../routes/collab';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels/:channelId/document', collabRouter);
  app.use(errorHandler);
  return app;
}

function mockAuthUser(overrides: Record<string, unknown> = {}) {
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'user-1',
    bannedAt: null,
    tokenVersion: 0,
    role: 'user',
    emailVerified: true,
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Collab Document Routes', () => {
  let app: express.Express;
  const token = makeToken();

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAuthUser();
    mockHasServerPermission.mockResolvedValue(true);
    mockHasChannelPermission.mockResolvedValue(true);
  });

  // ── GET /channels/:channelId/document ──────────────────────────────────

  describe('GET /api/v1/channels/:channelId/document', () => {
    it('returns document info for a canvas channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-canvas', type: 'canvas', serverId: 'srv-1',
      });
      prismaMock.channelDocument.findUnique.mockResolvedValue({
        channelId: 'ch-canvas',
        language: null,
        updatedAt: new Date('2026-03-29T12:00:00Z'),
      });

      const res = await request(app)
        .get('/api/v1/channels/ch-canvas/document')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.channelId).toBe('ch-canvas');
      expect(res.body.data.language).toBeNull();
    });

    it('returns document info for a code channel with language', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-code', type: 'code', serverId: 'srv-1',
      });
      prismaMock.channelDocument.findUnique.mockResolvedValue({
        channelId: 'ch-code',
        language: 'typescript',
        updatedAt: new Date('2026-03-29T12:00:00Z'),
      });

      const res = await request(app)
        .get('/api/v1/channels/ch-code/document')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.language).toBe('typescript');
    });

    it('returns 404 for non-existent channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/channels/ch-missing/document')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 400 for a text channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-text', type: 'text', serverId: 'srv-1',
      });

      const res = await request(app)
        .get('/api/v1/channels/ch-text/document')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not a collaborative channel');
    });

    it('returns 403 when user lacks VIEW_CHANNEL', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-canvas', type: 'canvas', serverId: 'srv-1',
      });
      mockHasChannelPermission.mockResolvedValue(false);

      const res = await request(app)
        .get('/api/v1/channels/ch-canvas/document')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/channels/ch-canvas/document');
      expect(res.status).toBe(401);
    });
  });

  // ── PUT /channels/:channelId/document/language ────────────────────────

  describe('PUT /api/v1/channels/:channelId/document/language', () => {
    it('updates language for a code channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-code', type: 'code', serverId: 'srv-1',
      });
      prismaMock.channelDocument.update.mockResolvedValue({
        channelId: 'ch-code', language: 'rust',
      });

      const res = await request(app)
        .put('/api/v1/channels/ch-code/document/language')
        .set('Authorization', `Bearer ${token}`)
        .send({ language: 'rust' });

      expect(res.status).toBe(200);
      expect(res.body.data.language).toBe('rust');
      expect(mockTo).toHaveBeenCalledWith('collab:ch-code');
      expect(mockEmit).toHaveBeenCalledWith('collab:language_changed', { channelId: 'ch-code', language: 'rust' });
    });

    it('rejects invalid language', async () => {
      const res = await request(app)
        .put('/api/v1/channels/ch-code/document/language')
        .set('Authorization', `Bearer ${token}`)
        .send({ language: 'brainfuck' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Language must be one of');
    });

    it('rejects canvas channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-canvas', type: 'canvas', serverId: 'srv-1',
      });

      const res = await request(app)
        .put('/api/v1/channels/ch-canvas/document/language')
        .set('Authorization', `Bearer ${token}`)
        .send({ language: 'typescript' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Only code channels');
    });

    it('rejects without MANAGE_CHANNELS permission', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-code', type: 'code', serverId: 'srv-1',
      });
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .put('/api/v1/channels/ch-code/document/language')
        .set('Authorization', `Bearer ${token}`)
        .send({ language: 'java' });

      expect(res.status).toBe(403);
    });
  });

  // ── POST /channels/:channelId/document/reset ──────────────────────────

  describe('POST /api/v1/channels/:channelId/document/reset', () => {
    it('resets a collaborative document', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-canvas', type: 'canvas', serverId: 'srv-1',
      });
      prismaMock.channelDocument.update.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/channels/ch-canvas/document/reset')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Document reset');
      expect(prismaMock.channelDocument.update).toHaveBeenCalledWith({
        where: { channelId: 'ch-canvas' },
        data: { snapshot: null },
      });
      // Should broadcast empty state
      expect(mockTo).toHaveBeenCalledWith('collab:ch-canvas');
      expect(mockEmit).toHaveBeenCalledWith('collab:sync', expect.objectContaining({ channelId: 'ch-canvas' }));
    });

    it('rejects text channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-text', type: 'text', serverId: 'srv-1',
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-text/document/reset')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('rejects without MANAGE_CHANNELS permission', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-canvas', type: 'canvas', serverId: 'srv-1',
      });
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/channels/ch-canvas/document/reset')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });
});
