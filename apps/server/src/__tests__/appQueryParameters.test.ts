import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { Router } from 'express';
import type { Express } from 'express';

// The rule under test: every query parameter carries ONE string value on
// every route of app.ts's api router, refused right after the general rate
// limiter (a repeated parameter arrives as an array, which no route accepts).
// Routes mounted on the app itself (the webhook execute route, the health
// probes, the public feature flags) are left exactly as they were. The
// routers are empty here: a request the rule lets through finds no route
// (404), one it refuses never reaches a router at all. The REAL error handler
// answers the refusal.

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
vi.mock('../routes/roles', () => ({ roleRouter: Router() }));
vi.mock('../routes/secureChannels', () => ({ secureChannelRouter: Router() }));
vi.mock('../routes/themes', () => ({ themeRouter: Router() }));
vi.mock('../routes/e2e', () => ({ e2eRouter: Router() }));
vi.mock('../routes/discovery', () => ({ discoveryRouter: Router() }));
vi.mock('../routes/webhooks', () => ({ webhookRouter: Router() }));
// The public execute router (mounted on the app, outside the api router):
// reached means 200, with the query it was handed
const executeReached = vi.hoisted(() => vi.fn());
vi.mock('../routes/webhookExecute', async () => {
  const { Router: makeRouter } = await import('express');
  const router = makeRouter();
  router.post('/:webhookId/:token', (req, res) => {
    executeReached(req.query);
    res.status(200).json({ reached: true });
  });
  return { webhookExecuteRouter: router };
});

