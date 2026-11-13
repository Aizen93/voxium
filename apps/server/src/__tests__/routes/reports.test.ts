import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
  requireConsent: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitReport: passthrough,
  };
});

const mockEmit = vi.fn();
const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: mockTo })),
}));

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    server: { findUnique: vi.fn() },
    report: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    serverMember: { findUnique: vi.fn() },
    channelMember: { findUnique: vi.fn() },
    message: { findUnique: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}));

import { prisma } from '../../utils/prisma';
import { reportsRouter } from '../../routes/reports';
import { errorHandler } from '../../middleware/errorHandler';

// ─── App setup ──────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Report Routes — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when reportedUserId is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ type: 'user', reason: 'Spam user doing spam things' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reportedUserId/i);
  });

  it('returns 400 when reportedUserId is not a string', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ type: 'user', reportedUserId: 12345, reason: 'Spam user doing spam things' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reportedUserId/i);
  });

  it('returns 400 when messageId is not a string for message reports', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'user-2' } as any);
    vi.mocked(prisma.report.findFirst).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ type: 'message', reportedUserId: 'user-2', messageId: 99999, reason: 'Offensive message content here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/messageId/i);
  });

  it('returns 400 with invalid report type', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ type: 'invalid', reportedUserId: 'user-2', reason: 'Some reason text here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid report type/i);
  });
});

describe('Report Routes — E2E message reports', () => {
  const baseDMMessage = {
    id: 'msg-1',
    content: 'server-side content',
    encrypted: false,
    channelId: null,
    conversationId: 'conv-1',
    authorId: 'user-2',
    channel: null,
  };

  function mockHappyPath(message: Record<string, unknown>) {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-2' } as any);
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.message.findUnique).mockResolvedValue(message as any);
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ id: 'conv-1' } as any);
    vi.mocked(prisma.report.create).mockResolvedValue({ id: 'report-1' } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.report.count).mockResolvedValue(0);
  });

  it('copies server content for plaintext messages (contentSource=server)', async () => {
    mockHappyPath(baseDMMessage);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ type: 'message', reportedUserId: 'user-2', messageId: 'msg-1', reason: 'Harassment in this DM' });

    expect(res.status).toBe(201);
    expect(prisma.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageContent: 'server-side content', contentSource: 'server' }),
      })
    );
  });

  it('uses reporter-provided plaintext for encrypted messages (contentSource=reporter)', async () => {
    mockHappyPath({ ...baseDMMessage, encrypted: true, content: '{"v":1,"e":"olm1","t":1,"b":"QWJj"}' });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({
        type: 'message',
        reportedUserId: 'user-2',
        messageId: 'msg-1',
        reason: 'Harassment in this DM',
        reportedContent: 'the decrypted text I saw',
      });

    expect(res.status).toBe(201);
    expect(prisma.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageContent: 'the decrypted text I saw', contentSource: 'reporter' }),
      })
    );
    // the ciphertext itself must never be copied into the report
    const created = vi.mocked(prisma.report.create).mock.calls[0][0] as any;
    expect(created.data.messageContent).not.toContain('olm1');
  });

  it('stores null content for encrypted messages when the reporter provides none', async () => {
    mockHappyPath({ ...baseDMMessage, encrypted: true, content: '{"v":1,"e":"olm1","t":1,"b":"QWJj"}' });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ type: 'message', reportedUserId: 'user-2', messageId: 'msg-1', reason: 'Harassment in this DM' });

    expect(res.status).toBe(201);
    expect(prisma.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageContent: null, contentSource: 'reporter' }),
      })
    );
  });

  it('rejects oversized reporter-provided content', async () => {
    mockHappyPath({ ...baseDMMessage, encrypted: true });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({
        type: 'message',
        reportedUserId: 'user-2',
        messageId: 'msg-1',
        reason: 'Harassment in this DM',
        reportedContent: 'x'.repeat(4001),
      });

    expect(res.status).toBe(400);
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  // ── SECURE channel messages ────────────────────────────────────────────

  const baseSecureMessage = {
    id: 'msg-9',
    content: '{"v":1,"e":"megolm1","sid":"c2Vzcw","b":"QWJj"}',
    encrypted: true,
    channelId: 'sec-1',
    conversationId: null,
    authorId: 'user-2',
    channel: { serverId: 'srv-1', secure: true },
  };

  // Messages in a secure channel cannot be reported, by anyone: the content
  // is not the server's to read, so the only "evidence" would be text the
  // reporter typed. The members deal with each other; a member who wants the
  // channel gone copies its id from the context menu and hands it to a server
  // admin, whose lever is delete-by-id in server settings.
  it('a secure-channel MEMBER cannot report — answered like a nonexistent message', async () => {
    mockHappyPath(baseSecureMessage);
    vi.mocked(prisma.channelMember.findUnique).mockResolvedValue({ userId: 'user-1' } as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({
        type: 'message',
        reportedUserId: 'user-2',
        messageId: 'msg-9',
        reason: 'Harassment in this channel',
        reportedContent: 'the decrypted offending text',
      });

    expect(res.status).toBe(404);
    expect(prisma.report.create).not.toHaveBeenCalled();
    // Refused BEFORE any membership lookup: the answer — and its cost — is the
    // same for a member, a non-member, and a message that does not exist
    expect(prisma.channelMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.serverMember.findUnique).not.toHaveBeenCalled();
  });

  it('a server member who is NOT a channel member gets 404 — not an oracle', async () => {
    mockHappyPath(baseSecureMessage);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({ userId: 'user-1' } as any);
    vi.mocked(prisma.channelMember.findUnique).mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/reports')
      .send({
        type: 'message',
        reportedUserId: 'user-2',
        messageId: 'msg-9',
        reason: 'Fishing for secure channels',
      });

    expect(res.status).toBe(404);
    expect(prisma.report.create).not.toHaveBeenCalled();
  });
});

// ─── Webhook-posted messages (no user author) ───────────────────────────────

describe('Report Routes — webhook-posted messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.report.count).mockResolvedValue(0);
  });

  it('a webhook message (authorId null) cannot be pinned on a user: 400, no report written', async () => {
    // The row as the route selects it, plus the webhook columns a webhook row
    // carries: authorId is NULL, so no reportedUserId can ever match it.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-2' } as any);
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.message.findUnique).mockResolvedValue({
      id: 'msg-wh',
      content: 'Build #42 passed',
      encrypted: false,
      channelId: 'ch-1',
      conversationId: null,
      authorId: null,
      webhookId: 'wh1',
      webhookName: 'CI',
      channel: { serverId: 'srv-1', secure: false },
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({ userId: 'user-1' } as any);

    const res = await request(createApp())
      .post('/api/v1/reports')
      .send({ type: 'message', reportedUserId: 'user-2', messageId: 'msg-wh', reason: 'Spam from this integration' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Reported user does not match message author' });
    expect(prisma.message.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'msg-wh' } }));
    expect(prisma.report.create).not.toHaveBeenCalled();
  });
});

