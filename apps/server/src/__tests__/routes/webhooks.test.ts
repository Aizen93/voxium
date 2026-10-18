import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { Permissions } from '@voxium/shared';

// The authenticated webhook MANAGEMENT router (routes/webhooks.ts): list,
// create, patch, rotate, delete (+ purge). The public execute route has its
// own suite.

// ─── Hoisted state ──────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  auth: { userId: 'user-1' as string | null },
  flags: { webhooks: true },
  hasServerPermission: vi.fn(),
  hasChannelPermission: vi.fn(),
  filterVisibleChannels: vi.fn(),
  requireVerifiedEmail: vi.fn(),
  requireConsent: vi.fn(),
  limiterCalls: [] as string[],
  emitted: [] as { room: string; event: string; payload: unknown }[],
}));

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, res: any, next: () => void) => {
    if (!h.auth.userId) {
      res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
      return;
    }
    req.user = { userId: h.auth.userId, username: 'tester', role: 'user', tokenVersion: 0, emailVerified: true, consentRequired: false };
    next();
  },
  requireVerifiedEmail: (req: any, res: any, next: () => void) => { h.requireVerifiedEmail(); next(); },
  requireConsent: (req: any, res: any, next: () => void) => { h.requireConsent(); next(); },
}));

vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: (name: string) => (name === 'webhooks' ? h.flags.webhooks : true),
}));

vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => h.hasServerPermission(...args),
  hasChannelPermission: (...args: unknown[]) => h.hasChannelPermission(...args),
  filterVisibleChannels: (...args: unknown[]) => h.filterVisibleChannels(...args),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitWebhookManage: (_req: any, _res: any, next: () => void) => { h.limiterCalls.push('webhookManage'); next(); },
  rateLimitWebhookRead: (_req: any, _res: any, next: () => void) => { h.limiterCalls.push('webhookRead'); next(); },
}));

// The REAL limits resolution (server override -> global -> LIMITS) over the
// prisma mock, wrapped so a test can also pin the answer directly.
vi.mock('../../utils/serverLimits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/serverLimits')>();
  return { ...actual, getEffectiveLimits: vi.fn(actual.getEffectiveLimits) };
});

const txMock = {
  $queryRaw: vi.fn(),
  message: { groupBy: vi.fn(), deleteMany: vi.fn() },
  webhook: { delete: vi.fn() },
};

const prismaMock: Record<string, any> = {
  webhook: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // Deliberately no `delete` here and no `message` model: the delete must
    // run on the transaction client, never on the root client.
  },
  channel: { findUnique: vi.fn() },
  globalConfig: { findUnique: vi.fn() },
  serverLimits: { findUnique: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => { h.emitted.push({ room, event, payload }); },
    }),
  })),
}));

// ─── App ────────────────────────────────────────────────────────────────────

import { webhookRouter } from '../../routes/webhooks';
import { errorHandler } from '../../middleware/errorHandler';
import { getEffectiveLimits } from '../../utils/serverLimits';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers/:serverId/webhooks', webhookRouter);
  app.use(errorHandler);
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE = '/api/v1/servers/srv-1/webhooks';
const CREATED_AT = new Date('2026-10-18T10:00:00.000Z');
const USED_AT = new Date('2026-10-18T11:30:00.000Z');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-1',
    serverId: 'srv-1',
    channelId: 'ch-1',
    name: 'CI',
    type: 'generic',
    enabled: true,
    createdAt: CREATED_AT,
    lastUsedAt: null,
    createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
    ...overrides,
  };
}

/** A list row as GET selects it: the row plus its channel's { id, secure }. */
function listRow(overrides: Record<string, unknown> = {}) {
  const row = webhookRow(overrides);
  return { ...row, channel: { id: row.channelId, secure: false } };
}

const textChannel = { id: 'ch-1', serverId: 'srv-1', type: 'text', secure: false };

const FULL_LIMITS = {
  maxChannelsPerServer: 20,
  maxVoiceUsersPerChannel: 12,
  maxCategoriesPerServer: 12,
  maxMembersPerServer: 0,
};

function eventsNamed(event: string) {
  return h.emitted.filter((e) => e.event === event);
}

function expectChangedOnce() {
  const changed = eventsNamed('webhook:changed');
  expect(changed).toHaveLength(1);
  expect(changed[0].room).toBe('server:srv-1');
  expect(changed[0].payload).toEqual({ serverId: 'srv-1' });
  // A refetch hint and nothing else: no channel id may reach server:{id}
  expect(Object.keys(changed[0].payload as object)).toHaveLength(1);
}

