import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@voxium/shared';

// A space's caps (channels, categories, members) and the sidebar positions of
// its channels and categories are counted and assigned under the space row
// lock, inside the transaction that inserts. These tests run the REAL routes
// and the REAL join against a small in-memory PostgreSQL that models what the
// race depends on:
//
//  - READ COMMITTED: a statement inside a transaction sees the rows committed
//    when it runs plus the transaction's own writes; a statement outside one
//    is its own transaction and commits at once;
//  - row locks: `SELECT … FROM servers … FOR UPDATE` and an UPDATE of a space
//    row take that row's lock, held until the transaction ends; anyone else
//    asking for it waits;
//  - the race itself: the first counted read of each racer waits until every
//    racer has either counted too or is waiting for a row lock. Code that
//    counts outside the lock lets every racer count the same rows (and fails
//    these tests); code that counts under the lock makes the second racer
//    wait for the first one's commit, then count it.
//
// It models only the statements these code paths issue.

// ─── In-memory database ─────────────────────────────────────────────────────

interface ServerRow { id: string; ownerId: string; memberCount: number }
interface ChannelRow { id: string; serverId: string; name: string; type: string; secure: boolean; position: number; categoryId: string | null; createdById: string | null }
interface CategoryRow { id: string; serverId: string; name: string; position: number }
interface MemberRow { userId: string; serverId: string }
interface Tables {
  servers: ServerRow[];
  channels: ChannelRow[];
  categories: CategoryRow[];
  members: MemberRow[];
  channelMembers: Array<{ channelId: string; userId: string; isCreator: boolean }>;
  channelReads: Array<{ userId: string; channelId: string }>;
  joinRequests: Array<{ serverId: string; userId: string; status: string }>;
  bans: Array<{ serverId: string; userId: string }>;
  invites: Array<{ code: string; serverId: string }>;
}

function emptyTables(): Tables {
  return { servers: [], channels: [], categories: [], members: [], channelMembers: [], channelReads: [], joinRequests: [], bans: [], invites: [] };
}

function cloneTables(t: Tables): Tables {
  return {
    servers: t.servers.map((r) => ({ ...r })),
    channels: t.channels.map((r) => ({ ...r })),
    categories: t.categories.map((r) => ({ ...r })),
    members: t.members.map((r) => ({ ...r })),
    channelMembers: t.channelMembers.map((r) => ({ ...r })),
    channelReads: t.channelReads.map((r) => ({ ...r })),
    joinRequests: t.joinRequests.map((r) => ({ ...r })),
    bans: t.bans.map((r) => ({ ...r })),
    invites: t.invites.map((r) => ({ ...r })),
  };
}

/** What has committed. */
let committed: Tables;
let nextId = 0;

/** A transaction: its writes, replayed on top of the committed rows by every read it makes. */
interface Txn { writes: Array<(t: Tables) => void>; held: Set<string> }

/** The rows a statement sees: committed, plus its own transaction's writes. */
function view(txn: Txn | null): Tables {
  if (!txn) return committed;
  const t = cloneTables(committed);
  for (const w of txn.writes) w(t);
  return t;
}

/** A write: deferred to the commit inside a transaction, applied at once outside one. */
function write(txn: Txn | null, w: (t: Tables) => void): void {
  if (txn) txn.writes.push(w);
  else w(committed);
}

// ─── Row locks and the race ─────────────────────────────────────────────────

const lockHolders = new Map<string, Txn>();
const lockWaiters = new Map<string, Array<() => void>>();

/** The racers that have not reached their counted read (or a lock wait) yet. */
let race: { pending: number; open: () => void; gate: Promise<void> } | null = null;

function armRace(racers: number): void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  race = { pending: racers, open, gate };
}

/** A racer reached the point the race is about: its counted read, or a wait for a row lock. */
function arrive(): Promise<void> | undefined {
  const r = race;
  if (!r) return undefined;
  r.pending -= 1;
  if (r.pending <= 0) {
    race = null;
    r.open();
  }
  return r.gate;
}

/** A counted read waits for the other racers to get as far. */
async function countedRead(): Promise<void> {
  await arrive();
}

