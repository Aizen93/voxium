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
