import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Removing a direct conversation removes it for the person who asks only
// (#47), and what each person sees of a conversation stops at their floor.
// The transactions themselves are tested in utils/conversationLifecycle.test.ts;
// this suite tests what the routes do with them and how every reader and
// action applies the floor.

// ─── Socket.IO: every emit recorded with its audience ───────────────────────

interface Emit { to: string | string[]; except: string[] | null; event: string; payload: any }

const io = vi.hoisted(() => {
  const emits: Emit[] = [];
  const order: string[] = [];
  const mockFetchSockets = vi.fn().mockResolvedValue([]);
  const mockSocketsJoin = vi.fn();
  const mockSocketsLeave = vi.fn(() => { order.push('cluster leave'); });
  const mockLocalSocketsLeave = vi.fn(() => { order.push('local leave'); });
  const emitter = (to: string | string[], except: string[] | null) => ({
    emit: vi.fn((event: string, payload: unknown) => {
      order.push(`emit ${event}`);
      emits.push({ to, except, event, payload });
    }),
  });
  const mockTo = vi.fn((to: string | string[]) => ({
    ...emitter(to, null),
    except: vi.fn((rooms: string[]) => emitter(to, rooms)),
  }));
  const mockIn = vi.fn(() => ({ fetchSockets: mockFetchSockets, socketsJoin: mockSocketsJoin, socketsLeave: mockSocketsLeave }));
  const mockLocalIn = vi.fn(() => ({ fetchSockets: mockFetchSockets, socketsLeave: mockLocalSocketsLeave }));
  return { emits, order, mockTo, mockIn, mockLocalIn, mockFetchSockets, mockSocketsJoin, mockSocketsLeave, mockLocalSocketsLeave };
});

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
  requireConsent: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitMessageSend: passthrough,
    rateLimitDmOpen: passthrough,
    rateLimitInteract: passthrough,
    rateLimitMarkRead: passthrough,
  };
});

vi.mock('../../websocket/socketServer', () => ({
  getIO: () => ({ to: io.mockTo, in: io.mockIn, local: { in: io.mockLocalIn }, fetchSockets: io.mockFetchSockets }),
}));

const mockEndDMCall = vi.hoisted(() => vi.fn());
const mockEndDMCallIfParticipant = vi.hoisted(() => vi.fn());
vi.mock('../../websocket/dmVoiceHandler', () => ({
  endDMCall: (...args: unknown[]) => mockEndDMCall(...args),
  // its states (no call, an outgoing ring, a ring from the other person,
  // connected) are tested in websocket/dmVoiceHandler.test.ts
  endDMCallIfParticipant: (...args: unknown[]) => mockEndDMCallIfParticipant(...args),
}));

const mockDeleteFromS3 = vi.hoisted(() => vi.fn());
vi.mock('../../utils/s3', () => ({
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
  deleteMultipleFromS3: (...args: unknown[]) => mockDeleteFromS3(...args),
}));

vi.mock('../../utils/uploadVerification', () => ({ verifyAttachmentUploads: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../../utils/prisma', () => ({
  prisma: {
    conversation: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
    // findMany: the audience of an event, read after the write (utils/conversationAudience.ts)
    conversationRead: { createMany: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    message: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    messageReaction: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn() },
    messageAttachment: { createMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const SEND_AT = new Date('2026-11-16T12:00:00.000Z');
const lifecycle = vi.hoisted(() => ({
  writeConversationMessage: vi.fn(),
  removeConversationForUser: vi.fn(),
  reopenConversationForUser: vi.fn(),
  changeConversationMessage: vi.fn(),
}));
vi.mock('../../utils/conversationLifecycle', () => lifecycle);

import { prisma } from '../../utils/prisma';
import { dmRouter } from '../../routes/dm';
import { errorHandler } from '../../middleware/errorHandler';
import { NotFoundError } from '../../utils/errors';
import { DM_CLEARED_LIST_MAX } from '@voxium/shared';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dm', dmRouter);
  app.use(errorHandler);
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FLOOR = new Date('2026-11-10T10:00:00.000Z');
const BELOW = new Date('2026-11-09T10:00:00.000Z');
const ABOVE = new Date('2026-11-11T10:00:00.000Z');
const validEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'QWJjZGVmZ2hpamtsbW5vcA' });

const read = (userId: string, clearedAt: Date | null = null, hiddenAt: Date | null = null) => ({ userId, hiddenAt, clearedAt });
/** The conversation as loadConversationView reads it: the sides and both read rows. */
const conversation = (reads = [read('user-1'), read('user-2')], sides: { user1Id: string | null; user2Id: string | null } = { user1Id: 'user-1', user2Id: 'user-2' }) =>
  ({ id: 'conv-1', ...sides, reads });

const alice = { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null };
const bob = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null };
const quoteAuthor = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'msg-1', content: validEnvelope, encrypted: true, type: 'user', mentionsEveryone: false,
  conversationId: 'conv-1', channelId: null, authorId: 'user-1', author: alice, webhookId: null, webhookName: null,
  replyToId: null, replyTo: null, editedAt: null, createdAt: ABOVE, reactions: [], attachments: [],
  ...over,
});
const quote = (createdAt: Date) => ({ id: 'msg-0', content: validEnvelope, encrypted: true, createdAt, webhookId: null, webhookName: null, author: quoteAuthor });

const dmRoomEmits = (event: string) => io.emits.filter((e) => e.event === event);

