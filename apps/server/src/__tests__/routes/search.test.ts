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
  return { rateLimitSearch: passthrough, rateLimitGeneral: passthrough };
});

vi.mock('../../utils/prisma', () => ({
  prisma: {
    conversation: { findUnique: vi.fn() },
    serverMember: { findUnique: vi.fn(), findMany: vi.fn() },
    channel: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
  },
}));

import { prisma } from '../../utils/prisma';
import { searchRouter } from '../../routes/search';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/search', searchRouter);
  app.use(errorHandler);
  return app;
}

describe('Search routes — DM search excludes E2E messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always filters encrypted messages out of DM search', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2',
    } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([]);

    const res = await request(createApp()).get('/api/v1/search/dm/conv-1/messages?q=secret');

    expect(res.status).toBe(200);
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ encrypted: false, conversationId: 'conv-1' }),
      })
    );
  });

  it('still denies non-participants', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      id: 'conv-1', user1Id: 'other-1', user2Id: 'other-2',
    } as any);

    const res = await request(createApp()).get('/api/v1/search/dm/conv-1/messages?q=secret');
    expect(res.status).toBe(403);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
});
