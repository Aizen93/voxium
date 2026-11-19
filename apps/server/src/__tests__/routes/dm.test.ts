import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockEmit, mockTo, mockFetchSockets, mockIn, mockLocalIn, mockSocketsJoin, mockSocketsLeave, mockLocalSocketsLeave,
} = vi.hoisted(() => {
  const mockEmit = vi.fn();
  // `except`: a message event skips a side whose floor hides the row
  // (routes/dm.ts roomOfViewers; its audiences are tested in dmRemovalForOneSide.test.ts)
  const mockTo = vi.fn().mockReturnValue({ emit: mockEmit, except: vi.fn().mockReturnValue({ emit: mockEmit }) });
  // fetchSockets stays reachable on every operator so a regression to it is an
  // explicit assertion failure, not a TypeError
  const mockFetchSockets = vi.fn().mockResolvedValue([]);
  const mockSocketsJoin = vi.fn();
  const mockSocketsLeave = vi.fn();
  const mockLocalSocketsLeave = vi.fn();
  const mockIn = vi.fn().mockReturnValue({ fetchSockets: mockFetchSockets, socketsJoin: mockSocketsJoin, socketsLeave: mockSocketsLeave });
  const mockLocalIn = vi.fn().mockReturnValue({ fetchSockets: mockFetchSockets, socketsLeave: mockLocalSocketsLeave });
  return { mockEmit, mockTo, mockFetchSockets, mockIn, mockLocalIn, mockSocketsJoin, mockSocketsLeave, mockLocalSocketsLeave };
});

// Mock auth middleware — always injects a test user
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
  requireConsent: (_req: any, _res: any, next: any) => next(),
}));

// Mock rate limiters — passthrough
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitMessageSend: passthrough,
    rateLimitGeneral: passthrough,
    rateLimitDmOpen: passthrough,
    rateLimitInteract: passthrough,
    rateLimitMarkRead: passthrough,
    socketRateLimit: vi.fn().mockReturnValue(true),
  };
});

// Mock getIO
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn().mockReturnValue({
    to: mockTo,
    fetchSockets: mockFetchSockets,
    in: mockIn,
    local: { in: mockLocalIn },
  }),
}));

// The DM call teardown (its own suite is websocket/dmVoiceHandler.test.ts):
// the conversation delete ends a call in progress through it
const mockEndDMCall = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../../websocket/dmVoiceHandler', () => ({
  endDMCall: (...args: unknown[]) => mockEndDMCall(...args),
  endDMCallIfParticipant: vi.fn().mockResolvedValue([]),
}));

// The conversation-row-locked transactions (their own suite is
// utils/conversationLifecycle.test.ts; the removal and reopen routes are in
// dmRemovalForOneSide.test.ts). A message write runs `write` inside the
// mocked `prisma.$transaction`, as the real one does inside its transaction,
// with the context it would read under the lock.
const SEND_AT = vi.hoisted(() => new Date('2026-11-16T12:00:00.000Z'));
vi.mock('../../utils/conversationLifecycle', async () => {
  const { prisma: client } = await import('../../utils/prisma');
  return {
    writeConversationMessage: vi.fn(async (_conversationId: string, _authorId: string, write: (tx: unknown, ctx: unknown) => Promise<unknown>, announce: (m: unknown, audience: unknown[]) => void) => {
      const context = { createdAt: SEND_AT, sides: [], authorFloor: null };
      const message = await client.$transaction((tx: unknown) => write(tx, context));
      // the event, to the audience read after the commit (nobody cleared anything here)
      announce(message, []);
      return { message, context };
    }),
    removeConversationForUser: vi.fn(),
    reopenConversationForUser: vi.fn().mockResolvedValue('reopened'),
    // An edit, a reaction, a delete: the write on the transaction's client
    // (here the mocked one), under the conversation row lock whose checks
    // are tested in utils/conversationLifecycle.test.ts
    changeConversationMessage: vi.fn(async (_conversationId: string, _userId: string, _opts: unknown, act: (tx: unknown, view: unknown) => unknown) => act(client, {})),
  };
});

// Mock S3
vi.mock('../../utils/s3', () => ({
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
  deleteMultipleFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Upload read-back (its own unit tests cover the S3 side)
const mockVerifyAttachmentUploads = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../utils/uploadVerification', () => ({
  verifyAttachmentUploads: (...args: unknown[]) => mockVerifyAttachmentUploads(...args),
}));

// Mock prisma
const mockConversation = {
  id: 'conv-1',
  user1Id: 'user-1',
  user2Id: 'user-2',
  // NOT NULL since the always-on cutover (migration 20260801140000_e2e_always_on):
  // a conversation is born encrypted, so every row the routes ever read has it set.
  encryptedAt: new Date('2026-08-01T14:00:00Z'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  // the read rows every view loads with the sides (utils/conversationVisibility.ts);
  // none: nobody removed it, no floor
  reads: [],
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

/** A structurally valid olm1 envelope (content validation is structural only). */
const validEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'QWJjZGVmZ2hpamtsbW5vcA' });
/** …and the multi-device megolm1 variant — both engines are valid on the wire. */
const validMegolmEnvelope = JSON.stringify({ v: 1, e: 'megolm1', sid: 'c2Vzc2lvbklk', b: 'QWJjZGVmZ2hpamtsbW5vcA' });

