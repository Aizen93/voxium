import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { E2E_SCOPE_STATES_MAX } from '@voxium/shared';

/**
 * POST /e2e/scopes/states: a device names the scopes its plaintext cache
 * holds (direct conversations, and secure channels as `ch:{channelId}`) and
 * learns, per scope, what the caller can still reach of it. A scope that is
 * not the caller's answers exactly like one that never existed, from the same
 * statements; one statement per kind of scope asked, whatever the count; the
 * route writes nothing.
 *
 * Prisma is replaced by a recorder that runs the route's `where` against a
 * small in-memory schema (the clauses the route builds are what decide each
 * state here, as they do on PostgreSQL) and fails on any other operation.
 */

const ME = 'user-me';
const OTHER = 'user-other';
const THIRD = 'user-third';

interface ConversationRow { id: string; user1Id: string | null; user2Id: string | null }
interface ReadRow { userId: string; conversationId: string; hiddenAt: Date | null; clearedAt: Date | null }
interface ChannelRow { id: string; secure: boolean; serverId: string }

const h = vi.hoisted(() => {
  const db = {
    conversations: [] as Array<{ id: string; user1Id: string | null; user2Id: string | null }>,
    reads: [] as Array<{ userId: string; conversationId: string; hiddenAt: Date | null; clearedAt: Date | null }>,
    channels: [] as Array<{ id: string; secure: boolean; serverId: string }>,
    channelMembers: [] as Array<{ channelId: string; userId: string }>,
    serverMembers: [] as Array<{ serverId: string; userId: string }>,
  };
  /** Every operation the route ran, in order, with its arguments. */
  const calls: Array<{ op: string; args: unknown }> = [];
  const handlers: Record<string, (args: any) => unknown> = {};
  const prisma = new Proxy({}, {
    get(_target, model: string | symbol) {
      return new Proxy({}, {
        get(_inner, op: string | symbol) {
          return (args: unknown) => {
            const name = `${String(model)}.${String(op)}`;
            calls.push({ op: name, args });
            const handler = handlers[name];
            if (!handler) return Promise.reject(new Error(`e2eScopeStates.test: unexpected statement ${name}`));
            return Promise.resolve(handler(args));
          };
        },
      });
    },
  });
  return { db, calls, handlers, prisma, user: { userId: 'user-me' } };
});

vi.mock('../../utils/prisma', () => ({ prisma: h.prisma }));

const gates = vi.hoisted(() => ({
  authenticate: vi.fn((req: any, _res: any, next: any) => {
    req.user = { userId: h.user.userId, username: 'me', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  }),
  requireVerifiedEmail: vi.fn((_req: any, _res: any, next: any) => next()),
  requireConsent: vi.fn((_req: any, _res: any, next: any) => next()),
}));
vi.mock('../../middleware/auth', () => gates);

const limiters = vi.hoisted(() => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitE2EDevice: vi.fn(passthrough),
    rateLimitE2EKeys: vi.fn(passthrough),
    rateLimitE2EBundle: vi.fn(passthrough),
    rateLimitE2EStatus: vi.fn(passthrough),
    rateLimitE2EShares: vi.fn(passthrough),
    rateLimitE2EShareAck: vi.fn(passthrough),
    rateLimitE2EScopeStates: vi.fn(passthrough),
    rateLimitE2EApprove: vi.fn(passthrough),
  };
});
vi.mock('../../middleware/rateLimiter', () => limiters);

import { e2eRouter } from '../../routes/e2e';
import { errorHandler } from '../../middleware/errorHandler';

// ─── The in-memory schema the recorded `where` clauses are run against ───────

/** conversation.findMany as the route calls it: `id in`, a side is the caller, the caller's own read row. */
h.handlers['conversation.findMany'] = (args: {
  where: { id: { in: string[] }; OR?: Array<{ user1Id?: string; user2Id?: string }> };
  select: { id: true; reads: { where: { userId: string }; select: { hiddenAt: true; clearedAt: true } } };
}) => {
  const ids = new Set(args.where.id.in);
  // no side clause: every conversation of those ids is read
  const side = (c: ConversationRow) =>
    !args.where.OR || args.where.OR.some((clause) =>
      ('user1Id' in clause && c.user1Id === clause.user1Id) || ('user2Id' in clause && c.user2Id === clause.user2Id));
  return h.db.conversations
    .filter((c) => ids.has(c.id) && side(c))
    .map((c) => ({
      id: c.id,
      reads: h.db.reads
        .filter((r) => r.conversationId === c.id && r.userId === args.select.reads.where.userId)
        .map((r) => ({ hiddenAt: r.hiddenAt, clearedAt: r.clearedAt })),
    }));
};

