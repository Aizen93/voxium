import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// A secure channel's access is derived from its ChannelMember rows alone, so a
// row may exist only while its user is a member of the channel's space. These
// tests run the REAL removal (utils/removeMember.ts), the REAL join
// (utils/serverJoin.ts), the REAL secure-channel routes and lifecycle helpers
// against a small in-memory database, and interleave two operations the way
// PostgreSQL's row locks order them:
//
//  - an invite whose transaction holds the member's row first: the removal's
//    member delete waits for it, so the hook runs the invite to its commit
//    right before the removal's delete is applied;
//  - a removal that commits first: the invite's transaction starts after it.
//
// The fake applies writes at once and restores a snapshot when a transaction
// throws. It models only the statements these code paths issue.

// ─── In-memory database ─────────────────────────────────────────────────────

interface ChannelRow { id: string; serverId: string; secure: boolean; type: string; createdById: string | null; name: string; position: number; categoryId: string | null }
interface ChannelMemberRow { channelId: string; userId: string; isCreator: boolean; addedAt: Date }
interface Store {
  users: Map<string, { id: string; username: string; displayName: string; avatarUrl: string | null }>;
  serverMembers: Array<{ userId: string; serverId: string }>;
  servers: Map<string, { id: string; memberCount: number; ownerId: string }>;
  channels: ChannelRow[];
  channelMembers: ChannelMemberRow[];
  channelReads: Array<{ userId: string; channelId: string; lastReadAt: Date }>;
  keyShares: Array<{ id: string; recipientUserId: string; conversationId: string }>;
  bans: Array<{ serverId: string; userId: string }>;
  joinRequests: Array<{ serverId: string; userId: string; status: string }>;
}

let db: Store;

function freshStore(): Store {
  return {
    users: new Map(),
    serverMembers: [],
    servers: new Map(),
    channels: [],
    channelMembers: [],
    channelReads: [],
    keyShares: [],
    bans: [],
    joinRequests: [],
  };
}

function cloneStore(s: Store): Store {
  return {
    users: new Map(s.users),
    serverMembers: s.serverMembers.map((r) => ({ ...r })),
    servers: new Map([...s.servers].map(([k, v]) => [k, { ...v }])),
    channels: s.channels.map((r) => ({ ...r })),
    channelMembers: s.channelMembers.map((r) => ({ ...r })),
    channelReads: s.channelReads.map((r) => ({ ...r })),
    keyShares: s.keyShares.map((r) => ({ ...r })),
    bans: s.bans.map((r) => ({ ...r })),
    joinRequests: s.joinRequests.map((r) => ({ ...r })),
  };
}

type Where = Record<string, unknown> | undefined;

/** Scalar condition: a value, `{ in }` or `{ not }`. */
function scalar(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as { in?: unknown[]; not?: unknown; gt?: number };
    if ('in' in c) return (c.in ?? []).includes(value);
    if ('not' in c) return value !== c.not;
    if ('gt' in c) return (value as number) > (c.gt as number);
  }
  return value === cond;
}

function isMemberOf(userId: string, serverId: string): boolean {
  return db.serverMembers.some((m) => m.userId === userId && m.serverId === serverId);
}

function channelMatches(row: ChannelRow, where: Where): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'AND') { if (!(v as Where[]).every((w) => channelMatches(row, w))) return false; continue; }
    if (k === 'members') {
      const some = (v as { some?: Where }).some;
      if (!db.channelMembers.some((m) => m.channelId === row.id && memberMatches(m, some))) return false;
      continue;
    }
    if (k === 'server') {
      const sw = v as { members?: { some?: { userId?: string } }; AND?: Array<{ members: { some: { userId: string } } }> };
      const conds = [...(sw.members ? [sw.members] : []), ...(sw.AND ?? []).map((a) => a.members)];
      if (!conds.every((c) => isMemberOf(c.some!.userId!, row.serverId))) return false;
      continue;
    }
    if (!scalar((row as unknown as Record<string, unknown>)[k], v)) return false;
  }
  return true;
}

function memberMatches(row: ChannelMemberRow, where: Where): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'channel') {
      const ch = db.channels.find((c) => c.id === row.channelId);
      if (!ch || !channelMatches(ch, v as Where)) return false;
      continue;
    }
    if (k === 'user') {
      const some = (v as { memberships?: { some?: { serverId?: string } } }).memberships?.some;
      if (some?.serverId !== undefined && !isMemberOf(row.userId, some.serverId)) return false;
      continue;
    }
    if (k === 'channelId_userId') {
      const key = v as { channelId: string; userId: string };
      if (row.channelId !== key.channelId || row.userId !== key.userId) return false;
      continue;
    }
    if (!scalar((row as unknown as Record<string, unknown>)[k], v)) return false;
  }
  return true;
}