// ─── Server reports (directory listings) ────────────────────────────────────

describe('Report Routes — type: server', () => {
  const REASON = 'This listing is spam and misleading';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.report.create).mockResolvedValue({} as any);
    vi.mocked(prisma.report.count).mockResolvedValue(1 as any);
  });

  it('requires serverId (and not reportedUserId — the owner is resolved from the listing)', async () => {
    const res = await request(createApp()).post('/api/v1/reports').send({ type: 'server', reason: REASON });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/serverId/);
  });

  it('answers a hidden server exactly like a nonexistent one, before any report lookup', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce(null as any);
    const missing = await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'zzz', reason: REASON });
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce({ id: 'srv-1', name: 'S', description: 'd', ownerId: 'owner-1', discoveryListed: false } as any);
    const hidden = await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });
    expect(missing.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(prisma.report.findFirst).not.toHaveBeenCalled();
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('refuses the owner reporting their own server', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValue({ id: 'srv-1', name: 'S', description: null, ownerId: 'user-1', discoveryListed: true } as any);
    const res = await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own server/);
  });

  it('dedupes on (reporter, server, pending)', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValue({ id: 'srv-1', name: 'S', description: null, ownerId: 'owner-1', discoveryListed: true } as any);
    vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: 'rep-1' } as any);
    const res = await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });
    expect(res.status).toBe(400);
    expect(prisma.report.findFirst).toHaveBeenCalledWith({
      where: { reporterId: 'user-1', serverId: 'srv-1', type: 'server', status: 'pending' },
      select: { id: true },
    });
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('files the report against the owner with the name + description snapshot (contentSource server) and notifies admins', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValue({ id: 'srv-1', name: 'Shady Lounge', description: 'Totally legit', ownerId: 'owner-1', discoveryListed: true } as any);

    const res = await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });

    expect(res.status).toBe(201);
    expect(prisma.report.create).toHaveBeenCalledWith({
      data: {
        type: 'server',
        reason: REASON,
        reporterId: 'user-1',
        reportedUserId: 'owner-1',
        messageId: null,
        messageContent: 'Shady Lounge\n\nTotally legit',
        contentSource: 'server',
        channelId: null,
        conversationId: null,
        serverId: 'srv-1',
      },
    });
    expect(mockTo).toHaveBeenCalledWith('admin:reports');
    expect(mockEmit).toHaveBeenCalledWith('report:new', { total: 1 });
  });

  it('a server without a description snapshots the name alone', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValue({ id: 'srv-1', name: 'Quiet', description: null, ownerId: 'owner-1', discoveryListed: true } as any);
    await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });
    expect(prisma.report.create).toHaveBeenCalledWith({ data: expect.objectContaining({ messageContent: 'Quiet' }) });
  });
});

