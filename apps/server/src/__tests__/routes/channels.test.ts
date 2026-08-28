import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Permissions, permissionsToString, DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS } from '@voxium/shared';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'user-1', username: 'testuser', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Permission calculator — mock before any route imports
const mockHasServerPermission = vi.fn().mockResolvedValue(true);
const mockHasChannelPermission = vi.fn().mockResolvedValue(true);
const mockGetHighestRolePosition = vi.fn().mockResolvedValue(Infinity);
const mockGetEffectivePermissions = vi.fn().mockResolvedValue({ permissions: '1048575', source: 'owner' });
const mockFilterVisibleChannels = vi.fn().mockImplementation((_uid: unknown, _sid: unknown, channels: unknown[]) => Promise.resolve(channels));

const mockComputeServerPermissions = vi.fn().mockResolvedValue(0n);
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
  hasChannelPermission: (...args: unknown[]) => mockHasChannelPermission(...args),
  getHighestRolePosition: (...args: unknown[]) => mockGetHighestRolePosition(...args),
  getEffectivePermissions: (...args: unknown[]) => mockGetEffectivePermissions(...args),
  filterVisibleChannels: (...args: unknown[]) => mockFilterVisibleChannels(...args),
  computeServerPermissions: (...args: unknown[]) => mockComputeServerPermissions(...args),
  Permissions: {
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_SERVER: 1n << 5n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
  },
  hasPermission: vi.fn().mockReturnValue(true),
}));

// Secure-channel lifecycle (the DELETE route hands secure channels to it)
const mockDeleteSecureChannel = vi.fn().mockResolvedValue(true);
vi.mock('../../utils/secureChannelLifecycle', () => ({
  deleteSecureChannel: (...args: unknown[]) => mockDeleteSecureChannel(...args),
}));

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
  },
  serverMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  category: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  channelRead: {
    upsert: vi.fn(),
    createMany: vi.fn(),
  },
  globalConfig: {
    findUnique: vi.fn(),
  },
  serverLimits: {
    findUnique: vi.fn(),
  },
  // Used by visibilityRoomsForNewChannel (F5): who can VIEW a brand-new
  // channel, decided from BASE permissions (@everyone + roles).
  role: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  memberRole: {
    findMany: vi.fn(),
  },
  server: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

// Socket.IO
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockSocketsJoin = vi.fn();
const mockIn = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]), socketsJoin: mockSocketsJoin, socketsLeave: vi.fn() }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitCategoryManage: passthrough,
    rateLimitMarkRead: passthrough,
  };
});

