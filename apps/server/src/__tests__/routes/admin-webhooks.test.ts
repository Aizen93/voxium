import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// Platform-admin webhook moderation (routes/admin.ts): the server's whole
// webhook list, disable / enable and delete (+ purge), all audited. The
// delete runs the owner's transaction (utils/webhookLifecycle.ts, REAL here)
// over the prisma mock.

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(userId = 'admin-1') {
  return jwt.sign({ userId, username: 'admin', tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

const h = vi.hoisted(() => ({
  emitted: [] as { room: string; event: string; payload: unknown }[],
  permissionSpies: [] as Array<{ mock: { calls: unknown[] } }>,
}));

const txMock = {
  $queryRaw: vi.fn(),
  message: { groupBy: vi.fn(), deleteMany: vi.fn() },
  webhook: { findUnique: vi.fn(), delete: vi.fn() },
};

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  server: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  // Deliberately no `delete` and no `message` model on the root client: the
  // delete runs on the transaction client only (updateMany: the disable the
  // shared delete commits BEFORE its transaction)
  webhook: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  channel: { findMany: vi.fn().mockResolvedValue([]) },
  serverMember: { findMany: vi.fn().mockResolvedValue([]) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $transaction: vi.fn(),
  // the history batches of the shared delete (root client): nothing to move by default
  $executeRaw: vi.fn().mockResolvedValue(0),
  $queryRaw: vi.fn().mockResolvedValue([]),
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_t, prop) { return prismaMock[prop as string]; } }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => { h.emitted.push({ room, event, payload }); },
    }),
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
  })),
}));

// Every permission helper wrapped in a spy: the admin routes must call none
// (no VIEW_CHANNEL filter, no server-role check: platform admins see all)
vi.mock('../../utils/permissionCalculator', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      const spy = vi.fn(value as (...a: unknown[]) => unknown);
      h.permissionSpies.push(spy);
      wrapped[key] = spy;
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped;
});

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough, normalizeIp: (ip: string) => ip };
});
vi.mock('../../utils/redis', () => ({ getOnlineUsers: vi.fn().mockResolvedValue([]) }));
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(), getVoiceMediaCounts: vi.fn().mockReturnValue({}), getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0), getTotalVoiceUsers: vi.fn().mockResolvedValue(0), getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../websocket/voiceCluster', () => ({ broadcastServerVoiceCleanup: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../websocket/dmVoiceHandler', () => ({ getActiveDMCallCount: vi.fn().mockResolvedValue(0), getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0) }));
vi.mock('../../mediasoup/mediasoupManager', () => ({ getSfuStats: vi.fn().mockReturnValue({ workers: [] }) }));
vi.mock('../../utils/serverLimits', () => ({ getGlobalLimits: vi.fn().mockResolvedValue({}) }));
vi.mock('../../utils/sanitize', () => ({ sanitizeText: vi.fn((s: string) => s) }));
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: vi.fn(), broadcastMemberLeft: vi.fn() }));
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/, VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]), deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));
const mockLogAuditEvent = vi.fn();
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: (...a: any[]) => mockLogAuditEvent(...a) }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: vi.fn().mockResolvedValue(true),
  recomputeListedForOwner: vi.fn().mockResolvedValue(0),
}));

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';
import { webhookSelect } from '../../utils/webhookLifecycle';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CREATED_AT = new Date('2026-10-18T10:00:00.000Z');
const USED_AT = new Date('2026-10-18T11:30:00.000Z');
const ROTATED_AT = new Date('2026-10-18T12:00:00.000Z');
const REMOVED_AT = new Date('2026-10-18T12:30:00.000Z');

/** A row as the mock returns it. It deliberately carries the two secret
 *  columns: the response must be built by a whitelist, not by the select alone. */
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
    tokenHash: 'a'.repeat(64),
    secretEnc: 'sealed-secret',
    ...overrides,
  };
}

/** The owner-decision fields of a webhook nobody locked, removed or rotated. */
const UNTOUCHED = { adminDisabledAt: null, creatorRemovedAt: null, lastRotatedAt: null, lastRotatedBy: null };

