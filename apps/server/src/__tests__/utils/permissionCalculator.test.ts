import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  Permissions,
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock = {
  server: { findUnique: vi.fn() },
  serverMember: { findUnique: vi.fn() },
  role: { findFirst: vi.fn(), findMany: vi.fn() },
  memberRole: { findMany: vi.fn() },
  channelPermissionOverride: { findMany: vi.fn() },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return (prismaMock as Record<string, unknown>)[prop as string];
    },
  }),
}));

// ─── Module under test ──────────────────────────────────────────────────────

import {
  computeServerPermissions,
  computeUserChannelPermissions,
  hasServerPermission,
  hasChannelPermission,
  getHighestRolePosition,
  getEffectivePermissions,
} from '../../utils/permissionCalculator';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('permissionCalculator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user is a member (tests override as needed)
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user1' });
  });

  // ── computeServerPermissions ───────────────────────────────────────────

  describe('computeServerPermissions', () => {
    it('returns ALL_PERMISSIONS for the server owner', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner1' });

      const result = await computeServerPermissions('owner1', 'srv1');

      expect(result).toBe(ALL_PERMISSIONS);
      // Should not query roles since owner short-circuits
      expect(prismaMock.role.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.memberRole.findMany).not.toHaveBeenCalled();
    });

    it('returns 0n when the server does not exist (non-member)', async () => {
      prismaMock.server.findUnique.mockResolvedValue(null);

      const result = await computeServerPermissions('user1', 'nonexistent');

      expect(result).toBe(0n);
    });

    it('returns @everyone permissions for member with no additional roles', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await computeServerPermissions('user1', 'srv1');

      expect(result).toBe(everyonePerms);
    });

    it('returns combined (OR) permissions from @everyone + additional roles', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      const roleAPerms = Permissions.MANAGE_CHANNELS;
      const roleBPerms = Permissions.KICK_MEMBERS;

      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([
        { role: { permissions: permissionsToString(roleAPerms) } },
        { role: { permissions: permissionsToString(roleBPerms) } },
      ]);

      const result = await computeServerPermissions('user1', 'srv1');

      const expected = everyonePerms | roleAPerms | roleBPerms;
      expect(result).toBe(expected);
    });

    it('returns ALL_PERMISSIONS when ADMINISTRATOR flag is present in any role', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL;
      const adminRolePerms = Permissions.ADMINISTRATOR;

      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([
        { role: { permissions: permissionsToString(adminRolePerms) } },
      ]);

      const result = await computeServerPermissions('user1', 'srv1');

      expect(result).toBe(ALL_PERMISSIONS);
    });

    it('falls back to DEFAULT_EVERYONE_PERMISSIONS when no @everyone role exists', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue(null);
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await computeServerPermissions('user1', 'srv1');

      expect(result).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    });
  });

  // ── computeUserChannelPermissions ──────────────────────────────────────

  describe('computeUserChannelPermissions', () => {
    it('returns ALL_PERMISSIONS for the owner (bypasses channel overrides)', async () => {
      // computeServerPermissions returns ALL_PERMISSIONS for owner
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner1' });

      const result = await computeUserChannelPermissions('owner1', 'ch1', 'srv1');

      expect(result).toBe(ALL_PERMISSIONS);
      // Should not query channel overrides
      expect(prismaMock.channelPermissionOverride.findMany).not.toHaveBeenCalled();
    });

    it('applies @everyone channel deny to remove a permission', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      // Optimized: single server lookup, then parallel role/memberRole/overrides queries
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([]);

      // Channel override: @everyone deny SEND_MESSAGES
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          roleId: 'everyone-role-id',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.SEND_MESSAGES),
        },
      ]);

      const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

      // SEND_MESSAGES should be removed
      expect(result & Permissions.SEND_MESSAGES).toBe(0n);
      // VIEW_CHANNEL should remain
      expect(result & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    });

    it('applies @everyone channel allow to add a permission', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([]);

      // Channel override: @everyone allow SEND_MESSAGES
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          roleId: 'everyone-role-id',
          allow: permissionsToString(Permissions.SEND_MESSAGES),
          deny: permissionsToString(0n),
        },
      ]);

      const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

      expect(result & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
      expect(result & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    });

    it('applies role channel overrides (allow/deny aggregation)', async () => {
      const everyonePerms =
        Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES;
      const roleAPerms = Permissions.MANAGE_CHANNELS;

      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([
        { roleId: 'roleA', role: { permissions: permissionsToString(roleAPerms) } },
      ]);

      // Channel overrides:
      // - @everyone: deny ATTACH_FILES
      // - roleA: allow ADD_REACTIONS, deny SEND_MESSAGES
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          roleId: 'everyone-role-id',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.ATTACH_FILES),
        },
        {
          roleId: 'roleA',
          allow: permissionsToString(Permissions.ADD_REACTIONS),
          deny: permissionsToString(Permissions.SEND_MESSAGES),
        },
      ]);

      const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

      // ATTACH_FILES removed by @everyone deny
      // Then role aggregation: deny SEND_MESSAGES, allow ADD_REACTIONS
      // allow wins at same level for role overrides (allow applied after deny)
      expect(result & Permissions.ATTACH_FILES).toBe(0n);
      expect(result & Permissions.ADD_REACTIONS).toBe(Permissions.ADD_REACTIONS);
      expect(result & Permissions.SEND_MESSAGES).toBe(0n);
      expect(result & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    });

    it('ADMINISTRATOR bypasses channel overrides', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL;
      const adminRolePerms = Permissions.ADMINISTRATOR;

      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      // Parallel queries: role.findFirst returns @everyone, memberRole returns admin role
      // channelPermissionOverride.findMany runs in parallel but result is discarded
      // since base === ALL_PERMISSIONS
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([
        { roleId: 'admin-role', role: { permissions: permissionsToString(adminRolePerms) } },
      ]);
      // Overrides are fetched in parallel but ignored since ADMINISTRATOR is present
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

      expect(result).toBe(ALL_PERMISSIONS);
    });

    it('handles no channel overrides (returns base permissions)', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

      expect(result).toBe(everyonePerms);
    });
  });

  // ── getHighestRolePosition ─────────────────────────────────────────────

  describe('getHighestRolePosition', () => {
    it('returns Infinity for the server owner', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner1' });

      const result = await getHighestRolePosition('owner1', 'srv1');

      expect(result).toBe(Infinity);
      expect(prismaMock.memberRole.findMany).not.toHaveBeenCalled();
    });

    it('returns max position for member with assigned roles', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.memberRole.findMany.mockResolvedValue([
        { role: { position: 3 } },
        { role: { position: 7 } },
        { role: { position: 2 } },
      ]);

      const result = await getHighestRolePosition('user1', 'srv1');

      expect(result).toBe(7);
    });

    it('returns 0 for member with no assigned roles (@everyone only)', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await getHighestRolePosition('user1', 'srv1');

      expect(result).toBe(0);
    });

    it('returns 0 when server does not exist', async () => {
      prismaMock.server.findUnique.mockResolvedValue(null);
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await getHighestRolePosition('user1', 'nonexistent');

      expect(result).toBe(0);
    });
  });

  // ── hasServerPermission ────────────────────────────────────────────────

  describe('hasServerPermission', () => {
    it('returns true when the user has the requested permission', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await hasServerPermission('user1', 'srv1', Permissions.VIEW_CHANNEL);

      expect(result).toBe(true);
    });

    it('returns false when the user does not have the requested permission', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await hasServerPermission('user1', 'srv1', Permissions.MANAGE_ROLES);

      expect(result).toBe(false);
    });

    it('returns true for any permission when user is the owner', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner1' });

      const result = await hasServerPermission('owner1', 'srv1', Permissions.ADMINISTRATOR);

      expect(result).toBe(true);
    });

    it('returns true for any permission when user has ADMINISTRATOR', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(0n),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([
        { role: { permissions: permissionsToString(Permissions.ADMINISTRATOR) } },
      ]);

      const result = await hasServerPermission('user1', 'srv1', Permissions.MANAGE_ROLES);

      expect(result).toBe(true);
    });
  });

  // ── hasChannelPermission ───────────────────────────────────────────────

  describe('hasChannelPermission', () => {
    it('returns true when the user has the requested channel permission', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const result = await hasChannelPermission('user1', 'ch1', 'srv1', Permissions.SEND_MESSAGES);

      expect(result).toBe(true);
    });

    it('returns false when channel override denies the permission', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          roleId: 'everyone-role-id',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.SEND_MESSAGES),
        },
      ]);

      const result = await hasChannelPermission('user1', 'ch1', 'srv1', Permissions.SEND_MESSAGES);

      expect(result).toBe(false);
    });
  });

  // ── getEffectivePermissions ────────────────────────────────────────────

  describe('getEffectivePermissions', () => {
    it('returns source "owner" with ALL_PERMISSIONS for the owner', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner1' });

      const result = await getEffectivePermissions('owner1', 'srv1');

      expect(result.source).toBe('owner');
      expect(result.permissions).toBe(permissionsToString(ALL_PERMISSIONS));
    });

    it('returns source "computed" with base permissions for non-owner', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValue({
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([]);

      const result = await getEffectivePermissions('user1', 'srv1');

      expect(result.source).toBe('computed');
      expect(result.permissions).toBe(permissionsToString(everyonePerms));
    });

    it('uses channel permissions when channelId is provided', async () => {
      const everyonePerms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      // getEffectivePermissions does server.findUnique for owner check, then
      // computeUserChannelPermissions does another server.findUnique + parallel queries
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      prismaMock.role.findFirst.mockResolvedValueOnce({
        id: 'everyone-role-id',
        permissions: permissionsToString(everyonePerms),
      });
      prismaMock.memberRole.findMany.mockResolvedValueOnce([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          roleId: 'everyone-role-id',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.SEND_MESSAGES),
        },
      ]);

      const result = await getEffectivePermissions('user1', 'srv1', 'ch1');

      expect(result.source).toBe('computed');
      // SEND_MESSAGES denied at channel level
      const perms = BigInt(result.permissions);
      expect(perms & Permissions.SEND_MESSAGES).toBe(0n);
      expect(perms & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    });
  });
});
