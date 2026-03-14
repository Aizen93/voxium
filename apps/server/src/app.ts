import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { authRouter } from './routes/auth';
import { serverRouter } from './routes/servers';
import { channelRouter } from './routes/channels';
import { messageRouter } from './routes/messages';
import { userRouter } from './routes/users';
import { inviteRouter } from './routes/invites';
import { uploadRouter } from './routes/uploads';
import { dmRouter } from './routes/dm';
import { friendRouter } from './routes/friends';
import { categoryRouter } from './routes/categories';
import { searchRouter } from './routes/search';
import { reportsRouter } from './routes/reports';
import { statsRouter } from './routes/stats';
import { adminRouter } from './routes/admin';
import { supportRouter } from './routes/support';
import { errorHandler } from './middleware/errorHandler';
import { rateLimitGeneral } from './middleware/rateLimiter';

export const app = express();

// Enable trust proxy so req.ip reflects the real client IP behind reverse proxies
// Only trust proxy headers in production where a reverse proxy is expected
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:8080')
  .split(',')
  .map((o) => o.trim());

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', ...allowedOrigins],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'", ...allowedOrigins],
    },
  },
}));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
const logFormat = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'dev');
if (logFormat === 'json') {
  morgan.token('body-size', (_req, res) => res.getHeader('content-length') as string || '0');
  app.use(morgan((tokens, req, res) => JSON.stringify({
    ts: new Date().toISOString(),
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: Number(tokens.status(req, res)),
    ms: Number(tokens['response-time'](req, res)),
    bytes: Number(tokens['body-size'](req, res)) || 0,
    ip: req.ip,
  })));
} else {
  app.use(morgan('dev'));
}
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  let healthy = true;

  // Check PostgreSQL
  const dbStart = Date.now();
  try {
    const { prisma } = await import('./utils/prisma');
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', latency: Date.now() - dbStart };
  } catch (err: unknown) {
    const msg = process.env.NODE_ENV === 'production' ? 'connection failed' : (err instanceof Error ? err.message : String(err));
    checks.database = { status: 'error', latency: Date.now() - dbStart, error: msg };
    healthy = false;
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    const { getRedis } = await import('./utils/redis');
    const redis = getRedis();
    await redis.ping();
    checks.redis = { status: 'ok', latency: Date.now() - redisStart };
  } catch (err: unknown) {
    const msg = process.env.NODE_ENV === 'production' ? 'connection failed' : (err instanceof Error ? err.message : String(err));
    checks.redis = { status: 'error', latency: Date.now() - redisStart, error: msg };
    healthy = false;
  }

  const statusCode = healthy ? 200 : 503;
  res.status(statusCode).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks,
  });
});

// ─── Public Feature Flags (unauthenticated, for landing page) ────────────────

app.get('/api/v1/feature-flags/public', rateLimitGeneral, async (_req, res) => {
  const { isFeatureEnabled } = await import('./utils/featureFlags');
  const PUBLIC_FLAGS = ['community_funding', 'registration'] as const;
  const flags: Record<string, boolean> = {};
  for (const name of PUBLIC_FLAGS) {
    flags[name] = isFeatureEnabled(name);
  }
  res.json({ success: true, data: flags });
});

// ─── API Routes ──────────────────────────────────────────────────────────────

const api = express.Router();
api.use(rateLimitGeneral);
api.use('/auth', authRouter);
api.use('/users', userRouter);
api.use('/servers', serverRouter);
api.use('/servers/:serverId/channels', channelRouter);
api.use('/servers/:serverId/categories', categoryRouter);
api.use('/channels/:channelId/messages', messageRouter);
api.use('/invites', inviteRouter);
api.use('/uploads', uploadRouter);
api.use('/dm', dmRouter);
api.use('/friends', friendRouter);
api.use('/search', searchRouter);
api.use('/reports', reportsRouter);
api.use('/stats', statsRouter);
api.use('/admin', adminRouter);
api.use('/support', supportRouter);

app.use('/api/v1', api);

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use(errorHandler);
