import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Permissions, ALL_PERMISSIONS, LEGACY_CLIENT_KNOWN_PERMISSIONS, WS_EVENTS, permissionsToString } from '@voxium/shared';
import { lazyStatement } from '../helpers/lazyStatement';

/**
 * Role and channel-override writes MERGE into the stored bitmask (#75): the
 * bits the client names in `knownPermissions` come from the request, every
 * other bit stays as stored, and a request without the field is read as a
 * 2.1.x client's (LEGACY_CLIENT_KNOWN_PERMISSIONS). The merge runs in one
 * transaction under the role row, where every check is made again against
 * the value the write overwrites.
 */

// A bit no flag uses yet: a permission added after this build. The only way
// to store one is to hand it to the route as the stored value (the locked
// row, or the override read), which is what a newer server would have written.
const FUTURE = 1n << 22n;
const s = permissionsToString;

// ─── Mocks ──────────────────────────────────────────────────────────────────

/** Every statement and check, with the client it ran on, in order. */
let order: string[] = [];

/** The transaction's own client: a model of its own per call, so a read on the shared client inside it shows. */
const tx = {
  $queryRaw: vi.fn(),
  role: { update: vi.fn() },
  channel: { findFirst: vi.fn() },
  channelPermissionOverride: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
};

const prismaMock: Record<string, any> = {
  role: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  channel: { findFirst: vi.fn() },
  channelPermissionOverride: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get: (_t, prop) => prismaMock[prop as string] }),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
vi.mock('../../websocket/socketServer', () => ({ getIO: vi.fn(() => ({ to: mockTo })) }));

const mockHasServerPermission = vi.fn();
const mockGetHighestRolePosition = vi.fn();
const mockGetEffectivePermissions = vi.fn();
const mockComputeServerPermissions = vi.fn();
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: any[]) => mockHasServerPermission(...args),
  hasChannelPermission: vi.fn(),
  getHighestRolePosition: (...args: any[]) => mockGetHighestRolePosition(...args),
  getEffectivePermissions: (...args: any[]) => mockGetEffectivePermissions(...args),
  computeServerPermissions: (...args: any[]) => mockComputeServerPermissions(...args),
}));

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: () => void) => {
    req.user = { userId: 'actor', username: 'actor', tokenVersion: 0, role: 'user' };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: () => void) => next(),
  requireConsent: (_req: any, _res: any, next: () => void) => next(),
}));

const mockSync = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/channelVisibilityRooms', () => ({
  syncChannelVisibilityRooms: (...args: any[]) => mockSync(...args),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitRoleManage: (_req: any, _res: any, next: () => void) => next(),
}));

import { roleRouter } from '../../routes/roles';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers/:serverId/roles', roleRouter);
  app.use(errorHandler);
  return app;
}
let app: express.Express;

// ─── Scenario builders ──────────────────────────────────────────────────────

interface Actor {
  /** Infinity for the owner. */
  rank: number;
  /** What the actor holds (ignored for the owner). */
  holds: bigint;
}
const OWNER: Actor = { rank: Infinity, holds: ALL_PERMISSIONS };
const MODERATOR: Actor = { rank: 5, holds: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES };

/**
 * The actor's checks on either client, each named in `order` with the client
 * it read through: on the shared client (the early answer) as given; on the
 * transaction's as `inTx` says when given (what holds once the row is theirs).
 */
function actorIs(actor: Actor, inTx: Partial<Actor & { mayManage: boolean }> = {}) {
  mockHasServerPermission.mockImplementation(async (_u: string, _s: string, _p: bigint, db?: unknown) => {
    order.push(db === tx ? 'tx:may-manage' : 'may-manage');
    return db === tx ? inTx.mayManage ?? true : true;
  });
  mockGetHighestRolePosition.mockImplementation(async (_u: string, _s: string, db?: unknown) => {
    order.push(db === tx ? 'tx:rank' : 'rank');
    return db === tx ? inTx.rank ?? actor.rank : actor.rank;
  });
  mockGetEffectivePermissions.mockImplementation(async () => {
    order.push('holds');
    return { permissions: s(actor.holds), source: actor.rank === Infinity ? 'owner' : 'computed' };
  });
  mockComputeServerPermissions.mockImplementation(async (_u: string, _s: string, db?: unknown) => {
    order.push(db === tx ? 'tx:holds' : 'holds (shared client)');
    return inTx.holds ?? actor.holds;
  });
}

