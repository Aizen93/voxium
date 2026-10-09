import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// GET/POST/DELETE /discovery/* — the directory (docs/local/server-discovery-plan.html).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
  requireConsent: (_req: any, _res: any, next: any) => next(),
}));

const limiters = vi.hoisted(() => ({
  browse: vi.fn((_req: any, _res: any, next: any) => next()),
  join: vi.fn((_req: any, _res: any, next: any) => next()),
}));
vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitDiscoveryBrowse: (...a: any[]) => limiters.browse(...a),
  rateLimitDiscoveryJoin: (...a: any[]) => limiters.join(...a),
}));

const flags = vi.hoisted(() => ({ discovery: true }));
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: (name: string) => (name === 'server_discovery' ? flags.discovery : true),
}));

const prismaMock = vi.hoisted(() => ({
  server: { findMany: vi.fn(), findUnique: vi.fn() },
  serverMember: { findMany: vi.fn(), findUnique: vi.fn() },
  serverJoinRequest: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  serverBan: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../utils/redis', () => ({ getRedis: () => redis }));

vi.mock('../../websocket/socketServer', () => ({ getIO: () => ({ to: vi.fn(() => ({ emit: vi.fn() })) }) }));

const emitToModerators = vi.hoisted(() => vi.fn());
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: (...a: any[]) => emitToModerators(...a) }));

const joinServerMember = vi.hoisted(() => vi.fn());
vi.mock('../../utils/serverJoin', () => ({ joinServerMember: (...a: any[]) => joinServerMember(...a) }));

import { discoveryRouter, DISCOVERY_PAGE_CACHE_TTL_S } from '../../routes/discovery';
import { errorHandler } from '../../middleware/errorHandler';
import { encodeDiscoveryCursor, decodeDiscoveryCursor, hashDiscoveryQuery } from '../../utils/discoveryCursor';
import { ForbiddenError, BadRequestError } from '../../utils/errors';
import { DISCOVERY_MAX_PAGES } from '@voxium/shared';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/discovery', discoveryRouter);
  app.use(errorHandler);
  return app;
}

const NOW = new Date('2026-10-09T12:00:00Z');

function row(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `srv-${i}`, name: `Server ${i}`, iconUrl: null, description: i % 2 ? 'desc' : null, tags: ['gaming'],
    memberCount: 10 + i, onlineCount: i, weeklyMessages: i * 3, joinMode: 'approval',
    featuredAt: null, createdAt: NOW, statsRefreshedAt: null, ...extra,
  };
}

const app = createApp();

beforeEach(() => {
  vi.clearAllMocks();
  flags.discovery = true;
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
  prismaMock.server.findMany.mockResolvedValue([]);
  prismaMock.serverMember.findMany.mockResolvedValue([]);
  prismaMock.serverMember.findUnique.mockResolvedValue(null);
  prismaMock.serverJoinRequest.findMany.mockResolvedValue([]);
  prismaMock.serverJoinRequest.findUnique.mockResolvedValue(null);
  prismaMock.serverBan.findUnique.mockResolvedValue(null);
  prismaMock.$queryRaw.mockResolvedValue([{ n: 3 }]);
});

// ─── Kill switch ────────────────────────────────────────────────────────────

