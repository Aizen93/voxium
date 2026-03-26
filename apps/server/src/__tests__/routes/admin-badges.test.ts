import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'superadmin-1', username: 'superadmin', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  serverMember: {
    findMany: vi.fn(),
  },
  conversation: {
    findMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue({}),
  },
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
    rateLimitAdmin: passthrough,
  };
});

// Redis — getOnlineUsers needed by admin stats (loaded at import time)
vi.mock('../../utils/redis', () => ({
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

// Voice handler
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));

// DM voice handler
vi.mock('../../websocket/dmVoiceHandler', () => ({
  getActiveDMCallCount: vi.fn().mockResolvedValue(0),
  getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0),
}));

// mediasoup manager
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getSfuStats: vi.fn().mockReturnValue({ workers: [], totalTransports: 0 }),
}));

// Server limits
vi.mock('../../utils/serverLimits', () => ({
  getGlobalLimits: vi.fn().mockResolvedValue({}),
  getEffectiveLimits: vi.fn().mockResolvedValue({
    maxChannelsPerServer: 20,
    maxVoiceUsersPerChannel: 12,
    maxCategoriesPerServer: 12,
    maxMembersPerServer: 0,
  }),
}));

// Sanitize
vi.mock('../../utils/sanitize', () => ({
  sanitizeText: vi.fn((s: string) => s),
}));

// Member broadcast
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: vi.fn().mockResolvedValue(undefined),
}));

// S3
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Audit log
vi.mock('../../utils/auditLog', () => ({
  logAuditEvent: vi.fn(),
}));

// Feature flags (in case admin routes check)
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockSuperAdminUser() {
  // Auth middleware looks up user by userId from JWT
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id === 'superadmin-1') {
      return Promise.resolve({
        id: 'superadmin-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'superadmin',
        emailVerified: true,
      });
    }
    return Promise.resolve(null);
  });
}

