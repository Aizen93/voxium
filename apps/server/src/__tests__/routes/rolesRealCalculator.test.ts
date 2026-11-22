import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import request from 'supertest';
import express from 'express';
import { Permissions, ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, LIMITS, WS_EVENTS, permissionsToString } from '@voxium/shared';
import {
  SECURE_CREATOR_PERMISSIONS,
  SECURE_MEMBER_PERMISSIONS,
  SECURE_VOICE_MEMBER_PERMISSIONS,
} from '../../utils/permissionCalculator';

/**
 * The role routes with the REAL permission calculator, over a small in-memory
 * space: the answers that depend on what the calculator decides (a space that
 * is gone, a channel the caller cannot view, a secure channel) are read from
 * the code that decides them, not from a mock of it.
 */

// ─── The space ──────────────────────────────────────────────────────────────

interface World {
  servers: Record<string, { ownerId: string }>;
  members: Array<{ userId: string; serverId: string }>;
  roles: Array<{ id: string; serverId: string; name: string; position: number; isDefault: boolean; permissions: string }>;
  memberRoles: Array<{ userId: string; serverId: string; roleId: string }>;
  channels: Record<string, { serverId: string; secure: boolean; type: 'text' | 'voice' }>;
  channelMembers: Array<{ channelId: string; userId: string; isCreator: boolean }>;
  overrides: Array<{ channelId: string; roleId: string; allow: string; deny: string }>;
}

const s = permissionsToString;

function emptyWorld(): World {
  return { servers: {}, members: [], roles: [], memberRoles: [], channels: {}, channelMembers: [], overrides: [] };
}

/**
 * The space row lock a creation takes (SELECT … FOR UPDATE), held until its
 * transaction ends: a second transaction asking for the same row waits for
 * it, as PostgreSQL makes it wait. Each transaction's releases are kept in
 * its own async context.
 */
const transactionLocks = new AsyncLocalStorage<Array<() => void>>();
const spaceRowHeld = new Map<string, Promise<void>>();
async function lockSpaceRow(serverId: string): Promise<void> {
  const releases = transactionLocks.getStore();
  if (!releases) throw new Error('a row lock outside a transaction');
  while (spaceRowHeld.has(serverId)) await spaceRowHeld.get(serverId);
  let release!: () => void;
  spaceRowHeld.set(serverId, new Promise<void>((resolve) => { release = resolve; }));
  releases.push(() => { spaceRowHeld.delete(serverId); release(); });
}

/** A test's hook, run when a creation inserts its role (before the row is written). */
let beforeRoleInsert: (() => Promise<void>) | null = null;

