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
  stickerPack: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    delete: vi.fn(),
  },
  sticker: {
    findUnique: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
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
  deleteMultipleFromS3: vi.fn().mockResolvedValue(undefined),
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

describe('Sticker Routes', () => {
  const token = makeToken();
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true });
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1' });
    prismaMock.stickerPack.count.mockResolvedValue(0);
    prismaMock.sticker.count.mockResolvedValue(0);
    mockHasServerPermission.mockResolvedValue(true);
    app = buildApp();
  });

  describe('GET /api/v1/servers/:serverId/sticker-packs', () => {
    it('should list server sticker packs', async () => {
      prismaMock.stickerPack.findMany.mockResolvedValue([
        { id: 'p1', name: 'Pack 1', description: '', serverId: 'srv-1', userId: null, createdAt: new Date(), updatedAt: new Date(), stickers: [] },
      ]);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/sticker-packs')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('should reject non-members', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/sticker-packs')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/servers/:serverId/sticker-packs', () => {
    it('should create a sticker pack', async () => {
      prismaMock.stickerPack.create.mockResolvedValue({
        id: 'p1', name: 'My Pack', description: '', serverId: 'srv-1', userId: null,
        createdAt: new Date(), updatedAt: new Date(), stickers: [],
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/sticker-packs')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Pack' });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('My Pack');
    });

    it('should enforce pack limit', async () => {
      prismaMock.stickerPack.count.mockResolvedValue(5);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/sticker-packs')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Extra Pack' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Maximum');
    });

    it('should reject without permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/sticker-packs')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Pack' });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/servers/:serverId/sticker-packs/:packId', () => {
    it('should delete a sticker pack', async () => {
      prismaMock.stickerPack.findUnique.mockResolvedValue({
        id: 'p1', serverId: 'srv-1', stickers: [{ s3Key: 'stickers/pack-p1/s1.webp' }],
      });
      prismaMock.stickerPack.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/sticker-packs/p1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('should reject deleting pack from wrong server', async () => {
      prismaMock.stickerPack.findUnique.mockResolvedValue({ id: 'p1', serverId: 'other-srv', stickers: [] });

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/sticker-packs/p1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/servers/:serverId/sticker-packs/:packId/stickers', () => {
    it('should add a sticker to a pack', async () => {
      prismaMock.stickerPack.findUnique.mockResolvedValue({ id: 'p1', serverId: 'srv-1' });
      prismaMock.sticker.findUnique.mockResolvedValue(null);
      prismaMock.sticker.create.mockResolvedValue({
        id: 's1', packId: 'p1', name: 'wave', s3Key: 'stickers/pack-p1/s1.webp', createdAt: new Date(),
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/sticker-packs/p1/stickers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'wave', s3Key: 'stickers/pack-p1/s1.webp' });

      expect(res.status).toBe(201);
    });

    it('should enforce sticker limit per pack', async () => {
      prismaMock.stickerPack.findUnique.mockResolvedValue({ id: 'p1', serverId: 'srv-1' });
      prismaMock.sticker.count.mockResolvedValue(30);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/sticker-packs/p1/stickers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'overflow', s3Key: 'stickers/pack-p1/s2.webp' });

      expect(res.status).toBe(400);
    });
  });

  describe('Personal sticker packs', () => {
    it('GET /stickers/personal should list user packs', async () => {
      prismaMock.stickerPack.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/v1/stickers/personal')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('POST /stickers/personal should create personal pack', async () => {
      prismaMock.stickerPack.create.mockResolvedValue({
        id: 'pp1', name: 'My Stickers', description: '', serverId: null, userId: 'user-1',
        createdAt: new Date(), updatedAt: new Date(), stickers: [],
      });

      const res = await request(app)
        .post('/api/v1/stickers/personal')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Stickers' });

      expect(res.status).toBe(201);
    });

    it('POST /stickers/personal should enforce personal pack limit', async () => {
      prismaMock.stickerPack.count.mockResolvedValue(3);

      const res = await request(app)
        .post('/api/v1/stickers/personal')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Too Many' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/stickers/:stickerId', () => {
    it('should resolve a sticker by ID', async () => {
      prismaMock.sticker.findUnique.mockResolvedValue({
        id: 's1', packId: 'p1', name: 'wave', s3Key: 'stickers/pack-p1/s1.webp', createdAt: new Date(),
        pack: { serverId: 'srv-1', userId: null },
      });

      const res = await request(app)
        .get('/api/v1/stickers/s1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });
});