beforeEach(() => {
  vi.clearAllMocks();
  io.emits.length = 0;
  io.order.length = 0;
  for (const model of Object.values(prisma) as Array<Record<string, ReturnType<typeof vi.fn>>>) {
    if (typeof model === 'function') continue;
    for (const fn of Object.values(model)) fn.mockReset();
  }
  vi.mocked(prisma.$transaction).mockReset();
  mockEndDMCall.mockReset().mockImplementation(async () => { io.order.push('end call'); return []; });
  mockEndDMCallIfParticipant.mockReset().mockImplementation(async () => { io.order.push('end call of the remover'); return []; });
  vi.mocked(prisma.conversationRead.findMany).mockResolvedValue([]);
  mockDeleteFromS3.mockReset().mockImplementation(async (keys: string[]) => { io.order.push('delete files'); return keys.length; });
  lifecycle.removeConversationForUser.mockReset().mockImplementation(async () => {
    io.order.push('removal');
    return { deleted: false, clearedUntil: null, attachmentKeys: [] };
  });
  lifecycle.reopenConversationForUser.mockReset().mockResolvedValue('reopened');
  lifecycle.writeConversationMessage.mockReset().mockImplementation(writeAs());
  // An edit, a reaction, a delete: the write on the transaction's client,
  // under the conversation row lock (its checks are tested in
  // utils/conversationLifecycle.test.ts)
  lifecycle.changeConversationMessage.mockReset().mockImplementation(
    async (_conversationId: string, _userId: string, _opts: unknown, act: (tx: unknown, view: unknown) => unknown) => act(prisma, {}),
  );
});

/**
 * The message write as the lifecycle runs it: `write` on the transaction's
 * client with the context it read under the lock, then `announce` with the
 * audience read after the commit (by default the same rows).
 */
function writeAs(opts: { sides?: ReturnType<typeof read>[]; authorFloor?: Date | null; audience?: ReturnType<typeof read>[] } = {}) {
  return async (_c: string, _a: string, write: (tx: unknown, ctx: unknown) => Promise<unknown>, announce: (m: unknown, audience: unknown) => void) => {
    const context = { createdAt: SEND_AT, sides: opts.sides ?? [read('user-1'), read('user-2')], authorFloor: opts.authorFloor ?? null };
    const message = await write(prisma, context);
    announce(message, opts.audience ?? context.sides);
    return { message, context };
  };
}

// ─── DELETE /dm/:id ─────────────────────────────────────────────────────────