/** channel.findMany as the route calls it: `id in`, secure, a ChannelMember row, a membership of the channel's space. */
h.handlers['channel.findMany'] = (args: {
  where: {
    id: { in: string[] };
    secure?: boolean;
    members?: { some: { userId: string } };
    server?: { members: { some: { userId: string } } };
  };
}) => {
  const { where } = args;
  const ids = new Set(where.id.in);
  return h.db.channels
    .filter((c) => ids.has(c.id))
    .filter((c) => where.secure === undefined || c.secure === where.secure)
    .filter((c) => !where.members || h.db.channelMembers.some((m) => m.channelId === c.id && m.userId === where.members!.some.userId))
    .filter((c) => !where.server || h.db.serverMembers.some((m) => m.serverId === c.serverId && m.userId === where.server!.members.some.userId))
    .map((c) => ({ id: c.id }));
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/e2e', e2eRouter);
  app.use(errorHandler);
  return app;
}

const ask = (scopes: unknown, body?: unknown) =>
  request(createApp()).post('/api/v1/e2e/scopes/states').send(body === undefined ? { scopes } : (body as object));

const FLOOR = new Date('2026-11-20T10:00:00.000Z');
const HIDDEN_AT = new Date('2026-11-20T10:05:00.000Z');

function conversation(id: string, user1Id: string | null, user2Id: string | null) {
  h.db.conversations.push({ id, user1Id, user2Id });
}
function read(conversationId: string, over: Partial<ReadRow> = {}) {
  h.db.reads.push({ userId: ME, conversationId, hiddenAt: null, clearedAt: null, ...over });
}
function channel(id: string, over: Partial<ChannelRow> = {}) {
  h.db.channels.push({ id, secure: true, serverId: 'space-1', ...over });
}

beforeEach(() => {
  h.db.conversations = [];
  h.db.reads = [];
  h.db.channels = [];
  h.db.channelMembers = [];
  h.db.serverMembers = [];
  h.calls.length = 0;
  h.user.userId = ME;
  vi.clearAllMocks();
});

describe('POST /e2e/scopes/states — direct conversations', () => {
  it('answers open, hidden, hidden with a floor, open with a floor, each from the caller\'s own read row', async () => {
    conversation('c-open', ME, OTHER);
    conversation('c-open-unread', OTHER, ME); // no read row yet: open
    conversation('c-hidden', ME, OTHER);
    read('c-hidden', { hiddenAt: HIDDEN_AT });
    conversation('c-hidden-floor', ME, THIRD);
    read('c-hidden-floor', { hiddenAt: HIDDEN_AT, clearedAt: FLOOR });
    conversation('c-open-floor', THIRD, ME);
    read('c-open-floor', { clearedAt: FLOOR });
    read('c-open');
    // the OTHER person's read row says hidden: it is not the caller's
    h.db.reads.push({ userId: OTHER, conversationId: 'c-open', hiddenAt: HIDDEN_AT, clearedAt: FLOOR });

    const res = await ask(['c-open', 'c-open-unread', 'c-hidden', 'c-hidden-floor', 'c-open-floor']);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        { scope: 'c-open', state: 'open' },
        { scope: 'c-open-unread', state: 'open' },
        { scope: 'c-hidden', state: 'hidden' },
        { scope: 'c-hidden-floor', state: 'hidden', clearedUntil: FLOOR.toISOString() },
        { scope: 'c-open-floor', state: 'open', clearedUntil: FLOOR.toISOString() },
      ],
    });
  });

  it('a conversation whose other side is a deleted account is still the caller\'s: open', async () => {
    conversation('c-kept', null, ME);
    const res = await ask(['c-kept']);
    expect(res.body.data).toEqual([{ scope: 'c-kept', state: 'open' }]);
  });

  it('answers gone, the same way, for an unknown id, another pair\'s conversation and a deleted one', async () => {
    conversation('c-theirs', OTHER, THIRD);
    read('c-theirs', { hiddenAt: HIDDEN_AT, clearedAt: FLOOR }); // even a row under the caller's id gives nothing
    // 'c-deleted' was the caller's: its row is gone, and so are its read rows (cascade)

    const res = await ask(['c-unknown', 'c-theirs', 'c-deleted']);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { scope: 'c-unknown', state: 'gone' },
      { scope: 'c-theirs', state: 'gone' },
      { scope: 'c-deleted', state: 'gone' },
    ]);
  });

  it('another pair\'s conversation costs exactly the statements of one that never existed, and answers the same body', async () => {
    conversation('c-theirs', OTHER, THIRD);
    read('c-theirs', { clearedAt: FLOOR });

    const theirs = await ask(['c-theirs']);
    const theirsCalls = JSON.stringify(h.calls).replaceAll('c-theirs', 'X');
    h.calls.length = 0;
    const unknown = await ask(['c-unknown']);
    const unknownCalls = JSON.stringify(h.calls).replaceAll('c-unknown', 'X');

    expect(theirs.status).toBe(unknown.status);
    expect(JSON.stringify(theirs.body).replaceAll('c-theirs', 'X')).toBe(JSON.stringify(unknown.body).replaceAll('c-unknown', 'X'));
    expect(theirsCalls).toBe(unknownCalls);
    expect(h.calls.map((c) => c.op)).toEqual(['conversation.findMany']);
  });

  it('the conversation statement filters on the caller as a side and loads only the caller\'s read row', async () => {
    await ask(['c-1', 'c-2']);
    expect(h.calls).toEqual([
      {
        op: 'conversation.findMany',
        args: {
          where: { id: { in: ['c-1', 'c-2'] }, OR: [{ user1Id: ME }, { user2Id: ME }] },
          select: { id: true, reads: { where: { userId: ME }, select: { hiddenAt: true, clearedAt: true } } },
        },
      },
    ]);
  });
});

