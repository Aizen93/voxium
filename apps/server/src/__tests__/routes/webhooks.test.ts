import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  filterChannelsWithPermissions: vi.fn(),
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
  filterChannelsWithPermissions: (...args: unknown[]) => h.filterChannelsWithPermissions(...args),
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
  // The row locks: the delete's on the webhook row, the create's on the server row
  $queryRaw: vi.fn(),
  message: { groupBy: vi.fn(), deleteMany: vi.fn() },
  // findUnique: the shared delete (utils/webhookLifecycle.ts) reads the row
  // again under its lock; see the beforeEach. count + create: the create's
  // cap check and insert, under the server-row lock
  webhook: { delete: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
};

const prismaMock: Record<string, any> = {
  webhook: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    // The disable the shared delete commits BEFORE its transaction
    updateMany: vi.fn(),
    // Deliberately no `delete`, `count` or `create` here and no `message`
    // model: the delete and the capped create must run on the transaction
    // client, never on the root client.
  },
  // findMany: GET /targets
  channel: { findUnique: vi.fn(), findMany: vi.fn() },
  globalConfig: { findUnique: vi.fn() },
  serverLimits: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  // the history batches of the shared delete (root client): nothing to move by default
  $executeRaw: vi.fn().mockResolvedValue(0),
  $queryRaw: vi.fn().mockResolvedValue([]),
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
import { openSecret } from '../../utils/secretBox';

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
    adminDisabledAt: null,
    creatorRemovedAt: null,
    createdAt: CREATED_AT,
    lastUsedAt: null,
    lastRotatedAt: null,
    createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
    lastRotatedBy: null,
    ...overrides,
  };
}

/** The owner-decision fields of a webhook nobody locked, removed or rotated. */
const UNTOUCHED = { adminDisabledAt: null, creatorRemovedAt: null, lastRotatedAt: null, lastRotatedBy: null };

/** What loadOwnWebhook selects: ownership, type, and the admin lock (the
 *  creator-removal mark is never read: an enable or a rotate clears it unconditionally). */
const OWN_SELECT = { id: true, serverId: true, channelId: true, type: true, adminDisabledAt: true };

const ADMIN_DISABLED = { success: false, error: 'This webhook was disabled by an administrator' };
const NO_SEND = { success: false, error: 'You do not have permission to send messages in this channel' };

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

/** What Prisma throws when the row to update is gone (a concurrent delete),
 *  or no longer matches the write's extra filter (a concurrent move). */
function recordNotFound() {
  return Object.assign(new Error('Record to update not found.'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2025',
    clientVersion: '7.0.0',
  });
}

/** What Prisma throws when a written channel id no longer exists (the FK). */
function foreignKeyViolation() {
  return Object.assign(new Error('Foreign key constraint violated on the constraint: `webhooks_channel_id_fkey`'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2003',
    clientVersion: '7.0.0',
  });
}

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
  h.filterChannelsWithPermissions.mockImplementation(async (_u: unknown, _s: unknown, channels: unknown[]) => channels);

  prismaMock.webhook.findMany.mockResolvedValue([]);
  prismaMock.webhook.findUnique.mockResolvedValue({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1' });
  txMock.webhook.count.mockResolvedValue(0);
  txMock.webhook.create.mockImplementation(async ({ data }: any) => webhookRow({
    name: data.name, channelId: data.channelId, type: data.type,
  }));
  prismaMock.webhook.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.webhook.update.mockImplementation(async ({ data }: any) => webhookRow({
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.channelId !== undefined ? { channelId: data.channelId } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
  }));
  prismaMock.channel.findUnique.mockResolvedValue(textChannel);
  prismaMock.channel.findMany.mockResolvedValue([]);
  prismaMock.globalConfig.findUnique.mockResolvedValue(null);
  prismaMock.serverLimits.findUnique.mockResolvedValue(null);
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  txMock.$queryRaw.mockResolvedValue([{ id: 'wh-1' }]);
  txMock.message.groupBy.mockResolvedValue([]);
  txMock.message.deleteMany.mockResolvedValue({ count: 0 });
  txMock.webhook.delete.mockResolvedValue({ id: 'wh-1' });
  // Under the lock the delete re-reads the row the route already loaded: a
  // real database returns the same row to both reads, so answer whatever the
  // root client's last findUnique answered (a test's mockResolvedValueOnce
  // included)
  txMock.webhook.findUnique.mockImplementation(async () => {
    const last = prismaMock.webhook.findUnique.mock.results.at(-1);
    return last ? { name: 'CI', type: 'generic', ...(await last.value) } : null;
  });

  app = createApp();
});

// ─── Router-level guards ────────────────────────────────────────────────────