/** One client (the shared one, or a transaction's) reading `world()`. */
function clientOf(world: () => World) {
  const roleRow = (r: World['roles'][number]) => ({ ...r, color: null });
  return {
    server: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = world().servers[where.id];
        return row ? { id: where.id, ownerId: row.ownerId } : null;
      }),
    },
    serverMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { userId, serverId } = where.userId_serverId;
        return world().members.find((m) => m.userId === userId && m.serverId === serverId) ?? null;
      }),
      update: vi.fn(async () => ({})),
    },
    role: {
      findMany: vi.fn(async ({ where }: any) => world().roles
        .filter((r) => where.id.in.includes(r.id) && (where.serverId === undefined || r.serverId === where.serverId))
        .map(roleRow)),
      delete: vi.fn(async ({ where }: any) => {
        const row = world().roles.find((r) => r.id === where.id);
        if (!row) throw Object.assign(new Error('No record was found for a delete.'), { code: 'P2025' });
        world().roles = world().roles.filter((r) => r !== row);
        world().memberRoles = world().memberRoles.filter((mr) => mr.roleId !== row.id);
        return roleRow(row);
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const row = world().roles.find((r) => r.serverId === where.serverId
          && (where.id === undefined || r.id === where.id)
          && (where.isDefault === undefined || r.isDefault === where.isDefault)
          && (where.name === undefined || r.name === where.name));
        return row ? roleRow(row) : null;
      }),
      count: vi.fn(async ({ where }: any) => world().roles.filter((r) => r.serverId === where.serverId && r.isDefault === where.isDefault).length),
      aggregate: vi.fn(async ({ where }: any) => {
        const rows = world().roles.filter((r) => r.serverId === where.serverId && r.isDefault === where.isDefault);
        return { _count: { _all: rows.length }, _max: { position: rows.length ? Math.max(...rows.map((r) => r.position)) : null } };
      }),
      create: vi.fn(async ({ data }: any) => {
        await beforeRoleInsert?.();
        const row = { id: `r-${data.name}`, isDefault: false, ...data };
        world().roles.push(row);
        return roleRow(row);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = world().roles.find((r) => r.id === where.id);
        if (!row) throw Object.assign(new Error('No record was found for an update.'), { code: 'P2025' });
        Object.assign(row, data);
        return roleRow(row);
      }),
    },
    memberRole: {
      findMany: vi.fn(async ({ where }: any) => world().memberRoles
        .filter((mr) => mr.userId === where.userId && mr.serverId === where.serverId)
        .map((mr) => ({ ...mr, role: roleRow(world().roles.find((r) => r.id === mr.roleId)!) }))),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = world().memberRoles.length;
        world().memberRoles = world().memberRoles.filter((mr) => !(mr.userId === where.userId && mr.serverId === where.serverId));
        return { count: before - world().memberRoles.length };
      }),
      create: vi.fn(async ({ data }: any) => { world().memberRoles.push({ ...data }); return { ...data }; }),
    },
    channel: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = world().channels[where.id];
        return row ? { id: where.id, ...row, server: { ownerId: world().servers[row.serverId]?.ownerId } } : null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const row = world().channels[where.id];
        return row && row.serverId === where.serverId ? { id: where.id, ...row } : null;
      }),
    },
    channelMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { channelId, userId } = where.channelId_userId;
        return world().channelMembers.find((m) => m.channelId === channelId && m.userId === userId) ?? null;
      }),
    },
    channelPermissionOverride: {
      findMany: vi.fn(async ({ where }: any) => world().overrides.filter((o) => o.channelId === where.channelId)),
      findUnique: vi.fn(async ({ where }: any) => {
        const { channelId, roleId } = where.channelId_roleId;
        return world().overrides.find((o) => o.channelId === channelId && o.roleId === roleId) ?? null;
      }),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // The raw statements these routes send here: the space row lock (a
    // creation), the member row lock (a role assignment) and the role row
    // lock (a role or override write); any other is unexpected
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.startsWith('SELECT id FROM servers')) {
        await lockSpaceRow(values[0] as string);
        return world().servers[values[0] as string] ? [{ id: values[0] }] : [];
      }
      if (sql.startsWith('SELECT user_id FROM server_members')) return [];
      if (!/^SELECT (position, is_default|permissions, position) FROM roles/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
      const [roleId, serverId] = values;
      const row = world().roles.find((r) => r.id === roleId && r.serverId === serverId);
      return row ? [{ position: row.position, is_default: row.isDefault, permissions: row.permissions }] : [];
    }),
  };
}

/** What the shared client reads, and what a transaction reads (the same unless a test makes it later). */
let shared: World;
let inTransaction: World;
const sharedClient = clientOf(() => shared);
const txClient = clientOf(() => inTransaction);

const prismaMock: Record<string, any> = {
  ...sharedClient,
  // An interactive transaction runs on the transaction's client, and the row
  // locks it took are released when it ends, whichever way it ends
  $transaction: vi.fn(async (fn: (client: typeof txClient) => unknown) => {
    const releases: Array<() => void> = [];
    try {
      return await transactionLocks.run(releases, () => fn(txClient));
    } finally {
      for (const release of releases) release();
    }
  }),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }),
}));

const mockEmit = vi.fn();
vi.mock('../../websocket/socketServer', () => ({ getIO: () => ({ to: () => ({ emit: mockEmit }) }) }));

/** Who sends the request. */
let caller = 'mod';
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: () => void) => {
    req.user = { userId: caller, username: caller, tokenVersion: 0, role: 'user' };
    next();
  },
  requireVerifiedEmail: (_q: any, _s: any, next: () => void) => next(),
  requireConsent: (_q: any, _s: any, next: () => void) => next(),
}));
vi.mock('../../utils/channelVisibilityRooms', () => ({ syncChannelVisibilityRooms: vi.fn(async () => undefined) }));
vi.mock('../../middleware/rateLimiter', () => ({ rateLimitRoleManage: (_q: any, _s: any, next: () => void) => next() }));