vi.mock('../../utils/prisma', () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    e2EDevice: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    conversationRead: {
      createMany: vi.fn(),
      upsert: vi.fn(),
      // the audience of an event, read after the write: nobody cleared anything
      findMany: vi.fn().mockResolvedValue([]),
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
      createMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
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
import { BadRequestError } from '../../utils/errors';

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
  vi.mocked(prisma.messageReaction.createMany).mockReset();
  vi.mocked(prisma.messageReaction.delete).mockReset();
  vi.mocked(prisma.messageReaction.deleteMany).mockReset();
  vi.mocked(prisma.messageReaction.groupBy).mockReset();
  vi.mocked(prisma.messageAttachment.findMany).mockReset();
  vi.mocked(prisma.messageAttachment.createMany).mockReset();
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.conversation.findUniqueOrThrow).mockReset();
  vi.mocked(prisma.conversation.updateMany).mockReset();
  vi.mocked(prisma.e2EDevice.count).mockReset();
  vi.mocked(prisma.e2EDevice.findMany).mockReset();
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

  it('the preview carries the row type (the client prints an unencrypted preview only for a system notice)', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation,
        user1: { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null },
        user2: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null },
        messages: [{ id: 'm-1', content: 'Voice call started', encrypted: false, type: 'system', createdAt: new Date('2024-01-01'), authorId: 'user-1' }],
      },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data[0].lastMessage).toMatchObject({ id: 'm-1', content: 'Voice call started', encrypted: false, type: 'system' });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        messages: expect.objectContaining({ select: expect.objectContaining({ type: true, encrypted: true }) }),
      }),
    }));
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
        encryptedAt: new Date('2026-08-01T14:00:00Z'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        reads: [],
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
        encryptedAt: new Date('2026-08-01T14:00:00Z'),
        createdAt: new Date('2024-02-01'),
        updatedAt: new Date('2024-02-01'),
        reads: [],
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

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: validEnvelope, encrypted: true });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // Verify socket emit
    expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
    expect(mockEmit).toHaveBeenCalledWith('dm:message:new', expect.anything());
  });

  it('rejects an empty body — there is no envelope to parse', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: '', encrypted: true });

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
      .send({ content: validEnvelope, encrypted: true });

    expect(res.status).toBe(403);
  });

  it('returns 400 when replyToId is not a string', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: validEnvelope, encrypted: true, replyToId: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/replyToId must be a string/);
  });
});

describe('DM routes — PUT /:conversationId/messages/:messageId/reactions/:emoji', () => {
  const EMOJI = '👍';
  const reactionUrl = `/api/v1/dm/conv-1/messages/msg-1/reactions/${encodeURIComponent(EMOJI)}`;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('adds a reaction and responds with action "add"', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1' } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.messageReaction.groupBy).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.messageReaction.createMany).mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(prisma.messageReaction.findMany).mockResolvedValueOnce([{ emoji: EMOJI, userId: 'user-1' }] as any);

    const app = createApp();
    const res = await request(app).put(reactionUrl);

    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('add');
    // ON CONFLICT DO NOTHING: inside the transaction, a duplicate must not be a failed statement
    expect(prisma.messageReaction.createMany).toHaveBeenCalledWith({ data: [{ messageId: 'msg-1', userId: 'user-1', emoji: EMOJI }], skipDuplicates: true });
    expect(prisma.messageReaction.create).not.toHaveBeenCalled();
    expect(mockTo).toHaveBeenCalledWith('dm:conv-1');
    expect(mockEmit).toHaveBeenCalledWith('dm:message:reaction_update', expect.objectContaining({ action: 'add' }));
  });

  it('race idempotency: responds 200 with action "add" when the concurrent duplicate already holds the row (the insert skips it)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1' } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.messageReaction.groupBy).mockResolvedValueOnce([] as any);
    // The losing half of a double-click race: the unique row is there, nothing inserted
    vi.mocked(prisma.messageReaction.createMany).mockResolvedValueOnce({ count: 0 } as any);
    vi.mocked(prisma.messageReaction.findMany).mockResolvedValueOnce([{ emoji: EMOJI, userId: 'user-1' }] as any);

    const app = createApp();
    const res = await request(app).put(reactionUrl);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.action).toBe('add');
  });

  it('other insert errors still fail the request', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1' } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.messageReaction.groupBy).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.messageReaction.createMany).mockRejectedValueOnce(new Error('connection lost'));

    const app = createApp();
    const res = await request(app).put(reactionUrl);

    expect(res.status).toBe(500);
  });

  it('removes an existing reaction via deleteMany (idempotent) and responds with action "remove"', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1' } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce({
      messageId: 'msg-1', userId: 'user-1', emoji: EMOJI,
    } as any);
    vi.mocked(prisma.messageReaction.deleteMany).mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(prisma.messageReaction.findMany).mockResolvedValueOnce([] as any);

    const app = createApp();
    const res = await request(app).put(reactionUrl);

    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('remove');
    // deleteMany (not delete) — a concurrent remove that already deleted the
    // row must not 500 with P2025
    expect(prisma.messageReaction.deleteMany).toHaveBeenCalledWith({
      where: { messageId: 'msg-1', userId: 'user-1', emoji: EMOJI },
    });
  });

  it('returns 404 when the message belongs to a different conversation', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-other' } as any);

    const app = createApp();
    const res = await request(app).put(reactionUrl);

    expect(res.status).toBe(404);
  });
});

// DELETE /:conversationId removes the conversation for the caller only (#47):
// its tests (hide, clear, the event's audience, the real deletion, the call,
// the best-effort steps) are in dmRemovalForOneSide.test.ts.