// Server limits
vi.mock('../../utils/serverLimits', () => ({
  getEffectiveLimits: vi.fn().mockResolvedValue({
    maxChannelsPerServer: 20,
    maxVoiceUsersPerChannel: 12,
    maxCategoriesPerServer: 12,
    maxMembersPerServer: 0,
  }),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { channelRouter } from '../../routes/channels';
import { errorHandler } from '../../middleware/errorHandler';
import { getEffectiveLimits } from '../../utils/serverLimits';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers/:serverId/channels', channelRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockAuthUser(overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: 'user-1',
    bannedAt: null,
    tokenVersion: 0,
    role: 'user',
    emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  };
  prismaMock.user.findUnique.mockResolvedValue({ ...defaults, ...overrides });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Channel Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAuthUser();
    // Default: permission checks pass
    mockHasServerPermission.mockResolvedValue(true);
    mockHasChannelPermission.mockResolvedValue(true);
    mockGetHighestRolePosition.mockResolvedValue(Infinity);
    // VIEW_CHANNEL is a prerequisite for every channel-management op, so the
    // default caller has to carry it in their base permissions.
    mockComputeServerPermissions.mockResolvedValue(
      Permissions.VIEW_CHANNEL | Permissions.MANAGE_CHANNELS,
    );
    // Default server shape: @everyone carries VIEW_CHANNEL, the ordinary case
    prismaMock.role.findFirst.mockResolvedValue({
      id: 'everyone',
      permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    });
    prismaMock.role.findMany.mockResolvedValue([]);
    prismaMock.memberRole.findMany.mockResolvedValue([]);
    prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
  });

  // ── GET /api/v1/servers/:serverId/channels ──────────────────────────────

  describe('GET /api/v1/servers/:serverId/channels', () => {
    it('returns channels for a server member', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.channel.findMany.mockResolvedValue([
        { id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-1', position: 0, categoryId: null },
        { id: 'ch-2', name: 'voice', type: 'voice', serverId: 'srv-1', position: 1, categoryId: null },
      ]);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 403 for non-member', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Not a member');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/servers/srv-1/channels');
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/servers/:serverId/channels ─────────────────────────────

  describe('POST /api/v1/servers/:serverId/channels', () => {
    it('creates a text channel as admin', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.count.mockResolvedValue(2);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new',
        name: 'new-channel',
        type: 'text',
        serverId: 'srv-1',
        position: 2,
        categoryId: null,
      });
      prismaMock.serverMember.findMany.mockResolvedValue([{ userId: 'user-1' }]);
      prismaMock.channelRead.createMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('new-channel');
      expect(res.body.data.type).toBe('text');
    });

    it('creates a voice channel as owner', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'owner',
      });
      prismaMock.channel.count.mockResolvedValue(1);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-v',
        name: 'voice-room',
        type: 'voice',
        serverId: 'srv-1',
        position: 1,
        categoryId: null,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'voice-room', type: 'voice' });

      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe('voice');
    });

    it('returns 403 for regular member', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 403 for non-member', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(403);
    });

    it('returns 400 with empty channel name', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '', type: 'text' });

      expect(res.status).toBe(400);
    });

    it('returns 400 with invalid channel type', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test-channel', type: 'video' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });

    it('returns 400 with invalid channel name characters', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'ch@nnel!', type: 'text' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('invalid characters');
    });

    it('respects maxChannelsPerServer limit', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.count.mockResolvedValue(20);
      // Default limit is 20

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'overflow', type: 'text' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('respects custom lower channel limit', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.count.mockResolvedValue(5);
      (getEffectiveLimits as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        maxChannelsPerServer: 5,
        maxVoiceUsersPerChannel: 12,
        maxCategoriesPerServer: 12,
        maxMembersPerServer: 0,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'overflow', type: 'text' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most 5');
    });

    it('validates categoryId belongs to server', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.category.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'valid-name', type: 'text', categoryId: 'cat-nonexistent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Category not found');
    });

    it('does NOT seed ChannelRead rows and auto-joins server sockets to the new channel room (MED-15)', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.count.mockResolvedValue(2);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new',
        name: 'new-channel',
        type: 'text',
        serverId: 'srv-1',
        position: 2,
        categoryId: null,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(201);
      // A brand-new channel has zero messages — unread computation yields 0
      // without rows, so per-member seeding (multi-second on big servers) is gone
      expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
      // One adapter-wide op subscribes every connected member to the new room
      expect(mockIn).toHaveBeenCalledWith('server:srv-1');
      expect(mockSocketsJoin).toHaveBeenCalledWith('channel:ch-new');
    });

    // ── F5: channel:{id} IS the VIEW_CHANNEL boundary ──────────────────────

    it('does not refuse a create just because the creator lacks VIEW_CHANNEL', async () => {
      // Creation confers no special status: a new channel has no overrides, so
      // who sees it is decided by base permissions, and a MANAGE_CHANNELS
      // holder carries VIEW in any sane role setup. Refusing here would block
      // work Discord allows, to guard against a role nobody builds.
      const token = makeToken();
      mockComputeServerPermissions.mockResolvedValue(Permissions.MANAGE_CHANNELS); // no VIEW
      prismaMock.channel.count.mockResolvedValue(0);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new', name: 'general', type: 'text', serverId: 'srv-1', position: 0, categoryId: null,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'general', type: 'text' });

      expect(res.status).toBe(201);
    });

    it('does NOT join or announce to members without VIEW_CHANNEL when @everyone lacks it', async () => {
      // The standard staff-only setup. The old code joined EVERY connected
      // member on the premise that a new channel has no overrides — but
      // visibility comes from base permissions, before overrides matter, so
      // non-privileged members received message:new, typing, reactions and
      // voice presence for a channel they cannot see, until they reconnected.
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.count.mockResolvedValue(0);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-staff', name: 'staff', type: 'text', serverId: 'srv-1', position: 0, categoryId: null,
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'everyone', permissions: permissionsToString(Permissions.SEND_MESSAGES), // no VIEW
      });
      prismaMock.role.findMany.mockResolvedValue([
        { id: 'everyone', permissions: permissionsToString(Permissions.SEND_MESSAGES) },
        { id: 'staff', permissions: permissionsToString(Permissions.VIEW_CHANNEL) },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([{ userId: 'mod-7' }]);
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner-1' });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'staff', type: 'text' });

      expect(res.status).toBe(201);
      expect(mockIn).not.toHaveBeenCalledWith('server:srv-1');
      expect(mockTo).not.toHaveBeenCalledWith('server:srv-1');
      // Exactly the VIEW-granting role's holders plus the owner (who may hold
      // no MemberRole rows at all). The CREATOR is not added on top:
      // MANAGE_CHANNELS and VIEW_CHANNEL are independent bits, so a channel
      // manager without a VIEW-granting role would otherwise be joined to the
      // room of a channel GET /channels filters out for them — the same leak,
      // narrowed to one person.
      const rooms = mockIn.mock.calls[0][0] as string[];
      expect(rooms).toEqual(expect.arrayContaining(['user:mod-7', 'user:owner-1']));
      expect(rooms).not.toContain('user:user-1');
      expect(rooms).toHaveLength(2);
      expect(mockSocketsJoin).toHaveBeenCalledWith('channel:ch-staff');
    });

    it('keeps the emit and the join on the SAME audience', async () => {
      // Narrowing one alone leaves clients showing a channel that produces no
      // events, or receiving events for a channel they never learned about.
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.count.mockResolvedValue(0);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-staff', name: 'staff', type: 'text', serverId: 'srv-1', position: 0, categoryId: null,
      });
      prismaMock.role.findFirst.mockResolvedValue({ id: 'everyone', permissions: permissionsToString(0n) });
      prismaMock.role.findMany.mockResolvedValue([
        { id: 'staff', permissions: permissionsToString(Permissions.VIEW_CHANNEL) },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([{ userId: 'mod-7' }]);

      await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'staff', type: 'text' });

      expect(mockTo.mock.calls.map((c) => c[0])).toEqual(mockIn.mock.calls.map((c) => c[0]));
    });

    it('treats ADMINISTRATOR as VIEW so admins are never locked out of the room', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.count.mockResolvedValue(0);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-staff', name: 'staff', type: 'text', serverId: 'srv-1', position: 0, categoryId: null,
      });
      prismaMock.role.findFirst.mockResolvedValue({ id: 'everyone', permissions: permissionsToString(0n) });
      prismaMock.role.findMany.mockResolvedValue([
        { id: 'admins', permissions: permissionsToString(Permissions.ADMINISTRATOR) },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([{ userId: 'admin-3' }]);

      await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'staff', type: 'text' });

      expect(prismaMock.memberRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { serverId: 'srv-1', roleId: { in: ['admins'] } } }),
      );
      expect(mockIn.mock.calls[0][0]).toContain('user:admin-3');
    });

    it('keeps the O(1) server-wide fast path when @everyone CAN view', async () => {
      // MED-15's cheap path must survive for the default configuration
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.count.mockResolvedValue(0);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-open', name: 'general', type: 'text', serverId: 'srv-1', position: 0, categoryId: null,
      });

      await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'general', type: 'text' });

      expect(mockIn).toHaveBeenCalledWith('server:srv-1');
      expect(prismaMock.memberRole.findMany).not.toHaveBeenCalled();
    });

    it('emits channel:created socket event', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.count.mockResolvedValue(0);
      const createdChannel = {
        id: 'ch-new',
        name: 'new-channel',
        type: 'text',
        serverId: 'srv-1',
        position: 0,
        categoryId: null,
      };
      prismaMock.channel.create.mockResolvedValue(createdChannel);
      prismaMock.serverMember.findMany.mockResolvedValue([]);
      prismaMock.channelRead.createMany.mockResolvedValue({ count: 0 });

      await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('channel:created', createdChannel);
    });
  });

  // ── PATCH /api/v1/servers/:serverId/channels/:channelId ────────────────

  describe('PATCH /api/v1/servers/:serverId/channels/:channelId', () => {
    it('allows admin to update channel category', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'text',
        serverId: 'srv-1',
        categoryId: null,
      });
      prismaMock.category.findFirst.mockResolvedValue({
        id: 'cat-1',
        name: 'Text Channels',
        serverId: 'srv-1',
      });
      prismaMock.channel.update.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'text',
        serverId: 'srv-1',
        categoryId: 'cat-1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryId: 'cat-1' });

      expect(res.status).toBe(200);
      expect(res.body.data.categoryId).toBe('cat-1');
    });

    it('returns 403 for regular member', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryId: 'cat-1' });

      expect(res.status).toBe(403);
    });

    it('returns 404 when channel does not exist', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/channels/ch-nonexistent')
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryId: null });

      expect(res.status).toBe(404);
    });

    it('returns 400 when categoryId is missing', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        serverId: 'srv-1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('categoryId is required');
    });
  });

  // ── DELETE /api/v1/servers/:serverId/channels/:channelId ───────────────

  describe('DELETE /api/v1/servers/:serverId/channels/:channelId', () => {
    it('allows admin to delete channel', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'text',
        serverId: 'srv-1',
      });
      prismaMock.channel.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Channel deleted');
    });

    it('returns 403 for regular member', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns 404 when channel does not exist in server', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('emits channel:deleted socket event', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'owner',
      });
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'text',
        serverId: 'srv-1',
      });
      prismaMock.channel.delete.mockResolvedValue({});

      await request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${token}`);

      // The channel's own room, not the server's — that room IS the
      // VIEW_CHANNEL audience, and nobody outside it has the channel in a
      // sidebar to remove.
      expect(mockTo).toHaveBeenCalledWith('channel:ch-1');
      expect(mockTo).not.toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('channel:deleted', { channelId: 'ch-1', serverId: 'srv-1' });
    });
  });

  // ── POST /api/v1/servers/:serverId/channels/:channelId/read ─────────────

  describe('POST /api/v1/servers/:serverId/channels/:channelId/read', () => {
    it('marks a channel as read', async () => {
      const token = makeToken();
      prismaMock.channel.findFirst.mockResolvedValue({ id: 'ch-1' });
      prismaMock.channelRead.upsert.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels/ch-1/read')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 for unauthorized user', async () => {
      const token = makeToken();
      prismaMock.channel.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels/ch-1/read')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns 403 without VIEW_CHANNEL — mark-read must not be a channel oracle', async () => {
      const token = makeToken();
      prismaMock.channel.findFirst.mockResolvedValue({ id: 'ch-1' });
      mockHasChannelPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels/ch-1/read')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(prismaMock.channelRead.upsert).not.toHaveBeenCalled();
    });
  });

  // ── SECURE channels — hardening of the plaintext-channel routes ────────

  describe('secure channels — hardening', () => {
    const secureCh = {
      id: 'sec-1',
      name: 'covert',
      type: 'text',
      serverId: 'srv-1',
      secure: true,
      createdById: 'creator-9',
      server: { ownerId: 'owner-7' },
    };

    it('DELETE: the creator can delete their secure channel (via the lifecycle helper)', async () => {
      const token = makeToken({ userId: 'creator-9' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'creator-9', bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      });
      prismaMock.channel.findFirst.mockResolvedValue(secureCh);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockDeleteSecureChannel).toHaveBeenCalledWith('sec-1');
      // The plaintext delete path (raw prisma delete + server-room event) must not run
      expect(prismaMock.channel.delete).not.toHaveBeenCalled();
    });

    it('DELETE: the server owner can delete-by-id (opaque moderation lever)', async () => {
      const token = makeToken({ userId: 'owner-7' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'owner-7', bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      });
      prismaMock.channel.findFirst.mockResolvedValue(secureCh);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockDeleteSecureChannel).toHaveBeenCalledWith('sec-1');
    });

    it('DELETE: an ADMINISTRATOR can delete-by-id; a mere MANAGE_CHANNELS holder gets 404', async () => {
      const token = makeToken(); // user-1: neither creator nor owner
      prismaMock.channel.findFirst.mockResolvedValue(secureCh);

      // ADMINISTRATOR → allowed
      mockComputeServerPermissions.mockResolvedValue(Permissions.ADMINISTRATOR);
      let res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(mockDeleteSecureChannel).toHaveBeenCalledWith('sec-1');

      // MANAGE_CHANNELS alone → indistinguishable from nonexistent
      mockDeleteSecureChannel.mockClear();
      mockComputeServerPermissions.mockResolvedValue(Permissions.MANAGE_CHANNELS);
      res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(mockDeleteSecureChannel).not.toHaveBeenCalled();
    });

    it('PUT /reorder: a secure channel id fails like a foreign id', async () => {
      const token = makeToken();
      // The validation query excludes secure rows, so only 1 of 2 ids comes back
      prismaMock.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);

      const res = await request(app)
        .put('/api/v1/servers/srv-1/channels/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({ order: [{ id: 'ch-1', position: 0 }, { id: 'sec-1', position: 1 }] });

      expect(res.status).toBe(400);
      expect(prismaMock.channel.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['ch-1', 'sec-1'] }, serverId: 'srv-1', secure: false },
        select: { id: true, secure: true },
      });
    });

    it('a channel you cannot VIEW cannot be edited, deleted or reordered', async () => {
      // Discord's rule: a channel you cannot see is inert for you. 404 rather
      // than 403 so the check answers exactly like a nonexistent id does for
      // this same caller, adding no existence oracle of its own.
      const token = makeToken();
      mockHasChannelPermission.mockResolvedValue(false); // no VIEW on the target
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch-hidden', serverId: 'srv-1', secure: false, createdById: 'someone', server: { ownerId: 'owner-1' },
      });

      const patched = await request(app)
        .patch('/api/v1/servers/srv-1/channels/ch-hidden')
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryId: null });
      expect(patched.status).toBe(404);

      const deleted = await request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-hidden')
        .set('Authorization', `Bearer ${token}`);
      expect(deleted.status).toBe(404);
      expect(prismaMock.channel.delete).not.toHaveBeenCalled();

      // Reorder: an invisible id fails exactly like a foreign one
      prismaMock.channel.findMany.mockResolvedValueOnce([{ id: 'ch-hidden', secure: false }]);
      mockFilterVisibleChannels.mockResolvedValueOnce([]); // nothing visible
      const reordered = await request(app)
        .put('/api/v1/servers/srv-1/channels/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({ order: [{ id: 'ch-hidden', position: 0 }] });
      expect(reordered.status).toBe(400);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('PUT /reorder: CHANNEL_UPDATED goes to the per-channel room, not the server', async () => {
      // Reordering a sidebar submits the whole order, which for an admin
      // includes channels other members cannot view. Broadcasting the updated
      // rows to server:{id} put those channels' NAMES on the wire for everyone
      // — the stock client drops them, which is not the same as not sending.
      const token = makeToken();
      prismaMock.channel.findMany
        .mockResolvedValueOnce([{ id: 'ch-open' }, { id: 'ch-hr' }])   // validation
        .mockResolvedValueOnce([                                        // re-read for the emit
          { id: 'ch-open', name: 'general', serverId: 'srv-1', position: 0, categoryId: null },
          { id: 'ch-hr', name: 'hr-terminations', serverId: 'srv-1', position: 1, categoryId: null },
        ]);
      prismaMock.$transaction.mockResolvedValue([]);

      const res = await request(app)
        .put('/api/v1/servers/srv-1/channels/reorder')
        .set('Authorization', `Bearer ${token}`)
        .send({ order: [{ id: 'ch-open', position: 0 }, { id: 'ch-hr', position: 1 }] });

      expect(res.status).toBe(200);
      expect(mockTo).toHaveBeenCalledWith('channel:ch-open');
      expect(mockTo).toHaveBeenCalledWith('channel:ch-hr');
      expect(mockTo).not.toHaveBeenCalledWith('server:srv-1');
    });

    it('PATCH (category move): a secure channel reads as not-found', async () => {
      const token = makeToken();
      prismaMock.channel.findFirst.mockResolvedValue(null); // secure:false filter excludes it

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryId: null });

      expect(res.status).toBe(404);
      expect(prismaMock.channel.findFirst).toHaveBeenCalledWith({
        where: { id: 'sec-1', serverId: 'srv-1', secure: false },
      });
    });

    it('POST (create): a smuggled `secure: true` body field is ignored', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue(null);
      prismaMock.channel.count.mockResolvedValue(1);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new', name: 'general2', type: 'text', serverId: 'srv-1',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'general2', type: 'text', secure: true });

      expect(res.status).toBe(201);
      const createArg = prismaMock.channel.create.mock.calls[0][0];
      expect(createArg.data.secure).toBeUndefined();
      expect(createArg.data.createdById).toBeUndefined();
    });
  });
});
