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

const mockHasServerPermission = vi.fn().mockResolvedValue(true);
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
  hasChannelPermission: vi.fn().mockResolvedValue(true),
}));

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn().mockResolvedValue({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true }) },
  serverMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1', serverId: 'srv-1' }) },
  customEmoji: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  ipBan: { findUnique: vi.fn().mockResolvedValue(null) },
};

vi.mock('../../utils/prisma', () => ({ prisma: new Proxy({}, { get: (_t, p) => prismaMock[p as string] }) }));
vi.mock('../../utils/redis', () => ({ getRedis: vi.fn().mockReturnValue({ hGetAll: vi.fn().mockResolvedValue({}) }) }));
vi.mock('../../websocket/socketServer', () => ({ getIO: vi.fn().mockReturnValue({ to: vi.fn().mockReturnValue({ emit: vi.fn() }) }) }));
vi.mock('../../utils/s3', () => ({
  generatePresignedPutUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload'),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
  VALID_S3_KEY_RE: /^((avatars|server-icons)\/[\w-]+\.webp|(emojis\/srv-[\w-]+|stickers\/pack-[\w-]+)\/[\w-]+\.(webp|png|gif))$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
}));

import { app as realApp } from '../../app';

function buildApp() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/', realApp);
  return testApp;
}

describe('Custom Emoji Routes', () => {
  const token = makeToken();
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true });
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1' });
    prismaMock.customEmoji.count.mockResolvedValue(0);
    prismaMock.customEmoji.findMany.mockResolvedValue([]);
    prismaMock.customEmoji.findUnique.mockResolvedValue(null);
    mockHasServerPermission.mockResolvedValue(true);
    app = buildApp();
  });

  describe('GET /api/v1/servers/:serverId/emojis', () => {
    it('should return custom emojis for a server', async () => {
      const emojis = [
        { id: 'e1', serverId: 'srv-1', name: 'pepe', s3Key: 'emojis/srv-srv-1/e1.webp', animated: false, creatorId: 'user-1', createdAt: new Date() },
      ];
      prismaMock.customEmoji.findMany.mockResolvedValue(emojis);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it('should reject non-members', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/servers/:serverId/emojis', () => {
    it('should create a custom emoji', async () => {
      const created = { id: 'e1', serverId: 'srv-1', name: 'test_emoji', s3Key: 'emojis/srv-srv-1/abc.webp', animated: false, creatorId: 'user-1', createdAt: new Date() };
      prismaMock.customEmoji.create.mockResolvedValue(created);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test_emoji', s3Key: 'emojis/srv-srv-1/abc.webp', animated: false });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('should reject invalid emoji names', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'invalid name!', s3Key: 'emojis/srv-srv-1/abc.webp' });

      expect(res.status).toBe(400);
    });

    it('should reject when at emoji limit', async () => {
      prismaMock.customEmoji.count.mockResolvedValue(50);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test', s3Key: 'emojis/srv-srv-1/abc.webp' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Maximum');
    });

    it('should reject without MANAGE_EMOJIS permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test', s3Key: 'emojis/srv-srv-1/abc.webp' });

      expect(res.status).toBe(403);
    });

    it('should reject duplicate names (P2002 unique constraint)', async () => {
      const p2002Error = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      prismaMock.customEmoji.create.mockRejectedValue(p2002Error);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test', s3Key: 'emojis/srv-srv-1/abc.webp' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already exists');
    });

    it('should reject invalid s3Key prefix', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/emojis')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test', s3Key: 'emojis/srv-WRONG/abc.webp' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid s3Key');
    });
  });

  describe('DELETE /api/v1/servers/:serverId/emojis/:emojiId', () => {
    it('should delete a custom emoji', async () => {
      prismaMock.customEmoji.findUnique.mockResolvedValue({ id: 'e1', serverId: 'srv-1', s3Key: 'emojis/srv-srv-1/e1.webp' });
      prismaMock.customEmoji.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/emojis/e1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('should reject deleting emoji from wrong server', async () => {
      prismaMock.customEmoji.findUnique.mockResolvedValue({ id: 'e1', serverId: 'other-srv' });

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/emojis/e1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('should reject without permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/emojis/e1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/emojis/:emojiId', () => {
    it('should resolve an emoji by ID', async () => {
      prismaMock.customEmoji.findUnique.mockResolvedValue({
        id: 'e1', serverId: 'srv-1', name: 'pepe', s3Key: 'emojis/srv-srv-1/e1.webp', animated: false, creatorId: 'user-1', createdAt: new Date(),
      });

      const res = await request(app)
        .get('/api/v1/emojis/e1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('pepe');
    });

    it('should return 404 for unknown emoji', async () => {
      prismaMock.customEmoji.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/emojis/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/uploads/presign/emoji/:serverId', () => {
    it('should return a presigned URL for emoji upload', async () => {
      const res = await request(app)
        .post('/api/v1/uploads/presign/emoji/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'pepe.png', fileSize: 50000, mimeType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.data.uploadUrl).toBeDefined();
      expect(res.body.data.key).toMatch(/^emojis\/srv-srv-1\//);
    });

    it('should reject invalid MIME types', async () => {
      const res = await request(app)
        .post('/api/v1/uploads/presign/emoji/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'test.pdf', fileSize: 50000, mimeType: 'application/pdf' });

      expect(res.status).toBe(400);
    });

    it('should reject files exceeding max size', async () => {
      const res = await request(app)
        .post('/api/v1/uploads/presign/emoji/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'big.png', fileSize: 500000, mimeType: 'image/png' });

      expect(res.status).toBe(400);
    });
  });
});
