import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { getRedis } from '../utils/redis';
import { rateLimitStats } from '../middleware/rateLimiter';

export const statsRouter = Router();

const CACHE_KEY = 'platform:stats';
const CACHE_TTL = 60; // seconds

statsRouter.get('/', rateLimitStats, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const redis = getRedis();

    // Try cache first
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      res.json({ success: true, data: JSON.parse(cached) });
      return;
    }

    // Cache miss — query DB
    const [users, servers, messages] = await Promise.all([
      prisma.user.count(),
      prisma.server.count(),
      prisma.message.count(),
    ]);

    const data = { users, servers, messages };

    // Store in cache
    await redis.set(CACHE_KEY, JSON.stringify(data), { EX: CACHE_TTL });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