// ─── Two identical reports at once ──────────────────────────────────────────
//
// The look for a pending report and the insert are two statements: two
// identical reports sent together both pass the look. The database refuses
// the second insert (the partial unique indexes of migration
// 20261111150000_reports_one_pending_per_target), and its unique violation
// must get the look's own answer, never a 500.

describe('Report Routes — the duplicate the look cannot see', () => {
  const REASON = 'Harassing other members in the channel';
  const DUPLICATE = 'You already have a pending report against this target';
  /** A unique violation as the pg adapter reports it (shape printed from a real one): the index named in `meta`. */
  const p2002 = (index: string) => Object.assign(new Error(`Unique constraint failed on the constraint: \`${index}\``), {
    code: 'P2002',
    meta: {
      modelName: 'Report',
      driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23505', kind: 'UniqueConstraintViolation', constraint: { index }, table: 'reports' } },
    },
  });

  /** Two requests at once: both pass the look, the database admits the first insert and refuses the second. */
  function databaseAdmitsOne(index: string) {
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any);
    let inserted = 0;
    vi.mocked(prisma.report.create).mockImplementation((async () => {
      inserted += 1;
      if (inserted > 1) throw p2002(index);
      return {};
    }) as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.report.count).mockResolvedValue(1 as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-2' } as any);
  });

  it('two identical USER reports at once: one is filed, the other gets the existing 400', async () => {
    databaseAdmitsOne('reports_pending_user_key');
    const send = () => request(createApp()).post('/api/v1/reports').send({ type: 'user', reportedUserId: 'user-2', reason: REASON });

    const [a, b] = await Promise.all([send(), send()]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect((a.status === 400 ? a : b).body.error).toBe(DUPLICATE);
    expect(prisma.report.findFirst).toHaveBeenCalledTimes(2);
    // admins hear about the one report filed, not about the refusal
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('two identical MESSAGE reports at once: one is filed, the other gets the existing 400', async () => {
    databaseAdmitsOne('reports_pending_message_key');
    vi.mocked(prisma.message.findUnique).mockResolvedValue({
      id: 'msg-1', content: 'hi', encrypted: false, channelId: 'ch-1', conversationId: null, authorId: 'user-2',
      channel: { serverId: 'srv-1', secure: false },
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({ userId: 'user-1' } as any);
    const send = () => request(createApp()).post('/api/v1/reports').send({ type: 'message', reportedUserId: 'user-2', messageId: 'msg-1', reason: REASON });

    const [a, b] = await Promise.all([send(), send()]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect((a.status === 400 ? a : b).body.error).toBe(DUPLICATE);
  });

  it('two identical SPACE reports at once: one is filed, the other gets the existing 400', async () => {
    databaseAdmitsOne('reports_pending_server_key');
    vi.mocked(prisma.server.findUnique).mockResolvedValue({ id: 'srv-1', name: 'S', description: null, ownerId: 'owner-1', discoveryListed: true } as any);
    const send = () => request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });

    const [a, b] = await Promise.all([send(), send()]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect((a.status === 400 ? a : b).body.error).toBe(DUPLICATE);
  });

  it('a unique violation of another index (the primary key) is not a duplicate report: it surfaces as the 500 it is', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.report.create).mockRejectedValue(p2002('reports_pkey'));
    try {
      const res = await request(createApp()).post('/api/v1/reports').send({ type: 'user', reportedUserId: 'user-2', reason: REASON });

      expect(res.status).toBe(500);
      expect(res.body.error).not.toBe(DUPLICATE);
      expect(mockEmit).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a unique violation whose meta names no index is not taken for a duplicate report either', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any);
    // the message quotes a pending index, the meta does not: the meta decides
    vi.mocked(prisma.report.create).mockRejectedValue(Object.assign(new Error('Unique constraint failed on the constraint: `reports_pending_user_key`'), { code: 'P2002' }));
    try {
      const res = await request(createApp()).post('/api/v1/reports').send({ type: 'user', reportedUserId: 'user-2', reason: REASON });
      expect(res.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('the index named as the meta target (the form without the pg adapter) is a duplicate report too', async () => {
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.report.create).mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: 'reports_pending_server_key' } }));
    vi.mocked(prisma.server.findUnique).mockResolvedValue({ id: 'srv-1', name: 'S', description: null, ownerId: 'owner-1', discoveryListed: true } as any);

    const res = await request(createApp()).post('/api/v1/reports').send({ type: 'server', serverId: 'srv-1', reason: REASON });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(DUPLICATE);
  });

  it('any other failure of the insert still answers 500', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.report.create).mockRejectedValue(Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' }));

    const res = await request(createApp()).post('/api/v1/reports').send({ type: 'user', reportedUserId: 'user-2', reason: REASON });

    expect(res.status).toBe(500);
    expect(mockEmit).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
