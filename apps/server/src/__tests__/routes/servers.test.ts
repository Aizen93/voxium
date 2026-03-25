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
    KICK_MEMBERS: 1n << 1n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
    CREATE_INVITES: 1n << 0n,
  },
  hasPermission: vi.fn().mockReturnValue(true),
}));

// Prisma
const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
  },
  server: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  serverMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
    createMany: vi.fn(),
  },
  category: {
    create: vi.fn(),
  },
  channelRead: {
    create: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  role: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  memberRole: {
    findMany: vi.fn(),
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
const mockFetchSockets = vi.fn().mockResolvedValue([]);
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
    fetchSockets: mockFetchSockets,
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitMemberManage: passthrough,
    rateLimitSearch: passthrough,
    rateLimitCategoryManage: passthrough,
    rateLimitMessageSend: passthrough,
    rateLimitMarkRead: passthrough,
  };
});

// Member broadcast
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: vi.fn().mockResolvedValue(undefined),
  joinServerRoom: vi.fn().mockResolvedValue(undefined),
}));

// S3
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Voice handler
vi.mock('../../websocket/voiceHandler', () => ({
  leaveCurrentVoiceChannel: vi.fn(),
  cleanupServerVoice: vi.fn(),
}));

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

import { serverRouter } from '../../routes/servers';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers', serverRouter);
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