/** No key anywhere in the body may name a credential. */
function expectNoCredentials(body: unknown) {
  const json = JSON.stringify(body);
  for (const key of ['"token"', '"tokenHash"', '"secretEnc"', '"secret"']) expect(json).not.toContain(key);
  expect(json).not.toContain('sealed-secret');
  expect(json).not.toContain('a'.repeat(64));
}

function eventsNamed(event: string) {
  return h.emitted.filter((e) => e.event === event);
}

function expectChangedOnce(serverId = 'srv-1') {
  const changed = eventsNamed('webhook:changed');
  expect(changed).toHaveLength(1);
  expect(changed[0]).toEqual({ room: `server:${serverId}`, event: 'webhook:changed', payload: { serverId } });
}

function adminUser(role: string) {
  return {
    id: 'admin-1', role, bannedAt: null, tokenVersion: 0, emailVerified: true,
    termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  };
}

const auth = () => `Bearer ${makeToken()}`;

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  h.emitted.length = 0;
  app = createApp();
  prismaMock.user.findUnique.mockResolvedValue(adminUser('admin'));
  prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1' });
  prismaMock.webhook.findMany.mockResolvedValue([]);
  prismaMock.webhook.update.mockImplementation(async ({ where, data }: any) => webhookRow({ id: where.id, ...data }));
  prismaMock.webhook.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  txMock.$queryRaw.mockResolvedValue([{ id: 'wh-1' }]);
  txMock.webhook.findUnique.mockResolvedValue({ serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic' });
  txMock.message.groupBy.mockResolvedValue([]);
  txMock.message.deleteMany.mockResolvedValue({ count: 0 });
  txMock.webhook.delete.mockResolvedValue({ id: 'wh-1' });
});

// ─── Guards ─────────────────────────────────────────────────────────────────

const ROUTES: { label: string; send: (token?: string) => request.Test }[] = [
  { label: 'GET /servers/:id/webhooks', send: (t) => withAuth(request(app).get('/api/v1/admin/servers/srv-1/webhooks'), t) },
  { label: 'PATCH /webhooks/:id', send: (t) => withAuth(request(app).patch('/api/v1/admin/webhooks/wh-1'), t).send({ enabled: false }) },
  { label: 'DELETE /webhooks/:id', send: (t) => withAuth(request(app).delete('/api/v1/admin/webhooks/wh-1?purge=1'), t) },
];

function withAuth(req: request.Test, token?: string): request.Test {
  return token ? req.set('Authorization', token) : req;
}

function expectNothingTouched() {
  expect(prismaMock.webhook.findMany).not.toHaveBeenCalled();
  expect(prismaMock.webhook.update).not.toHaveBeenCalled();
  expect(prismaMock.webhook.updateMany).not.toHaveBeenCalled();
  expect(prismaMock.$transaction).not.toHaveBeenCalled();
  expect(mockLogAuditEvent).not.toHaveBeenCalled();
  expect(h.emitted).toHaveLength(0);
}

describe('admin webhook routes — guards', () => {
  it.each(ROUTES)('$label: a non-admin is 403 and reaches nothing', async ({ send }) => {
    prismaMock.user.findUnique.mockResolvedValue(adminUser('user'));
    const res = await send(auth());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Admin access required' });
    expectNothingTouched();
  });

  it.each(ROUTES)('$label: no token is 401', async ({ send }) => {
    const res = await send();
    expect(res.status).toBe(401);
    expectNothingTouched();
  });

  it.each(ROUTES)('$label: a superadmin passes too', async ({ send }) => {
    prismaMock.user.findUnique.mockResolvedValue(adminUser('superadmin'));
    const res = await send(auth());
    expect(res.status).toBe(200);
  });

  it.each(ROUTES)('$label: calls no permission helper (no VIEW filter, no server role)', async ({ send }) => {
    prismaMock.webhook.findMany.mockResolvedValue([{ ...webhookRow(), channel: { name: 'general', secure: false } }]);
    const res = await send(auth());
    expect(res.status).toBe(200);
    // the module is loaded (routes/admin.ts reaches it), so the check is not vacuous
    expect(h.permissionSpies.length).toBeGreaterThan(0);
    for (const spy of h.permissionSpies) expect(spy.mock.calls).toHaveLength(0);
  });
});

