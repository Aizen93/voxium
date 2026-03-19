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

vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
  hasChannelPermission: (...args: unknown[]) => mockHasChannelPermission(...args),
  getHighestRolePosition: (...args: unknown[]) => mockGetHighestRolePosition(...args),
  getEffectivePermissions: (...args: unknown[]) => mockGetEffectivePermissions(...args),
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

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
  },
  server: {
    findUnique: vi.fn(),
  },
  serverMember: {
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  invite: {
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
  },
  channelRead: {
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
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
  };
});

// Member broadcast
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
}));

// Feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Server limits
vi.mock('../../utils/serverLimits', () => ({
  getEffectiveLimits: vi.fn().mockResolvedValue({
    maxChannelsPerServer: 20,
    maxVoiceUsersPerChannel: 12,
    maxCategoriesPerServer: 12,
    maxMembersPerServer: 0, // unlimited
  }),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { inviteRouter } from '../../routes/invites';
import { errorHandler } from '../../middleware/errorHandler';
import { isFeatureEnabled } from '../../utils/featureFlags';
import { getEffectiveLimits } from '../../utils/serverLimits';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invites', inviteRouter);
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

const mockServer = {
  id: 'srv-1',
  name: 'Test Server',
  iconUrl: null,
  ownerId: 'user-1',
  invitesLocked: false,
  createdAt: new Date('2024-01-01'),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Invite Routes', () => {
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

  // ── POST /api/v1/invites/servers/:serverId ──────────────────────────────

  describe('POST /api/v1/invites/servers/:serverId', () => {
    it('creates an invite code for a server member', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.server.findUnique.mockResolvedValue(mockServer);
      prismaMock.invite.create.mockResolvedValue({
        id: 'inv-1',
        code: 'ABC12345',
        serverId: 'srv-1',
        createdBy: 'user-1',
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/api/v1/invites/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.code).toBe('ABC12345');
      expect(res.body.data.serverId).toBe('srv-1');
    });

    it('returns 403 for non-member', async () => {
      const token = makeToken();
      // No CREATE_INVITES permission (non-member)
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/invites/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 403 when invites are locked', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.server.findUnique.mockResolvedValue({
        ...mockServer,
        invitesLocked: true,
      });

      const res = await request(app)
        .post('/api/v1/invites/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('locked');
    });

    it('returns 403 when invite feature is disabled', async () => {
      (isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/invites/servers/srv-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('disabled');
      (isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v1/invites/servers/srv-1');
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/invites/:code/join ─────────────────────────────────────

  describe('POST /api/v1/invites/:code/join', () => {
    it('joins a server and deletes the invite (single-use)', async () => {
      const token = makeToken({ userId: 'user-2' });
      mockAuthUser({ id: 'user-2' });

      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'ABC12345',
        serverId: 'srv-1',
        expiresAt: null,
        server: { ...mockServer, invitesLocked: false },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue(null); // not already a member
      prismaMock.serverMember.count.mockResolvedValue(5);
      prismaMock.$transaction.mockResolvedValue([{}, {}]);
      prismaMock.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
      prismaMock.channelRead.createMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .post('/api/v1/invites/ABC12345/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('srv-1');

      // Verify transaction was called (creates member + deletes invite)
      expect(prismaMock.$transaction).toHaveBeenCalled();
    });

    it('returns 404 with invalid invite code', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/invites/INVALID/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 400 when already a member', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'ABC12345',
        serverId: 'srv-1',
        expiresAt: null,
        server: { ...mockServer, invitesLocked: false },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });

      const res = await request(app)
        .post('/api/v1/invites/ABC12345/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already a member');
    });

    it('returns 400 when invite is expired', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'EXPIRED1',
        serverId: 'srv-1',
        expiresAt: new Date('2020-01-01'), // expired
        server: { ...mockServer, invitesLocked: false },
      });
      prismaMock.invite.delete.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/invites/EXPIRED1/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('expired');
      expect(prismaMock.invite.delete).toHaveBeenCalledWith({ where: { code: 'EXPIRED1' } });
    });

    it('returns 403 when invites are locked on the server', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'LOCKED01',
        serverId: 'srv-1',
        expiresAt: null,
        server: { ...mockServer, invitesLocked: true },
      });

      const res = await request(app)
        .post('/api/v1/invites/LOCKED01/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('locked');
    });

    it('returns 400 when server member limit is reached', async () => {
      const token = makeToken({ userId: 'user-3' });
      mockAuthUser({ id: 'user-3' });

      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'FULL0001',
        serverId: 'srv-1',
        expiresAt: null,
        server: { ...mockServer, invitesLocked: false },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue(null);
      (getEffectiveLimits as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        maxChannelsPerServer: 20,
        maxVoiceUsersPerChannel: 12,
        maxCategoriesPerServer: 12,
        maxMembersPerServer: 10,
      });
      prismaMock.serverMember.count.mockResolvedValue(10);

      const res = await request(app)
        .post('/api/v1/invites/FULL0001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('member limit');
    });

    it('returns 403 when invite feature is disabled', async () => {
      (isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/invites/ABC12345/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      (isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it('seeds ChannelRead records for text channels', async () => {
      const token = makeToken({ userId: 'user-4' });
      mockAuthUser({ id: 'user-4' });

      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'SEED0001',
        serverId: 'srv-1',
        expiresAt: null,
        server: { ...mockServer, invitesLocked: false },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue(null);
      prismaMock.$transaction.mockResolvedValue([{}, {}]);
      prismaMock.channel.findMany.mockResolvedValue([
        { id: 'ch-1' },
        { id: 'ch-2' },
      ]);
      prismaMock.channelRead.createMany.mockResolvedValue({ count: 2 });

      await request(app)
        .post('/api/v1/invites/SEED0001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(prismaMock.channelRead.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ userId: 'user-4', channelId: 'ch-1' }),
            expect.objectContaining({ userId: 'user-4', channelId: 'ch-2' }),
          ]),
          skipDuplicates: true,
        }),
      );
    });
  });

  // ── GET /api/v1/invites/:code ──────────────────────────────────────────

  describe('GET /api/v1/invites/:code', () => {
    it('returns invite preview with server info', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'ABC12345',
        serverId: 'srv-1',
        expiresAt: null,
        server: {
          id: 'srv-1',
          name: 'Test Server',
          iconUrl: null,
          _count: { members: 42 },
        },
      });

      const res = await request(app)
        .get('/api/v1/invites/ABC12345')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.code).toBe('ABC12345');
      expect(res.body.data.server.name).toBe('Test Server');
      expect(res.body.data.server.memberCount).toBe(42);
    });

    it('returns 404 with invalid invite code', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/invites/INVALID')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 400 and deletes expired invite', async () => {
      const token = makeToken();
      prismaMock.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        code: 'EXPIRED1',
        serverId: 'srv-1',
        expiresAt: new Date('2020-01-01'),
        server: {
          id: 'srv-1',
          name: 'Test Server',
          iconUrl: null,
          _count: { members: 10 },
        },
      });
      prismaMock.invite.delete.mockResolvedValue({});

      const res = await request(app)
        .get('/api/v1/invites/EXPIRED1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('expired');
      expect(prismaMock.invite.delete).toHaveBeenCalled();
    });
  });
});
