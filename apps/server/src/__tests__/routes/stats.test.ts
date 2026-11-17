import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { prismaMock, redisMock, redisAccess } = vi.hoisted(() => ({
  prismaMock: {
    user: { count: vi.fn() },
    server: { count: vi.fn() },
    message: { count: vi.fn() },
  },
  redisMock: { get: vi.fn(), set: vi.fn() },
  redisAccess: { throws: false },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../utils/redis', () => ({
  getRedis: () => {
    if (redisAccess.throws) throw new Error('Redis not initialised');
    return redisMock;
  },
}));

const { limiterSpy } = vi.hoisted(() => ({
  limiterSpy: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../middleware/rateLimiter', () => ({ rateLimitStats: limiterSpy }));

import { errorHandler } from '../../middleware/errorHandler';

// The route keeps a per-process copy of the totals, so each test gets a fresh module
let router: express.Router;
async function createApp() {
  vi.resetModules();
  const { statsRouter } = await import('../../routes/stats');
  router = statsRouter;
  const app = express();
  app.use('/api/v1/stats', statsRouter);
  app.use(errorHandler);
  return app;
}

// Runs the router's handler without HTTP: the answer it would send
function callStats(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, body }); return this; },
    };
    router.handle({ method: 'GET', url: '/', headers: {} } as any, res as any, (err?: unknown) => reject(err ?? new Error('not handled')));
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Stats route', () => {
  let app: express.Express;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    limiterSpy.mockImplementation((_req, _res, next) => next());
    redisAccess.throws = false;
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
    prismaMock.user.count.mockResolvedValue(12);
    prismaMock.server.count.mockResolvedValue(3);
    prismaMock.message.count.mockResolvedValue(456);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await createApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
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

    it('counts once for a burst of requests that all find the cache empty', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      prismaMock.user.count.mockImplementation(async () => { await gate; return 12; });

      const burst = Promise.all(Array.from({ length: 10 }, () => request(app).get('/api/v1/stats')));
      // every request has read the empty cache and waits on the one count
      await vi.waitFor(() => expect(redisMock.get).toHaveBeenCalledTimes(10));
      release();
      const responses = await burst;

      expect(responses.every((r) => r.status === 200 && r.body.data.users === 12)).toBe(true);
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

  // Rule: the Redis cache fails open, bounded per node: an unusable cache never turns the public
  // route into a 500 and never turns a burst into a burst of database counts.
  describe('when the Redis cache is unusable', () => {
    const redisError = () => Object.assign(new Error('connect ECONNREFUSED redis://user:secret@10.0.0.5:6379'), { code: 'ECONNREFUSED' });

    it('counts from the database and answers 200 when Redis cannot be read', async () => {
      redisMock.get.mockRejectedValue(redisError());
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { users: 12, servers: 3, messages: 456 } });
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
      // a cache that cannot be read is not written either
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('warns with the error name and code only: never its message, which can carry the connection string', async () => {
      redisMock.get.mockRejectedValue(redisError());
      await request(app).get('/api/v1/stats');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = String(warnSpy.mock.calls[0][0]);
      expect(logged).toContain('read');
      expect(logged).toContain('Error');
      expect(logged).toContain('ECONNREFUSED');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('secret');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('10.0.0.5');
    });

    it('runs the three counts once for a burst of 20 concurrent requests during an outage', async () => {
      redisMock.get.mockRejectedValue(redisError());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      prismaMock.user.count.mockImplementation(async () => { await gate; return 12; });

      const burst = Promise.all(Array.from({ length: 20 }, () => request(app).get('/api/v1/stats')));
      // let every request reach the route and queue on the one count, then let it finish
      await vi.waitFor(() => expect(redisMock.get).toHaveBeenCalledTimes(20));
      release();
      const responses = await burst;

      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(responses.every((r) => r.body.data.users === 12 && r.body.data.messages === 456)).toBe(true);
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
      expect(prismaMock.server.count).toHaveBeenCalledTimes(1);
      expect(prismaMock.message.count).toHaveBeenCalledTimes(1);
      // one warning for the burst, not one per request
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('serves the in-process copy while it is younger than 60 seconds, then counts once more', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      redisMock.get.mockRejectedValue(redisError());

      await request(app).get('/api/v1/stats');
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
      prismaMock.user.count.mockResolvedValue(99);
      const young = await request(app).get('/api/v1/stats');
      expect(young.body.data.users).toBe(12);
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      const expired = await request(app).get('/api/v1/stats');
      expect(expired.body.data.users).toBe(99);
      expect(prismaMock.user.count).toHaveBeenCalledTimes(2);

      // the new copy is served in turn
      prismaMock.user.count.mockResolvedValue(7);
      vi.setSystemTime(new Date('2026-01-01T00:01:30Z'));
      expect((await request(app).get('/api/v1/stats')).body.data.users).toBe(99);
      expect(prismaMock.user.count).toHaveBeenCalledTimes(2);
    });

    it('warns at most once a minute per kind of failure', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      redisMock.get.mockRejectedValue(redisError());
      await request(app).get('/api/v1/stats');
      await request(app).get('/api/v1/stats');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      await request(app).get('/api/v1/stats');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('treats a cached value that is not valid JSON as unusable: answers 200 from the database and warns', async () => {
      redisMock.get.mockResolvedValue('{not json');
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ users: 12, servers: 3, messages: 456 });
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('corrupt');
      expect(String(warnSpy.mock.calls[0][0])).not.toContain('{not json');
    });

    it.each([
      ['JSON null', 'null'],
      ['an array', '[1,2,3]'],
      ['missing fields', '{"users":1}'],
      ['a field that is not a number', '{"users":"1","servers":2,"messages":3}'],
    ])('treats a cached value that is %s as unusable', async (_label, value) => {
      redisMock.get.mockResolvedValue(value);
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ users: 12, servers: 3, messages: 456 });
      expect(String(warnSpy.mock.calls[0][0])).toContain('corrupt');
    });

    it('serves the in-process copy for a corrupt cached value after an earlier count', async () => {
      await request(app).get('/api/v1/stats'); // a normal miss: counts and keeps the copy
      redisMock.get.mockResolvedValue('{not json');
      prismaMock.user.count.mockResolvedValue(99);
      const res = await request(app).get('/api/v1/stats');
      expect(res.body.data.users).toBe(12);
      expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
    });

    // The Redis client queues commands while it is disconnected: a command then hangs, it does not
    // reject. These run the route handler directly (no HTTP), so fake timers cannot stall a socket.
    describe('when a Redis command never settles', () => {
      const neverSettles = () => new Promise<never>(() => {});
      const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

      it('gives up on a read after one second, counts and answers 200 with one read warning', async () => {
        fakeTimers();
        redisMock.get.mockReturnValue(neverSettles());

        const pending = callStats();
        await vi.advanceTimersByTimeAsync(999);
        expect(prismaMock.user.count).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const res = await pending;

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ users: 12, servers: 3, messages: 456 });
        expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
        expect(redisMock.set).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const logged = String(warnSpy.mock.calls[0][0]);
        expect(logged).toContain('read');
        expect(logged).toContain('TimeoutError');
        expect(vi.getTimerCount()).toBe(0);
      });

      it('serves the in-process copy after the read times out, without another count', async () => {
        fakeTimers();
        redisMock.get.mockReturnValue(neverSettles());

        const first = callStats();
        await vi.advanceTimersByTimeAsync(1000);
        await first;
        prismaMock.user.count.mockResolvedValue(99);
        const second = callStats();
        await vi.advanceTimersByTimeAsync(1000);
        const res = await second;

        expect(res.status).toBe(200);
        expect(res.body.data.users).toBe(12);
        expect(prismaMock.user.count).toHaveBeenCalledTimes(1);
      });

      it('does not delay the answer beyond one second for a write that never settles, and logs one write warning', async () => {
        fakeTimers();
        redisMock.set.mockReturnValue(neverSettles());

        const pending = callStats();
        await vi.advanceTimersByTimeAsync(1000);
        const res = await pending;

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ users: 12, servers: 3, messages: 456 });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('write');
        expect(String(warnSpy.mock.calls[0][0])).toContain('TimeoutError');
        expect(vi.getTimerCount()).toBe(0);
      });

      it('does not turn a late rejection of an abandoned command into an unhandled rejection', async () => {
        fakeTimers();
        let rejectLate!: (err: Error) => void;
        redisMock.get.mockReturnValue(new Promise((_resolve, reject) => { rejectLate = reject; }));
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
          const pending = callStats();
          await vi.advanceTimersByTimeAsync(1000);
          await pending;
          rejectLate(new Error('connection closed'));
          await vi.advanceTimersByTimeAsync(10);
          expect(unhandled).not.toHaveBeenCalled();
        } finally {
          process.off('unhandledRejection', unhandled);
        }
      });
    });

    it('leaves no timer pending after a normal request', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const res = await callStats();
      expect(res.status).toBe(200);
      expect(redisMock.set).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('takes the same fallback when getRedis itself throws', async () => {
      redisAccess.throws = true;
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ users: 12, servers: 3, messages: 456 });
      expect(String(warnSpy.mock.calls[0][0])).toContain('read');
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('answers 200 and warns when the cache write fails', async () => {
      redisMock.set.mockRejectedValue(redisError());
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ users: 12, servers: 3, messages: 456 });
      expect(String(warnSpy.mock.calls[0][0])).toContain('write');
    });

    it.each([
      ['user', () => prismaMock.user.count],
      ['server', () => prismaMock.server.count],
      ['message', () => prismaMock.message.count],
    ])('still answers 500 when the %s count fails (Redis healthy), and caches nothing', async (_name, count) => {
      count().mockRejectedValue(new Error('db down'));
      const res = await request(app).get('/api/v1/stats');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('still answers 500 when the database fails during a Redis outage, and the next request counts again', async () => {
      redisMock.get.mockRejectedValue(redisError());
      prismaMock.user.count.mockRejectedValueOnce(new Error('db down'));
      const failed = await request(app).get('/api/v1/stats');
      expect(failed.status).toBe(500);

      const retried = await request(app).get('/api/v1/stats');
      expect(retried.status).toBe(200);
      expect(prismaMock.user.count).toHaveBeenCalledTimes(2);
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
