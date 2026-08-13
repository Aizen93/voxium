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
    channel: { findMany: vi.fn(), findUnique: vi.fn() },
    message: { findMany: vi.fn() },
  },
}));

const mockFilterVisibleChannels = vi.fn();
vi.mock('../../utils/permissionCalculator', () => ({
  filterVisibleChannels: (...args: any[]) => mockFilterVisibleChannels(...args),
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

describe('Search routes — server search respects visibility and encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({
      userId: 'user-1', serverId: 'srv-1',
    } as any);
  });

  it('searches only channels the member can VIEW, never secure ones, never ciphertext', async () => {
    vi.mocked(prisma.channel.findMany).mockResolvedValueOnce([
      { id: 'ch-visible', secure: false },
      { id: 'ch-hidden', secure: false },
    ] as any);
    // Visibility filter drops ch-hidden
    mockFilterVisibleChannels.mockResolvedValueOnce([{ id: 'ch-visible', secure: false }]);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([]);

    const res = await request(createApp()).get('/api/v1/search/servers/srv-1/messages?q=hello');

    expect(res.status).toBe(200);
    // Secure channels are excluded at the SQL level, before visibility math
    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'srv-1', type: 'text', secure: false },
      select: { id: true, secure: true },
    });
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channelId: { in: ['ch-visible'] },
          encrypted: false,
        }),
      }),
    );
  });

  it('returns empty (not everything) when the member can see no channels', async () => {
    vi.mocked(prisma.channel.findMany).mockResolvedValueOnce([
      { id: 'ch-hidden', secure: false },
    ] as any);
    mockFilterVisibleChannels.mockResolvedValueOnce([]);

    const res = await request(createApp()).get('/api/v1/search/servers/srv-1/messages?q=hello');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('rejects a SECURE channelId with the same error as an invalid one (no oracle)', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({
      id: 'ch-sec', serverId: 'srv-1', type: 'text', secure: true,
    } as any);

    const res = await request(createApp()).get(
      '/api/v1/search/servers/srv-1/messages?q=hello&channelId=ch-sec',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid channel');
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('rejects a channelId the member cannot VIEW with the same generic error', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({
      id: 'ch-hidden', serverId: 'srv-1', type: 'text', secure: false,
    } as any);
    mockFilterVisibleChannels.mockResolvedValueOnce([]);

    const res = await request(createApp()).get(
      '/api/v1/search/servers/srv-1/messages?q=hello&channelId=ch-hidden',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid channel');
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
});