// ─── E2E encryption ─────────────────────────────────────────────────────────

// The opt-in route (POST /:conversationId/encryption) was deleted in the
// always-on cutover — conversations are born encrypted, so there is nothing to
// enable. What used to be its behaviour is now covered by "born encrypted"
// below plus the enforcement suite that follows.
describe('DM routes — the opt-in encryption route is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('404s POST /:conversationId/encryption and never touches the conversation', async () => {
    const app = createApp();
    const res = await request(app).post('/api/v1/dm/conv-1/encryption');

    expect(res.status).toBe(404);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('DM routes — conversations are born encrypted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('returns encryptedAt on a newly created conversation', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null,
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    // the DB column default fills encrypted_at — the route never sets it
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);

    const app = createApp();
    const res = await request(app).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(201);
    expect(res.body.data.encryptedAt).toBe('2026-08-01T14:00:00.000Z');
    // no toggle: creation must not try to write the column itself
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { user1Id: 'user-1', user2Id: 'user-2' } });
  });

  it('rejects the first plaintext message into a freshly created conversation', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null,
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);

    const app = createApp();
    const created = await request(app).post('/api/v1/dm').send({ userId: 'user-2' });
    expect(created.status).toBe(201);

    // …and the very first message into it already has to be ciphertext
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    const res = await request(app)
      .post(`/api/v1/dm/${created.body.data.id}/messages`)
      .send({ content: 'plain old text' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This conversation is end-to-end encrypted; update your client to send messages');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('serialises encryptedAt on every listed conversation', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation,
        user1: { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null },
        user2: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null },
        messages: [],
      },
    ] as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data[0].encryptedAt).toBe('2026-08-01T14:00:00.000Z');
  });
});