/** Lock `key` for `txn` until it ends, waiting for the transaction that holds it. */
async function lockRow(txn: Txn, key: string): Promise<void> {
  for (;;) {
    const holder = lockHolders.get(key);
    if (!holder || holder === txn) {
      lockHolders.set(key, txn);
      txn.held.add(key);
      return;
    }
    const released = new Promise<void>((resolve) => {
      const list = lockWaiters.get(key) ?? [];
      list.push(resolve);
      lockWaiters.set(key, list);
    });
    void arrive();
    await released;
  }
}

function releaseLocks(txn: Txn): void {
  for (const key of txn.held) {
    lockHolders.delete(key);
    const waiters = lockWaiters.get(key) ?? [];
    lockWaiters.delete(key);
    for (const wake of waiters) wake();
  }
}

// ─── The fake client ────────────────────────────────────────────────────────

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (k === 'userId_serverId' || k === 'serverId_userId') {
      const key = v as { userId: string; serverId: string };
      return row.userId === key.userId && row.serverId === key.serverId;
    }
    if (k === 'channel') {
      const ch = view(null).channels.find((c) => c.id === row.channelId);
      return !!ch && matches(ch as unknown as Record<string, unknown>, v as Where);
    }
    if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
}

function highest(rows: Array<{ position: number }>): number | null {
  return rows.length === 0 ? null : Math.max(...rows.map((r) => r.position));
}