// ─── GET /servers/:serverId/webhooks ────────────────────────────────────────

describe('GET /admin/servers/:serverId/webhooks', () => {
  const get = (serverId = 'srv-1') => request(app).get(`/api/v1/admin/servers/${serverId}/webhooks`).set('Authorization', auth());

  it('lists EVERY webhook of the server, oldest first, with its channel name and the total', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([
      { ...webhookRow(), channel: { name: 'general', secure: false } },
      // a staff-only channel: an owner's moderator might not see it, an admin does
      {
        // its creator was kicked (disabled + marked), and a moderator rotated it since
        ...webhookRow({
          id: 'wh-2', channelId: 'ch-staff', name: 'Deploys', type: 'github', enabled: false, lastUsedAt: USED_AT, createdBy: null,
          creatorRemovedAt: REMOVED_AT, lastRotatedAt: ROTATED_AT,
          lastRotatedBy: { id: 'user-2', username: 'bob', displayName: 'Bob' },
        }),
        channel: { name: 'staff-only', secure: false },
      },
    ]);

    const res = await get();

    expect(res.status).toBe(200);
    expect(prismaMock.server.findUnique).toHaveBeenCalledWith({ where: { id: 'srv-1' }, select: { id: true } });
    expect(prismaMock.webhook.findMany).toHaveBeenCalledWith({
      where: { serverId: 'srv-1' },
      orderBy: { createdAt: 'asc' },
      select: { ...webhookSelect, channel: { select: { name: true, secure: true } } },
    });
    expect(res.body).toEqual({
      success: true,
      total: 2,
      data: [
        {
          id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
          createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
          createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: null, channelName: 'general',
          ...UNTOUCHED,
        },
        {
          id: 'wh-2', serverId: 'srv-1', channelId: 'ch-staff', name: 'Deploys', type: 'github', enabled: false,
          createdBy: null, createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: '2026-10-18T11:30:00.000Z', channelName: 'staff-only',
          adminDisabledAt: null, creatorRemovedAt: '2026-10-18T12:30:00.000Z',
          lastRotatedAt: '2026-10-18T12:00:00.000Z', lastRotatedBy: { id: 'user-2', username: 'bob', displayName: 'Bob' },
        },
      ],
    });
    expectNoCredentials(res.body);
    // a read: no audit row, no event
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('never selects the token hash nor the sealed secret', async () => {
    await get();
    const { select } = prismaMock.webhook.findMany.mock.calls[0][0];
    expect(select).not.toHaveProperty('tokenHash');
    expect(select).not.toHaveProperty('secretEnc');
  });

  it('a secure channel name never reaches the dashboard', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([{ ...webhookRow({ channelId: 'ch-sec' }), channel: { name: 'Top secret', secure: true } }]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data[0].channelName).toBeNull();
    expect(res.text).not.toContain('Top secret');
  });

  it('an empty server answers an empty list and 0', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [], total: 0 });
  });

  it('an unknown server is 404 "Server not found"', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    const res = await get('nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Server not found' });
  });
});

// ─── PATCH /webhooks/:webhookId ─────────────────────────────────────────────

