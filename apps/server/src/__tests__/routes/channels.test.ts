import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

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

vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
  hasChannelPermission: (...args: unknown[]) => mockHasChannelPermission(...args),
  getHighestRolePosition: (...args: unknown[]) => mockGetHighestRolePosition(...args),
  getEffectivePermissions: (...args: unknown[]) => mockGetEffectivePermissions(...args),
  filterVisibleChannels: (...args: unknown[]) => mockFilterVisibleChannels(...args),
  Permissions: {
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_SERVER: 1n << 5n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
  },
  hasPermission: vi.fn().mockReturnValue(true),
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
const mockIn = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
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
    emailVerified: true,
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

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
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
  });
});