describe('DELETE /dm/:id — removal for the caller only', () => {
  beforeEach(() => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation() as any);
  });

  it('without a flag (what the 2.1.x desktop sends): hides only, and answers what the route always answered', async () => {
    const res = await request(createApp()).delete('/api/v1/dm/conv-1');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ success: true, message: 'Conversation deleted' });
    expect(lifecycle.removeConversationForUser).toHaveBeenCalledWith('conv-1', 'user-1', { clearHistory: false });
  });

  it('?clearHistory=true clears the caller\'s history; ?clearHistory=false only hides', async () => {
    await request(createApp()).delete('/api/v1/dm/conv-1?clearHistory=true');
    await request(createApp()).delete('/api/v1/dm/conv-1?clearHistory=false');

    expect(lifecycle.removeConversationForUser).toHaveBeenNthCalledWith(1, 'conv-1', 'user-1', { clearHistory: true });
    expect(lifecycle.removeConversationForUser).toHaveBeenNthCalledWith(2, 'conv-1', 'user-1', { clearHistory: false });
  });

  it('any other value, a repeated parameter included, is refused before anything is read: it never falls through to a clear', async () => {
    for (const query of ['clearHistory=yes', 'clearHistory=1', 'clearHistory=TRUE', 'clearHistory=', 'clearHistory=true&clearHistory=true', 'clearHistory=true&clearHistory=false']) {
      const res = await request(createApp()).delete(`/api/v1/dm/conv-1?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.error).toBe('clearHistory must be true or false');
    }
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    expect(lifecycle.removeConversationForUser).not.toHaveBeenCalled();
    expect(io.emits).toEqual([]);
  });

  it('the event goes to every device of the remover (user:{id}) and NEVER to dm:{id}: the other person is told nothing', async () => {
    await request(createApp()).delete('/api/v1/dm/conv-1');

    const notices = dmRoomEmits('dm:conversation:deleted');
    expect(notices).toEqual([{ to: 'user:user-1', except: null, event: 'dm:conversation:deleted', payload: { conversationId: 'conv-1' } }]);
    expect(io.mockTo).not.toHaveBeenCalledWith('dm:conv-1');
  });

  it('a clear names the floor the remover\'s history was cleared to', async () => {
    lifecycle.removeConversationForUser.mockResolvedValueOnce({ deleted: false, clearedUntil: FLOOR, attachmentKeys: [] });

    await request(createApp()).delete('/api/v1/dm/conv-1?clearHistory=true');

    expect(dmRoomEmits('dm:conversation:deleted')[0].payload).toStrictEqual({ conversationId: 'conv-1', clearedUntil: '2026-11-10T10:00:00.000Z' });
  });

  it('the answer carries the floor too (data.clearedUntil, the event\'s value), beside the success and message it always had', async () => {
    for (const deleted of [false, true]) {
      lifecycle.removeConversationForUser.mockResolvedValueOnce({ deleted, clearedUntil: FLOOR, attachmentKeys: [] });

      const res = await request(createApp()).delete('/api/v1/dm/conv-1?clearHistory=true');

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ success: true, message: 'Conversation deleted', data: { clearedUntil: '2026-11-10T10:00:00.000Z' } });
    }
  });

  it('a removal that set no floor (no flag, or an empty conversation never cleared) answers exactly what the route always did: no data key', async () => {
    for (const query of ['', '?clearHistory=true', '?clearHistory=false']) {
      lifecycle.removeConversationForUser.mockResolvedValueOnce({ deleted: false, clearedUntil: null, attachmentKeys: [] });

      const res = await request(createApp()).delete(`/api/v1/dm/conv-1${query}`);

      expect(res.body, query).toStrictEqual({ success: true, message: 'Conversation deleted' });
      expect(Object.keys(res.body)).toEqual(['success', 'message']);
    }
  });

  it('the remover\'s sockets stay in dm:{id} (a later message brings it back), no file is deleted, and the route never writes the conversation row', async () => {
    await request(createApp()).delete('/api/v1/dm/conv-1?clearHistory=true');

    expect(io.mockSocketsLeave).not.toHaveBeenCalled();
    expect(io.mockLocalSocketsLeave).not.toHaveBeenCalled();
    expect(mockDeleteFromS3).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversation.upsert).not.toHaveBeenCalled();
    expect(prisma.conversation.delete).not.toHaveBeenCalled();
    expect(prisma.conversation.deleteMany).not.toHaveBeenCalled();
  });

  it('a call the REMOVER is in ends without a "call ended" notice (it would bring the conversation back), before the event, after the removal', async () => {
    for (const query of ['', '?clearHistory=true']) {
      io.order.length = 0;
      mockEndDMCallIfParticipant.mockClear();
      await request(createApp()).delete(`/api/v1/dm/conv-1${query}`);

      expect(mockEndDMCallIfParticipant).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'user-1', { notice: false });
      expect(io.order).toEqual(['removal', 'end call of the remover', 'emit dm:conversation:deleted']);
    }
    // never a call that is not the remover's: the other person ringing is left alone
    expect(mockEndDMCall).not.toHaveBeenCalled();
  });

  it('the early answers: 404 for a missing conversation, 403 for a non-participant (a NULL side admits nobody), and no removal', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    expect((await request(createApp()).delete('/api/v1/dm/conv-x')).status).toBe(404);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([], { user1Id: 'user-2', user2Id: 'user-3' }) as any);
    expect((await request(createApp()).delete('/api/v1/dm/conv-1')).status).toBe(403);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([], { user1Id: null, user2Id: 'user-2' }) as any);
    expect((await request(createApp()).delete('/api/v1/dm/conv-1')).status).toBe(403);
    expect(lifecycle.removeConversationForUser).not.toHaveBeenCalled();
  });

  it('a conversation deleted between the early answer and the lock answers 404, ending and announcing nothing', async () => {
    lifecycle.removeConversationForUser.mockRejectedValueOnce(new NotFoundError('Conversation'));

    const res = await request(createApp()).delete('/api/v1/dm/conv-1');

    expect(res.status).toBe(404);
    expect(mockEndDMCall).not.toHaveBeenCalled();
    expect(io.emits).toEqual([]);
  });

  it('a removal that fails ends no call and announces nothing', async () => {
    lifecycle.removeConversationForUser.mockRejectedValueOnce(new Error('db gone'));

    const res = await request(createApp()).delete('/api/v1/dm/conv-1');

    expect(res.status).toBe(500);
    expect(mockEndDMCall).not.toHaveBeenCalled();
    expect(io.emits).toEqual([]);
    expect(io.mockSocketsLeave).not.toHaveBeenCalled();
  });

  describe('when nobody can reach it any more (the rows were deleted)', () => {
    const keys = ['attachments/dm-conv-1/clmsg1-blob.bin', 'attachments/dm-conv-1/clmsg2-blob.bin'];

    beforeEach(() => {
      lifecycle.removeConversationForUser.mockImplementation(async () => {
        io.order.push('removal');
        return { deleted: true, clearedUntil: FLOOR, attachmentKeys: keys };
      });
    });

    it('the files go after the commit, the call ends, the remover is told, then the room is emptied on this node and cluster-wide', async () => {
      const res = await request(createApp()).delete('/api/v1/dm/conv-1?clearHistory=true');

      expect(res.status).toBe(200);
      // the floor this removal set, as for one that kept the conversation
      expect(res.body).toStrictEqual({ success: true, message: 'Conversation deleted', data: { clearedUntil: '2026-11-10T10:00:00.000Z' } });
      expect(mockDeleteFromS3).toHaveBeenCalledWith(keys);
      expect(io.order).toEqual(['removal', 'delete files', 'end call', 'emit dm:conversation:deleted', 'local leave', 'cluster leave']);
      // a deleted conversation ends whatever call is left in it, the other person's ring included
      expect(mockEndDMCall).toHaveBeenCalledWith(expect.anything(), 'conv-1', { notice: false });
      expect(mockEndDMCallIfParticipant).not.toHaveBeenCalled();
      expect(io.mockLocalIn).toHaveBeenCalledWith(['dm:conv-1']);
      expect(io.mockLocalSocketsLeave).toHaveBeenCalledWith(['dm:conv-1']);
      expect(io.mockIn).toHaveBeenCalledWith(['dm:conv-1']);
      expect(io.mockSocketsLeave).toHaveBeenCalledWith(['dm:conv-1']);
      // still the remover only
      expect(dmRoomEmits('dm:conversation:deleted')).toEqual([
        { to: 'user:user-1', except: null, event: 'dm:conversation:deleted', payload: { conversationId: 'conv-1', clearedUntil: '2026-11-10T10:00:00.000Z' } },
      ]);
    });

    it('never fetches the sockets (a fetch waits on every node and throws when one peer is unresponsive)', async () => {
      io.mockFetchSockets.mockRejectedValue(new Error('timeout reached while waiting for fetchSockets response'));
      try {
        const res = await request(createApp()).delete('/api/v1/dm/conv-1');
        expect(res.status).toBe(200);
        expect(io.mockFetchSockets).not.toHaveBeenCalled();
      } finally {
        io.mockFetchSockets.mockResolvedValue([]);
      }
    });
  });

  describe('the steps after the commit are best effort', () => {
    let errorLog: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      lifecycle.removeConversationForUser.mockResolvedValue({ deleted: true, clearedUntil: null, attachmentKeys: [] });
    });

    afterEach(() => errorLog.mockRestore());

    it('a call teardown that rejects still answers, tells the remover and empties the room', async () => {
      mockEndDMCall.mockRejectedValueOnce(new Error('redis gone'));

      const res = await request(createApp()).delete('/api/v1/dm/conv-1');

      expect(res.status).toBe(200);
      expect(dmRoomEmits('dm:conversation:deleted')).toHaveLength(1);
      expect(io.mockSocketsLeave).toHaveBeenCalledWith(['dm:conv-1']);
      expect(errorLog).toHaveBeenCalledWith('[DM] Conversation conv-1 removed, but ending its call failed:', 'redis gone');
    });

    it('a notice that throws still empties the room and answers 200', async () => {
      io.mockTo.mockImplementationOnce(() => { throw new Error('adapter publish failed'); });

      const res = await request(createApp()).delete('/api/v1/dm/conv-1');

      expect(res.status).toBe(200);
      expect(io.mockSocketsLeave).toHaveBeenCalledWith(['dm:conv-1']);
      expect(errorLog).toHaveBeenCalledWith('[DM] Conversation conv-1 removed, but the dm:conversation:deleted notice failed:', 'adapter publish failed');
    });

    it('a local room leave that throws still runs the cluster one and answers 200', async () => {
      io.mockLocalSocketsLeave.mockImplementationOnce(() => { throw new Error('local adapter failed'); });
      io.mockSocketsLeave.mockImplementationOnce(() => { throw new Error('cluster adapter failed'); });

      const res = await request(createApp()).delete('/api/v1/dm/conv-1');

      expect(res.status).toBe(200);
      expect(errorLog).toHaveBeenCalledWith('[DM] Conversation conv-1 removed, but the local room leave failed:', 'local adapter failed');
      expect(errorLog).toHaveBeenCalledWith('[DM] Conversation conv-1 removed, but the cluster room leave failed:', 'cluster adapter failed');
    });
  });
});


// ─── POST /dm: opening again ────────────────────────────────────────────────

describe('POST /dm — opening a conversation the caller removed', () => {
  const target = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, role: 'user', isSupporter: false, supporterTier: null };
  // `reads`: the caller's read row, loaded with the pair (their floor)
  const existing = { id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2', encryptedAt: new Date('2026-08-01T14:00:00Z'), createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01'), reads: [] as Array<{ clearedAt: Date | null }> };

  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(target as any);
  });

  it('an existing pair is reopened for the caller (their hidden mark cleared, their floor kept) and answered as before', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(existing as any);

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('conv-1');
    expect(lifecycle.reopenConversationForUser).toHaveBeenCalledWith('conv-1', 'user-1', 'user-2');
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    // nothing about it reaches the other person
    expect(io.emits).toEqual([]);
  });

  it('a pair whose conversation a removal deleted meanwhile gets a new conversation, created as any new one', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(existing as any);
    lifecycle.reopenConversationForUser.mockResolvedValueOnce('missing');
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce({ ...existing, id: 'conv-2' } as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('conv-2');
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { user1Id: 'user-1', user2Id: 'user-2' } });
    expect(prisma.conversationRead.createMany).toHaveBeenCalled();
    expect(io.mockSocketsJoin).toHaveBeenCalledWith('dm:conv-2');
  });

  it("the target's account deleted while the reopen waited (the conversation kept read-only): 404 User, never that account's profile, nothing created", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(existing as any);
    lifecycle.reopenConversationForUser.mockResolvedValueOnce('other-side-gone');

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'User not found' });
    expect(JSON.stringify(res.body)).not.toContain('bob');
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(io.mockSocketsJoin).not.toHaveBeenCalled();
  });

  it('the answer carries the row\'s own updatedAt, on the reopen path (nothing is written to move it) and on the create path', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...existing, updatedAt: new Date('2025-03-04T05:06:07.000Z') } as any);
    const reopened = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.updatedAt).toBe('2025-03-04T05:06:07.000Z');
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();

    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null as any);
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce({ ...existing, id: 'conv-9', updatedAt: new Date('2026-01-02T03:04:05.000Z') } as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);
    lifecycle.reopenConversationForUser.mockResolvedValueOnce('missing');
    const created = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });
    expect(created.status).toBe(201);
    expect(created.body.data.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('a new pair is created without a reopen', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce(existing as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);

    expect((await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' })).status).toBe(201);
    expect(lifecycle.reopenConversationForUser).not.toHaveBeenCalled();
  });

  it('the caller\'s floor is read with the pair, in the same statement, for the caller only', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(existing as any);

    await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(prisma.conversation.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { user1Id_user2Id: { user1Id: 'user-1', user2Id: 'user-2' } },
      include: { reads: { where: { userId: 'user-1' }, select: { clearedAt: true } } },
    });
    expect(prisma.conversationRead.findMany).not.toHaveBeenCalled();
  });

  it('reopening a conversation whose history the caller cleared answers their floor (clearedUntil), after the fields it always had', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...existing, reads: [{ clearedAt: FLOOR }] } as any);

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(res.body.data.clearedUntil).toBe('2026-11-10T10:00:00.000Z');
    expect(Object.keys(res.body.data)).toEqual(['id', 'user1Id', 'user2Id', 'participant', 'lastMessage', 'encryptedAt', 'createdAt', 'updatedAt', 'clearedUntil']);
  });

  it('no floor (no read row, or one that never cleared): no clearedUntil key at all', async () => {
    for (const reads of [[], [{ clearedAt: null }]]) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...existing, reads } as any);

      const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('clearedUntil');
    }
  });

  it('a pair whose conversation a removal deleted meanwhile: the new conversation has no floor, whatever the old one had', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ ...existing, reads: [{ clearedAt: FLOOR }] } as any);
    lifecycle.reopenConversationForUser.mockResolvedValueOnce('missing');
    vi.mocked(prisma.conversation.create).mockResolvedValueOnce({ ...existing, id: 'conv-2' } as any);
    vi.mocked(prisma.conversationRead.createMany).mockResolvedValueOnce({ count: 2 } as any);

    const res = await request(createApp()).post('/api/v1/dm').send({ userId: 'user-2' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('conv-2');
    expect(res.body.data).not.toHaveProperty('clearedUntil');
  });
});

// ─── GET /dm: the list ──────────────────────────────────────────────────────

describe('GET /dm — the caller\'s list', () => {
  const listed = (messages: unknown[], clearedAt: Date | null) => ({
    id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2', encryptedAt: new Date('2026-08-01T14:00:00Z'), createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01'),
    user1: alice, user2: bob, messages, reads: clearedAt === undefined ? [] : [{ clearedAt }],
  });

  it('leaves out, in the query, what the caller has hidden (so the 200 cap is never spent on it), and reads the caller\'s floor', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([]);

    await request(createApp()).get('/api/v1/dm');

    const args = vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any;
    expect(args.where).toEqual({
      OR: [{ user1Id: 'user-1' }, { user2Id: 'user-1' }],
      reads: { none: { userId: 'user-1', hiddenAt: { not: null } } },
    });
    expect(args.include.reads).toEqual({ where: { userId: 'user-1' }, select: { clearedAt: true } });
    expect(args.take).toBe(200);
  });

  it('the preview is never a row at or below the caller\'s floor', async () => {
    const newest = { id: 'm-1', content: validEnvelope, encrypted: true, type: 'user', createdAt: FLOOR, authorId: 'user-2' };
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      listed([newest], FLOOR),
      { ...listed([{ ...newest, createdAt: ABOVE }], FLOOR), id: 'conv-2' },
      { ...listed([newest], null), id: 'conv-3' },
      { ...listed([newest], null), id: 'conv-4', reads: [] },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.body.data.map((c: any) => c.lastMessage?.createdAt ?? null)).toEqual([
      null,
      '2026-11-11T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
    ]);
  });

  it('each conversation carries the caller\'s floor (clearedUntil, read with the list: no query of its own) only when there is one', async () => {
    const newest = { id: 'm-1', content: validEnvelope, encrypted: true, type: 'user', createdAt: ABOVE, authorId: 'user-2' };
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      listed([newest], FLOOR),
      // a cleared conversation with nothing above the floor: no preview, the floor still sent
      { ...listed([{ ...newest, createdAt: FLOOR }], FLOOR), id: 'conv-2' },
      { ...listed([newest], null), id: 'conv-3' },
      { ...listed([newest], null), id: 'conv-4', reads: [] },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.body.data.map((c: any) => c.clearedUntil)).toEqual(['2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z', undefined, undefined]);
    expect(res.body.data[1].lastMessage).toBeNull();
    expect(Object.keys(res.body.data[0])).toEqual(['id', 'user1Id', 'user2Id', 'participant', 'lastMessage', 'encryptedAt', 'createdAt', 'clearedUntil']);
    expect(Object.keys(res.body.data[2])).toEqual(['id', 'user1Id', 'user2Id', 'participant', 'lastMessage', 'encryptedAt', 'createdAt']);
    // the listed floors come with the list itself; the one read-row query is the hidden ones' (below)
    expect(prisma.conversation.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.conversationRead.findMany).toHaveBeenCalledTimes(1);
  });

  it('the floors of the conversations the caller removed (hidden, cleared) come beside the list as `cleared`, newest floor first, from one bounded query on the caller\'s read rows', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.conversationRead.findMany).mockResolvedValueOnce([
      { conversationId: 'conv-8', clearedAt: ABOVE },
      { conversationId: 'conv-9', clearedAt: FLOOR },
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: [],
      cleared: [
        { conversationId: 'conv-8', clearedUntil: '2026-11-11T10:00:00.000Z' },
        { conversationId: 'conv-9', clearedUntil: '2026-11-10T10:00:00.000Z' },
      ],
    });
    expect(prisma.conversationRead.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', hiddenAt: { not: null }, clearedAt: { not: null } },
      orderBy: { clearedAt: 'desc' },
      take: DM_CLEARED_LIST_MAX,
      select: { conversationId: true, clearedAt: true },
    });
    expect(DM_CLEARED_LIST_MAX).toBe(200);
  });

  it('no removed conversation with a floor: no `cleared` key, the body a 2.1.x client reads today', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([listed([], null)] as any);
    vi.mocked(prisma.conversationRead.findMany).mockResolvedValueOnce([]);

    const res = await request(createApp()).get('/api/v1/dm');

    expect(Object.keys(res.body)).toEqual(['success', 'data']);
  });

  it('a failing floor query never fails the list: it is answered without `cleared`, with one warning that names the error\'s type and code only', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([listed([], null)] as any);
    const failure = Object.assign(new Error('connection to db-host:5432 lost for user-1'), { name: 'PrismaClientKnownRequestError', code: 'P1001' });
    vi.mocked(prisma.conversationRead.findMany).mockRejectedValueOnce(failure);
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['success', 'data']);
    expect(res.body.data).toHaveLength(1);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog.mock.calls[0]).toEqual([
      '[DM] The conversation list is answered without the floors of removed conversations:',
      'PrismaClientKnownRequestError',
      'P1001',
    ]);
    warnLog.mockRestore();
  });

  it('a failing list query still answers the error', async () => {
    vi.mocked(prisma.conversation.findMany).mockRejectedValueOnce(new Error('db gone'));
    vi.mocked(prisma.conversationRead.findMany).mockResolvedValueOnce([]);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(createApp()).get('/api/v1/dm');

    expect(res.status).toBe(500);
    errorLog.mockRestore();
  });
});

// ─── GET /dm/:id/messages: every mode ───────────────────────────────────────

describe('GET /dm/:id/messages — nothing at or below the caller\'s floor', () => {
  it('without a floor the pages are what they were', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation() as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([]);

    await request(createApp()).get('/api/v1/dm/conv-1/messages');

    expect((vi.mocked(prisma.message.findMany).mock.calls[0][0] as any).where).toEqual({ conversationId: 'conv-1', AND: [{}, {}] });
  });

  it('the standard page and a `before` page stop at the floor', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation([read('user-1', FLOOR), read('user-2')]) as any);
    vi.mocked(prisma.message.findMany).mockResolvedValue([]);

    await request(createApp()).get('/api/v1/dm/conv-1/messages');
    await request(createApp()).get('/api/v1/dm/conv-1/messages?before=2026-11-12T00:00:00.000Z');

    const [first, second] = vi.mocked(prisma.message.findMany).mock.calls.map((c) => (c[0] as any).where);
    expect(first).toEqual({ conversationId: 'conv-1', AND: [{ createdAt: { gt: FLOOR } }, {}] });
    expect(second).toEqual({ conversationId: 'conv-1', AND: [{ createdAt: { gt: FLOOR } }, { createdAt: { lt: new Date('2026-11-12T00:00:00.000Z') } }] });
  });

  it('the other person\'s floor changes nothing for the caller', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([read('user-1'), read('user-2', FLOOR)]) as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([]);

    await request(createApp()).get('/api/v1/dm/conv-1/messages');

    expect((vi.mocked(prisma.message.findMany).mock.calls[0][0] as any).where.AND[0]).toEqual({});
  });

  it('`around` a target at or below the floor answers like a missing message; above it, both halves stop at the floor', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation([read('user-1', FLOOR)]) as any);

    for (const createdAt of [BELOW, FLOOR]) {
      vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-t', conversationId: 'conv-1', createdAt } as any);
      const res = await request(createApp()).get('/api/v1/dm/conv-1/messages?around=msg-t');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Message not found');
    }
    expect(prisma.message.findMany).not.toHaveBeenCalled();

    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-t', conversationId: 'conv-1', createdAt: ABOVE } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValue([]);
    const ok = await request(createApp()).get('/api/v1/dm/conv-1/messages?around=msg-t');
    expect(ok.status).toBe(200);
    const [older, newer] = vi.mocked(prisma.message.findMany).mock.calls.map((c) => (c[0] as any).where);
    expect(older).toEqual({ conversationId: 'conv-1', AND: [{ createdAt: { gt: FLOOR } }, { createdAt: { lte: ABOVE } }] });
    expect(newer).toEqual({ conversationId: 'conv-1', AND: [{ createdAt: { gt: FLOOR } }, { createdAt: { gt: ABOVE } }] });
  });

  it('a row that quotes one the caller cleared comes back with a deleted quote (replyTo null, replyToId kept); a quote above the floor is kept, without its time', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([read('user-1', FLOOR)]) as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([
      row({ id: 'msg-2', replyToId: 'msg-0', replyTo: quote(ABOVE) }),
      row({ id: 'msg-1', replyToId: 'msg-0', replyTo: quote(BELOW) }),
    ] as any);

    const res = await request(createApp()).get('/api/v1/dm/conv-1/messages');

    const [first, second] = res.body.data;
    expect(first.id).toBe('msg-1');
    expect(first.replyToId).toBe('msg-0');
    expect(first.replyTo).toBeNull();
    const { createdAt: _t, ...keptQuote } = quote(ABOVE);
    expect(second.replyTo).toStrictEqual(keptQuote);
    expect(second.replyTo).not.toHaveProperty('createdAt');
    // the quote's time is selected only to decide
    expect((vi.mocked(prisma.message.findMany).mock.calls[0][0] as any).include.replyTo.select.createdAt).toBe(true);
  });
});

// ─── POST /dm/:id/messages ──────────────────────────────────────────────────

describe('POST /dm/:id/messages — the write and its audience', () => {
  beforeEach(() => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation() as any);
    vi.mocked(prisma.message.create).mockResolvedValue({ id: 'msg-9' } as any);
    vi.mocked(prisma.message.findUniqueOrThrow).mockResolvedValue(row({ id: 'msg-9', createdAt: SEND_AT }) as any);
  });

  it('goes through the conversation-row-locked write, with the time the lock gave (after every floor)', async () => {
    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true });

    expect(res.status).toBe(201);
    expect(lifecycle.writeConversationMessage).toHaveBeenCalledWith('conv-1', 'user-1', expect.any(Function), expect.any(Function));
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { content: validEnvelope, encrypted: true, conversationId: 'conv-1', authorId: 'user-1', createdAt: SEND_AT },
    });
    // the bump lives in the write, after its commit: never here
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    // one emit, to the whole DM room
    expect(dmRoomEmits('dm:message:new')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: null })]);
  });

  it('a conversation deleted while the write waited answers 404, and nothing is sent', async () => {
    lifecycle.writeConversationMessage.mockRejectedValueOnce(new NotFoundError('Conversation'));

    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
    expect(io.emits).toEqual([]);
  });

  it('a reply to a message the caller cleared answers like one to a missing message, before any write', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation([read('user-1', FLOOR)]) as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ conversationId: 'conv-1', createdAt: BELOW } as any);

    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, replyToId: 'msg-0' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid replyToId');
    expect(lifecycle.writeConversationMessage).not.toHaveBeenCalled();
  });

  it('…and again under the lock, with the floor read there (a clear that committed meanwhile)', async () => {
    vi.mocked(prisma.message.findUnique)
      .mockResolvedValueOnce({ conversationId: 'conv-1', createdAt: BELOW } as any)
      .mockResolvedValueOnce({ conversationId: 'conv-1', createdAt: BELOW } as any);
    lifecycle.writeConversationMessage.mockImplementationOnce(writeAs({ sides: [read('user-1', FLOOR)], authorFloor: FLOOR }));

    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, replyToId: 'msg-0' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid replyToId');
    expect(prisma.message.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('a reply to a message of another conversation, or a missing one, is refused as before', async () => {
    for (const parent of [null, { conversationId: 'conv-2', createdAt: ABOVE }]) {
      vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(parent as any);
      const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, replyToId: 'msg-0' });
      expect(res.status).toBe(400);
    }
  });

  it('a reply quoting a row the OTHER side cleared: they get the row with a deleted quote, everyone else (the author included) the quote', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValue({ conversationId: 'conv-1', createdAt: BELOW } as any);
    vi.mocked(prisma.message.findUniqueOrThrow).mockResolvedValueOnce(row({ id: 'msg-9', createdAt: SEND_AT, replyToId: 'msg-0', replyTo: quote(BELOW) }) as any);
    lifecycle.writeConversationMessage.mockImplementationOnce(writeAs({ sides: [read('user-1'), read('user-2', FLOOR)] }));

    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true, replyToId: 'msg-0' });

    expect(res.status).toBe(201);
    const { createdAt: _t, ...keptQuote } = quote(BELOW);
    expect(res.body.data.replyTo).toStrictEqual(keptQuote);
    const emits = dmRoomEmits('dm:message:new');
    expect(emits).toHaveLength(2);
    expect(emits[0]).toMatchObject({ to: 'dm:conv-1', except: ['user:user-2'] });
    expect(emits[0].payload.replyTo).toStrictEqual(keptQuote);
    expect(emits[1]).toMatchObject({ to: 'user:user-2', except: null });
    expect(emits[1].payload.replyTo).toBeNull();
    expect(emits[1].payload.replyToId).toBe('msg-0');
    for (const e of emits) expect(JSON.stringify(e.payload)).not.toContain('2026-11-09');
  });

  it('a removal that committed between the write and its event: its floor decides, so the remover is not told (the audience is the one read after the commit)', async () => {
    // under the lock nobody had a floor; by the event the other side's floor is the new row itself
    lifecycle.writeConversationMessage.mockImplementationOnce(writeAs({
      sides: [read('user-1'), read('user-2')],
      audience: [read('user-1'), read('user-2', SEND_AT, SEND_AT)],
    }));

    const res = await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true });

    expect(res.status).toBe(201);
    expect(dmRoomEmits('dm:message:new')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: ['user:user-2'] })]);
  });

  it("the event goes out through the writer's announce, before the writer returns", async () => {
    let returned = false;
    lifecycle.writeConversationMessage.mockImplementationOnce(async (c: string, a: string, write: any, announce: any) => {
      const out = await writeAs()(c, a, write, (m: unknown, audience: unknown) => {
        expect(returned).toBe(false);
        announce(m, audience);
      });
      returned = true;
      return out;
    });

    await request(createApp()).post('/api/v1/dm/conv-1/messages').send({ content: validEnvelope, encrypted: true });

    expect(dmRoomEmits('dm:message:new')).toHaveLength(1);
  });
});

// ─── The actions on one message ─────────────────────────────────────────────

describe('edit, delete, reaction — a row the caller cleared answers like a missing one', () => {
  const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });

  beforeEach(() => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation([read('user-1', FLOOR), read('user-2')]) as any);
  });

  it('edit: 404 for a row at or below the floor, nothing updated or sent', async () => {
    for (const createdAt of [BELOW, FLOOR]) {
      vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(row({ createdAt }) as any);
      const res = await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });
      expect(res.status).toBe(404);
    }
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(io.emits).toEqual([]);
  });

  it('delete: 404 for a row at or below the floor, nothing deleted or sent', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...row({ createdAt: BELOW }), attachments: [] } as any);

    const res = await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1');

    expect(res.status).toBe(404);
    expect(prisma.message.delete).not.toHaveBeenCalled();
    expect(io.emits).toEqual([]);
  });

  it('reaction: 404 for a row at or below the floor, no reaction written', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1', createdAt: BELOW } as any);

    const res = await request(createApp()).put(`/api/v1/dm/conv-1/messages/msg-1/reactions/${encodeURIComponent('👍')}`);

    expect(res.status).toBe(404);
    expect(prisma.messageReaction.findUnique).not.toHaveBeenCalled();
    expect(prisma.messageReaction.createMany).not.toHaveBeenCalled();
    expect((vi.mocked(prisma.message.findUnique).mock.calls[0][0] as any).select).toEqual({ id: true, conversationId: true, createdAt: true });
  });
});

describe('edit, delete, reaction — the events skip a side that cleared the row', () => {
  // the caller (user-1) has no floor; user-2 cleared up to FLOOR. The view is
  // read before the action, the audience again after it
  beforeEach(() => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation([read('user-1'), read('user-2', FLOOR)]) as any);
    vi.mocked(prisma.conversationRead.findMany).mockResolvedValue([read('user-1'), read('user-2', FLOOR)] as any);
  });

  it('the audience is read after the action: a floor set meanwhile decides, though the view read before showed none', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(conversation([read('user-1'), read('user-2')]) as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...row({ createdAt: BELOW }), attachments: [] } as any);
    vi.mocked(prisma.message.delete).mockResolvedValueOnce({} as any);

    await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1');

    expect(prisma.conversationRead.findMany).toHaveBeenCalledWith({ where: { conversationId: 'conv-1' }, select: { userId: true, hiddenAt: true, clearedAt: true } });
    expect(vi.mocked(prisma.conversationRead.findMany).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(prisma.message.delete).mock.invocationCallOrder[0]);
    expect(dmRoomEmits('dm:message:delete')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: ['user:user-2'] })]);
  });

  it('an edit of an old row the other side cleared reaches the DM room without them', async () => {
    const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(row({ createdAt: BELOW }) as any);
    vi.mocked(prisma.message.update).mockResolvedValueOnce(row({ createdAt: BELOW, content: editEnvelope, editedAt: SEND_AT }) as any);

    const res = await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });

    expect(res.status).toBe(200);
    expect(dmRoomEmits('dm:message:update')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: ['user:user-2'] })]);
  });

  it('an edit of a recent row reaches everyone: one emit, no exception', async () => {
    const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(row({ createdAt: ABOVE }) as any);
    vi.mocked(prisma.message.update).mockResolvedValueOnce(row({ createdAt: ABOVE, content: editEnvelope }) as any);

    await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });

    expect(dmRoomEmits('dm:message:update')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: null })]);
  });

  it('the caller\'s own answer to an edit drops a quote the caller cleared', async () => {
    const editEnvelope = JSON.stringify({ v: 1, e: 'olm1', t: 1, b: 'ZWRpdGVkY2lwaGVydGV4dA' });
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([read('user-1', FLOOR), read('user-2')]) as any);
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(row({ createdAt: ABOVE }) as any);
    vi.mocked(prisma.message.update).mockResolvedValueOnce(row({ createdAt: ABOVE, replyToId: 'msg-0', replyTo: quote(BELOW) }) as any);

    const res = await request(createApp()).patch('/api/v1/dm/conv-1/messages/msg-1').send({ content: editEnvelope, encrypted: true });

    expect(res.body.data.replyTo).toBeNull();
    expect(res.body.data.replyToId).toBe('msg-0');
  });

  it('a delete and a reaction on an old row skip the side that cleared it', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ ...row({ createdAt: BELOW }), attachments: [] } as any);
    vi.mocked(prisma.message.delete).mockResolvedValueOnce({} as any);
    await request(createApp()).delete('/api/v1/dm/conv-1/messages/msg-1');

    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'msg-1', conversationId: 'conv-1', createdAt: BELOW } as any);
    vi.mocked(prisma.messageReaction.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.messageReaction.groupBy).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.messageReaction.createMany).mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(prisma.messageReaction.findMany).mockResolvedValueOnce([] as any);
    await request(createApp()).put(`/api/v1/dm/conv-1/messages/msg-1/reactions/${encodeURIComponent('👍')}`);

    expect(dmRoomEmits('dm:message:delete')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: ['user:user-2'] })]);
    expect(dmRoomEmits('dm:message:reaction_update')).toEqual([expect.objectContaining({ to: 'dm:conv-1', except: ['user:user-2'] })]);
  });
});

// ─── POST /dm/:id/read ──────────────────────────────────────────────────────

describe('POST /dm/:id/read', () => {
  it('moves the last read only, never the caller\'s removal state', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([read('user-1', FLOOR, FLOOR)]) as any);
    vi.mocked(prisma.conversationRead.upsert).mockResolvedValueOnce({} as any);

    const res = await request(createApp()).post('/api/v1/dm/conv-1/read');

    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.conversationRead.upsert).mock.calls[0][0] as any;
    expect(Object.keys(args.update)).toEqual(['lastReadAt']);
    expect(Object.keys(args.create).sort()).toEqual(['conversationId', 'lastReadAt', 'userId']);
  });

  it('a non-participant is refused through the same view (403), and nothing is written', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversation([], { user1Id: null, user2Id: 'user-2' }) as any);

    expect((await request(createApp()).post('/api/v1/dm/conv-1/read')).status).toBe(403);
    expect(prisma.conversationRead.upsert).not.toHaveBeenCalled();
  });
});