describe('PATCH /admin/webhooks/:webhookId', () => {
  const patch = (body: unknown, id = 'wh-1') => request(app).patch(`/api/v1/admin/webhooks/${id}`).set('Authorization', auth()).send(body as object);

  it('validates the body: enabled is required and must be a boolean', async () => {
    const missing = await patch({});
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ success: false, error: 'Provide enabled' });
    for (const enabled of ['false', 0, 1, null, 'true']) {
      const res = await patch({ enabled });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'enabled must be a boolean' });
    }
    // other fields are not an admin's to edit
    expect((await patch({ name: 'x' })).status).toBe(400);
    expect(prismaMock.webhook.update).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('disable: sets enabled false and the sticky admin lock only, audits webhook.disable, emits webhook:changed, answers the Webhook', async () => {
    const before = Date.now();
    const res = await patch({ enabled: false, name: 'ignored', channelId: 'ch-evil' });

    expect(res.status).toBe(200);
    expect(prismaMock.webhook.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.webhook.update).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      data: { enabled: false, adminDisabledAt: expect.any(Date) },
      select: webhookSelect,
    });
    const lockedAt: Date = prismaMock.webhook.update.mock.calls[0][0].data.adminDisabledAt;
    expect(lockedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockLogAuditEvent).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'webhook.disable',
      targetType: 'webhook',
      targetId: 'wh-1',
      metadata: { serverId: 'srv-1', channelId: 'ch-1', name: 'CI' },
    });
    expectChangedOnce();
    expect(h.emitted).toHaveLength(1);
    expect(res.body).toEqual({
      success: true,
      data: {
        id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: false,
        createdBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
        createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: null,
        ...UNTOUCHED,
        // the lock travels to the tab, which shows why the owner cannot re-enable
        adminDisabledAt: lockedAt.toISOString(),
      },
    });
    expectNoCredentials(res.body);
  });

  it('enable: lifts the admin lock (adminDisabledAt null) and audits webhook.enable with the row it updated', async () => {
    prismaMock.webhook.update.mockResolvedValueOnce(webhookRow({ id: 'wh-7', serverId: 'srv-9', channelId: 'ch-9', name: 'Alerts', enabled: true }));
    const res = await patch({ enabled: true }, 'wh-7');

    expect(res.status).toBe(200);
    expect(prismaMock.webhook.update).toHaveBeenCalledWith({
      where: { id: 'wh-7' },
      data: { enabled: true, adminDisabledAt: null, creatorRemovedAt: null },
      select: webhookSelect,
    });
    expect(res.body.data.adminDisabledAt).toBeNull();
    expect(mockLogAuditEvent).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'webhook.enable',
      targetType: 'webhook',
      targetId: 'wh-7',
      metadata: { serverId: 'srv-9', channelId: 'ch-9', name: 'Alerts' },
    });
    // the refetch hint goes to the webhook's own server, from the row
    expectChangedOnce('srv-9');
    expect(res.body.data.enabled).toBe(true);
  });

  it('enable also clears the creator-removal mark (any enable is a review); a disable leaves it alone', async () => {
    // The stored row: disabled by its creator's kick, then locked by an admin.
    // The write applies its data to it, as the database would
    const stored = { enabled: false, adminDisabledAt: USED_AT, creatorRemovedAt: REMOVED_AT };
    prismaMock.webhook.update.mockImplementation(async ({ where, data }: any) => webhookRow({ id: where.id, ...stored, ...data }));

    const on = await patch({ enabled: true });
    expect(on.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[0][0].data).toEqual({ enabled: true, adminDisabledAt: null, creatorRemovedAt: null });
    // an enabled webhook never carries a "disabled because its creator was removed" note
    expect(on.body.data).toMatchObject({ enabled: true, adminDisabledAt: null, creatorRemovedAt: null });

    const off = await patch({ enabled: false });
    expect(off.status).toBe(200);
    expect(prismaMock.webhook.update.mock.calls[1][0].data).not.toHaveProperty('creatorRemovedAt');
    expect(off.body.data.creatorRemovedAt).toBe(REMOVED_AT.toISOString());
  });

  it('an unknown id is 404 "Webhook not found": no audit, no event', async () => {
    prismaMock.webhook.update.mockRejectedValueOnce(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }));
    const res = await patch({ enabled: false }, 'wh-0');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('any other failure is a 500: no audit, no event', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.webhook.update.mockRejectedValueOnce(new Error('connection reset'));
    const res = await patch({ enabled: false });
    expect(res.status).toBe(500);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });
});

// ─── DELETE /webhooks/:webhookId ────────────────────────────────────────────