const ROUTES: { label: string; send: () => request.Test }[] = [
  { label: 'GET /', send: () => request(app).get(BASE) },
  { label: 'POST /', send: () => request(app).post(BASE).send({ channelId: 'ch-1', name: 'CI', type: 'generic' }) },
  { label: 'PATCH /:id', send: () => request(app).patch(`${BASE}/wh-1`).send({ enabled: false }) },
  { label: 'POST /:id/rotate', send: () => request(app).post(`${BASE}/wh-1/rotate`) },
  { label: 'DELETE /:id', send: () => request(app).delete(`${BASE}/wh-1?purge=1`) },
  { label: 'GET /targets', send: () => request(app).get(`${BASE}/targets`) },
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

  it('a caller the calculator allows passes (owner and ADMINISTRATOR are the calculator\'s business, mocked here)', async () => {
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
          ...UNTOUCHED,
        },
        {
          id: 'wh-2', serverId: 'srv-1', channelId: 'ch-1', name: 'Kuma', type: 'generic', enabled: false,
          createdBy: null,
          createdAt: CREATED_AT.toISOString(), lastUsedAt: USED_AT.toISOString(),
          ...UNTOUCHED,
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

    const args = txMock.webhook.create.mock.calls[0][0];
    expect(args.data).toEqual({
      serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic',
      tokenHash: expect.stringMatching(HEX64_RE), secretEnc: null, createdById: 'user-1',
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
        ...UNTOUCHED,
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

  describe('GitHub webhooks (a signing secret, sealed at rest, shown once)', () => {
    const TEST_KEY = '5e'.repeat(32);
    let savedKey: string | undefined;

    beforeEach(() => {
      savedKey = process.env.TOTP_ENCRYPTION_KEY;
      process.env.TOTP_ENCRYPTION_KEY = TEST_KEY;
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
      else process.env.TOTP_ENCRYPTION_KEY = savedKey;
    });

    it('201 with a 43-char token AND a 64-hex secret; only the hash and the SEALED secret are stored', async () => {
      const res = await create({ channelId: 'ch-1', name: 'GH', type: 'github' });
      expect(res.status).toBe(201);

      const { token, secret } = res.body.data;
      expect(token).toMatch(TOKEN_RE);
      expect(secret).toMatch(HEX64_RE);

      const args = txMock.webhook.create.mock.calls[0][0];
      expect(args.data).toEqual({
        serverId: 'srv-1', channelId: 'ch-1', name: 'GH', type: 'github',
        tokenHash: sha256(token), secretEnc: expect.stringMatching(/^enc:/), createdById: 'user-1',
      });
      // The stored value is the seal of exactly the secret shown, never the plaintext
      expect(openSecret(args.data.secretEnc)).toBe(secret);
      expect(JSON.stringify(args)).not.toContain(secret);
      expect(JSON.stringify(args)).not.toContain(token);
      expect(args.select).not.toHaveProperty('secretEnc');

      expect(res.body).toEqual({
        success: true,
        data: {
          id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'GH', type: 'github', enabled: true,
          createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
          createdAt: CREATED_AT.toISOString(), lastUsedAt: null,
          ...UNTOUCHED,
          token, secret,
        },
      });
      expect(res.body.data).not.toHaveProperty('secretEnc');
    });

    it('every create mints a fresh secret, and neither secret nor seal rides a socket', async () => {
      const a = await create({ channelId: 'ch-1', name: 'A', type: 'github' });
      const b = await create({ channelId: 'ch-1', name: 'B', type: 'github' });
      expect(a.body.data.secret).not.toBe(b.body.data.secret);
      const seals = txMock.webhook.create.mock.calls.map((c: any[]) => c[0].data.secretEnc);
      expect(seals[0]).not.toBe(seals[1]);
      const wire = JSON.stringify(h.emitted);
      expect(wire).not.toContain(a.body.data.secret);
      expect(wire).not.toContain(seals[0]);
    });

    it('503 when the server has no usable encryption key, before the cap, the channel or the create', async () => {
      delete process.env.TOTP_ENCRYPTION_KEY;
      const res = await create({ channelId: 'ch-1', name: 'GH', type: 'github' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ success: false, error: 'GitHub webhooks are not configured on this server' });
      expect(txMock.webhook.count).not.toHaveBeenCalled();
      expect(getEffectiveLimits).not.toHaveBeenCalled();
      expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();
      expect(txMock.webhook.create).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });

    it('a key of the wrong length counts as no key', async () => {
      process.env.TOTP_ENCRYPTION_KEY = 'ab'.repeat(16);
      const res = await create({ channelId: 'ch-1', name: 'GH', type: 'github' });
      expect(res.status).toBe(503);
      expect(txMock.webhook.create).not.toHaveBeenCalled();
    });

    it('a generic webhook needs no key: it is created without one, with no secret', async () => {
      delete process.env.TOTP_ENCRYPTION_KEY;
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(201);
      expect(res.body.data).not.toHaveProperty('secret');
      expect(txMock.webhook.create.mock.calls[0][0].data.secretEnc).toBeNull();
    });
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
    expect(txMock.webhook.create).not.toHaveBeenCalled();
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
    expect(txMock.webhook.create).not.toHaveBeenCalled();
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
    expect(txMock.webhook.create.mock.calls[0][0].data.name).toBe('x');
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
      expect(txMock.webhook.create).not.toHaveBeenCalled();
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
      expect(txMock.webhook.create).not.toHaveBeenCalled();
      expect(txMock.webhook.count).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });

    // ── SEND_MESSAGES: a webhook must not become a way around it ──

    /** VIEW granted, SEND_MESSAGES refused (a read-only announcements channel). */
    function viewButNoSend() {
      h.hasChannelPermission.mockImplementation(async (...args: unknown[]) => args[3] !== Permissions.SEND_MESSAGES);
    }

    it('a channel the caller can VIEW but not SEND in: 403 with the messages.ts sentence, nothing created', async () => {
      viewButNoSend();
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'You do not have permission to send messages in this channel' });
      expect(h.hasChannelPermission).toHaveBeenCalledWith('user-1', 'ch-1', 'srv-1', Permissions.SEND_MESSAGES);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(txMock.webhook.create).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });

    it('VIEW and SEND granted: created, with VIEW asked first, then SEND', async () => {
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(201);
      expect(h.hasChannelPermission.mock.calls).toEqual([
        ['user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL],
        ['user-1', 'ch-1', 'srv-1', Permissions.SEND_MESSAGES],
      ]);
    });

    it('a secure channel is still the 404 first: no permission is asked, SEND or otherwise', async () => {
      viewButNoSend();
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, secure: true });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'Channel not found' });
      expect(h.hasChannelPermission).not.toHaveBeenCalled();
    });

    it('a hidden channel is the 404 before SEND is asked (no "exists, read-only" leak)', async () => {
      h.hasChannelPermission.mockResolvedValue(false);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found');
      expect(h.hasChannelPermission.mock.calls).toEqual([['user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL]]);
    });

    it('SEND is decided before the type: a visible read-only voice channel is the 403, not the text-only 400', async () => {
      viewButNoSend();
      prismaMock.channel.findUnique.mockResolvedValueOnce({ ...textChannel, type: 'voice' });
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(403);
    });
  });

  it('a channel deleted between the checks and the insert (P2003) answers 404 "Channel not found": no stack, nothing emitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    txMock.webhook.create.mockRejectedValueOnce(foreignKeyViolation());
    const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Channel not found' });
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('any other insert failure is still a 500, and emits nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    txMock.webhook.create.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'P1017' }));
    const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(res.status).toBe(500);
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  describe('per-server cap', () => {
    it('counts this server only', async () => {
      await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(txMock.webhook.count).toHaveBeenCalledWith({ where: { serverId: 'srv-1' } });
      expect(getEffectiveLimits).toHaveBeenCalledWith('srv-1');
    });

    it('counts and creates in ONE transaction whose FIRST statement locks the server row', async () => {
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(201);

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = txMock.$queryRaw.mock.calls[0];
      expect((strings as string[]).join('?')).toBe('SELECT id FROM servers WHERE id = ? FOR UPDATE');
      expect(values).toEqual(['srv-1']);
      const lock = txMock.$queryRaw.mock.invocationCallOrder[0];
      const count = txMock.webhook.count.mock.invocationCallOrder[0];
      const insert = txMock.webhook.create.mock.invocationCallOrder[0];
      expect(lock).toBeLessThan(count);
      expect(count).toBeLessThan(insert);
    });

    it('announces webhook:changed only once the transaction has committed', async () => {
      const emittedInside: number[] = [];
      prismaMock.$transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => unknown) => {
        const out = await cb(txMock);
        emittedInside.push(h.emitted.length);
        return out;
      });
      await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(emittedInside).toEqual([0]);
      expectChangedOnce();
    });

    it('two parallel creates against a cap of 1: the server-row lock serialises them, exactly one is created', async () => {
      prismaMock.globalConfig.findUnique.mockResolvedValue({ ...FULL_LIMITS, maxWebhooksPerServer: 1 });
      // A database in miniature: the lock statement waits for the previous
      // holder and holds until its transaction ends; count reads the rows
      // committed so far
      let rows = 0;
      let held: Promise<void> = Promise.resolve();
      prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
        let release: (() => void) | undefined;
        const tx = {
          ...txMock,
          $queryRaw: vi.fn(async () => {
            const previous = held;
            held = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            return [{ id: 'srv-1' }];
          }),
          webhook: {
            ...txMock.webhook,
            count: vi.fn(async () => rows),
            create: vi.fn(async ({ data }: any) => {
              // yield first, as a real insert would: the other request runs meanwhile
              await new Promise((resolve) => setTimeout(resolve, 5));
              rows += 1;
              return webhookRow({ name: data.name });
            }),
          },
        };
        try {
          return await cb(tx);
        } finally {
          release?.();
        }
      });

      const [a, b] = await Promise.all([
        create({ channelId: 'ch-1', name: 'A', type: 'generic' }),
        create({ channelId: 'ch-1', name: 'B', type: 'generic' }),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 400]);
      expect([a.body.error, b.body.error]).toContain('Server can have at most 1 webhooks');
      expect(rows).toBe(1);
    });

    it('the cap refusal is raised INSIDE the transaction (rolled back): same 400 text, nothing created or emitted', async () => {
      txMock.webhook.count.mockResolvedValue(10);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Server can have at most 10 webhooks' });
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(txMock.webhook.create).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });

    it('hardcoded default (no GlobalConfig row): 10, refused at the 10th existing', async () => {
      txMock.webhook.count.mockResolvedValue(9);
      expect((await create({ channelId: 'ch-1', name: 'CI', type: 'generic' })).status).toBe(201);

      txMock.webhook.count.mockResolvedValue(10);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Server can have at most 10 webhooks' });
    });

    it('global layer: GlobalConfig.maxWebhooksPerServer applies', async () => {
      prismaMock.globalConfig.findUnique.mockResolvedValue({ ...FULL_LIMITS, maxWebhooksPerServer: 3 });
      txMock.webhook.count.mockResolvedValue(3);
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
      txMock.webhook.count.mockResolvedValue(1);
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
      txMock.webhook.count.mockResolvedValue(4);
      expect((await create({ channelId: 'ch-1', name: 'CI', type: 'generic' })).status).toBe(201);
      txMock.webhook.count.mockResolvedValue(5);
      expect((await create({ channelId: 'ch-1', name: 'CI', type: 'generic' })).body.error)
        .toBe('Server can have at most 5 webhooks');
    });

    it('a per-server override of 0 freezes creation even with none existing', async () => {
      prismaMock.serverLimits.findUnique.mockResolvedValue({
        maxChannelsPerServer: null, maxVoiceUsersPerChannel: null, maxCategoriesPerServer: null,
        maxMembersPerServer: null, maxWebhooksPerServer: 0,
      });
      txMock.webhook.count.mockResolvedValue(0);
      const res = await create({ channelId: 'ch-1', name: 'CI', type: 'generic' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 0 webhooks');
      expect(txMock.webhook.create).not.toHaveBeenCalled();
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
    expect(args.where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
    expect(args.data).toEqual({ name: 'Deploys' });
    expect(args.select).not.toHaveProperty('tokenHash');
    expect(args.select).not.toHaveProperty('secretEnc');
    expect(res.body.data).toMatchObject({ id: 'wh-1', name: 'Deploys' });
    expect(res.body.data).not.toHaveProperty('token');
    expect(res.body.data).not.toHaveProperty('tokenHash');
    expectChangedOnce();
    expect(h.limiterCalls).toEqual(['webhookManage']);
  });

  it('disables and enables (an enable also clears the creator-removal mark)', async () => {
    const off = await patch({ enabled: false });
    expect(off.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ enabled: false });
    expect(off.body.data.enabled).toBe(false);

    const on = await patch({ enabled: true });
    expect(prismaMock.webhook.update.mock.calls[1][0].data).toEqual({ enabled: true, creatorRemovedAt: null });
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

  it('a webhook deleted between the ownership read and the update (P2025) is 404 "Webhook not found": no stack logged, nothing emitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.update.mockRejectedValueOnce(recordNotFound());
    const res = await patch({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.webhook.update).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('any other update failure is still a 500, and emits nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.update.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'P1017' }));
    const res = await patch({ enabled: false });
    expect(res.status).toBe(500);
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('a move is conditional on the OLD channel (the one VIEW was checked on); the data carries the new one', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-7' });
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    const res = await patch({ channelId: 'ch-2' });
    expect(res.status).toBe(200);
    const args = prismaMock.webhook.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'wh-1', channelId: 'ch-7' });
    expect(args.data).toEqual({ channelId: 'ch-2' });
  });

  it('a webhook moved by someone else after the VIEW check: the conditional write matches nothing → 404, nothing emitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The row now posts to ch-hidden: a write conditional on the checked ch-1 finds no row (P2025)
    prismaMock.webhook.update.mockImplementationOnce(async ({ where }: any) => {
      if (where.channelId !== 'ch-hidden') throw recordNotFound();
      return webhookRow({ channelId: 'ch-hidden' });
    });
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.webhook.update.mock.calls[0][0].where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('a target channel deleted between its checks and the move (P2003) is 404 "Channel not found", nothing emitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    prismaMock.webhook.update.mockRejectedValueOnce(foreignKeyViolation());
    const res = await patch({ channelId: 'ch-2' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Channel not found' });
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('moving into a channel the caller can see but not SEND in is the 403; nothing updated or emitted', async () => {
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-ro' });
    h.hasChannelPermission.mockImplementation(async (...args: unknown[]) => !(args[1] === 'ch-ro' && args[3] === Permissions.SEND_MESSAGES));
    const res = await patch({ channelId: 'ch-ro' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'You do not have permission to send messages in this channel' });
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('a rename or a DISABLE never asks SEND_MESSAGES (neither binds nor reopens a channel)', async () => {
    await patch({ name: 'New', enabled: false });
    await patch({ name: 'Newer' });
    await patch({ enabled: false });
    const asked = h.hasChannelPermission.mock.calls.map((c: unknown[]) => c[3]);
    expect(asked).toEqual([Permissions.VIEW_CHANNEL, Permissions.VIEW_CHANNEL, Permissions.VIEW_CHANNEL]);
    expect(prismaMock.webhook.update).toHaveBeenCalledTimes(3);
  });

  it('an ENABLE asks SEND_MESSAGES on the webhook\'s own channel, after VIEW', async () => {
    const res = await patch({ enabled: true });
    expect(res.status).toBe(200);
    expect(h.hasChannelPermission.mock.calls).toEqual([
      ['user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL],
      ['user-1', 'ch-1', 'srv-1', Permissions.SEND_MESSAGES],
    ]);
  });
});

// ─── POST /:webhookId/rotate ────────────────────────────────────────────────

describe('POST /servers/:serverId/webhooks/:webhookId/rotate', () => {
  const rotate = (id = 'wh-1') => request(app).post(`${BASE}/${id}/rotate`);

  it('on a channel the caller can see but not SEND in: 403, nothing rotated, no token, nothing emitted', async () => {
    // A read-only announcements channel: VIEW granted, SEND_MESSAGES refused by an override
    h.hasChannelPermission.mockImplementation(async (...args: unknown[]) => args[3] !== Permissions.SEND_MESSAGES);
    const res = await rotate();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'You do not have permission to send messages in this channel' });
    expect(res.body).not.toHaveProperty('data');
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('asks VIEW first (a hidden channel stays a 404), then SEND_MESSAGES on the webhook\'s own channel, before minting', async () => {
    await rotate();
    const calls = h.hasChannelPermission.mock.calls as unknown[][];
    expect(calls.map((c) => c[3])).toEqual([Permissions.VIEW_CHANNEL, Permissions.SEND_MESSAGES]);
    expect(calls[1][1]).toBe(calls[0][1]);
    expect(prismaMock.webhook.update).toHaveBeenCalledTimes(1);
  });

  it('mints a new token and stores only its hash, replacing the old one', async () => {
    // The stored row carries a known hash: the update must replace it, never copy it
    const oldHash = sha256('the-old-token');
    prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', type: 'generic', tokenHash: oldHash });
    const res = await rotate();
    expect(res.status).toBe(200);

    const token: string = res.body.data.token;
    expect(token).toMatch(TOKEN_RE);

    const args = prismaMock.webhook.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
    expect(args.data).toEqual({
      tokenHash: sha256(token),
      lastRotatedAt: expect.any(Date), lastRotatedById: 'user-1', creatorRemovedAt: null,
    });
    expect(args.data.tokenHash).toMatch(HEX64_RE);
    expect(args.data.tokenHash).not.toBe(oldHash);
    expect(JSON.stringify(args)).not.toContain(token);
    expect(args.select).not.toHaveProperty('tokenHash');

    expect(res.body.data).toMatchObject({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(res.body.data).not.toHaveProperty('tokenHash');
    // A generic webhook has no secret to renew or show
    expect(res.body.data).not.toHaveProperty('secret');
    expect(args.data).not.toHaveProperty('secretEnc');
  });

  it("loads the webhook's type with its ownership fields and marks, never a credential", async () => {
    await rotate();
    expect(prismaMock.webhook.findUnique).toHaveBeenCalledWith({ where: { id: 'wh-1' }, select: OWN_SELECT });
  });

  describe('a GitHub webhook: rotation renews both the token and the secret', () => {
    const TEST_KEY = '5e'.repeat(32);
    let savedKey: string | undefined;

    beforeEach(() => {
      savedKey = process.env.TOTP_ENCRYPTION_KEY;
      process.env.TOTP_ENCRYPTION_KEY = TEST_KEY;
      prismaMock.webhook.findUnique.mockResolvedValue({ id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', type: 'github' });
      prismaMock.webhook.update.mockImplementation(async () => webhookRow({ type: 'github', name: 'GH' }));
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
      else process.env.TOTP_ENCRYPTION_KEY = savedKey;
    });

    it('one update stores the new hash and a fresh seal; the response shows the new token and secret once', async () => {
      const res = await rotate();
      expect(res.status).toBe(200);

      const { token, secret } = res.body.data;
      expect(token).toMatch(TOKEN_RE);
      expect(secret).toMatch(HEX64_RE);

      expect(prismaMock.webhook.update).toHaveBeenCalledTimes(1);
      const args = prismaMock.webhook.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
      expect(args.data).toEqual({
        tokenHash: sha256(token), secretEnc: expect.stringMatching(/^enc:/),
        lastRotatedAt: expect.any(Date), lastRotatedById: 'user-1', creatorRemovedAt: null,
      });
      expect(openSecret(args.data.secretEnc)).toBe(secret);
      expect(JSON.stringify(args)).not.toContain(secret);
      expect(args.select).not.toHaveProperty('secretEnc');

      expect(res.body.data).toMatchObject({ id: 'wh-1', type: 'github', name: 'GH' });
      expect(res.body.data).not.toHaveProperty('secretEnc');
      expect(JSON.stringify(h.emitted)).not.toContain(secret);
      expectChangedOnce();
    });

    it('two rotations give two different secrets and seals', async () => {
      const a = await rotate();
      const b = await rotate();
      expect(a.body.data.secret).not.toBe(b.body.data.secret);
      const seals = prismaMock.webhook.update.mock.calls.map((c: any[]) => c[0].data.secretEnc);
      expect(seals[0]).not.toBe(seals[1]);
    });

    it('503 without a usable key: nothing rotated (the old token and secret keep working), nothing emitted', async () => {
      delete process.env.TOTP_ENCRYPTION_KEY;
      const res = await rotate();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ success: false, error: 'GitHub webhooks are not configured on this server' });
      expect(prismaMock.webhook.update).not.toHaveBeenCalled();
      expect(h.emitted).toHaveLength(0);
    });

    it('a GitHub webhook of another server is still a 404, before the key is consulted', async () => {
      delete process.env.TOTP_ENCRYPTION_KEY;
      prismaMock.webhook.findUnique.mockResolvedValueOnce({ id: 'wh-9', serverId: 'srv-2', channelId: 'ch-9', type: 'github' });
      const res = await rotate('wh-9');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Webhook not found');
      expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    });
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

  it('a webhook deleted between the ownership read and the update (an admin delete racing the rotate, P2025) is 404 "Webhook not found": no credential, no stack, nothing emitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.update.mockRejectedValueOnce(recordNotFound());
    const res = await rotate();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.webhook.update).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('a webhook moved by someone else after the VIEW check (maybe into a hidden channel): 404, NO token handed out, nothing emitted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.update.mockImplementationOnce(async ({ where }: any) => {
      if (where.channelId !== 'ch-hidden') throw recordNotFound();
      return webhookRow({ channelId: 'ch-hidden' });
    });
    const res = await rotate();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.webhook.update.mock.calls[0][0].where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
    expect(res.text).not.toMatch(/"token"/);
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('any other update failure during a rotate is still a 500, and emits nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.update.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'P1017' }));
    const res = await rotate();
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('data');
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });
});

// ─── DELETE /:webhookId ─────────────────────────────────────────────────────

describe('DELETE /servers/:serverId/webhooks/:webhookId', () => {
  const del = (query = '', id = 'wh-1') => request(app).delete(`${BASE}/${id}${query}`);

  it('without purge: deletes the row only, keeps its messages, no bulk event', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedMessages: 0 } });
    expect(prismaMock.webhook.findUnique).toHaveBeenCalledWith({ where: { id: 'wh-1' }, select: OWN_SELECT });
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

  it('an ENABLE is the same 404, never the SEND 403 nor the admin-lock 403 (VIEW decides first)', async () => {
    prismaMock.webhook.findUnique.mockResolvedValue({
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-staff', adminDisabledAt: new Date(),
    });
    const res = await request(app).patch(`${BASE}/wh-1`).send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(h.hasChannelPermission.mock.calls).toEqual([['user-1', 'ch-staff', 'srv-1', Permissions.VIEW_CHANNEL]]);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
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

// ─── Owner decisions (2026-10-19): the admin lock, enable asks SEND, the ───
// ─── creator-removal mark, the rotation trace ───────────────────────────────

const LOCKED_AT = new Date('2026-10-19T08:00:00.000Z');
const REMOVED_AT = new Date('2026-10-19T08:30:00.000Z');

/** The row loadOwnWebhook reads: ownership, type and the admin lock. */
function ownRow(overrides: Record<string, unknown> = {}) {
  return { id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', type: 'generic', adminDisabledAt: null, ...overrides };
}

describe('PATCH: a platform admin\'s disable is sticky', () => {
  const patch = (body: unknown) => request(app).patch(`${BASE}/wh-1`).send(body as object);

  beforeEach(() => {
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false, adminDisabledAt: LOCKED_AT }));
  });

  it('an enable answers 403 with the exact sentence: nothing written, nothing emitted, SEND never asked', async () => {
    const res = await patch({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(ADMIN_DISABLED);
    expect(prismaMock.webhook.findUnique).toHaveBeenCalledWith({ where: { id: 'wh-1' }, select: OWN_SELECT });
    // VIEW first (opacity), then the lock: SEND is never reached
    expect(h.hasChannelPermission.mock.calls).toEqual([['user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL]]);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('an enable riding with a rename or a move is refused whole: the rename is not applied, the target never looked up', async () => {
    const renamed = await patch({ enabled: true, name: 'Back' });
    expect(renamed.status).toBe(403);
    expect(renamed.body).toEqual(ADMIN_DISABLED);

    const moved = await patch({ enabled: true, channelId: 'ch-2' });
    expect(moved.status).toBe(403);
    expect(moved.body).toEqual(ADMIN_DISABLED);
    expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();

    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('the lock is decided before SEND: a locked webhook on a read-only channel answers the lock sentence', async () => {
    h.hasChannelPermission.mockImplementation(async (...args: unknown[]) => args[3] !== Permissions.SEND_MESSAGES);
    const res = await patch({ enabled: true });
    expect(res.body).toEqual(ADMIN_DISABLED);
  });

  it.each([
    ['a rename', { name: 'Renamed' }, { name: 'Renamed' }],
    ['a disable', { enabled: false }, { enabled: false }],
  ])('%s of the locked webhook is still allowed, and leaves the lock alone', async (_label, body, data) => {
    prismaMock.webhook.update.mockImplementationOnce(async ({ data: d }: any) => webhookRow({ enabled: false, adminDisabledAt: LOCKED_AT, ...d }));
    const res = await patch(body);
    expect(res.status).toBe(200);
    const args = prismaMock.webhook.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
    expect(args.data).toEqual(data);
    expect(res.body.data.adminDisabledAt).toBe(LOCKED_AT.toISOString());
    expectChangedOnce();
  });

  it('a move of the locked webhook is still allowed (through the target checks), and leaves the lock alone', async () => {
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    const res = await patch({ channelId: 'ch-2' });
    expect(res.status).toBe(200);
    const args = prismaMock.webhook.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'wh-1', channelId: 'ch-1' });
    expect(args.data).toEqual({ channelId: 'ch-2' });
  });

  it('the owner cannot lift the lock through the body: adminDisabledAt is not a PATCH field', async () => {
    const res = await patch({ name: 'x', adminDisabledAt: null, creatorRemovedAt: null });
    expect(res.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ name: 'x' });

    const only = await patch({ adminDisabledAt: null });
    expect(only.status).toBe(400);
    expect(only.body.error).toBe('No fields to update');
  });

  it('an enable is written only while the lock is still absent: an admin disable racing it makes the write match nothing (404), never an enabled locked row', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false }));
    // The admin's disable committed after the read: the conditional write finds no row
    prismaMock.webhook.update.mockImplementationOnce(async ({ where }: any) => {
      if (where.adminDisabledAt === null) throw recordNotFound();
      return webhookRow({ enabled: true });
    });
    const res = await patch({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.webhook.update.mock.calls[0][0].where).toEqual({ id: 'wh-1', channelId: 'ch-1', adminDisabledAt: null });
    expect(spy).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });

  it('an unlocked webhook enables normally, conditional on the lock being absent', async () => {
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false }));
    const res = await patch({ enabled: true });
    expect(res.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].where).toEqual({ id: 'wh-1', channelId: 'ch-1', adminDisabledAt: null });
    expect(res.body.data.enabled).toBe(true);
    expectChangedOnce();
  });
});

describe('PATCH: an enable asks SEND_MESSAGES (it turns the URL back into write access)', () => {
  const patch = (body: unknown) => request(app).patch(`${BASE}/wh-1`).send(body as object);

  /** VIEW everywhere; SEND refused in the listed channels. */
  function noSendIn(...channelIds: string[]) {
    h.hasChannelPermission.mockImplementation(async (...args: unknown[]) =>
      !(args[3] === Permissions.SEND_MESSAGES && channelIds.includes(args[1] as string)));
  }

  beforeEach(() => {
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false }));
  });

  it('without SEND on the webhook\'s channel: 403 with the messages.ts sentence, nothing updated, nothing emitted', async () => {
    noSendIn('ch-1');
    const res = await patch({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(NO_SEND);
    expect(h.hasChannelPermission.mock.calls).toEqual([
      ['user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL],
      ['user-1', 'ch-1', 'srv-1', Permissions.SEND_MESSAGES],
    ]);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('an enable riding with a rename is refused whole without SEND', async () => {
    noSendIn('ch-1');
    const res = await patch({ enabled: true, name: 'Back' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(NO_SEND);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });

  it('an enable that also MOVES is asked on the TARGET (by the move checks), never on the old channel', async () => {
    // The old channel is read-only for the caller; the target is not
    noSendIn('ch-1');
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    const res = await patch({ enabled: true, channelId: 'ch-2' });
    expect(res.status).toBe(200);
    expect(h.hasChannelPermission.mock.calls).toEqual([
      ['user-1', 'ch-1', 'srv-1', Permissions.VIEW_CHANNEL],
      ['user-1', 'ch-2', 'srv-1', Permissions.VIEW_CHANNEL],
      ['user-1', 'ch-2', 'srv-1', Permissions.SEND_MESSAGES],
    ]);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ enabled: true, channelId: 'ch-2', creatorRemovedAt: null });
  });

  it('an enable that moves to a target without SEND is the 403, nothing updated', async () => {
    noSendIn('ch-2');
    prismaMock.channel.findUnique.mockResolvedValue({ ...textChannel, id: 'ch-2' });
    const res = await patch({ enabled: true, channelId: 'ch-2' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(NO_SEND);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  });

  it('a disable on a read-only channel is still allowed (it reopens nothing)', async () => {
    noSendIn('ch-1');
    const res = await patch({ enabled: false });
    expect(res.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ enabled: false });
  });
});

describe('PATCH: the creator-removal mark', () => {
  const patch = (body: unknown) => request(app).patch(`${BASE}/wh-1`).send(body as object);

  beforeEach(() => {
    // Disabled by its creator's kick. The mark lives in the row the write
    // answers (below): loadOwnWebhook never reads it
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false }));
    prismaMock.webhook.update.mockImplementation(async ({ data }: any) => webhookRow({
      enabled: data.enabled ?? false,
      creatorRemovedAt: data.creatorRemovedAt === null ? null : REMOVED_AT,
      ...(data.name !== undefined ? { name: data.name } : {}),
    }));
  });

  it('the owner\'s enable clears it (they reviewed the webhook); the response carries null', async () => {
    const res = await patch({ enabled: true });
    expect(res.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ enabled: true, creatorRemovedAt: null });
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.creatorRemovedAt).toBeNull();
  });

  it('a rename or a disable keeps it (only an enable or a rotate is the review)', async () => {
    const renamed = await patch({ name: 'Renamed' });
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ name: 'Renamed' });
    expect(renamed.body.data.creatorRemovedAt).toBe(REMOVED_AT.toISOString());

    await patch({ enabled: false });
    expect(prismaMock.webhook.update.mock.calls[1][0].data).toEqual({ enabled: false });
  });
});

describe('POST rotate: the rotation trace', () => {
  const rotate = () => request(app).post(`${BASE}/wh-1/rotate`);

  beforeEach(() => {
    prismaMock.webhook.update.mockImplementation(async ({ data }: any) => webhookRow({
      enabled: false,
      lastRotatedAt: data.lastRotatedAt,
      lastRotatedBy: { id: data.lastRotatedById, username: 'tester', displayName: 'Tester' },
      creatorRemovedAt: data.creatorRemovedAt === null ? null : REMOVED_AT,
    }));
  });

  it('records who rotated and when, and the response carries it', async () => {
    const before = Date.now();
    const res = await rotate();
    expect(res.status).toBe(200);

    const { data } = prismaMock.webhook.update.mock.calls[0][0];
    expect(data.lastRotatedById).toBe('user-1');
    expect(data.lastRotatedAt).toBeInstanceOf(Date);
    expect(data.lastRotatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(res.body.data.lastRotatedAt).toBe(data.lastRotatedAt.toISOString());
    expect(res.body.data.lastRotatedBy).toEqual({ id: 'user-1', username: 'tester', displayName: 'Tester' });
  });

  it('clears the creator-removal mark but never enables: a webhook disabled by the kick stays disabled', async () => {
    // A webhook its creator's kick disabled (the update mock answers the mark)
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false }));
    const res = await rotate();
    expect(res.status).toBe(200);
    const { data } = prismaMock.webhook.update.mock.calls[0][0];
    expect(data.creatorRemovedAt).toBeNull();
    expect(data).not.toHaveProperty('enabled');
    expect(res.body.data.creatorRemovedAt).toBeNull();
    expect(res.body.data.enabled).toBe(false);
  });

  it('a rotate of an admin-locked webhook is allowed and leaves the lock alone (it reopens nothing)', async () => {
    prismaMock.webhook.findUnique.mockResolvedValue(ownRow({ enabled: false, adminDisabledAt: LOCKED_AT }));
    const res = await rotate();
    expect(res.status).toBe(200);
    const { data } = prismaMock.webhook.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('enabled');
    expect(data).not.toHaveProperty('adminDisabledAt');
  });

  it('the trace comes from the authenticated caller, never from the body', async () => {
    await request(app).post(`${BASE}/wh-1/rotate`).send({ lastRotatedById: 'user-evil', lastRotatedAt: '2000-01-01T00:00:00.000Z' });
    const { data } = prismaMock.webhook.update.mock.calls[0][0];
    expect(data.lastRotatedById).toBe('user-1');
    expect(data.lastRotatedAt.getFullYear()).toBeGreaterThan(2000);
  });
});

// ─── GET /targets ───────────────────────────────────────────────────────────

describe('GET /servers/:serverId/webhooks/targets', () => {
  const targets = (serverId = 'srv-1') => request(app).get(`/api/v1/servers/${serverId}/webhooks/targets`);
  const BIND = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;

  function channelRow(id: string, overrides: Record<string, unknown> = {}) {
    return { id, name: id, categoryId: null, position: 0, type: 'text', secure: false, ...overrides };
  }

  it('answers the text channels the batched filter allows for VIEW | SEND, as { id, name, categoryId, position }, in query order', async () => {
    prismaMock.channel.findMany.mockResolvedValue([
      channelRow('general', { categoryId: 'cat-1', position: 0 }),
      channelRow('announcements', { categoryId: 'cat-1', position: 1 }),
      channelRow('staff', { categoryId: 'cat-2', position: 2 }),
      channelRow('random', { position: 3 }),
    ]);
    // a hidden channel (staff) and a read-only one (announcements) both fail the mask
    h.filterChannelsWithPermissions.mockImplementation(async (_u: unknown, _s: unknown, channels: { id: string }[]) =>
      channels.filter((c) => c.id !== 'staff' && c.id !== 'announcements'));

    const res = await targets();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        { id: 'general', name: 'general', categoryId: 'cat-1', position: 0 },
        { id: 'random', name: 'random', categoryId: null, position: 3 },
      ],
    });
    // a hidden channel is never named, a read-only one never offered
    expect(res.text).not.toContain('staff');
    expect(res.text).not.toContain('announcements');
  });

  it('ONE batched pass with VIEW_CHANNEL | SEND_MESSAGES over the candidates, never a permission computation per channel', async () => {
    prismaMock.channel.findMany.mockResolvedValue([channelRow('a'), channelRow('b'), channelRow('c')]);
    await targets();
    expect(h.filterChannelsWithPermissions).toHaveBeenCalledTimes(1);
    expect(h.filterChannelsWithPermissions).toHaveBeenCalledWith('user-1', 'srv-1', [channelRow('a'), channelRow('b'), channelRow('c')], BIND);
    expect(h.hasChannelPermission).not.toHaveBeenCalled();
    expect(h.filterVisibleChannels).not.toHaveBeenCalled();
  });

  it('queries the server\'s non-secure text channels by position then name, selecting `secure` for the filter', async () => {
    await targets();
    expect(prismaMock.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'srv-1', type: 'text', secure: false },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, categoryId: true, position: true, type: true, secure: true },
    });
  });

  it('never answers a voice or a secure channel, even should the query return one (decided again in code)', async () => {
    prismaMock.channel.findMany.mockResolvedValue([
      channelRow('voice-1', { type: 'voice' }),
      channelRow('vault', { secure: true }),
      channelRow('general'),
    ]);
    const res = await targets();
    expect(res.body.data).toEqual([{ id: 'general', name: 'general', categoryId: null, position: 0 }]);
    // only the candidate reaches the filter
    expect(h.filterChannelsWithPermissions).toHaveBeenCalledWith('user-1', 'srv-1', [channelRow('general')], BIND);
  });

  it('keeps the order the query answered (position, then name)', async () => {
    prismaMock.channel.findMany.mockResolvedValue([
      channelRow('alpha', { position: 0 }),
      channelRow('beta', { position: 0 }),
      channelRow('zeta', { position: 1 }),
    ]);
    const res = await targets();
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('no text channel: an empty list and no permission pass at all', async () => {
    const res = await targets();
    expect(res.body).toEqual({ success: true, data: [] });
    expect(h.filterChannelsWithPermissions).not.toHaveBeenCalled();
    expect(h.hasChannelPermission).not.toHaveBeenCalled();
  });

  it('nothing allowed: an empty list', async () => {
    prismaMock.channel.findMany.mockResolvedValue([channelRow('a'), channelRow('b')]);
    h.filterChannelsWithPermissions.mockResolvedValue([]);
    const res = await targets();
    expect(res.body).toEqual({ success: true, data: [] });
  });

  it('is guarded by the read limiter, emits nothing, and never reads a webhook (it is not a /:webhookId route)', async () => {
    const res = await targets();
    expect(res.status).toBe(200);
    expect(h.limiterCalls).toEqual(['webhookRead']);
    expect(h.emitted).toHaveLength(0);
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.webhook.findMany).not.toHaveBeenCalled();
  });

  it('without MANAGE_WEBHOOKS: 403 from the router guard, no channel read', async () => {
    h.hasServerPermission.mockResolvedValue(false);
    const res = await targets('srv-9');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'You do not have permission to manage webhooks' });
    expect(h.hasServerPermission).toHaveBeenCalledWith('user-1', 'srv-9', Permissions.MANAGE_WEBHOOKS);
    expect(prismaMock.channel.findMany).not.toHaveBeenCalled();
  });

  it('a permission-calculator failure is a 500, never a partial list', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.channel.findMany.mockResolvedValue([channelRow('a'), channelRow('b')]);
    h.filterChannelsWithPermissions.mockRejectedValue(new Error('db down'));
    const res = await targets();
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('data');
    spy.mockRestore();
  });
});