function makeClient(txn: Txn | null): Record<string, any> {
  const rows = <K extends keyof Tables>(table: K): Tables[K] => view(txn)[table];
  return {
    server: {
      findUnique: async ({ where }: any) => rows('servers').find((s) => s.id === where.id) ?? null,
      // An UPDATE of the space row takes its lock (FOR NO KEY UPDATE)
      update: async ({ where, data }: any) => {
        if (txn) await lockRow(txn, `servers:${where.id}`);
        write(txn, (t) => {
          const s = t.servers.find((r) => r.id === where.id)!;
          if (data.memberCount?.increment) s.memberCount += data.memberCount.increment;
        });
        return rows('servers').find((s) => s.id === where.id);
      },
      updateMany: async ({ where, data }: any) => {
        if (txn) await lockRow(txn, `servers:${where.id}`);
        write(txn, (t) => {
          const s = t.servers.find((r) => r.id === where.id);
          if (s && data.memberCount?.decrement) s.memberCount = Math.max(0, s.memberCount - data.memberCount.decrement);
        });
        return { count: 1 };
      },
    },
    role: {
      findFirst: async () => ({ id: 'everyone', permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS) }),
      findMany: async () => [],
    },
    memberRole: { findMany: async () => [] },
    serverBan: { findUnique: async ({ where }: any) => rows('bans').find((b) => matches(b, where)) ?? null },
    serverJoinRequest: {
      findUnique: async ({ where }: any) => rows('joinRequests').find((r) => matches(r, where)) ?? null,
      deleteMany: async ({ where }: any) => {
        const n = rows('joinRequests').filter((r) => matches(r, where)).length;
        write(txn, (t) => { t.joinRequests = t.joinRequests.filter((r) => !matches(r, where)); });
        return { count: n };
      },
    },
    invite: {
      delete: async ({ where }: any) => {
        const found = rows('invites').find((i) => i.code === where.code);
        if (!found) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
        write(txn, (t) => { t.invites = t.invites.filter((i) => i.code !== where.code); });
        return found;
      },
    },
    serverMember: {
      findUnique: async ({ where }: any) => rows('members').find((m) => matches(m, where)) ?? null,
      count: async ({ where }: any) => {
        await countedRead();
        return rows('members').filter((m) => matches(m, where)).length;
      },
      create: async ({ data }: any) => {
        if (rows('members').some((m) => m.userId === data.userId && m.serverId === data.serverId)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        write(txn, (t) => { t.members.push({ userId: data.userId, serverId: data.serverId }); });
        return data;
      },
      deleteMany: async ({ where }: any) => {
        const n = rows('members').filter((m) => matches(m, where)).length;
        write(txn, (t) => { t.members = t.members.filter((m) => !matches(m, where)); });
        return { count: n };
      },
    },
    category: {
      findFirst: async ({ where }: any) => rows('categories').find((c) => matches(c, where)) ?? null,
      count: async ({ where }: any) => {
        await countedRead();
        return rows('categories').filter((c) => matches(c, where)).length;
      },
      aggregate: async ({ where }: any) => {
        await countedRead();
        const found = rows('categories').filter((c) => matches(c, where));
        return { _count: { _all: found.length }, _max: { position: highest(found) } };
      },
      create: async ({ data }: any) => {
        const row: CategoryRow = { id: `cat-${++nextId}`, ...data };
        write(txn, (t) => { t.categories.push(row); });
        return row;
      },
    },
    channel: {
      findMany: async ({ where }: any) => rows('channels').filter((c) => matches(c, where)),
      count: async ({ where }: any) => {
        await countedRead();
        return rows('channels').filter((c) => matches(c, where)).length;
      },
      groupBy: async ({ where }: any) => {
        await countedRead();
        const found = rows('channels').filter((c) => matches(c, where));
        return [false, true]
          .map((secure) => found.filter((c) => c.secure === secure))
          .filter((group) => group.length > 0)
          .map((group) => ({ secure: group[0].secure, _count: { _all: group.length }, _max: { position: highest(group) } }));
      },
      aggregate: async ({ where }: any) => {
        const found = rows('channels').filter((c) => matches(c, where));
        return { _count: { _all: found.length }, _max: { position: highest(found) } };
      },
      create: async ({ data }: any) => {
        const row: ChannelRow = { id: `ch-${++nextId}`, secure: false, categoryId: null, createdById: null, ...data };
        write(txn, (t) => { t.channels.push(row); });
        return row;
      },
    },
    channelMember: {
      findMany: async ({ where }: any) => rows('channelMembers').filter((m) => matches(m, where)).map((m) => ({ userId: m.userId })),
      createMany: async ({ data }: any) => {
        write(txn, (t) => { t.channelMembers.push(...data); });
        return { count: data.length };
      },
      deleteMany: async ({ where }: any) => {
        const n = rows('channelMembers').filter((m) => matches(m, where)).length;
        write(txn, (t) => { t.channelMembers = t.channelMembers.filter((m) => !matches(m, where)); });
        return { count: n };
      },
    },
    channelRead: {
      createMany: async ({ data }: any) => {
        write(txn, (t) => { t.channelReads.push(...data); });
        return { count: data.length };
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (/FROM server_members/.test(sql)) {
        // lockServerMemberRows (FOR KEY SHARE): no writer here conflicts with it
        const [serverId, userIds] = values as [string, string[]];
        return rows('members').filter((m) => m.serverId === serverId && userIds.includes(m.userId)).map((m) => ({ user_id: m.userId }));
      }
      if (/FROM servers WHERE id = \? FOR UPDATE$/.test(sql)) {
        if (!txn) throw new Error('a row lock outside a transaction locks nothing');
        await lockRow(txn, `servers:${values[0] as string}`);
        return rows('servers').filter((s) => s.id === values[0]).map((s) => ({ id: s.id }));
      }
      throw new Error(`unmodelled raw query: ${sql}`);
    },
  };
}

const root = makeClient(null);

const client: Record<string, any> = {
  ...root,
  $transaction: async (arg: any) => {
    // An array of statements already ran (each its own autocommit statement
    // here, which is all the array form's callers rely on in these tests)
    if (Array.isArray(arg)) return Promise.all(arg);
    const txn: Txn = { writes: [], held: new Set() };
    try {
      const result = await arg(makeClient(txn));
      for (const w of txn.writes) w(committed);
      return result;
    } finally {
      releaseLocks(txn);
    }
  },
};

vi.mock('../../utils/prisma', () => ({ prisma: new Proxy({}, { get: (_t, prop) => client[prop as string] }) }));

// ─── Everything around the database ─────────────────────────────────────────

vi.mock('../../websocket/socketServer', () => ({
  getIO: () => ({
    to: () => ({ emit: () => {} }),
    in: () => ({ socketsJoin: () => {}, socketsLeave: () => {} }),
  }),
}));
vi.mock('../../websocket/voiceCluster', () => ({
  broadcastVoiceEvictUser: async () => {},
  broadcastChannelVoiceCleanup: async () => {},
}));
vi.mock('../../websocket/voiceHandler', () => ({ replayVoiceState: async () => {} }));
vi.mock('../../utils/redis', () => ({ getRedis: () => ({ get: async () => null }) }));
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: async () => {}, broadcastMemberLeft: async () => {} }));
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: async () => {} }));
vi.mock('../../utils/webhookLifecycle', () => ({ emitWebhookChanged: () => {} }));
vi.mock('../../utils/s3', () => ({ deleteMultipleFromS3: async () => 0, VALID_ATTACHMENT_KEY_RE: /^attachments\// }));
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: async () => true,
  hasChannelPermission: async () => true,
  filterVisibleChannels: async (_u: unknown, _s: unknown, channels: unknown[]) => channels,
  computeServerPermissions: async () => 0n,
}));
const limits = vi.hoisted(() => ({
  maxChannelsPerServer: 20,
  maxVoiceUsersPerChannel: 12,
  maxCategoriesPerServer: 12,
  maxMembersPerServer: 0,
  maxWebhooksPerServer: 10,
  maxSecureChannelsPerServer: 5,
}));
vi.mock('../../utils/serverLimits', () => ({ getEffectiveLimits: async () => ({ ...limits }) }));
vi.mock('../../middleware/rateLimiter', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { rateLimitCategoryManage: pass, rateLimitMarkRead: pass, rateLimitSecureChannelManage: pass, rateLimitMemberManage: pass };
});
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: unknown, next: () => void) => {
    req.user = { userId: 'owner', username: 'owner', tokenVersion: 0, role: 'user' };
    next();
  },
  requireVerifiedEmail: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireConsent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { channelRouter } from '../../routes/channels';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/v1/servers/:serverId/channels', channelRouter);
