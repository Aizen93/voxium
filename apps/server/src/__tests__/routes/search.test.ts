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

describe('Search routes — there is no server-side DM search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 404 for the removed DM route and touches no table (every DM is ciphertext; search is local)', async () => {
    const res = await request(createApp()).get('/api/v1/search/dm/conv-1/messages?q=secret');
    expect(res.status).toBe(404);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
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

  it('returns a webhook-posted match with its synthesised author (never a null author), a human match unchanged', async () => {
    vi.mocked(prisma.channel.findMany).mockResolvedValueOnce([{ id: 'ch-1', secure: false }] as any);
    mockFilterVisibleChannels.mockResolvedValueOnce([{ id: 'ch-1', secure: false }]);
    const human = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null };
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([
      {
        id: 'msg-hook', content: 'deploy hello', type: 'user', channelId: 'ch-1', authorId: null,
        webhookId: 'wh-1', webhookName: 'CI', author: null, channel: { name: 'general' },
        createdAt: new Date('2026-10-18T12:00:00Z'), editedAt: null,
      },
      {
        id: 'msg-gone', content: 'old hello', type: 'user', channelId: 'ch-1', authorId: null,
        webhookId: null, webhookName: 'Old bot', author: null, channel: { name: 'general' },
        createdAt: new Date('2026-10-17T12:00:00Z'), editedAt: null,
      },
      {
        id: 'msg-human', content: 'hello @everyone', type: 'user', channelId: 'ch-1', authorId: 'user-2',
        webhookId: null, webhookName: null, author: human, channel: { name: 'general' },
        mentionsEveryone: true,
        createdAt: new Date('2026-10-16T12:00:00Z'), editedAt: null,
      },
    ] as any);

    const res = await request(createApp()).get('/api/v1/search/servers/srv-1/messages?q=hello');

    expect(res.status).toBe(200);
    const [hook, gone, person] = res.body.data;
    expect(hook.author).toEqual({ id: 'webhook:wh-1', username: 'CI', displayName: 'CI', avatarUrl: null, isWebhook: true });
    expect(hook.webhookId).toBe('wh-1');
    expect(hook.channelName).toBe('general');
    expect(gone.author).toEqual({ id: 'webhook:deleted', username: 'Old bot', displayName: 'Old bot', avatarUrl: null, isWebhook: true });
    expect(gone.webhookId).toBeNull();
    expect(person.author).toEqual(human);
    expect(person.webhookId).toBeNull();
    // The server's @everyone decision travels with a result, so it renders as
    // a mention there exactly as it does in the channel
    expect(person.mentionsEveryone).toBe(true);
    expect(hook.mentionsEveryone).toBeUndefined();
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