describe('DM routes — encrypted conversation message enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('accepts a valid envelope and stores it verbatim with encrypted=true', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    let createdData: any;
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => {
      return fn({
        message: {
          create: vi.fn().mockImplementation((args: any) => {
            createdData = args.data;
            return { id: 'msg-e1' };
          }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ ...mockMessage, id: 'msg-e1', content: validEnvelope, encrypted: true }),
        },
        messageAttachment: { createMany: vi.fn() },
      });
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: validEnvelope, encrypted: true });

    expect(res.status).toBe(201);
    // ciphertext must be stored byte-for-byte — no sanitizeText pass
    expect(createdData.content).toBe(validEnvelope);
    expect(createdData.encrypted).toBe(true);
  });

  it('accepts a megolm1 group-ratchet envelope and stores it verbatim', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    let createdData: any;
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => {
      return fn({
        message: {
          create: vi.fn().mockImplementation((args: any) => {
            createdData = args.data;
            return { id: 'msg-m1' };
          }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ ...mockMessage, id: 'msg-m1', content: validMegolmEnvelope, encrypted: true }),
        },
        messageAttachment: { createMany: vi.fn() },
      });
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: validMegolmEnvelope, encrypted: true });

    expect(res.status).toBe(201);
    // the server is engine-agnostic: it stores whatever parseE2EEnvelope accepts
    expect(createdData.content).toBe(validMegolmEnvelope);
    expect(createdData.encrypted).toBe(true);
  });

  it('rejects malformed megolm1 envelopes', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    const app = createApp();

    const bad = [
      JSON.stringify({ v: 1, e: 'megolm1', b: 'QWJj' }), // missing sid
      JSON.stringify({ v: 1, e: 'megolm1', sid: 'not a sid!', b: 'QWJj' }), // sid charset
      JSON.stringify({ v: 1, e: 'megolm1', sid: '', b: 'QWJj' }), // empty sid
      JSON.stringify({ v: 1, e: 'megolm1', sid: 'AAAA', b: 'not base64 !!' }), // body charset
      JSON.stringify({ v: 1, e: 'megolm1', sid: 'AAAA', t: 0, b: 'QWJj' }), // extra key
      JSON.stringify({ v: 1, e: 'megolm2', sid: 'AAAA', b: 'QWJj' }), // unknown engine
    ];
    for (const content of bad) {
      const res = await request(app).post('/api/v1/dm/conv-1/messages').send({ content, encrypted: true });
      expect(res.status).toBe(400);
    }
  });

  // This rejection is the ENTIRE mitigation for an un-updated client (plan D2):
  // no minimum client version was built, so this string is what an old build
  // shows its user instead of silently downgrading to plaintext. Asserted
  // verbatim — the wording is the feature.
  it('rejects plaintext sends with the exact upgrade instruction (no silent downgrade)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({ content: 'plain old text' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This conversation is end-to-end encrypted; update your client to send messages');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a plaintext send even when it carries valid-looking attachments', async () => {
    // The guard runs BEFORE attachment validation: an old client must never
    // reach a path that could persist an attachment row for a plaintext body.
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({
        content: 'plain old text',
        attachments: [{
          s3Key: 'attachments/dm-conv-1/abc123-photo.png',
          fileName: 'photo.png',
          fileSize: 1024,
          mimeType: 'image/png',
        }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This conversation is end-to-end encrypted; update your client to send messages');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.messageAttachment.createMany).not.toHaveBeenCalled();
  });

  it('rejects malformed envelopes', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    const app = createApp();

    const badEnvelopes = [
      'not json',
      JSON.stringify({ v: 2, e: 'olm1', t: 0, b: 'QWJj' }), // wrong version
      JSON.stringify({ v: 1, e: 'other', t: 0, b: 'QWJj' }), // unknown engine
      JSON.stringify({ v: 1, e: 'olm1', t: 5, b: 'QWJj' }), // invalid type
      JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'not base64 !!' }), // invalid body
      JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'QWJj', x: 1 }), // extra key
    ];
    for (const bad of badEnvelopes) {
      const res = await request(app)
        .post('/api/v1/dm/conv-1/messages')
        .send({ content: bad, encrypted: true });
      expect(res.status).toBe(400);
    }
  });

  it('accepts opaque encrypted attachments and never stores a client-supplied name', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    let attachmentRows: any;
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) =>
      fn({
        message: {
          create: vi.fn().mockResolvedValue({ id: 'msg-e2' }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ ...mockMessage, id: 'msg-e2', encrypted: true, content: validEnvelope }),
        },
        messageAttachment: {
          createMany: vi.fn().mockImplementation((args: any) => {
            attachmentRows = args.data;
          }),
        },
      })
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/dm/conv-1/messages')
      .send({
        content: validEnvelope,
        encrypted: true,
        attachments: [{
          s3Key: 'attachments/dm-conv-1/abc123-encrypted.bin',
          fileName: 'real-secret-name.png', // must be discarded server-side
          fileSize: 1024,
          mimeType: 'application/octet-stream',
        }],
      });

    expect(res.status).toBe(201);
    expect(attachmentRows[0].fileName).toBe('encrypted.bin');
    expect(attachmentRows[0].mimeType).toBe('application/octet-stream');
    // The stored blob was read back against the declared ciphertext size
    expect(mockVerifyAttachmentUploads).toHaveBeenCalledWith([{
      key: 'attachments/dm-conv-1/abc123-encrypted.bin',
      declaredSize: 1024,
      maxSize: 12 * 1024 * 1024 + 16,
    }]);
  });

  it('refuses a blob the read-back rejects, creating nothing', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    mockVerifyAttachmentUploads.mockRejectedValueOnce(new BadRequestError('Invalid attachment size'));

    const res = await request(createApp())
      .post('/api/v1/dm/conv-1/messages')
      .send({
        content: validEnvelope,
        encrypted: true,
        attachments: [{ s3Key: 'attachments/dm-conv-1/abc123-encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid attachment size');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed (500) when the store cannot be read', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockVerifyAttachmentUploads.mockRejectedValueOnce(new Error('store unavailable'));

    const res = await request(createApp())
      .post('/api/v1/dm/conv-1/messages')
      .send({
        content: validEnvelope,
        encrypted: true,
        attachments: [{ s3Key: 'attachments/dm-conv-1/abc123-encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream' }],
      });

    expect(res.status).toBe(500);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects non-opaque or invalid encrypted attachments', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    const app = createApp();
    const base = { content: validEnvelope, encrypted: true };
    const valid = { s3Key: 'attachments/dm-conv-1/abc123-encrypted.bin', fileName: 'encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream' };

    // real mime type leaking through
    let res = await request(app).post('/api/v1/dm/conv-1/messages')
      .send({ ...base, attachments: [{ ...valid, mimeType: 'image/png' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/opaque/i);

    // ciphertext larger than the outer cap (video max + GCM tag)
    res = await request(app).post('/api/v1/dm/conv-1/messages')
      .send({ ...base, attachments: [{ ...valid, fileSize: 12 * 1024 * 1024 + 17 }] });
    expect(res.status).toBe(400);

    // key belonging to another conversation
    res = await request(app).post('/api/v1/dm/conv-1/messages')
      .send({ ...base, attachments: [{ ...valid, s3Key: 'attachments/dm-other/abc123-encrypted.bin' }] });
    expect(res.status).toBe(400);

    // a fractional size can be neither signed nor stored
    res = await request(app).post('/api/v1/dm/conv-1/messages')
      .send({ ...base, attachments: [{ ...valid, fileSize: 1024.5 }] });
    expect(res.status).toBe(400);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    // none of these reached the store
    expect(mockVerifyAttachmentUploads).not.toHaveBeenCalled();
  });

  it('rejects a plaintext edit of an encrypted message (no downgrade)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({
      ...mockMessage, encrypted: true, content: validEnvelope,
    } as any);

    const app = createApp();
    const res = await request(app)
      .patch('/api/v1/dm/conv-1/messages/msg-1')
      .send({ content: 'new text' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end-to-end encrypted/i);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('accepts an envelope edit of an encrypted message and stores it verbatim', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({
      ...mockMessage, encrypted: true, content: validEnvelope,
    } as any);
    const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });
    vi.mocked(prisma.message.update).mockResolvedValueOnce({
      ...mockMessage, encrypted: true, content: editEnvelope, editedAt: new Date('2026-07-12'), reactions: [],
    } as any);

    const app = createApp();
    const res = await request(app)
      .patch('/api/v1/dm/conv-1/messages/msg-1')
      .send({ content: editEnvelope, encrypted: true });

    expect(res.status).toBe(200);
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: editEnvelope }),
      })
    );
    expect(mockEmit).toHaveBeenCalledWith('dm:message:update', expect.objectContaining({ encrypted: true }));
  });

  it('rejects a malformed envelope on an encrypted edit', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({
      ...mockMessage, encrypted: true, content: validEnvelope,
    } as any);

    const app = createApp();
    const res = await request(app)
      .patch('/api/v1/dm/conv-1/messages/msg-1')
      .send({ content: 'not an envelope', encrypted: true });

    expect(res.status).toBe(400);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  // The two tests below cover the edit route's surviving plaintext branch. It
  // is NOT dead after the cutover: `createSystemMessage()` in
  // websocket/dmVoiceHandler.ts still writes `type: 'system'` DM rows ("Voice
  // call started/ended") with `encrypted` at its false default, authored by a
  // participant — so they pass this route's ownership check and land here.
  const systemMessage = {
    ...mockMessage, type: 'system', encrypted: false, content: 'Voice call started',
  };

  it('refuses to edit a system message at all', async () => {
    // "Voice call started" rows carry a real participant as their author, so
    // the ownership check passes for them. Without this guard a participant
    // could rewrite that content into arbitrary text which still renders with
    // system styling — words the app appears to be saying itself.
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(systemMessage as any);

    const app = createApp();
    const res = await request(app)
      .patch('/api/v1/dm/conv-1/messages/msg-1')
      .send({ content: '<b>call was never made</b>', encrypted: false });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/system messages cannot be edited/i);
    expect(prisma.message.update).not.toHaveBeenCalled();
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

// ─── A conversation that outlived one side (expand step of #47/#131) ─────────
// Nothing writes a NULL side or a NULL DM author yet: the rows below are
// constructed to pin what every reader does once one exists, and that a live
// conversation still serialises exactly as before (what a 2.1.x client reads).

describe('DM routes — the wire for live conversations is unchanged', () => {
  const alice = { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null };
  const bob = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: 'avatars/user-2-1.webp', status: 'idle', role: 'admin', isSupporter: true, supporterTier: 'first' };

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('GET /dm: exactly the fields and order it had, and no participantDeleted key', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation,
        user1: alice,
        user2: bob,
        messages: [{ id: 'm-1', content: validEnvelope, encrypted: true, type: 'user', createdAt: new Date('2026-11-01T10:00:00Z'), authorId: 'user-2' }],
      },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: [{
        id: 'conv-1',
        user1Id: 'user-1',
        user2Id: 'user-2',
        participant: bob,
        lastMessage: { id: 'm-1', content: validEnvelope, encrypted: true, type: 'user', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'user-2' },
        encryptedAt: '2026-08-01T14:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
      }],
    });
    expect(Object.keys(res.body.data[0])).toEqual(['id', 'user1Id', 'user2Id', 'participant', 'lastMessage', 'encryptedAt', 'createdAt']);
  });

  it('POST /dm: exactly the body it had', async () => {
    const target = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null };
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(target as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: {
        id: 'conv-1',
        user1Id: 'user-1',
        user2Id: 'user-2',
        participant: target,
        lastMessage: null,
        encryptedAt: '2026-08-01T14:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    });
    // the pair lookup is by both live ids, sorted (Prisma's compound input
    // takes no null), with the caller's read row for their floor (none here:
    // no clearedUntil key above)
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { user1Id_user2Id: { user1Id: 'user-1', user2Id: 'user-2' } },
      include: { reads: { where: { userId: 'user-1' }, select: { clearedAt: true } } },
    });
  });

  it('GET /:id/messages: a live row and its live quote pass through as they are (the quote\'s time, read for the floor, is never sent)', async () => {
    const quoted = { id: 'msg-0', content: validEnvelope, encrypted: true, webhookId: null, webhookName: null, author: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null } };
    const row = { ...mockMessage, encrypted: true, content: validEnvelope, webhookId: null, webhookName: null, mentionsEveryone: false, replyToId: 'msg-0', replyTo: quoted };
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([{ ...row, replyTo: { ...quoted, createdAt: new Date('2023-12-31') } }] as any);

    const res = await request(createApp()).get('/api/v1/dm/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.data).toStrictEqual([JSON.parse(JSON.stringify({ ...row, reactions: [] }))]);
    expect(Object.keys(res.body.data[0])).toEqual(Object.keys({ ...row, reactions: [] }));
  });
});

