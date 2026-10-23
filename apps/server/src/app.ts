import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
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
import { roleRouter } from './routes/roles';
import { secureChannelRouter } from './routes/secureChannels';
import { themeRouter } from './routes/themes';
import { e2eRouter } from './routes/e2e';
import { discoveryRouter } from './routes/discovery';
import { webhookExecuteRouter } from './routes/webhookExecute';
import { webhookRouter } from './routes/webhooks';
import { errorHandler } from './middleware/errorHandler';
import { rateLimitGeneral } from './middleware/rateLimiter';
import { trustsProxy, trustedProxyHops } from './utils/trustProxy';
import { redactUrl } from './utils/redactUrl';

export const app = express();

// Enable trust proxy lazily (env vars not available at module scope due to import hoisting)
let _trustProxySet = false;
app.use((req, _res, next) => {
  if (!_trustProxySet) {
    _trustProxySet = true;
    if (trustsProxy()) {
      req.app.set('trust proxy', trustedProxyHops());
    }
  }
  next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────

// Lazy getter: env vars may not be loaded yet at module scope (ES import hoisting)
let _allowedOrigins: string[] | null = null;
function getAllowedOrigins(): string[] {
  if (!_allowedOrigins) {
    _allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:8080')
      .split(',')
      .map((o) => o.trim());
  }
  return _allowedOrigins;
}

app.use((req, res, next) => {
  // Defer helmet to request time so env vars are available
  const origins = getAllowedOrigins();
  const isProd = process.env.NODE_ENV === 'production';
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', ...origins],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        connectSrc: ["'self'", ...origins],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Only upgrade HTTP→HTTPS in production (breaks local HTTP dev)
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS pinned to 1 year in production (helmet's default is ~180 days);
    // disabled outside production so plain-HTTP localhost dev never caches
    // the policy. nginx must set the same header for static-file responses
    // that never reach Express (DEPLOYMENT.md §12).
    strictTransportSecurity: isProd
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
  })(req, res, next);
});

app.use(cors({
  origin: (origin, callback) => {
    const origins = getAllowedOrigins();
    if (!origin || origins.includes(origin)) {
      // Echo the exact origin back (required when credentials: true).
      // For same-origin/non-browser requests (origin === undefined), reflect
      // the first allowed origin instead of `true` (which becomes "*" and is
      // forbidden with credentials).
      callback(null, origin || origins[0]);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  maxAge: 86400, // Cache preflight responses for 24 hours
}));

// X-Request-ID for log correlation — must be BEFORE morgan so the ID is available for logging
app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
});

// Deferred: morgan handler resolved at first request, not at module scope.
// We create the morgan middleware lazily and invoke it inline (not via app.use())
// so it stays at the correct position in the middleware stack.
let _morganHandler: express.RequestHandler | null = null;
function getMorganHandler(): express.RequestHandler {
  if (!_morganHandler) {
    const fmt = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'dev');
    // Every format prints the redacted URL (the 'dev' format too: LOG_FORMAT
    // can select it in production, and a token on a terminal is still a token)
    morgan.token<express.Request, express.Response>('url', (rq) => redactUrl(rq.originalUrl || rq.url));
    if (fmt === 'json') {
      morgan.token('body-size', (_rq, rs) => rs.getHeader('content-length') as string || '0');
      // Credentials in a URL stay out of durable access logs (utils/redactUrl.ts):
      // invite codes (single-use bearer credentials) and incoming-webhook tokens
      // (/api/v1/webhooks/:id/[redacted] — a bearer credential in a URL, like an
      // invite code). Tokens/reset codes in POST bodies never reach morgan.
      _morganHandler = morgan((tokens, rq, rs) => JSON.stringify({
        ts: new Date().toISOString(),
        rid: rq.id,
        method: tokens.method(rq, rs),
        url: redactUrl(tokens.url(rq, rs)),
        status: Number(tokens.status(rq, rs)),
        ms: Number(tokens['response-time'](rq, rs)),
        bytes: Number(tokens['body-size'](rq, rs)) || 0,
        ip: rq.ip,
      }));
    } else {
      _morganHandler = morgan('dev');
    }
  }
  return _morganHandler;
}
app.use((req, res, next) => {
  getMorganHandler()(req, res, next);
});

app.use(compression());
// Incoming-webhook execute route (public, token in the URL). Mounted HERE, on
// purpose: after morgan (logged, token redacted) and compression; BEFORE the
// global 100 KB parser below, because it has its own 1 MB parser (GitHub push
// payloads routinely exceed 100 KB); and OUTSIDE the api router, so not under
// its per-IP rateLimitGeneral (GitHub's deliveries to every server share a
// few egress addresses) — it brings its own per-IP and per-webhook limiters.
app.use('/api/v1/webhooks', webhookExecuteRouter);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ─── Health Check ────────────────────────────────────────────────────────────

// readyFlag is set once the server has fully started (set from index.ts after listen())
let _serverReady = false;
export function markServerReady() { _serverReady = true; }

app.get('/health', async (_req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  let healthy = true;

  // Check PostgreSQL
  const dbStart = Date.now();
  try {
    const { prisma } = await import('./utils/prisma');
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', ...(isProd ? {} : { latency: Date.now() - dbStart }) };
  } catch (err: unknown) {
    const msg = isProd ? 'connection failed' : (err instanceof Error ? err.message : String(err));
    checks.database = { status: 'error', error: msg };
    healthy = false;
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    const { getRedis } = await import('./utils/redis');
    const redis = getRedis();
    await redis.ping();
    checks.redis = { status: 'ok', ...(isProd ? {} : { latency: Date.now() - redisStart }) };
  } catch (err: unknown) {
    const msg = isProd ? 'connection failed' : (err instanceof Error ? err.message : String(err));
    checks.redis = { status: 'error', error: msg };
    healthy = false;
  }

  const statusCode = healthy ? 200 : 503;
  res.status(statusCode).json({
    status: healthy ? 'ok' : 'degraded',
    ...(isProd ? {} : { timestamp: new Date().toISOString(), uptime: Math.floor(process.uptime()) }),
    checks,
  });
});

// Readiness probe — returns 503 until server is fully initialized
app.get('/ready', (_req, res) => {
  res.status(_serverReady ? 200 : 503).json({ ready: _serverReady });
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
api.use('/servers/:serverId/secure-channels', secureChannelRouter);
api.use('/servers/:serverId/categories', categoryRouter);
api.use('/servers/:serverId/roles', roleRouter);
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
api.use('/themes', themeRouter);
api.use('/e2e', e2eRouter);
api.use('/discovery', discoveryRouter);
// Incoming-webhook MANAGEMENT (authenticated, MANAGE_WEBHOOKS); the public
// execute endpoint is mounted above, outside this router.
api.use('/servers/:serverId/webhooks', webhookRouter);

app.use('/api/v1', api);

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use(errorHandler);