import { roleRouter } from '../../routes/roles';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/v1/servers/:serverId/roles', roleRouter);
app.use(errorHandler);

const answer = async (req: request.Test) => {
  const res = await req;
  return { status: res.status, body: res.body };
};

/**
 * srv1, owned by `owner`: `mod` holds the Mod role (position 5, Manage
 * Roles); `helper` (position 2) is below it. ch1 is a plaintext text channel.
 */
function space(): World {
  const w = emptyWorld();
  w.servers.srv1 = { ownerId: 'owner' };
  w.members.push({ userId: 'owner', serverId: 'srv1' }, { userId: 'mod', serverId: 'srv1' });
  w.roles.push(
    { id: 'r-everyone', serverId: 'srv1', name: 'everyone', position: 0, isDefault: true, permissions: s(DEFAULT_EVERYONE_PERMISSIONS) },
    { id: 'r-mod', serverId: 'srv1', name: 'Mod', position: 5, isDefault: false, permissions: s(Permissions.MANAGE_ROLES) },
    { id: 'r-helper', serverId: 'srv1', name: 'Helper', position: 2, isDefault: false, permissions: '0' },
  );
  w.memberRoles.push({ userId: 'mod', serverId: 'srv1', roleId: 'r-mod' });
  w.channels.ch1 = { serverId: 'srv1', secure: false, type: 'text' };
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  caller = 'mod';
  shared = space();
  inTransaction = shared;
  beforeRoleInsert = null;
  spaceRowHeld.clear();
});

// ─── An override write overtaken by a space delete ──────────────────────────