function prismaCallCount(): number {
  let n = prismaMock.$transaction.mock.calls.length;
  for (const model of ['webhook', 'channel', 'globalConfig', 'serverLimits']) {
    for (const fn of Object.values(prismaMock[model]) as any[]) n += fn.mock.calls.length;
  }
  return n;
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.userId = 'user-1';
  h.flags.webhooks = true;
  h.limiterCalls.length = 0;
  h.emitted.length = 0;
  h.hasServerPermission.mockResolvedValue(true);
  h.hasChannelPermission.mockResolvedValue(true);
  h.filterVisibleChannels.mockImplementation(async (_u: unknown, _s: unknown, channels: unknown[]) => channels);

  prismaMock.webhook.findMany.mockResolvedValue([]);
  prismaMock.webhook.findUnique.mockResolvedValue({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1' });
  prismaMock.webhook.count.mockResolvedValue(0);
  prismaMock.webhook.create.mockImplementation(async ({ data }: any) => webhookRow({
    name: data.name, channelId: data.channelId, type: data.type,
  }));
  prismaMock.webhook.update.mockImplementation(async ({ data }: any) => webhookRow({
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.channelId !== undefined ? { channelId: data.channelId } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
  }));
  prismaMock.channel.findUnique.mockResolvedValue(textChannel);
  prismaMock.globalConfig.findUnique.mockResolvedValue(null);
  prismaMock.serverLimits.findUnique.mockResolvedValue(null);
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  txMock.$queryRaw.mockResolvedValue([{ id: 'wh-1' }]);
  txMock.message.groupBy.mockResolvedValue([]);
  txMock.message.deleteMany.mockResolvedValue({ count: 0 });
  txMock.webhook.delete.mockResolvedValue({ id: 'wh-1' });

  app = createApp();
});

// ─── Router-level guards ────────────────────────────────────────────────────

const ROUTES: { label: string; send: () => request.Test }[] = [
  { label: 'GET /', send: () => request(app).get(BASE) },
  { label: 'POST /', send: () => request(app).post(BASE).send({ channelId: 'ch-1', name: 'CI', type: 'generic' }) },
  { label: 'PATCH /:id', send: () => request(app).patch(`${BASE}/wh-1`).send({ enabled: false }) },
  { label: 'POST /:id/rotate', send: () => request(app).post(`${BASE}/wh-1/rotate`) },
  { label: 'DELETE /:id', send: () => request(app).delete(`${BASE}/wh-1?purge=1`) },
];

describe('router guards', () => {
  it('runs the auth chain: unauthenticated requests are 401 and touch nothing', async () => {
    h.auth.userId = null;
    for (const route of ROUTES) {
      const res = await route.send();
      expect(res.status).toBe(401);
    }
    expect(h.hasServerPermission).not.toHaveBeenCalled();
    expect(prismaCallCount()).toBe(0);
  });

  it('applies requireVerifiedEmail and requireConsent to every route', async () => {
    for (const route of ROUTES) {
      h.requireVerifiedEmail.mockClear();
      h.requireConsent.mockClear();
      await route.send();
      expect(h.requireVerifiedEmail).toHaveBeenCalledTimes(1);
      expect(h.requireConsent).toHaveBeenCalledTimes(1);
    }
  });

  it('flag off: every route answers 403 "Webhooks are currently disabled" before any permission or prisma call', async () => {
    h.flags.webhooks = false;
    for (const route of ROUTES) {
      const res = await route.send();
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Webhooks are currently disabled' });
    }
    expect(h.hasServerPermission).not.toHaveBeenCalled();
    expect(h.hasChannelPermission).not.toHaveBeenCalled();
    expect(h.filterVisibleChannels).not.toHaveBeenCalled();
    expect(prismaCallCount()).toBe(0);
    expect(h.emitted).toHaveLength(0);
  });

  it('a member without MANAGE_WEBHOOKS gets 403 on every route and nothing is read or written', async () => {
    h.hasServerPermission.mockResolvedValue(false);
    for (const route of ROUTES) {
      const res = await route.send();
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'You do not have permission to manage webhooks' });
    }
    expect(prismaCallCount()).toBe(0);
    expect(h.emitted).toHaveLength(0);
  });

  it('checks MANAGE_WEBHOOKS for the caller on the URL server', async () => {
    await request(app).get('/api/v1/servers/srv-9/webhooks');
    expect(h.hasServerPermission).toHaveBeenCalledWith('user-1', 'srv-9', Permissions.MANAGE_WEBHOOKS);
  });

  it('owner and ADMINISTRATOR pass (the calculator answers true for them)', async () => {
    h.hasServerPermission.mockResolvedValue(true);
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
  });

  it('a permission-calculator failure answers 500, not a pass', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.hasServerPermission.mockRejectedValue(new Error('db down'));
    const res = await request(app).get(BASE);
    expect(res.status).toBe(500);
    expect(prismaMock.webhook.findMany).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── GET / ──────────────────────────────────────────────────────────────────

describe('GET /servers/:serverId/webhooks', () => {
  it('lists the server webhooks oldest first, with a select that never reads tokenHash or secretEnc', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([listRow()]);
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);

    const args = prismaMock.webhook.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ serverId: 'srv-1' });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.select).not.toHaveProperty('tokenHash');
    expect(args.select).not.toHaveProperty('secretEnc');
    expect(args.select.createdBy).toEqual({ select: { id: true, username: true, displayName: true } });
    // The visibility filter fails open without `secure`
    expect(args.select.channel).toEqual({ select: { id: true, secure: true } });
    // Unpaginated: its length is the `total` the response reports
    expect(args).not.toHaveProperty('take');
    expect(args).not.toHaveProperty('skip');
    expect(args).not.toHaveProperty('cursor');
  });

  it('maps rows to the shared Webhook shape (ISO dates, createdBy null tolerated, no channel object)', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([
      listRow(),
      listRow({ id: 'wh-2', name: 'Kuma', enabled: false, createdBy: null, lastUsedAt: USED_AT }),
    ]);
    const res = await request(app).get(BASE);
    expect(res.body).toEqual({
      success: true,
      data: [
        {
          id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
          createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
          createdAt: CREATED_AT.toISOString(), lastUsedAt: null,
        },
        {
          id: 'wh-2', serverId: 'srv-1', channelId: 'ch-1', name: 'Kuma', type: 'generic', enabled: false,
          createdBy: null,
          createdAt: CREATED_AT.toISOString(), lastUsedAt: USED_AT.toISOString(),
        },
      ],
      total: 2,
    });
  });

  it('never leaks a credential even if a row carried one (the mapper picks fields explicitly)', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([
      { ...listRow(), tokenHash: 'a'.repeat(64), secretEnc: 'enc:secret', updatedAt: CREATED_AT, createdById: 'user-1' },
    ]);
    const res = await request(app).get(BASE);
    const item = res.body.data[0];
    expect(item).not.toHaveProperty('tokenHash');
    expect(item).not.toHaveProperty('secretEnc');
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('secret');
    expect(JSON.stringify(res.body)).not.toContain('a'.repeat(64));
  });

  it('is guarded by the read limiter, and emits nothing', async () => {
    await request(app).get(BASE);
    expect(h.limiterCalls).toEqual(['webhookRead']);
    expect(h.emitted).toHaveLength(0);
  });

  it('omits webhooks whose channel the caller cannot VIEW', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([
      listRow({ id: 'wh-1', channelId: 'ch-1' }),
      listRow({ id: 'wh-2', channelId: 'ch-staff' }),
      listRow({ id: 'wh-3', channelId: 'ch-1' }),
    ]);
    h.filterVisibleChannels.mockImplementation(async (_u: unknown, _s: unknown, channels: { id: string }[]) =>
      channels.filter((c) => c.id !== 'ch-staff'));

    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { id: string }) => w.id)).toEqual(['wh-1', 'wh-3']);
    expect(JSON.stringify(res.body)).not.toContain('ch-staff');
    // ...but the hidden one still counts toward the total (the cap counts it)
    expect(res.body.total).toBe(3);

    const [userId, serverId, channels] = h.filterVisibleChannels.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(serverId).toBe('srv-1');
    expect(channels).toEqual([
      { id: 'ch-1', secure: false },
      { id: 'ch-staff', secure: false },
      { id: 'ch-1', secure: false },
    ]);
  });

  it('an empty list skips the visibility filter', async () => {
    const res = await request(app).get(BASE);
    expect(res.body).toEqual({ success: true, data: [], total: 0 });
    expect(h.filterVisibleChannels).not.toHaveBeenCalled();
  });

  it('total is EVERY webhook of the server, the hidden ones included: the number the create cap counts', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([
      listRow({ id: 'wh-1', channelId: 'ch-staff' }),
      listRow({ id: 'wh-2', channelId: 'ch-staff' }),
      listRow({ id: 'wh-3', channelId: 'ch-mods' }),
    ]);
    h.filterVisibleChannels.mockResolvedValue([]);

    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [], total: 3 });
    // the same server scope as the cap's count({ where: { serverId } })
    expect(prismaMock.webhook.findMany.mock.calls[0][0].where).toEqual({ serverId: 'srv-1' });
    // a count only: no hidden channel id or name rides along
    expect(JSON.stringify(res.body)).not.toContain('ch-staff');
    expect(JSON.stringify(res.body)).not.toContain('ch-mods');
  });
});

