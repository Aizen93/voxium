import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { LIMITS, WS_EVENTS } from '@voxium/shared';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(userId = 'user-1') {
  return jwt.sign({ userId, username: userId, tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  supportTicket: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  supportMessage: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }),
}));

// Every emit as [room, event, payload], in order; every room join as [userRoom, targetRoom]
const emitted: Array<[string, string, any]> = [];
const joins: Array<[string, string]> = [];
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push([room, event, payload]); } }),
    in: (room: string) => ({ socketsJoin: (target: string) => { joins.push([room, target]); } }),
  })),
}));

const { limiterSpy } = vi.hoisted(() => ({
  limiterSpy: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitSupport: limiterSpy,
  normalizeIp: (ip: string) => ip,
}));

const { flagSpy } = vi.hoisted(() => ({ flagSpy: vi.fn().mockReturnValue(true) }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: flagSpy }));

import { supportRouter } from '../../routes/support';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/support', supportRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface AuthUser { emailVerified?: boolean; termsAcceptedAt?: Date | null; privacyAcceptedAt?: Date | null }

function mockAccount(over: AuthUser = {}) {
  prismaMock.user.findUnique.mockResolvedValue({
    bannedAt: null,
    tokenVersion: 0,
    role: 'user',
    emailVerified: true,
    termsAcceptedAt: new Date(0),
    privacyAcceptedAt: new Date(0),
    ...over,
  });
}

const AUTHOR = {
  id: 'user-1', username: 'user-1', displayName: 'User One', avatarUrl: null,
  role: 'user', isSupporter: false, supporterTier: null,
};

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    userId: 'user-1',
    status: 'open',
    claimedById: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function messageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    ticketId: 'ticket-1',
    authorId: 'user-1',
    content: 'hello',
    type: 'user',
    createdAt: new Date('2026-01-03T00:00:00Z'),
    author: AUTHOR,
    ...over,
  };
}