describe('DM routes — a conversation whose other side was deleted (NULL side)', () => {
  const alice = { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null };
  const placeholder = (conversationId: string) => ({
    id: `deleted:${conversationId}`,
    username: 'deleted',
    displayName: 'Deleted user',
    avatarUrl: null,
    status: 'offline',
    role: 'user',
    isSupporter: false,
    supporterTier: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('GET /dm: the viewer as the first side, the second gone → the placeholder, participantDeleted: true, the side sent as null', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      { ...mockConversation, id: 'conv-7', user1Id: 'user-1', user2Id: null, user1: alice, user2: null, messages: [] },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toStrictEqual({
      id: 'conv-7',
      user1Id: 'user-1',
      user2Id: null,
      participant: placeholder('conv-7'),
      participantDeleted: true,
      lastMessage: null,
      encryptedAt: '2026-08-01T14:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('GET /dm: the viewer as the second side, the first gone → the placeholder', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      { ...mockConversation, id: 'conv-8', user1Id: null, user2Id: 'user-1', user1: null, user2: alice, messages: [] },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.body.data[0].user1Id).toBeNull();
    expect(res.body.data[0].user2Id).toBe('user-1');
    expect(res.body.data[0].participant).toStrictEqual(placeholder('conv-8'));
    expect(res.body.data[0].participantDeleted).toBe(true);
  });

  it('GET /dm: a live and an outlived conversation side by side keep their own shapes, and the placeholders differ per conversation', async () => {
    const bob = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, status: 'offline', role: 'user', isSupporter: false, supporterTier: null };
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      { ...mockConversation, user1: alice, user2: bob, messages: [] },
      { ...mockConversation, id: 'conv-a', user1Id: 'user-1', user2Id: null, user1: alice, user2: null, messages: [] },
      { ...mockConversation, id: 'conv-b', user1Id: null, user2Id: 'user-1', user1: null, user2: alice, messages: [] },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.body.data[0].participant).toStrictEqual(bob);
    expect(res.body.data[0]).not.toHaveProperty('participantDeleted');
    expect(res.body.data[1].participant.id).toBe('deleted:conv-a');
    expect(res.body.data[2].participant.id).toBe('deleted:conv-b');
  });

  it('GET /dm: a newest row without an author names the placeholder as its author, never null', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        ...mockConversation, id: 'conv-7', user1Id: 'user-1', user2Id: null, user1: alice, user2: null,
        messages: [{ id: 'm-9', content: '', encrypted: false, type: 'deleted', createdAt: new Date('2026-11-01T10:00:00Z'), authorId: null }],
      },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.body.data[0].lastMessage).toStrictEqual({
      id: 'm-9', content: '', encrypted: false, type: 'deleted', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'deleted:conv-7',
    });
  });

  it('the participant check: the remaining person passes, and may read (a read-only conversation is still read)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...mockConversation, user1Id: null, user2Id: 'user-1' } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([] as any);

    const res = await request(createApp()).get('/api/v1/dm/conv-1/messages');

    expect(res.status).toBe(200);
  });

  it('the participant check: nobody passes as the deleted side, and a row with both sides gone admits nobody', async () => {
    for (const sides of [{ user1Id: null, user2Id: 'user-2' }, { user1Id: 'user-2', user2Id: null }, { user1Id: null, user2Id: null }]) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...mockConversation, ...sides } as any);
      const res = await request(createApp()).get('/api/v1/dm/conv-1/messages');
      expect(res.status, JSON.stringify(sides)).toBe(403);
      expect(res.body.error).toBe('Not a participant of this conversation');
    }
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('GET /:id/messages: an authorless row is shaped with the placeholder author, and so is a quote of one', async () => {
    const placeholderRow = {
      id: 'msg-a', content: '', encrypted: false, type: 'deleted', mentionsEveryone: false,
      conversationId: 'conv-1', channelId: null, authorId: null, author: null, webhookId: null, webhookName: null,
      replyToId: null, replyTo: null, editedAt: null, createdAt: new Date('2026-11-01T10:00:00Z'), reactions: [], attachments: [],
    };
    const reply = {
      ...mockMessage, id: 'msg-b', encrypted: true, content: validEnvelope, webhookId: null, webhookName: null,
      replyToId: 'msg-a', replyTo: { id: 'msg-a', content: '', encrypted: false, author: null, webhookId: null, webhookName: null },
    };
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...mockConversation, user2Id: null } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([reply, placeholderRow] as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(createApp()).get('/api/v1/dm/conv-1/messages');

    expect(res.status).toBe(200);
    const [first, second] = res.body.data;
    expect(first.id).toBe('msg-a');
    expect(first.author).toStrictEqual(placeholder('conv-1'));
    expect(first.author).not.toHaveProperty('isWebhook');
    expect(second.author.id).toBe('user-1');
    // a quote's placeholder carries exactly the keys this route selects for a
    // live quote author (no presence), the row's those of a live row author
    const { status: _status, ...quotePlaceholder } = placeholder('conv-1');
    expect(second.replyTo.author).toStrictEqual(quotePlaceholder);
    const include = vi.mocked(prisma.message.findMany).mock.calls[0][0]!.include as any;
    expect(Object.keys(second.replyTo.author).sort()).toEqual(Object.keys(include.replyTo.select.author.select).sort());
    expect(Object.keys(first.author).sort()).toEqual(Object.keys(include.author.select).sort());
    // never the webhook fallback label, so never its warning
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[messageAuthor]'), expect.anything());
    warn.mockRestore();
  });

  it('GET /:id/messages: the conversation comes from the route, so a row read without conversationId still gets the placeholder', async () => {
    const { conversationId: _omitted, ...withoutConversation } = {
      id: 'msg-a', content: '', encrypted: false, type: 'deleted', mentionsEveryone: false,
      conversationId: 'conv-1', channelId: null, authorId: null, author: null, webhookId: null, webhookName: null,
      replyToId: null, replyTo: null, editedAt: null, createdAt: new Date('2026-11-01T10:00:00Z'), reactions: [], attachments: [],
    };
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...mockConversation, user2Id: null } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([withoutConversation] as any);

    const res = await request(createApp()).get('/api/v1/dm/conv-1/messages');

    expect(res.body.data[0].author).toStrictEqual(placeholder('conv-1'));
  });
});

