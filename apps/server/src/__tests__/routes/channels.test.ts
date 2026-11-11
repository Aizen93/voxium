import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // The secure-channel creator's row, read by the creator's delete lever
  channelMember: {
    findUnique: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    groupBy: vi.fn(),
  },
  webhook: {
    count: vi.fn(),
  },
  // The attachment keys a channel delete reads before the cascade takes them
  messageAttachment: {
    findMany: vi.fn().mockResolvedValue([]),
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
  // The space row lock the create takes in its transaction
  $queryRaw: vi.fn(),
};

// Object storage: the files of a deleted channel's attachments
const mockDeleteMultipleFromS3 = vi.hoisted(() => vi.fn(async (keys: string[]) => keys.length));
vi.mock('../../utils/s3', () => ({
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
  deleteMultipleFromS3: (keys: string[]) => mockDeleteMultipleFromS3(keys),
}));

// Live voice dies with the channel on every node
const mockBroadcastChannelVoiceCleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../websocket/voiceCluster', () => ({
  broadcastChannelVoiceCleanup: (...args: unknown[]) => mockBroadcastChannelVoiceCleanup(...args),
}));

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

/**
 * The `groupBy({ by: ['secure'] })` rows the create route counts and places
 * from. Positions default to 0..n-1 with the secure channels after the
 * regular ones; `highest` overrides the highest position of each group.
 */
function channelCounts(regular: number, secure = 0, highest: { regular?: number; secure?: number } = {}) {
  const rows: { secure: boolean; _count: { _all: number }; _max: { position: number | null } }[] = [];
  if (regular > 0) rows.push({ secure: false, _count: { _all: regular }, _max: { position: highest.regular ?? regular - 1 } });
  if (secure > 0) rows.push({ secure: true, _count: { _all: secure }, _max: { position: highest.secure ?? regular + secure - 1 } });
  return rows;
}

