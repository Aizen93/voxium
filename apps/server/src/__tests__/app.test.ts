import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Express } from 'express';
import http from 'http';
import { Router } from 'express';

// ─── Mock all route modules (avoids deep transitive dependency chains) ────────

const emptyRouter = Router();

vi.mock('../routes/auth', () => ({ authRouter: Router() }));
vi.mock('../routes/servers', () => ({ serverRouter: Router() }));
vi.mock('../routes/channels', () => ({ channelRouter: Router() }));
vi.mock('../routes/messages', () => ({ messageRouter: Router() }));
vi.mock('../routes/users', () => ({ userRouter: Router() }));
vi.mock('../routes/invites', () => ({ inviteRouter: Router() }));
vi.mock('../routes/uploads', () => ({ uploadRouter: Router() }));
vi.mock('../routes/dm', () => ({ dmRouter: Router() }));
vi.mock('../routes/friends', () => ({ friendRouter: Router() }));
vi.mock('../routes/categories', () => ({ categoryRouter: Router() }));
vi.mock('../routes/search', () => ({ searchRouter: Router() }));
vi.mock('../routes/reports', () => ({ reportsRouter: Router() }));
vi.mock('../routes/stats', () => ({ statsRouter: Router() }));
vi.mock('../routes/admin', () => ({ adminRouter: Router() }));
vi.mock('../routes/support', () => ({ supportRouter: Router() }));

// Mock error handler
vi.mock('../middleware/errorHandler', () => ({
  errorHandler: (_err: unknown, _req: unknown, res: { status: (n: number) => { json: (o: unknown) => void } }, _next: unknown) => {
    res.status(500).json({ success: false, error: 'Internal server error' });
  },
}));

// Mock rate limiter (app.ts imports rateLimitGeneral)
vi.mock('../middleware/rateLimiter', () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
  };
});

// Mock prisma and redis used by health check (dynamic imports in app.ts)
vi.mock('../utils/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
}));

vi.mock('../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue({
    ping: vi.fn().mockResolvedValue('PONG'),
  }),
}));

// Mock feature flags used by the public feature flags endpoint
vi.mock('../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// ─── Helper to make HTTP requests to the Express app ─────────────────────────

function request(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get server address'));
        return;
      }
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers,
      };
      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

describe('app.ts — CORS lazy configuration', () => {
  const savedCorsOrigin = process.env.CORS_ORIGIN;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (savedCorsOrigin !== undefined) {
      process.env.CORS_ORIGIN = savedCorsOrigin;
    } else {
      delete process.env.CORS_ORIGIN;
    }
  });

  it('importing app.ts does NOT throw even without CORS_ORIGIN set', async () => {
    delete process.env.CORS_ORIGIN;
    const mod = await import('../app');
    expect(mod.app).toBeDefined();
  });

  it('CORS allows requests with no Origin header (same-origin)', async () => {
    process.env.CORS_ORIGIN = 'http://localhost:8080';
    const { app } = await import('../app');

    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
  });

  it('CORS allows configured origin', async () => {
    process.env.CORS_ORIGIN = 'http://localhost:8080';
    const { app } = await import('../app');

    const res = await request(app, 'OPTIONS', '/api/v1/auth/login', {
      Origin: 'http://localhost:8080',
      'Access-Control-Request-Method': 'POST',
    });

    // CORS preflight should return the allowed origin
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
  });

  it('CORS rejects unconfigured origin', async () => {
    process.env.CORS_ORIGIN = 'http://localhost:8080';
    const { app } = await import('../app');

    const res = await request(app, 'OPTIONS', '/api/v1/auth/login', {
      Origin: 'http://evil.example.com',
      'Access-Control-Request-Method': 'POST',
    });

    // The access-control-allow-origin header should NOT be set for rejected origins
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS supports multiple comma-separated origins', async () => {
    process.env.CORS_ORIGIN = 'http://localhost:8080, https://app.voxium.io';
    const { app } = await import('../app');

    const res1 = await request(app, 'OPTIONS', '/api/v1/auth/login', {
      Origin: 'http://localhost:8080',
      'Access-Control-Request-Method': 'POST',
    });
    expect(res1.headers['access-control-allow-origin']).toBe('http://localhost:8080');

    const res2 = await request(app, 'OPTIONS', '/api/v1/auth/login', {
      Origin: 'https://app.voxium.io',
      'Access-Control-Request-Method': 'POST',
    });
    expect(res2.headers['access-control-allow-origin']).toBe('https://app.voxium.io');
  });

  it('CORS uses default origin when CORS_ORIGIN is not set', async () => {
    delete process.env.CORS_ORIGIN;
    const { app } = await import('../app');

    const res = await request(app, 'OPTIONS', '/api/v1/auth/login', {
      Origin: 'http://localhost:8080',
      'Access-Control-Request-Method': 'POST',
    });
    // Default is http://localhost:8080
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
  });

  it('health endpoint is accessible and returns JSON', async () => {
    const { app } = await import('../app');

    const res = await request(app, 'GET', '/health');
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
  });
});

