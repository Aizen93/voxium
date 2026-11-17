import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { prismaMock, redisMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { count: vi.fn() },
    server: { count: vi.fn() },
    message: { count: vi.fn() },
  },
  redisMock: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../utils/redis', () => ({ getRedis: () => redisMock }));

const { limiterSpy } = vi.hoisted(() => ({
  limiterSpy: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../middleware/rateLimiter', () => ({ rateLimitStats: limiterSpy }));

import { statsRouter } from '../../routes/stats';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use('/api/v1/stats', statsRouter);
  app.use(errorHandler);
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Stats route', () => {
  let app: express.Express;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    limiterSpy.mockImplementation((_req, _res, next) => next());
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
    prismaMock.user.count.mockResolvedValue(12);
    prismaMock.server.count.mockResolvedValue(3);
    prismaMock.message.count.mockResolvedValue(456);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = createApp();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // Rule: platform totals are public (no sign-in) and have exactly the shape the landing page reads.
  describe('GET /stats', () => {
    it('answers the three totals without any authentication', async () => {
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { users: 12, servers: 3, messages: 456 } });
    });

    it('counts users, spaces and messages in the database on a cache miss', async () => {
      await request(app).get('/api/v1/stats');
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
      expect(prismaMock.server.count).toHaveBeenCalledTimes(1);
      expect(prismaMock.message.count).toHaveBeenCalledTimes(1);
    });
  });

  // Rule: the totals are cached for a minute, so a busy landing page does not count tables on every hit.
  describe('caching', () => {
    it('stores the fresh totals under platform:stats with a 60-second expiry', async () => {
      await request(app).get('/api/v1/stats');
      expect(redisMock.get).toHaveBeenCalledWith('platform:stats');
      expect(redisMock.set).toHaveBeenCalledWith('platform:stats', JSON.stringify({ users: 12, servers: 3, messages: 456 }), { EX: 60 });
    });

    it('serves a cached value without touching the database or rewriting the cache', async () => {
      redisMock.get.mockResolvedValue(JSON.stringify({ users: 1, servers: 2, messages: 3 }));
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { users: 1, servers: 2, messages: 3 } });
      expect(prismaMock.user.count).not.toHaveBeenCalled();
      expect(prismaMock.server.count).not.toHaveBeenCalled();
      expect(prismaMock.message.count).not.toHaveBeenCalled();
      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  // Rule: the route is rate limited before it reads anything.
  describe('rate limiting', () => {
    it('runs behind the stats rate limiter', async () => {
      await request(app).get('/api/v1/stats');
      expect(limiterSpy).toHaveBeenCalledTimes(1);
    });

    it('answers what the limiter answers and reads nothing when it refuses', async () => {
      limiterSpy.mockImplementation((_req, res: any) => { res.status(429).json({ success: false }); });
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(429);
      expect(redisMock.get).not.toHaveBeenCalled();
      expect(prismaMock.user.count).not.toHaveBeenCalled();
    });
  });

  // Rule: a failing dependency is a 500 the error handler logs, never a partial or wrong answer.
  describe('failing dependencies', () => {
    it('answers 500 when Redis cannot be read', async () => {
      redisMock.get.mockRejectedValue(new Error('redis down'));
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it.each([
      ['user', prismaMock.user.count],
      ['server', prismaMock.server.count],
      ['message', prismaMock.message.count],
    ])('answers 500 when the %s count fails, and caches nothing', async (_name, count) => {
      count.mockRejectedValue(new Error('db down'));
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(500);
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('answers 500 when the cache write fails', async () => {
      redisMock.set.mockRejectedValue(new Error('redis down'));
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(500);
    });

    it('answers 500 when the cached value is not valid JSON', async () => {
      redisMock.get.mockResolvedValue('{not json');
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(500);
    });
  });

  // Rule: only GET exists on this router.
  describe('other methods', () => {
    it.each(['post', 'put', 'delete', 'patch'] as const)('%s /stats is not a route', async (method) => {
      const res = await request(app)[method]('/api/v1/stats');
      expect(res.status).toBe(404);
      expect(prismaMock.user.count).not.toHaveBeenCalled();
    });
  });
});
