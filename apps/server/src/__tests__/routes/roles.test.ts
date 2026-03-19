import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Permissions, permissionsToString, permissionsFromString, ALL_PERMISSIONS, WS_EVENTS } from '@voxium/shared';

// ─── Mocks (must be before any imports that use them) ───────────────────────

const prismaMock: Record<string, any> = {
  serverMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  role: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  memberRole: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  channel: {
    findFirst: vi.fn(),
  },
  channelPermissionOverride: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  server: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

// Socket.IO
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
  })),
}));

// Permission calculator
const mockHasServerPermission = vi.fn();
const mockGetHighestRolePosition = vi.fn();
const mockGetEffectivePermissions = vi.fn();
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: (...args: any[]) => mockHasServerPermission(...args),
  getHighestRolePosition: (...args: any[]) => mockGetHighestRolePosition(...args),
  getEffectivePermissions: (...args: any[]) => mockGetEffectivePermissions(...args),
}));

// Auth middleware — sets req.user on every request
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: () => void) => {
    req.user = { userId: 'user1', username: 'testuser', tokenVersion: 0, role: 'user' };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: () => void) => next(),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitRoleManage: passthrough,
    rateLimitGeneral: passthrough,
  };
});

// ─── App setup ──────────────────────────────────────────────────────────────