function readMatches(row: { userId: string; channelId: string }, where: Where): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'channel') {
      const ch = db.channels.find((c) => c.id === row.channelId);
      if (!ch || !channelMatches(ch, v as Where)) return false;
      continue;
    }
    if (!scalar((row as Record<string, unknown>)[k], v)) return false;
  }
  return true;
}

function plainMatches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (k === 'userId_serverId' || k === 'serverId_userId') {
      const key = v as { userId: string; serverId: string };
      return row.userId === key.userId && row.serverId === key.serverId;
    }
    return scalar(row[k], v);
  });
}

/** Cascade of a channel row (members, reads). */
function dropChannels(ids: string[]): number {
  const before = db.channels.length;
  db.channels = db.channels.filter((c) => !ids.includes(c.id));
  db.channelMembers = db.channelMembers.filter((m) => !ids.includes(m.channelId));
  db.channelReads = db.channelReads.filter((r) => !ids.includes(r.channelId));
  return before - db.channels.length;
}

function p2025(): Error {
  return Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
}

// ─── Interleaving hooks ─────────────────────────────────────────────────────

type HookPoint = 'serverMember.delete' | 'transaction.start';
let hooks: Array<{ at: HookPoint; run: () => Promise<void> }> = [];
/** Statements the test makes fail, by name. */
let failing = new Set<string>();

async function fire(at: HookPoint): Promise<void> {
  const due = hooks.filter((h) => h.at === at);
  hooks = hooks.filter((h) => h.at !== at);
  for (const h of due) await h.run();
}

function maybeFail(op: string): void {
  if (failing.has(op)) throw new Error(`${op} failed`);
}

// ─── The fake client ────────────────────────────────────────────────────────