// ─── A row deleted while the request ran ────────────────────────────────────
// Each of these windows answered 500. The errors are shaped as Prisma 7 and
// its pg adapter raise them (checked against PostgreSQL 16): a refused
// foreign key is P2003 naming its constraint, a row gone before an update or
// a delete is P2025.

/** A refused foreign key, as the adapter reports it. */
const foreignKeyRefused = (modelName: string, constraint: string) => Object.assign(new Error(`Foreign key constraint violated on the constraint: \`${constraint}\``), {
  code: 'P2003',
  meta: {
    modelName,
    driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23503', kind: 'ForeignKeyConstraintViolation', constraint: { index: constraint } } },
  },
});
/** No row to update or delete. */
const rowGone = (operation: string) => Object.assign(new Error('An operation failed because it depends on one or more records that were required but not found.'), {
  code: 'P2025',
  meta: { modelName: 'Message', operation },
});

describe('DM routes — a row deleted while the request ran is answered as missing', () => {
  const EMOJI = '👍';
  const reactionUrl = `/api/v1/dm/conv-1/messages/msg-1/reactions/${encodeURIComponent(EMOJI)}`;
  const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errorLog.mockRestore());

  const stageReaction = () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1', createdAt: new Date('2024-01-01') } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.messageReaction.groupBy).mockResolvedValueOnce([] as any);
  };

  it('a reaction on a message deleted after the read: 404 Message, nothing announced', async () => {
    stageReaction();
    vi.mocked(prisma.messageReaction.createMany).mockRejectedValueOnce(foreignKeyRefused('MessageReaction', 'message_reactions_message_id_fkey'));

    const res = await request(createApp()).put(reactionUrl);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a reaction refused by another key (the account) is not taken for a missing message: it surfaces as itself', async () => {
    stageReaction();
    vi.mocked(prisma.messageReaction.createMany).mockRejectedValueOnce(foreignKeyRefused('MessageReaction', 'message_reactions_user_id_fkey'));

    expect((await request(createApp()).put(reactionUrl)).status).toBe(500);
  });

  it('a reply whose parent was deleted after the check: the answer a missing parent always gets (400 Invalid replyToId), and nothing is sent', async () => {
    const parent = { conversationId: 'conv-1', createdAt: new Date('2024-01-01') };
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(parent as any);
    const tx = {
      message: {
        findUnique: vi.fn().mockResolvedValue(parent),
        create: vi.fn().mockRejectedValue(foreignKeyRefused('Message', 'messages_reply_to_id_fkey')),
        findUniqueOrThrow: vi.fn(),
      },
      messageAttachment: { createMany: vi.fn() },
    };
    vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: (client: unknown) => unknown) => fn(tx)) as any);

    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, replyToId: 'msg-0' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid replyToId');
    expect(tx.message.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a send refused by another key surfaces as itself, a reply\'s included', async () => {
    for (const replyToId of [undefined, 'msg-0']) {
      if (replyToId) vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ conversationId: 'conv-1', createdAt: new Date('2024-01-01') } as any);
      const tx = {
        message: {
          findUnique: vi.fn().mockResolvedValue({ conversationId: 'conv-1', createdAt: new Date('2024-01-01') }),
          create: vi.fn().mockRejectedValue(foreignKeyRefused('Message', 'messages_author_id_fkey')),
          findUniqueOrThrow: vi.fn(),
        },
        messageAttachment: { createMany: vi.fn() },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: (client: unknown) => unknown) => fn(tx)) as any);
      const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, ...(replyToId && { replyToId }) });
      expect(res.status, String(replyToId)).toBe(500);
    }
  });

  it('an edit that lost the race with a delete: 404 Message, nothing announced', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, encrypted: true, content: validEnvelope } as any);
    vi.mocked(prisma.message.update).mockRejectedValueOnce(rowGone('an update'));

    const res = await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a delete that lost the race with another delete: 404 Message, no file deleted, nothing announced', async () => {
    const { deleteMultipleFromS3 } = await import('../../utils/s3');
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, attachments: [{ s3Key: 'attachments/dm-conv-1/abc123-encrypted.bin' }] } as any);
    vi.mocked(prisma.message.delete).mockRejectedValueOnce(rowGone('a delete'));

    const res = await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('an edit or a delete failing otherwise surfaces as itself', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, encrypted: true, content: validEnvelope } as any);
    vi.mocked(prisma.message.update).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }));
    expect((await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true })).status).toBe(500);

    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, attachments: [] } as any);
    vi.mocked(prisma.message.delete).mockRejectedValueOnce(new Error('connection lost'));
    expect((await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1')).status).toBe(500);
  });

  it('a mark-read whose insert meets a conversation really deleted after the view: 404 Conversation', async () => {
    vi.mocked(prisma.conversationRead.upsert).mockRejectedValueOnce(foreignKeyRefused('ConversationRead', 'conversation_reads_conversation_id_fkey'));

    const res = await request(createApp()).post('/api/v1/dm/conv-1/read');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });

  it('a mark-read refused by the account\'s key is not taken for a missing conversation: it surfaces as itself', async () => {
    vi.mocked(prisma.conversationRead.upsert).mockRejectedValueOnce(foreignKeyRefused('ConversationRead', 'conversation_reads_user_id_fkey'));

    expect((await request(createApp()).post('/api/v1/dm/conv-1/read')).status).toBe(500);
  });
});

