import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ userId: 'user-1' }));

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: state.userId, username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
  requireConsent: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitMessageSend: passthrough, rateLimitGeneral: passthrough, rateLimitDmOpen: passthrough,
    rateLimitInteract: passthrough, rateLimitMarkRead: passthrough,
  };
});
vi.mock('../../websocket/socketServer', () => ({ getIO: vi.fn() }));
vi.mock('../../websocket/dmVoiceHandler', () => ({ endDMCall: vi.fn(), endDMCallIfParticipant: vi.fn() }));
vi.mock('../../utils/conversationLifecycle', () => ({
  writeConversationMessage: vi.fn(),
  removeConversationForUser: vi.fn(),
  reopenConversationForUser: vi.fn(),
  changeConversationMessage: vi.fn(),
}));
vi.mock('../../utils/s3', () => ({ VALID_ATTACHMENT_KEY_RE: /x/, deleteMultipleFromS3: vi.fn() }));
vi.mock('../../utils/uploadVerification', () => ({ verifyAttachmentUploads: vi.fn() }));
vi.mock('../../utils/prisma', () => ({
  prisma: { conversation: { findMany: vi.fn() }, conversationRead: { findMany: vi.fn() } },
}));

import { prisma } from '../../utils/prisma';
import { dmRouter } from '../../routes/dm';
import { errorHandler } from '../../middleware/errorHandler';
import { encodeDmListCursor, dmListAccountDigest } from '../../utils/dmListCursor';
import { encodeSignedCursor } from '../../utils/signedCursor';

const alice = { id: 'user-1', username: 'alice', displayName: 'Alice', avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null };
const other = (n: number) => ({ id: `peer-${n}`, username: `p${n}`, displayName: `P${n}`, avatarUrl: null, status: 'online', role: 'user', isSupporter: false, supporterTier: null });

interface Row { id: string; updatedAt: Date; n: number; user2Id?: string | null; floor?: Date | null }
const at = (day: string) => new Date(`2026-11-0${day}T10:00:00.000Z`);

/** What the store would return for the route's where/orderBy/take, over `rows`. */
function fakeStore(rows: Row[]) {
  vi.mocked(prisma.conversation.findMany).mockImplementation((async (args: any) => {
    const cursorOr = args.where.AND?.[0]?.OR as Array<any> | undefined;
    let out = rows.filter((r) => {
      if (!cursorOr) return true;
      const [lt, tie] = cursorOr;
      return r.updatedAt < lt.updatedAt.lt || (r.updatedAt.getTime() === tie.updatedAt.getTime() && r.id < tie.id.lt);
    });
    out = [...out].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1));
    return out.slice(0, args.take).map((r) => ({
      id: r.id,
      user1Id: 'user-1',
      user2Id: r.user2Id === undefined ? `peer-${r.n}` : r.user2Id,
      user1: alice,
      user2: r.user2Id === null ? null : other(r.n),
      encryptedAt: at('1'),
      createdAt: at('1'),
      updatedAt: r.updatedAt,
      messages: [{ id: `m-${r.id}`, content: 'x', encrypted: true, type: 'user', createdAt: at('2'), authorId: 'user-1' }],
      reads: r.floor ? [{ clearedAt: r.floor }] : [],
    }));
  }) as any);
}

function app() {
  const a = express();
  a.use('/dm', dmRouter);
  a.use(errorHandler);
  return a;
}

const ids = (res: request.Response) => res.body.data.map((c: any) => c.id);
const five = () => Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, updatedAt: at(String(i + 1)), n: i }));