const client: Record<string, any> = {
  user: {},
  serverBan: {
    findUnique: async ({ where }: any) => db.bans.find((b) => plainMatches(b, where)) ?? null,
    upsert: async ({ create }: any) => {
      if (!db.bans.some((b) => b.serverId === create.serverId && b.userId === create.userId)) db.bans.push({ serverId: create.serverId, userId: create.userId });
      return create;
    },
  },
  serverJoinRequest: {
    findUnique: async ({ where }: any) => db.joinRequests.find((r) => plainMatches(r, where)) ?? null,
    deleteMany: async ({ where }: any) => {
      const before = db.joinRequests.length;
      db.joinRequests = db.joinRequests.filter((r) => !plainMatches(r, where));
      return { count: before - db.joinRequests.length };
    },
  },
  serverMember: {
    findUnique: async ({ where }: any) => db.serverMembers.find((m) => plainMatches(m, where)) ?? null,
    findMany: async ({ where }: any) => db.serverMembers.filter((m) => plainMatches(m, where)),
    count: async ({ where }: any) => db.serverMembers.filter((m) => plainMatches(m, where)).length,
    create: async ({ data }: any) => {
      if (isMemberOf(data.userId, data.serverId)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      db.serverMembers.push({ userId: data.userId, serverId: data.serverId });
      return data;
    },
    delete: async ({ where }: any) => {
      await fire('serverMember.delete');
      const idx = db.serverMembers.findIndex((m) => plainMatches(m, where));
      if (idx < 0) throw p2025();
      return db.serverMembers.splice(idx, 1)[0];
    },
    deleteMany: async ({ where }: any) => {
      await fire('serverMember.delete');
      const before = db.serverMembers.length;
      db.serverMembers = db.serverMembers.filter((m) => !plainMatches(m, where));
      return { count: before - db.serverMembers.length };
    },
  },
  server: {
    update: async ({ where, data }: any) => {
      const s = db.servers.get(where.id)!;
      if (data.memberCount?.increment) s.memberCount += data.memberCount.increment;
      return s;
    },
    updateMany: async ({ where, data }: any) => {
      const s = db.servers.get(where.id);
      if (!s) return { count: 0 };
      if (data.memberCount?.decrement) s.memberCount = Math.max(0, s.memberCount - data.memberCount.decrement);
      return { count: 1 };
    },
  },
  webhook: { updateMany: async () => ({ count: 0 }) },
  channel: {
    findFirst: async ({ where }: any) => db.channels.find((c) => channelMatches(c, where)) ?? null,
    findUnique: async ({ where, select }: any) => {
      const c = db.channels.find((ch) => ch.id === where.id);
      if (!c) return null;
      return select?.members
        ? { ...c, members: db.channelMembers.filter((m) => m.channelId === c.id).map((m) => ({ userId: m.userId })) }
        : c;
    },
    findUniqueOrThrow: async ({ where }: any) => {
      const c = db.channels.find((ch) => ch.id === where.id);
      if (!c) throw Object.assign(new Error('No record'), { code: 'P2025' });
      return c;
    },
    findMany: async ({ where }: any) => db.channels.filter((c) => channelMatches(c, where)),
    count: async ({ where }: any) => db.channels.filter((c) => channelMatches(c, where)).length,
    create: async ({ data }: any) => {
      const row: ChannelRow = { id: `ch-new-${db.channels.length + 1}`, categoryId: null, createdById: null, ...data };
      db.channels.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      maybeFail('channel.delete');
      if (dropChannels([where.id]) === 0) throw p2025();
      return { id: where.id };
    },
    deleteMany: async ({ where }: any) => {
      maybeFail('channel.delete');
      const ids = db.channels.filter((c) => channelMatches(c, where)).map((c) => c.id);
      return { count: dropChannels(ids) };
    },
  },
  channelMember: {
    findUnique: async ({ where }: any) => db.channelMembers.find((m) => memberMatches(m, where)) ?? null,
    findFirst: async ({ where }: any) => db.channelMembers.find((m) => memberMatches(m, where)) ?? null,
    findMany: async ({ where, select }: any) => db.channelMembers
      .filter((m) => memberMatches(m, where))
      .map((m) => ({
        ...m,
        user: db.users.get(m.userId) ?? { id: m.userId, username: m.userId, displayName: m.userId, avatarUrl: null },
        ...(select?.channel && { channel: { serverId: db.channels.find((c) => c.id === m.channelId)?.serverId } }),
      })),
    count: async ({ where }: any) => db.channelMembers.filter((m) => memberMatches(m, where)).length,
    create: async ({ data }: any) => {
      db.channelMembers.push({ addedAt: new Date(), ...data });
      return data;
    },
    createMany: async ({ data }: any) => {
      for (const d of data) db.channelMembers.push({ addedAt: new Date(), ...d });
      return { count: data.length };
    },
    deleteMany: async ({ where }: any) => {
      maybeFail('channelMember.deleteMany');
      const before = db.channelMembers.length;
      db.channelMembers = db.channelMembers.filter((m) => !memberMatches(m, where));
      return { count: before - db.channelMembers.length };
    },
  },
  channelRead: {
    upsert: async ({ create }: any) => { db.channelReads.push(create); return create; },
    createMany: async ({ data }: any) => { db.channelReads.push(...data); return { count: data.length }; },
    deleteMany: async ({ where }: any) => {
      const before = db.channelReads.length;
      db.channelReads = db.channelReads.filter((r) => !readMatches(r, where));
      return { count: before - db.channelReads.length };
    },
  },
  e2EKeyShare: {
    deleteMany: async ({ where }: any) => {
      const before = db.keyShares.length;
      db.keyShares = db.keyShares.filter((k) => !plainMatches(k, where));
      return { count: before - db.keyShares.length };
    },
  },
  messageAttachment: { findMany: async () => [] },
  // The row locks the code takes. Each answers what PostgreSQL would once
  // the lock is granted (the interleaving itself comes from the hooks).
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM server_members/.test(sql)) {
      const [first, second] = values;
      const userIds = Array.isArray(first) ? first as string[] : Array.isArray(second) ? second as string[] : [first as string];
      const serverId = (Array.isArray(first) ? second : Array.isArray(second) ? first : second) as string;
      return db.serverMembers.filter((m) => m.serverId === serverId && userIds.includes(m.userId)).map((m) => ({ user_id: m.userId }));
    }
    if (/FROM servers/.test(sql)) return db.servers.has(values[0] as string) ? [{ id: values[0] }] : [];
    if (/FROM channels c/.test(sql) && /created_by_id/.test(sql)) {
      // The removal's lock: every secure channel the user created or is a
      // member of (in the space, when one is named), in id order
      const scoped = /c\.server_id = \?/.test(sql);
      const [serverId, userId] = scoped ? values as string[] : [undefined, values[0] as string];
      return db.channels
        .filter((c) => c.secure && (serverId === undefined || c.serverId === serverId))
        .filter((c) => c.createdById === userId || db.channelMembers.some((m) => m.channelId === c.id && m.userId === userId))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => ({ id: c.id, server_id: c.serverId, created_by_id: c.createdById }));
    }
    if (/FROM channels/.test(sql)) return db.channels.filter((c) => c.id === values[0]).map((c) => ({ id: c.id }));
    throw new Error(`unmodelled raw query: ${sql}`);
  },
  $transaction: async (arg: any, _opts?: unknown) => {
    await fire('transaction.start');
    const snapshot = cloneStore(db);
    try {
      return Array.isArray(arg) ? await Promise.all(arg) : await arg(client);
    } catch (err) {
      db = snapshot;
      throw err;
    }
  },
};