// ─── POST / ─────────────────────────────────────────────────────────────────

describe('POST /servers/:serverId/webhooks', () => {
  const create = (body: unknown) => request(app).post(BASE).send(body as object);

  it('creates a webhook: 201 with a 43-char base64url token, only its sha256 stored', async () => {
    const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(res.status).toBe(201);

    const token: string = res.body.data.token;
    expect(token).toMatch(TOKEN_RE);

    const args = prismaMock.webhook.create.mock.calls[0][0];
    expect(args.data).toEqual({
      serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic',
      tokenHash: expect.stringMatching(HEX64_RE), createdById: 'user-1',
    });
    expect(args.data.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(args)).not.toContain(token);
    expect(args.select).not.toHaveProperty('tokenHash');
    expect(args.select).not.toHaveProperty('secretEnc');

    expect(res.body).toEqual({
      success: true,
      data: {
        id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
        createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
        createdAt: CREATED_AT.toISOString(), lastUsedAt: null,
        token,
      },
    });
    // No public URL is built server-side (the client composes it)
    expect(JSON.stringify(res.body)).not.toContain('/webhooks/');
  });

  it('emits webhook:changed to server:{id} with exactly { serverId }, and the token never rides a socket', async () => {
    const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
    expectChangedOnce();
    expect(h.emitted).toHaveLength(1);
    expect(JSON.stringify(h.emitted)).not.toContain(res.body.data.token);
  });

  it('every create mints a fresh token', async () => {
    const a = await create({ channelId: 'ch-1', name: 'A', type: 'generic' });
    const b = await create({ channelId: 'ch-1', name: 'B', type: 'generic' });
    expect(a.body.data.token).not.toBe(b.body.data.token);
  });

  it('is guarded by the manage limiter', async () => {
    await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(h.limiterCalls).toEqual(['webhookManage']);
  });

  it('refuses GitHub webhooks in this step', async () => {
    const res = await create({ channelId: 'ch-1', name: 'GH', type: 'github' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('GitHub webhooks are not available yet');
    expect(prismaMock.webhook.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown type', 'slack'],
    ['a missing type', undefined],
    ['a non-string type', 1],
    ['a case variant', 'Generic'],
  ])('400 "Invalid webhook type" for %s', async (_label, type) => {
    const res = await create({ channelId: 'ch-1', name: 'CI', type });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid webhook type');
    expect(prismaMock.webhook.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 42],
    ['an object', { id: 'ch-1' }],
  ])('400 "channelId is required" when channelId is %s', async (_label, channelId) => {
    const res = await create({ channelId, name: 'CI', type: 'generic' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('channelId is required');
    expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();
  });

  it('a body that is not an object (array, none) is a 400, not a 500', async () => {
    const arr = await request(app).post(BASE).send([{ channelId: 'ch-1' }]);
    expect(arr.status).toBe(400);
    const none = await request(app).post(BASE);
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('channelId is required');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a string', 7],
    ['missing', undefined],
    ['only markup', '<b></b>'],
  ])('400 "Webhook name cannot be empty" when the name is %s', async (_label, name) => {
    const res = await create({ channelId: 'ch-1', name, type: 'generic' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Webhook name cannot be empty');
    expect(prismaMock.webhook.create).not.toHaveBeenCalled();
  });

  it('400 for a 65-character name, 201 for 64', async () => {
    const long = await create({ channelId: 'ch-1', name: 'x'.repeat(65), type: 'generic' });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('Webhook name must be at most 64 characters');

    const max = await create({ channelId: 'ch-1', name: 'x'.repeat(64), type: 'generic' });
    expect(max.status).toBe(201);
  });

  it('sanitises the name before validating and storing it', async () => {
    const res = await create({ channelId: 'ch-1', name: '  <b>x</b>  ', type: 'generic' });
    expect(res.status).toBe(201);
    expect(prismaMock.webhook.create.mock.calls[0][0].data.name).toBe('x');
  });

  it('looks the channel up with a minimal select', async () => {
    await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(prismaMock.channel.findUnique).toHaveBeenCalledWith({
      where: { id: 'ch-1' },
      select: { id: true, serverId: true, type: true, secure: true },
    });
  });

  describe('channel checks', () => {
    async function notFoundBody() {
      prismaMock.channel.findUnique.mockResolvedValueOnce(null);
      const res = await create({ channelId: 'ch-x', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      return res.body;
    }

    it('404 "Channel not found" for a nonexistent channel', async () => {
      expect(await notFoundBody()).toEqual({ success: false, error: 'Channel not found' });
    });

    it('404 "Channel not found" for a channel of another server', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, serverId: 'srv-2' });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(await notFoundBody());
    });

    it('a SECURE channel answers byte-identically to a nonexistent one', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, secure: true });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      const expected = await notFoundBody();
      expect(res.body).toEqual(expected);
      expect(res.text).toBe(JSON.stringify(expected));
    });

    it('a secure VOICE channel is still a 404 (secure is decided before the type)', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, type: 'voice', secure: true });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found');
    });

    it('400 for a voice channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, type: 'voice' });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Webhooks can only post to text channels');
    });

    it('a channel the caller cannot VIEW answers byte-identically to a nonexistent one', async () => {
      h.hasChannelPermission.mockResolvedValueOnce(false);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      expect(h.hasChannelPermission).toHaveBeenCalledWith('user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL);
      const expected = await notFoundBody();
      expect(res.text).toBe(JSON.stringify(expected));
      expect(prismaMock.webhook.create).not.toHaveBeenCalled();
    });

    it('a hidden VOICE channel is a 404, not the text-only 400 (VIEW is decided before the type)', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, type: 'voice' });
      h.hasChannelPermission.mockResolvedValueOnce(false);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found');
    });

    it('the VIEW check never runs for a secure or foreign channel (decided before it)', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, secure: true });
      await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, serverId: 'srv-2' });
      await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(h.hasChannelPermission).not.toHaveBeenCalled();
    });

    it('a rejected channel creates nothing and emits nothing', async () => {
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, secure: true });
      await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(prismaMock.webhook.create).not.toHaveBeenCalled();
      expect(prismaMock.webhook.count).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });
  });

  describe('per-server cap', () => {
    it('counts this server only', async () => {
      await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(prismaMock.webhook.count).toHaveBeenCalledWith({ where: { serverId: 'srv-1' } });
      expect(getEffectiveLimits).toHaveBeenCalledWith('srv-1');
    });

    it('hardcoded default (no GlobalConfig row): 10, refused at the 10th existing', async () => {
      prismaMock.webhook.count.mockResolvedValue(9);
      expect((await create({ channelId: 'ch-1', name: 'CI', type: 'generic' })).status).toBe(201);

      prismaMock.webhook.count.mockResolvedValue(10);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Server can have at most 10 webhooks' });
    });

    it('global layer: GlobalConfig.maxWebhooksPerServer applies', async () => {
      prismaMock.globalConfig.findUnique.mockResolvedValue({ ...FULL_LIMITS, maxWebhooksPerServer: 3 });
      prismaMock.webhook.count.mockResolvedValue(3);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 3 webhooks');
    });

    it('server layer: a per-server override beats the global value', async () => {
      prismaMock.globalConfig.findUnique.mockResolvedValue({ ...FULL_LIMITS, maxWebhooksPerServer: 10 });
      prismaMock.serverLimits.findUnique.mockResolvedValue({
        maxChannelsPerServer: null, maxVoiceUsersPerChannel: null, maxCategoriesPerServer: null,
        maxMembersPerServer: null, maxWebhooksPerServer: 1,
      });
      prismaMock.webhook.count.mockResolvedValue(1);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 1 webhooks');
    });

    it('a null per-server override falls back to the global value', async () => {
      prismaMock.globalConfig.findUnique.mockResolvedValue({ ...FULL_LIMITS, maxWebhooksPerServer: 5 });
      prismaMock.serverLimits.findUnique.mockResolvedValue({
        maxChannelsPerServer: null, maxVoiceUsersPerChannel: null, maxCategoriesPerServer: null,
        maxMembersPerServer: null, maxWebhooksPerServer: null,
      });
      prismaMock.webhook.count.mockResolvedValue(4);
      expect((await create({ channelId: 'ch-1', name: 'CI', type: 'generic' })).status).toBe(201);
      prismaMock.webhook.count.mockResolvedValue(5);
      expect((await create({ channelId: 'ch-1', name: 'CI', type: 'generic' })).body.error)
        .toBe('Server can have at most 5 webhooks');
    });

    it('a per-server override of 0 freezes creation even with none existing', async () => {
      prismaMock.serverLimits.findUnique.mockResolvedValue({
        maxChannelsPerServer: null, maxVoiceUsersPerChannel: null, maxCategoriesPerServer: null,
        maxMembersPerServer: null, maxWebhooksPerServer: 0,
      });
      prismaMock.webhook.count.mockResolvedValue(0);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 0 webhooks');
      expect(prismaMock.webhook.create).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });

    it('uses whatever getEffectiveLimits resolves (maxWebhooksPerServer: 0)', async () => {
      vi.mocked(getEffectiveLimits).mockResolvedValueOnce({ ...FULL_LIMITS, maxWebhooksPerServer: 0 });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 0 webhooks');
    });
  });
});

