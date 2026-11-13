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
    aggregate: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
  // The space row lock the create takes in its transaction
  $queryRaw: vi.fn(),
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
    emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  };
  prismaMock.user.findUnique.mockResolvedValue({ ...defaults, ...overrides });
}

/** The space's category count and highest position (default: positions 0..count-1), read under the space row lock. */
function categoryStats(count: number, highest: number | null = count > 0 ? count - 1 : null) {
  prismaMock.category.aggregate.mockResolvedValue({ _count: { _all: count }, _max: { position: highest } });
}

/** Set while a `$transaction` callback runs, so a mock can tell where it was called. */
let inTransaction = false;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Category Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAuthUser();
    mockHasServerPermission.mockResolvedValue(true);
    // An interactive transaction runs its callback on the same mocks; an
    // array one (the reorder) awaits its statements
    inTransaction = false;
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      inTransaction = true;
      try {
        return await arg(new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }));
      } finally {
        inTransaction = false;
      }
    });
    // The space row lock finds the space
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'srv-1' }]);
  });

  // ── POST /api/v1/servers/:serverId/categories ──────────────────────────

  describe('POST /api/v1/servers/:serverId/categories', () => {
    it('creates a category', async () => {
      const token = makeToken();
      categoryStats(2);
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

    it('gives the transaction the long budget: the space row it waits for is held through an account deletion\'s cascade', async () => {
      const token = makeToken();
      categoryStats(2);
      prismaMock.category.create.mockResolvedValue({ id: 'cat-1', name: 'Text Channels', serverId: 'srv-1', position: 2 });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Text Channels' });

      expect(res.status).toBe(201);
      // Under Prisma's 5 s default the wait alone expired the creation (P2028, a 500)
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
    });

    it('emits category:created socket event', async () => {
      const token = makeToken();
      categoryStats(0);
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
      categoryStats(12); // at the default limit

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Overflow Category' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('respects custom lower category limit', async () => {
      const token = makeToken();
      categoryStats(3);
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
      categoryStats(0);
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

    // ── The limit and the position, under the space row lock ─────────────

    it('locks the space row, then counts and places, then inserts, all inside ONE transaction', async () => {
      const order: string[] = [];
      const where = () => (inTransaction ? 'tx' : 'outside');
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        order.push(`lock:${where()}`);
        expect(strings.join('?')).toBe('SELECT id FROM servers WHERE id = ? FOR UPDATE');
        expect(values).toEqual(['srv-1']);
        return [{ id: 'srv-1' }];
      });
      prismaMock.category.aggregate.mockImplementation(async () => {
        order.push(`count:${where()}`);
        return { _count: { _all: 2 }, _max: { position: 1 } };
      });
      prismaMock.category.create.mockImplementation(async ({ data }: any) => {
        order.push(`create:${where()}`);
        return { id: 'cat-new', ...data };
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Voice' });

      expect(res.status).toBe(201);
      expect(order).toEqual(['lock:tx', 'count:tx', 'create:tx']);
      // one read: the count and the highest position
      expect(prismaMock.category.aggregate).toHaveBeenCalledWith({
        where: { serverId: 'srv-1' },
        _count: { _all: true },
        _max: { position: true },
      });
      expect(prismaMock.category.count).not.toHaveBeenCalled();
    });

    it('places the category after the highest position, not after the count, and at 0 in a space without one', async () => {
      categoryStats(2, 7);
      prismaMock.category.create.mockImplementation(async ({ data }: any) => ({ id: 'cat-new', ...data }));
      let res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Voice' });
      expect(res.status).toBe(201);
      expect(prismaMock.category.create).toHaveBeenLastCalledWith({ data: { name: 'Voice', serverId: 'srv-1', position: 8 } });

      categoryStats(0);
      res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Text' });
      expect(res.status).toBe(201);
      expect(prismaMock.category.create).toHaveBeenLastCalledWith({ data: { name: 'Text', serverId: 'srv-1', position: 0 } });
    });

    it('a limit of 0 freezes category creation', async () => {
      categoryStats(0);
      (getEffectiveLimits as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 0, maxMembersPerServer: 0,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Voice' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 0 categories');
      expect(prismaMock.category.create).not.toHaveBeenCalled();
    });

    it('404 Server when the space was deleted since the permission check, creating and announcing nothing', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/categories')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Voice' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Server not found');
      expect(prismaMock.category.aggregate).not.toHaveBeenCalled();
      expect(prismaMock.category.create).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('a creation PostgreSQL aborted to break a deadlock is run again and succeeds', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
        })
        .mockImplementation(real);
      categoryStats(1);
      prismaMock.category.create.mockImplementation(async ({ data }: any) => ({ id: 'cat-new', ...data }));
      try {
        const res = await request(app)
          .post('/api/v1/servers/srv-1/categories')
          .set('Authorization', `Bearer ${makeToken()}`)
          .send({ name: 'Voice' });

        expect(res.status).toBe(201);
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(prismaMock.category.create).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
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

    // A creation places the new category after the highest position in the
    // space, so a reorder must not write one near the column's ceiling, and a
    // malformed entry is a 400, not a 500 from the database
    it.each([
      ['a negative position', [{ id: 'cat-1', position: -1 }]],
      ['a fractional position', [{ id: 'cat-1', position: 0.5 }]],
      ['a position past the bound', [{ id: 'cat-1', position: 1_000_001 }]],
      ['a position given as a string', [{ id: 'cat-1', position: '0' }]],
      ['no position', [{ id: 'cat-1' }]],
      ['a numeric id', [{ id: 1, position: 0 }]],
      ['an entry that is not an object', ['cat-1']],
    ])('returns 400 for %s, before any read or write', async (_label, order) => {
      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ order });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Each order entry needs a category id and a whole-number position from 0 to 1000000');
      expect(prismaMock.category.findMany).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('accepts 0 and the bound itself', async () => {
      prismaMock.category.findMany
        .mockResolvedValueOnce([{ id: 'cat-1' }, { id: 'cat-2' }])
        .mockResolvedValueOnce([]);
      prismaMock.$transaction.mockResolvedValue([]);

      const res = await request(app)
        .put('/api/v1/servers/srv-1/categories/reorder')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ order: [{ id: 'cat-1', position: 0 }, { id: 'cat-2', position: 1_000_000 }] });

      expect(res.status).toBe(200);
    });
  });
});