/** The role as the route reads it first (the early answer) and as its locked row answers inside the transaction. */
function roleIs(early: { permissions: bigint; position?: number; isDefault?: boolean }, locked: { permissions: bigint; position?: number; isDefault?: boolean } | null = early) {
  prismaMock.role.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.name !== undefined) return null; // the duplicate-name check finds none
    order.push('role');
    return {
      id: 'role1', serverId: 'srv1', name: 'Mod', color: null,
      position: early.position ?? 2, isDefault: early.isDefault ?? false, permissions: s(early.permissions),
    };
  });
  tx.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) =>
    lazyStatement(order, `tx:${strings.join('?')} [${values.join(',')}]`, locked === null ? [] : [{
      permissions: s(locked.permissions), position: locked.position ?? 2, is_default: locked.isDefault ?? false,
    }]));
  tx.role.update.mockImplementation(async ({ data }: any) => {
    order.push('tx:role.update');
    return { id: 'role1', serverId: 'srv1', name: data.name ?? 'Mod', color: null, position: 2, isDefault: false, permissions: data.permissions };
  });
  prismaMock.role.update.mockImplementation(async ({ data }: any) => {
    order.push('role.update');
    return { id: 'role1', serverId: 'srv1', name: data.name ?? 'Mod', color: null, position: 2, isDefault: false, permissions: s(early.permissions) };
  });
}

/** The override as read for the early answer and as read again inside the transaction (null: none stored). */
function overrideIs(early: { allow: bigint; deny: bigint } | null, inTx: { allow: bigint; deny: bigint } | null = early) {
  prismaMock.channel.findFirst.mockImplementation(async () => { order.push('channel'); return { id: 'ch1', serverId: 'srv1', secure: false }; });
  tx.channel.findFirst.mockImplementation(async () => { order.push('tx:channel'); return { secure: false }; });
  prismaMock.role.findFirst.mockImplementation(async () => { order.push('role'); return { id: 'role1', serverId: 'srv1', position: 2, isDefault: false }; });
  tx.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) =>
    lazyStatement(order, `tx:${strings.join('?')} [${values.join(',')}]`, [{ position: 2, is_default: false }]));
  prismaMock.channelPermissionOverride.findUnique.mockImplementation(async () => {
    order.push('override');
    return early && { allow: s(early.allow), deny: s(early.deny) };
  });
  tx.channelPermissionOverride.findUnique.mockImplementation(async () => {
    order.push('tx:override');
    return inTx && { allow: s(inTx.allow), deny: s(inTx.deny) };
  });
  tx.channelPermissionOverride.upsert.mockImplementation(async () => { order.push('tx:override.upsert'); return {}; });
  tx.channelPermissionOverride.deleteMany.mockImplementation(async () => { order.push('tx:override.deleteMany'); return { count: 1 }; });
  prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
}

const patchRole = (body: Record<string, unknown>) => request(app).patch('/api/v1/servers/srv1/roles/role1').send(body);
const putOverride = (body: Record<string, unknown>) => request(app).put('/api/v1/servers/srv1/roles/channels/ch1/permissions/role1').send(body);
const createRole = (body: Record<string, unknown>) => request(app).post('/api/v1/servers/srv1/roles').send(body);

/** What the role write stored, as bits. */
const storedRole = () => BigInt((tx.role.update.mock.calls[0][0] as any).data.permissions);
/** What the override write stored ('deleted' when it removed the row). */
function storedOverride(): { allow: bigint; deny: bigint } | 'deleted' {
  if (tx.channelPermissionOverride.deleteMany.mock.calls.length > 0) return 'deleted';
  const { update, create } = tx.channelPermissionOverride.upsert.mock.calls[0][0] as any;
  expect(create).toEqual({ channelId: 'ch1', roleId: 'role1', ...update });
  return { allow: BigInt(update.allow), deny: BigInt(update.deny) };
}

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  prismaMock.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown, opts?: unknown) => {
    order.push(`txn ${JSON.stringify(opts)}`);
    return fn(tx);
  });
  app = createApp();
});

// ─── The role update ────────────────────────────────────────────────────────

