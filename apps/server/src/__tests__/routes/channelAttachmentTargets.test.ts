import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  Permissions,
  permissionsToString,
} from '@voxium/shared';

// GET /servers/:serverId/channels/attachment-targets: where the caller can
// post a message WITH an attachment (VIEW_CHANNEL, SEND_MESSAGES and
// ATTACH_FILES, non-secure text channels). Runs the REAL permission
// calculator over a prisma mock, so the bits, the channel overrides and the
// number of queries of the batched pass are the production ones.

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
  channel: { findMany: vi.fn(), findUnique: vi.fn() },
  server: { findUnique: vi.fn() },
  role: { findFirst: vi.fn() },
  memberRole: { findMany: vi.fn() },
  channelPermissionOverride: { findMany: vi.fn() },
  channelMember: { findMany: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }),
}));

// The rest of the channel router's imports reach for sockets, storage and Redis
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

const app = express();
app.use(express.json());
app.use('/api/v1/servers/:serverId/channels', channelRouter);
app.use(errorHandler);

const get = (serverId = 'srv-1') => request(app).get(`/api/v1/servers/${serverId}/channels/attachment-targets`);

const VIEW = Permissions.VIEW_CHANNEL;
const SEND = Permissions.SEND_MESSAGES;
const ATTACH = Permissions.ATTACH_FILES;

function channelRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, categoryId: null, position: 0, type: 'text', secure: false, ...extra };
}

/** The caller's base permissions come from @everyone plus one role of theirs. */
function givenBase(everyone: bigint, role: bigint | null = null) {
  prismaMock.role.findFirst.mockResolvedValue({ id: 'role-everyone', permissions: permissionsToString(everyone) });
  prismaMock.memberRole.findMany.mockResolvedValue(
    role === null ? [] : [{ roleId: 'role-mod', role: { id: 'role-mod', permissions: permissionsToString(role) } }],
  );
}

function queriesMade(): number {
  return Object.values(prismaMock).reduce(
    (n, model) => n + Object.values(model as Record<string, ReturnType<typeof vi.fn>>).reduce((m, fn) => m + fn.mock.calls.length, 0),
    0,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.userId = 'user-1';
  h.limiterCalls.length = 0;
  prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'member' });
  prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
  prismaMock.channel.findMany.mockResolvedValue([channelRow('general')]);
  prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
  prismaMock.channelMember.findMany.mockResolvedValue([]);
  givenBase(DEFAULT_EVERYONE_PERMISSIONS, ATTACH);
});