/** Set while a `$transaction` callback runs, so a mock can tell where it was called. */
let inTransaction = false;

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
    prismaMock.channel.groupBy.mockResolvedValue([]);
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
    // An interactive transaction runs its callback on the same mocks; an
    // array one (the reorder) awaits its statements
    inTransaction = false;
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      inTransaction = true;
      try {
        return await arg(new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }));
      } finally {
        inTransaction = false;
      }
    });
    // The space row lock finds the space
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'srv-1' }]);
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
      // id breaks position ties, as GET /servers/:serverId does
      expect(prismaMock.channel.findMany).toHaveBeenCalledWith({
        where: { serverId: 'srv-1' },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(2));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(1));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(20));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(5));
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

    it('does not count secure channels against the channel limit', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      // 19 regular + 5 secure: the total is over 20, the regular count is not
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(19, 5));
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new', name: 'fits', type: 'text', serverId: 'srv-1', position: 24, categoryId: null, secure: false,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'fits', type: 'text' });

      // one grouped count serves both numbers
      expect(prismaMock.channel.groupBy).toHaveBeenCalledTimes(1);
      expect(prismaMock.channel.groupBy).toHaveBeenCalledWith(expect.objectContaining({
        by: ['secure'],
        where: { serverId: 'srv-1' },
      }));
      expect(res.body.error ?? '').not.toContain('at most');
      expect(res.status).toBe(201);
      // the position still follows every channel, secure ones included
      expect(prismaMock.channel.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ position: 24 }),
      }));
    });

    it('refuses at the limit counted over regular channels, whatever secure channels exist', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(20, 3));

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'overflow', type: 'text' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most 20');
      expect(prismaMock.channel.create).not.toHaveBeenCalled();
    });

    it('places the first channel of a space with only secure channels after them', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0, 5));
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new', name: 'first', type: 'text', serverId: 'srv-1', position: 5, categoryId: null, secure: false,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'first', type: 'text' });

      expect(res.status).toBe(201);
      expect(prismaMock.channel.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ position: 5 }),
      }));
    });

    it('places the first channel of an empty space at position 0', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.groupBy.mockResolvedValue([]);
      prismaMock.channel.create.mockResolvedValue({
        id: 'ch-new', name: 'first', type: 'text', serverId: 'srv-1', position: 0, categoryId: null, secure: false,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'first', type: 'text' });

      expect(res.status).toBe(201);
      expect(prismaMock.channel.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ position: 0 }),
      }));
    });

    it('answers 500 and creates nothing when the count fails', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'admin' });
      prismaMock.channel.groupBy.mockRejectedValue(new Error('db down'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'first', type: 'text' });

      expect(res.status).toBe(500);
      expect(prismaMock.channel.create).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    // ── The limit and the position, under the space row lock ─────────────

    it('locks the space row, then counts and places, then inserts, all inside ONE transaction', async () => {
      const token = makeToken();
      const order: string[] = [];
      const where = () => (inTransaction ? 'tx' : 'outside');
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        order.push(`lock:${where()}`);
        expect(strings.join('?')).toBe('SELECT id FROM servers WHERE id = ? FOR UPDATE');
        expect(values).toEqual(['srv-1']);
        return [{ id: 'srv-1' }];
      });
      prismaMock.channel.groupBy.mockImplementation(async () => { order.push(`count:${where()}`); return channelCounts(3); });
      prismaMock.channel.create.mockImplementation(async ({ data }: any) => {
        order.push(`create:${where()}`);
        return { id: 'ch-new', categoryId: null, ...data };
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(201);
      expect(order).toEqual(['lock:tx', 'count:tx', 'create:tx']);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      // one grouped read: the count per kind and the highest position
      expect(prismaMock.channel.groupBy).toHaveBeenCalledWith({
        by: ['secure'],
        where: { serverId: 'srv-1' },
        _count: { _all: true },
        _max: { position: true },
      });
    });

    it('places the channel after the highest position, so a gap a delete left never gives a second channel the same one', async () => {
      // Three regular channels at positions 0, 4 and 9 (one between them was
      // deleted): the count (3) is a position a channel already holds
      const token = makeToken();
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(3, 0, { regular: 9 }));
      prismaMock.channel.create.mockImplementation(async ({ data }: any) => ({ id: 'ch-new', categoryId: null, ...data }));

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(201);
      expect(prismaMock.channel.create).toHaveBeenCalledWith({
        data: { name: 'new-channel', type: 'text', serverId: 'srv-1', position: 10, categoryId: null },
      });
    });

    it('places a channel after a secure channel that holds the highest position', async () => {
      const token = makeToken();
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(2, 1, { regular: 1, secure: 7 }));
      prismaMock.channel.create.mockImplementation(async ({ data }: any) => ({ id: 'ch-new', categoryId: null, ...data }));

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(201);
      expect(prismaMock.channel.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ position: 8 }),
      }));
    });

    it('a limit of 0 freezes channel creation', async () => {
      const token = makeToken();
      prismaMock.channel.groupBy.mockResolvedValue([]);
      (getEffectiveLimits as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        maxChannelsPerServer: 0, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 0,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server can have at most 0 channels');
      expect(prismaMock.channel.create).not.toHaveBeenCalled();
    });

    it('404 Server when the space was deleted since the permission check, creating and announcing nothing', async () => {
      const token = makeToken();
      prismaMock.$queryRaw.mockResolvedValue([]);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'new-channel', type: 'text' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Server not found');
      expect(prismaMock.channel.groupBy).not.toHaveBeenCalled();
      expect(prismaMock.channel.create).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('a creation PostgreSQL aborted to break a deadlock is run again and succeeds', async () => {
      const token = makeToken();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
        })
        .mockImplementation(real);
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(1));
      prismaMock.channel.create.mockImplementation(async ({ data }: any) => ({ id: 'ch-new', categoryId: null, ...data }));
      try {
        const res = await request(app)
          .post('/api/v1/servers/srv-1/channels')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'new-channel', type: 'text' });

        expect(res.status).toBe(201);
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(prismaMock.channel.create).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
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

    it('answers like a missing category, not 500, when the category is deleted between the check and the insert', async () => {
      const token = makeToken();
      prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-1', serverId: 'srv-1' });
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(1));
      // The insert's foreign key on category_id: the row is gone
      prismaMock.channel.create.mockRejectedValue(Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' }));

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'valid-name', type: 'text', categoryId: 'cat-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Category not found in this server');
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('still answers 500 for any other failure of the insert', async () => {
      const token = makeToken();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(1));
      prismaMock.channel.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

      const res = await request(app)
        .post('/api/v1/servers/srv-1/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'valid-name', type: 'text' });

      expect(res.status).toBe(500);
      errSpy.mockRestore();
    });

    it('does NOT seed ChannelRead rows and auto-joins server sockets to the new channel room (MED-15)', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'admin',
      });
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(2));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0));
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(0));
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

    it('tells the server room webhook:changed when the channel carried webhooks (they cascade with it), and nothing when it did not', async () => {
      const token = makeToken();
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'owner' });
      prismaMock.channel.findFirst.mockResolvedValue({ id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-1' });
      prismaMock.channel.delete.mockResolvedValue({});
      prismaMock.webhook.count.mockResolvedValueOnce(2);

      await request(app).delete('/api/v1/servers/srv-1/channels/ch-1').set('Authorization', `Bearer ${token}`);

      expect(prismaMock.webhook.count).toHaveBeenCalledWith({ where: { channelId: 'ch-1' } });
      // the server id alone: a channel id never reaches the server room
      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockEmit).toHaveBeenCalledWith('webhook:changed', { serverId: 'srv-1' });

      mockTo.mockClear();
      mockEmit.mockClear();
      prismaMock.webhook.count.mockResolvedValueOnce(0);
      await request(app).delete('/api/v1/servers/srv-1/channels/ch-1').set('Authorization', `Bearer ${token}`);
      expect(mockEmit).not.toHaveBeenCalledWith('webhook:changed', expect.anything());
      expect(mockEmit).toHaveBeenCalledWith('channel:deleted', { channelId: 'ch-1', serverId: 'srv-1' });
    });

    describe('attachment files', () => {
      const KEYS = ['attachments/ch-1/clmsg1-photo.png', 'attachments/ch-1/clmsg2-notes.txt'];

      beforeEach(() => {
        prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'owner' });
        prismaMock.channel.findFirst.mockResolvedValue({ id: 'ch-1', name: 'general', type: 'text', serverId: 'srv-1', secure: false });
        prismaMock.channel.delete.mockReset().mockResolvedValue({});
        prismaMock.webhook.count.mockResolvedValue(0);
        prismaMock.messageAttachment.findMany.mockReset().mockResolvedValue([]);
        mockDeleteMultipleFromS3.mockReset().mockImplementation(async (keys: string[]) => keys.length);
        mockBroadcastChannelVoiceCleanup.mockReset().mockResolvedValue(undefined);
      });

      const deleteChannel = () => request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${makeToken()}`);

      it('reads the kept attachment keys of the channel BEFORE the row, and deletes the files AFTER it', async () => {
        prismaMock.messageAttachment.findMany.mockResolvedValueOnce([
          { id: 'att-1', s3Key: KEYS[0] }, { id: 'att-2', s3Key: KEYS[1] },
        ]);

        const res = await deleteChannel();

        expect(res.status).toBe(200);
        expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
          where: { expired: false, message: { channelId: 'ch-1' } },
        }));
        expect(mockDeleteMultipleFromS3).toHaveBeenCalledTimes(1);
        expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith(KEYS);
        const deleteOrder = prismaMock.channel.delete.mock.invocationCallOrder[0];
        expect(prismaMock.messageAttachment.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
        expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
      });

      it('touches storage not at all for a channel without kept attachments', async () => {
        await deleteChannel();

        expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      });

      it('a storage failure is logged and the delete still answers 200', async () => {
        prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEYS[0] }]);
        mockDeleteMultipleFromS3.mockRejectedValueOnce(new Error('S3 unavailable'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const res = await deleteChannel();

          expect(res.status).toBe(200);
          await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
            '[Channels] Attachment file cleanup failed for channel ch-1 (the orphan sweep will reclaim them):', 'S3 unavailable'));
        } finally {
          warn.mockRestore();
        }
      });

      it('a row delete that fails deletes no file', async () => {
        prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEYS[0] }]);
        prismaMock.channel.delete.mockRejectedValueOnce(new Error('db gone'));
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const res = await deleteChannel();

          expect(res.status).toBe(500);
          expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
        } finally {
          errorLog.mockRestore();
        }
      });

      it('starts the file delete before the events, so a throwing fan-out cannot skip it', async () => {
        prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEYS[0] }]);
        mockBroadcastChannelVoiceCleanup.mockRejectedValueOnce(new Error('voice cleanup failed'));
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await deleteChannel();

          expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([KEYS[0]]);
        } finally {
          errorLog.mockRestore();
        }
      });
    });

    describe('the steps after the row delete are best effort', () => {
      let errorLog: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'owner' });
        prismaMock.channel.findFirst.mockResolvedValue({ id: 'ch-1', name: 'general', type: 'voice', serverId: 'srv-1', secure: false });
        prismaMock.channel.delete.mockReset().mockResolvedValue({});
        prismaMock.webhook.count.mockResolvedValue(1);
        prismaMock.messageAttachment.findMany.mockReset().mockResolvedValue([]);
        mockBroadcastChannelVoiceCleanup.mockReset().mockResolvedValue(undefined);
        errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      });

      afterEach(() => {
        errorLog.mockRestore();
        mockEmit.mockReset();
        prismaMock.webhook.count.mockReset();
      });

      const deleteChannel = () => request(app)
        .delete('/api/v1/servers/srv-1/channels/ch-1')
        .set('Authorization', `Bearer ${makeToken()}`);

      it('a voice cleanup that rejects answers 200 for the delete that happened, after the notices went out', async () => {
        mockBroadcastChannelVoiceCleanup.mockRejectedValueOnce(new Error('voice cleanup failed'));

        const res = await deleteChannel();

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Channel deleted');
        expect(mockEmit).toHaveBeenCalledWith('channel:deleted', { channelId: 'ch-1', serverId: 'srv-1' });
        expect(mockEmit).toHaveBeenCalledWith('webhook:changed', { serverId: 'srv-1' });
        expect(errorLog).toHaveBeenCalledWith('[Channels] Channel ch-1 deleted, but the voice cleanup failed:', 'voice cleanup failed');
      });

      it('a notice that throws still tears the live voice down and answers 200', async () => {
        mockEmit.mockImplementation(() => { throw new Error('adapter publish failed'); });

        const res = await deleteChannel();

        expect(res.status).toBe(200);
        expect(mockBroadcastChannelVoiceCleanup).toHaveBeenCalledWith(expect.anything(), 'ch-1');
        expect(errorLog).toHaveBeenCalledWith('[Channels] Channel ch-1 deleted, but the channel:deleted notice failed:', 'adapter publish failed');
        expect(errorLog).toHaveBeenCalledWith('[Channels] Channel ch-1 deleted, but the webhook:changed notice failed:', 'adapter publish failed');
      });

      it('a row delete that fails announces nothing and tears nothing down', async () => {
        prismaMock.channel.delete.mockRejectedValueOnce(new Error('db gone'));

        const res = await deleteChannel();

        expect(res.status).toBe(500);
        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
      });
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
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'creator-9' });
      prismaMock.channelMember.findUnique.mockResolvedValue({ isCreator: true });

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockDeleteSecureChannel).toHaveBeenCalledWith('sec-1');
      expect(prismaMock.serverMember.findUnique).toHaveBeenCalledWith({
        where: { userId_serverId: { userId: 'creator-9', serverId: 'srv-1' } },
        select: { userId: true },
      });
      expect(prismaMock.channelMember.findUnique).toHaveBeenCalledWith({
        where: { channelId_userId: { channelId: 'sec-1', userId: 'creator-9' } },
        select: { isCreator: true },
      });
      // The plaintext delete path (raw prisma delete + server-room event) must not run
      expect(prismaMock.channel.delete).not.toHaveBeenCalled();
    });

    it('DELETE: a former creator who joined the space again, without their creator row, has no lever over the channel', async () => {
      const token = makeToken({ userId: 'creator-9' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'creator-9', bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      });
      prismaMock.channel.findFirst.mockResolvedValue(secureCh);
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'creator-9' });
      prismaMock.channelMember.findUnique.mockResolvedValue(null);
      // a plain member of the space: no ADMINISTRATOR, no MANAGE_CHANNELS
      mockHasServerPermission.mockResolvedValue(false);
      mockComputeServerPermissions.mockResolvedValue(Permissions.VIEW_CHANNEL);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have permission to delete channels');
      expect(mockDeleteSecureChannel).not.toHaveBeenCalled();
    });

    it('DELETE: a creator who is no longer a member of the space has no lever over the channel', async () => {
      const token = makeToken({ userId: 'creator-9' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'creator-9', bannedAt: null, tokenVersion: 0, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      });
      prismaMock.channel.findFirst.mockResolvedValue(secureCh);
      prismaMock.serverMember.findUnique.mockResolvedValue(null);
      // a non-member holds no permission in the space
      mockHasServerPermission.mockResolvedValue(false);
      mockComputeServerPermissions.mockResolvedValue(0n);

      const res = await request(app)
        .delete('/api/v1/servers/srv-1/channels/sec-1')
        .set('Authorization', `Bearer ${token}`);

      // what this caller gets for an id that does not exist
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have permission to delete channels');
      expect(mockDeleteSecureChannel).not.toHaveBeenCalled();
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
      prismaMock.channel.groupBy.mockResolvedValue(channelCounts(1));
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

  // ── PUT /reorder: what an entry may carry ─────────────────────────────
  //
  // A creation places the new channel after the highest position in the
  // space, so a reorder must not be able to write one near the column's
  // ceiling (every later creation would fail), and an entry that is not a
  // channel id and a whole number is a 400, not a 500 from the database.

  describe('PUT /reorder: entry validation', () => {
    const reorder = (order: unknown) => request(app)
      .put('/api/v1/servers/srv-1/channels/reorder')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ order });

    it.each([
      ['a negative position', [{ id: 'ch-1', position: -1 }]],
      ['a fractional position', [{ id: 'ch-1', position: 1.5 }]],
      ['a position past the bound', [{ id: 'ch-1', position: 1_000_001 }]],
      ['a position at the column ceiling', [{ id: 'ch-1', position: 2_147_483_647 }]],
      ['a position given as a string', [{ id: 'ch-1', position: '3' }]],
      ['no position', [{ id: 'ch-1' }]],
      ['a numeric id', [{ id: 7, position: 0 }]],
      ['an entry that is not an object', ['ch-1']],
      ['a null entry', [null]],
      ['a numeric categoryId', [{ id: 'ch-1', position: 0, categoryId: 4 }]],
    ])('400 for %s, before any read or write', async (_label, order) => {
      const res = await reorder(order);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Each order entry needs a channel id and a whole-number position from 0 to 1000000');
      expect(prismaMock.channel.findMany).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('accepts 0 and the bound itself, with or without a category', async () => {
      prismaMock.channel.findMany
        .mockResolvedValueOnce([{ id: 'ch-1' }, { id: 'ch-2' }])
        .mockResolvedValueOnce([]);
      prismaMock.category.findMany.mockResolvedValueOnce([{ id: 'cat-1' }]);
      prismaMock.$transaction.mockResolvedValue([]);

      const res = await reorder([
        { id: 'ch-1', position: 0, categoryId: null },
        { id: 'ch-2', position: 1_000_000, categoryId: 'cat-1' },
      ]);

      expect(res.status).toBe(200);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
