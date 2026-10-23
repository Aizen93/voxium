import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { buildMegolmEnvelope, E2E_ATTACHMENT_MIME, E2E_ATTACHMENT_NAME, Permissions } from '@voxium/shared';
import { extractMentionIds, batchResolveMentions, attachMentions, resolveMentionsForServer } from '../../utils/mentions';

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
    deleteMany: vi.fn(),
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
    rateLimitInteract: passthrough,
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
    emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
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

    it('returns 404 when the author can no longer VIEW the channel (revoked access / removed from secure channel)', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage());
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
      mockHasChannelPermission.mockResolvedValue(false);

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Edited message' });

      expect(res.status).toBe(404);
      expect(prismaMock.message.update).not.toHaveBeenCalled();
    });

    it('refuses to edit a system message', async () => {
      // System rows ("X joined the server") are authored by a real user, so
      // the ownership check passes for them. Rewriting one would put arbitrary
      // text on screen with system styling — words the app appears to be
      // saying itself.
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage({ type: 'system' }));

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'never happened' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/system messages cannot be edited/i);
      expect(prismaMock.message.update).not.toHaveBeenCalled();
    });

    it('returns 400 with empty content', async () => {
      const token = makeToken();
      // Content validation now runs AFTER the message fetch (the secure branch
      // needs channel.secure before deciding how to treat req.body.content)
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage());
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });

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

  // ── PUT /api/v1/channels/:channelId/messages/:messageId/reactions/:emoji ──

  describe('PUT /api/v1/channels/:channelId/messages/:messageId/reactions/:emoji', () => {
    const EMOJI = '👍';
    const reactionUrl = `/api/v1/channels/ch-1/messages/msg-1/reactions/${encodeURIComponent(EMOJI)}`;

    function mockReactableMessage() {
      prismaMock.message.findUnique.mockResolvedValue({
        id: 'msg-1',
        channelId: 'ch-1',
        channel: { serverId: 'srv-1' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
    }

    it('adds a reaction and responds with action "add"', async () => {
      const token = makeToken();
      mockReactableMessage();
      prismaMock.messageReaction.findUnique.mockResolvedValue(null);
      prismaMock.messageReaction.groupBy.mockResolvedValue([]);
      prismaMock.messageReaction.create.mockResolvedValue({});
      prismaMock.messageReaction.findMany.mockResolvedValue([{ emoji: EMOJI, userId: 'user-1' }]);

      const res = await request(app)
        .put(reactionUrl)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.action).toBe('add');
    });

    it('race idempotency: responds 200 with action "add" when create rejects with P2002 (concurrent duplicate)', async () => {
      const token = makeToken();
      mockReactableMessage();
      prismaMock.messageReaction.findUnique.mockResolvedValue(null);
      prismaMock.messageReaction.groupBy.mockResolvedValue([]);
      // The losing half of a double-click race: unique constraint violation
      prismaMock.messageReaction.create.mockRejectedValue({ code: 'P2002' });
      prismaMock.messageReaction.findMany.mockResolvedValue([{ emoji: EMOJI, userId: 'user-1' }]);

      const res = await request(app)
        .put(reactionUrl)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.action).toBe('add');
    });

    it('non-P2002 create errors still fail the request', async () => {
      const token = makeToken();
      mockReactableMessage();
      prismaMock.messageReaction.findUnique.mockResolvedValue(null);
      prismaMock.messageReaction.groupBy.mockResolvedValue([]);
      prismaMock.messageReaction.create.mockRejectedValue(new Error('connection lost'));

      const res = await request(app)
        .put(reactionUrl)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });

    it('removes an existing reaction via deleteMany (idempotent) and responds with action "remove"', async () => {
      const token = makeToken();
      mockReactableMessage();
      prismaMock.messageReaction.findUnique.mockResolvedValue({
        messageId: 'msg-1',
        userId: 'user-1',
        emoji: EMOJI,
      });
      prismaMock.messageReaction.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.messageReaction.findMany.mockResolvedValue([]);

      const res = await request(app)
        .put(reactionUrl)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.action).toBe('remove');
      // deleteMany (not delete) — a concurrent remove that already deleted the
      // row must not 500 with P2025
      expect(prismaMock.messageReaction.deleteMany).toHaveBeenCalledWith({
        where: { messageId: 'msg-1', userId: 'user-1', emoji: EMOJI },
      });
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
      // Can VIEW the channel (first check), but no MANAGE_MESSAGES (second)
      mockHasChannelPermission
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns 404 when the author can no longer VIEW the channel (removed from a secure channel)', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ channelId: 'sec-1', channel: { serverId: 'srv-1', secure: true } }),
      );
      mockHasChannelPermission.mockResolvedValue(false); // no VIEW → 404, opaque

      const res = await request(app)
        .delete('/api/v1/channels/sec-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(prismaMock.message.delete).not.toHaveBeenCalled();
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

  // ── SECURE channels: encrypted-only enforcement ────────────────────────

  describe('secure channels — encrypted-only enforcement', () => {
    const ENVELOPE = buildMegolmEnvelope('sessAbc123', 'Y2lwaGVydGV4dA');

    function mockSecureChannel() {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'sec-1',
        serverId: 'srv-1',
        type: 'text',
        name: 'covert',
        secure: true,
        server: { name: 'Test Server' },
      });
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        serverId: 'srv-1',
        role: 'member',
      });
    }

    function mockTxCapture() {
      const create = vi.fn().mockResolvedValue({ id: 'msg-1' });
      const createManyAttachments = vi.fn().mockResolvedValue({ count: 1 });
      prismaMock.$transaction.mockImplementation(async (cb: Function) =>
        cb({
          message: {
            create,
            findUniqueOrThrow: vi.fn().mockResolvedValue(
              makeMockMessage({ channelId: 'sec-1', encrypted: true, content: ENVELOPE }),
            ),
          },
          messageAttachment: { createMany: createManyAttachments },
        }),
      );
      return { create, createManyAttachments };
    }

    it('rejects a plaintext send with a hard 400 (no silent downgrade)', async () => {
      const token = makeToken();
      mockSecureChannel();

      const res = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'hello in the clear' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('end-to-end encrypted');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('a NON-member probing POST gets the nonexistent-channel 404, never the encrypted 400', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'sec-1', serverId: 'srv-1', type: 'text', name: 'covert',
        secure: true, server: { name: 'Test Server' },
      });
      // Not a server member at all — the secure-flag branch must be unreachable
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const nonMember = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'probe' });
      expect(nonMember.status).toBe(404);
      expect(nonMember.body.error).not.toContain('encrypted');

      // Server member without channel membership (owner/ADMIN included): same 404
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1' });
      mockHasChannelPermission.mockResolvedValue(false);
      const serverMember = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'probe' });
      expect(serverMember.status).toBe(404);
      expect(serverMember.body.error).not.toContain('encrypted');
    });

    it('a NON-member fetching GET messages gets the nonexistent-channel 404', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({ serverId: 'srv-1', secure: true });
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1' });
      mockHasChannelPermission.mockResolvedValue(false); // no VIEW → opaque

      const res = await request(app)
        .get('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('rejects encrypted:true with a malformed envelope', async () => {
      const token = makeToken();
      mockSecureChannel();

      const res = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '{"v":1,"garbage":true}', encrypted: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('envelope');
    });

    it('stores a valid envelope VERBATIM with encrypted:true and resolves no mentions', async () => {
      const token = makeToken();
      mockSecureChannel();
      const { create } = mockTxCapture();

      const res = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: ENVELOPE, encrypted: true });

      expect(res.status).toBe(201);
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ content: ENVELOPE, encrypted: true }),
      });
      // Ciphertext is never mention-parsed
      expect(vi.mocked(extractMentionIds)).not.toHaveBeenCalled();
      // Broadcast still goes to the channel room (its membership = channel members)
      expect(mockTo).toHaveBeenCalledWith('channel:sec-1');
    });

    it('rejects encrypted:true in a PLAINTEXT channel', async () => {
      const token = makeToken();
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1', serverId: 'srv-1', type: 'text', name: 'general',
        secure: false, server: { name: 'Test Server' },
      });

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: ENVELOPE, encrypted: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('secure channels');
    });

    it('rejects non-opaque attachments and forces the stored fileName for valid ones', async () => {
      const token = makeToken();
      mockSecureChannel();

      // Non-opaque mime → rejected
      let res = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({
          content: ENVELOPE,
          encrypted: true,
          attachments: [{ s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin', fileSize: 1024, mimeType: 'image/png' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('opaque');

      // Valid opaque blob → accepted, fileName forced server-side
      const { createManyAttachments } = mockTxCapture();
      res = await request(app)
        .post('/api/v1/channels/sec-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({
          content: ENVELOPE,
          encrypted: true,
          attachments: [{
            s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin',
            fileName: 'real-secret-name.pdf', // must be discarded
            fileSize: 1024,
            mimeType: E2E_ATTACHMENT_MIME,
          }],
        });
      expect(res.status).toBe(201);
      expect(createManyAttachments).toHaveBeenCalledWith({
        data: [expect.objectContaining({ fileName: E2E_ATTACHMENT_NAME })],
      });
    });

    it('secure edits must be fresh ciphertexts (plaintext edit → 400, envelope edit stored verbatim)', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(
        makeMockMessage({ channelId: 'sec-1', encrypted: true, channel: { serverId: 'srv-1', secure: true } }),
      );
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user-1', serverId: 'srv-1', role: 'member',
      });

      let res = await request(app)
        .patch('/api/v1/channels/sec-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'plaintext edit' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('end-to-end encrypted');

      prismaMock.message.update.mockResolvedValue(
        makeMockMessage({
          channelId: 'sec-1', encrypted: true, content: ENVELOPE,
          editedAt: new Date(), channel: { serverId: 'srv-1', secure: true },
        }),
      );
      res = await request(app)
        .patch('/api/v1/channels/sec-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: ENVELOPE, encrypted: true });
      expect(res.status).toBe(200);
      expect(prismaMock.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ content: ENVELOPE }),
        }),
      );
    });
  });

  // ── Incoming webhooks: authorless rows ─────────────────────────────────
  // A webhook-posted row has author === null plus webhookId/webhookName. The
  // wire keeps a non-null author (synthesised, isWebhook: true) and the row
  // never resolves mentions: an unauthenticated URL must never ping anyone.

  describe('webhook-authored rows', () => {
    const webhookAuthor = { id: 'webhook:wh-1', username: 'CI', displayName: 'CI', avatarUrl: null, isWebhook: true };
    const user2 = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null };

    function makeWebhookMessage(overrides: Record<string, unknown> = {}) {
      return makeMockMessage({
        authorId: null,
        author: null,
        webhookId: 'wh-1',
        webhookName: 'CI',
        content: 'Build failed, ping @[user-2]',
        ...overrides,
      });
    }

    beforeEach(async () => {
      // Run the REAL batch resolver/attacher for these tests (the module is
      // mocked file-wide); prisma.serverMember.findMany is the mocked query
      const actual = await vi.importActual<typeof import('../../utils/mentions')>('../../utils/mentions');
      vi.mocked(batchResolveMentions).mockImplementation(actual.batchResolveMentions);
      vi.mocked(attachMentions).mockImplementation(actual.attachMentions);
      prismaMock.channel.findUnique.mockResolvedValue({ id: 'ch-1', serverId: 'srv-1', type: 'text', secure: false });
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user-1', serverId: 'srv-1', role: 'member' });
      prismaMock.serverMember.findMany.mockResolvedValue([{ user: user2 }]);
    });

    afterEach(() => {
      // back to the file-wide defaults so later tests see the plain mocks
      vi.mocked(batchResolveMentions).mockResolvedValue(new Map());
      vi.mocked(attachMentions).mockReturnValue([]);
      vi.mocked(extractMentionIds).mockReturnValue([]);
    });

    it('DELETE: a plain member is not the author of a webhook row (authorId null) and gets the 403; nothing deleted, nothing emitted', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeWebhookMessage());
      mockHasChannelPermission.mockImplementation(async (...args: unknown[]) => args[3] !== Permissions.MANAGE_MESSAGES);

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You can only delete your own messages');
      expect(prismaMock.message.delete).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalledWith('message:delete', expect.anything());
    });

    it('DELETE: MANAGE_MESSAGES deletes a webhook row (the only way to remove one post) and emits message:delete', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeWebhookMessage());
      prismaMock.message.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(prismaMock.message.delete).toHaveBeenCalledWith({ where: { id: 'msg-1' } });
      expect(mockEmit).toHaveBeenCalledWith('message:delete', expect.anything());
    });

    it('GET (standard page): synthesises the author and resolves no mentions for a webhook row, while a human row on the same page still does', async () => {
      const token = makeToken();
      // findMany is newest-first; the route reverses it
      prismaMock.message.findMany.mockResolvedValue([
        makeMockMessage({ id: 'msg-human', content: 'hey @[user-2]', webhookId: null, webhookName: null }),
        makeWebhookMessage({ id: 'msg-hook' }),
      ]);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const hook = res.body.data.find((m: { id: string }) => m.id === 'msg-hook');
      const human = res.body.data.find((m: { id: string }) => m.id === 'msg-human');
      expect(hook.author).toEqual(webhookAuthor);
      expect(hook.webhookId).toBe('wh-1');
      expect(hook.mentions).toEqual([]);
      expect(human.author).toEqual(mockAuthor);
      expect(human.mentions).toEqual([user2]);
      // the quoted-author select carries what the shape needs
      expect(prismaMock.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
        include: expect.objectContaining({
          replyTo: { select: expect.objectContaining({ webhookId: true, webhookName: true, author: expect.any(Object) }) },
        }),
      }));
    });

    it('GET (standard page): a page of webhook rows only never queries members at all', async () => {
      const token = makeToken();
      prismaMock.message.findMany.mockResolvedValue([makeWebhookMessage({ id: 'a' }), makeWebhookMessage({ id: 'b' })]);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.map((m: { mentions: unknown[] }) => m.mentions)).toEqual([[], []]);
      expect(prismaMock.serverMember.findMany).not.toHaveBeenCalled();
    });

    it('GET (around mode): synthesises the author and resolves no mentions for a webhook row', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue({ id: 'msg-hook', channelId: 'ch-1', createdAt: new Date('2024-01-01') });
      prismaMock.message.findMany
        .mockResolvedValueOnce([makeWebhookMessage({ id: 'msg-hook' })]) // older, incl. the target
        .mockResolvedValueOnce([makeMockMessage({ id: 'msg-after', content: '@[user-2] look', webhookId: null, webhookName: null })]);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages?around=msg-hook')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.targetMessageId).toBe('msg-hook');
      const hook = res.body.data.find((m: { id: string }) => m.id === 'msg-hook');
      const after = res.body.data.find((m: { id: string }) => m.id === 'msg-after');
      expect(hook.author).toEqual(webhookAuthor);
      expect(hook.mentions).toEqual([]);
      expect(after.mentions).toEqual([user2]);
    });

    it('GET: a deleted webhook (webhookId SET NULL) still renders under its frozen name as webhook:deleted', async () => {
      const token = makeToken();
      prismaMock.message.findMany.mockResolvedValue([makeWebhookMessage({ id: 'old', webhookId: null, webhookName: 'Old bot' })]);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].author).toEqual({
        id: 'webhook:deleted', username: 'Old bot', displayName: 'Old bot', avatarUrl: null, isWebhook: true,
      });
      expect(res.body.data[0].mentions).toEqual([]);
    });

    it('GET: a human reply quoting a webhook message carries a synthesised replyTo.author', async () => {
      const token = makeToken();
      prismaMock.message.findMany.mockResolvedValue([
        makeMockMessage({
          id: 'msg-reply',
          webhookId: null,
          webhookName: null,
          replyToId: 'msg-hook',
          replyTo: { id: 'msg-hook', content: 'Deploy failed', author: null, webhookId: 'wh-1', webhookName: 'CI' },
        }),
      ]);

      const res = await request(app)
        .get('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].author).toEqual(mockAuthor);
      expect(res.body.data[0].replyTo.author).toEqual(webhookAuthor);
    });

    function mockSendChannel() {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1', serverId: 'srv-1', type: 'text', name: 'general', secure: false, server: { name: 'Test Server' },
      });
    }

    function mockCreatedRow(row: Record<string, unknown>) {
      prismaMock.$transaction.mockImplementation(async (cb: Function) => cb({
        message: {
          create: vi.fn().mockResolvedValue({ id: row.id }),
          findUniqueOrThrow: vi.fn().mockResolvedValue(row),
        },
        messageAttachment: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }));
    }

    it('POST: a reply quoting a webhook message comes back (response AND message:new) with a synthesised replyTo.author', async () => {
      const token = makeToken();
      mockSendChannel();
      prismaMock.message.findUnique.mockResolvedValue({ channelId: 'ch-1' }); // the replyToId check
      mockCreatedRow(makeMockMessage({
        id: 'msg-reply',
        content: 'on it',
        webhookId: null,
        webhookName: null,
        replyToId: 'msg-hook',
        replyTo: { id: 'msg-hook', content: 'Deploy failed', author: null, webhookId: 'wh-1', webhookName: 'CI' },
      }));

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'on it', replyToId: 'msg-hook' });

      expect(res.status).toBe(201);
      expect(res.body.data.author).toEqual(mockAuthor);
      expect(res.body.data.replyTo.author).toEqual(webhookAuthor);
      const emitted = mockEmit.mock.calls.find((c) => c[0] === 'message:new')![1];
      expect(emitted.replyTo.author).toEqual(webhookAuthor);
    });

    it('POST: never resolves mentions for a row carrying a webhookId (defence in depth)', async () => {
      const token = makeToken();
      mockSendChannel();
      vi.mocked(extractMentionIds).mockReturnValue(['user-2']);
      mockCreatedRow(makeWebhookMessage({ id: 'msg-hook' }));

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Build failed, ping @[user-2]' });

      expect(res.status).toBe(201);
      expect(resolveMentionsForServer).toHaveBeenCalledWith([], 'srv-1');
      expect(res.body.data.author).toEqual(webhookAuthor);
      const emitted = mockEmit.mock.calls.find((c) => c[0] === 'message:new')![1];
      expect(emitted.author).toEqual(webhookAuthor);
    });

    it('POST: a human row still resolves its mentions (the skip is keyed on isWebhookRow: webhookId, webhookName or a null authorId)', async () => {
      const token = makeToken();
      mockSendChannel();
      vi.mocked(extractMentionIds).mockReturnValue(['user-2']);
      mockCreatedRow(makeMockMessage({ id: 'msg-human', content: 'hey @[user-2]', webhookId: null, webhookName: null }));

      const res = await request(app)
        .post('/api/v1/channels/ch-1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'hey @[user-2]' });

      expect(res.status).toBe(201);
      expect(resolveMentionsForServer).toHaveBeenCalledWith(['user-2'], 'srv-1');
    });

    it('PATCH: a webhook row is nobody\'s to edit (authorId null never matches the caller)', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeWebhookMessage({ channel: { serverId: 'srv-1', secure: false } }));

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'rewritten' });

      expect(res.status).toBe(403);
      expect(prismaMock.message.update).not.toHaveBeenCalled();
    });

    it('PATCH: an edited human reply quoting a webhook message carries a synthesised replyTo.author', async () => {
      const token = makeToken();
      prismaMock.message.findUnique.mockResolvedValue(makeMockMessage({ channel: { serverId: 'srv-1', secure: false } }));
      prismaMock.message.update.mockResolvedValue(makeMockMessage({
        content: 'edited',
        editedAt: new Date(),
        webhookId: null,
        webhookName: null,
        replyTo: { id: 'msg-hook', content: 'Deploy failed', author: null, webhookId: 'wh-1', webhookName: 'CI' },
      }));

      const res = await request(app)
        .patch('/api/v1/channels/ch-1/messages/msg-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'edited' });

      expect(res.status).toBe(200);
      expect(res.body.data.replyTo.author).toEqual(webhookAuthor);
      const emitted = mockEmit.mock.calls.find((c) => c[0] === 'message:update')![1];
      expect(emitted.replyTo.author).toEqual(webhookAuthor);
    });
  });
});