function mockAdminUser() {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.id === 'admin-1') {
      return Promise.resolve({
        id: 'admin-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'admin',
        emailVerified: true,
      });
    }
    return Promise.resolve(null);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Admin Badge Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ── PATCH /admin/users/:userId/role ─────────────────────────────────────

  describe('PATCH /admin/users/:userId/role', () => {
    it('changes role and emits user:updated to server rooms', async () => {
      // Auth: superadmin user
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        // Target user lookup
        .mockResolvedValueOnce({
          id: 'target-user', role: 'user', username: 'targetuser',
        });

      prismaMock.user.update.mockResolvedValue({});

      // The user is a member of 2 servers
      prismaMock.serverMember.findMany.mockResolvedValue([
        { serverId: 'server-1' },
        { serverId: 'server-2' },
      ]);
      prismaMock.conversation.findMany.mockResolvedValue([]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Should emit user:updated to both server rooms
      expect(mockTo).toHaveBeenCalledWith('server:server-1');
      expect(mockTo).toHaveBeenCalledWith('server:server-2');
      expect(mockEmit).toHaveBeenCalledWith('user:updated', {
        userId: 'target-user',
        role: 'admin',
      });
    });

    it('emits user:updated to DM conversation rooms', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', role: 'user', username: 'targetuser',
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([]);
      prismaMock.conversation.findMany.mockResolvedValue([
        { id: 'conv-1' },
        { id: 'conv-2' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(200);

      // Should emit to DM rooms
      expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
      expect(mockTo).toHaveBeenCalledWith('dm:conv-2');
      expect(mockEmit).toHaveBeenCalledWith('user:updated', {
        userId: 'target-user',
        role: 'admin',
      });
    });

    it('rejects invalid role values', async () => {
      mockSuperAdminUser();

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'superadmin' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Role must be "user" or "admin"');
    });

    it('rejects missing role', async () => {
      mockSuperAdminUser();

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Role must be "user" or "admin"');
    });

    it('rejects self-role-change', async () => {
      mockSuperAdminUser();

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/superadmin-1/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot change your own role');
    });

    it('rejects modifying a superadmin', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'other-superadmin', role: 'superadmin', username: 'othersuperadmin',
        });

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/other-superadmin/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot modify a super admin');
    });

    it('rejects when user already has the same role', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', role: 'admin', username: 'targetuser',
        });

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('User already has role "admin"');
    });

    it('returns 404 for non-existent user', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce(null);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/nonexistent/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(404);
    });

    it('requires superadmin role (rejects admin)', async () => {
      mockAdminUser();

      const token = makeToken({ userId: 'admin-1', username: 'admin' });
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Super admin access required');
    });

    it('broadcast errors do not crash the endpoint', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', role: 'user', username: 'targetuser',
        });

      prismaMock.user.update.mockResolvedValue({});

      // Make the broadcast query fail
      prismaMock.serverMember.findMany.mockRejectedValue(new Error('DB connection lost'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/role')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' });

      // Endpoint should still succeed
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Admin] Failed to broadcast role change'),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  // ── PATCH /admin/users/:userId/supporter ────────────────────────────────

  describe('PATCH /admin/users/:userId/supporter', () => {
    it('grants supporter badge and emits user:updated with isSupporter and supporterTier', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: false, supporterTier: null,
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'server-1' }]);
      prismaMock.conversation.findMany.mockResolvedValue([]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true, supporterTier: 'first' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockTo).toHaveBeenCalledWith('server:server-1');
      expect(mockEmit).toHaveBeenCalledWith('user:updated', {
        userId: 'target-user',
        isSupporter: true,
        supporterTier: 'first',
      });
    });

    it('emits user:updated to DM conversation rooms', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: false, supporterTier: null,
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([]);
      prismaMock.conversation.findMany.mockResolvedValue([
        { id: 'conv-1' },
        { id: 'conv-3' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true, supporterTier: 'top' });

      expect(res.status).toBe(200);

      expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
      expect(mockTo).toHaveBeenCalledWith('dm:conv-3');
      expect(mockEmit).toHaveBeenCalledWith('user:updated', {
        userId: 'target-user',
        isSupporter: true,
        supporterTier: 'top',
      });
    });

    it('rejects when isSupporter is not a boolean', async () => {
      mockSuperAdminUser();

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('isSupporter must be a boolean');
    });

    it('rejects invalid supporterTier', async () => {
      mockSuperAdminUser();

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true, supporterTier: 'invalid-tier' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('supporterTier must be "first", "top", or null');
    });

    it('clears supporterTier when isSupporter is set to false', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: true, supporterTier: 'first',
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'server-1' }]);
      prismaMock.conversation.findMany.mockResolvedValue([]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: false });

      expect(res.status).toBe(200);

      // user.update should be called with supporterTier: null when isSupporter is false
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: 'target-user' },
        data: expect.objectContaining({
          isSupporter: false,
          supporterTier: null,
          supporterSince: null,
        }),
      });

      // Emitted payload should reflect cleared tier
      expect(mockEmit).toHaveBeenCalledWith('user:updated', {
        userId: 'target-user',
        isSupporter: false,
        supporterTier: null,
      });
    });

    it('preserves existing supporterTier when not provided and isSupporter is true', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: false, supporterTier: 'top',
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'server-1' }]);
      prismaMock.conversation.findMany.mockResolvedValue([]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true });

      expect(res.status).toBe(200);

      // When supporterTier not provided, should preserve existing tier
      expect(mockEmit).toHaveBeenCalledWith('user:updated', {
        userId: 'target-user',
        isSupporter: true,
        supporterTier: 'top',
      });
    });

    it('returns 404 for non-existent user', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce(null);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/nonexistent/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true });

      expect(res.status).toBe(404);
    });

    it('broadcast errors do not crash the endpoint', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: false, supporterTier: null,
        });

      prismaMock.user.update.mockResolvedValue({});

      // Make the broadcast query fail
      prismaMock.serverMember.findMany.mockRejectedValue(new Error('Redis down'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true, supporterTier: 'first' });

      // Endpoint should still succeed despite broadcast failure
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Admin] Failed to broadcast supporter change'),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it('emits to both server rooms and DM rooms simultaneously', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'superadmin-1', bannedAt: null, tokenVersion: 0, role: 'superadmin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: false, supporterTier: null,
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([
        { serverId: 'server-1' },
        { serverId: 'server-2' },
      ]);
      prismaMock.conversation.findMany.mockResolvedValue([
        { id: 'conv-1' },
        { id: 'conv-2' },
        { id: 'conv-3' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true, supporterTier: 'top' });

      expect(res.status).toBe(200);

      // Verify all rooms were targeted
      expect(mockTo).toHaveBeenCalledWith('server:server-1');
      expect(mockTo).toHaveBeenCalledWith('server:server-2');
      expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
      expect(mockTo).toHaveBeenCalledWith('dm:conv-2');
      expect(mockTo).toHaveBeenCalledWith('dm:conv-3');

      // Total emits: 2 server + 3 DM = 5
      expect(mockEmit).toHaveBeenCalledTimes(5);

      // Each emit should have the same payload
      for (let i = 0; i < 5; i++) {
        expect(mockEmit).toHaveBeenNthCalledWith(i + 1, 'user:updated', {
          userId: 'target-user',
          isSupporter: true,
          supporterTier: 'top',
        });
      }
    });

    it('allows admin (not just superadmin) to manage supporter badges', async () => {
      // supporter endpoint uses requireAdmin (not requireSuperAdmin)
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'admin-1', bannedAt: null, tokenVersion: 0, role: 'admin', emailVerified: true,
        })
        .mockResolvedValueOnce({
          id: 'target-user', username: 'targetuser', isSupporter: false, supporterTier: null,
        });

      prismaMock.user.update.mockResolvedValue({});
      prismaMock.serverMember.findMany.mockResolvedValue([]);
      prismaMock.conversation.findMany.mockResolvedValue([]);

      const token = makeToken({ userId: 'admin-1', username: 'admin' });
      const res = await request(app)
        .patch('/api/v1/admin/users/target-user/supporter')
        .set('Authorization', `Bearer ${token}`)
        .send({ isSupporter: true, supporterTier: 'first' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