describe('DELETE /admin/webhooks/:webhookId', () => {
  const del = (query = '', id = 'wh-1') => request(app).delete(`/api/v1/admin/webhooks/${id}${query}`).set('Authorization', auth());

  it('without purge: locks, deletes the row only, audits, emits webhook:changed only', async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedMessages: 0 } });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(txMock.webhook.delete.mock.invocationCallOrder[0]);
    expect(txMock.webhook.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(eventsNamed('message:bulk_deleted')).toHaveLength(0);
    expectChangedOnce();
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockLogAuditEvent).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'webhook.delete',
      targetType: 'webhook',
      targetId: 'wh-1',
      metadata: { serverId: 'srv-1', channelId: 'ch-1', name: 'CI', purge: false, deletedMessages: 0 },
    });
  });

  it('with ?purge=1: lock, groupBy, deleteMany, delete in that order; one receipt per channel; audit carries the count', async () => {
    txMock.message.groupBy.mockResolvedValue([
      { channelId: 'ch-1', _count: { _all: 4 } },
      { channelId: 'ch-old', _count: { _all: 9 } },
    ]);
    txMock.message.deleteMany.mockResolvedValue({ count: 13 });

    const res = await del('?purge=1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedMessages: 13 } });

    const [strings, ...values] = txMock.$queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toBe('SELECT id FROM webhooks WHERE id = ? FOR UPDATE');
    expect(values).toEqual(['wh-1']);
    const lock = txMock.$queryRaw.mock.invocationCallOrder[0];
    const read = txMock.webhook.findUnique.mock.invocationCallOrder[0];
    const group = txMock.message.groupBy.mock.invocationCallOrder[0];
    const purge = txMock.message.deleteMany.mock.invocationCallOrder[0];
    const drop = txMock.webhook.delete.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(group);
    expect(group).toBeLessThan(purge);
    expect(purge).toBeLessThan(drop);
    expect(txMock.message.groupBy).toHaveBeenCalledWith({ by: ['channelId'], where: { webhookId: 'wh-1' }, _count: { _all: true } });
    expect(txMock.message.deleteMany).toHaveBeenCalledWith({ where: { webhookId: 'wh-1' } });

    expect(eventsNamed('message:bulk_deleted')).toEqual([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 4 } },
      { room: 'channel:ch-old', event: 'message:bulk_deleted', payload: { channelId: 'ch-old', webhookId: 'wh-1', count: 9 } },
    ]);
    expectChangedOnce();
    expect(h.emitted[h.emitted.length - 1].event).toBe('webhook:changed');

    expect(mockLogAuditEvent).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'webhook.delete',
      targetType: 'webhook',
      targetId: 'wh-1',
      metadata: { serverId: 'srv-1', channelId: 'ch-1', name: 'CI', purge: true, deletedMessages: 13 },
    });
    expectNoCredentials(res.body);
    expect(Object.keys(res.body.data)).toEqual(['deletedMessages']);
  });

  it('?purge=true purges too; a purge that removed nothing sends one count-0 receipt to the current channel', async () => {
    txMock.webhook.findUnique.mockResolvedValue({ serverId: 'srv-2', channelId: 'ch-7', name: 'Old', type: 'github' });
    const res = await del('?purge=true');

    expect(res.status).toBe(200);
    expect(res.body.data.deletedMessages).toBe(0);
    expect(txMock.message.deleteMany).toHaveBeenCalledTimes(1);
    expect(eventsNamed('message:bulk_deleted')).toEqual([
      { room: 'channel:ch-7', event: 'message:bulk_deleted', payload: { channelId: 'ch-7', webhookId: 'wh-1', count: 0 } },
    ]);
    // the server and the audit metadata come from the locked row
    expectChangedOnce('srv-2');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { serverId: 'srv-2', channelId: 'ch-7', name: 'Old', purge: true, deletedMessages: 0 },
    }));
  });

  it.each(['?purge=0', '?purge=yes', '?purge=', '?purge=TRUE'])('%s does not purge', async (query) => {
    await del(query);
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(txMock.webhook.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ purge: false }),
    }));
  });

  it('a vanished row (the lock finds nothing) is 404 "Webhook not found": nothing deleted, no audit, no event', async () => {
    txMock.$queryRaw.mockResolvedValue([]);
    const res = await del('?purge=1', 'wh-0');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(txMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(txMock.webhook.delete).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('a failed transaction is a 500: no audit, no event', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    txMock.message.deleteMany.mockResolvedValue({ count: 3 });
    txMock.webhook.delete.mockRejectedValue(new Error('deadlock'));
    const res = await del('?purge=1');
    expect(res.status).toBe(500);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
    spy.mockRestore();
  });
});