describe('PATCH /roles/:roleId — the permissions are merged into the stored value', () => {
  it('a knownPermissions narrower than the role keeps every stored bit outside it', async () => {
    actorIs(OWNER);
    // the client knows VIEW_CHANNEL, SEND_MESSAGES and KICK_MEMBERS, not MANAGE_WEBHOOKS
    const known = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.KICK_MEMBERS;
    roleIs({ permissions: Permissions.VIEW_CHANNEL | Permissions.KICK_MEMBERS | Permissions.MANAGE_WEBHOOKS });

    // it clears VIEW_CHANNEL and KICK_MEMBERS, sets SEND_MESSAGES
    const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(known) });

    expect(res.status).toBe(200);
    expect(storedRole()).toBe(Permissions.SEND_MESSAGES | Permissions.MANAGE_WEBHOOKS);
    // the merged value is what the response and the event carry
    expect(BigInt(res.body.data.permissions)).toBe(Permissions.SEND_MESSAGES | Permissions.MANAGE_WEBHOOKS);
    expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.ROLE_UPDATED, { serverId: 'srv1', role: expect.objectContaining({ permissions: s(Permissions.SEND_MESSAGES | Permissions.MANAGE_WEBHOOKS) }) });
  });

  it('a request without knownPermissions (a 2.1.x client) keeps a stored bit outside the 2.1.x set', async () => {
    actorIs(OWNER);
    roleIs({ permissions: Permissions.VIEW_CHANNEL | FUTURE });

    // the 2.1.x editor read the role without the bit and sends what it shows, plus SEND_MESSAGES
    const res = await patchRole({ permissions: s(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES) });

    expect(res.status).toBe(200);
    expect(storedRole()).toBe(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | FUTURE);
  });

  it('a request without knownPermissions still sets and clears every bit that exists today', async () => {
    actorIs(OWNER);
    roleIs({ permissions: Permissions.VIEW_CHANNEL | Permissions.MANAGE_WEBHOOKS });

    const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES | Permissions.CREATE_SECURE_CHANNELS) });

    expect(res.status).toBe(200);
    expect(storedRole()).toBe(Permissions.SEND_MESSAGES | Permissions.CREATE_SECURE_CHANNELS);
  });

  it('a current client (knownPermissions = every bit it knows) sets and clears bits inside its mask', async () => {
    actorIs(OWNER);
    roleIs({ permissions: Permissions.VIEW_CHANNEL | Permissions.KICK_MEMBERS | FUTURE });

    const res = await patchRole({ permissions: s(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

    expect(res.status).toBe(200);
    expect(storedRole()).toBe(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | FUTURE);
  });

  it('a knownPermissions naming bits this server does not know is masked with the server\'s own: those bits stay as stored', async () => {
    actorIs(OWNER);
    roleIs({ permissions: FUTURE });

    // a newer client knows the bit and clears it; this server does not know it, so it is not the client's to clear here
    const res = await patchRole({ permissions: '0', knownPermissions: s(ALL_PERMISSIONS | FUTURE) });

    expect(res.status).toBe(200);
    expect(storedRole()).toBe(FUTURE);
  });

  it('the row FIRST (FOR NO KEY UPDATE), then every check on the transaction\'s client, then the write, with the long budget', async () => {
    actorIs(MODERATOR);
    roleIs({ permissions: Permissions.VIEW_CHANNEL });

    expect((await patchRole({ permissions: s(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) })).status).toBe(200);

    expect(order).toEqual([
      // the early answer, on the shared client
      'may-manage',
      'role',
      'rank',
      'holds',
      `txn ${JSON.stringify({ timeout: 60_000, maxWait: 10_000 })}`,
      'tx:SELECT permissions, position FROM roles WHERE id = ? AND server_id = ? FOR NO KEY UPDATE [role1,srv1]',
      'tx:may-manage',
      'tx:rank',
      'tx:holds',
      'tx:role.update',
    ]);
    expect(prismaMock.role.update).not.toHaveBeenCalled();
  });

  it('a rename sends no permissions: one plain update, no transaction, the stored bits untouched, no room re-sync', async () => {
    actorIs(OWNER);
    roleIs({ permissions: Permissions.VIEW_CHANNEL | FUTURE });

    const res = await patchRole({ name: 'Helpers' });

    expect(res.status).toBe(200);
    expect(prismaMock.role.update).toHaveBeenCalledWith({ where: { id: 'role1' }, data: { name: 'Helpers' } });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('a role gone by the time the lock is taken: 404 Role, nothing written, nothing announced', async () => {
    actorIs(OWNER);
    roleIs({ permissions: 0n }, null);

    const res = await patchRole({ permissions: s(Permissions.VIEW_CHANNEL) });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Role not found');
    expect(tx.role.update).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a transaction PostgreSQL aborted to break a deadlock runs again whole, the lock and the checks included', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    actorIs(OWNER);
    roleIs({ permissions: 0n });
    const real = prismaMock.$transaction.getMockImplementation()!;
    prismaMock.$transaction
      .mockImplementationOnce(async () => { throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' }); })
      .mockImplementation(real);
    try {
      expect((await patchRole({ permissions: s(Permissions.VIEW_CHANNEL) })).status).toBe(200);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(storedRole()).toBe(Permissions.VIEW_CHANNEL);
    } finally {
      warn.mockRestore();
    }
  });

  describe('the room re-sync follows the MERGED value', () => {
    it('a write whose only change falls outside the client\'s mask changes nothing: no re-sync (the event still goes out)', async () => {
      actorIs(OWNER);
      roleIs({ permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES });

      // the client does not know VIEW_CHANNEL: its cleared bit is not its to clear
      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(Permissions.SEND_MESSAGES) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES);
      expect(mockSync).not.toHaveBeenCalled();
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.ROLE_UPDATED, expect.anything());
    });

    it('the same request from a client that knows VIEW_CHANNEL clears it: the rooms re-sync', async () => {
      actorIs(OWNER);
      roleIs({ permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.SEND_MESSAGES);
      expect(mockSync).toHaveBeenCalledWith('srv1');
    });
  });

  describe('the actor must hold every bit the write turns ON; turning one off, or leaving it as stored, is never refused', () => {
    it('a grant of a bit the actor lacks, sent with the full mask: 403, before any transaction', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: 0n });

      const res = await patchRole({ permissions: s(Permissions.KICK_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot grant permissions you do not have');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('a bit the actor lacks, left as stored while they change one they hold: 200, the bit kept', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: Permissions.KICK_MEMBERS });

      const res = await patchRole({ permissions: s(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES);
    });

    it('clearing a bit the actor lacks is never refused: 200, cleared', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.SEND_MESSAGES);
    });

    it('a 2.1.x save (no mask) clearing a bit the actor lacks succeeds, as it did before', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: Permissions.KICK_MEMBERS });

      const res = await patchRole({ permissions: '0' });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(0n);
    });

    it('a bit the actor lacks, sent but outside the client\'s mask, is dropped and never judged', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: 0n });

      const res = await patchRole({ permissions: s(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES), knownPermissions: s(Permissions.SEND_MESSAGES) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.SEND_MESSAGES);
    });

    it('the row changed between the early answer and the lock (a bit the actor lacks taken away meanwhile): the save that keeps it turns it on again, judged as a grant, 403, nothing written', async () => {
      actorIs(MODERATOR);
      // read early with KICK_MEMBERS (so leaving it looked like no change), locked without it
      roleIs({ permissions: Permissions.KICK_MEMBERS }, { permissions: 0n });

      const res = await patchRole({ permissions: s(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot grant permissions you do not have');
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.role.update).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('a bit the actor lacks added meanwhile, outside the client\'s mask: kept, and not counted as the actor turning it on (judged against the locked row)', async () => {
      actorIs(MODERATOR);
      // read early without KICK_MEMBERS, locked with it
      roleIs({ permissions: 0n }, { permissions: Permissions.KICK_MEMBERS });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(Permissions.SEND_MESSAGES) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES);
    });

    it('a bit the actor lacks added meanwhile, inside the client\'s mask: the save that does not carry it clears it, 200 (a turn-off is never refused)', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: 0n }, { permissions: Permissions.KICK_MEMBERS });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.SEND_MESSAGES);
    });

    it('a bit the actor lacks added meanwhile does not let them turn on another one they lack: 403 inside the transaction', async () => {
      actorIs(MODERATOR);
      // read early with MUTE_MEMBERS (kept, so no turn-on there), locked with
      // KICK_MEMBERS instead: against the row it overwrites, keeping
      // MUTE_MEMBERS turns it on, whatever was added beside it
      roleIs({ permissions: Permissions.MUTE_MEMBERS }, { permissions: Permissions.KICK_MEMBERS });

      const res = await patchRole({ permissions: s(Permissions.MUTE_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot grant permissions you do not have');
      // the early answer let it through: the refusal is the transaction's
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.role.update).not.toHaveBeenCalled();
    });

    it('what the actor holds is read again on the transaction\'s client: lost meanwhile, 403', async () => {
      actorIs(MODERATOR, { holds: Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES });
      roleIs({ permissions: 0n });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(tx.role.update).not.toHaveBeenCalled();
    });

    it('a bit outside the client\'s mask is never the client\'s act, whoever holds it', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: Permissions.KICK_MEMBERS });

      // the client does not know KICK_MEMBERS: its cleared KICK_MEMBERS is no clearing at all
      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(Permissions.SEND_MESSAGES) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES);
    });

    it('the owner may set and clear anything', async () => {
      actorIs(OWNER);
      roleIs({ permissions: Permissions.ADMINISTRATOR });

      const res = await patchRole({ permissions: s(Permissions.MANAGE_WEBHOOKS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedRole()).toBe(Permissions.MANAGE_WEBHOOKS);
      expect(mockComputeServerPermissions).not.toHaveBeenCalled();
    });
  });

  describe('the other checks hold once the row is theirs', () => {
    it('a role at or above the actor by then (moved up meanwhile): 403, nothing written', async () => {
      actorIs(MODERATOR);
      roleIs({ permissions: 0n, position: 2 }, { permissions: 0n, position: 5 });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot edit a role at or above your own position');
      expect(tx.role.update).not.toHaveBeenCalled();
    });

    it('an actor ranked down to the role by then: 403, nothing written', async () => {
      actorIs(MODERATOR, { rank: 2 });
      roleIs({ permissions: 0n, position: 2 });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot edit a role at or above your own position');
      expect(tx.role.update).not.toHaveBeenCalled();
    });

    it('an actor who may no longer manage roles by then: 403, nothing written', async () => {
      actorIs(MODERATOR, { mayManage: false });
      roleIs({ permissions: 0n });

      const res = await patchRole({ permissions: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have permission to manage roles');
      expect(tx.role.update).not.toHaveBeenCalled();
    });
  });
});