describe('GET /servers/:serverId/channels/attachment-targets', () => {
  it('lists the channels where the caller holds VIEW_CHANNEL, SEND_MESSAGES and ATTACH_FILES, as { id, name, categoryId, position }', async () => {
    prismaMock.channel.findMany.mockResolvedValue([
      channelRow('general', { categoryId: 'cat-1', position: 0 }),
      channelRow('random', { position: 3 }),
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        { id: 'general', name: 'general', categoryId: 'cat-1', position: 0 },
        { id: 'random', name: 'random', categoryId: null, position: 3 },
      ],
    });
  });

  it.each([
    ['VIEW_CHANNEL', VIEW],
    ['SEND_MESSAGES', SEND],
    ['ATTACH_FILES', ATTACH],
  ])('a member missing %s gets no channel', async (_name, missing) => {
    givenBase((VIEW | SEND | ATTACH) & ~missing);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });

  it('the default @everyone role has no ATTACH_FILES: an ordinary member gets an empty list, a role granting it gets the channel', async () => {
    givenBase(DEFAULT_EVERYONE_PERMISSIONS, null);
    expect((await get()).body.data).toEqual([]);
    givenBase(DEFAULT_EVERYONE_PERMISSIONS, ATTACH);
    expect((await get()).body.data.map((c: { id: string }) => c.id)).toEqual(['general']);
  });

  it('a channel override that denies one bit leaves that channel out only', async () => {
    prismaMock.channel.findMany.mockResolvedValue([channelRow('open'), channelRow('no-files'), channelRow('read-only'), channelRow('hidden')]);
    const deny = (channelId: string, bit: bigint) => ({ channelId, roleId: 'role-everyone', allow: '0', deny: permissionsToString(bit) });
    prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
      deny('no-files', ATTACH), deny('read-only', SEND), deny('hidden', VIEW),
    ]);
    const res = await get();
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(['open']);
  });

  it('a channel override that grants the missing bit adds that channel only', async () => {
    givenBase(DEFAULT_EVERYONE_PERMISSIONS, null);
    prismaMock.channel.findMany.mockResolvedValue([channelRow('plain'), channelRow('uploads')]);
    prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
      { channelId: 'uploads', roleId: 'role-everyone', allow: permissionsToString(ATTACH), deny: '0' },
    ]);
    const res = await get();
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(['uploads']);
  });

  it('the owner and an ADMINISTRATOR holder get every plaintext text channel', async () => {
    prismaMock.channel.findMany.mockResolvedValue([channelRow('a'), channelRow('b')]);
    prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'user-1' });
    expect((await get()).body.data).toHaveLength(2);
    prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
    givenBase(DEFAULT_EVERYONE_PERMISSIONS, Permissions.ADMINISTRATOR);
    expect((await get()).body.data).toHaveLength(2);
    givenBase(DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS);
    expect((await get()).body.data).toHaveLength(2);
  });

  it('asks the database for non-secure TEXT channels only, ordered by position then id, and never answers a voice or a secure one even should it come back', async () => {
    prismaMock.channel.findMany.mockResolvedValue([
      channelRow('voice-1', { type: 'voice' }),
      channelRow('vault', { secure: true }),
      channelRow('general'),
    ]);
    // the caller is a member of the secure channel: still never offered
    prismaMock.channelMember.findMany.mockResolvedValue([{ channelId: 'vault' }]);
    const res = await get();
    expect(prismaMock.channel.findMany).toHaveBeenCalledWith({
      where: { serverId: 'srv-1', type: 'text', secure: false },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, categoryId: true, position: true, type: true, secure: true },
    });
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(['general']);
    expect(res.text).not.toContain('vault');
    expect(res.text).not.toContain('voice-1');
    // the secure partition was never consulted
    expect(prismaMock.channelMember.findMany).not.toHaveBeenCalled();
  });

  it('a non-member gets what GET / answers: 403 Not a member of this server, and no channel is read', async () => {
    prismaMock.serverMember.findUnique.mockResolvedValue(null);
    const res = await get('srv-9');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Not a member of this server' });
    expect(prismaMock.channel.findMany).not.toHaveBeenCalled();
    expect(prismaMock.channelPermissionOverride.findMany).not.toHaveBeenCalled();
  });

  it('is unauthenticated-closed and goes through the per-user read limiter', async () => {
    h.auth.userId = null;
    expect((await get()).status).toBe(401);
    expect(h.limiterCalls).toEqual([]);
    h.auth.userId = 'user-1';
    expect((await get()).status).toBe(200);
    expect(h.limiterCalls).toEqual(['memberRead']);
  });

  it('no text channel: an empty list and no permission pass at all', async () => {
    prismaMock.channel.findMany.mockResolvedValue([]);
    const res = await get();
    expect(res.body).toEqual({ success: true, data: [] });
    expect(prismaMock.role.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.channelPermissionOverride.findMany).not.toHaveBeenCalled();
  });

  it('the batched pass makes the same number of queries for 3 channels as for 300', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => channelRow(`ch-${i}`, { position: i }));
    prismaMock.channel.findMany.mockResolvedValue(many(3));
    await get();
    const small = queriesMade();
    vi.clearAllMocks();
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1' });
    prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
    prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
    givenBase(DEFAULT_EVERYONE_PERMISSIONS, ATTACH);
    prismaMock.channel.findMany.mockResolvedValue(many(300));
    const res = await get();
    expect(res.body.data).toHaveLength(300);
    expect(queriesMade()).toBe(small);
    // membership, channels, server, @everyone, the member's roles, the overrides
    expect(small).toBe(6);
  });

  it('a database failure is a 500, never a partial list', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.channelPermissionOverride.findMany.mockRejectedValue(new Error('db down'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('data');
    spy.mockRestore();
  });
});

describe('the route sits before every /:channelId route', () => {
  it('is not swallowed by a parameter route: no GET /:channelId exists, and the path resolves here', async () => {
    const stack = (channelRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
    const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
    const targetIndex = routes.findIndex((r) => r.path === '/attachment-targets');
    const firstParam = routes.findIndex((r) => r.path.startsWith('/:'));
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeLessThan(firstParam);
    expect(routes.some((r) => r.path.startsWith('/:') && r.methods.includes('get'))).toBe(false);
  });
});
