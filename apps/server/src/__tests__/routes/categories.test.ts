import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'user-1', username: 'testuser', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Permission calculator — mock before any route imports
const mockHasServerPermission = vi.fn().mockResolvedValue(true);

vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
  Permissions: {
    MANAGE_CATEGORIES: 1n << 2n,
    MANAGE_CHANNELS: 1n << 1n,
    MANAGE_SERVER: 1n << 3n,
  },
  hasPermission: vi.fn().mockReturnValue(true),
}));

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
  },
  category: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
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
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitCategoryManage: passthrough,
  };
});

// Server limits
vi.mock('../../utils/serverLimits', () => ({
  getEffectiveLimits: vi.fn().mockResolvedValue({
    maxChannelsPerServer: 20,
    maxVoiceUsersPerChannel: 12,
    maxCategoriesPerServer: 12,
    maxMembersPerServer: 0,
  }),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { categoryRouter } from '../../routes/categories';
import { errorHandler } from '../../middleware/errorHandler';
import { getEffectiveLimits } from '../../utils/serverLimits';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers/:serverId/categories', categoryRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockAuthUser(overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: 'user-1',
    bannedAt: null,
    tokenVersion: 0,
    role: 'user',
    emailVerified: true,
  };
  prismaMock.user.findUnique.mockResolvedValue({ ...defaults, ...overrides });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Category Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAuthUser();
    mockHasServerPermission.mockResolvedValue(true);
  });

  // ── POST /api/v1/servers/:serverId/categories ──────────────────────────

  describe('POST /api/v1/servers/:serverId/categories', () => {
    it('creates a category', async () => {
      const token = makeToken();
      prismaMock.category.count.mockResolvedValue(2);
      prismaMock.category.create.mockResolvedValue({
        id: 'cat-1',
        name: 'Text Channels',
        serverId: 'srv-1',
        position: 2,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Text Channels' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Text Channels');
      expect(res.body.data.serverId).toBe('srv-1');
    });

    it('emits category:created socket event', async () => {
      const token = makeToken();
      prismaMock.category.count.mockResolvedValue(0);
      const createdCategory = {
        id: 'cat-1',
        name: 'Text Channels',
        serverId: 'srv-1',
        position: 0,
      };
      prismaMock.category.create.mockResolvedValue(createdCategory);

      await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Text Channels' });

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('category:created', createdCategory);
    });

    it('returns 403 without MANAGE_CATEGORIES permission', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Text Channels' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 400 with empty category name', async () => {
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '' });

      expect(res.status).toBe(400);
    });

    it('returns 400 with missing name', async () => {
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 when category name exceeds max length', async () => {
      const token = makeToken();
      const longName = 'a'.repeat(101);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: longName });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('respects maxCategoriesPerServer limit', async () => {
      const token = makeToken();
      prismaMock.category.count.mockResolvedValue(12); // at the default limit

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Overflow Category' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('respects custom lower category limit', async () => {
      const token = makeToken();
      prismaMock.category.count.mockResolvedValue(3);
      (getEffectiveLimits as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        maxChannelsPerServer: 20,
        maxVoiceUsersPerChannel: 12,
        maxCategoriesPerServer: 3, // custom lower limit
        maxMembersPerServer: 0,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Overflow' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most 3');
    });

    it('sanitizes HTML from category name', async () => {
      const token = makeToken();
      prismaMock.category.count.mockResolvedValue(0);
      prismaMock.category.create.mockResolvedValue({
        id: 'cat-1',
        name: 'Clean Name',
        serverId: 'srv-1',
        position: 0,
      });

      await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '<script>Clean Name</script>' });

      const createCall = prismaMock.category.create.mock.calls[0]?.[0];
      expect(createCall?.data?.name).toBe('Clean Name');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .send({ name: 'Text Channels' });

      expect(res.status).toBe(401);
    });

    it('returns 403 when email is not verified', async () => {
      const token = makeToken();
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: false,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Text Channels' });

      expect(res.status).toBe(403);
    });
  });

  // ── PATCH /api/v1/servers/:serverId/categories/:categoryId ─────────────

  describe('PATCH /api/v1/servers/:serverId/categories/:categoryId', () => {
    it('renames a category', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Old Name',
        serverId: 'srv-1',
        position: 0,
      });
      prismaMock.category.update.mockResolvedValue({
        id: 'cat-1',
        name: 'New Name',
        serverId: 'srv-1',
        position: 0,
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('New Name');
    });

    it('emits category:updated socket event', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Old Name',
        serverId: 'srv-1',
        position: 0,
      });
      const updatedCategory = {
        id: 'cat-1',
        name: 'Renamed',
        serverId: 'srv-1',
        position: 0,
      };
      prismaMock.category.update.mockResolvedValue(updatedCategory);

      await request(app)
        .patch('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed' });

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('category:updated', updatedCategory);
    });

    it('returns 403 without MANAGE_CATEGORIES permission', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(403);
    });

    it('returns 404 when category does not exist', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/categories/cat-nonexistent')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 400 with empty name', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Old Name',
        serverId: 'srv-1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when name exceeds max length', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Old Name',
        serverId: 'srv-1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'a'.repeat(101) });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });
  });

  // ── DELETE /api/v1/servers/:serverId/categories/:categoryId ────────────

  describe('DELETE /api/v1/servers/:serverId/categories/:categoryId', () => {
    it('deletes a category', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Text Channels',
        serverId: 'srv-1',
        position: 0,
      });
      prismaMock.channel.findMany
        .mockResolvedValueOnce([]) // affected channels before delete
        .mockResolvedValueOnce([]); // orphaned channels after delete (won't be called if no affected)
      prismaMock.category.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('deleted');
    });

    it('emits category:deleted socket event', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Text Channels',
        serverId: 'srv-1',
        position: 0,
      });
      prismaMock.channel.findMany.mockResolvedValue([]);
      prismaMock.category.delete.mockResolvedValue({});

      await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`);

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('category:deleted', {
        categoryId: 'cat-1',
        serverId: 'srv-1',
      });
    });

    it('emits channel:updated for orphaned channels', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Text Channels',
        serverId: 'srv-1',
        position: 0,
      });
      // Channels in the category before delete
      prismaMock.channel.findMany
        .mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }])
        // Re-read orphaned channels after delete
        .mockResolvedValueOnce([
          { id: 'ch-1', name: 'general', categoryId: null, serverId: 'srv-1' },
          { id: 'ch-2', name: 'random', categoryId: null, serverId: 'srv-1' },
        ]);
      prismaMock.category.delete.mockResolvedValue({});

      await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`);

      // category:deleted + 2 x channel:updated
      expect(mockEmit).toHaveBeenCalledWith('category:deleted', {
        categoryId: 'cat-1',
        serverId: 'srv-1',
      });
      expect(mockEmit).toHaveBeenCalledWith('channel:updated', expect.objectContaining({
        id: 'ch-1',
        categoryId: null,
      }));
      expect(mockEmit).toHaveBeenCalledWith('channel:updated', expect.objectContaining({
        id: 'ch-2',
        categoryId: null,
      }));
    });

    it('returns 403 without MANAGE_CATEGORIES permission', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 404 when category does not exist', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 404 when category belongs to a different server', async () => {
      const token = makeToken();
      // findFirst with { id, serverId } returns null because serverId doesn't match
      prismaMock.category.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-from-srv-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .delete('/api/v1/servers/srv-1/categories/cat-1');

      expect(res.status).toBe(401);
    });
  });

  // ── PUT /api/v1/servers/:serverId/categories/reorder ───────────────────

  describe('PUT /api/v1/servers/:serverId/categories/reorder', () => {
    it('reorders categories', async () => {
      const token = makeToken();

      prismaMock.category.findMany
        // Validation: check IDs belong to server
        .mockResolvedValueOnce([{ id: 'cat-1' }, { id: 'cat-2' }])
        // Re-read updated categories
        .mockResolvedValueOnce([
          { id: 'cat-1', name: 'First', position: 1, serverId: 'srv-1' },
          { id: 'cat-2', name: 'Second', position: 0, serverId: 'srv-1' },
        ]);

      prismaMock.$transaction.mockResolvedValue([{}, {}]);

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({
          order: [
            { id: 'cat-2', position: 0 },
            { id: 'cat-1', position: 1 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('emits category:updated for each reordered category', async () => {
      const token = makeToken();

      prismaMock.category.findMany
        .mockResolvedValueOnce([{ id: 'cat-1' }, { id: 'cat-2' }])
        .mockResolvedValueOnce([
          { id: 'cat-1', name: 'First', position: 1, serverId: 'srv-1' },
          { id: 'cat-2', name: 'Second', position: 0, serverId: 'srv-1' },
        ]);

      prismaMock.$transaction.mockResolvedValue([{}, {}]);

      await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({
          order: [
            { id: 'cat-2', position: 0 },
            { id: 'cat-1', position: 1 },
          ],
        });

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledTimes(2);
      expect(mockEmit).toHaveBeenCalledWith('category:updated', expect.objectContaining({ id: 'cat-1' }));
      expect(mockEmit).toHaveBeenCalledWith('category:updated', expect.objectContaining({ id: 'cat-2' }));
    });

    it('returns 403 without MANAGE_CATEGORIES permission', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({
          order: [{ id: 'cat-1', position: 0 }],
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 400 when order is not an array', async () => {
      const token = makeToken();

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({ order: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('non-empty array');
    });

    it('returns 400 when order is an empty array', async () => {
      const token = makeToken();

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({ order: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('non-empty array');
    });

    it('returns 400 when order is missing', async () => {
      const token = makeToken();

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('non-empty array');
    });

    it('returns 400 when category IDs do not belong to server', async () => {
      const token = makeToken();

      // Only 1 of 2 IDs found in this server
      prismaMock.category.findMany.mockResolvedValueOnce([{ id: 'cat-1' }]);

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({
          order: [
            { id: 'cat-1', position: 0 },
            { id: 'cat-from-other-server', position: 1 },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('do not belong');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .send({ order: [{ id: 'cat-1', position: 0 }] });

      expect(res.status).toBe(401);
    });
  });
});