describe('Server Routes', () => {
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

  // ── Authentication ──────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('returns 401 when no authorization header is provided', async () => {
      const res = await request(app).get('/api/v1/servers');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 with invalid token', async () => {
      const res = await request(app)
        .get('/api/v1/servers')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when email is not verified', async () => {
      mockAuthUser({ emailVerified: false });
      const token = makeToken();
      const res = await request(app)
        .get('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Email not verified');
    });
  });

  // ── GET /api/v1/servers ─────────────────────────────────────────────────

  describe('GET /api/v1/servers', () => {
    it('returns a list of servers the user is a member of', async () => {
      const token = makeToken();
      const mockServers = [
        {
          server: {
            id: 'srv-1',
            name: 'Test Server',
            iconUrl: null,
            invitesLocked: false,
            ownerId: 'user-1',
            createdAt: new Date(),
          },
        },
      ];
      prismaMock.serverMember.findMany.mockResolvedValue(mockServers);

      const res = await request(app)
        .get('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('srv-1');
      expect(res.body.data[0].name).toBe('Test Server');
    });

    it('returns empty array when user has no servers', async () => {
      const token = makeToken();
      prismaMock.serverMember.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── POST /api/v1/servers ────────────────────────────────────────────────

  describe('POST /api/v1/servers', () => {
    it('creates a new server', async () => {
      const token = makeToken();
      prismaMock.server.count.mockResolvedValue(0);
      const mockCreatedServer = {
        id: 'srv-new',
        name: 'My Server',
        iconUrl: null,
        ownerId: 'user-1',
        invitesLocked: false,
        createdAt: new Date(),
        channels: [
          { id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-new', categoryId: 'cat-1', position: 0 },
          { id: 'ch-2', name: 'General', type: 'voice', serverId: 'srv-new', categoryId: 'cat-2', position: 1 },
        ],
        categories: [
          { id: 'cat-1', name: 'Text Channels', serverId: 'srv-new', position: 0 },
          { id: 'cat-2', name: 'Voice Channels', serverId: 'srv-new', position: 1 },
        ],
        _count: { members: 1 },
      };
      prismaMock.$transaction.mockImplementation(async (cb: Function) => {
        return cb({
          server: {
            create: vi.fn().mockResolvedValue({ id: 'srv-new', name: 'My Server', ownerId: 'user-1' }),
            findUniqueOrThrow: vi.fn().mockResolvedValue(mockCreatedServer),
          },
          category: {
            create: vi.fn()
              .mockResolvedValueOnce({ id: 'cat-1', name: 'Text Channels', serverId: 'srv-new', position: 0 })
              .mockResolvedValueOnce({ id: 'cat-2', name: 'Voice Channels', serverId: 'srv-new', position: 1 }),
          },
          channel: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
          role: { create: vi.fn().mockResolvedValue({ id: 'role-everyone', name: 'everyone', serverId: 'srv-new', position: 0, isDefault: true }) },
        });
      });
      prismaMock.channelRead.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Server' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('My Server');
      expect(res.body.data.memberCount).toBe(1);
    });

    it('returns 400 with empty server name', async () => {
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 with too short server name', async () => {
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'X' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when max owned servers reached', async () => {
      const token = makeToken();
      prismaMock.server.count.mockResolvedValue(5); // MAX_SERVERS_PER_USER = 5

      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Another Server' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('only create up to');
    });

    it('returns 403 when server creation is disabled', async () => {
      const { isFeatureEnabled } = await import('../../utils/featureFlags');
      (isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const token = makeToken();
      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Server' });

      expect(res.status).toBe(403);
      (isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it('sanitizes HTML from server name', async () => {
      const token = makeToken();
      prismaMock.server.count.mockResolvedValue(0);
      const mockCreatedServer = {
        id: 'srv-new',
        name: 'My Server',
        iconUrl: null,
        ownerId: 'user-1',
        invitesLocked: false,
        createdAt: new Date(),
        channels: [
          { id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-new', categoryId: 'cat-1', position: 0 },
        ],
        categories: [],
        _count: { members: 1 },
      };
      prismaMock.$transaction.mockImplementation(async (cb: Function) => {
        return cb({
          server: {
            create: vi.fn().mockResolvedValue({ id: 'srv-new', name: 'My Server', ownerId: 'user-1' }),
            findUniqueOrThrow: vi.fn().mockResolvedValue(mockCreatedServer),
          },
          category: {
            create: vi.fn().mockResolvedValue({ id: 'cat-1', name: 'Text Channels', serverId: 'srv-new', position: 0 }),
          },
          channel: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          role: { create: vi.fn().mockResolvedValue({ id: 'role-everyone', name: 'everyone', serverId: 'srv-new', position: 0, isDefault: true }) },
        });
      });
      prismaMock.channelRead.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '<script>alert("xss")</script>My Server' });

      // HTML tags should be stripped by sanitizeText, resulting in 'alert("xss")My Server'
      // This will still pass validation since it's >= 2 chars
      expect(res.status).toBe(201);
    });
  });

  // ── GET /api/v1/servers/:serverId ───────────────────────────────────────

  describe('GET /api/v1/servers/:serverId', () => {
    it('returns server details for a member', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Test Server',
        iconUrl: null,
        ownerId: 'user-1',
        invitesLocked: false,
        createdAt: new Date(),
        channels: [],
        categories: [],
        roles: [],
        _count: { members: 3 },
      });

      const res = await request(app)
        .get('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('srv-1');
      expect(res.body.data.memberCount).toBe(3);
    });

    it('returns 404 for non-member', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /api/v1/servers/:serverId ─────────────────────────────────────

  describe('PATCH /api/v1/servers/:serverId', () => {
    it('allows owner to update server name', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Old Name',
        iconUrl: null,
        ownerId: 'user-1',
      });
      prismaMock.server.update.mockResolvedValue({
        id: 'srv-1',
        name: 'New Name',
        iconUrl: null,
        invitesLocked: false,
        ownerId: 'user-1',
        createdAt: new Date(),
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('New Name');
      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
    });

    it('returns 403 for non-owner', async () => {
      const token = makeToken({ userId: 'user-2' });
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Old Name',
        iconUrl: null,
        ownerId: 'user-1',
      });
      // No MANAGE_SERVER permission
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .patch('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 400 when no update fields provided', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Old Name',
        iconUrl: null,
        ownerId: 'user-1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No fields to update');
    });

    it('returns 404 when server does not exist', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/servers/nonexistent')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
    });

    it('returns 400 with invalid icon key', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Old Name',
        iconUrl: null,
        ownerId: 'user-1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ iconUrl: '../../../etc/passwd' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid icon key');
    });
  });

  // ── DELETE /api/v1/servers/:serverId ────────────────────────────────────

  describe('DELETE /api/v1/servers/:serverId', () => {
    it('allows owner to delete server', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Test Server',
        iconUrl: null,
        ownerId: 'user-1',
      });
      prismaMock.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
      prismaMock.server.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Server deleted');
    });

    it('returns 403 for non-owner', async () => {
      const token = makeToken({ userId: 'user-2' });
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Test Server',
        iconUrl: null,
        ownerId: 'user-1',
      });

      const res = await request(app)
        .delete('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns 404 when server does not exist', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/servers/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('emits server:deleted event to server room', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue({
        id: 'srv-1',
        name: 'Test Server',
        iconUrl: null,
        ownerId: 'user-1',
      });
      prismaMock.channel.findMany.mockResolvedValue([]);
      prismaMock.server.delete.mockResolvedValue({});

      await request(app)
        .delete('/api/v1/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('server:deleted', { serverId: 'srv-1' });
    });
  });

  // ── POST /api/v1/servers/:serverId/leave ────────────────────────────────

  describe('POST /api/v1/servers/:serverId/leave', () => {
    it('allows member to leave server', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.channel.findMany.mockResolvedValue([]);
      prismaMock.serverMember.delete.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/servers/srv-1/leave')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Left server');
    });

    it('returns 403 when owner tries to leave', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'owner',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/leave')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('owner cannot leave');
    });
  });

  // ── GET /api/v1/servers/:serverId/members ───────────────────────────────

  describe('GET /api/v1/servers/:serverId/members', () => {
    it('returns paginated members', async () => {
      const token = makeToken();
      // First call = membership check, second call = member list
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.serverMember.findMany.mockResolvedValue([
        {
          userId: 'user-1',
          serverId: 'srv-1',
          role: 'owner',
          joinedAt: new Date(),
          user: {
            id: 'user-1',
            username: 'testuser',
            displayName: 'Test User',
            avatarUrl: null,
            bio: null,
            status: 'online',
            isSupporter: false,
            supporterTier: null,
            createdAt: new Date(),
          },
          memberRoles: [],
        },
      ]);
      prismaMock.serverMember.count.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/members')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.hasMore).toBe(false);
    });
  });

  // ── PATCH /api/v1/servers/:serverId/members/:memberId/role ──────────────

  describe('PATCH /api/v1/servers/:serverId/members/:memberId/role', () => {
    it('allows owner to change member role', async () => {
      const token = makeToken();
      // Actor membership check
      prismaMock.serverMember.findUnique
        .mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv-1', role: 'owner' })
        // Target membership check
        .mockResolvedValueOnce({ userId: 'user-2', serverId: 'srv-1', role: 'member' });
      prismaMock.serverMember.update.mockResolvedValue({});

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/members/user-2/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('admin');
    });

    it('returns 403 for non-owner', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/members/user-2/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
    });

    it('returns 400 with invalid role value', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'owner',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/members/user-2/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'superadmin' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when trying to change own role', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'owner',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/members/user-1/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('own role');
    });
  });

  describe('POST /api/v1/servers/:serverId/transfer-ownership', () => {
    it('returns 400 when targetUserId is missing', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/api/v1/servers/srv-1/transfer-ownership')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/targetUserId/i);
    });

    it('returns 400 when targetUserId is not a string', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/api/v1/servers/srv-1/transfer-ownership')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/targetUserId/i);
    });
  });
});
