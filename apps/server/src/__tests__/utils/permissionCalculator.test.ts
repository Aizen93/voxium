import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  Permissions,
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock = {
  server: { findUnique: vi.fn(), findMany: vi.fn() },
  serverMember: { findUnique: vi.fn() },
  role: { findFirst: vi.fn(), findMany: vi.fn() },
  memberRole: { findMany: vi.fn() },
  channelPermissionOverride: { findMany: vi.fn() },
  channel: { findUnique: vi.fn() },
  channelMember: { findUnique: vi.fn(), findMany: vi.fn() },
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
  filterVisibleChannels,
  filterVisibleChannelsMulti,
  SECURE_MEMBER_PERMISSIONS,
  SECURE_CREATOR_PERMISSIONS,
} from '../../utils/permissionCalculator';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('permissionCalculator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user is a member (tests override as needed)
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'user1' });
    // Default: a plaintext channel in srv1 whose server row mirrors whatever
    // the test configured on server.findUnique (channel-permission paths now
    // resolve the owner through the channel fetch)
    prismaMock.channel.findUnique.mockImplementation(async () => {
      const server = (await prismaMock.server.findUnique()) ?? { ownerId: 'someone-else' };
      return { secure: false, serverId: 'srv1', server: { ownerId: server.ownerId } };
    });
    // Default: no secure-channel memberships
    prismaMock.channelMember.findUnique.mockResolvedValue(null);
    prismaMock.channelMember.findMany.mockResolvedValue([]);
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

    it('returns 0n when the channel does not exist', async () => {
      prismaMock.channel.findUnique.mockResolvedValue(null);

      const result = await computeUserChannelPermissions('user1', 'nope', 'srv1');

      expect(result).toBe(0n);
    });

    it('returns 0n when the channel belongs to a different server than claimed', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        secure: false,
        serverId: 'srv-OTHER',
        server: { ownerId: 'user1' },
      });

      const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

      expect(result).toBe(0n);
    });

    // ── secure channels: membership-derived, role system fully bypassed ──

    describe('secure channels', () => {
      const secureChannel = (ownerId: string) => ({
        secure: true,
        serverId: 'srv1',
        server: { ownerId },
      });

      it('the server OWNER gets 0n when not a channel member', async () => {
        prismaMock.channel.findUnique.mockResolvedValue(secureChannel('owner1'));
        prismaMock.channelMember.findUnique.mockResolvedValue(null);

        const result = await computeUserChannelPermissions('owner1', 'ch1', 'srv1');

        expect(result).toBe(0n);
        // Role machinery must never even be consulted
        expect(prismaMock.role.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.channelPermissionOverride.findMany).not.toHaveBeenCalled();
      });

      it('an ADMINISTRATOR gets 0n when not a channel member', async () => {
        prismaMock.channel.findUnique.mockResolvedValue(secureChannel('someone-else'));
        prismaMock.channelMember.findUnique.mockResolvedValue(null);
        // Even with an admin role configured, it must not be reached
        prismaMock.role.findFirst.mockResolvedValue({
          id: 'ev', permissions: permissionsToString(Permissions.ADMINISTRATOR),
        });

        const result = await computeUserChannelPermissions('admin-user', 'ch1', 'srv1');

        expect(result).toBe(0n);
      });

      it('a channel member gets exactly the fixed member set', async () => {
        prismaMock.channel.findUnique.mockResolvedValue(secureChannel('someone-else'));
        prismaMock.channelMember.findUnique.mockResolvedValue({ isCreator: false });

        const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

        expect(result).toBe(SECURE_MEMBER_PERMISSIONS);
        expect(result & Permissions.MANAGE_MESSAGES).toBe(0n);
      });

      it('the creator additionally gets MANAGE_MESSAGES', async () => {
        prismaMock.channel.findUnique.mockResolvedValue(secureChannel('someone-else'));
        prismaMock.channelMember.findUnique.mockResolvedValue({ isCreator: true });

        const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

        expect(result).toBe(SECURE_CREATOR_PERMISSIONS);
        expect(result & Permissions.MANAGE_MESSAGES).toBe(Permissions.MANAGE_MESSAGES);
      });

      it('a stale ChannelMember row without ServerMember row grants nothing', async () => {
        prismaMock.channel.findUnique.mockResolvedValue(secureChannel('someone-else'));
        prismaMock.channelMember.findUnique.mockResolvedValue({ isCreator: false });
        prismaMock.serverMember.findUnique.mockResolvedValue(null);

        const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

        expect(result).toBe(0n);
      });

      it('member permissions never include role-grantable extras (no ADMINISTRATOR, no MANAGE_CHANNELS)', async () => {
        prismaMock.channel.findUnique.mockResolvedValue(secureChannel('someone-else'));
        prismaMock.channelMember.findUnique.mockResolvedValue({ isCreator: true });

        const result = await computeUserChannelPermissions('user1', 'ch1', 'srv1');

        expect(result & Permissions.ADMINISTRATOR).toBe(0n);
        expect(result & Permissions.MANAGE_CHANNELS).toBe(0n);
        expect(result & Permissions.CREATE_SECURE_CHANNELS).toBe(0n);
      });
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

  // ── filterVisibleChannelsMulti (P2 — batched socket-connect hot path) ──

  describe('filterVisibleChannelsMulti', () => {
    it('owner of a server sees all its channels; a non-owned server in the same call is still filtered', async () => {
      const chOwned1 = { id: 'ch-own-1', serverId: 'srv-owned' };
      const chOwned2 = { id: 'ch-own-2', serverId: 'srv-owned' };
      const chOther = { id: 'ch-other-1', serverId: 'srv-other' };

      prismaMock.server.findMany.mockResolvedValue([
        { id: 'srv-owned', ownerId: 'user1' },
        { id: 'srv-other', ownerId: 'someone-else' },
      ]);
      prismaMock.role.findMany.mockResolvedValue([
        {
          id: 'ev-other',
          serverId: 'srv-other',
          permissions: permissionsToString(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES),
        },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([]);
      // The non-owned server hides its channel from @everyone
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          channelId: 'ch-other-1',
          roleId: 'ev-other',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.VIEW_CHANNEL),
        },
      ]);

      const result = await filterVisibleChannelsMulti('user1', [chOwned1, chOwned2, chOther]);

      expect(result).toEqual([chOwned1, chOwned2]);
    });

    it('a member whose combined role permissions equal ALL_PERMISSIONS (ADMINISTRATOR) sees everything', async () => {
      const channels = [
        { id: 'ch-a', serverId: 'srv1' },
        { id: 'ch-b', serverId: 'srv1' },
      ];

      prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', ownerId: 'someone-else' }]);
      prismaMock.role.findMany.mockResolvedValue([
        { id: 'ev1', serverId: 'srv1', permissions: permissionsToString(Permissions.VIEW_CHANNEL) },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([
        {
          serverId: 'srv1',
          roleId: 'admin-role',
          role: { permissions: permissionsToString(Permissions.ADMINISTRATOR) },
        },
      ]);
      // A deny override that would hide ch-a — must be bypassed by ADMINISTRATOR
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          channelId: 'ch-a',
          roleId: 'ev1',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.VIEW_CHANNEL),
        },
      ]);

      const result = await filterVisibleChannelsMulti('user1', channels);

      expect(result).toEqual(channels);
    });

    it('an @everyone override denying VIEW_CHANNEL hides that channel for a plain member; siblings stay visible', async () => {
      const chHidden = { id: 'ch-hidden', serverId: 'srv1' };
      const chVisible = { id: 'ch-visible', serverId: 'srv1' };

      prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', ownerId: 'someone-else' }]);
      prismaMock.role.findMany.mockResolvedValue([
        {
          id: 'ev1',
          serverId: 'srv1',
          permissions: permissionsToString(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES),
        },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          channelId: 'ch-hidden',
          roleId: 'ev1',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.VIEW_CHANNEL),
        },
      ]);

      const result = await filterVisibleChannelsMulti('user1', [chHidden, chVisible]);

      expect(result).toEqual([chVisible]);
    });

    it('an allow override on one of the user\'s roles reveals a channel hidden by the everyone override', async () => {
      const chSecret = { id: 'ch-secret', serverId: 'srv1' };

      prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', ownerId: 'someone-else' }]);
      prismaMock.role.findMany.mockResolvedValue([
        {
          id: 'ev1',
          serverId: 'srv1',
          permissions: permissionsToString(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES),
        },
      ]);
      prismaMock.memberRole.findMany.mockResolvedValue([
        { serverId: 'srv1', roleId: 'roleA', role: { permissions: permissionsToString(0n) } },
      ]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([
        {
          channelId: 'ch-secret',
          roleId: 'ev1',
          allow: permissionsToString(0n),
          deny: permissionsToString(Permissions.VIEW_CHANNEL),
        },
        {
          channelId: 'ch-secret',
          roleId: 'roleA',
          allow: permissionsToString(Permissions.VIEW_CHANNEL),
          deny: permissionsToString(0n),
        },
      ]);

      const result = await filterVisibleChannelsMulti('user1', [chSecret]);

      expect(result).toEqual([chSecret]);
    });

    it('multi-server input issues exactly ONE call to each of the 4 batched queries', async () => {
      prismaMock.server.findMany.mockResolvedValue([
        { id: 's1', ownerId: 'other' },
        { id: 's2', ownerId: 'other' },
        { id: 's3', ownerId: 'other' },
      ]);
      prismaMock.role.findMany.mockResolvedValue([]);
      prismaMock.memberRole.findMany.mockResolvedValue([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);

      const channels = [
        { id: 'c1', serverId: 's1' },
        { id: 'c2', serverId: 's2' },
        { id: 'c3', serverId: 's3' },
        { id: 'c4', serverId: 's1' },
      ];
      const result = await filterVisibleChannelsMulti('user1', channels);

      // No everyone role → DEFAULT_EVERYONE_PERMISSIONS (includes VIEW_CHANNEL)
      expect(result).toEqual(channels);
      expect(prismaMock.server.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.role.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.memberRole.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.channelPermissionOverride.findMany).toHaveBeenCalledTimes(1);
      // The 5th (secure-membership) query only runs when secure channels exist
      expect(prismaMock.channelMember.findMany).not.toHaveBeenCalled();
    });

    it('empty channels input returns [] without any queries', async () => {
      const result = await filterVisibleChannelsMulti('user1', []);

      expect(result).toEqual([]);
      expect(prismaMock.server.findMany).not.toHaveBeenCalled();
      expect(prismaMock.role.findMany).not.toHaveBeenCalled();
      expect(prismaMock.memberRole.findMany).not.toHaveBeenCalled();
      expect(prismaMock.channelPermissionOverride.findMany).not.toHaveBeenCalled();
    });

    // ── secure channels: hidden from owner/ADMIN, shown only to members ──

    describe('secure channels', () => {
      it('hides a secure channel from the SERVER OWNER who is not a member', async () => {
        const chPlain = { id: 'ch-plain', serverId: 'srv1', secure: false };
        const chSecure = { id: 'ch-secure', serverId: 'srv1', secure: true };

        prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', ownerId: 'user1' }]);
        prismaMock.role.findMany.mockResolvedValue([]);
        prismaMock.memberRole.findMany.mockResolvedValue([]);
        prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
        prismaMock.channelMember.findMany.mockResolvedValue([]);

        const result = await filterVisibleChannelsMulti('user1', [chPlain, chSecure]);

        expect(result).toEqual([chPlain]);
      });

      it('hides a secure channel from an ADMINISTRATOR who is not a member', async () => {
        const chSecure = { id: 'ch-secure', serverId: 'srv1', secure: true };

        prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', ownerId: 'other' }]);
        prismaMock.role.findMany.mockResolvedValue([]);
        prismaMock.memberRole.findMany.mockResolvedValue([
          {
            serverId: 'srv1',
            roleId: 'admin-role',
            role: { permissions: permissionsToString(Permissions.ADMINISTRATOR) },
          },
        ]);
        prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
        prismaMock.channelMember.findMany.mockResolvedValue([]);

        const result = await filterVisibleChannelsMulti('user1', [chSecure]);

        expect(result).toEqual([]);
      });

      it('shows a secure channel to a channel member (even a plain member with no roles)', async () => {
        const chSecure = { id: 'ch-secure', serverId: 'srv1', secure: true };
        const chSecureOther = { id: 'ch-secure-2', serverId: 'srv1', secure: true };

        prismaMock.server.findMany.mockResolvedValue([{ id: 'srv1', ownerId: 'other' }]);
        prismaMock.role.findMany.mockResolvedValue([]);
        prismaMock.memberRole.findMany.mockResolvedValue([]);
        prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
        prismaMock.channelMember.findMany.mockResolvedValue([{ channelId: 'ch-secure' }]);

        const result = await filterVisibleChannelsMulti('user1', [chSecure, chSecureOther]);

        expect(result).toEqual([chSecure]);
        // Membership query is scoped to this user and the secure ids only
        expect(prismaMock.channelMember.findMany).toHaveBeenCalledWith({
          where: { userId: 'user1', channelId: { in: ['ch-secure', 'ch-secure-2'] } },
          select: { channelId: true },
        });
      });
    });
  });

  // ── filterVisibleChannels (single-server variant, secure handling) ─────

  describe('filterVisibleChannels — secure channels', () => {
    it('owner: all plaintext channels, secure only where member', async () => {
      const chPlain = { id: 'ch-plain', secure: false };
      const chMine = { id: 'ch-mine', secure: true };
      const chTheirs = { id: 'ch-theirs', secure: true };

      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'user1' });
      prismaMock.channelMember.findMany.mockResolvedValue([{ channelId: 'ch-mine' }]);

      const result = await filterVisibleChannels('user1', 'srv1', [chPlain, chMine, chTheirs]);

      expect(result).toEqual([chPlain, chMine]);
      // Owner fast path must not skip the secure filter, but must still skip
      // the role machinery
      expect(prismaMock.role.findFirst).not.toHaveBeenCalled();
    });

    it('plain member: secure membership decides, override math untouched by secure rows', async () => {
      const chPlain = { id: 'ch-plain', secure: false };
      const chSecure = { id: 'ch-secure', secure: true };

      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'other' });
      prismaMock.role.findFirst.mockResolvedValue({
        id: 'ev1',
        permissions: permissionsToString(Permissions.VIEW_CHANNEL),
      });
      prismaMock.memberRole.findMany.mockResolvedValue([]);
      prismaMock.channelPermissionOverride.findMany.mockResolvedValue([]);
      prismaMock.channelMember.findMany.mockResolvedValue([]);

      const result = await filterVisibleChannels('user1', 'srv1', [chPlain, chSecure]);

      expect(result).toEqual([chPlain]);
      // Overrides are only fetched for the plaintext partition
      expect(prismaMock.channelPermissionOverride.findMany).toHaveBeenCalledWith({
        where: { channelId: { in: ['ch-plain'] } },
      });
    });

    it('no secure channels in input → no channelMember query at all', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'user1' });

      await filterVisibleChannels('user1', 'srv1', [{ id: 'ch1' }, { id: 'ch2' }]);

      expect(prismaMock.channelMember.findMany).not.toHaveBeenCalled();
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