describe('an override write whose space is deleted while it waits for the role row', () => {
  const put = () => request(app).put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r-helper').send({ allow: s(Permissions.VIEW_CHANNEL), deny: '0' });
  const del = () => request(app).delete('/api/v1/servers/srv1/roles/channels/ch1/permissions/r-helper');

  it.each([['PUT', put], ['DELETE', del]] as const)('%s: 404 Server, nothing written, nothing announced', async (_route, send) => {
    // the early answer sees the space; the transaction runs after its delete committed
    inTransaction = emptyWorld();

    expect(await answer(send())).toEqual({ status: 404, body: { success: false, error: 'Server not found' } });
    expect(txClient.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    expect(txClient.channelPermissionOverride.deleteMany).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it.each([['PUT', put], ['DELETE', del]] as const)('%s by the owner: 404 Server as well', async (_route, send) => {
    caller = 'owner';
    inTransaction = emptyWorld();

    expect(await answer(send())).toEqual({ status: 404, body: { success: false, error: 'Server not found' } });
  });

  it.each([['PUT', put], ['DELETE', del]] as const)('%s: the role alone deleted meanwhile, the space still there: 404 Role', async (_route, send) => {
    inTransaction = space();
    inTransaction.roles = inTransaction.roles.filter((r) => r.id !== 'r-helper');

    expect(await answer(send())).toEqual({ status: 404, body: { success: false, error: 'Role not found' } });
  });

  it.each([['PUT', put], ['DELETE', del]] as const)('%s: nothing deleted meanwhile: the write goes through', async (_route, send) => {
    expect((await answer(send())).status).toBe(200);
    expect(mockEmit).toHaveBeenCalled();
  });
});

// ─── The effective permissions of a channel ────────────────────────────────

/**
 * With a channelId, a channel the CALLER cannot view answers exactly what an
 * id that names no channel of the space answers, for the same target; a
 * secure channel is decided by membership before any fast path, for the
 * caller and for the target. Every answer for a channel the caller views is
 * the channel calculation of the target, as before.
 *
 * The space: `owner`; `mod` (Manage Roles, rank 5); `member` (no role);
 * `staffer` (the Staff role, which the hidden channel lets in). Channels:
 * ch1 (everyone views it), ch-hidden (@everyone denied VIEW_CHANNEL, Staff
 * allowed), ch-sec (secure text, `member` its creator), ch-sec-voice (secure
 * voice, `member`), ch-sec-mod (secure text, `mod` its creator and
 * `member`), ch-elsewhere (another space's), ch-none (no channel).
 */
describe('GET /permissions/effective with a channel', () => {
  const MOD_BITS = DEFAULT_EVERYONE_PERMISSIONS | Permissions.MANAGE_ROLES;
  const EVERYONE_WITHOUT_VIEW = DEFAULT_EVERYONE_PERMISSIONS & ~Permissions.VIEW_CHANNEL;

  function effectiveWorld(): World {
    const w = space();
    w.members.push({ userId: 'member', serverId: 'srv1' }, { userId: 'staffer', serverId: 'srv1' });
    w.roles.push({ id: 'r-staff', serverId: 'srv1', name: 'Staff', position: 1, isDefault: false, permissions: '0' });
    w.memberRoles.push({ userId: 'staffer', serverId: 'srv1', roleId: 'r-staff' });
    w.channels['ch-hidden'] = { serverId: 'srv1', secure: false, type: 'text' };
    w.channels['ch-sec'] = { serverId: 'srv1', secure: true, type: 'text' };
    w.channels['ch-sec-voice'] = { serverId: 'srv1', secure: true, type: 'voice' };
    w.channels['ch-sec-mod'] = { serverId: 'srv1', secure: true, type: 'text' };
    w.servers.srv2 = { ownerId: 'owner' };
    w.channels['ch-elsewhere'] = { serverId: 'srv2', secure: false, type: 'text' };
    w.overrides.push(
      { channelId: 'ch-hidden', roleId: 'r-everyone', allow: '0', deny: s(Permissions.VIEW_CHANNEL) },
      { channelId: 'ch-hidden', roleId: 'r-staff', allow: s(Permissions.VIEW_CHANNEL), deny: '0' },
    );
    w.channelMembers.push(
      { channelId: 'ch-sec', userId: 'member', isCreator: true },
      { channelId: 'ch-sec-voice', userId: 'member', isCreator: false },
      { channelId: 'ch-sec-mod', userId: 'mod', isCreator: true },
      { channelId: 'ch-sec-mod', userId: 'member', isCreator: false },
    );
    return w;
  }

  beforeEach(() => {
    shared = effectiveWorld();
    inTransaction = shared;
  });

  async function effective(asker: string, target: string, channelId: string) {
    caller = asker;
    const query = target === asker ? `channelId=${channelId}` : `channelId=${channelId}&userId=${target}`;
    const res = await request(app).get(`/api/v1/servers/srv1/roles/permissions/effective?${query}`);
    expect(res.status).toBe(200);
    return res.body.data as { permissions: string; source: string };
  }

  const NONE = { permissions: '0', source: 'computed' };
  const bits = (value: bigint, source = 'computed') => ({ permissions: s(value), source });
  const OWNER_ALL = bits(ALL_PERMISSIONS, 'owner');

  // caller, target, channel, the answer
  const table: Array<[string, string, string, { permissions: string; source: string }]> = [
    // a member about themselves
    ['member', 'member', 'ch1', bits(DEFAULT_EVERYONE_PERMISSIONS)],
    ['member', 'member', 'ch-hidden', NONE],
    ['member', 'member', 'ch-none', NONE],
    ['member', 'member', 'ch-elsewhere', NONE],
    ['member', 'member', 'ch-sec', bits(SECURE_CREATOR_PERMISSIONS)],
    ['member', 'member', 'ch-sec-voice', bits(SECURE_VOICE_MEMBER_PERMISSIONS)],
    ['member', 'member', 'ch-sec-mod', bits(SECURE_MEMBER_PERMISSIONS)],
    // a manager about themselves
    ['mod', 'mod', 'ch1', bits(MOD_BITS)],
    ['mod', 'mod', 'ch-hidden', NONE],
    ['mod', 'mod', 'ch-sec', NONE],
    ['mod', 'mod', 'ch-sec-mod', bits(SECURE_CREATOR_PERMISSIONS)],
    // a manager about another member, in channels the manager cannot view
    ['mod', 'staffer', 'ch-hidden', NONE],
    ['mod', 'member', 'ch-hidden', NONE],
    ['mod', 'member', 'ch-sec', NONE],
    ['mod', 'member', 'ch-sec-voice', NONE],
    ['mod', 'member', 'ch-elsewhere', NONE],
    ['mod', 'member', 'ch-none', NONE],
    // ... and in channels the manager views
    ['mod', 'staffer', 'ch1', bits(DEFAULT_EVERYONE_PERMISSIONS)],
    ['mod', 'member', 'ch1', bits(DEFAULT_EVERYONE_PERMISSIONS)],
    ['mod', 'member', 'ch-sec-mod', bits(SECURE_MEMBER_PERMISSIONS)],
    ['mod', 'staffer', 'ch-sec-mod', NONE],
    // a manager about the owner
    ['mod', 'owner', 'ch1', OWNER_ALL],
    ['mod', 'owner', 'ch-hidden', NONE],
    ['mod', 'owner', 'ch-sec', NONE],
    ['mod', 'owner', 'ch-sec-mod', NONE],
    ['mod', 'owner', 'ch-none', NONE],
    // the owner about themselves
    ['owner', 'owner', 'ch1', OWNER_ALL],
    ['owner', 'owner', 'ch-hidden', OWNER_ALL],
    ['owner', 'owner', 'ch-sec', NONE],
    ['owner', 'owner', 'ch-none', NONE],
    ['owner', 'owner', 'ch-elsewhere', NONE],
    // the owner about others: every plaintext channel is the owner's to view
    ['owner', 'member', 'ch-hidden', bits(EVERYONE_WITHOUT_VIEW)],
    ['owner', 'staffer', 'ch-hidden', bits(DEFAULT_EVERYONE_PERMISSIONS)],
    ['owner', 'member', 'ch-sec', NONE],
    ['owner', 'member', 'ch-none', NONE],
  ];

  it.each(table)('%s asking about %s in %s', async (asker, target, channelId, expected) => {
    expect(await effective(asker, target, channelId)).toEqual(expected);
  });

  /** The channels each caller views (the rest it cannot). */
  const VIEWS: Record<string, string[]> = {
    member: ['ch1', 'ch-sec', 'ch-sec-voice', 'ch-sec-mod'],
    mod: ['ch1', 'ch-sec-mod'],
    owner: ['ch1', 'ch-hidden'],
  };

  it.each([
    ['member', 'member'], ['mod', 'mod'], ['mod', 'member'], ['mod', 'staffer'], ['mod', 'owner'], ['owner', 'owner'], ['owner', 'member'],
  ])('%s about %s: every channel the caller cannot view answers what an unknown id answers', async (asker, target) => {
    const unknown = await effective(asker, target, 'ch-none');
    for (const channelId of ['ch-hidden', 'ch-sec', 'ch-sec-voice', 'ch-sec-mod', 'ch-elsewhere']) {
      if (VIEWS[asker].includes(channelId)) continue;
      expect({ channelId, answer: await effective(asker, target, channelId) }).toEqual({ channelId, answer: unknown });
    }
  });

  it('a channel the caller cannot view reads nothing of the target in it', async () => {
    await effective('mod', 'member', 'ch-sec');

    // the secure membership was asked of the caller only
    const asked = sharedClient.channelMember.findUnique.mock.calls.map(([arg]: any[]) => arg.where.channelId_userId.userId);
    expect(asked).toEqual(['mod']);
  });

  it('without a channel: the server-level answer, unchanged (the owner holds every bit)', async () => {
    caller = 'mod';
    const owner = await request(app).get('/api/v1/servers/srv1/roles/permissions/effective?userId=owner');
    const member = await request(app).get('/api/v1/servers/srv1/roles/permissions/effective?userId=member');

    expect(owner.body.data).toEqual(OWNER_ALL);
    expect(member.body.data).toEqual(bits(DEFAULT_EVERYONE_PERMISSIONS));
  });
});

// ─── Where a new role goes ──────────────────────────────────────────────────

/**
 * A creation moves no existing role. A new role goes one position below its
 * creator's highest one (P - 1), so it is below them by the rule every later
 * edit, assignment, override and delete of it is judged by; a role already
 * at that position shares it, and every rank comparison treats the two as
 * equal. The owner's goes on top. A creator whose highest position is 0 is
 * refused.
 *
 * The space: `owner`; `c1`, `c2`, `c5` hold One (1), TwoA (2) and Five (5),
 * each with Manage Roles, and `c5b` holds Five too; TwoB (2) ties with TwoA;
 * FiveOld (5) ties with Five; Three (3) and Admin (7) are held by nobody;
 * `zero` holds only Old0, a role at 0 with Manage Roles; `member` holds no
 * role.
 */
describe('POST /roles: a new role goes one position below its creator, and no existing role moves', () => {
  const MANAGE = s(Permissions.MANAGE_ROLES);
  const BEFORE: Record<string, number> = {
    'r-everyone': 0, 'r-old0': 0, 'r-one': 1, 'r-two-a': 2, 'r-two-b': 2, 'r-three': 3, 'r-five': 5, 'r-five-old': 5, 'r-admin': 7,
  };

  function orderWorld(): World {
    const w = emptyWorld();
    w.servers.srv1 = { ownerId: 'owner' };
    for (const userId of ['owner', 'c1', 'c2', 'c5', 'c5b', 'zero', 'member']) w.members.push({ userId, serverId: 'srv1' });
    const role = (id: string, name: string, permissions = '0') => ({ id, serverId: 'srv1', name, position: BEFORE[id], isDefault: false, permissions });
    w.roles.push(
      { id: 'r-everyone', serverId: 'srv1', name: 'everyone', position: 0, isDefault: true, permissions: s(DEFAULT_EVERYONE_PERMISSIONS) },
      role('r-old0', 'Old0', MANAGE),
      role('r-one', 'One', MANAGE),
      role('r-two-a', 'TwoA', MANAGE),
      role('r-two-b', 'TwoB'),
      role('r-three', 'Three'),
      role('r-five', 'Five', MANAGE),
      role('r-five-old', 'FiveOld'),
      role('r-admin', 'Admin'),
    );
    w.memberRoles.push(
      { userId: 'c1', serverId: 'srv1', roleId: 'r-one' },
      { userId: 'c2', serverId: 'srv1', roleId: 'r-two-a' },
      { userId: 'c5', serverId: 'srv1', roleId: 'r-five' },
      { userId: 'c5b', serverId: 'srv1', roleId: 'r-five' },
      { userId: 'zero', serverId: 'srv1', roleId: 'r-old0' },
    );
    w.channels.ch1 = { serverId: 'srv1', secure: false, type: 'text' };
    return w;
  }

  beforeEach(() => {
    shared = orderWorld();
    inTransaction = shared;
  });

  const positions = () => Object.fromEntries(shared.roles.map((r) => [r.id, r.position]));
  const emitted = () => mockEmit.mock.calls.map(([event]) => event);
  const create = (asker: string, name: string) => {
    caller = asker;
    return request(app).post('/api/v1/servers/srv1/roles').send({ name });
  };
  const refusal = async (req: request.Test) => {
    const res = await req;
    return { status: res.status, error: res.body.error };
  };

  it.each([
    ['c5', 5, 4],
    ['c2', 2, 1],
    ['c1', 1, 0],
  ] as const)('%s (highest position %i): the new role goes to %i, no existing role moves, and the creator can then edit it, set its override, assign it and delete it', async (creator, _highest, expected) => {
    const res = await create(creator, 'New');

    expect(res.status).toBe(201);
    const id = res.body.data.id as string;
    expect(positions()).toEqual({ ...BEFORE, [id]: expected });
    expect(emitted()).toEqual([WS_EVENTS.ROLE_CREATED]);

    caller = creator;
    expect((await request(app).patch(`/api/v1/servers/srv1/roles/${id}`).send({ permissions: s(Permissions.VIEW_CHANNEL) })).status).toBe(200);
    expect((await request(app).put(`/api/v1/servers/srv1/roles/channels/ch1/permissions/${id}`).send({ allow: s(Permissions.VIEW_CHANNEL), deny: '0' })).status).toBe(200);
    expect((await request(app).patch('/api/v1/servers/srv1/roles/members/member').send({ roleIds: [id] })).status).toBe(200);
    expect(shared.memberRoles).toContainEqual({ userId: 'member', serverId: 'srv1', roleId: id });
    expect((await request(app).delete(`/api/v1/servers/srv1/roles/${id}`)).status).toBe(200);
    expect(shared.roles.some((r) => r.id === id)).toBe(false);
    expect(positions()).toEqual(BEFORE);
  });

  it('a second role by the same creator shares the first\'s position, and no existing role moves at either creation', async () => {
    const first = await create('c5', 'First');
    expect(positions()).toEqual({ ...BEFORE, [first.body.data.id]: 4 });
    const second = await create('c5', 'Second');

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(positions()).toEqual({ ...BEFORE, [first.body.data.id]: 4, [second.body.data.id]: 4 });
  });

  it('a role placed beside an existing one ranks equal with it: the holder of the existing role cannot edit or delete the new one, its creator can', async () => {
    // c2 (highest 2) places New at 1, beside One, which c1 holds
    const id = (await create('c2', 'New')).body.data.id as string;
    expect(positions()).toMatchObject({ [id]: 1, 'r-one': 1 });

    caller = 'c1';
    expect(await refusal(request(app).patch(`/api/v1/servers/srv1/roles/${id}`).send({ name: 'Renamed' })))
      .toEqual({ status: 403, error: 'Cannot edit a role at or above your own position' });
    expect(await refusal(request(app).delete(`/api/v1/servers/srv1/roles/${id}`)))
      .toEqual({ status: 403, error: 'Cannot delete a role at or above your own position' });

    caller = 'c2';
    expect((await request(app).patch(`/api/v1/servers/srv1/roles/${id}`).send({ name: 'Renamed' })).status).toBe(200);
  });

  it('a role tied with its creator\'s own stays where it is: the creator still cannot manage it', async () => {
    await create('c5', 'New');

    expect(positions()).toMatchObject({ 'r-five': 5, 'r-five-old': 5 });
    caller = 'c5';
    expect(await refusal(request(app).patch('/api/v1/servers/srv1/roles/r-five-old').send({ permissions: s(Permissions.VIEW_CHANNEL) })))
      .toEqual({ status: 403, error: 'Cannot edit a role at or above your own position' });
  });

  it('the owner\'s role goes on top, one above the highest, and moves nothing: role:created alone', async () => {
    const res = await create('owner', 'Top');

    expect(res.status).toBe(201);
    expect(positions()).toEqual({ ...BEFORE, [res.body.data.id]: 8 });
    expect(emitted()).toEqual([WS_EVENTS.ROLE_CREATED]);
  });

  it.each([
    ['a member who may manage roles through @everyone and holds no role', 'member'],
    ['a member whose only role sits at 0, @everyone\'s position', 'zero'],
  ])('%s: 403, nothing created', async (_who, asker) => {
    shared.roles[0].permissions = s(DEFAULT_EVERYONE_PERMISSIONS | Permissions.MANAGE_ROLES);

    expect(await refusal(create(asker, 'New'))).toEqual({ status: 403, error: 'Your role is too low in the role order to create roles' });
    expect(positions()).toEqual(BEFORE);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  /** The read hooks a test installed, taken out after it. */
  const restore: Array<() => void> = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  /**
   * The creator's own creation, run to its commit as a separate request, in
   * the middle of another request of theirs: right after that request reads
   * `roleId` through `client` (the shared client, or the transaction's). The
   * new role is named `name`.
   */
  function creationAfterReadOf(client: typeof sharedClient, method: 'findFirst' | 'findMany', roleId: string, name: string) {
    const original = client.role[method].getMockImplementation()!;
    restore.push(() => client.role[method].mockImplementation(original as any));
    let pending = true;
    client.role[method].mockImplementation(async (args: any) => {
      const answer = await (original as (a: any) => Promise<unknown>)(args);
      const names = method === 'findFirst' ? args.where.id === roleId : args.where.id?.in?.includes(roleId);
      if (names && pending) {
        pending = false;
        const created = await request(app).post('/api/v1/servers/srv1/roles').send({ name });
        expect(created.status).toBe(201);
      }
      return answer;
    });
  }

  it.each([
    ['the delete of a role tied with them', () => request(app).delete('/api/v1/servers/srv1/roles/r-five-old'), 'r-five-old', 'Cannot delete a role at or above your own position'],
    ['the rename of a role tied with them', () => request(app).patch('/api/v1/servers/srv1/roles/r-five-old').send({ name: 'Renamed' }), 'r-five-old', 'Cannot edit a role at or above your own position'],
    ['the delete of their own top role', () => request(app).delete('/api/v1/servers/srv1/roles/r-five'), 'r-five', 'Cannot delete a role at or above your own position'],
    ['the rename of their own top role', () => request(app).patch('/api/v1/servers/srv1/roles/r-five').send({ name: 'Renamed' }), 'r-five', 'Cannot edit a role at or above your own position'],
  ] as const)('a creation of theirs committed between the role read and the rank read of %s: still refused', async (_what, send, roleId, error) => {
    caller = 'c5';
    creationAfterReadOf(sharedClient, 'findFirst', roleId, 'During');

    expect(await refusal(send())).toEqual({ status: 403, error });
    // the creation committed in between, below them, and moved nothing
    expect(positions()).toEqual({ ...BEFORE, 'r-During': 4 });
  });

  it('creations of theirs committed between the role read and the rank read of an assignment, early and inside the transaction: a role tied with them is still refused', async () => {
    caller = 'c5';
    creationAfterReadOf(sharedClient, 'findMany', 'r-five-old', 'DuringEarly');
    creationAfterReadOf(txClient, 'findMany', 'r-five-old', 'DuringInside');

    expect(await refusal(request(app).patch('/api/v1/servers/srv1/roles/members/member').send({ roleIds: ['r-five-old'] })))
      .toEqual({ status: 403, error: 'Cannot assign roles at or above your own position' });
    expect(shared.memberRoles.some((mr) => mr.userId === 'member')).toBe(false);
    // refused at the early answer: the creation inside the transaction never runs
    expect(positions()).toEqual({ ...BEFORE, 'r-DuringEarly': 4 });
  });

  /**
   * Two creations sent at once: the first stops right before its insert,
   * with the space row held; the second is sent meanwhile and goes as far as
   * it can before the first resumes.
   */
  async function twoAtOnce(first: () => request.Test, second: () => request.Test) {
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let waiting = true;
    beforeRoleInsert = async () => {
      if (!waiting) return;
      waiting = false;
      await paused;
    };

    const a = first().then((res) => res);
    await vi.waitFor(() => expect(waiting).toBe(false));
    const b = second().then((res) => res);
    await vi.waitFor(() => expect(prismaMock.$transaction).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    resume();
    return Promise.all([a, b]);
  }

  it('two owner creations at once run one after the other on the space row: the second goes above the first', async () => {
    const [resA, resB] = await twoAtOnce(() => create('owner', 'A'), () => create('owner', 'B'));

    expect([resA.status, resB.status]).toEqual([201, 201]);
    // the second read the highest position after the first's insert: 9, not 8
    expect(positions()).toEqual({ ...BEFORE, [resA.body.data.id]: 8, [resB.body.data.id]: 9 });
  });

  it('two creations at once with one role left under the cap: the first is created, the second counts it and gets the cap\'s answer', async () => {
    const held = Object.keys(BEFORE).filter((id) => id !== 'r-everyone').length;
    for (let i = held; i < LIMITS.MAX_ROLES_PER_SERVER - 1; i++) {
      shared.roles.push({ id: `r-fill-${i}`, serverId: 'srv1', name: `Fill${i}`, position: 3, isDefault: false, permissions: '0' });
    }

    const [resA, resB] = await twoAtOnce(() => create('c5', 'A'), () => create('c5b', 'B'));

    expect(resA.status).toBe(201);
    expect({ status: resB.status, error: resB.body.error }).toEqual({ status: 400, error: `Server can have at most ${LIMITS.MAX_ROLES_PER_SERVER} roles` });
    expect(shared.roles.filter((r) => !r.isDefault)).toHaveLength(LIMITS.MAX_ROLES_PER_SERVER);
  });

  it('the space deleted while the creation waited for its row: 404 Server, nothing created', async () => {
    inTransaction = emptyWorld();

    expect(await answer(create('c5', 'New'))).toEqual({ status: 404, body: { success: false, error: 'Server not found' } });
    expect(positions()).toEqual(BEFORE);
  });
});
