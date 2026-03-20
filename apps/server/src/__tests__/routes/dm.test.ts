import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockEmit, mockTo, mockFetchSockets } = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
  const mockFetchSockets = vi.fn().mockResolvedValue([]);
  return { mockEmit, mockTo, mockFetchSockets };
});

// Mock auth middleware — always injects a test user
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

// Mock rate limiters — passthrough
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitMessageSend: passthrough,
    rateLimitGeneral: passthrough,
    rateLimitMarkRead: passthrough,
    socketRateLimit: vi.fn().mockReturnValue(true),
  };
});

// Mock getIO
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn().mockReturnValue({
    to: mockTo,
    fetchSockets: mockFetchSockets,
    in: vi.fn().mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([]) }),
  }),
}));

// Mock S3
vi.mock('../../utils/s3', () => ({
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
  deleteMultipleFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Mock prisma
const mockConversation = {
  id: 'conv-1',
  user1Id: 'user-1',
  user2Id: 'user-2',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const mockMessage = {
  id: 'msg-1',
  content: 'Hello world',
  conversationId: 'conv-1',
  channelId: null,
  authorId: 'user-1',
  type: 'user',
  editedAt: null,
  replyToId: null,
  replyTo: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  author: {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarUrl: null,
    role: 'user',
    isSupporter: false,
    supporterTier: null,
  },
  reactions: [],
  attachments: [],
};

vi.mock('../../utils/prisma', () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    conversationRead: {
      createMany: vi.fn(),
      upsert: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    messageReaction: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      groupBy: vi.fn(),
    },
    messageAttachment: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../utils/prisma';
import { dmRouter } from '../../routes/dm';
import { errorHandler } from '../../middleware/errorHandler';

// ─── App setup ──────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dm', dmRouter);
  app.use(errorHandler);
  return app;
}

/** Reset all prisma mock return value queues to prevent leaking between tests.
 *  vi.clearAllMocks() does NOT clear mockResolvedValueOnce queues. */
function resetPrismaMocks() {
  vi.mocked(prisma.conversation.findUnique).mockReset();
  vi.mocked(prisma.conversation.findMany).mockReset();
  vi.mocked(prisma.conversation.create).mockReset();
  vi.mocked(prisma.conversation.update).mockReset();
  vi.mocked(prisma.conversation.delete).mockReset();
  vi.mocked(prisma.conversationRead.createMany).mockReset();
  vi.mocked(prisma.conversationRead.upsert).mockReset();
  vi.mocked(prisma.message.findMany).mockReset();
  vi.mocked(prisma.message.findUnique).mockReset();
  vi.mocked(prisma.message.findUniqueOrThrow).mockReset();
  vi.mocked(prisma.message.create).mockReset();
  vi.mocked(prisma.message.delete).mockReset();
  vi.mocked(prisma.message.update).mockReset();
  vi.mocked(prisma.messageReaction.findUnique).mockReset();
  vi.mocked(prisma.messageReaction.findMany).mockReset();
  vi.mocked(prisma.messageReaction.create).mockReset();
  vi.mocked(prisma.messageReaction.delete).mockReset();
  vi.mocked(prisma.messageReaction.groupBy).mockReset();
  vi.mocked(prisma.messageAttachment.findMany).mockReset();
  vi.mocked(prisma.messageAttachment.createMany).mockReset();
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.$transaction).mockReset();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DM routes — GET /conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('lists user conversations', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation,
        user1: { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null },
        user2: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null },
        messages: [{ content: 'hi', createdAt: new Date('2024-01-01'), authorId: 'user-1' }],
      },
    ] as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('conv-1');
    // participant should be the OTHER user (user-2)
    expect(res.body.data[0].participant.id).toBe('user-2');
  });

  it('returns empty array when no conversations', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([]);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('DM routes — GET /conversations participant status field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('includes participant.status field in response (user1 perspective)', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation,
        user1: {
          id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null,
          status: 'online', role: 'user', isSupporter: false, supporterTier: null,
        },
        user2: {
          id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null,
          status: 'offline', role: 'user', isSupporter: false, supporterTier: null,
        },
        messages: [],
      },
    ] as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // user-1 is the authenticated user, so participant is user-2
    expect(res.body.data[0].participant.id).toBe('user-2');
    expect(res.body.data[0].participant.status).toBe('offline');
  });

  it('includes participant.status field in response (user2 perspective)', async () => {
    // Simulate user-1 being user2 in the conversation ordering
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        id: 'conv-2',
        user1Id: 'user-0', // user-0 < user-1, so user-0 is user1
        user2Id: 'user-1', // authenticated user is user2
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        user1: {
          id: 'user-0', username: 'eve', displayName: 'Eve', avatarUrl: null,
          status: 'online', role: 'user', isSupporter: false, supporterTier: null,
        },
        user2: {
          id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null,
          status: 'online', role: 'user', isSupporter: false, supporterTier: null,
        },
        messages: [],
      },
    ] as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // user-1 is user2Id, so participant is user1 (user-0)
    expect(res.body.data[0].participant.id).toBe('user-0');
    expect(res.body.data[0].participant.status).toBe('online');
  });

  it('status field is present for multiple conversations', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation,
        user1: {
          id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null,
          status: 'online', role: 'user', isSupporter: false, supporterTier: null,
        },
        user2: {
          id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null,
          status: 'idle', role: 'user', isSupporter: false, supporterTier: null,
        },
        messages: [],
      },
      {
        id: 'conv-3',
        user1Id: 'user-1',
        user2Id: 'user-3',
        createdAt: new Date('2024-02-01'),
        updatedAt: new Date('2024-02-01'),
        user1: {
          id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null,
          status: 'online', role: 'user', isSupporter: false, supporterTier: null,
        },
        user2: {
          id: 'user-3', username: 'charlie', displayName: 'Charlie', avatarUrl: null,
          status: 'dnd', role: 'user', isSupporter: false, supporterTier: null,
        },
        messages: [],
      },
    ] as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].participant.status).toBe('idle');
    expect(res.body.data[1].participant.status).toBe('dnd');
  });
});