describe('server_discovery feature flag', () => {
  it('answers 403 on every directory route when off, before any lookup', async () => {
    flags.discovery = false;
    const paths = [
      request(app).get('/api/v1/discovery/servers'),
      request(app).get('/api/v1/discovery/servers/srv-1'),
      request(app).post('/api/v1/discovery/servers/srv-1/join'),
      request(app).delete('/api/v1/discovery/servers/srv-1/join'),
    ];
    for (const p of paths) {
      const res = await p;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Server discovery is currently disabled');
    }
    expect(prismaMock.server.findMany).not.toHaveBeenCalled();
    expect(prismaMock.server.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Listing ────────────────────────────────────────────────────────────────

describe('GET /discovery/servers', () => {
  it('filters on discoveryListed ALONE, sorts by activity then id, takes limit + 1, and is rate limited', async () => {
    prismaMock.server.findMany.mockResolvedValue([row(1), row(2)]);

    const res = await request(app).get('/api/v1/discovery/servers');

    expect(res.status).toBe(200);
    expect(limiters.browse).toHaveBeenCalled();
    // first call = the page, second = featured (first page without q)
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { discoveryListed: true },
      orderBy: [{ activityScore: 'desc' }, { id: 'desc' }],
      take: 25,
    }));
    expect(prismaMock.server.findMany.mock.calls[0][0]).not.toHaveProperty('cursor');
    expect(prismaMock.server.findMany.mock.calls[0][0]).not.toHaveProperty('skip');
    expect(res.body.data.servers).toHaveLength(2);
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.totalCapped).toBe(3);
    expect(res.body.data.servers[0]).toEqual({
      id: 'srv-1', name: 'Server 1', iconUrl: null, description: 'desc', tags: ['gaming'],
      memberCount: 11, onlineCount: 1, weeklyMessages: 3, joinMode: 'approval', featured: false,
      createdAt: NOW.toISOString(), statsRefreshedAt: null, isMember: false, requestPending: false,
    });
  });

  it('maps each sort to its index-backed order and clamps the limit to 48', async () => {
    for (const [sort, orderBy] of [
      ['members', [{ memberCount: 'desc' }, { id: 'desc' }]],
      ['newest', [{ createdAt: 'desc' }, { id: 'desc' }]],
      ['name', [{ name: 'asc' }, { id: 'asc' }]],
    ] as const) {
      vi.clearAllMocks();
      redis.get.mockResolvedValue(null);
      prismaMock.server.findMany.mockResolvedValue([]);
      prismaMock.$queryRaw.mockResolvedValue([{ n: 0 }]);
      const res = await request(app).get(`/api/v1/discovery/servers?sort=${sort}&limit=1000`);
      expect(res.status).toBe(200);
      expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ orderBy, take: 49 }));
    }
    const bad = await request(app).get('/api/v1/discovery/servers?sort=random');
    expect(bad.status).toBe(400);
  });

  it('search: three characters minimum, insensitive contains for the rows, escaped ILIKE for the capped count', async () => {
    let res = await request(app).get('/api/v1/discovery/servers?q=ab');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at least 3');
    expect(prismaMock.server.findMany).not.toHaveBeenCalled();

    prismaMock.server.findMany.mockResolvedValue([]);
    res = await request(app).get('/api/v1/discovery/servers?q=' + encodeURIComponent(' 50%_x\\ '));
    expect(res.status).toBe(200);
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { discoveryListed: true, name: { contains: '50%_x\\', mode: 'insensitive' } },
    }));
    // the raw count binds the escaped pattern as a parameter — never
    // interpolated (nested Prisma.sql fragments carry their own values)
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('LIMIT');
    const flat = (v: any): unknown[] => Array.isArray(v) ? v.flatMap(flat)
      : v && typeof v === 'object' && 'values' in v && 'strings' in v ? (v.values as unknown[]).flatMap(flat) : [v];
    expect(flat(values)).toContain('%50\\%\\_x\\\\%');
    // featured is NOT fetched with a query
    expect(prismaMock.server.findMany).toHaveBeenCalledTimes(1);
  });

  it('the capped count takes the plan-safe shape for each filter combination (measured at one million rows)', async () => {
    // Render the tagged-template call as SQL text, recursing into nested Prisma.sql fragments
    const render = (strings: readonly string[], values: unknown[]): string => strings.map((str, i) => {
      if (i >= values.length) return str;
      const v = values[i] as { strings?: readonly string[]; values?: unknown[] };
      return str + (v && typeof v === 'object' && v.strings && v.values ? render(v.strings, v.values) : '?');
    }).join('');
    const sqlOf = (i: number) => { const [strings, ...values] = prismaMock.$queryRaw.mock.calls[i]; return render(strings, values).replace(/\s+/g, ' '); };
    prismaMock.server.findMany.mockResolvedValue([]);

    // no query: the sort's own index order, LIMIT cap + 1
    await request(app).get('/api/v1/discovery/servers?sort=members');
    expect(sqlOf(0)).toContain('ORDER BY member_count DESC, id DESC LIMIT ?');
    expect(sqlOf(0)).not.toContain('ILIKE');
    // a tag rides the same shape as a filter
    await request(app).get('/api/v1/discovery/servers?tag=music');
    expect(sqlOf(1)).toContain('= ANY(tags)');
    expect(sqlOf(1)).toContain('ORDER BY discovery_activity_score DESC, id DESC LIMIT ?');
    // a query: the covering name index, whatever the sort
    await request(app).get('/api/v1/discovery/servers?q=voxium&sort=active');
    expect(sqlOf(2)).toContain('ORDER BY name ASC, id ASC LIMIT ?');
    // query + tag: a plain count the trigram bitmap serves, capped in code
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 50_000 }]);
    const res = await request(app).get('/api/v1/discovery/servers?q=voxium&tag=music');
    expect(sqlOf(3)).not.toContain('LIMIT');
    expect(sqlOf(3)).not.toContain('ORDER BY');
    expect(res.body.data.totalCapped).toBe(1001);
  });

  it('tag: must come from the vocabulary, filters rows AND the featured row', async () => {
    let res = await request(app).get('/api/v1/discovery/servers?tag=nope');
    expect(res.status).toBe(400);

    prismaMock.server.findMany.mockResolvedValue([]);
    res = await request(app).get('/api/v1/discovery/servers?tag=music');
    expect(res.status).toBe(200);
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { discoveryListed: true, tags: { has: 'music' } },
    }));
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { discoveryListed: true, featuredAt: { not: null }, tags: { has: 'music' } },
      orderBy: [{ featuredAt: 'desc' }, { id: 'desc' }],
    }));
  });

  it('issues a signed keyset cursor when there is more, and pages with cursor + skip 1', async () => {
    prismaMock.server.findMany.mockResolvedValueOnce(Array.from({ length: 25 }, (_, i) => row(i + 1))).mockResolvedValueOnce([]);

    const first = await request(app).get('/api/v1/discovery/servers');
    expect(first.status).toBe(200);
    expect(first.body.data.servers).toHaveLength(24);
    const cursor = first.body.data.nextCursor as string;
    expect(cursor).toBeTruthy();
    expect(decodeDiscoveryCursor(cursor, { sort: 'active', tag: '', q: '' })).toEqual({ sort: 'active', tag: '', q: '', id: 'srv-24', page: 2 });

    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    prismaMock.server.findMany.mockResolvedValue([row(25)]);
    prismaMock.$queryRaw.mockResolvedValue([{ n: 25 }]);
    const second = await request(app).get(`/api/v1/discovery/servers?cursor=${encodeURIComponent(cursor)}`);
    expect(second.status).toBe(200);
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cursor: { id: 'srv-24' }, skip: 1, take: 25,
    }));
    // page 2: no featured row
    expect(prismaMock.server.findMany).toHaveBeenCalledTimes(1);
    expect(second.body.data.featured).toEqual([]);
    expect(second.body.data.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor, a cursor from another sort/tag/query, and one past the depth cap', async () => {
    const good = encodeDiscoveryCursor({ sort: 'active', tag: '', q: '', id: 'srv-24', page: 2 });
    const tampered = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
    let res = await request(app).get(`/api/v1/discovery/servers?cursor=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid cursor');

    res = await request(app).get(`/api/v1/discovery/servers?sort=members&cursor=${encodeURIComponent(good)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid cursor');

    const deep = encodeDiscoveryCursor({ sort: 'active', tag: '', q: '', id: 'srv-x', page: DISCOVERY_MAX_PAGES + 1 });
    res = await request(app).get(`/api/v1/discovery/servers?cursor=${encodeURIComponent(deep)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Refine your search');
    expect(prismaMock.server.findMany).not.toHaveBeenCalled();
  });

  it('never issues a cursor beyond the depth cap, even when more rows exist', async () => {
    const last = encodeDiscoveryCursor({ sort: 'active', tag: '', q: '', id: 'srv-prev', page: DISCOVERY_MAX_PAGES });
    prismaMock.server.findMany.mockResolvedValue(Array.from({ length: 25 }, (_, i) => row(i + 1)));

    const res = await request(app).get(`/api/v1/discovery/servers?cursor=${encodeURIComponent(last)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.servers).toHaveLength(24);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('serves the public part from the 60 s cache, keyed by sort/tag/hash(q)/cursor/limit, and still resolves per-user flags', async () => {
    const qh = hashDiscoveryQuery('voxium');
    redis.get.mockResolvedValue(JSON.stringify({
      featured: [], servers: [{ ...row(7), createdAt: NOW.toISOString(), featured: false }], nextCursor: null, totalCapped: 1,
    }));
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-7' }]);

    const res = await request(app).get('/api/v1/discovery/servers?q=voxium&tag=gaming&sort=members&limit=10');

    expect(res.status).toBe(200);
    expect(redis.get).toHaveBeenCalledWith(`discovery:page:members:gaming:${qh}::10`);
    expect(prismaMock.server.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    // flags are the caller's, computed on every request
    expect(prismaMock.serverMember.findMany).toHaveBeenCalledWith({ where: { userId: 'user-1', serverId: { in: ['srv-7'] } }, select: { serverId: true } });
    expect(res.body.data.servers[0].isMember).toBe(true);
    expect(res.body.data.servers[0].requestPending).toBe(false);
  });

  it('on a miss, caches the public part only (no flags) for 60 s', async () => {
    prismaMock.server.findMany.mockResolvedValue([row(1)]);
    prismaMock.serverJoinRequest.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);

    const res = await request(app).get('/api/v1/discovery/servers');
    expect(res.status).toBe(200);
    expect(res.body.data.servers[0].requestPending).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('discovery:page:active::::24', expect.any(String), { EX: DISCOVERY_PAGE_CACHE_TTL_S });
    const cached = JSON.parse(redis.set.mock.calls[0][1]);
    expect(cached.servers[0]).not.toHaveProperty('isMember');
    expect(cached.servers[0]).not.toHaveProperty('requestPending');
    expect(DISCOVERY_PAGE_CACHE_TTL_S).toBe(60);
  });

  it('a cache outage is logged and the page is served uncached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.set.mockRejectedValue(new Error('redis down'));
    prismaMock.server.findMany.mockResolvedValue([row(1)]);

    const res = await request(app).get('/api/v1/discovery/servers');
    expect(res.status).toBe(200);
    expect(res.body.data.servers).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('marks featured cards and computes their flags too', async () => {
    prismaMock.server.findMany.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([row(9, { featuredAt: NOW })]);
    prismaMock.serverMember.findMany.mockImplementation(async ({ where }: any) =>
      where.serverId.in.includes('srv-9') ? [{ serverId: 'srv-9' }] : []);

    const res = await request(app).get('/api/v1/discovery/servers');
    expect(res.body.data.featured).toHaveLength(1);
    expect(res.body.data.featured[0]).toMatchObject({ id: 'srv-9', featured: true, isMember: true });
    expect(res.body.data.servers[0]).toMatchObject({ id: 'srv-1', featured: false, isMember: false });
  });
});

// ─── One card ───────────────────────────────────────────────────────────────

describe('GET /discovery/servers/:serverId', () => {
  it('answers a hidden server EXACTLY like a nonexistent one', async () => {
    prismaMock.server.findUnique.mockResolvedValueOnce(null);
    const missing = await request(app).get('/api/v1/discovery/servers/nope');
    prismaMock.server.findUnique.mockResolvedValueOnce({ ...row(1), discoveryListed: false });
    const hidden = await request(app).get('/api/v1/discovery/servers/srv-1');

    expect(missing.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it('returns the card with the caller\'s flags', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ ...row(1), discoveryListed: true });
    prismaMock.serverJoinRequest.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);
    const res = await request(app).get('/api/v1/discovery/servers/srv-1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'srv-1', requestPending: true, isMember: false });
  });
});

// ─── Join ───────────────────────────────────────────────────────────────────

describe('POST /discovery/servers/:serverId/join', () => {
  it('is 404 for a hidden server, byte-identical to nonexistent, and rate limited', async () => {
    prismaMock.server.findUnique.mockResolvedValueOnce(null);
    const missing = await request(app).post('/api/v1/discovery/servers/nope/join');
    prismaMock.server.findUnique.mockResolvedValueOnce({ ...row(1, { joinMode: 'open' }), discoveryListed: false });
    const hidden = await request(app).post('/api/v1/discovery/servers/srv-1/join');
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(limiters.join).toHaveBeenCalled();
    expect(joinServerMember).not.toHaveBeenCalled();
  });

  it('open mode: runs the join helper (via discovery) and answers with the Server like an invite join', async () => {
    prismaMock.server.findUnique
      .mockResolvedValueOnce({ ...row(1, { joinMode: 'open' }), discoveryListed: true })
      .mockResolvedValueOnce({ id: 'srv-1', name: 'Server 1', iconUrl: null, invitesLocked: false, ownerId: 'o', createdAt: NOW, description: null, tags: [], discoverable: true, joinMode: 'open' });
    joinServerMember.mockResolvedValue(undefined);

    const res = await request(app).post('/api/v1/discovery/servers/srv-1/join');
    expect(res.status).toBe(200);
    expect(joinServerMember).toHaveBeenCalledWith('user-1', 'srv-1', { via: 'discovery' });
    expect(res.body.data).toMatchObject({ id: 'srv-1', joinMode: 'open' });
    expect(emitToModerators).not.toHaveBeenCalled();
  });

  it('open mode: the helper\'s refusals (banned 403, member limit 400) pass through', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ ...row(1, { joinMode: 'open' }), discoveryListed: true });
    joinServerMember.mockRejectedValueOnce(new ForbiddenError('You are banned from this server'));
    let res = await request(app).post('/api/v1/discovery/servers/srv-1/join');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('banned');
    joinServerMember.mockRejectedValueOnce(new BadRequestError('This server has reached its member limit (10)'));
    res = await request(app).post('/api/v1/discovery/servers/srv-1/join');
    expect(res.status).toBe(400);
  });

  describe('approval mode', () => {
    beforeEach(() => {
      prismaMock.server.findUnique.mockResolvedValue({ ...row(1, { joinMode: 'approval' }), discoveryListed: true });
      prismaMock.serverJoinRequest.create.mockImplementation(async ({ data }: any) => ({
        id: 'req-1', serverId: data.serverId, userId: data.userId, message: data.message, status: 'pending', createdAt: NOW,
        user: { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null },
      }));
    });

    it('refuses a banned user (403) and an existing member (400) before touching requests', async () => {
      prismaMock.serverBan.findUnique.mockResolvedValueOnce({ userId: 'user-1' });
      let res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({});
      expect(res.status).toBe(403);
      prismaMock.serverMember.findUnique.mockResolvedValueOnce({ userId: 'user-1' });
      res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already a member');
      expect(prismaMock.serverJoinRequest.create).not.toHaveBeenCalled();
      expect(joinServerMember).not.toHaveBeenCalled();
    });

    it('validates the optional message (string, sanitized, 300 max, no bidi)', async () => {
      let res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({ message: 42 });
      expect(res.status).toBe(400);
      res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({ message: 'x'.repeat(301) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most 300');
      res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({ message: `hi${String.fromCharCode(0x202e)}` });
      expect(res.status).toBe(400);
      expect(prismaMock.serverJoinRequest.create).not.toHaveBeenCalled();
    });

    it('creates the request (202), stores the sanitized message, and tells ONLY the moderators', async () => {
      const res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({ message: '  <b>Let me in</b> ' });
      expect(res.status).toBe(202);
      expect(res.body.data).toEqual({ status: 'pending' });
      expect(prismaMock.serverJoinRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: { serverId: 'srv-1', userId: 'user-1', message: 'Let me in' },
      }));
      expect(emitToModerators).toHaveBeenCalledWith('srv-1', 'server:join_request', {
        serverId: 'srv-1',
        request: {
          id: 'req-1', serverId: 'srv-1', userId: 'user-1', message: 'Let me in', status: 'pending', createdAt: NOW.toISOString(),
          user: { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null },
        },
      });
    });

    it('an empty message is stored as null', async () => {
      await request(app).post('/api/v1/discovery/servers/srv-1/join').send({ message: '   ' });
      expect(prismaMock.serverJoinRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ message: null }) }));
    });

    it('is idempotent while a request is pending: 200, no second row, no second event', async () => {
      prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'pending', decidedAt: null });
      const res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ status: 'pending' });
      expect(prismaMock.serverJoinRequest.create).not.toHaveBeenCalled();
      expect(prismaMock.serverJoinRequest.update).not.toHaveBeenCalled();
      expect(emitToModerators).not.toHaveBeenCalled();
    });

    it('refuses within the 7-day cooldown after a decline, and reuses the row past it', async () => {
      prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'declined', decidedAt: new Date(Date.now() - 6 * 24 * 3600 * 1000) });
      let res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('declined recently');

      prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'declined', decidedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
      prismaMock.serverJoinRequest.update.mockResolvedValue({
        id: 'req-1', serverId: 'srv-1', userId: 'user-1', message: null, status: 'pending', createdAt: NOW,
        user: { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null },
      });
      res = await request(app).post('/api/v1/discovery/servers/srv-1/join').send({});
      expect(res.status).toBe(202);
      expect(prismaMock.serverJoinRequest.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'req-1' },
        data: { status: 'pending', message: null, decidedById: null, decidedAt: null, createdAt: expect.any(Date) },
      }));
      expect(prismaMock.serverJoinRequest.create).not.toHaveBeenCalled();
      expect(emitToModerators).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Cancel ─────────────────────────────────────────────────────────────────