// Every limiter passes; the general one records each request it charges
const generalCharged = vi.hoisted(() => vi.fn());
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  const mocked: Record<string, unknown> = {};
  for (const key of Object.keys(original)) mocked[key] = passthrough;
  mocked.rateLimitGeneral = (req: { originalUrl: string }, _res: unknown, next: () => void) => {
    generalCharged(req.originalUrl);
    next();
  };
  return mocked;
});
vi.mock('../utils/prisma', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]) } }));
vi.mock('../utils/redis', () => ({ getRedis: vi.fn().mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') }) }));
vi.mock('../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));

const REFUSAL = { success: false, error: 'Each query parameter must be a single value' };

// ─── Every route that reads req.query, read from the sources ─────────────────

const SRC = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(SRC, 'routes');

interface QueryRoute {
  file: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  url: string;
  keys: string[];
  /** under app.ts's api router (judged by the rule) or mounted on the app itself (left alone) */
  underApi: boolean;
}

/** `api.use('/prefix', fooRouter)` / `app.use('/api/v1/webhooks', fooRouter)` → router name → where it is mounted. */
function mounts(): Map<string, { prefix: string; underApi: boolean }> {
  const appSource = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8');
  const found = new Map<string, { prefix: string; underApi: boolean }>();
  for (const m of appSource.matchAll(/\b(api|app)\.use\(\s*'([^']+)'\s*,\s*(\w+Router)\s*\)/g)) {
    found.set(m[3], m[1] === 'api' ? { prefix: `/api/v1${m[2]}`, underApi: true } : { prefix: m[2], underApi: false });
  }
  return found;
}

/** A concrete path for an Express 5 route path: `:param` → `p`, `*splat` → `a/b`. */
function concrete(routePath: string): string {
  return routePath.replace(/:\w+/g, 'p').replace(/\*\w+/g, 'a/b');
}

function queryRoutes(): QueryRoute[] {
  const mounted = mounts();
  const found: QueryRoute[] = [];
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    const registrations = [...source.matchAll(/\b(\w+Router)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
    const readsIn = (text: string) => [...text.matchAll(/req\.query\.(\w+)/g)].map((k) => k[1]);
    // A handler defined above the file's first registration (webhookExecute.ts
    // names its handler functions there) may serve any of them
    const beforeFirst = readsIn(source.slice(0, registrations[0]?.index ?? 0));
    registrations.forEach((reg, i) => {
      // The handler of a registration is the source up to the next one
      const body = source.slice(reg.index, registrations[i + 1]?.index ?? source.length);
      const keys = [...new Set([...readsIn(body), ...beforeFirst])];
      if (keys.length === 0) return;
      const mount = mounted.get(reg[1]);
      if (mount === undefined) throw new Error(`${file}: ${reg[1]} is not mounted in app.ts`);
      found.push({
        file,
        method: reg[2] as QueryRoute['method'],
        url: concrete(`${mount.prefix}${reg[3] === '/' ? '' : reg[3]}`),
        keys,
        underApi: mount.underApi,
      });
    });
  }
  return found;
}

const ALL = queryRoutes();
const UNDER_API = ALL.filter((r) => r.underApi);
const OUTSIDE_API = ALL.filter((r) => !r.underApi);

let app: Express;
beforeAll(async () => {
  ({ app } = await import('../app'));
});
beforeEach(() => {
  executeReached.mockClear();
  generalCharged.mockClear();
});

describe('app.ts — a query parameter carries one value on every API route', () => {
  it('the scan finds the routes that read the query string (the list the rest of this file walks)', () => {
    // A scan that silently found nothing would make every test below vacuous
    expect(UNDER_API.length).toBeGreaterThanOrEqual(30);
    const seen = new Set(UNDER_API.map((r) => `${r.method.toUpperCase()} ${r.url} ${r.keys.join(',')}`));
    // The routes the issue names, each with the parameters that used to reach a .trim() or a Prisma where
    for (const expected of [
      'GET /api/v1/channels/p/messages limit,before,around',
      'GET /api/v1/dm/p/messages limit,before,around',
      'GET /api/v1/search/servers/p/messages q,channelId,authorId,before,limit',
      'GET /api/v1/admin/users page,limit,search,filter,sort',
    ]) {
      expect(seen).toContain(expected);
    }
    // ...and the public execute route, mounted on the app, outside the api router
    expect(OUTSIDE_API.map((r) => `${r.method} ${r.url} ${r.keys.join(',')}`)).toEqual(['post /api/v1/webhooks/p/p wait']);
  });

  for (const route of UNDER_API) {
    for (const key of route.keys) {
      it(`${route.method.toUpperCase()} ${route.url} — a repeated "${key}" answers 400, charged on the general budget`, async () => {
        const res = await request(app)[route.method](`${route.url}?${key}=a&${key}=b`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual(REFUSAL);
        expect(generalCharged).toHaveBeenCalledTimes(1);
      });
    }
  }

  it('a single value of every parameter passes the rule (the control: the empty routers answer 404)', async () => {
    for (const route of UNDER_API) {
      const query = route.keys.map((k) => `${k}=a`).join('&');
      const res = await request(app)[route.method](`${route.url}?${query}`);
      expect(res.body).not.toEqual(REFUSAL);
    }
  });

  it('a repeated parameter no route reads is refused too: the rule is the api router\'s, not a list', async () => {
    const res = await request(app).get('/api/v1/servers?unused=a&unused=b');
    expect(res.status).toBe(400);
    expect(res.body).toEqual(REFUSAL);
  });

  it('a bracketed key stays a flat string key under the simple parser, and is not refused', async () => {
    const res = await request(app).get('/api/v1/servers?a[b]=1&c[]=2');
    expect(res.body).not.toEqual(REFUSAL);
  });

  it('a key named like an Object.prototype member is an ordinary key', async () => {
    const res = await request(app).get('/api/v1/servers?__proto__=a&__proto__=b');
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/v1/servers?constructor=a')).body).not.toEqual(REFUSAL);
  });

  it('pins the simple query parser: the extended one would hand routes nested objects', () => {
    expect(app.get('query parser')).toBe('simple');
  });
});

describe('app.ts — the routes outside the api router are not judged by the rule', () => {
  it('the webhook execute route still receives a repeated parameter (as before: ?wait=true&wait=true posts)', async () => {
    const [route] = OUTSIDE_API;
    const res = await request(app).post(`${route.url}?wait=true&wait=true`).send({ content: 'x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
    expect(executeReached).toHaveBeenCalledWith(expect.objectContaining({ wait: ['true', 'true'] }));
    // its own chain, never the api router's budget
    expect(generalCharged).not.toHaveBeenCalled();
  });

  it('the health probes and the public feature flags answer as before', async () => {
    const health = await request(app).get('/health?x=1&x=2');
    expect(health.status).toBe(200);
    expect(health.body).not.toEqual(REFUSAL);

    const ready = await request(app).get('/ready?x=1&x=2');
    expect(ready.status).toBe(503); // not marked ready in this test: its own answer, not the rule's
    expect(ready.body).toEqual({ ready: false });

    const flags = await request(app).get('/api/v1/feature-flags/public?x=1&x=2');
    expect(flags.status).toBe(200);
    expect(flags.body.success).toBe(true);
  });
});