// ─── A conversation whose other side's account is gone: read-only (#131) ────

describe('DM routes — a read-only conversation (the other side is gone)', () => {
  const EMOJI = '👍';
  const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });
  const READ_ONLY = { status: 403, error: 'This conversation is read-only' };
  // the caller (user-1) is the side that is left, either way round
  const readOnly = [
    { ...mockConversation, user1Id: 'user-1', user2Id: null },
    { ...mockConversation, user1Id: null, user2Id: 'user-1' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
  });

  it('a send is refused before anything is checked, uploaded or written (403, the shared sentence)', async () => {
    const { writeConversationMessage } = await import('../../utils/conversationLifecycle');
    for (const conversation of readOnly) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation as any);
      const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, attachments: [{ s3Key: 'attachments/dm-conv-1/abc123-encrypted.bin', fileSize: 10, mimeType: 'application/octet-stream' }] });
      expect({ status: res.status, error: res.body.error }).toEqual(READ_ONLY);
    }
    expect(mockVerifyAttachmentUploads).not.toHaveBeenCalled();
    expect(writeConversationMessage).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('an edit is refused before the message is read', async () => {
    for (const conversation of readOnly) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation as any);
      const res = await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });
      expect({ status: res.status, error: res.body.error }).toEqual(READ_ONLY);
    }
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('a reaction, added or taken back, is refused before the message is read', async () => {
    for (const conversation of readOnly) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation as any);
      const res = await request(createApp()).put(`/api/v1/dm/conv-1/messages/msg-1/reactions/${encodeURIComponent(EMOJI)}`);
      expect({ status: res.status, error: res.body.error }).toEqual(READ_ONLY);
    }
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(prisma.messageReaction.createMany).not.toHaveBeenCalled();
    expect(prisma.messageReaction.deleteMany).not.toHaveBeenCalled();
  });

  it("a delete of one's own message, a mark-read and a page still go through", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(readOnly[0] as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, attachments: [] } as any);
    vi.mocked(prisma.message.delete).mockResolvedValueOnce({} as any);
    expect((await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1')).status).toBe(200);
    expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'msg-1' } });

    vi.mocked(prisma.conversationRead.upsert).mockResolvedValueOnce({} as any);
    expect((await request(createApp()).post('/api/v1/dm/conv-1/read')).status).toBe(200);

    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([] as any);
    expect((await request(createApp()).get('/api/v1/dm/conv-1/messages')).status).toBe(200);
  });

  it('the writes repeat the check under the conversation row lock: an edit and a reaction refuse a read-only conversation there, a delete does not', async () => {
    const { changeConversationMessage } = await import('../../utils/conversationLifecycle');
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);

    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, encrypted: true, content: validEnvelope } as any);
    vi.mocked(prisma.message.update).mockResolvedValueOnce({ ...mockMessage, encrypted: true, content: editEnvelope, editedAt: new Date() } as any);
    expect((await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true })).status).toBe(200);

    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1', createdAt: new Date('2024-01-01') } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.messageReaction.groupBy).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.messageReaction.createMany).mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(prisma.messageReaction.findMany).mockResolvedValueOnce([] as any);
    expect((await request(createApp()).put(`/api/v1/dm/conv-1/messages/msg-1/reactions/${encodeURIComponent(EMOJI)}`)).status).toBe(200);

    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, attachments: [] } as any);
    vi.mocked(prisma.message.delete).mockResolvedValueOnce({} as any);
    expect((await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1')).status).toBe(200);

    expect(vi.mocked(changeConversationMessage).mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['conv-1', 'user-1', { refuseReadOnly: true }],
      ['conv-1', 'user-1', { refuseReadOnly: true }],
      ['conv-1', 'user-1', { refuseReadOnly: false }],
    ]);
  });

  it('the refusal the lock makes reaches the caller as it is (an account deletion committed while the edit waited)', async () => {
    const { changeConversationMessage } = await import('../../utils/conversationLifecycle');
    const { ForbiddenError } = await import('../../utils/errors');
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(mockConversation as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...mockMessage, encrypted: true, content: validEnvelope } as any);
    vi.mocked(changeConversationMessage).mockRejectedValueOnce(new ForbiddenError('This conversation is read-only'));

    const res = await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });

    expect({ status: res.status, error: res.body.error }).toEqual(READ_ONLY);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('POST /dm toward a placeholder id answers what an unknown account always got (404 User), and opens nothing', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'deleted:conv-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });
});

