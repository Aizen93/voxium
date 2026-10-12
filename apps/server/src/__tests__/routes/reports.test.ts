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
