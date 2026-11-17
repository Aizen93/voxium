import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { LIMITS, WS_EVENTS } from '@voxium/shared';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(userId: string) {
  return jwt.sign({ userId, username: userId, tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  supportTicket: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
  },
  supportMessage: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }),
}));

// One ordered record of room joins and emits, so "join BEFORE emit" can be asserted
type Step = ['join', string, string] | ['emit', string, string, any];
const timeline: Step[] = [];
const joins = () => timeline.filter((s): s is ['join', string, string] => s[0] === 'join').map((s) => [s[1], s[2]]);
const emits = () => timeline.filter((s): s is ['emit', string, string, any] => s[0] === 'emit');
const roomsOf = (event: string) => emits().filter((s) => s[2] === event).map((s) => s[1]);
const payloadOf = (event: string) => emits().find((s) => s[2] === event)?.[3];
const socketsLeave = vi.fn();

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { timeline.push(['emit', room, event, payload]); } }),
    in: (room: string) => ({
      socketsJoin: (target: string) => { timeline.push(['join', room, target]); },
      socketsLeave,
      fetchSockets: vi.fn().mockResolvedValue([]),
    }),
    local: { in: () => ({ socketsLeave: vi.fn() }) },
  })),
}));

const { adminLimiter } = vi.hoisted(() => ({
  adminLimiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitAdmin: adminLimiter,
  normalizeIp: (ip: string) => ip,
}));

vi.mock('../../utils/redis', () => ({ getOnlineUsers: vi.fn().mockResolvedValue([]) }));
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../websocket/dmVoiceHandler', () => ({
  getActiveDMCallCount: vi.fn().mockResolvedValue(0),
  getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getSfuStats: vi.fn().mockReturnValue({ workers: [], totalTransports: 0 }),
}));
vi.mock('../../utils/serverLimits', () => ({
  getGlobalLimits: vi.fn().mockResolvedValue({}),
  getEffectiveLimits: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));
const { auditSpy } = vi.hoisted(() => ({ auditSpy: vi.fn() }));
vi.mock('../../utils/auditLog', () => ({
  logAuditEvent: auditSpy,
  auditLogData: vi.fn((p: unknown) => p),
}));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The auth middleware and the handlers' username lookups all read user.findUnique. */
function mockAccounts() {
  prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
    const roles: Record<string, string> = { 'admin-1': 'admin', 'admin-2': 'admin', 'super-1': 'superadmin', 'user-1': 'user' };
    const role = roles[where.id];
    if (!role) return null;
    return {
      id: where.id, username: `name-${where.id}`, role,
      bannedAt: null, tokenVersion: 0, emailVerified: true,
      termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    };
  });
}

const AUTHOR = {
  id: 'admin-1', username: 'name-admin-1', displayName: 'Admin', avatarUrl: null,
  role: 'admin', isSupporter: false, supporterTier: null,
};

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1', userId: 'user-9', status: 'open', claimedById: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function messageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm1', ticketId: 'ticket-1', authorId: 'admin-1', content: 'hello', type: 'user',
    createdAt: new Date('2026-01-03T00:00:00Z'), author: AUTHOR, ...over,
  };
}