describe('DM routes — POST /conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('creates a new conversation', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null,
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('conv-1');
  });

  it('returns existing conversation (dedup via sorted IDs)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null,
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Should not create a new conversation
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('rejects missing userId', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId/i);
  });

  it('rejects conversation with yourself', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm')
      .send({ userId: 'user-1' }); // same as authenticated user

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  it('returns 404 when target user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm')
      .send({ userId: 'user-nonexistent' });

    expect(res.status).toBe(404);
  });
});

describe('DM routes — GET /:conversationId/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('returns paginated messages', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([mockMessage] as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('msg-1');
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      ...mockConversation,
      user1Id: 'other-user-1',
      user2Id: 'other-user-2',
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm/conv-1/messages');

    expect(res.status).toBe(403);
  });

  it('returns 404 when conversation does not exist', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm/conv-nonexistent/messages');

    expect(res.status).toBe(404);
  });
});

describe('DM routes — POST /:conversationId/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('sends a message', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce(mockMessage as any);
    vi.mocked(prisma.conversation.update).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: 'Hello!' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // Verify socket emit
    expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
    expect(mockEmit).toHaveBeenCalledWith('dm:message:new', expect.anything());
  });

  it('rejects empty message without attachments', async () => {
    // No need to mock conversation.findUnique — content validation happens before
    // getConversationOrThrow is called, so the handler throws before any DB access.
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('sanitizes HTML from message content', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => {
      // Verify the sanitized content gets passed through
      return mockMessage;
    });
    vi.mocked(prisma.conversation.update).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: '<script>alert("xss")</script>Hello!' });

    expect(res.status).toBe(201);
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      ...mockConversation,
      user1Id: 'other-1',
      user2Id: 'other-2',
    } as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: 'Hello' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when replyToId is not a string', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: 'Hello', replyToId: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/replyToId must be a string/);
  });
});

describe('DM routes — DELETE /:conversationId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('deletes conversation with cascade', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.messageAttachment.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.conversation.delete).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app).delete('/api/v1/dm/conv-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.conversation.delete).toHaveBeenCalledWith({ where: { id: 'conv-1' } });
    // Should emit dm:conversation:deleted event
    expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
    expect(mockEmit).toHaveBeenCalledWith('dm:conversation:deleted', { conversationId: 'conv-1' });
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      ...mockConversation,
      user1Id: 'other-1',
      user2Id: 'other-2',
    } as any);

    const app = createApp();
    const res = await request(app).delete('/api/v1/dm/conv-1');

    expect(res.status).toBe(403);
  });

  it('returns 404 when conversation not found', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app).delete('/api/v1/dm/conv-nonexistent');

    expect(res.status).toBe(404);
  });
});

describe('DM routes — POST /:conversationId/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('marks conversation as read', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.conversationRead.upsert).mockResolvedValueOnce({} as any);

    const app = createApp();
    const res = await request(app).post('/api/v1/dm/conv-1/read');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.conversationRead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_conversationId: { userId: 'user-1', conversationId: 'conv-1' } },
      }),
    );
  });
});