vi.mock('../../utils/prisma', () => ({ prisma: new Proxy({}, { get: (_t, prop) => client[prop as string] }) }));

// ─── Everything around the database ─────────────────────────────────────────

const emitted: Array<{ room: string; event: string; payload: any }> = [];
const roomOps: Array<{ op: 'join' | 'leave'; target: string; room: string }> = [];
vi.mock('../../websocket/socketServer', () => ({
  getIO: () => ({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    in: (target: string) => ({
      socketsJoin: (room: string) => roomOps.push({ op: 'join', target, room }),
      socketsLeave: (room: string) => roomOps.push({ op: 'leave', target, room }),
    }),
  }),
}));

const voiceEvictions: Array<[string, string]> = [];
const voiceCleanups: string[] = [];
vi.mock('../../websocket/voiceCluster', () => ({
  broadcastVoiceEvictUser: async (_io: unknown, channelId: string, userId: string) => { voiceEvictions.push([channelId, userId]); },
  broadcastChannelVoiceCleanup: async (_io: unknown, channelId: string) => { voiceCleanups.push(channelId); },
}));
vi.mock('../../websocket/voiceHandler', () => ({ replayVoiceState: async () => {} }));
vi.mock('../../utils/redis', () => ({ getRedis: () => ({ get: async () => null }) }));
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberLeft: async () => {}, broadcastMemberJoined: async () => {} }));
vi.mock('../../utils/webhookLifecycle', () => ({ emitWebhookChanged: () => {} }));
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: async () => {} }));
vi.mock('../../utils/s3', () => ({ deleteMultipleFromS3: async () => 0, VALID_ATTACHMENT_KEY_RE: /^attachments\// }));
vi.mock('../../utils/permissionCalculator', () => ({ hasServerPermission: async () => true }));
vi.mock('../../utils/serverLimits', () => ({
  getEffectiveLimits: async () => ({ maxMembersPerServer: 0, maxSecureChannelsPerServer: 5 }),
}));
vi.mock('../../middleware/rateLimiter', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { rateLimitSecureChannelManage: pass, rateLimitMemberManage: pass };
});
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: unknown, next: () => void) => {
    req.user = { userId: req.headers['x-test-user'] as string, username: 'x', tokenVersion: 0, role: 'user' };
    next();
  },
  requireVerifiedEmail: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireConsent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { removeMemberFromServer } from '../../utils/removeMember';
import { joinServerMember } from '../../utils/serverJoin';
import { secureChannelRouter } from '../../routes/secureChannels';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/v1/servers/:serverId/secure-channels', secureChannelRouter);
app.use(errorHandler);

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Space S, owned by `owner`. `alice` created the secure text channel C;
// `bob` is a member of S (and, when a test says so, of C).

const S = 'srv-1';
const C = 'sec-1';

function seed(): void {
  db = freshStore();
  for (const id of ['owner', 'alice', 'bob']) {
    db.users.set(id, { id, username: id, displayName: id, avatarUrl: null });
    db.serverMembers.push({ userId: id, serverId: S });
  }
  db.servers.set(S, { id: S, memberCount: 3, ownerId: 'owner' });
  db.channels.push(
    { id: 'general', serverId: S, secure: false, type: 'text', createdById: null, name: 'general', position: 0, categoryId: null },
    { id: C, serverId: S, secure: true, type: 'text', createdById: 'alice', name: 'covert', position: 1, categoryId: null },
  );
  db.channelMembers.push({ channelId: C, userId: 'alice', isCreator: true, addedAt: new Date() });
}

function rowsOf(userId: string): ChannelMemberRow[] {
  return db.channelMembers.filter((m) => m.userId === userId);
}

function invite(userId: string) {
  return request(app).post(`/api/v1/servers/${S}/secure-channels/${C}/members`).set('x-test-user', 'alice').send({ userId });
}

beforeEach(() => {
  seed();
  hooks = [];
  failing = new Set();
  emitted.length = 0;
  roomOps.length = 0;
  voiceEvictions.length = 0;
  voiceCleanups.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─── Removal ────────────────────────────────────────────────────────────────

describe('ending a space membership removes the secure-channel rows with it', () => {
  it('removes the member from every secure channel of the space, and only of that space', async () => {
    db.channelMembers.push({ channelId: C, userId: 'bob', isCreator: false, addedAt: new Date() });
    db.servers.set('srv-2', { id: 'srv-2', memberCount: 1, ownerId: 'bob' });
    db.serverMembers.push({ userId: 'bob', serverId: 'srv-2' });
    db.channels.push({ id: 'sec-elsewhere', serverId: 'srv-2', secure: true, type: 'text', createdById: 'bob', name: 'x', position: 0, categoryId: null });
    db.channelMembers.push({ channelId: 'sec-elsewhere', userId: 'bob', isCreator: true, addedAt: new Date() });
    db.keyShares.push({ id: 'ks-1', recipientUserId: 'bob', conversationId: `ch:${C}` });

    await removeMemberFromServer('bob', S);

    expect(rowsOf('bob').map((m) => m.channelId)).toEqual(['sec-elsewhere']);
    expect(db.keyShares).toEqual([]);
    // the departed member's live session in that channel ends; the rest re-key
    expect(voiceEvictions).toContainEqual([C, 'bob']);
    expect(emitted).toContainEqual({ room: 'user:bob', event: 'channel:deleted', payload: { channelId: C, serverId: S } });
    expect(emitted.some((e) => e.room === `channel:${C}` && e.event === 'channel:members_updated')).toBe(true);
    expect(roomOps).toContainEqual({ op: 'leave', target: 'user:bob', room: `channel:${C}` });
  });

  it('an invite that holds the member\'s row first and commits leaves no row behind once the removal commits', async () => {
    // The invite's transaction locked bob's member row before the removal's
    // delete reached it: the delete waits, then removes what the invite wrote.
    hooks.push({ at: 'serverMember.delete', run: async () => { expect((await invite('bob')).status).toBe(201); } });

    await removeMemberFromServer('bob', S);

    expect(isMemberOf('bob', S)).toBe(false);
    expect(rowsOf('bob')).toEqual([]);
  });

  it('a removal whose secure-channel step fails removes nothing: the member stays a member of the space and of the channel', async () => {
    db.channelMembers.push({ channelId: C, userId: 'bob', isCreator: false, addedAt: new Date() });
    failing.add('channelMember.deleteMany');

    await expect(removeMemberFromServer('bob', S)).rejects.toThrow('channelMember.deleteMany failed');

    expect(isMemberOf('bob', S)).toBe(true);
    expect(rowsOf('bob').map((m) => m.channelId)).toEqual([C]);
  });

  it('a creator who leaves takes their secure channels with them, every member\'s row included', async () => {
    db.channelMembers.push({ channelId: C, userId: 'bob', isCreator: false, addedAt: new Date() });

    await removeMemberFromServer('alice', S);

    expect(db.channels.map((c) => c.id)).toEqual(['general']);
    expect(db.channelMembers).toEqual([]);
    // every member hears it, the room is emptied, the live call ends
    expect(emitted).toContainEqual({ room: 'user:bob', event: 'channel:deleted', payload: { channelId: C, serverId: S } });
    expect(emitted).toContainEqual({ room: 'user:alice', event: 'channel:deleted', payload: { channelId: C, serverId: S } });
    expect(roomOps).toContainEqual({ op: 'leave', target: `channel:${C}`, room: `channel:${C}` });
    expect(voiceCleanups).toEqual([C]);
  });

  it('when the creator\'s channel cannot be deleted, the departure fails as a whole: the creator is still in the space and the channel', async () => {
    failing.add('channel.delete');

    await expect(removeMemberFromServer('alice', S)).rejects.toThrow('channel.delete failed');

    expect(isMemberOf('alice', S)).toBe(true);
    expect(rowsOf('alice').map((m) => m.channelId)).toEqual([C]);
    expect(db.channels.some((c) => c.id === C)).toBe(true);
    expect(emitted.filter((e) => e.event === 'channel:deleted')).toEqual([]);
  });
});

// ─── Adding ─────────────────────────────────────────────────────────────────

describe('a secure-channel row is written only for a current member of the space', () => {
  it('an invite whose transaction starts after the target\'s removal committed is refused and writes nothing', async () => {
    hooks.push({ at: 'transaction.start', run: () => removeMemberFromServer('bob', S) });

    const res = await invite('bob');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('User is not a member of this server');
    expect(isMemberOf('bob', S)).toBe(false);
    expect(rowsOf('bob')).toEqual([]);
  });

  it('a creation whose transaction starts after an invitee\'s removal committed is refused and writes nothing', async () => {
    hooks.push({ at: 'transaction.start', run: () => removeMemberFromServer('bob', S) });

    const res = await request(app).post(`/api/v1/servers/${S}/secure-channels`).set('x-test-user', 'alice')
      .send({ name: 'plans', memberIds: ['bob'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('All invited users must be members of this server');
    expect(db.channels.filter((c) => c.name === 'plans')).toEqual([]);
    expect(rowsOf('bob')).toEqual([]);
  });

  it('a creation whose transaction starts after the CREATOR\'s removal committed is refused and writes nothing', async () => {
    hooks.push({ at: 'transaction.start', run: () => removeMemberFromServer('bob', S) });

    const res = await request(app).post(`/api/v1/servers/${S}/secure-channels`).set('x-test-user', 'bob')
      .send({ name: 'plans', memberIds: ['alice'] });

    expect(res.status).toBe(403);
    expect(db.channels.filter((c) => c.name === 'plans')).toEqual([]);
    expect(rowsOf('bob')).toEqual([]);
  });

  it('an invite into a channel deleted meanwhile answers 404 Channel, not a 500', async () => {
    hooks.push({ at: 'transaction.start', run: async () => { db.channels = db.channels.filter((c) => c.id !== C); db.channelMembers = db.channelMembers.filter((m) => m.channelId !== C); } });

    const res = await invite('bob');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Channel not found');
  });
});

// ─── Joining ────────────────────────────────────────────────────────────────

describe('a membership starts with no secure-channel rows', () => {
  it('a join removes any row left from an earlier membership of that space, and only of that space', async () => {
    db.serverMembers = db.serverMembers.filter((m) => m.userId !== 'bob');
    db.channelMembers.push({ channelId: C, userId: 'bob', isCreator: false, addedAt: new Date() });
    db.channels.push({ id: 'sec-elsewhere', serverId: 'srv-2', secure: true, type: 'text', createdById: 'bob', name: 'x', position: 0, categoryId: null });
    db.channelMembers.push({ channelId: 'sec-elsewhere', userId: 'bob', isCreator: true, addedAt: new Date() });

    await joinServerMember('bob', S, { via: 'invite' });

    expect(isMemberOf('bob', S)).toBe(true);
    expect(rowsOf('bob').map((m) => m.channelId)).toEqual(['sec-elsewhere']);
  });

  it('a join undone by a ban that committed mid-join leaves no secure-channel row either', async () => {
    db.serverMembers = db.serverMembers.filter((m) => m.userId !== 'bob');
    // The ban lands right after the join's transaction; an invite slipped in
    // between, while bob was briefly a member
    let calls = 0;
    const findBan = client.serverBan.findUnique;
    client.serverBan.findUnique = async (args: any) => {
      calls++;
      if (calls === 2) {
        db.channelMembers.push({ channelId: C, userId: 'bob', isCreator: false, addedAt: new Date() });
        db.bans.push({ serverId: S, userId: 'bob' });
      }
      return findBan(args);
    };
    try {
      await expect(joinServerMember('bob', S, { via: 'invite' })).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      client.serverBan.findUnique = findBan;
    }

    expect(isMemberOf('bob', S)).toBe(false);
    expect(rowsOf('bob')).toEqual([]);
  });
});

// ─── Readers ────────────────────────────────────────────────────────────────

describe('a row whose user left the space grants nothing', () => {
  it('the member list leaves out a row whose user is no longer in the space', async () => {
    db.channelMembers.push({ channelId: C, userId: 'bob', isCreator: false, addedAt: new Date() });
    db.serverMembers = db.serverMembers.filter((m) => m.userId !== 'bob');

    const res = await request(app).get(`/api/v1/servers/${S}/secure-channels/${C}/members`).set('x-test-user', 'alice');

    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { userId: string }) => m.userId)).toEqual(['alice']);
  });
});