const roomsOf = (event: string) => emitted.filter(([, e]) => e === event).map(([r]) => r);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Support routes (user side)', () => {
  let app: express.Express;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    emitted.length = 0;
    joins.length = 0;
    flagSpy.mockReturnValue(true);
    limiterSpy.mockImplementation((_req, _res, next) => next());
    mockAccount();
    prismaMock.supportTicket.count.mockResolvedValue(3);
    prismaMock.supportMessage.findMany.mockResolvedValue([]);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = createApp();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // Rule: every support route needs a signed-in, verified account that accepted the legal documents.
  describe('gates', () => {
    const routes: Array<['post' | 'get', string]> = [
      ['post', '/api/v1/support/open'],
      ['get', '/api/v1/support/ticket'],
      ['post', '/api/v1/support/messages'],
    ];

    it.each(routes)('%s %s answers 401 without a token and touches nothing', async (method, path) => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.create).not.toHaveBeenCalled();
    });

    it.each(routes)('%s %s answers 403 for an unverified email', async (method, path) => {
      mockAccount({ emailVerified: false });
      const res = await request(app)[method](path).set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(403);
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
    });

    it.each(routes)('%s %s answers 403 for an account that has not accepted the terms', async (method, path) => {
      mockAccount({ termsAcceptedAt: null });
      const res = await request(app)[method](path).set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(403);
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
    });

    it('answers 500 (not 401) when the account lookup fails', async () => {
      prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));
      const res = await request(app).get('/api/v1/support/ticket').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(500);
    });
  });

  // Rule: opening a ticket creates it once per user, reopens a closed one, joins the user's sockets to it and tells staff.
  describe('POST /support/open', () => {
    it('creates a ticket for the caller with an opening system message', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      prismaMock.supportTicket.create.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.create.mockResolvedValue(messageRow({ type: 'system', content: 'Support ticket opened' }));

      const res = await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(prismaMock.supportTicket.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(prismaMock.supportTicket.create).toHaveBeenCalledWith({ data: { userId: 'user-1' } });
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data).toEqual({
        ticketId: 'ticket-1', authorId: 'user-1', content: 'Support ticket opened', type: 'system',
      });
      expect(res.body.data.ticket).toEqual({
        id: 'ticket-1', status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(Array.isArray(res.body.data.messages)).toBe(true);
    });

    it('announces the new message to the ticket room and to staff, joins the caller, and sends the open-ticket count', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      prismaMock.supportTicket.create.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.create.mockResolvedValue(messageRow({ type: 'system', content: 'Support ticket opened' }));

      await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);

      expect(roomsOf(WS_EVENTS.SUPPORT_MESSAGE_NEW).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(joins).toEqual([['user:user-1', 'support:ticket-1']]);
      expect(prismaMock.supportTicket.count).toHaveBeenCalledWith({ where: { status: { in: ['open', 'claimed'] } } });
      expect(emitted).toContainEqual(['admin:support', WS_EVENTS.SUPPORT_TICKET_NEW, { total: 3 }]);
      expect(roomsOf(WS_EVENTS.SUPPORT_STATUS_CHANGE)).toEqual([]);
    });

    it('returns an existing open ticket without creating, updating or adding a message', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'claimed' }));
      prismaMock.supportMessage.findMany.mockResolvedValue([messageRow()]);

      const res = await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.status).toBe('claimed');
      expect(res.body.data.messages).toHaveLength(1);
      expect(prismaMock.supportTicket.create).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.update).not.toHaveBeenCalled();
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
      expect(joins).toEqual([['user:user-1', 'support:ticket-1']]);
    });

    it('reopens a closed ticket, clears its claim and tells both rooms', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'closed', claimedById: 'admin-9' }));
      prismaMock.supportTicket.update.mockResolvedValue(ticketRow({ status: 'open' }));
      prismaMock.supportMessage.create.mockResolvedValue(messageRow({ type: 'system', content: 'Support ticket reopened' }));

      const res = await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.status).toBe('open');
      expect(prismaMock.supportTicket.create).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.update).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        data: { status: 'open', claimedById: null, claimedAt: null, closedAt: null },
      });
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data.content).toBe('Support ticket reopened');
      expect(roomsOf(WS_EVENTS.SUPPORT_STATUS_CHANGE).sort()).toEqual(['admin:support', 'support:ticket-1']);
      const status = emitted.find(([, e]) => e === WS_EVENTS.SUPPORT_STATUS_CHANGE)![2];
      expect(status).toEqual({ ticketId: 'ticket-1', status: 'open' });
      expect(joins).toEqual([['user:user-1', 'support:ticket-1']]);
    });

    it('uses the caller from the token, never an id from the body', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).post('/api/v1/support/open')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ userId: 'someone-else', ticketId: 'ticket-9' });
      expect(prismaMock.supportTicket.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(joins).toEqual([['user:user-1', 'support:ticket-1']]);
    });

    it('answers 403 and writes nothing when the support flag is off', async () => {
      flagSpy.mockReturnValue(false);
      const res = await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Support tickets are currently disabled');
      expect(flagSpy).toHaveBeenCalledWith('support');
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.supportTicket.create).not.toHaveBeenCalled();
    });

    it('answers 500 when the database fails', async () => {
      prismaMock.supportTicket.findUnique.mockRejectedValue(new Error('db down'));
      const res = await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(500);
      expect(emitted).toEqual([]);
    });

    it('runs behind the support rate limiter', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);
      expect(limiterSpy).toHaveBeenCalledTimes(1);
    });

    it('stops at the rate limiter before reading the database when it refuses', async () => {
      limiterSpy.mockImplementation((_req, res: any) => { res.status(429).json({ success: false }); });
      const res = await request(app).post('/api/v1/support/open').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(429);
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
    });
  });

  // Rule: a user reads only their own ticket, newest page first, with a bounded page size.
  describe('GET /support/ticket', () => {
    it('answers an empty result when the caller has no ticket', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/v1/support/ticket').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { ticket: null, messages: [] } });
      expect(prismaMock.supportMessage.findMany).not.toHaveBeenCalled();
    });

    it('looks the ticket up by the caller and reads messages of that ticket only', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.findMany.mockResolvedValue([
        messageRow({ id: 'm2', createdAt: new Date('2026-01-05T00:00:00Z') }),
        messageRow({ id: 'm1', createdAt: new Date('2026-01-04T00:00:00Z') }),
      ]);

      const res = await request(app)
        .get('/api/v1/support/ticket?ticketId=ticket-9&userId=user-2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(prismaMock.supportTicket.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].where).toEqual({ ticketId: 'ticket-1' });
      // fetched newest first, returned oldest first
      expect(res.body.data.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
      expect(res.body.data.hasMore).toBe(false);
      expect(res.body.data.messages[0].createdAt).toBe('2026-01-04T00:00:00.000Z');
    });

    it('reports hasMore and drops the extra row when the page is full', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.findMany.mockResolvedValue([
        messageRow({ id: 'a' }), messageRow({ id: 'b' }), messageRow({ id: 'c' }),
      ]);
      const res = await request(app).get('/api/v1/support/ticket?limit=2').set('Authorization', `Bearer ${makeToken()}`);
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].take).toBe(3);
      expect(res.body.data.hasMore).toBe(true);
      expect(res.body.data.messages).toHaveLength(2);
    });

    it.each([
      ['5000', 101],
      ['0', 51],
      ['abc', 51],
    ])('bounds the page size (limit=%s reads take=%i)', async (limit, take) => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).get(`/api/v1/support/ticket?limit=${limit}`).set('Authorization', `Bearer ${makeToken()}`);
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].take).toBe(take);
    });

    // Defect: routes/support.ts GET /ticket has no lower bound on limit, so limit=-4 reads take=-3
    // (Prisma reads a negative take backwards). Kept as it.fails until the route clamps it.
    it.fails('never reads a negative page size', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).get('/api/v1/support/ticket?limit=-4').set('Authorization', `Bearer ${makeToken()}`);
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].take).toBeGreaterThan(0);
    });

    it('pages with a before date', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      await request(app).get('/api/v1/support/ticket?before=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${makeToken()}`);
      expect(prismaMock.supportMessage.findMany.mock.calls[0][0].where).toEqual({
        ticketId: 'ticket-1', createdAt: { lt: new Date('2026-02-01T00:00:00.000Z') },
      });
    });

    it('answers 400 for a before value that is not a date', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      const res = await request(app).get('/api/v1/support/ticket?before=yesterday').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(400);
      expect(prismaMock.supportMessage.findMany).not.toHaveBeenCalled();
    });

    it('answers 500 when the database fails', async () => {
      prismaMock.supportTicket.findUnique.mockRejectedValue(new Error('db down'));
      const res = await request(app).get('/api/v1/support/ticket').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(500);
    });
  });

  // Rule: a user posts only into their own open ticket; content is sanitized and length-bound; staff are told.
  describe('POST /support/messages', () => {
    beforeEach(() => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow());
      prismaMock.supportMessage.create.mockImplementation(async ({ data }: any) => messageRow({ content: data.content }));
      prismaMock.supportTicket.update.mockResolvedValue(ticketRow());
    });

    const post = (body: unknown) =>
      request(app).post('/api/v1/support/messages').set('Authorization', `Bearer ${makeToken()}`).send(body as object);

    it('stores the message in the caller\'s own ticket, whatever ids the body names', async () => {
      const res = await post({ content: 'need help', ticketId: 'ticket-9', authorId: 'user-2', type: 'system' });
      expect(res.status).toBe(201);
      expect(prismaMock.supportTicket.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data).toEqual({
        ticketId: 'ticket-1', authorId: 'user-1', content: 'need help',
      });
      expect(res.body.data.content).toBe('need help');
    });

    it('emits the message to the ticket room and to staff, then the open-ticket count', async () => {
      await post({ content: 'need help' });
      expect(roomsOf(WS_EVENTS.SUPPORT_MESSAGE_NEW).sort()).toEqual(['admin:support', 'support:ticket-1']);
      expect(emitted).toContainEqual(['admin:support', WS_EVENTS.SUPPORT_TICKET_NEW, { total: 3 }]);
      expect(prismaMock.supportTicket.update).toHaveBeenCalledWith({ where: { id: 'ticket-1' }, data: { updatedAt: expect.any(Date) } });
    });

    it('strips HTML from the content before storing it', async () => {
      await post({ content: '  <b>hi</b> <script>alert(1)</script>there  ' });
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data.content).toBe('hi alert(1)there');
    });

    it('drops NUL bytes from the content', async () => {
      await post({ content: `a${String.fromCharCode(0)}b` });
      expect(prismaMock.supportMessage.create.mock.calls[0][0].data.content).toBe('ab');
    });

    it('answers 404 when the caller has no ticket', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(null);
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(404);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
    });

    it('answers 400 for a closed ticket and stores nothing', async () => {
      prismaMock.supportTicket.findUnique.mockResolvedValue(ticketRow({ status: 'closed' }));
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/closed/i);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });

    it('accepts content of exactly the maximum length', async () => {
      const res = await post({ content: 'x'.repeat(LIMITS.SUPPORT_MESSAGE_MAX) });
      expect(res.status).toBe(201);
    });

    it('refuses content one character over the maximum', async () => {
      const res = await post({ content: 'x'.repeat(LIMITS.SUPPORT_MESSAGE_MAX + 1) });
      expect(res.status).toBe(400);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty string', { content: '' }],
      ['only whitespace', { content: '   \n\t ' }],
      ['only an HTML tag', { content: '<b></b>' }],
      ['a number', { content: 42 }],
      ['an array', { content: ['hi'] }],
      ['an object', { content: { a: 1 } }],
      ['no content field', {}],
    ])('refuses %s with 400', async (_label, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(prismaMock.supportMessage.create).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });

    it('answers 500 when storing the message fails, and emits nothing', async () => {
      prismaMock.supportMessage.create.mockRejectedValue(new Error('db down'));
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(500);
      expect(emitted).toEqual([]);
    });

    it('runs behind the support rate limiter', async () => {
      await post({ content: 'hi' });
      expect(limiterSpy).toHaveBeenCalledTimes(1);
    });

    it('stops at the rate limiter before reading the database when it refuses', async () => {
      limiterSpy.mockImplementation((_req, res: any) => { res.status(429).json({ success: false }); });
      const res = await post({ content: 'hi' });
      expect(res.status).toBe(429);
      expect(prismaMock.supportTicket.findUnique).not.toHaveBeenCalled();
    });
  });
});
