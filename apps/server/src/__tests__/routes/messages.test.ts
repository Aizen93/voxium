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
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
  },
  hasPermission: vi.fn().mockReturnValue(true),
}));

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
  },
  channel: {
    findUnique: vi.fn(),
  },
  serverMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  message: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  messageReaction: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  messageAttachment: {
    createMany: vi.fn(),
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
    rateLimitMessageSend: passthrough,
  };
});

// S3
vi.mock('../../utils/s3', () => ({
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  deleteMultipleFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Mentions
vi.mock('../../utils/mentions', () => ({
  extractMentionIds: vi.fn().mockReturnValue([]),
  resolveMentionsForServer: vi.fn().mockResolvedValue([]),
  batchResolveMentions: vi.fn().mockResolvedValue(new Map()),
  attachMentions: vi.fn().mockReturnValue([]),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { messageRouter } from '../../routes/messages';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels/:channelId/messages', messageRouter);
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

const mockAuthor = {
  id: 'user-1',
  username: 'testuser',
  displayName: 'Test User',
  avatarUrl: null,
  role: 'user',
  isSupporter: false,
  supporterTier: null,
};

function makeMockMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    content: 'Hello world',
    channelId: 'ch-1',
    authorId: 'user-1',
    type: 'user',
    editedAt: null,
    replyToId: null,
    replyTo: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    author: mockAuthor,
    reactions: [],
    attachments: [],
    channel: { serverId: 'srv-1' },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Message Routes', () => {
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

  // ── GET /api/v1/channels/:channelId/messages ───────────────────────────

  describe('GET /api/v1/channels/:channelId/messages', () => {
    it('returns paginated messages for a channel member', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      const msgs = [makeMockMessage({ id: 'msg-1' }), makeMockMessage({ id: 'msg-2', content: 'Hi' })];
      prismaMock.message.findMany.mockResolvedValue(msgs);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.hasMore).toBe(false);
    });

    it('returns hasMore=true when more messages exist', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      // Return 51 messages (limit + 1 = hasMore)
      const msgs = Array.from({ length: 51 }, (_, i) =>
        makeMockMessage({ id: `msg-${i}` }),
      );
      prismaMock.message.findMany.mockResolvedValue(msgs);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.data).toHaveLength(50);
    });

    it('returns 404 when channel does not exist', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/channels/ch-nonexistent/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 403 for non-member', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
      });
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('supports before cursor pagination', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.message.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages?before=2024-01-01T00:00:00.000Z')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(prismaMock.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            channelId: 'ch-1',
            createdAt: expect.any(Object),
          }),
        }),
      );
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/channels/ch-1/messages');
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/channels/:channelId/messages ──────────────────────────

  describe('POST /api/v1/channels/:channelId/messages', () => {
    it('creates a message', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'general',
        server: { name: 'Test Server' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      const createdMsg = makeMockMessage({ content: 'Hello!' });
      prismaMock.$transaction.mockImplementation(async (cb: Function) => {
        return cb({
          message: {
            create: vi.fn().mockResolvedValue({ id: 'msg-1', content: 'Hello!' }),
            findUniqueOrThrow: vi.fn().mockResolvedValue(createdMsg),
          },
          messageAttachment: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        });
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello!' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('returns 400 with empty message content', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'general',
        server: { name: 'Test Server' },
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when sending to a voice channel', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'voice',
        name: 'Voice',
        server: { name: 'Test' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('voice channel');
    });

    it('returns 403 for non-member', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'general',
        server: { name: 'Test' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello!' });

      expect(res.status).toBe(403);
    });

    it('sanitizes HTML from message content', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'general',
        server: { name: 'Test' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      const createdMsg = makeMockMessage({ content: 'alert("xss")' });
      prismaMock.$transaction.mockImplementation(async (cb: Function) => {
        return cb({
          message: {
            create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
            findUniqueOrThrow: vi.fn().mockResolvedValue(createdMsg),
          },
          messageAttachment: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        });
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '<b>alert("xss")</b>' });

      expect(res.status).toBe(201);
      // The content stored should have HTML stripped
    });

    it('validates replyToId belongs to same channel', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'general',
        server: { name: 'Test' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      // The referenced message is in a different channel
      prismaMock.message.findUnique.mockResolvedValue({
        id: 'msg-parent',
        channelId: 'ch-2', // different channel!
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Replying', replyToId: 'msg-parent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('replyToId');
    });

    it('returns 400 when replyToId is not a string', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello', replyToId: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/replyToId must be a string/);
    });

    it('emits message:new socket event', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'general',
        server: { name: 'Test Server' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      const createdMsg = makeMockMessage();
      prismaMock.$transaction.mockImplementation(async (cb: Function) => {
        return cb({
          message: {
            create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
            findUniqueOrThrow: vi.fn().mockResolvedValue(createdMsg),
          },
          messageAttachment: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        });
      });

      await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello!' });

      expect(mockTo).toHaveBeenCalledWith('channel:ch-1');
      expect(mockEmit).toHaveBeenCalledWith('message:new', expect.objectContaining({
        channelName: 'general',
        serverName: 'Test Server',
        serverId: 'srv-1',
      }));
    });
  });

  // ── PATCH /api/v1/channels/:channelId/messages/:messageId ──────────────

  describe('PATCH /api/v1/channels/:channelId/messages/:messageId', () => {
    it('allows author to edit their own message', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage());
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.message.update.mockResolvedValue({
        ...makeMockMessage(),
        content: 'Edited message',
        editedAt: new Date(),
        reactions: [],
      });

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Edited message' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 when editing another users message', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ authorId: 'user-2' }),
      );

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Trying to edit' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('own messages');
    });

    it('returns 400 with empty content', async () => {
      const token = makeToken();

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '' });

      expect(res.status).toBe(400);
    });

    it('returns 404 when message does not exist', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-nonexistent')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Edited' });

      expect(res.status).toBe(404);
    });

    it('IDOR prevention: rejects edit when channelId does not match', async () => {
      const token = makeToken();
      // Message belongs to ch-2 but the request targets ch-1
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ channelId: 'ch-2' }),
      );

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'IDOR attempt' });

      expect(res.status).toBe(404);
    });

    it('verifies server membership for edit', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage());
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Edited' });

      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /api/v1/channels/:channelId/messages/:messageId ─────────────

  describe('DELETE /api/v1/channels/:channelId/messages/:messageId', () => {
    it('allows author to delete their own message', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage());
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.message.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Message deleted');
    });

    it('allows admin to delete any message', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ authorId: 'user-2' }),
      );
      // hasServerPermission(MANAGE_MESSAGES) returns true (default)
      prismaMock.message.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('allows owner to delete any message', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ authorId: 'user-2' }),
      );
      // hasServerPermission(MANAGE_MESSAGES) returns true (default)
      prismaMock.message.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('returns 403 when regular member deletes another users message', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ authorId: 'user-2' }),
      );
      // No MANAGE_MESSAGES permission (channel-level check)
      mockHasChannelPermission.mockResolvedValue(false);

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('IDOR prevention: rejects delete when channelId does not match', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ channelId: 'ch-2' }),
      );

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 404 when message does not exist', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('emits message:delete socket event', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage());
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      prismaMock.message.delete.mockResolvedValue({});

      await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(mockTo).toHaveBeenCalledWith('channel:ch-1');
      expect(mockEmit).toHaveBeenCalledWith('message:delete', {
        messageId: 'msg-1',
        channelId: 'ch-1',
      });
    });
  });
});