describe('DM routes — POST /dm toward an account deleted while the request ran', () => {
  const bob = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null };

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMocks();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(bob as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null);
  });

  it('the new conversation\'s key to the account refused (either side): 404 User, as for an unknown account, and nobody joins a room', async () => {
    for (const constraint of ['conversations_user1_id_fkey', 'conversations_user2_id_fkey']) {
      vi.mocked(prisma.conversation.create).mockRejectedValueOnce(foreignKeyRefused('Conversation', constraint));

      const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

      expect(res.status, constraint).toBe(404);
      expect(res.body.error).toBe('User not found');
    }
    expect(prisma.conversationRead.createMany).not.toHaveBeenCalled();
    expect(mockSocketsJoin).not.toHaveBeenCalled();
  });

  it('its read rows refused because the account went in between: 404 User, nobody joins a room', async () => {
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce({ ...mockConversation } as any);
    vi.mocked(prisma.conversationRead.createMany).mockRejectedValueOnce(foreignKeyRefused('ConversationRead', 'conversation_reads_user_id_fkey'));

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
    expect(mockSocketsJoin).not.toHaveBeenCalled();
  });

  it('any other refusal surfaces as itself', async () => {
    vi.mocked(prisma.conversation.create).mockRejectedValueOnce(foreignKeyRefused('Conversation', 'some_other_fkey'));
    expect((await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' })).status).toBe(500);

    vi.mocked(prisma.conversation.create).mockResolvedValueOnce({ ...mockConversation } as any);
    vi.mocked(prisma.conversationRead.createMany).mockRejectedValueOnce(foreignKeyRefused('ConversationRead', 'conversation_reads_conversation_id_fkey'));
    expect((await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' })).status).toBe(500);
  });
});