describe('GET /dm paged by a signed keyset cursor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userId = 'user-1';
    vi.mocked(prisma.conversationRead.findMany).mockReset().mockResolvedValue([]);
  });

  it('legacy mode (neither parameter): one answer of take 200, no nextCursor, no keyset predicate', async () => {
    fakeStore(five());
    const res = await request(app()).get('/dm');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['success', 'data']);
    // the legacy rows carry no updatedAt
    expect(res.body.data.every((c: any) => !('updatedAt' in c))).toBe(true);
    expect(ids(res)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0']);
    const args = vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any;
    expect(args.take).toBe(200);
    expect(args.where.AND).toBeUndefined();
    expect(prisma.conversationRead.findMany).toHaveBeenCalledTimes(1);
  });

  it('first page, second page, last page (no nextCursor), no row twice and none missing', async () => {
    fakeStore(five());
    const p1 = await request(app()).get('/dm?limit=2');
    expect(ids(p1)).toEqual(['c4', 'c3']);
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await request(app()).get('/dm').query({ limit: '2', cursor: p1.body.nextCursor });
    expect(ids(p2)).toEqual(['c2', 'c1']);
    const p3 = await request(app()).get('/dm').query({ limit: '2', cursor: p2.body.nextCursor });
    expect(ids(p3)).toEqual(['c0']);
    expect('nextCursor' in p3.body).toBe(false);
  });

  it('a paged row carries the updatedAt the list was ordered by', async () => {
    fakeStore(five().slice(0, 2));
    const res = await request(app()).get('/dm?limit=5');
    expect(res.body.data.map((c: any) => c.updatedAt)).toEqual([at('2').toISOString(), at('1').toISOString()]);
  });

  it('an exact fit has no nextCursor (limit + 1 rows are read to know)', async () => {
    fakeStore([{ id: 'a', updatedAt: at('1'), n: 1 }, { id: 'b', updatedAt: at('2'), n: 2 }]);
    const res = await request(app()).get('/dm?limit=2');
    expect(ids(res)).toEqual(['b', 'a']);
    expect('nextCursor' in res.body).toBe(false);
    expect((vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any).take).toBe(3);
  });

  it('equal updatedAt values: the id breaks the tie and a page boundary inside the tie loses nothing', async () => {
    fakeStore(['a', 'b', 'c', 'd', 'e'].map((id, n) => ({ id, updatedAt: at('3'), n })));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await request(app()).get('/dm').query({ limit: '2', ...(cursor ? { cursor } : {}) });
      seen.push(...ids(res));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect((vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any).orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
  });

  it('the page size is 50 with a cursor alone and is capped at 100', async () => {
    fakeStore([]);
    await request(app()).get('/dm?limit=100000');
    expect((vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any).take).toBe(101);
    const cursor = encodeDmListCursor('user-1', { updatedAt: at('1'), id: 'c' });
    await request(app()).get('/dm').query({ cursor });
    expect((vi.mocked(prisma.conversation.findMany).mock.calls[1][0] as any).take).toBe(51);
  });

  it.each(['0', '-1', 'abc', '', '1.5', '2e1', ' 3'])('a malformed limit %j is a 400', async (limit) => {
    fakeStore([]);
    const res = await request(app()).get('/dm').query({ limit });
    expect(res.status).toBe(400);
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('a cursor of another account, another scope, a tampered one and garbage are a 400', async () => {
    fakeStore([]);
    const mine = encodeDmListCursor('user-1', { updatedAt: at('1'), id: 'c' });
    const theirs = encodeDmListCursor('user-2', { updatedAt: at('1'), id: 'c' });
    // right account digest and fields, signed under ANOTHER scope
    const foreign = encodeSignedCursor('members', { a: dmListAccountDigest('user-1'), updatedAt: at('1').toISOString(), id: 'c' });
    const forged = Buffer.from(JSON.stringify({ a: 'x', updatedAt: at('1').toISOString(), id: 'zzz' })).toString('base64url');
    const tampered = `${forged}.${mine.split('.')[1]}`;
    for (const cursor of [theirs, foreign, tampered, 'garbage', '']) {
      const res = await request(app()).get('/dm').query({ cursor });
      expect(res.status).toBe(400);
    }
    expect((await request(app()).get('/dm').query({ cursor: mine })).status).toBe(200);
  });

  it('a correctly signed cursor with an invalid date, an over-long id or a wrong field type is a 400', async () => {
    fakeStore([]);
    const a = dmListAccountDigest('user-1');
    const bad = [
      { a, updatedAt: 'not a date', id: 'c' },
      { a, updatedAt: at('1').toISOString(), id: 'x'.repeat(65) },
      { a, updatedAt: at('1').toISOString(), id: '' },
      { a, updatedAt: at('1').toISOString(), id: 7 },
      { a: 'zz', updatedAt: at('1').toISOString(), id: 'c' },
    ];
    for (const payload of bad) {
      const res = await request(app()).get('/dm').query({ cursor: encodeSignedCursor('dm-list', payload) });
      expect(res.status).toBe(400);
    }
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('a repeated limit or cursor is a 400', async () => {
    fakeStore([]);
    // express parses a repeated key as an array; the production app also refuses it earlier (singleValueQuery)
    expect((await request(app()).get('/dm?limit=2&limit=3')).status).toBe(400);
    const c = encodeDmListCursor('user-1', { updatedAt: at('1'), id: 'c' });
    expect((await request(app()).get(`/dm?cursor=${c}&cursor=${c}`)).status).toBe(400);
  });

  it('the cursor holds the account digest and the last key, never a participant id', async () => {
    fakeStore(five().slice(0, 3));
    const res = await request(app()).get('/dm?limit=1');
    const payload = JSON.parse(Buffer.from(res.body.nextCursor.split('.')[0], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['a', 'id', 'updatedAt']);
    expect(JSON.stringify(payload)).not.toMatch(/peer-|user-1/);
  });

  it('the cleared floors ride on the first page only', async () => {
    fakeStore(five().slice(0, 3));
    vi.mocked(prisma.conversationRead.findMany).mockResolvedValue([{ conversationId: 'gone', clearedAt: at('5') }] as any);
    const p1 = await request(app()).get('/dm?limit=2');
    expect(p1.body.cleared).toEqual([{ conversationId: 'gone', clearedUntil: at('5').toISOString() }]);
    const p2 = await request(app()).get('/dm').query({ limit: '2', cursor: p1.body.nextCursor });
    expect('cleared' in p2.body).toBe(false);
    expect(prisma.conversationRead.findMany).toHaveBeenCalledTimes(1);
  });

  it('a hidden conversation is left out by the query on every page; a cleared one keeps its floor and preview rule across the boundary', async () => {
    fakeStore([
      { id: 'a', updatedAt: at('1'), n: 1 },
      { id: 'b', updatedAt: at('2'), n: 2, floor: at('9') },
      { id: 'c', updatedAt: at('3'), n: 3 },
    ]);
    const p1 = await request(app()).get('/dm?limit=2');
    const p2 = await request(app()).get('/dm').query({ limit: '2', cursor: p1.body.nextCursor });
    expect(ids(p2)).toEqual(['a']);
    expect(ids(p1)).toEqual(['c', 'b']);
    expect(p1.body.data[1]).toMatchObject({ id: 'b', lastMessage: null, clearedUntil: at('9').toISOString() });
    for (const call of vi.mocked(prisma.conversation.findMany).mock.calls) {
      expect((call[0] as any).where.reads).toEqual({ none: { userId: 'user-1', hiddenAt: { not: null } } });
    }
  });

  it('a conversation with a deleted side is served with the placeholder on a later page', async () => {
    fakeStore([{ id: 'a', updatedAt: at('1'), n: 1, user2Id: null }, { id: 'b', updatedAt: at('2'), n: 2 }]);
    const p1 = await request(app()).get('/dm?limit=1');
    const p2 = await request(app()).get('/dm').query({ limit: '1', cursor: p1.body.nextCursor });
    expect(p2.body.data[0]).toMatchObject({ id: 'a', participantDeleted: true, user2Id: null });
  });
});
