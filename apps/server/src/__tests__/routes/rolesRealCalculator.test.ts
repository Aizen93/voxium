import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Permissions, DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@voxium/shared';

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
    },
    role: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = world().roles.find((r) => r.serverId === where.serverId
          && (where.id === undefined || r.id === where.id)
          && (where.isDefault === undefined || r.isDefault === where.isDefault)
          && (where.name === undefined || r.name === where.name));
        return row ? roleRow(row) : null;
      }),
    },
    memberRole: {
      findMany: vi.fn(async ({ where }: any) => world().memberRoles
        .filter((mr) => mr.userId === where.userId && mr.serverId === where.serverId)
        .map((mr) => ({ ...mr, role: roleRow(world().roles.find((r) => r.id === mr.roleId)!) }))),
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
    // The one raw statement these routes send here: the role row lock
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('?').startsWith('SELECT position, is_default FROM roles')) throw new Error(`unexpected statement: ${strings.join('?')}`);
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
  $transaction: vi.fn(async (fn: (client: typeof txClient) => unknown) => fn(txClient)),
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