describe('DELETE /discovery/servers/:serverId/join', () => {
  it('deletes the caller\'s PENDING request and tells the moderators it was cancelled', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ ...row(1), discoveryListed: true });
    prismaMock.serverJoinRequest.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete('/api/v1/discovery/servers/srv-1/join');
    expect(res.status).toBe(200);
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { serverId: 'srv-1', userId: 'user-1', status: 'pending' } });
    expect(emitToModerators).toHaveBeenCalledWith('srv-1', 'server:join_request_resolved', { serverId: 'srv-1', userId: 'user-1', outcome: 'cancelled' });
  });

  it('is 404 when there is nothing pending, and 404 (identical) for a hidden server', async () => {
    prismaMock.server.findUnique.mockResolvedValueOnce({ ...row(1), discoveryListed: true });
    prismaMock.serverJoinRequest.deleteMany.mockResolvedValue({ count: 0 });
    const none = await request(app).delete('/api/v1/discovery/servers/srv-1/join');
    expect(none.status).toBe(404);
    expect(emitToModerators).not.toHaveBeenCalled();

    prismaMock.server.findUnique.mockResolvedValueOnce({ ...row(1), discoveryListed: false });
    const hidden = await request(app).delete('/api/v1/discovery/servers/srv-1/join');
    prismaMock.server.findUnique.mockResolvedValueOnce(null);
    const missing = await request(app).delete('/api/v1/discovery/servers/zzz/join');
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledTimes(1);
  });
});