const as = (who: string) => ({ Authorization: `Bearer ${makeToken(who)}` });
const BASE = '/api/v1/admin/support/tickets';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Admin support routes', () => {
  let app: express.Express;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    timeline.length = 0;
    adminLimiter.mockImplementation((_req, _res, next) => next());
    mockAccounts();
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.supportTicket.count.mockResolvedValue(4);
    prismaMock.supportTicket.update.mockImplementation(async ({ where, data }: any) => ticketRow({ id: where.id, ...data }));
    prismaMock.supportMessage.create.mockImplementation(async ({ data }: any) =>
      messageRow({ ticketId: data.ticketId, authorId: data.authorId, content: data.content, type: data.type ?? 'user' }));
    prismaMock.supportMessage.findMany.mockResolvedValue([]);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = createApp();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // Rule: only staff reach the support routes, behind the admin rate limiter; nothing is read or written for anyone else.
  describe('staff gate', () => {
    const routes: Array<['get' | 'post', string]> = [
      ['get', BASE],
      ['post', `${BASE}/ticket-1/claim`],
      ['get', `${BASE}/ticket-1/messages`],
      ['post', `${BASE}/ticket-1/messages`],
      ['post', `${BASE}/ticket-1/close`],
    ];

    it.each(routes)('%s %s answers 401 without a token', async (method, path) => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    it.each(routes)('%s %s refuses a normal user with 403 and touches no ticket', async (method, path) => {
      const res = await request(app)[method](path).set(as('user-1')).send({ content: 'x' });
      expect(res.status).toBe(403);
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.findMany).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
      expect(timeline).toEqual([]);
    });

    it('lets a superadmin in as well as an admin', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([]);
      prismaMock.supportTicket.count.mockResolvedValue(0);
      expect((await request(app).get(BASE).set(as('super-1'))).status).toBe(200);
      expect((await request(app).get(BASE).set(as('admin-1'))).status).toBe(200);
    });

    it('runs behind the admin rate limiter', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([]);
      await request(app).get(BASE).set(as('admin-1'));
      expect(adminLimiter).toHaveBeenCalled();
    });
  });

  // Rule: the ticket list is filtered by a known status, paged within bounds, oldest first.
  describe('GET /admin/support/tickets', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      ...ticketRow(),
      user: { id: 'user-9', username: 'bob', displayName: 'Bob', avatarUrl: null },
      claimedBy: null,
      messages: [],
      ...over,
    });

    it('maps rows to the list shape with the last message', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([
        row({ status: 'claimed', claimedById: 'admin-2', claimedBy: { id: 'admin-2', username: 'carol' },
          messages: [{ content: 'last words', createdAt: new Date('2026-01-04T00:00:00Z') }] }),
        row({ id: 'ticket-2' }),
      ]);
      prismaMock.supportTicket.count.mockResolvedValue(2);

      const res = await request(app).get(BASE).set(as('admin-1'));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, total: 2, page: 1, limit: 20, hasMore: false });
      expect(res.body.data[0]).toEqual({
        id: 'ticket-1', userId: 'user-9', username: 'bob', displayName: 'Bob', avatarUrl: null,
        status: 'claimed', claimedById: 'admin-2', claimedByUsername: 'carol',
        lastMessage: 'last words', lastMessageAt: '2026-01-04T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(res.body.data[1]).toMatchObject({ id: 'ticket-2', claimedByUsername: null, lastMessage: null, lastMessageAt: null });
    });

    it('lists all statuses by default, oldest first, 20 a page', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([]);
      await request(app).get(BASE).set(as('admin-1'));
      const args = prismaMock.supportTicket.findMany.mock.calls[0][0];
      expect(args.where).toEqual({});
      expect(args.orderBy).toEqual({ createdAt: 'asc' });
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });

    it.each(['open', 'claimed', 'closed'])('filters on status=%s', async (status) => {
      prismaMock.supportTicket.findMany.mockResolvedValue([]);
      await request(app).get(`${BASE}?status=${status}`).set(as('admin-1'));
      expect(prismaMock.supportTicket.findMany.mock.calls[0][0].where).toEqual({ status });
      expect(prismaMock.supportTicket.count).toHaveBeenCalledWith({ where: { status } });
    });

    it('ignores a status it does not know instead of passing it to the query', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([]);
      await request(app).get(`${BASE}?status=banana`).set(as('admin-1'));
      expect(prismaMock.supportTicket.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('pages with skip and take and reports hasMore', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([row()]);
      prismaMock.supportTicket.count.mockResolvedValue(25);
      const res = await request(app).get(`${BASE}?page=2&limit=10`).set(as('admin-1'));
      const args = prismaMock.supportTicket.findMany.mock.calls[0][0];
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      expect(res.body).toMatchObject({ page: 2, limit: 10, total: 25, hasMore: true });
    });

    it('reports no more on the last page', async () => {
      prismaMock.supportTicket.findMany.mockResolvedValue([row()]);
      prismaMock.supportTicket.count.mockResolvedValue(25);
      const res = await request(app).get(`${BASE}?page=3&limit=10`).set(as('admin-1'));
      expect(res.body.hasMore).toBe(false);
    });

    it.each([
      ['limit=5000', 'take', 100],
      ['limit=-3', 'take', 1],
      ['limit=0', 'take', 20],
      ['limit=abc', 'take', 20],
      ['page=0', 'skip', 0],
      ['page=-5', 'skip', 0],
      ['page=abc', 'skip', 0],
    ])('bounds %s (%s becomes %i)', async (query, key, expected) => {
      prismaMock.supportTicket.findMany.mockResolvedValue([]);
      await request(app).get(`${BASE}?${query}`).set(as('admin-1'));
      expect(prismaMock.supportTicket.findMany.mock.calls[0][0][key]).toBe(expected);
    });

    it('answers 500 when the database fails', async () => {
      prismaMock.supportTicket.findMany.mockRejectedValue(new Error('db down'));
      const res = await request(app).get(BASE).set(as('admin-1'));
      expect(res.status).toBe(500);
    });
  });

  // Rule: claiming marks the ticket claimed by the caller, joins the caller to the ticket room BEFORE announcing, and is audited.
  describe('POST /admin/support/tickets/:id/claim', () => {
    it('claims an open ticket for the caller', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());

      const res = await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { id: 'ticket-1', status: 'claimed' } });
      const update = prismaMock.supportTicket.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'ticket-1' });
      expect(update.data).toMatchObject({ status: 'claimed', claimedById: 'admin-1' });
      expect(update.data.claimedAt).toBeInstanceOf(Date);
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data).toEqual({
        ticketId: 'ticket-1', authorId: 'admin-1', content: 'Staff member name-admin-1 has joined the conversation', type: 'system',
      });
    });

    it('joins the caller\'s sockets to support:{id} before the first event goes out', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));
      expect(joins()).toEqual([['user:admin-1', 'support:ticket-1']]);
      expect(timeline[0]).toEqual(['join', 'user:admin-1', 'support:ticket-1']);
    });

    it('announces the join message and the status change to the ticket room and to staff, then the count', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));
      expect(roomsOf(WS_EVENTS.SUPPORT_MESSAGE_NEW).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(roomsOf(WS_EVENTS.SUPPORT_STATUS_CHANGE).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(payloadOf(WS_EVENTS.SUPPORT_STATUS_CHANGE)).toEqual({
        ticketId: 'ticket-1', status: 'claimed', claimedById: 'admin-1', claimedByUsername: 'name-admin-1',
      });
      expect(emits()).toContainEqual(['emit', 'admin:support', WS_EVENTS.SUPPORT_TICKET_NEW, { total: 4 }]);
    });

    it('writes a support.claim audit event naming the ticket owner', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));
      expect(auditSpy).toHaveBeenCalledWith({
        actorId: 'admin-1', action: 'support.claim', targetType: 'support_ticket', targetId: 'ticket-1', metadata: { userId: 'user-9' },
      });
    });

    it('takes the ticket over when another admin already holds it (current behaviour, not a refusal)', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed', claimedById: 'admin-2' }));

      const res = await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));

      expect(res.status).toBe(200);
      expect(prismaMock.supportTicket.update.mock.calls[0][0].data).toMatchObject({ status: 'claimed', claimedById: 'admin-1' });
      expect(joins()).toEqual([['user:admin-1', 'support:ticket-1']]);
      // The previous admin's sockets are not taken out of the room
      expect(socketsLeave).not.toHaveBeenCalled();
      expect(payloadOf(WS_EVENTS.SUPPORT_STATUS_CHANGE).claimedById).toBe('admin-1');
    });

    it('answers 404 for an unknown ticket and changes nothing', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      const res = await request(app).post(`${BASE}/nope/claim`).set(as('admin-1'));
      expect(res.status).toBe(404);
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
      expect(timeline).toEqual([]);
    });

    it('refuses a closed ticket with 400 and changes nothing', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'closed' }));
      const res = await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));
      expect(res.status).toBe(400);
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
      expect(timeline).toEqual([]);
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('answers 500 when the database fails', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportTicket.update.mockRejectedValue(new Error('db down'));
      const res = await request(app).post(`${BASE}/ticket-1/claim`).set(as('admin-1'));
      expect(res.status).toBe(500);
      expect(timeline).toEqual([]);
    });
  });

  // Rule: reading a thread joins the reader to the ticket room and pages oldest-last within bounds.
  describe('GET /admin/support/tickets/:id/messages', () => {
    it('returns the thread oldest first and joins the caller to support:{id}', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.findMany.mockResolvedValue([
        messageRow({ id: 'm2', createdAt: new Date('2026-01-05T00:00:00Z') }),
        messageRow({ id: 'm1', createdAt: new Date('2026-01-04T00:00:00Z') }),
      ]);

      const res = await request(app).get(`${BASE}/ticket-1/messages`).set(as('admin-1'));

      expect(res.status).toBe(200);
      expect(res.body.data.map((m: any) => m.id)).toEqual(['m1', 'm2']);
      expect(res.body.hasMore).toBe(false);
      expect(joins()).toEqual([['user:admin-1', 'support:ticket-1']]);
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].where).toEqual({ ticketId: 'ticket-1' });
    });

    it('reports hasMore and drops the extra row', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.findMany.mockResolvedValue([messageRow({ id: 'a' }), messageRow({ id: 'b' }), messageRow({ id: 'c' })]);
      const res = await request(app).get(`${BASE}/ticket-1/messages?limit=2`).set(as('admin-1'));
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].take).toBe(3);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('caps the page size at 100', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).get(`${BASE}/ticket-1/messages?limit=9999`).set(as('admin-1'));
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].take).toBe(101);
    });

    it('pages with a before date', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).get(`${BASE}/ticket-1/messages?before=2026-02-01T00:00:00.000Z`).set(as('admin-1'));
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].where).toEqual({
        ticketId: 'ticket-1', createdAt: { lt: new Date('2026-02-01T00:00:00.000Z') },
      });
    });

    it('answers 400 for a before value that is not a date', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      const res = await request(app).get(`${BASE}/ticket-1/messages?before=soon`).set(as('admin-1'));
      expect(res.status).toBe(400);
      expect(prismaMock.supportMessage.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown ticket and joins nothing', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      const res = await request(app).get(`${BASE}/nope/messages`).set(as('admin-1'));
      expect(res.status).toBe(404);
      expect(joins()).toEqual([]);
    });

    it('answers 500 when the database fails', async () => {
      prismaMock.supportTicket.findUnique.mockRejectedValue(new Error('db down'));
      const res = await request(app).get(`${BASE}/ticket-1/messages`).set(as('admin-1'));
      expect(res.status).toBe(500);
    });
  });

  // Rule: a staff reply claims an open ticket, is sanitized and length-bound, and is refused on a closed one.
  describe('POST /admin/support/tickets/:id/messages', () => {
    const post = (body: unknown, who = 'admin-1') =>
      request(app).post(`${BASE}/ticket-1/messages`).set(as(who)).send(body as object);

    it('stores a reply on a claimed ticket without claiming again', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed', claimedById: 'admin-2' }));

      const res = await post({ content: 'on it' });

      expect(res.status).toBe(201);
      expect(res.body.data.content).toBe('on it');
      expect(prismaMock.supportMessage.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data).toEqual({ ticketId: 'ticket-1', authorId: 'admin-1', content: 'on it' });
      // only the updatedAt bump, no claim
      expect(prismaMock.supportTicket.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.supportTicket.update.mock.calls[0][0].data).toEqual({ updatedAt: expect.any(Date) });
      expect(roomsOf(WS_EVENTS.SUPPORT_STATUS_CHANGE)).toEqual([]);
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('claims an open ticket for the replying admin, announces it and audits it', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());

      const res = await post({ content: 'hello there' });

      expect(res.status).toBe(201);
      const claim = prismaMock.supportTicket.update.mock.calls[0][0];
      expect(claim.data).toMatchObject({ status: 'claimed', claimedById: 'admin-1' });
      const created = prismaMock.supportMessage.create.mock.calls.map((c: any) => c[0].data);
      expect(created[0]).toMatchObject({ type: 'system', content: 'Staff member name-admin-1 has joined the conversation' });
      expect(created[1]).toEqual({ ticketId: 'ticket-1', authorId: 'admin-1', content: 'hello there' });
      expect(payloadOf(WS_EVENTS.SUPPORT_STATUS_CHANGE)).toEqual({
        ticketId: 'ticket-1', status: 'claimed', claimedById: 'admin-1', claimedByUsername: 'name-admin-1',
      });
      expect(roomsOf(WS_EVENTS.SUPPORT_STATUS_CHANGE).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'support.claim', targetId: 'ticket-1', actorId: 'admin-1' }));
    });

    it('emits the reply to the ticket room and to staff, then the count', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed' }));
      await post({ content: 'hi' });
      expect(roomsOf(WS_EVENTS.SUPPORT_MESSAGE_NEW).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(emits()).toContainEqual(['emit', 'admin:support', WS_EVENTS.SUPPORT_TICKET_NEW, { total: 4 }]);
    });

    it('strips HTML from the reply before storing it', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed' }));
      await post({ content: ' <i>thanks</i> <img src=x onerror=1>ok ' });
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data.content).toBe('thanks ok');
    });

    it('answers 404 for an unknown ticket', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(404);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
    });

    it('refuses a reply on a closed ticket with 400 and stores nothing', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'closed' }));
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(400);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
      expect(timeline).toEqual([]);
    });

    it('accepts the maximum length and refuses one character more', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed' }));
      expect((await post({ content: 'x'.repeat(LIMITS.SUPPORT_MESSAGE_MAX) })).status).toBe(201);
      expect((await post({ content: 'x'.repeat(LIMITS.SUPPORT_MESSAGE_MAX + 1) })).status).toBe(400);
    });

    it.each([
      ['an empty string', { content: '' }],
      ['only whitespace', { content: '  \n ' }],
      ['only an HTML tag', { content: '<b></b>' }],
      ['a number', { content: 7 }],
      ['an array', { content: ['a'] }],
      ['no content field', {}],
    ])('refuses %s with 400 on a claimed ticket', async (_label, body) => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed' }));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
      expect(timeline).toEqual([]);
    });

    // Defect: routes/admin.ts POST /support/tickets/:id/messages claims an open ticket (update, system
    // message, events, audit) BEFORE it validates the content, so a refused reply still claims it.
    it.fails('does not claim an open ticket when the reply itself is refused', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      const res = await post({ content: '' });
      expect(res.status).toBe(400);
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
    });

    it('answers 500 when storing the reply fails', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed' }));
      prismaMock.supportMessage.create.mockRejectedValue(new Error('db down'));
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(500);
      expect(roomsOf(WS_EVENTS.SUPPORT_MESSAGE_NEW)).toEqual([]);
    });
  });

  // Rule: closing ends an open or claimed ticket once, with a system message, events to both rooms and an audit row.
  describe('POST /admin/support/tickets/:id/close', () => {
    it('closes an open ticket', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());

      const res = await request(app).post(`${BASE}/ticket-1/close`).set(as('admin-1'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Ticket closed' });
      const update = prismaMock.supportTicket.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'ticket-1' });
      expect(update.data.status).toBe('closed');
      expect(update.data.closedAt).toBeInstanceOf(Date);
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data).toEqual({
        ticketId: 'ticket-1', authorId: 'admin-1', content: 'Ticket closed by name-admin-1', type: 'system',
      });
    });

    it('closes a ticket another admin holds', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed', claimedById: 'admin-2' }));
      const res = await request(app).post(`${BASE}/ticket-1/close`).set(as('admin-1'));
      expect(res.status).toBe(200);
    });

    it('announces the close message and the status change to both rooms, then the count, and audits it', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).post(`${BASE}/ticket-1/close`).set(as('admin-1'));
      expect(roomsOf(WS_EVENTS.SUPPORT_MESSAGE_NEW).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(roomsOf(WS_EVENTS.SUPPORT_STATUS_CHANGE).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(payloadOf(WS_EVENTS.SUPPORT_STATUS_CHANGE)).toEqual({ ticketId: 'ticket-1', status: 'closed' });
      expect(emits()).toContainEqual(['emit', 'admin:support', WS_EVENTS.SUPPORT_TICKET_NEW, { total: 4 }]);
      expect(auditSpy).toHaveBeenCalledWith({
        actorId: 'admin-1', action: 'support.close', targetType: 'support_ticket', targetId: 'ticket-1', metadata: { userId: 'user-9' },
      });
    });

    it('answers 404 for an unknown ticket', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      const res = await request(app).post(`${BASE}/nope/close`).set(as('admin-1'));
      expect(res.status).toBe(404);
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
    });

    it('refuses closing a closed ticket with 400 and changes nothing', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'closed' }));
      const res = await request(app).post(`${BASE}/ticket-1/close`).set(as('admin-1'));
      expect(res.status).toBe(400);
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
      expect(timeline).toEqual([]);
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('answers 500 when the database fails', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportTicket.update.mockRejectedValue(new Error('db down'));
      const res = await request(app).post(`${BASE}/ticket-1/close`).set(as('admin-1'));
      expect(res.status).toBe(500);
      expect(timeline).toEqual([]);
    });
  });
});