import { roleRouter } from '../../routes/roles';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/servers/:serverId/roles', roleRouter);
  app.use(errorHandler);
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Role Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ── GET /api/v1/servers/:serverId/roles ────────────────────────────────

  describe('GET /roles', () => {
    it('lists roles for a server member', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user1',
        serverId: 'srv1',
      });
      prismaMock.role.findMany.mockResolvedValue([
        { id: 'role-everyone', name: 'everyone', position: 0, isDefault: true, permissions: '0', color: null, serverId: 'srv1' },
        { id: 'role-mod', name: 'Moderator', position: 1, isDefault: false, permissions: '16', color: '#FF5733', serverId: 'srv1' },
      ]);

      const res = await request(app).get('/api/v1/servers/srv1/roles');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].name).toBe('everyone');
      expect(res.body.data[1].name).toBe('Moderator');
    });

    it('returns 404 for non-member', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app).get('/api/v1/servers/srv1/roles');

      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/servers/:serverId/roles ───────────────────────────────

  describe('POST /roles', () => {
    it('creates a role with MANAGE_ROLES permission', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity); // owner
      prismaMock.role.count.mockResolvedValue(2);
      prismaMock.role.aggregate.mockResolvedValue({ _max: { position: 1 } });
      prismaMock.role.create.mockResolvedValue({
        id: 'role-new',
        name: 'Moderator',
        position: 2,
        isDefault: false,
        permissions: '0',
        color: '#00FF00',
        serverId: 'srv1',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Moderator', color: '#00FF00' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Moderator');
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.ROLE_CREATED,
        expect.objectContaining({ serverId: 'srv1' }),
      );
    });

    it('returns 403 without MANAGE_ROLES permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Moderator' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permission');
    });

    it('returns 400 for invalid name (empty)', async () => {
      mockHasServerPermission.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: '' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for reserved name "everyone"', async () => {
      mockHasServerPermission.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'everyone' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('everyone');
    });

    it('returns 400 for reserved name "Everyone" (case insensitive)', async () => {
      mockHasServerPermission.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Everyone' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('everyone');
    });

    it('returns 400 when role limit reached', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.role.count.mockResolvedValue(25);

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Another Role' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('creates a role with permissions when actor is owner', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.role.count.mockResolvedValue(1);
      prismaMock.role.aggregate.mockResolvedValue({ _max: { position: 0 } });
      const perms = Permissions.MANAGE_CHANNELS | Permissions.KICK_MEMBERS;
      prismaMock.role.create.mockResolvedValue({
        id: 'role-new',
        name: 'Admin',
        position: 1,
        isDefault: false,
        permissions: permissionsToString(perms),
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Admin', permissions: permissionsToString(perms) });

      expect(res.status).toBe(201);
    });

    it('returns 403 when granting permissions the actor does not have', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(5); // not owner
      prismaMock.role.count.mockResolvedValue(1);
      // Actor only has VIEW_CHANNEL
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(Permissions.VIEW_CHANNEL),
        source: 'computed',
      });

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Power', permissions: permissionsToString(Permissions.ADMINISTRATOR) });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot grant permissions');
    });

    it('returns 400 for invalid color format', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.role.count.mockResolvedValue(1);

      const res = await request(app)
        .post('/api/v1/servers/srv1/roles')
        .send({ name: 'Colored', color: 'not-hex' });

      expect(res.status).toBe(400);
    });
  });

  // ── PATCH /api/v1/servers/:serverId/roles/:roleId ──────────────────────

  describe('PATCH /roles/:roleId', () => {
    it('updates role name and color', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(10);
      prismaMock.role.findFirst
        .mockResolvedValueOnce({
          id: 'role1',
          name: 'OldName',
          position: 5,
          isDefault: false,
          permissions: '0',
          color: null,
          serverId: 'srv1',
        })
        .mockResolvedValueOnce(null); // duplicate name check returns no conflict
      prismaMock.role.update.mockResolvedValue({
        id: 'role1',
        name: 'NewName',
        position: 5,
        isDefault: false,
        permissions: '0',
        color: '#AABBCC',
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role1')
        .send({ name: 'NewName', color: '#AABBCC' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('NewName');
      expect(res.body.data.color).toBe('#AABBCC');
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.ROLE_UPDATED,
        expect.objectContaining({ serverId: 'srv1' }),
      );
    });

    it('updates role permissions', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity); // owner
      const newPerms = Permissions.MANAGE_CHANNELS | Permissions.KICK_MEMBERS;
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'Mod',
        position: 3,
        isDefault: false,
        permissions: '0',
        color: null,
        serverId: 'srv1',
      });
      prismaMock.role.update.mockResolvedValue({
        id: 'role1',
        name: 'Mod',
        position: 3,
        isDefault: false,
        permissions: permissionsToString(newPerms),
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role1')
        .send({ permissions: permissionsToString(newPerms) });

      expect(res.status).toBe(200);
    });

    it('returns 403 for role at or above actor position', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(5);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'HighRole',
        position: 5, // same as actor
        isDefault: false,
        permissions: '0',
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role1')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('above your own position');
    });

    it('returns 403 for role above actor position', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(3);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'HighRole',
        position: 7,
        isDefault: false,
        permissions: '0',
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role1')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(403);
    });

    it('returns 400 when trying to rename @everyone role', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role-everyone',
        name: 'everyone',
        position: 0,
        isDefault: true,
        permissions: '0',
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role-everyone')
        .send({ name: 'RenamedEveryone' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('everyone');
    });

    it('allows updating permissions on @everyone (isDefault) role', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity); // owner bypasses position check
      const newPerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role-everyone',
        name: 'everyone',
        position: 0,
        isDefault: true,
        permissions: '0',
        color: null,
        serverId: 'srv1',
      });
      prismaMock.role.update.mockResolvedValue({
        id: 'role-everyone',
        name: 'everyone',
        position: 0,
        isDefault: true,
        permissions: permissionsToString(newPerms),
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role-everyone')
        .send({ permissions: permissionsToString(newPerms) });

      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent role', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.role.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/nonexistent')
        .send({ name: 'Whatever' });

      expect(res.status).toBe(404);
    });

    it('returns 400 when no fields to update', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'Existing',
        position: 2,
        isDefault: false,
        permissions: '0',
        color: null,
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No fields');
    });

    it('returns 403 when granting permissions the actor does not have', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(5);
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(Permissions.VIEW_CHANNEL),
        source: 'computed',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'Mod',
        position: 2,
        isDefault: false,
        permissions: '0',
        serverId: 'srv1',
      });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/role1')
        .send({ permissions: permissionsToString(Permissions.ADMINISTRATOR) });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot grant permissions');
    });
  });

  // ── DELETE /api/v1/servers/:serverId/roles/:roleId ─────────────────────

  describe('DELETE /roles/:roleId', () => {
    it('deletes a role below actor position', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(10);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'LowRole',
        position: 3,
        isDefault: false,
        permissions: '0',
        serverId: 'srv1',
      });
      prismaMock.role.delete.mockResolvedValue({ id: 'role1' });

      const res = await request(app).delete('/api/v1/servers/srv1/roles/role1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.ROLE_DELETED,
        { serverId: 'srv1', roleId: 'role1' },
      );
    });

    it('returns 403 when trying to delete @everyone', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role-everyone',
        name: 'everyone',
        position: 0,
        isDefault: true,
        permissions: '0',
        serverId: 'srv1',
      });

      const res = await request(app).delete('/api/v1/servers/srv1/roles/role-everyone');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('everyone');
    });

    it('returns 403 for role at or above actor position', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(3);
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'role1',
        name: 'HighRole',
        position: 5,
        isDefault: false,
        permissions: '0',
        serverId: 'srv1',
      });

      const res = await request(app).delete('/api/v1/servers/srv1/roles/role1');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('above your own position');
    });

    it('returns 403 without MANAGE_ROLES permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app).delete('/api/v1/servers/srv1/roles/role1');

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent role', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.role.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/v1/servers/srv1/roles/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  // ── PUT /api/v1/servers/:serverId/roles/reorder ────────────────────────

  describe('PUT /roles/reorder', () => {
    it('reorders roles successfully', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.role.findMany
        // First call: validate roles
        .mockResolvedValueOnce([
          { id: 'r1', position: 0, isDefault: true },
          { id: 'r2', position: 1, isDefault: false },
          { id: 'r3', position: 2, isDefault: false },
        ])
        // Second call: fetch updated roles for broadcast
        .mockResolvedValueOnce([
          { id: 'r1', position: 0 },
          { id: 'r3', position: 1 },
          { id: 'r2', position: 2 },
        ]);
      prismaMock.$transaction.mockResolvedValue([]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/reorder')
        .send({
          order: [
            { id: 'r1', position: 0 },
            { id: 'r3', position: 1 },
            { id: 'r2', position: 2 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.ROLE_REORDERED,
        expect.objectContaining({ serverId: 'srv1' }),
      );
    });

    it('returns 400 when order is not an array', async () => {
      mockHasServerPermission.mockResolvedValue(true);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/reorder')
        .send({ order: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('non-empty array');
    });

    it('returns 400 when order is empty', async () => {
      mockHasServerPermission.mockResolvedValue(true);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/reorder')
        .send({ order: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when role IDs do not belong to server', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      // Only 1 role found but 2 were requested
      prismaMock.role.findMany.mockResolvedValueOnce([
        { id: 'r1', position: 0, isDefault: true },
      ]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/reorder')
        .send({
          order: [
            { id: 'r1', position: 0 },
            { id: 'r-foreign', position: 1 },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('do not belong');
    });

    it('returns 403 when trying to reorder roles at or above actor position', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(3);
      prismaMock.role.findMany.mockResolvedValueOnce([
        { id: 'r1', position: 0, isDefault: true },
        { id: 'r2', position: 5, isDefault: false }, // above actor
      ]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/reorder')
        .send({
          order: [
            { id: 'r1', position: 0 },
            { id: 'r2', position: 1 },
          ],
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('above your own position');
    });

    it('returns 400 when trying to move @everyone away from position 0', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.role.findMany.mockResolvedValueOnce([
        { id: 'r1', position: 0, isDefault: true },
        { id: 'r2', position: 1, isDefault: false },
      ]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/reorder')
        .send({
          order: [
            { id: 'r1', position: 1 }, // @everyone moved from 0
            { id: 'r2', position: 0 },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('position 0');
    });
  });

  // ── PATCH /api/v1/servers/:serverId/roles/members/:memberId ────────────

  describe('PATCH /roles/members/:memberId', () => {
    it('assigns roles to a member', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity); // owner
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'member1',
        serverId: 'srv1',
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'user1' }); // actor is owner
      prismaMock.role.findMany
        // First call: validate role IDs
        .mockResolvedValueOnce([
          { id: 'r2', position: 2, isDefault: false },
          { id: 'r3', position: 3, isDefault: false },
        ])
        // Second call: re-fetch for legacy field
        .mockResolvedValueOnce([
          { permissions: permissionsToString(Permissions.VIEW_CHANNEL) },
          { permissions: permissionsToString(Permissions.SEND_MESSAGES) },
        ]);
      prismaMock.$transaction.mockResolvedValue([]);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: ['r2', 'r3'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.MEMBER_ROLES_UPDATED,
        expect.objectContaining({
          serverId: 'srv1',
          userId: 'member1',
          roleIds: ['r2', 'r3'],
        }),
      );
    });

    it('returns 403 without MANAGE_ROLES permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: ['r2'] });

      expect(res.status).toBe(403);
    });

    it('returns 400 when roleIds is not an array', async () => {
      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: 'not-array' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('array');
    });

    it('returns 404 when target is not a member', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/nonexistent')
        .send({ roleIds: ['r2'] });

      expect(res.status).toBe(404);
    });

    it('returns 403 when trying to modify owner roles (by non-owner)', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'owner1',
        serverId: 'srv1',
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner1' });

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/owner1')
        .send({ roleIds: ['r2'] });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("owner's roles");
    });

    it('returns 403 for roles above actor position', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(3);
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'member1',
        serverId: 'srv1',
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findMany.mockResolvedValueOnce([
        { id: 'r-high', position: 5, isDefault: false }, // above actor's position
      ]);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: ['r-high'] });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('above your own position');
    });

    it('returns 400 when trying to assign @everyone role', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'member1',
        serverId: 'srv1',
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findMany.mockResolvedValueOnce([
        { id: 'r-everyone', position: 0, isDefault: true },
      ]);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: ['r-everyone'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('everyone');
    });

    it('returns 400 when role IDs are invalid', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'member1',
        serverId: 'srv1',
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      // Only 1 found instead of 2
      prismaMock.role.findMany.mockResolvedValueOnce([
        { id: 'r2', position: 1, isDefault: false },
      ]);

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: ['r2', 'r-invalid'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('invalid');
    });

    it('updates legacy role to admin when assigning ADMINISTRATOR role', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'member1',
        serverId: 'srv1',
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'user1' }); // actor is owner
      prismaMock.role.findMany
        .mockResolvedValueOnce([
          { id: 'r-admin', position: 5, isDefault: false },
        ])
        .mockResolvedValueOnce([
          { permissions: permissionsToString(Permissions.ADMINISTRATOR) },
        ]);
      prismaMock.$transaction.mockResolvedValue([]);
      prismaMock.serverMember.update.mockResolvedValue({});

      const res = await request(app)
        .patch('/api/v1/servers/srv1/roles/members/member1')
        .send({ roleIds: ['r-admin'] });

      expect(res.status).toBe(200);
      expect(prismaMock.serverMember.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: 'admin' },
        }),
      );
    });
  });

  // ── GET /channels/:channelId/permissions ───────────────────────────────

  describe('GET /roles/channels/:channelId/permissions', () => {
    it('lists channel permission overrides', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user1',
        serverId: 'srv1',
      });
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
        name: 'general',
      });
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          channelId: 'ch1',
          roleId: 'r-everyone',
          allow: '0',
          deny: permissionsToString(Permissions.SEND_MESSAGES),
          role: { id: 'r-everyone', name: 'everyone' },
        },
      ]);

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/channels/ch1/permissions',
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it('returns 404 when not a server member', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/channels/ch1/permissions',
      );

      expect(res.status).toBe(404);
    });

    it('returns 404 when channel does not exist', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user1',
        serverId: 'srv1',
      });
      prismaMock.channel.findFirst.mockResolvedValue(null);

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/channels/ch-none/permissions',
      );

      expect(res.status).toBe(404);
    });
  });

  // ── PUT /channels/:channelId/permissions/:roleId ───────────────────────

  describe('PUT /roles/channels/:channelId/permissions/:roleId', () => {
    it('sets a channel permission override', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity); // owner
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r2',
        serverId: 'srv1',
        position: 2,
        isDefault: false,
      });
      prismaMock.channelPermissionOverride.upsert.mockResolvedValue({
        channelId: 'ch1',
        roleId: 'r2',
        allow: permissionsToString(Permissions.SEND_MESSAGES),
        deny: '0',
      });
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          channelId: 'ch1',
          roleId: 'r2',
          allow: permissionsToString(Permissions.SEND_MESSAGES),
          deny: '0',
          role: { id: 'r2', name: 'Mod' },
        },
      ]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r2')
        .send({
          allow: permissionsToString(Permissions.SEND_MESSAGES),
          deny: '0',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED,
        expect.objectContaining({
          serverId: 'srv1',
          channelId: 'ch1',
        }),
      );
    });

    it('removes override when both allow and deny are 0', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r2',
        serverId: 'srv1',
        position: 2,
        isDefault: false,
      });
      prismaMock.channelPermissionOverride.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r2')
        .send({ allow: '0', deny: '0' });

      expect(res.status).toBe(200);
      expect(prismaMock.channelPermissionOverride.deleteMany).toHaveBeenCalled();
      expect(prismaMock.channelPermissionOverride.upsert).not.toHaveBeenCalled();
    });

    it('returns 400 when allow and deny overlap', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r2',
        serverId: 'srv1',
        position: 2,
        isDefault: false,
      });

      const overlap = permissionsToString(Permissions.SEND_MESSAGES);
      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r2')
        .send({ allow: overlap, deny: overlap });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('overlapping');
    });

    it('returns 400 when allow/deny are not strings', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r2',
        serverId: 'srv1',
        position: 2,
        isDefault: false,
      });

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r2')
        .send({ allow: 123, deny: 456 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('strings');
    });

    it('returns 403 for role at or above actor position (non-default)', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(3);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r-high',
        serverId: 'srv1',
        position: 5,
        isDefault: false,
      });

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r-high')
        .send({ allow: '1', deny: '0' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('above your own position');
    });

    it('allows setting overrides for @everyone (isDefault) even if actor is not owner', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(5); // not owner but MANAGE_ROLES
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r-everyone',
        serverId: 'srv1',
        position: 0,
        isDefault: true,
      });
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_ROLES),
        source: 'computed',
      });
      prismaMock.channelPermissionOverride.upsert.mockResolvedValue({});
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r-everyone')
        .send({
          allow: '0',
          deny: permissionsToString(Permissions.SEND_MESSAGES),
        });

      // Should succeed — @everyone (isDefault) is exempt from position check
      expect(res.status).toBe(200);
    });

    it('returns 403 when trying to set overrides for permissions the actor does not have', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(5);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r2',
        serverId: 'srv1',
        position: 2,
        isDefault: false,
      });
      // Actor only has VIEW_CHANNEL + MANAGE_ROLES, not KICK_MEMBERS
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(Permissions.VIEW_CHANNEL | Permissions.MANAGE_ROLES),
        source: 'computed',
      });

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r2')
        .send({
          allow: permissionsToString(Permissions.KICK_MEMBERS),
          deny: '0',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permissions you do not have');
    });

    it('silently strips ADMINISTRATOR from channel overrides', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.channel.findFirst.mockResolvedValue({ id: 'ch1', serverId: 'srv1' });
      prismaMock.role.findFirst.mockResolvedValue({ id: 'r1', serverId: 'srv1', position: 1, isDefault: false });
      prismaMock.channelPermissionOverride.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      // Sending ADMINISTRATOR as allow — should be stripped to 0, resulting in delete
      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r1')
        .send({
          allow: permissionsToString(Permissions.ADMINISTRATOR),
          deny: '0',
        });

      expect(res.status).toBe(200);
      // Should have called deleteMany since both allow and deny are 0 after stripping
      expect(prismaMock.channelPermissionOverride.deleteMany).toHaveBeenCalled();
    });

    it('returns 404 when channel does not exist', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.channel.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch-none/permissions/r2')
        .send({ allow: '1', deny: '0' });

      expect(res.status).toBe(404);
    });

    it('returns 404 when role does not exist', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .put('/api/v1/servers/srv1/roles/channels/ch1/permissions/r-none')
        .send({ allow: '1', deny: '0' });

      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /channels/:channelId/permissions/:roleId ────────────────────

  describe('DELETE /roles/channels/:channelId/permissions/:roleId', () => {
    it('removes a channel permission override', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(Infinity);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r2',
        serverId: 'srv1',
        position: 2,
        isDefault: false,
      });
      prismaMock.channelPermissionOverride.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const res = await request(app).delete(
        '/api/v1/servers/srv1/roles/channels/ch1/permissions/r2',
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED,
        expect.objectContaining({
          serverId: 'srv1',
          channelId: 'ch1',
        }),
      );
    });

    it('returns 403 without MANAGE_ROLES permission', async () => {
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app).delete(
        '/api/v1/servers/srv1/roles/channels/ch1/permissions/r2',
      );

      expect(res.status).toBe(403);
    });

    it('returns 404 when channel does not exist', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.channel.findFirst.mockResolvedValue(null);

      const res = await request(app).delete(
        '/api/v1/servers/srv1/roles/channels/ch-none/permissions/r2',
      );

      expect(res.status).toBe(404);
    });

    it('returns 404 when role does not exist', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue(null);

      const res = await request(app).delete(
        '/api/v1/servers/srv1/roles/channels/ch1/permissions/r-none',
      );

      expect(res.status).toBe(404);
    });

    it('returns 403 for role at or above actor position (non-default)', async () => {
      mockHasServerPermission.mockResolvedValue(true);
      mockGetHighestRolePosition.mockResolvedValue(3);
      prismaMock.channel.findFirst.mockResolvedValue({
        id: 'ch1',
        serverId: 'srv1',
      });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'r-high',
        serverId: 'srv1',
        position: 5,
        isDefault: false,
      });

      const res = await request(app).delete(
        '/api/v1/servers/srv1/roles/channels/ch1/permissions/r-high',
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('above your own position');
    });
  });

  // ── GET /permissions/effective ─────────────────────────────────────────

  describe('GET /roles/permissions/effective', () => {
    it('returns effective permissions for the current user', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user1',
        serverId: 'srv1',
      });
      mockHasServerPermission.mockResolvedValue(false); // no MANAGE_ROLES
      const effectivePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(effectivePerms),
        source: 'computed',
      });

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/permissions/effective',
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.source).toBe('computed');
      expect(res.body.data.permissions).toBe(permissionsToString(effectivePerms));
    });

    it('returns effective permissions with channelId query param', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user1',
        serverId: 'srv1',
      });
      mockHasServerPermission.mockResolvedValue(false);
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(Permissions.VIEW_CHANNEL),
        source: 'computed',
      });

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/permissions/effective?channelId=ch1',
      );

      expect(res.status).toBe(200);
      expect(mockGetEffectivePermissions).toHaveBeenCalledWith('user1', 'srv1', 'ch1');
    });

    it('returns 404 for non-member', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/permissions/effective',
      );

      expect(res.status).toBe(404);
    });

    it('returns 403 when querying another user without MANAGE_ROLES', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({
        userId: 'user1',
        serverId: 'srv1',
      });
      mockHasServerPermission.mockResolvedValue(false);

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/permissions/effective?userId=other-user',
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('only view your own');
    });

    it('allows querying another user with MANAGE_ROLES', async () => {
      prismaMock.serverMember.findUnique
        // First call: actor membership check
        .mockResolvedValueOnce({ userId: 'user1', serverId: 'srv1' })
        // Second call: target membership check
        .mockResolvedValueOnce({ userId: 'other-user', serverId: 'srv1' });
      mockHasServerPermission.mockResolvedValue(true); // has MANAGE_ROLES
      mockGetEffectivePermissions.mockResolvedValue({
        permissions: permissionsToString(Permissions.VIEW_CHANNEL),
        source: 'computed',
      });

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/permissions/effective?userId=other-user',
      );

      expect(res.status).toBe(200);
      expect(mockGetEffectivePermissions).toHaveBeenCalledWith('other-user', 'srv1', undefined);
    });

    it('returns 404 when target user is not a member', async () => {
      prismaMock.serverMember.findUnique
        .mockResolvedValueOnce({ userId: 'user1', serverId: 'srv1' }) // actor is member
        .mockResolvedValueOnce(null); // target not a member
      mockHasServerPermission.mockResolvedValue(true);

      const res = await request(app).get(
        '/api/v1/servers/srv1/roles/permissions/effective?userId=nonexistent',
      );

      expect(res.status).toBe(404);
    });
  });
});