app.use(errorHandler);

// ─── Fixtures ───────────────────────────────────────────────────────────────

const S = 'srv-1';

function seed(): void {
  committed = emptyTables();
  nextId = 0;
  lockHolders.clear();
  lockWaiters.clear();
  race = null;
  committed.servers.push({ id: S, ownerId: 'owner', memberCount: 1 });
  committed.members.push({ userId: 'owner', serverId: S });
}

/** `n` channels at the positions after the ones already there. */
function seedChannels(n: number, opts: { secure?: boolean } = {}): void {
  const first = committed.channels.length;
  for (let i = 0; i < n; i++) {
    committed.channels.push({
      id: `seed-${opts.secure ? 's' : 'c'}${first + i}`, serverId: S, name: `c${first + i}`, type: 'text',
      secure: opts.secure ?? false, position: first + i,
      categoryId: null, createdById: opts.secure ? 'owner' : null,
    });
  }
}

const createChannel = (name: string) => request(app).post(`/api/v1/servers/${S}/channels`).send({ name, type: 'text' });

beforeEach(() => {
  seed();
  Object.assign(limits, { maxChannelsPerServer: 20, maxCategoriesPerServer: 12, maxMembersPerServer: 0, maxSecureChannelsPerServer: 5 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ─── Channels ───────────────────────────────────────────────────────────────

describe('two concurrent channel creations in one space', () => {
  it('one below the limit: exactly one is created, the other gets the limit answer, never a 500', async () => {
    limits.maxChannelsPerServer = 3;
    seedChannels(2);
    armRace(2);

    const [a, b] = await Promise.all([createChannel('alpha'), createChannel('beta')]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const refused = a.status === 400 ? a : b;
    expect(refused.body.error).toBe('Server can have at most 3 channels');
    expect(committed.channels.filter((c) => !c.secure)).toHaveLength(3);
  });

  it('below the limit: both are created, at two different positions after every existing one', async () => {
    seedChannels(2);
    armRace(2);

    const [a, b] = await Promise.all([createChannel('alpha'), createChannel('beta')]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.data.position, b.body.data.position].sort()).toEqual([2, 3]);
  });

  it('secure channels do not count against the limit but still hold positions', async () => {
    limits.maxChannelsPerServer = 1;
    seedChannels(3, { secure: true });
    armRace(2);

    const [a, b] = await Promise.all([createChannel('alpha'), createChannel('beta')]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect((a.status === 201 ? a : b).body.data.position).toBe(3);
  });
});
