import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { TEST_JWT_SECRET } from '../helpers/testSecrets';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = TEST_JWT_SECRET;

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
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  server: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  messageAttachment: {
    updateMany: vi.fn(),
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
// Room operations, in call order, with the scope they ran on
const roomOps: Array<[string, string, string[]]> = [];
const mockFetchSockets = vi.fn().mockResolvedValue([]);
const mockIn = vi.fn((room: string) => ({
  fetchSockets: mockFetchSockets,
  socketsLeave: (rooms: string[]) => { roomOps.push(['cluster', room, rooms]); },
  disconnectSockets: () => { roomOps.push(['cluster-disconnect', room, []]); },
}));
const mockLocalIn = vi.fn((room: string) => ({
  socketsLeave: (rooms: string[]) => { roomOps.push(['local', room, rooms]); },
  disconnectSockets: () => { roomOps.push(['local-disconnect', room, []]); },
}));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
    local: { in: mockLocalIn },
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitAdmin: passthrough,
    normalizeIp: (ip: string) => ip,
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

vi.mock('../../utils/discoveryPageCache', () => ({
  bumpDiscoveryPageCache: vi.fn().mockResolvedValue(undefined),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { adminRouter } from '../../routes/admin';
import { bumpDiscoveryPageCache } from '../../utils/discoveryPageCache';
import { deleteFromS3 } from '../../utils/s3';
import { serverSelect } from '../../utils/serverSelect';
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
        emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
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
        emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      });
    }
    return Promise.resolve(null);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DELETE /admin/storage/files/*path', () => {
  let app: express.Express;
  const auth = () => ({ Authorization: `Bearer ${makeToken()}` });

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSuperAdminUser();
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.server.findMany.mockResolvedValue([]);
    prismaMock.server.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.messageAttachment.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.serverMember.findMany.mockResolvedValue([]);
  });

  it('announces a removed avatar to every space the owner is in', async () => {
    prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u1', displayName: 'Alice', avatarUrl: null }]);
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's1' }, { serverId: 's2' }]);

    const res = await request(app).delete('/api/v1/admin/storage/files/avatars/u1-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({ where: { avatarUrl: 'avatars/u1-1-abcd.webp' }, data: { avatarUrl: null } });
    expect(mockTo).toHaveBeenCalledWith('server:s1');
    expect(mockTo).toHaveBeenCalledWith('server:s2');
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit).toHaveBeenCalledWith('user:updated', { userId: 'u1', displayName: 'Alice', avatarUrl: null });
    expect(deleteFromS3).toHaveBeenCalledWith('avatars/u1-1-abcd.webp');
  });

  it('reads who held the avatar before the key is nulled, and announces each owner as their row reads after the write', async () => {
    prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      // a rename and a new avatar landed between the two reads
      .mockResolvedValueOnce([{ id: 'u1', displayName: 'Alice Renamed', avatarUrl: 'avatars/u1-2-ffff.webp' }]);
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's1' }]);

    const res = await request(app).delete('/api/v1/admin/storage/files/avatars/u1-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(prismaMock.user.findMany).toHaveBeenNthCalledWith(1, { where: { avatarUrl: 'avatars/u1-1-abcd.webp' }, select: { id: true } });
    expect(prismaMock.user.findMany).toHaveBeenNthCalledWith(2, { where: { id: { in: ['u1'] } }, select: { id: true, displayName: true, avatarUrl: true } });
    const [firstRead, secondRead] = prismaMock.user.findMany.mock.invocationCallOrder;
    const [write] = prismaMock.user.updateMany.mock.invocationCallOrder;
    expect(firstRead).toBeLessThan(write);
    expect(write).toBeLessThan(secondRead);
    expect(mockEmit).toHaveBeenCalledWith('user:updated', { userId: 'u1', displayName: 'Alice Renamed', avatarUrl: 'avatars/u1-2-ffff.webp' });
  });

  it('still deletes the file and answers 200 when the profiles cannot be read after the write', async () => {
    prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockRejectedValueOnce(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).delete('/api/v1/admin/storage/files/avatars/u1-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(deleteFromS3).toHaveBeenCalledWith('avatars/u1-1-abcd.webp');
    expect(errSpy).toHaveBeenCalledWith('[Admin] Failed to read the profiles to announce after an avatar removal:', 'db down');
    errSpy.mockRestore();
  });

  it('emits nothing when no user held the avatar key', async () => {
    const res = await request(app).delete('/api/v1/admin/storage/files/avatars/ghost-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(deleteFromS3).toHaveBeenCalled();
  });

  it('announces a removed space icon with the full server shape and bumps the Explore cache', async () => {
    const shape = { id: 's1', name: 'Space', iconUrl: null, ownerId: 'u1' };
    prismaMock.server.findMany
      .mockResolvedValueOnce([{ id: 's1' }])
      .mockResolvedValueOnce([shape]);
    prismaMock.server.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete('/api/v1/admin/storage/files/server-icons/s1-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({ where: { iconUrl: 'server-icons/s1-1-abcd.webp' }, data: { iconUrl: null } });
    expect(bumpDiscoveryPageCache).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith('server:s1');
    expect(mockEmit).toHaveBeenCalledWith('server:updated', shape);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    // who held the icon is read before the key is nulled; what is sent is the public shape of the space
    const [idsRead, shapeRead] = prismaMock.server.findMany.mock.invocationCallOrder;
    const [write] = prismaMock.server.updateMany.mock.invocationCallOrder;
    expect(idsRead).toBeLessThan(write);
    expect(write).toBeLessThan(shapeRead);
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(1, { where: { iconUrl: 'server-icons/s1-1-abcd.webp' }, select: { id: true } });
    expect(prismaMock.server.findMany).toHaveBeenNthCalledWith(2, { where: { id: { in: ['s1'] } }, select: serverSelect });
  });

  it('still deletes the file and answers 200 when the space icon announcement fails', async () => {
    prismaMock.server.findMany
      .mockResolvedValueOnce([{ id: 's1' }])
      .mockRejectedValueOnce(new Error('db down'));
    prismaMock.server.updateMany.mockResolvedValue({ count: 1 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).delete('/api/v1/admin/storage/files/server-icons/s1-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(deleteFromS3).toHaveBeenCalledWith('server-icons/s1-1-abcd.webp');
    expect(errSpy).toHaveBeenCalledWith('[Admin] Failed to broadcast space icon removal:', 'db down');
    errSpy.mockRestore();
  });

  it('emits nothing and does not bump the cache for an icon no space held', async () => {
    const res = await request(app).delete('/api/v1/admin/storage/files/server-icons/none-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(bumpDiscoveryPageCache).not.toHaveBeenCalled();
  });

  it('emits nothing for an attachment key, which is only expired', async () => {
    const res = await request(app).delete('/api/v1/admin/storage/files/attachments/c1/file-1.png').set(auth());

    expect(res.status).toBe(200);
    expect(prismaMock.messageAttachment.updateMany).toHaveBeenCalledWith({ where: { s3Key: 'attachments/c1/file-1.png' }, data: { expired: true } });
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockTo).not.toHaveBeenCalled();
  });

  it('still deletes the file and answers 200 when the announcement fails', async () => {
    prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u1', displayName: 'Alice', avatarUrl: null }]);
    prismaMock.serverMember.findMany.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).delete('/api/v1/admin/storage/files/avatars/u1-1-abcd.webp').set(auth());

    expect(res.status).toBe(200);
    expect(deleteFromS3).toHaveBeenCalledWith('avatars/u1-1-abcd.webp');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('refuses a key of the wrong shape', async () => {
    const res = await request(app).delete('/api/v1/admin/storage/files/bad%20key').set(auth());
    expect(res.status).toBe(400);
    expect(deleteFromS3).not.toHaveBeenCalled();
  });
});