// ─── knownPermissions must be a permission bitmask string ────────────────────

describe('a knownPermissions that is not a permission bitmask string is a 400 on every write', () => {
  const malformed: unknown[] = ['', ' 1', '1 ', '0x10', '-1', '+1', '1e3', '12a', 'abc', '1'.repeat(41), 12, null, true, ['1'], { bits: '1' }];

  it.each(malformed)('PATCH with %j: 400, nothing read past the early checks, nothing written', async (value) => {
    actorIs(OWNER);
    roleIs({ permissions: 0n });

    const res = await patchRole({ permissions: s(Permissions.VIEW_CHANNEL), knownPermissions: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('knownPermissions must be a permission bitmask: a string of 1 to 40 decimal digits');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.role.update).not.toHaveBeenCalled();
  });

  it('PATCH: refused even beside a rename alone', async () => {
    actorIs(OWNER);
    roleIs({ permissions: 0n });

    const res = await patchRole({ name: 'Helpers', knownPermissions: '0x1' });

    expect(res.status).toBe(400);
    expect(prismaMock.role.update).not.toHaveBeenCalled();
  });

  it.each(malformed)('PUT override with %j: 400, nothing written', async (value) => {
    actorIs(OWNER);
    overrideIs(null);

    const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('knownPermissions must be a permission bitmask: a string of 1 to 40 decimal digits');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each(malformed)('POST with %j: 400, nothing created', async (value) => {
    actorIs(OWNER);
    prismaMock.role.findFirst.mockResolvedValue(null);
    prismaMock.role.count.mockResolvedValue(0);
    prismaMock.role.aggregate.mockResolvedValue({ _max: { position: 1 } });

    const res = await createRole({ name: 'Helpers', permissions: s(Permissions.VIEW_CHANNEL), knownPermissions: value });

    expect(res.status).toBe(400);
    expect(prismaMock.role.create).not.toHaveBeenCalled();
  });

  it('forty digits is the longest accepted', async () => {
    actorIs(OWNER);
    roleIs({ permissions: 0n });

    const res = await patchRole({ permissions: s(Permissions.VIEW_CHANNEL), knownPermissions: '1'.repeat(40) });

    expect(res.status).toBe(200);
  });
});

// ─── The role creation ──────────────────────────────────────────────────────

describe('POST /roles — a creation stores the bits its client knows from what it sent', () => {
  function creatable() {
    prismaMock.role.findFirst.mockResolvedValue(null);
    prismaMock.role.count.mockResolvedValue(0);
    prismaMock.role.aggregate.mockResolvedValue({ _max: { position: 1 } });
    prismaMock.role.create.mockImplementation(async ({ data }: any) => ({ id: 'role-new', ...data }));
  }
  const created = () => BigInt((prismaMock.role.create.mock.calls[0][0] as any).data.permissions);

  it('the bits outside a narrow knownPermissions are not stored', async () => {
    actorIs(OWNER);
    creatable();

    const res = await createRole({
      name: 'Helpers',
      permissions: s(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.KICK_MEMBERS),
      knownPermissions: s(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES),
    });

    expect(res.status).toBe(201);
    expect(created()).toBe(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES);
    expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.ROLE_CREATED, { serverId: 'srv1', role: expect.objectContaining({ permissions: s(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES) }) });
  });

  it('without knownPermissions, every bit that exists today is stored as sent', async () => {
    actorIs(OWNER);
    creatable();

    const res = await createRole({ name: 'Helpers', permissions: s(LEGACY_CLIENT_KNOWN_PERMISSIONS) });

    expect(res.status).toBe(201);
    expect(created()).toBe(LEGACY_CLIENT_KNOWN_PERMISSIONS);
  });

  it('a non-owner cannot grant at creation what they do not hold', async () => {
    actorIs(MODERATOR);
    creatable();

    const res = await createRole({ name: 'Helpers', permissions: s(Permissions.KICK_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Cannot grant permissions you do not have');
    expect(prismaMock.role.create).not.toHaveBeenCalled();
  });

  it('a bit the actor lacks but the client says it does not know is dropped, not refused', async () => {
    actorIs(MODERATOR);
    creatable();

    const res = await createRole({
      name: 'Helpers',
      permissions: s(Permissions.SEND_MESSAGES | Permissions.KICK_MEMBERS),
      knownPermissions: s(Permissions.SEND_MESSAGES),
    });

    expect(res.status).toBe(201);
    expect(created()).toBe(Permissions.SEND_MESSAGES);
  });
});

// ─── The channel override ───────────────────────────────────────────────────

describe('PUT /roles/channels/:channelId/permissions/:roleId — allow and deny are merged into the stored override', () => {
  it('a knownPermissions narrower than the override keeps every stored bit outside it, in allow and in deny', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES, deny: Permissions.ATTACH_FILES | Permissions.ADD_REACTIONS });

    // the client knows VIEW_CHANNEL and ATTACH_FILES only, and clears both
    const res = await putOverride({ allow: '0', deny: '0', knownPermissions: s(Permissions.VIEW_CHANNEL | Permissions.ATTACH_FILES) });

    expect(res.status).toBe(200);
    // not deleted: the bits the client does not know are still there
    expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES, deny: Permissions.ADD_REACTIONS });
  });

  it('a request without knownPermissions (a 2.1.x client) keeps a stored bit outside the 2.1.x set, even when it clears everything it shows', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: FUTURE });

    const res = await putOverride({ allow: '0', deny: '0' });

    expect(res.status).toBe(200);
    expect(storedOverride()).toEqual({ allow: 0n, deny: FUTURE });
  });

  it('a request without knownPermissions still sets and clears every bit that exists today', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: Permissions.ATTACH_FILES });

    const res = await putOverride({ allow: s(Permissions.VIEW_CHANNEL), deny: s(Permissions.SEND_MESSAGES) });

    expect(res.status).toBe(200);
    expect(storedOverride()).toEqual({ allow: Permissions.VIEW_CHANNEL, deny: Permissions.SEND_MESSAGES });
  });

  it('a current client sets and clears inside its mask; both masks empty after the merge removes the override', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: Permissions.ATTACH_FILES });

    const res = await putOverride({ allow: '0', deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

    expect(res.status).toBe(200);
    expect(storedOverride()).toBe('deleted');
    expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
  });

  it('the server-level-only flags are stripped from the merged result, and only they: a stored bit this server does not know survives', async () => {
    actorIs(OWNER);
    overrideIs({ allow: FUTURE, deny: 0n });

    const res = await putOverride({
      allow: s(Permissions.SEND_MESSAGES | Permissions.ADMINISTRATOR | Permissions.CREATE_SECURE_CHANNELS | Permissions.MANAGE_WEBHOOKS),
      deny: s(Permissions.ATTACH_FILES | Permissions.MANAGE_WEBHOOKS),
      knownPermissions: s(ALL_PERMISSIONS),
    });

    expect(res.status).toBe(200);
    expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES | FUTURE, deny: Permissions.ATTACH_FILES });
  });

  it('the overlap check judges the merged override: a bit the client sent in deny but does not know is not an overlap', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: 0n });

    const res = await putOverride({ allow: '0', deny: s(Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES), knownPermissions: s(Permissions.ATTACH_FILES) });

    expect(res.status).toBe(200);
    expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES, deny: Permissions.ATTACH_FILES });
  });

  it('an overlap inside the mask is still a 400, before any transaction', async () => {
    actorIs(OWNER);
    overrideIs(null);

    const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: s(Permissions.SEND_MESSAGES), knownPermissions: s(ALL_PERMISSIONS) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('allow and deny cannot have overlapping bits');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('the ROLE row first (FOR NO KEY UPDATE), then every check on the transaction\'s client, the override read again, then the write, with the long budget', async () => {
    actorIs(MODERATOR);
    overrideIs(null);

    expect((await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(ALL_PERMISSIONS) })).status).toBe(200);

    expect(order).toEqual([
      'may-manage',
      'channel',
      'role',
      'rank',
      'override',
      'holds',
      `txn ${JSON.stringify({ timeout: 60_000, maxWait: 10_000 })}`,
      'tx:SELECT position, is_default FROM roles WHERE id = ? AND server_id = ? FOR NO KEY UPDATE [role1,srv1]',
      'tx:may-manage',
      'tx:channel',
      'tx:rank',
      'tx:override',
      'tx:holds',
      'tx:override.upsert',
    ]);
    expect(prismaMock.channelPermissionOverride.upsert).not.toHaveBeenCalled();
  });

  describe('the room re-sync follows the MERGED override', () => {
    it('a write that changes no bit: no re-sync (the event still goes out)', async () => {
      actorIs(OWNER);
      overrideIs({ allow: Permissions.VIEW_CHANNEL, deny: 0n });

      // the client does not know VIEW_CHANNEL, so its cleared allow is no change
      const res = await putOverride({ allow: '0', deny: '0', knownPermissions: s(Permissions.SEND_MESSAGES) });

      expect(res.status).toBe(200);
      expect(storedOverride()).toEqual({ allow: Permissions.VIEW_CHANNEL, deny: 0n });
      expect(mockSync).not.toHaveBeenCalled();
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED, { serverId: 'srv1' });
    });

    it('a write that changes VIEW_CHANNEL: this channel\'s rooms re-sync', async () => {
      actorIs(OWNER);
      overrideIs({ allow: Permissions.VIEW_CHANNEL, deny: 0n });

      const res = await putOverride({ allow: '0', deny: s(Permissions.VIEW_CHANNEL), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(mockSync).toHaveBeenCalledWith('srv1', { channelId: 'ch1' });
    });
  });

  describe('the actor must hold every bit the write turns ON, in allow or in deny (each against its own stored mask)', () => {
    it('a deny of a bit the actor lacks: 403, before any transaction', async () => {
      actorIs(MODERATOR);
      overrideIs(null);

      const res = await putOverride({ allow: '0', deny: s(Permissions.KICK_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot set overrides for permissions you do not have');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('a bit the actor lacks, left as stored: 200, kept', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: 0n, deny: Permissions.KICK_MEMBERS });

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: s(Permissions.KICK_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES, deny: Permissions.KICK_MEMBERS });
    });

    it('clearing a deny of a bit the actor lacks is never refused: 200, the override removed', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: 0n, deny: Permissions.KICK_MEMBERS });

      const res = await putOverride({ allow: '0', deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedOverride()).toBe('deleted');
    });

    it('clearing an allow of a bit the actor lacks, keeping the rest: 200', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES, deny: 0n });

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0' });

      expect(res.status).toBe(200);
      expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES, deny: 0n });
    });

    it('moving a bit the actor lacks from allow to deny turns it on in deny: 403', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: Permissions.KICK_MEMBERS, deny: 0n });

      const res = await putOverride({ allow: '0', deny: s(Permissions.KICK_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot set overrides for permissions you do not have');
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('moving a bit the actor lacks from deny to allow turns it on in allow: 403', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: 0n, deny: Permissions.KICK_MEMBERS });

      const res = await putOverride({ allow: s(Permissions.KICK_MEMBERS), deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('the override changed between the early answer and the lock (an allow the actor lacks taken away meanwhile): the save that keeps it turns it on again, 403, nothing written', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: Permissions.KICK_MEMBERS, deny: 0n }, null);

      const res = await putOverride({ allow: s(Permissions.KICK_MEMBERS | Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('a deny the actor lacks added meanwhile, outside the client\'s mask: kept, not the actor turning it on (judged against the row read inside)', async () => {
      actorIs(MODERATOR);
      overrideIs(null, { allow: 0n, deny: Permissions.KICK_MEMBERS });

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(Permissions.SEND_MESSAGES) });

      expect(res.status).toBe(200);
      expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES, deny: Permissions.KICK_MEMBERS });
    });

    it('a deny the actor lacks added meanwhile, inside the client\'s mask: the save that does not carry it clears it, 200', async () => {
      actorIs(MODERATOR);
      overrideIs(null, { allow: 0n, deny: Permissions.KICK_MEMBERS });

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
      expect(storedOverride()).toEqual({ allow: Permissions.SEND_MESSAGES, deny: 0n });
    });

    it('a deny the actor lacks moved to allow meanwhile: the save that keeps the deny turns it on in deny again, 403', async () => {
      actorIs(MODERATOR);
      overrideIs({ allow: 0n, deny: Permissions.KICK_MEMBERS }, { allow: Permissions.KICK_MEMBERS, deny: 0n });

      const res = await putOverride({ allow: '0', deny: s(Permissions.KICK_MEMBERS), knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });
  });

  describe('the other checks hold once the role row is theirs', () => {
    it('a role at or above the actor by then: 403, nothing written', async () => {
      actorIs(MODERATOR, { rank: 2 });
      overrideIs(null);

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot set overrides for roles at or above your own position');
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('the @everyone role is exempt from the rank check inside too', async () => {
      actorIs(MODERATOR, { rank: 0 });
      overrideIs(null);
      tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
        lazyStatement(order, `tx:${strings.join('?')}`, [{ position: 0, is_default: true }]));

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(200);
    });

    it('an actor who may no longer manage roles by then: 403, nothing written', async () => {
      actorIs(MODERATOR, { mayManage: false });
      overrideIs(null);

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0', knownPermissions: s(ALL_PERMISSIONS) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have permission to manage permissions');
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('a role gone by the time the lock is taken: 404 Role', async () => {
      actorIs(OWNER);
      overrideIs(null);
      tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => lazyStatement(order, `tx:${strings.join('?')}`, []));

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Role not found');
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('a channel gone by then: 404 Channel, nothing written', async () => {
      actorIs(OWNER);
      overrideIs(null);
      tx.channel.findFirst.mockResolvedValue(null);

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found');
      expect(tx.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('a channel deleted while the transaction ran: the new row\'s key refused, 404 Channel, nothing announced', async () => {
      actorIs(OWNER);
      overrideIs(null);
      tx.channelPermissionOverride.upsert.mockRejectedValueOnce(Object.assign(
        new Error('Foreign key constraint violated on the constraint: `channel_permission_overrides_channel_id_fkey`'),
        { code: 'P2003' },
      ));

      const res = await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found');
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('any other failure of the transaction is still a 500', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      actorIs(OWNER);
      overrideIs(null);
      tx.channelPermissionOverride.upsert.mockRejectedValueOnce(Object.assign(new Error('Foreign key constraint violated on the constraint: `another_fkey`'), { code: 'P2003' }));
      try {
        expect((await putOverride({ allow: s(Permissions.SEND_MESSAGES), deny: '0' })).status).toBe(500);
      } finally {
        err.mockRestore();
      }
    });
  });
});

// ─── The override DELETE: a 0/0 write with the 2.1.x set ─────────────────────

describe('DELETE /roles/channels/:channelId/permissions/:roleId — a 0/0 write with the 2.1.x set', () => {
  const deleteOverride = () => request(app).delete('/api/v1/servers/srv1/roles/channels/ch1/permissions/role1');

  it('an override holding only bits a 2.1.x client knows: the row is removed, as before', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: Permissions.ATTACH_FILES });

    const res = await deleteOverride();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Override removed' });
    expect(storedOverride()).toBe('deleted');
    expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED, { serverId: 'srv1' });
    expect(mockSync).toHaveBeenCalledWith('srv1', { channelId: 'ch1' });
  });

  it('a stored bit outside the 2.1.x set survives: the row keeps it, everything else cleared', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES | FUTURE, deny: Permissions.ATTACH_FILES | (FUTURE << 1n) });

    const res = await deleteOverride();

    expect(res.status).toBe(200);
    expect(storedOverride()).toEqual({ allow: FUTURE, deny: FUTURE << 1n });
    expect(mockSync).toHaveBeenCalledWith('srv1', { channelId: 'ch1' });
  });

  it('the same lock and checks as the PUT, inside one transaction with the long budget; the actor\'s bits are not read (nothing is turned on)', async () => {
    actorIs(MODERATOR);
    overrideIs({ allow: Permissions.KICK_MEMBERS, deny: 0n });

    expect((await deleteOverride()).status).toBe(200);

    expect(order).toEqual([
      'may-manage',
      'channel',
      'role',
      'rank',
      `txn ${JSON.stringify({ timeout: 60_000, maxWait: 10_000 })}`,
      'tx:SELECT position, is_default FROM roles WHERE id = ? AND server_id = ? FOR NO KEY UPDATE [role1,srv1]',
      'tx:may-manage',
      'tx:channel',
      'tx:rank',
      'tx:override',
      'tx:override.deleteMany',
    ]);
    // the moderator lacks KICK_MEMBERS: clearing it is never refused
    expect(storedOverride()).toBe('deleted');
  });

  it('no override stored: nothing changes, no re-sync (the event still goes out)', async () => {
    actorIs(OWNER);
    overrideIs(null);

    const res = await deleteOverride();

    expect(res.status).toBe(200);
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED, { serverId: 'srv1' });
  });

  it('a role at or above the actor by then: 403 with the route\'s own sentence, nothing written', async () => {
    actorIs(MODERATOR, { rank: 2 });
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: 0n });

    const res = await deleteOverride();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Cannot modify overrides for roles at or above your own position');
    expect(tx.channelPermissionOverride.deleteMany).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('an actor who may no longer manage roles by then: 403, nothing written', async () => {
    actorIs(MODERATOR, { mayManage: false });
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: 0n });

    const res = await deleteOverride();

    expect(res.status).toBe(403);
    expect(tx.channelPermissionOverride.deleteMany).not.toHaveBeenCalled();
  });

  it('a role gone by the time the lock is taken: 404 Role', async () => {
    actorIs(OWNER);
    overrideIs(null);
    tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => lazyStatement(order, `tx:${strings.join('?')}`, []));

    const res = await deleteOverride();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Role not found');
  });

  it('a channel gone by then: 404 Channel, nothing written', async () => {
    actorIs(OWNER);
    overrideIs({ allow: Permissions.SEND_MESSAGES, deny: 0n });
    tx.channel.findFirst.mockResolvedValue(null);

    const res = await deleteOverride();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Channel not found');
    expect(tx.channelPermissionOverride.deleteMany).not.toHaveBeenCalled();
  });
});
