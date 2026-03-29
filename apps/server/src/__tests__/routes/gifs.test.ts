import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Environment variables (must be set before any app import) ───────────────

const JWT_SECRET = 'test-jwt-secret-for-unit-tests';
process.env.JWT_SECRET = JWT_SECRET;

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'user-1', username: 'testuser', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: vi.fn().mockResolvedValue(true),
  hasChannelPermission: vi.fn().mockResolvedValue(true),
}));

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn().mockResolvedValue({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true }) },
  ipBan: { findUnique: vi.fn().mockResolvedValue(null) },
  gifUpload: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock('../../utils/prisma', () => ({ prisma: new Proxy({}, { get: (_t, p) => prismaMock[p as string] }) }));
vi.mock('../../utils/redis', () => ({ getRedis: vi.fn().mockReturnValue({ hGetAll: vi.fn().mockResolvedValue({}) }) }));
vi.mock('../../websocket/socketServer', () => ({ getIO: vi.fn().mockReturnValue({ to: vi.fn().mockReturnValue({ emit: vi.fn() }) }) }));
vi.mock('../../utils/s3', () => ({
  generatePresignedPutUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload'),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
  VALID_S3_KEY_RE: /^((avatars|server-icons)\/[\w-]+\.webp|(emojis\/srv-[\w-]+|stickers\/pack-[\w-]+|gifs\/usr-[\w-]+)\/[\w-]+\.(webp|png|gif))$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
}));

const mockIsFeatureEnabled = vi.fn().mockReturnValue(false);
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  loadFeatureFlags: vi.fn().mockResolvedValue(undefined),
  getAllFeatureFlags: vi.fn().mockReturnValue([]),
}));

import { app as realApp } from '../../app';

function buildApp() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/', realApp);
  return testApp;
}

describe('GIF Routes', () => {
  const token = makeToken();
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true });
    prismaMock.gifUpload.count.mockResolvedValue(0);
    prismaMock.gifUpload.findMany.mockResolvedValue([]);
    mockIsFeatureEnabled.mockReturnValue(false);
    app = buildApp();
  });

  // ─── Giphy Proxy ──────────────────────────────────────────────────────────

  describe('GET /api/v1/gifs/giphy/search', () => {
    it('should return 404 when gif_giphy is disabled', async () => {
      const res = await request(app)
        .get('/api/v1/gifs/giphy/search?q=hello')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not enabled');
    });

    it('should return 503 when enabled but no API key', async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      const originalKey = process.env.GIPHY_API_KEY;
      delete process.env.GIPHY_API_KEY;

      const res = await request(app)
        .get('/api/v1/gifs/giphy/search?q=hello')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(503);
      if (originalKey) process.env.GIPHY_API_KEY = originalKey;
    });

    it('should reject empty search query', async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      process.env.GIPHY_API_KEY = 'test-key';

      const res = await request(app)
        .get('/api/v1/gifs/giphy/search?q=')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      delete process.env.GIPHY_API_KEY;
    });

    it('should require authentication', async () => {
      const res = await request(app).get('/api/v1/gifs/giphy/search?q=hello');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/gifs/giphy/trending', () => {
    it('should return 404 when gif_giphy is disabled', async () => {
      const res = await request(app)
        .get('/api/v1/gifs/giphy/trending')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  // ─── Self-Hosted Library ──────────────────────────────────────────────────

  describe('GET /api/v1/gifs/library', () => {
    it('should return library GIFs', async () => {
      prismaMock.gifUpload.findMany.mockResolvedValue([
        { id: 'g1', s3Key: 'gifs/usr-user-1/abc.gif', fileName: 'funny.gif', fileSize: 1000, tags: ['funny'], uploaderId: 'user-1', createdAt: new Date() },
      ]);
      prismaMock.gifUpload.count.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/v1/gifs/library')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.gifs).toHaveLength(1);
      expect(res.body.data.total).toBe(1);
    });
  });

  describe('GET /api/v1/gifs/my', () => {
    it('should return user own GIFs', async () => {
      prismaMock.gifUpload.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/v1/gifs/my')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /api/v1/gifs', () => {
    it('should create a GIF upload', async () => {
      prismaMock.gifUpload.create.mockResolvedValue({
        id: 'g1', s3Key: 'gifs/usr-user-1/abc.gif', fileName: 'funny', fileSize: 5000,
        tags: ['funny'], uploaderId: 'user-1', createdAt: new Date(),
      });

      const res = await request(app)
        .post('/api/v1/gifs')
        .set('Authorization', `Bearer ${token}`)
        .send({ s3Key: 'gifs/usr-user-1/abc.gif', fileName: 'funny.gif', fileSize: 5000, tags: ['funny'] });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('g1');
    });

    it('should reject wrong s3Key prefix', async () => {
      const res = await request(app)
        .post('/api/v1/gifs')
        .set('Authorization', `Bearer ${token}`)
        .send({ s3Key: 'gifs/usr-OTHER/abc.gif', fileName: 'funny.gif', fileSize: 5000 });

      expect(res.status).toBe(400);
    });

    it('should enforce per-user limit', async () => {
      prismaMock.gifUpload.count.mockResolvedValue(50);

      const res = await request(app)
        .post('/api/v1/gifs')
        .set('Authorization', `Bearer ${token}`)
        .send({ s3Key: 'gifs/usr-user-1/abc.gif', fileName: 'funny.gif', fileSize: 5000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Maximum');
    });
  });

  describe('DELETE /api/v1/gifs/:gifId', () => {
    it('should delete own GIF', async () => {
      prismaMock.gifUpload.findUnique.mockResolvedValue({ id: 'g1', uploaderId: 'user-1', s3Key: 'gifs/usr-user-1/abc.gif' });
      prismaMock.gifUpload.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/gifs/g1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('should reject deleting other user GIF', async () => {
      prismaMock.gifUpload.findUnique.mockResolvedValue({ id: 'g1', uploaderId: 'other-user', s3Key: 'gifs/usr-other/abc.gif' });

      const res = await request(app)
        .delete('/api/v1/gifs/g1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/uploads/presign/gif', () => {
    it('should return presigned URL for GIF upload', async () => {
      const res = await request(app)
        .post('/api/v1/uploads/presign/gif')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'test.gif', fileSize: 500000, mimeType: 'image/gif' });

      expect(res.status).toBe(200);
      expect(res.body.data.key).toMatch(/^gifs\/usr-user-1\//);
    });

    it('should reject non-GIF MIME types', async () => {
      const res = await request(app)
        .post('/api/v1/uploads/presign/gif')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'test.png', fileSize: 500000, mimeType: 'image/png' });

      expect(res.status).toBe(400);
    });
  });
});
