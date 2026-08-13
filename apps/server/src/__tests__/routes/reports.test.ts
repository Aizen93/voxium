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

  it('a secure-channel MEMBER can report with their decrypted plaintext', async () => {
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

    expect(res.status).toBe(201);
    expect(prisma.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messageContent: 'the decrypted offending text',
          contentSource: 'reporter',
        }),
      }),
    );
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