// ─── PATCH /:webhookId ──────────────────────────────────────────────────────

describe('PATCH /servers/:serverId/webhooks/:webhookId', () => {
  const patch = (body: unknown, id = 'wh-1') => request(app).patch(`${BASE}/${id}`).send(body as object);

  it('renames (sanitised), answers the Webhook shape without a token, emits webhook:changed', async () => {
    const res = await patch({ name: ' <i>Deploys</i> ' });
    expect(res.status).toBe(200);
    const args = prismaMock.webhook.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'wh-1' });
    expect(args.data).toEqual({ name: 'Deploys' });
    expect(args.select).not.toHaveProperty('tokenHash');
    expect(args.select).not.toHaveProperty('secretEnc');
    expect(res.body.data).toMatchObject({ id: 'wh-1', name: 'Deploys' });
    expect(res.body.data).not.toHaveProperty('token');
    expect(res.body.data).not.toHaveProperty('tokenHash');
    expectChangedOnce();
    expect(h.limiterCalls).toEqual(['webhookManage']);
  });

  it('disables and enables', async () => {
    const off = await patch({ enabled: false });
    expect(off.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ enabled: false });
    expect(off.body.data.enabled).toBe(false);

    const on = await patch({ enabled: true });
    expect(prismaMock.webhook.update.mock.calls[1][0].data).toEqual({ enabled: true });
    expect(on.body.data.enabled).toBe(true);
  });

  it('moves to another text channel of the server, through the same channel checks', async () => {
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    const res = await patch({ channelId: 'ch-2' });
    expect(res.status).toBe(200);
    expect(prismaMock.channel.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ch-2' } }));
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ channelId: 'ch-2' });
    expect(res.body.data.channelId).toBe('ch-2');
  });

  it('updates several fields at once, and never the token hash', async () => {
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    await patch({ name: 'New', channelId: 'ch-2', enabled: false, tokenHash: 'f'.repeat(64), serverId: 'srv-2' });
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ name: 'New', channelId: 'ch-2', enabled: false });
  });

  it('400 "No fields to update" for an empty or unknown-only body', async () => {
    for (const body of [{}, { color: 'red' }, []]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No fields to update');
    }
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'false'],
    ['a number', 0],
    ['null', null],
  ])('400 "enabled must be a boolean" for %s', async (_label, enabled) => {
    const res = await patch({ enabled });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('enabled must be a boolean');
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });

  it('validates the name like create', async () => {
    const empty = await patch({ name: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('Webhook name cannot be empty');
    const long = await patch({ name: 'y'.repeat(65) });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('Webhook name must be at most 64 characters');
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });

  it('400 for a non-string or empty channelId', async () => {
    for (const channelId of [5, '', null]) {
      const res = await patch({ channelId });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('channelId must be a non-empty string');
    }
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });

  it('moving to a secure channel answers like a nonexistent one; to voice is a 400; to another server is a 404', async () => {
    prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, secure: true });
    const secure = await patch({ channelId: 'ch-s' });
    expect(secure.status).toBe(404);
    expect(secure.body).toEqual({ success: false, error: 'Channel not found' });

    prismaMock.channel.findUnique.mockResolvedValueOnce(null);
    const missing = await patch({ channelId: 'ch-x' });
    expect(missing.body).toEqual(secure.body);

    prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, serverId: 'srv-2' });
    const foreign = await patch({ channelId: 'ch-f' });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(secure.body);

    prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, type: 'voice' });
    const voice = await patch({ channelId: 'ch-v' });
    expect(voice.status).toBe(400);
    expect(voice.body.error).toBe('Webhooks can only post to text channels');

    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('404 "Webhook not found" for a webhook of another server, identical to a missing one', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-9', serverId: 'srv-2', channelId: 'ch-9' });
    const foreign = await patch({ enabled: false }, 'wh-9');
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ success: false, error: 'Webhook not found' });

    prismaMock.webhook.findUnique.mockResolvedValueOnce(null);
    const missing = await patch({ enabled: false }, 'wh-0');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(foreign.body);

    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('checks ownership before the channel (a foreign webhook id never reaches the channel lookup)', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-9', serverId: 'srv-2', channelId: 'ch-9' });
    const res = await patch({ channelId: 'ch-2' }, 'wh-9');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Webhook not found');
    expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();
  });
});