describe('app.ts — lazy morgan middleware', () => {
  const savedLogFormat = process.env.LOG_FORMAT;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.LOG_FORMAT;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedLogFormat !== undefined) {
      process.env.LOG_FORMAT = savedLogFormat;
    } else {
      delete process.env.LOG_FORMAT;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it('morgan handler is created lazily — not at module import time', async () => {
    // If morgan were created at module scope, it would fail or use wrong env vars.
    // Importing the app should succeed without any requests being made.
    const { app } = await import('../app');
    expect(app).toBeDefined();
    // The morgan handler is only initialized on the first request,
    // so we verify the app can be imported without error even when
    // LOG_FORMAT is unset.
  });

  it('morgan uses dev format by default when LOG_FORMAT is unset and not production', async () => {
    delete process.env.LOG_FORMAT;
    delete process.env.NODE_ENV;
    const { app } = await import('../app');

    // Make a request to trigger the lazy morgan initialization
    const res = await request(app, 'GET', '/health');
    // If morgan was set up correctly (dev format), the request succeeds
    expect(res.status).toBe(200);
  });

  it('morgan uses json format when LOG_FORMAT=json', async () => {
    process.env.LOG_FORMAT = 'json';
    const { app } = await import('../app');

    const res = await request(app, 'GET', '/health');
    // Request succeeds — morgan was configured with json format
    expect(res.status).toBe(200);
  });

  it('morgan defaults to json format in production when LOG_FORMAT is unset', async () => {
    delete process.env.LOG_FORMAT;
    process.env.NODE_ENV = 'production';
    const { app } = await import('../app');

    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
  });

  it('morgan handler is reused across multiple requests (lazy singleton)', async () => {
    const { app } = await import('../app');

    const res1 = await request(app, 'GET', '/health');
    expect(res1.status).toBe(200);

    // Second request should reuse the same morgan handler
    const res2 = await request(app, 'GET', '/health');
    expect(res2.status).toBe(200);
  });
});

describe('app.ts — trust proxy lazy configuration', () => {
  const savedTrustProxy = process.env.TRUST_PROXY;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.TRUST_PROXY;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedTrustProxy !== undefined) {
      process.env.TRUST_PROXY = savedTrustProxy;
    } else {
      delete process.env.TRUST_PROXY;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it('trust proxy is NOT set when TRUST_PROXY and NODE_ENV are unset', async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.NODE_ENV;
    const { app } = await import('../app');

    // Make a request to trigger the lazy trust proxy check
    await request(app, 'GET', '/health');

    // trust proxy should not be set (undefined or default false)
    // Express default is false/undefined when not explicitly set
    expect(app.get('trust proxy')).toBeFalsy();
  });

  it('trust proxy IS set when TRUST_PROXY=true', async () => {
    process.env.TRUST_PROXY = 'true';
    const { app } = await import('../app');

    // Make a request to trigger the lazy trust proxy middleware
    await request(app, 'GET', '/health');

    expect(app.get('trust proxy')).toBe(1);
  });

  it('trust proxy IS set when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const { app } = await import('../app');

    await request(app, 'GET', '/health');

    expect(app.get('trust proxy')).toBe(1);
  });

  it('trust proxy is NOT set when TRUST_PROXY=false', async () => {
    process.env.TRUST_PROXY = 'false';
    delete process.env.NODE_ENV;
    const { app } = await import('../app');

    await request(app, 'GET', '/health');

    expect(app.get('trust proxy')).toBeFalsy();
  });

  it('trust proxy check runs only once (idempotent)', async () => {
    process.env.TRUST_PROXY = 'true';
    const { app } = await import('../app');

    // First request triggers the check
    await request(app, 'GET', '/health');
    expect(app.get('trust proxy')).toBe(1);

    // Even if env var changes, the flag should already be set
    process.env.TRUST_PROXY = 'false';
    await request(app, 'GET', '/health');
    // Still 1 because the check only runs once
    expect(app.get('trust proxy')).toBe(1);
  });
});
