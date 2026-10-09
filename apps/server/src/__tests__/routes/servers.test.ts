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
  serverBan: {
    findMany: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
  },
  serverJoinRequest: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    updateMany: vi.fn(),
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

// Rate limiters (memberManage is observable: every new route must carry one)
const mockRateLimitMemberManage = vi.fn((_req: any, _res: any, next: () => void) => next());
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitMemberManage: (...args: any[]) => mockRateLimitMemberManage(...args),
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

// Visibility-room resync (owner transfer changes VIEW_CHANNEL for two users)
const mockSyncVisibilityRooms = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/channelVisibilityRooms', () => ({
  syncChannelVisibilityRooms: (...args: any[]) => mockSyncVisibilityRooms(...args),
}));

// Secure-channel lifecycle (leave/kick purge their secure state first)
const mockPurgeSecureChannelState = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/secureChannelLifecycle', () => ({
  purgeSecureChannelState: (...args: any[]) => mockPurgeSecureChannelState(...args),
  purgeSecureChannelStateForAccount: vi.fn().mockResolvedValue(undefined),
  deleteSecureChannel: vi.fn().mockResolvedValue(true),
}));

// The removal teardown (voice eviction, secure purge, read markers, the
// ban/membership/count transaction, member:left) has its own unit tests in
// utils/removeMember.test.ts — here the routes are checked for delegating
// with the right arguments.
const mockRemoveMemberFromServer = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/removeMember', () => ({
  removeMemberFromServer: (...args: any[]) => mockRemoveMemberFromServer(...args),
}));

// Directory listing column recompute (invites-lock is one of its inputs)
const mockRecomputeListed = vi.fn().mockResolvedValue(true);
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: (...args: any[]) => mockRecomputeListed(...args),
  recomputeListedForOwner: vi.fn().mockResolvedValue(0),
}));

// The join helper (approval runs it with the request delete as extra write)
const mockJoinServerMember = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/serverJoin', () => ({
  joinServerMember: (...args: any[]) => mockJoinServerMember(...args),
}));

