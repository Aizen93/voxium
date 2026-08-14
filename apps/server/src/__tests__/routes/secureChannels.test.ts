import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Permissions, E2E_LIMITS, WS_EVENTS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockHasServerPermission = vi.fn();
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: any[]) => mockHasServerPermission(...args),
}));

const prismaMock: Record<string, any> = {
  channel: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  channelMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  channelRead: {
    upsert: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  serverMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  e2EKeyShare: {
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

// Socket.IO — capture rooms and events
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockSocketsJoin = vi.fn();
const mockSocketsLeave = vi.fn();
const mockIn = vi.fn(() => ({
  socketsJoin: mockSocketsJoin,
  socketsLeave: mockSocketsLeave,
  fetchSockets: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: mockTo, in: mockIn })),
}));

// S3 (imported transitively by secureChannelLifecycle)
vi.mock('../../utils/s3', () => ({
  deleteMultipleFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Auth — req.user injected directly
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: () => void) => {
    req.user = { userId: 'user-1', username: 'creator', tokenVersion: 0, role: 'user' };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: () => void) => next(),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitSecureChannelManage: passthrough,
    rateLimitMemberManage: passthrough,
    rateLimitGeneral: passthrough,
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

// ─── App setup (real secureChannels router + REAL lifecycle helpers) ────────

import { secureChannelRouter } from '../../routes/secureChannels';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers/:serverId/secure-channels', secureChannelRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const CH = {
  id: 'sec-1',
  name: 'covert-ops',
  serverId: 'srv-1',
  secure: true,
  createdById: 'user-1',
};

/** Configure the membership gate: caller's row (or null). */
function mockCallerMembership(isCreator: boolean | null) {
  prismaMock.channel.findFirst.mockResolvedValue({
    id: CH.id, name: CH.name, serverId: CH.serverId, createdById: CH.createdById,
  });
  prismaMock.channelMember.findUnique.mockResolvedValue(
    isCreator === null ? null : { isCreator },
  );
}

function membersPayloadRows() {
  return [
    {
      userId: 'user-1', isCreator: true, addedAt: new Date('2026-08-01T00:00:00Z'),
      user: { id: 'user-1', username: 'creator', displayName: 'Creator', avatarUrl: null },
    },
    {
      userId: 'user-2', isCreator: false, addedAt: new Date('2026-08-02T00:00:00Z'),
      user: { id: 'user-2', username: 'felix', displayName: 'Felix', avatarUrl: null },
    },
  ];
}

describe('Secure Channel Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockHasServerPermission.mockResolvedValue(true);
    // Interactive tx runs the callback on the same proxy; array tx awaits all
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg(new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }));
    });
    prismaMock.channelMember.findMany.mockResolvedValue(membersPayloadRows());
    // Caller gate cross-checks ServerMember (stale-row defense); the invite tx
    // takes a row lock via $queryRaw before its in-tx cap/duplicate checks
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1' });
    prismaMock.$queryRaw.mockResolvedValue([{ id: CH.id }]);
  });

  // ── POST / (create) ────────────────────────────────────────────────────

  describe('POST / (create)', () => {
    beforeEach(() => {
      prismaMock.channel.count.mockResolvedValue(3);
      prismaMock.serverMember.findMany.mockResolvedValue([
        { userId: 'user-2' }, { userId: 'user-3' },
      ]);
      prismaMock.channel.create.mockResolvedValue({ ...CH, type: 'text', position: 3 });
      prismaMock.channelMember.createMany.mockResolvedValue({ count: 3 });
      prismaMock.channelRead.createMany.mockResolvedValue({ count: 3 });
    });

    it('creates the channel with creator + invitees and notifies ONLY member user rooms', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'covert-ops', memberIds: ['user-2', 'user-3', 'user-2', 'user-1'] });

      expect(res.status).toBe(201);
      expect(mockHasServerPermission).toHaveBeenCalledWith(
        'user-1', 'srv-1', Permissions.CREATE_SECURE_CHANNELS,
      );
      // Deduped, self dropped, creator flagged
      expect(prismaMock.channelMember.createMany).toHaveBeenCalledWith({
        data: [
          { channelId: CH.id, userId: 'user-1', isCreator: true },
          { channelId: CH.id, userId: 'user-2', isCreator: false },
          { channelId: CH.id, userId: 'user-3', isCreator: false },
        ],
      });
      // ChannelRead seeded for everyone present from the start
      expect(prismaMock.channelRead.createMany).toHaveBeenCalled();
      // Events to each member's user room; NEVER the server room
      const rooms = mockTo.mock.calls.map((c: any[]) => c[0]);
      expect(rooms).toEqual(expect.arrayContaining(['user:user-1', 'user:user-2', 'user:user-3']));
      expect(rooms.every((r: string) => !r.startsWith('server:'))).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_CREATED, expect.objectContaining({ id: CH.id }));
      // Sockets joined into the channel room via user rooms
      expect(mockIn).toHaveBeenCalledWith('user:user-2');
      expect(mockSocketsJoin).toHaveBeenCalledWith(`channel:${CH.id}`);
    });

    it('403 without CREATE_SECURE_CHANNELS', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'covert-ops' });

      expect(res.status).toBe(403);
      expect(prismaMock.channel.create).not.toHaveBeenCalled();
    });

    it('400 on invalid channel name', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'bad!!name' });

      expect(res.status).toBe(400);
    });

    it('creates a secure VOICE channel — type persisted, NO ChannelRead seeding (spec §21)', async () => {
      prismaMock.channel.create.mockResolvedValue({ ...CH, type: 'voice', position: 3 });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'war-room', type: 'voice', memberIds: ['user-2', 'user-3'] });

      expect(res.status).toBe(201);
      expect(prismaMock.channel.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'voice', secure: true }) }),
      );
      // Voice channels carry no messages — no unread tracking rows
      expect(prismaMock.channelRead.createMany).not.toHaveBeenCalled();
    });

    it('400 on an invalid channel type', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'war-room', type: 'video' });

      expect(res.status).toBe(400);
      expect(prismaMock.channel.create).not.toHaveBeenCalled();
    });

    it('400 when invitees exceed the member cap', async () => {
      const tooMany = Array.from(
        { length: E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP },
        (_, i) => `invitee-${i}`,
      );

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'covert-ops', memberIds: tooMany });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(`${E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP}`);
    });

    it('400 when an invitee is not a server member', async () => {
      prismaMock.serverMember.findMany.mockResolvedValue([{ userId: 'user-2' }]); // user-3 missing

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'covert-ops', memberIds: ['user-2', 'user-3'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('members of this server');
    });

    it('400 when the server channel limit is reached (secure channels count too)', async () => {
      prismaMock.channel.count.mockResolvedValue(20);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'covert-ops' });

      expect(res.status).toBe(400);
    });

    it('400 when memberIds is not a string array', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels')
        .send({ name: 'covert-ops', memberIds: [42] });

      expect(res.status).toBe(400);
    });
  });

  // ── GET /count ─────────────────────────────────────────────────────────

  describe('GET /count', () => {
    it('returns the count for MANAGE_SERVER holders', async () => {
      prismaMock.channel.count.mockResolvedValue(2);

      const res = await request(app).get('/api/v1/servers/srv-1/secure-channels/count');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ count: 2 });
      expect(mockHasServerPermission).toHaveBeenCalledWith('user-1', 'srv-1', Permissions.MANAGE_SERVER);
    });

    it('403 without MANAGE_SERVER', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app).get('/api/v1/servers/srv-1/secure-channels/count');

      expect(res.status).toBe(403);
    });
  });

  // ── GET /:channelId/members ────────────────────────────────────────────

  describe('GET /:channelId/members', () => {
    it('returns the member list to a channel member', async () => {
      mockCallerMembership(false);

      const res = await request(app).get('/api/v1/servers/srv-1/secure-channels/sec-1/members');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({ userId: 'user-1', isCreator: true });
    });

    it('404 for a NON-member — indistinguishable from a nonexistent channel', async () => {
      mockCallerMembership(null);

      const memberRes = await request(app).get('/api/v1/servers/srv-1/secure-channels/sec-1/members');

      prismaMock.channel.findFirst.mockResolvedValue(null);
      const ghostRes = await request(app).get('/api/v1/servers/srv-1/secure-channels/ghost/members');

      expect(memberRes.status).toBe(404);
      expect(ghostRes.status).toBe(404);
      expect(memberRes.body.error).toBe(ghostRes.body.error);
    });
  });

  // ── POST /:channelId/members (invite) ──────────────────────────────────

  describe('POST /:channelId/members (invite)', () => {
    beforeEach(() => {
      mockCallerMembership(true);
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-9' });
      prismaMock.channelMember.count.mockResolvedValue(2);
      prismaMock.channelMember.create.mockResolvedValue({});
      prismaMock.channelRead.upsert.mockResolvedValue({});
      prismaMock.channel.findUniqueOrThrow.mockResolvedValue({ ...CH, type: 'text' });
      // Caller-membership gate resolves first, then the target lookup
      prismaMock.channelMember.findUnique
        .mockResolvedValueOnce({ isCreator: true }) // caller
        .mockResolvedValueOnce(null); // target not yet a member
    });

    it('creator invites a server member — events go to the invitee and the channel room', async () => {
      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels/sec-1/members')
        .send({ userId: 'user-9' });

      expect(res.status).toBe(201);
      expect(prismaMock.channelMember.create).toHaveBeenCalledWith({
        data: { channelId: 'sec-1', userId: 'user-9', isCreator: false },
      });
      // Unread starts at join point
      expect(prismaMock.channelRead.upsert).toHaveBeenCalled();
      const rooms = mockTo.mock.calls.map((c: any[]) => c[0]);
      expect(rooms).toContain('user:user-9');
      expect(rooms).toContain('channel:sec-1');
      expect(rooms.every((r: string) => !r.startsWith('server:'))).toBe(true);
      expect(mockIn).toHaveBeenCalledWith('user:user-9');
      expect(mockSocketsJoin).toHaveBeenCalledWith('channel:sec-1');
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.CHANNEL_MEMBERS_UPDATED,
        expect.objectContaining({ channelId: 'sec-1', serverId: 'srv-1' }),
      );
    });

    it('403 when a plain member tries to invite', async () => {
      prismaMock.channelMember.findUnique.mockReset();
      mockCallerMembership(false);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels/sec-1/members')
        .send({ userId: 'user-9' });

      expect(res.status).toBe(403);
      expect(prismaMock.channelMember.create).not.toHaveBeenCalled();
    });

    it('404 when the caller is not a channel member at all', async () => {
      prismaMock.channelMember.findUnique.mockReset();
      mockCallerMembership(null);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels/sec-1/members')
        .send({ userId: 'user-9' });

      expect(res.status).toBe(404);
    });

    it('400 when the target is not a server member', async () => {
      // First lookup = the CALLER's server membership (gate), second = target
      prismaMock.serverMember.findUnique
        .mockResolvedValueOnce({ userId: 'user-1' })
        .mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels/sec-1/members')
        .send({ userId: 'outsider' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('member of this server');
    });

    it('400 when the target is already a channel member', async () => {
      prismaMock.channelMember.findUnique.mockReset();
      prismaMock.channelMember.findUnique
        .mockResolvedValueOnce({ isCreator: true }) // caller
        .mockResolvedValueOnce({ userId: 'user-9' }); // target already in
      prismaMock.channel.findFirst.mockResolvedValue({
        id: CH.id, name: CH.name, serverId: CH.serverId, createdById: CH.createdById,
      });

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels/sec-1/members')
        .send({ userId: 'user-9' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already a member');
    });

    it('400 when the member cap is reached', async () => {
      prismaMock.channelMember.count.mockResolvedValue(E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP);

      const res = await request(app)
        .post('/api/v1/servers/srv-1/secure-channels/sec-1/members')
        .send({ userId: 'user-9' });

      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /:channelId/members/:userId ─────────────────────────────────

  describe('DELETE /:channelId/members/:userId', () => {
    beforeEach(() => {
      prismaMock.channelMember.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.channelRead.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.e2EKeyShare.deleteMany.mockResolvedValue({ count: 0 });
    });

    it('creator removes a member — rows deleted, removed user gets channel:deleted', async () => {
      prismaMock.channel.findFirst.mockResolvedValue({
        id: CH.id, name: CH.name, serverId: CH.serverId, createdById: 'user-1',
      });
      prismaMock.channelMember.findUnique
        .mockResolvedValueOnce({ isCreator: true }) // caller gate
        .mockResolvedValueOnce({ userId: 'user-2' }); // target row

      const res = await request(app).delete('/api/v1/servers/srv-1/secure-channels/sec-1/members/user-2');

      expect(res.status).toBe(200);
      expect(prismaMock.channelMember.deleteMany).toHaveBeenCalledWith({
        where: { channelId: 'sec-1', userId: 'user-2' },
      });
      expect(prismaMock.channelRead.deleteMany).toHaveBeenCalledWith({
        where: { channelId: 'sec-1', userId: 'user-2' },
      });
      const rooms = mockTo.mock.calls.map((c: any[]) => c[0]);
      expect(rooms).toContain('user:user-2');
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_DELETED, {
        channelId: 'sec-1', serverId: 'srv-1',
      });
      expect(mockIn).toHaveBeenCalledWith('user:user-2');
      expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-1');
      // Remaining members get the refreshed list
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.CHANNEL_MEMBERS_UPDATED,
        expect.objectContaining({ channelId: 'sec-1' }),
      );
    });

    it('a plain member can remove THEMSELVES (leave)', async () => {
      prismaMock.channel.findFirst.mockResolvedValue({
        id: CH.id, name: CH.name, serverId: CH.serverId, createdById: 'user-9',
      });
      prismaMock.channelMember.findUnique
        .mockResolvedValueOnce({ isCreator: false }) // caller gate
        .mockResolvedValueOnce({ userId: 'user-1' }); // own row

      const res = await request(app).delete('/api/v1/servers/srv-1/secure-channels/sec-1/members/user-1');

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Left channel');
    });

    it('403 when a plain member tries to remove someone else', async () => {
      prismaMock.channel.findFirst.mockResolvedValue({
        id: CH.id, name: CH.name, serverId: CH.serverId, createdById: 'user-9',
      });
      prismaMock.channelMember.findUnique.mockResolvedValueOnce({ isCreator: false });

      const res = await request(app).delete('/api/v1/servers/srv-1/secure-channels/sec-1/members/user-2');

      expect(res.status).toBe(403);
      expect(prismaMock.channelMember.deleteMany).not.toHaveBeenCalled();
    });

    it('400 when the creator tries to leave their own channel', async () => {
      prismaMock.channel.findFirst.mockResolvedValue({
        id: CH.id, name: CH.name, serverId: CH.serverId, createdById: 'user-1',
      });
      prismaMock.channelMember.findUnique.mockResolvedValueOnce({ isCreator: true });

      const res = await request(app).delete('/api/v1/servers/srv-1/secure-channels/sec-1/members/user-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('delete the channel');
    });
  });

  // ── PATCH /:channelId (rename) ─────────────────────────────────────────

  describe('PATCH /:channelId (rename)', () => {
    it('creator renames — CHANNEL_UPDATED goes to the channel room only', async () => {
      mockCallerMembership(true);
      prismaMock.channel.update.mockResolvedValue({ ...CH, name: 'renamed' });

      const res = await request(app)
        .patch('/api/v1/servers/srv-1/secure-channels/sec-1')
        .send({ name: 'renamed' });

      expect(res.status).toBe(200);
      const rooms = mockTo.mock.calls.map((c: any[]) => c[0]);
      expect(rooms).toEqual(['channel:sec-1']);
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_UPDATED, expect.objectContaining({ name: 'renamed' }));
    });

    it('403 for a plain member, 404 for a non-member', async () => {
      mockCallerMembership(false);
      const memberRes = await request(app)
        .patch('/api/v1/servers/srv-1/secure-channels/sec-1')
        .send({ name: 'renamed' });

      mockCallerMembership(null);
      const outsiderRes = await request(app)
        .patch('/api/v1/servers/srv-1/secure-channels/sec-1')
        .send({ name: 'renamed' });

      expect(memberRes.status).toBe(403);
      expect(outsiderRes.status).toBe(404);
      expect(prismaMock.channel.update).not.toHaveBeenCalled();
    });
  });
});