describe('POST /e2e/scopes/states — secure channels', () => {
  beforeEach(() => {
    h.db.serverMembers.push({ serverId: 'space-1', userId: ME }, { serverId: 'space-2', userId: OTHER });
  });

  it('answers open for a secure channel the caller is a member of, in a space they are a member of; never hidden, never a floor', async () => {
    channel('ch-1');
    h.db.channelMembers.push({ channelId: 'ch-1', userId: ME });
    const res = await ask(['ch:ch-1']);
    expect(res.body).toEqual({ success: true, data: [{ scope: 'ch:ch-1', state: 'open' }] });
  });

  it('answers gone for an unknown channel, a channel that is not secure, one the caller is no member of, and a ChannelMember row without the space membership', async () => {
    channel('ch-plain', { secure: false });
    h.db.channelMembers.push({ channelId: 'ch-plain', userId: ME });
    channel('ch-not-member');
    h.db.channelMembers.push({ channelId: 'ch-not-member', userId: OTHER });
    channel('ch-no-space', { serverId: 'space-2' });
    h.db.channelMembers.push({ channelId: 'ch-no-space', userId: ME });

    const res = await ask(['ch:ch-unknown', 'ch:ch-plain', 'ch:ch-not-member', 'ch:ch-no-space']);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { scope: 'ch:ch-unknown', state: 'gone' },
      { scope: 'ch:ch-plain', state: 'gone' },
      { scope: 'ch:ch-not-member', state: 'gone' },
      { scope: 'ch:ch-no-space', state: 'gone' },
    ]);
  });

  it('a channel the caller may not see costs exactly the statements of one that never existed', async () => {
    channel('ch-not-member');
    h.db.channelMembers.push({ channelId: 'ch-not-member', userId: OTHER });

    await ask(['ch:ch-not-member']);
    const hidden = JSON.stringify(h.calls).replaceAll('ch-not-member', 'X');
    h.calls.length = 0;
    await ask(['ch:ch-unknown']);
    expect(JSON.stringify(h.calls).replaceAll('ch-unknown', 'X')).toBe(hidden);
    expect(h.calls).toEqual([
      {
        op: 'channel.findMany',
        args: {
          where: { id: { in: ['ch-unknown'] }, secure: true, members: { some: { userId: ME } }, server: { members: { some: { userId: ME } } } },
          select: { id: true },
        },
      },
    ]);
  });
});