// ─── POST /:webhookId/rotate ────────────────────────────────────────────────

describe('POST /servers/:serverId/webhooks/:webhookId/rotate', () => {
  const rotate = (id = 'wh-1') => request(app).post(`${BASE}/${id}/rotate`);

  it('mints a new token and stores only its hash, replacing the old one', async () => {
    const oldHash = sha256('the-old-token');
    const res = await rotate();
    expect(res.status).toBe(200);

    const token: string = res.body.data.token;
    expect(token).toMatch(TOKEN_RE);

    const args = prismaMock.webhook.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'wh-1' });
    expect(args.data).toEqual({ tokenHash: sha256(token) });
    expect(args.data.tokenHash).toMatch(HEX64_RE);
    expect(args.data.tokenHash).not.toBe(oldHash);
    expect(JSON.stringify(args)).not.toContain(token);
    expect(args.select).not.toHaveProperty('tokenHash');

    expect(res.body.data).toMatchObject({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(res.body.data).not.toHaveProperty('tokenHash');
  });

  it('two rotations give two different tokens (the previous one is dead)', async () => {
    const a = await rotate();
    const b = await rotate();
    expect(a.body.data.token).not.toBe(b.body.data.token);
    const hashes = prismaMock.webhook.update.mock.calls.map((c: any[]) => c[0].data.tokenHash);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('emits webhook:changed with only the server id (no token on the socket)', async () => {
    const res = await rotate();
    expectChangedOnce();
    expect(JSON.stringify(h.emitted)).not.toContain(res.body.data.token);
    expect(h.limiterCalls).toEqual(['webhookManage']);
  });

  it('404 for a webhook of another server; nothing rotated', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-9', serverId: 'srv-2', channelId: 'ch-9' });
    const res = await rotate('wh-9');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Webhook not found');
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

// ─── DELETE /:webhookId ─────────────────────────────────────────────────────

describe('DELETE /servers/:serverId/webhooks/:webhookId', () => {
  const del = (query = '', id = 'wh-1') => request(app).delete(`${BASE}/${id}${query}`);

  it('without purge: deletes the row only, keeps its messages, no bulk event', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedMessages: 0 } });
    expect(prismaMock.webhook.findUnique).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      select: { id: true, serverId: true, channelId: true },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.webhook.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(eventsNamed('message:bulk_deleted')).toHaveLength(0);
    expectChangedOnce();
    expect(h.limiterCalls).toEqual(['webhookManage']);
  });

  it('locks the webhook row FOR UPDATE as the first statement of the transaction', async () => {
    // A concurrent delivery's INSERT takes a KEY SHARE on this row (FK check):
    // locked first, it waits for the commit and then fails its FK, so no
    // message can land between the purge and the delete.
    txMock.message.groupBy.mockResolvedValue([{ channelId: 'ch-1', _count: { _all: 2 } }]);
    txMock.message.deleteMany.mockResolvedValue({ count: 2 });
    await del('?purge=1');

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = txMock.$queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toBe('SELECT id FROM webhooks WHERE id = ? FOR UPDATE');
    expect(values).toEqual(['wh-1']);

    const lock = txMock.$queryRaw.mock.invocationCallOrder[0];
    const group = txMock.message.groupBy.mock.invocationCallOrder[0];
    const purge = txMock.message.deleteMany.mock.invocationCallOrder[0];
    const drop = txMock.webhook.delete.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(group);
    expect(group).toBeLessThan(purge);
    expect(purge).toBeLessThan(drop);
  });

  it('takes the same lock without purge, before the delete', async () => {
    await del();
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(txMock.webhook.delete.mock.invocationCallOrder[0]);
  });

  it('a concurrent delete that won the lock: no locked row answers 404, deletes nothing, emits nothing', async () => {
    txMock.$queryRaw.mockResolvedValue([]);
    const res = await del('?purge=1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(txMock.webhook.delete).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it.each(['?purge=1', '?purge=true'])('with %s: purges its messages first, in the same transaction', async (query) => {
    txMock.message.groupBy.mockResolvedValue([{ channelId: 'ch-1', _count: { _all: 7 } }]);
    txMock.message.deleteMany.mockResolvedValue({ count: 7 });
    const res = await del(query);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedMessages: 7 } });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.message.groupBy).toHaveBeenCalledWith({
      by: ['channelId'],
      where: { webhookId: 'wh-1' },
      _count: { _all: true },
    });
    expect(txMock.message.deleteMany).toHaveBeenCalledWith({ where: { webhookId: 'wh-1' } });
    expect(txMock.webhook.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    expect(txMock.message.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(txMock.webhook.delete.mock.invocationCallOrder[0]);

    const bulk = eventsNamed('message:bulk_deleted');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].room).toBe('channel:ch-1');
    expect(bulk[0].payload).toEqual({ channelId: 'ch-1', webhookId: 'wh-1', count: 7 });
    expectChangedOnce();
    // The channel id travels ONLY to the channel room
    expect(h.emitted.filter((e) => e.room.startsWith('server:') && JSON.stringify(e.payload).includes('ch-1'))).toHaveLength(0);
  });

  it('purges EVERY channel the webhook posted to (it may have been moved), one receipt per channel', async () => {
    // Moved from ch-old to ch-1 with PATCH: its earlier rows stayed in ch-old
    txMock.message.groupBy.mockResolvedValue([
      { channelId: 'ch-1', _count: { _all: 4 } },
      { channelId: 'ch-old', _count: { _all: 9 } },
    ]);
    txMock.message.deleteMany.mockResolvedValue({ count: 13 });
    const res = await del('?purge=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedMessages: 13 } });

    // scoped by the webhook alone, never by its current channel
    expect(txMock.message.deleteMany).toHaveBeenCalledTimes(1);
    expect(txMock.message.deleteMany).toHaveBeenCalledWith({ where: { webhookId: 'wh-1' } });

    const bulk = eventsNamed('message:bulk_deleted');
    expect(bulk).toHaveLength(2);
    expect(bulk).toEqual(expect.arrayContaining([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 4 } },
      { room: 'channel:ch-old', event: 'message:bulk_deleted', payload: { channelId: 'ch-old', webhookId: 'wh-1', count: 9 } },
    ]));
    // each channel id only ever reaches its own room
    for (const e of bulk) expect(e.room).toBe(`channel:${(e.payload as { channelId: string }).channelId}`);
    expectChangedOnce();
    // webhook:changed is the LAST event, after every receipt
    expect(h.emitted[h.emitted.length - 1].event).toBe('webhook:changed');
  });

  it('the purge scope is the webhook id, never anything from the request', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-7' });
    txMock.message.groupBy.mockResolvedValue([{ channelId: 'ch-7', _count: { _all: 1 } }]);
    txMock.message.deleteMany.mockResolvedValue({ count: 1 });
    await request(app).delete(`${BASE}/wh-1?purge=1`).send({ channelId: 'ch-evil' });
    expect(txMock.message.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { webhookId: 'wh-1' } }));
    expect(txMock.message.deleteMany).toHaveBeenCalledWith({ where: { webhookId: 'wh-1' } });
    expect(eventsNamed('message:bulk_deleted').map((e) => e.room)).toEqual(['channel:ch-7']);
  });

  it('a purge that removed nothing still emits ONE message:bulk_deleted with count 0, to the current channel', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-7' });
    txMock.message.groupBy.mockResolvedValue([]);
    txMock.message.deleteMany.mockResolvedValue({ count: 0 });
    const res = await del('?purge=1');
    expect(res.body.data.deletedMessages).toBe(0);
    const bulk = eventsNamed('message:bulk_deleted');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].room).toBe('channel:ch-7');
    expect(bulk[0].payload).toEqual({ channelId: 'ch-7', webhookId: 'wh-1', count: 0 });
    expectChangedOnce();
    expect(h.emitted[h.emitted.length - 1].event).toBe('webhook:changed');
  });

  it.each(['?purge=0', '?purge=yes', '?purge=', '?purge=TRUE'])('%s does not purge', async (query) => {
    await del(query);
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(txMock.webhook.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    expect(eventsNamed('message:bulk_deleted')).toHaveLength(0);
    expectChangedOnce();
  });

  it('404 for a webhook of another server: no transaction, no events', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-9', serverId: 'srv-2', channelId: 'ch-9' });
    const res = await del('?purge=1', 'wh-9');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('a failed transaction answers 500 and emits nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    txMock.message.deleteMany.mockResolvedValue({ count: 3 });
    txMock.webhook.delete.mockRejectedValue(new Error('deadlock'));
    const res = await del('?purge=1');
    expect(res.status).toBe(500);
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('the response never carries a token or hash', async () => {
    const res = await del('?purge=1');
    expect(Object.keys(res.body.data)).toEqual(['deletedMessages']);
  });
});

// ─── Channels the caller cannot VIEW ────────────────────────────────────────

describe('a webhook on a channel the caller cannot VIEW does not exist for them', () => {
  // The webhook wh-1 posts to ch-staff, which this caller cannot see
  beforeEach(() => {
    prismaMock.webhook.findUnique.mockResolvedValue({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-staff' });
    h.hasChannelPermission.mockImplementation(async (_u: unknown, channelId: string) => channelId !== 'ch-staff');
  });

  const NOT_FOUND = { success: false, error: 'Webhook not found' };

  it('PATCH answers 404 "Webhook not found" and writes nothing', async () => {
    const res = await request(app).patch(`${BASE}/wh-1`).send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(h.hasChannelPermission).toHaveBeenCalledWith('user-1', 'ch-staff', 'srv-1', Permissions.VIEW_CHANNEL);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('rotate answers 404 and mints no credential for the hidden channel', async () => {
    const res = await request(app).post(`${BASE}/wh-1/rotate`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(res.body).not.toHaveProperty('data');
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('DELETE (with purge) answers 404 and deletes nothing', async () => {
    const res = await request(app).delete(`${BASE}/wh-1?purge=1`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('the 404 is byte-identical to the one for a missing id', async () => {
    const hidden = await request(app).post(`${BASE}/wh-1/rotate`);
    prismaMock.webhook.findUnique.mockResolvedValueOnce(null);
    const missing = await request(app).post(`${BASE}/wh-0/rotate`);
    expect(hidden.text).toBe(missing.text);
  });

  it('PATCH cannot MOVE a visible webhook into a hidden channel', async () => {
    prismaMock.webhook.findUnique.mockResolvedValue({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1' });
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-staff' });
    const res = await request(app).patch(`${BASE}/wh-1`).send({ channelId: 'ch-staff' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Channel not found' });
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });
});
