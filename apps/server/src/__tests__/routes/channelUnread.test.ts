import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// GET /servers/:serverId/channels/unread: the caller's unread counts for the
// visible text channels of one space, the statement unread:init runs at
// connect, asked again by a client whose counts a purge made stale.

const h = vi.hoisted(() => ({
  auth: { userId: 'user-1' as string | null },
  limiterCalls: [] as string[],
}));

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, res: any, next: () => void) => {
    if (!h.auth.userId) {
      res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
      return;
    }
    req.user = { userId: h.auth.userId, username: 'tester', role: 'user', tokenVersion: 0, emailVerified: true, consentRequired: false };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: () => void) => next(),
  requireConsent: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitCategoryManage: passthrough,
    rateLimitMarkRead: passthrough,
    rateLimitMemberRead: (_req: any, _res: any, next: () => void) => { h.limiterCalls.push('memberRead'); next(); },
  };
});

const prismaMock: Record<string, any> = {
  serverMember: { findUnique: vi.fn() },
  channel: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }),
}));

vi.mock('../../utils/permissionCalculator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/permissionCalculator')>()),
  filterVisibleChannels: vi.fn(),
}));
vi.mock('../../websocket/socketServer', () => ({ getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn() })) }));
vi.mock('../../websocket/voiceCluster', () => ({ broadcastChannelVoiceCleanup: vi.fn() }));
vi.mock('../../utils/secureChannelLifecycle', () => ({ deleteSecureChannel: vi.fn() }));
vi.mock('../../utils/webhookLifecycle', () => ({ emitWebhookChanged: vi.fn() }));
vi.mock('../../utils/attachmentBlobs', () => ({ collectAttachmentKeys: vi.fn(), deleteAttachmentBlobs: vi.fn() }));
vi.mock('../../utils/serverLimits', () => ({ getEffectiveLimits: vi.fn() }));
vi.mock('../../utils/channelVisibilityRooms', () => ({
  visibilityRequestMark: vi.fn(), resyncRequestedSince: vi.fn(), recheckVisibilityAfterJoin: vi.fn(),
}));

import { channelRouter } from '../../routes/channels';
import { errorHandler } from '../../middleware/errorHandler';
import { filterVisibleChannels } from '../../utils/permissionCalculator';

const app = express();
app.use(express.json());
app.use('/api/v1/servers/:serverId/channels', channelRouter);
app.use(errorHandler);

const get = (serverId = 'srv-1') => request(app).get(`/api/v1/servers/${serverId}/channels/unread`);

function channelRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, categoryId: null, position: 0, type: 'text', secure: false, ...extra };
}

/** The raw statement's text, with its interpolated values */
function sqlOfCall(call: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = call as [string[], ...unknown[]];
  return { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.userId = 'user-1';
  h.limiterCalls.length = 0;
  prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1' });
  prismaMock.channel.findMany.mockResolvedValue([channelRow('ch-1'), channelRow('ch-2')]);
  vi.mocked(filterVisibleChannels).mockImplementation(async (_u, _s, channels) => channels as never);
  prismaMock.$queryRaw.mockResolvedValue([]);
});

describe('GET /servers/:serverId/channels/unread', () => {
  it('answers the counts of the space\'s visible text channels, nothing for a channel with none, on the memberRead bucket', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ channel_id: 'ch-1', cnt: 3 }, { channel_id: 'ch-2', cnt: 100 }]);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [{ channelId: 'ch-1', serverId: 'srv-1', count: 3 }, { channelId: 'ch-2', serverId: 'srv-1', count: 100 }],
    });
    expect(h.limiterCalls).toEqual(['memberRead']);
  });

  it('is ONE statement for the whole space, over the visible channels only, with the caller\'s own rows left out by IS DISTINCT FROM and the cap of 100', async () => {
    vi.mocked(filterVisibleChannels).mockResolvedValue([channelRow('ch-1')] as never);

    await get();

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOfCall(prismaMock.$queryRaw.mock.calls[0]);
    expect(text).toContain('m.author_id IS DISTINCT FROM ?');
    expect(text).toContain('LIMIT 100');
    // channels with nothing unread are left out
    expect(text).toContain('AND cnt.val > 0');
    expect(text).toContain('COALESCE(cr.last_read_at');
    expect(values).toEqual(['user-1', 'user-1', ['ch-1']]);
  });

  it('selects `secure` for the visibility filter (it fails open without it) and asks only text channels of THIS space', async () => {
    await get();

    const arg = prismaMock.channel.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ serverId: 'srv-1', type: 'text' });
    expect(arg.select.secure).toBe(true);
    expect(filterVisibleChannels).toHaveBeenCalledWith('user-1', 'srv-1', expect.any(Array));
  });

  it('a space where nothing is visible answers an empty list and runs no count', async () => {
    vi.mocked(filterVisibleChannels).mockResolvedValue([] as never);

    const res = await get();

    expect(res.body).toEqual({ success: true, data: [] });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('a space without a text channel answers an empty list and filters nothing', async () => {
    prismaMock.channel.findMany.mockResolvedValue([]);

    const res = await get();

    expect(res.body).toEqual({ success: true, data: [] });
    expect(filterVisibleChannels).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('a caller who is not a member is refused (403), before any channel is read', async () => {
    prismaMock.serverMember.findUnique.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(403);
    expect(prismaMock.channel.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('needs a signed-in caller (401)', async () => {
    h.auth.userId = null;
    expect((await get()).status).toBe(401);
  });

  it('is not shadowed by the /:channelId routes (a GET, so none of them answers it)', async () => {
    const res = await get();
    expect(res.status).toBe(200);
  });
});