describe('POST /e2e/scopes/states — the answer and the statements', () => {
  it('answers one entry per scope, in the order asked, conversations and channels mixed', async () => {
    conversation('c-a', ME, OTHER);
    h.db.serverMembers.push({ serverId: 'space-1', userId: ME });
    channel('ch-b');
    h.db.channelMembers.push({ channelId: 'ch-b', userId: ME });

    const res = await ask(['ch:ch-gone', 'c-a', 'ch:ch-b', 'c-gone']);

    expect(res.body.data.map((e: { scope: string }) => e.scope)).toEqual(['ch:ch-gone', 'c-a', 'ch:ch-b', 'c-gone']);
    expect(res.body.data.map((e: { state: string }) => e.state)).toEqual(['gone', 'open', 'open', 'gone']);
  });

  it('runs one statement per kind of scope asked, whatever the number of scopes, and nothing else (no write, no lock)', async () => {
    await ask(['c-1', 'ch:ch-1']);
    expect(h.calls.map((c) => c.op)).toEqual(['conversation.findMany', 'channel.findMany']);

    h.calls.length = 0;
    const many = Array.from({ length: E2E_SCOPE_STATES_MAX }, (_, i) => (i % 2 ? `c-${i}` : `ch:ch-${i}`));
    const res = await ask(many);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(E2E_SCOPE_STATES_MAX);
    expect(h.calls.map((c) => c.op)).toEqual(['conversation.findMany', 'channel.findMany']);

    // a request naming one kind only runs that kind's statement
    h.calls.length = 0;
    await ask(['ch:ch-1', 'ch:ch-2']);
    expect(h.calls.map((c) => c.op)).toEqual(['channel.findMany']);
  });

  it('runs behind the router\'s authentication, verified-e-mail and consent gates, and its own limiter alone', async () => {
    const res = await ask(['c-1']);
    expect(res.status).toBe(200);
    expect(gates.authenticate).toHaveBeenCalledTimes(1);
    expect(gates.requireVerifiedEmail).toHaveBeenCalledTimes(1);
    expect(gates.requireConsent).toHaveBeenCalledTimes(1);
    expect(limiters.rateLimitE2EScopeStates).toHaveBeenCalledTimes(1);
    for (const [name, limiter] of Object.entries(limiters)) {
      if (name !== 'rateLimitE2EScopeStates') expect(limiter, name).not.toHaveBeenCalled();
    }
  });

  it('a request the limiter refuses reads nothing', async () => {
    limiters.rateLimitE2EScopeStates.mockImplementationOnce((_req: any, res: any) => {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    });
    const res = await ask(['c-1']);
    expect(res.status).toBe(429);
    expect(h.calls).toEqual([]);
  });

  it('a failing statement is a 500, never an answer', async () => {
    const original = h.handlers['conversation.findMany'];
    h.handlers['conversation.findMany'] = () => { throw new Error('connection lost'); };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await ask(['c-1']);
      expect(res.status).toBe(500);
      expect(res.body.data).toBeUndefined();
    } finally {
      h.handlers['conversation.findMany'] = original;
      error.mockRestore();
    }
  });
});

describe('POST /e2e/scopes/states — a malformed request is a 400 before any statement', () => {
  const entry = 'scopes[0]: a scope is a conversation id, or ch: followed by a channel id';
  const count = `scopes must contain 1–${E2E_SCOPE_STATES_MAX} entries`;

  it.each([
    ['no body field', undefined, {}, count],
    ['not a list', 'c-1', undefined, count],
    ['an empty list', [], undefined, count],
    ['more than the maximum', Array.from({ length: E2E_SCOPE_STATES_MAX + 1 }, (_, i) => `c-${i}`), undefined, count],
    ['an entry that is not a string', [42], undefined, entry],
    ['an empty entry', [''], undefined, entry],
    ['a voice scope', ['chv:ch-1'], undefined, entry],
    ['ch: alone', ['ch:'], undefined, entry],
    ['ch: with an id the route does not take', ['ch:a:b'], undefined, entry],
    ['an id with a colon', ['a:b'], undefined, entry],
    ['an id with a space', ['c 1'], undefined, entry],
    ['an id longer than 64 characters', ['c'.repeat(65)], undefined, entry],
  ])('%s', async (_what, scopes, body, error) => {
    const res = await ask(scopes, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error });
    expect(h.calls).toEqual([]);
  });

  it('names the entry that is wrong', async () => {
    const res = await ask(['c-1', 'ch:ch-1', 'chv:ch-2']);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('scopes[2]: a scope is a conversation id, or ch: followed by a channel id');
    expect(h.calls).toEqual([]);
  });

  it('refuses a scope named twice', async () => {
    const res = await ask(['c-1', 'ch:ch-1', 'c-1']);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Duplicate scopes in batch' });
    expect(h.calls).toEqual([]);
  });

  it('takes exactly the maximum, and ids of 64 characters', async () => {
    const res = await ask([...Array.from({ length: E2E_SCOPE_STATES_MAX - 2 }, (_, i) => `c-${i}`), 'c'.repeat(64), `ch:${'d'.repeat(64)}`]);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(E2E_SCOPE_STATES_MAX);
  });
});