// Moderator audience (join-request events never reach the server room)
const mockEmitToModerators = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/moderatorAudience', () => ({
  emitToModerators: (...args: any[]) => mockEmitToModerators(...args),
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
    emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
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

  const SERVER_SELECT = {
    id: true, name: true, iconUrl: true, invitesLocked: true, ownerId: true, createdAt: true,
    description: true, tags: true, discoverable: true, joinMode: true,
  };

  describe('GET /api/v1/servers', () => {
    it('selects the directory profile with every server (the shared Server type)', async () => {
      const token = makeToken();
      prismaMock.serverMember.findMany.mockResolvedValue([]);

      await request(app).get('/api/v1/servers').set('Authorization', `Bearer ${token}`);

      expect(prismaMock.serverMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
        include: { server: { select: SERVER_SELECT } },
      }));
    });

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

    it('seeds the inline member count with the creator (the one membership that skips joinServerMember)', async () => {
      const token = makeToken();
      prismaMock.server.count.mockResolvedValue(0);
      const txServerCreate = vi.fn().mockResolvedValue({ id: 'srv-new', name: 'My Server', ownerId: 'user-1' });
      prismaMock.$transaction.mockImplementation(async (cb: Function) => cb({
        server: {
          create: txServerCreate,
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: 'srv-new', name: 'My Server', iconUrl: null, ownerId: 'user-1', invitesLocked: false, createdAt: new Date(),
            channels: [], categories: [], _count: { members: 1 },
          }),
        },
        category: { create: vi.fn().mockResolvedValue({ id: 'cat-1' }) },
        channel: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        role: { create: vi.fn().mockResolvedValue({ id: 'role-everyone' }) },
      }));

      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Server' });

      expect(res.status).toBe(201);
      expect(txServerCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ ownerId: 'user-1', memberCount: 1, members: { create: { userId: 'user-1', role: 'owner' } } }),
      });
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
      // server:updated must carry the directory profile too
      expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ select: SERVER_SELECT }));
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

  // ── POST /api/v1/servers/:serverId/join — removed (HIGH-6) ──────────────

  describe('POST /api/v1/servers/:serverId/join (removed route)', () => {
    it('returns 404 — joining MUST go through POST /invites/:code/join', async () => {
      // The direct join-by-id route bypassed invite validity, invitesLocked,
      // and maxMembers. It was removed; only the invite flow may add members.
      const token = makeToken();
      const res = await request(app)
        .post('/api/v1/servers/srv-1/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      // Defense-in-depth: no membership row was created
      expect(prismaMock.serverMember.create).not.toHaveBeenCalled();
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
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });

    it('runs the shared removal WITHOUT a ban, so a voluntary leave keeps the member count right and can return', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'member' });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/leave')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockRemoveMemberFromServer).toHaveBeenCalledTimes(1);
      expect(mockRemoveMemberFromServer).toHaveBeenCalledWith('user-1', 'srv-1');
      // No route-level writes remain: the helper owns the whole teardown
      expect(prismaMock.serverMember.delete).not.toHaveBeenCalled();
      expect(prismaMock.channelRead.deleteMany).not.toHaveBeenCalled();
    });

    it('does not remove anyone who is not a member (404 first)', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/leave')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });
  });

  // ── PATCH /api/v1/servers/:serverId/invites-lock ────────────────────────

  describe('PATCH /api/v1/servers/:serverId/invites-lock', () => {
    it('recomputes the directory listing column AFTER the lock update and emits the full Server', async () => {
      const token = makeToken();
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', ownerId: 'user-1' });
      const order: string[] = [];
      prismaMock.server.update.mockImplementation(async () => {
        order.push('update');
        return { id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: true, ownerId: 'user-1', createdAt: new Date(), description: null, tags: [], discoverable: true, joinMode: 'approval' };
      });
      mockRecomputeListed.mockImplementation(async () => { order.push('recompute'); return false; });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/invites-lock')
        .set('Authorization', `Bearer ${token}`)
        .send({ locked: true });

      expect(res.status).toBe(200);
      expect(prismaMock.server.update).toHaveBeenCalledWith({ where: { id: 'srv-1' }, select: SERVER_SELECT, data: { invitesLocked: true } });
      expect(mockRecomputeListed).toHaveBeenCalledWith('srv-1');
      expect(order).toEqual(['update', 'recompute']);
      expect(mockEmit).toHaveBeenCalledWith('server:updated', expect.objectContaining({ id: 'srv-1', invitesLocked: true, joinMode: 'approval' }));
    });

    it('rejects a non-boolean without touching anything', async () => {
      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/servers/srv-1/invites-lock')
        .set('Authorization', `Bearer ${token}`)
        .send({ locked: 'yes' });

      expect(res.status).toBe(400);
      expect(mockRecomputeListed).not.toHaveBeenCalled();
    });
  });

  // ── POST /api/v1/servers/:serverId/members/:memberId/kick — remove AND ban ─

  describe('POST /api/v1/servers/:serverId/members/:memberId/kick', () => {
    function mockTarget() {
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-2', serverId: 'srv-1', role: 'member' });
      mockGetHighestRolePosition.mockImplementation(async (userId: string) => (userId === 'user-1' ? 10 : 1));
    }

    it('removes the member through the shared helper WITH a ban carrying the actor and the reason, then tells them', async () => {
      const token = makeToken();
      mockTarget();

      const res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: '  <b>spam</b> in every channel ' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockHasServerPermission).toHaveBeenCalledWith('user-1', 'srv-1', expect.anything());
      expect(mockRemoveMemberFromServer).toHaveBeenCalledTimes(1);
      // sanitizeText'd: tags stripped, trimmed
      expect(mockRemoveMemberFromServer).toHaveBeenCalledWith('user-2', 'srv-1', { ban: { by: 'user-1', reason: 'spam in every channel' } });
      // member:kicked goes to the removed user's own room (they are already out of server:{id})
      expect(mockTo).toHaveBeenCalledWith('user:user-2');
      expect(mockEmit).toHaveBeenCalledWith('member:kicked', { serverId: 'srv-1', userId: 'user-2' });
      // No route-level membership writes remain
      expect(prismaMock.serverMember.delete).not.toHaveBeenCalled();
    });

    it('bans with a null reason when the body is empty (the client sends none today) or the reason is blank', async () => {
      const token = makeToken();
      mockTarget();

      let res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(mockRemoveMemberFromServer).toHaveBeenLastCalledWith('user-2', 'srv-1', { ban: { by: 'user-1', reason: null } });

      res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: '   ' });
      expect(res.status).toBe(200);
      expect(mockRemoveMemberFromServer).toHaveBeenLastCalledWith('user-2', 'srv-1', { ban: { by: 'user-1', reason: null } });
    });

    it('rejects a non-string or over-long reason BEFORE any permission work, removing nobody', async () => {
      const token = makeToken();
      mockTarget();

      let res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reason must be a string');

      res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'x'.repeat(301) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most 300');

      expect(mockHasServerPermission).not.toHaveBeenCalled();
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });

    it('returns 400 when kicking yourself', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-1/kick')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });

    it('returns 403 without KICK_MEMBERS', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);
      const res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });

    it('returns 404 when the target is not a member', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });

    it('returns 403 when the actor does not outrank the target', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-2', serverId: 'srv-1', role: 'member' });
      mockGetHighestRolePosition.mockResolvedValue(5); // equal
      const res = await request(app)
        .post('/api/v1/servers/srv-1/members/user-2/kick')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('equal or higher role');
      expect(mockRemoveMemberFromServer).not.toHaveBeenCalled();
    });
  });

  // ── PATCH /api/v1/servers/:serverId/discovery ───────────────────────────

  describe('PATCH /api/v1/servers/:serverId/discovery', () => {
    const UPDATED = { id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: false, ownerId: 'user-1', createdAt: new Date(), description: 'd', tags: ['gaming'], discoverable: true, joinMode: 'open' };
    const patch = (body: unknown) => request(app).patch('/api/v1/servers/srv-1/discovery').set('Authorization', `Bearer ${makeToken()}`).send(body);

    beforeEach(() => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryBlockedAt: null });
      prismaMock.server.update.mockResolvedValue(UPDATED);
    });

    it('404 unknown server, 403 without MANAGE_SERVER, 400 without fields', async () => {
      prismaMock.server.findUnique.mockResolvedValueOnce(null);
      expect((await patch({ discoverable: false })).status).toBe(404);
      mockHasServerPermission.mockResolvedValueOnce(false);
      expect((await patch({ discoverable: false })).status).toBe(403);
      expect((await patch({})).status).toBe(400);
      expect(prismaMock.server.update).not.toHaveBeenCalled();
      expect(mockRecomputeListed).not.toHaveBeenCalled();
    });

    it('validates every field', async () => {
      expect((await patch({ discoverable: 'yes' })).status).toBe(400);
      expect((await patch({ joinMode: 'invite' })).status).toBe(400);
      expect((await patch({ description: 42 })).status).toBe(400);
      expect((await patch({ description: 'x'.repeat(301) })).status).toBe(400);
      expect((await patch({ description: `a${String.fromCharCode(0x200b)}b` })).status).toBe(400);
      expect((await patch({ tags: 'gaming' })).status).toBe(400);
      expect((await patch({ tags: ['nope'] })).status).toBe(400);
      expect((await patch({ tags: ['gaming', 'esports', 'music', 'art', 'community', 'science'] })).status).toBe(400);
      expect(prismaMock.server.update).not.toHaveBeenCalled();
    });

    it('refuses to relist a server an administrator blocked (403), but still allows hiding it', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryBlockedAt: new Date() });
      let res = await patch({ discoverable: true });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('administrator');
      res = await patch({ discoverable: false });
      expect(res.status).toBe(200);
    });

    it('writes the sanitized profile (deduped tags, empty description → null), recomputes AFTER the update, emits server:updated', async () => {
      const order: string[] = [];
      prismaMock.server.update.mockImplementation(async () => { order.push('update'); return UPDATED; });
      mockRecomputeListed.mockImplementation(async () => { order.push('recompute'); return true; });

      const res = await patch({ discoverable: false, joinMode: 'open', description: ' <i>Hi</i> there ', tags: ['music', 'gaming', 'music'] });

      expect(res.status).toBe(200);
      expect(prismaMock.server.update).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        select: SERVER_SELECT,
        data: { discoverable: false, joinMode: 'open', description: 'Hi there', tags: ['music', 'gaming'] },
      });
      expect(order).toEqual(['update', 'recompute']);
      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('server:updated', expect.objectContaining({ id: 'srv-1', joinMode: 'open' }));
      expect(res.body.data.joinMode).toBe('open');

      await patch({ description: '   ' });
      expect(prismaMock.server.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { description: null } }));
      await patch({ description: null });
      expect(prismaMock.server.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { description: null } }));
    });
  });

  // ── Join requests (KICK_MEMBERS) ────────────────────────────────────────

  describe('join requests', () => {
    const REQUEST_ROW = {
      id: 'req-1', serverId: 'srv-1', userId: 'user-2', message: 'hi', status: 'pending', createdAt: new Date('2026-10-09T10:00:00Z'),
      user: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null },
    };
    const SERVER_ROW = { id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: false, ownerId: 'user-1', createdAt: new Date(), description: null, tags: [], discoverable: true, joinMode: 'approval' };

    it('GET lists pending requests oldest first with the user summary, paginated, KICK_MEMBERS only', async () => {
      prismaMock.serverJoinRequest.findMany.mockResolvedValue([REQUEST_ROW]);
      prismaMock.serverJoinRequest.count.mockResolvedValue(1);

      const res = await request(app).get('/api/v1/servers/srv-1/join-requests').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: 'req-1', serverId: 'srv-1', userId: 'user-2', message: 'hi', status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: REQUEST_ROW.user }]);
      expect(prismaMock.serverJoinRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { serverId: 'srv-1', status: 'pending' }, orderBy: { createdAt: 'asc' }, skip: 0, take: 100,
      }));
      expect(mockRateLimitMemberManage).toHaveBeenCalled();

      mockHasServerPermission.mockResolvedValueOnce(false);
      const denied = await request(app).get('/api/v1/servers/srv-1/join-requests').set('Authorization', `Bearer ${makeToken()}`);
      expect(denied.status).toBe(403);
    });

    it('approve: 404 without a PENDING row', async () => {
      prismaMock.serverJoinRequest.findUnique.mockResolvedValueOnce(null);
      let res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/approve').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(404);
      prismaMock.serverJoinRequest.findUnique.mockResolvedValueOnce({ id: 'req-1', status: 'declined' });
      res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/approve').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(404);
      expect(mockJoinServerMember).not.toHaveBeenCalled();
    });

    it('approve: runs the join helper with the row delete as the extra write, then notifies the requester and the moderators', async () => {
      prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'pending' });
      const DELETE = { op: 'request.delete' };
      prismaMock.serverJoinRequest.delete.mockReturnValue(DELETE);
      prismaMock.server.findUnique.mockResolvedValue(SERVER_ROW);

      const res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/approve').set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(mockJoinServerMember).toHaveBeenCalledWith('user-2', 'srv-1', { via: 'approval', extraWrites: [DELETE] });
      // status-scoped: a decline that committed first leaves a row this delete must not find
      expect(prismaMock.serverJoinRequest.delete).toHaveBeenCalledWith({ where: { id: 'req-1', status: 'pending' } });
      expect(mockTo).toHaveBeenCalledWith('user:user-2');
      expect(mockEmit).toHaveBeenCalledWith('server:join_approved', { server: SERVER_ROW });
      expect(mockEmitToModerators).toHaveBeenCalledWith('srv-1', 'server:join_request_resolved', { serverId: 'srv-1', userId: 'user-2', outcome: 'approved' });
    });

    it('approve: a row that vanished mid-flight (P2025) is 404; the helper\'s refusals pass through', async () => {
      prismaMock.serverJoinRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'pending' });
      mockJoinServerMember.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'P2025' }));
      let res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/approve').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Join request not found');
      expect(mockEmitToModerators).not.toHaveBeenCalled();

      const { ForbiddenError } = await import('../../utils/errors');
      mockJoinServerMember.mockRejectedValueOnce(new ForbiddenError('You are banned from this server'));
      res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/approve').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(403);
    });

    it('decline: marks the row with decider and time, tells the requester (with the server name) and the moderators', async () => {
      prismaMock.serverJoinRequest.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.server.findUnique.mockResolvedValue({ name: 'S' });

      const res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/decline').set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(prismaMock.serverJoinRequest.updateMany).toHaveBeenCalledWith({
        where: { serverId: 'srv-1', userId: 'user-2', status: 'pending' },
        data: { status: 'declined', decidedById: 'user-1', decidedAt: expect.any(Date) },
      });
      expect(mockTo).toHaveBeenCalledWith('user:user-2');
      expect(mockEmit).toHaveBeenCalledWith('server:join_declined', { serverId: 'srv-1', serverName: 'S' });
      expect(mockEmitToModerators).toHaveBeenCalledWith('srv-1', 'server:join_request_resolved', { serverId: 'srv-1', userId: 'user-2', outcome: 'declined' });
      expect(mockJoinServerMember).not.toHaveBeenCalled();
    });

    it('decline: 404 without a pending row; 403 without KICK_MEMBERS', async () => {
      prismaMock.serverJoinRequest.updateMany.mockResolvedValue({ count: 0 });
      let res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/decline').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(404);
      expect(mockEmitToModerators).not.toHaveBeenCalled();
      mockHasServerPermission.mockResolvedValueOnce(false);
      res = await request(app).post('/api/v1/servers/srv-1/join-requests/user-2/decline').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/v1/servers/:serverId/bans ──────────────────────────────────

  describe('GET /api/v1/servers/:serverId/bans', () => {
    const banRow = {
      serverId: 'srv-1',
      userId: 'user-2',
      bannedById: 'user-1',
      reason: 'spam',
      createdAt: new Date('2026-10-09T10:00:00Z'),
      user: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null },
      bannedBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
    };

    it('lists bans with the user summary, reason, date and who banned, newest first, paginated', async () => {
      const token = makeToken();
      prismaMock.serverBan.findMany.mockResolvedValue([banRow]);
      prismaMock.serverBan.count.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/bans')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{
        serverId: 'srv-1',
        userId: 'user-2',
        reason: 'spam',
        createdAt: '2026-10-09T10:00:00.000Z',
        user: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null },
        bannedBy: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      }]);
      expect(res.body.total).toBe(1);
      expect(res.body.hasMore).toBe(false);
      // every new REST route carries a limiter from middleware/rateLimiter.ts
      expect(mockRateLimitMemberManage).toHaveBeenCalled();
      expect(prismaMock.serverBan.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { serverId: 'srv-1' },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 100,
      }));
    });

    it('caps the page size at MEMBERS_PER_PAGE and reports hasMore', async () => {
      const token = makeToken();
      prismaMock.serverBan.findMany.mockResolvedValue([banRow]);
      prismaMock.serverBan.count.mockResolvedValue(250);

      const res = await request(app)
        .get('/api/v1/servers/srv-1/bans?page=2&limit=1000')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
      expect(res.body.page).toBe(2);
      expect(res.body.hasMore).toBe(true);
      expect(prismaMock.serverBan.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 100 }));
    });

    it('returns 403 without KICK_MEMBERS (non-members included)', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);
      const res = await request(app)
        .get('/api/v1/servers/srv-1/bans')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(prismaMock.serverBan.findMany).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /api/v1/servers/:serverId/bans/:userId ───────────────────────

  describe('DELETE /api/v1/servers/:serverId/bans/:userId', () => {
    it('deletes the ban row', async () => {
      const token = makeToken();
      prismaMock.serverBan.deleteMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/bans/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Member unbanned');
      expect(prismaMock.serverBan.deleteMany).toHaveBeenCalledWith({ where: { serverId: 'srv-1', userId: 'user-2' } });
    });

    it('returns 404 when there is no ban to lift', async () => {
      const token = makeToken();
      prismaMock.serverBan.deleteMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/bans/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Ban not found');
    });

    it('returns 403 without KICK_MEMBERS', async () => {
      const token = makeToken();
      mockHasServerPermission.mockResolvedValue(false);
      const res = await request(app)
        .delete('/api/v1/servers/srv-1/bans/user-2')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(prismaMock.serverBan.deleteMany).not.toHaveBeenCalled();
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

    // server.ownerId is the pivot of every visibility calculator's owner fast
    // path, and channel:{id} rooms are computed at connect. Without a resync
    // the old owner keeps receiving staff-only channels' events and the new
    // owner misses channel-scoped lifecycle events until reconnect.
    it('resyncs channel visibility rooms for BOTH the new and the old owner after the transaction', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.userId_serverId.userId === 'user-1'
          ? { userId: 'user-1', serverId: 'srv-1', role: 'owner' }
          : { userId: 'user-2', serverId: 'srv-1', role: 'member' }));
      const order: string[] = [];
      prismaMock.$transaction.mockImplementation(async () => { order.push('txn'); return []; });
      mockSyncVisibilityRooms.mockImplementation(async (_sid: string, opts: { userId: string }) => { order.push(`sync:${opts.userId}`); });
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: false, ownerId: 'user-2', createdAt: new Date() });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/transfer-ownership')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: 'user-2' });

      expect(res.status).toBe(200);
      expect(mockSyncVisibilityRooms).toHaveBeenCalledWith('srv-1', { userId: 'user-2' });
      expect(mockSyncVisibilityRooms).toHaveBeenCalledWith('srv-1', { userId: 'user-1' });
      // the server:updated emit carries the full Server (directory profile included)
      expect(prismaMock.server.findUnique).toHaveBeenCalledWith({ where: { id: 'srv-1' }, select: SERVER_SELECT });
      // After the commit: the util re-reads ownerId, so syncing before it
      // would recompute against the OLD owner
      expect(order[0]).toBe('txn');
      expect(order).toEqual(expect.arrayContaining(['sync:user-2', 'sync:user-1']));
    });

    it('recomputes the directory listing column AFTER the transfer commits (ownerId decides whose ban state counts)', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.userId_serverId.userId === 'user-1'
          ? { userId: 'user-1', serverId: 'srv-1', role: 'owner' }
          : { userId: 'user-2', serverId: 'srv-1', role: 'member' }));
      const order: string[] = [];
      prismaMock.$transaction.mockImplementation(async () => { order.push('txn'); return []; });
      mockRecomputeListed.mockImplementation(async () => { order.push('recompute'); return true; });
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: false, ownerId: 'user-2', createdAt: new Date(), description: null, tags: [], discoverable: true, joinMode: 'approval' });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/transfer-ownership')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: 'user-2' });

      expect(res.status).toBe(200);
      expect(mockRecomputeListed).toHaveBeenCalledWith('srv-1');
      expect(order).toEqual(['txn', 'recompute']);
    });

    it('refuses to transfer to a platform-banned member (a ban keeps the membership row), like the admin path', async () => {
      const token = makeToken();
      prismaMock.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(
        where.id === 'user-2'
          ? { id: 'user-2', bannedAt: new Date('2026-01-01T00:00:00Z') }
          : { id: 'user-1', bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0) }));
      prismaMock.serverMember.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.userId_serverId.userId === 'user-1'
          ? { userId: 'user-1', serverId: 'srv-1', role: 'owner' }
          : { userId: 'user-2', serverId: 'srv-1', role: 'member' }));

      const res = await request(app)
        .post('/api/v1/servers/srv-1/transfer-ownership')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: 'user-2' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('banned user');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(mockRecomputeListed).not.toHaveBeenCalled();
    });
  });
});
