import { describe, it, expect } from 'vitest';
import {
  Permissions,
  ALL_PERMISSIONS,
  hasPermission,
  combinePermissions,
  permissionsToString,
  permissionsFromString,
  computeBasePermissions,
  computeChannelPermissions,
} from '@voxium/shared';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Shared permissions utilities', () => {
  // ── hasPermission ──────────────────────────────────────────────────────

  describe('hasPermission', () => {
    it('returns true when the flag is set', () => {
      const perms = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      expect(hasPermission(perms, Permissions.VIEW_CHANNEL)).toBe(true);
      expect(hasPermission(perms, Permissions.SEND_MESSAGES)).toBe(true);
    });

    it('returns false when the flag is not set', () => {
      const perms = Permissions.VIEW_CHANNEL;
      expect(hasPermission(perms, Permissions.SEND_MESSAGES)).toBe(false);
      expect(hasPermission(perms, Permissions.ADMINISTRATOR)).toBe(false);
    });

    it('ADMINISTRATOR flag makes hasPermission always return true', () => {
      const perms = Permissions.ADMINISTRATOR;
      // Even though only ADMINISTRATOR is set, all permission checks pass
      expect(hasPermission(perms, Permissions.VIEW_CHANNEL)).toBe(true);
      expect(hasPermission(perms, Permissions.SEND_MESSAGES)).toBe(true);
      expect(hasPermission(perms, Permissions.MANAGE_ROLES)).toBe(true);
      expect(hasPermission(perms, Permissions.KICK_MEMBERS)).toBe(true);
      expect(hasPermission(perms, Permissions.MANAGE_SERVER)).toBe(true);
      expect(hasPermission(perms, Permissions.MUTE_MEMBERS)).toBe(true);
    });

    it('returns true for ADMINISTRATOR check on ALL_PERMISSIONS', () => {
      expect(hasPermission(ALL_PERMISSIONS, Permissions.ADMINISTRATOR)).toBe(true);
    });

    it('returns false for 0n (no permissions)', () => {
      expect(hasPermission(0n, Permissions.VIEW_CHANNEL)).toBe(false);
      expect(hasPermission(0n, Permissions.ADMINISTRATOR)).toBe(false);
    });
  });

  // ── combinePermissions ─────────────────────────────────────────────────

  describe('combinePermissions', () => {
    it('ORs all inputs together', () => {
      const result = combinePermissions(
        Permissions.VIEW_CHANNEL,
        Permissions.SEND_MESSAGES,
        Permissions.ATTACH_FILES,
      );
      const expected =
        Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES;
      expect(result).toBe(expected);
    });

    it('returns 0n when called with no arguments', () => {
      expect(combinePermissions()).toBe(0n);
    });

    it('returns the same value when called with a single argument', () => {
      expect(combinePermissions(Permissions.MANAGE_ROLES)).toBe(Permissions.MANAGE_ROLES);
    });

    it('handles duplicate flags (OR is idempotent)', () => {
      const result = combinePermissions(
        Permissions.VIEW_CHANNEL,
        Permissions.VIEW_CHANNEL,
        Permissions.VIEW_CHANNEL,
      );
      expect(result).toBe(Permissions.VIEW_CHANNEL);
    });

    it('can produce ALL_PERMISSIONS from individual flags', () => {
      const allFlags = Object.values(Permissions);
      const result = combinePermissions(...allFlags);
      expect(result).toBe(ALL_PERMISSIONS);
    });
  });

  // ── permissionsToString / permissionsFromString ────────────────────────

  describe('permissionsToString / permissionsFromString', () => {
    it('roundtrips a simple permission', () => {
      const original = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      const str = permissionsToString(original);
      const back = permissionsFromString(str);
      expect(back).toBe(original);
    });

    it('roundtrips ALL_PERMISSIONS', () => {
      const str = permissionsToString(ALL_PERMISSIONS);
      const back = permissionsFromString(str);
      expect(back).toBe(ALL_PERMISSIONS);
    });

    it('roundtrips 0n', () => {
      const str = permissionsToString(0n);
      const back = permissionsFromString(str);
      expect(back).toBe(0n);
    });

    it('permissionsToString produces a decimal string', () => {
      const str = permissionsToString(Permissions.VIEW_CHANNEL);
      expect(str).toBe('1');
    });

    it('permissionsFromString handles invalid input (returns 0n)', () => {
      expect(permissionsFromString('not-a-number')).toBe(0n);
      expect(permissionsFromString('')).toBe(0n);
      expect(permissionsFromString('abc123')).toBe(0n);
    });

    it('permissionsFromString handles large bigint strings', () => {
      const large = ALL_PERMISSIONS;
      const str = large.toString();
      expect(permissionsFromString(str)).toBe(large);
    });

    it('permissionsFromString rejects negative values (returns 0n)', () => {
      expect(permissionsFromString('-1')).toBe(0n);
      expect(permissionsFromString('-999')).toBe(0n);
    });

    it('permissionsFromString masks to ALL_PERMISSIONS (strips unknown bits)', () => {
      // Bit 30 is way beyond defined permissions (max is bit 19)
      const outOfRange = (1n << 30n) | Permissions.VIEW_CHANNEL;
      const result = permissionsFromString(outOfRange.toString());
      expect(result).toBe(Permissions.VIEW_CHANNEL); // bit 30 stripped
      expect(result & (1n << 30n)).toBe(0n);
    });
  });

  // ── computeBasePermissions ─────────────────────────────────────────────

  describe('computeBasePermissions', () => {
    it('combines @everyone and role permissions via OR', () => {
      const everyone = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      const rolePerms = [Permissions.MANAGE_CHANNELS, Permissions.KICK_MEMBERS];

      const result = computeBasePermissions(everyone, rolePerms);

      const expected =
        Permissions.VIEW_CHANNEL |
        Permissions.SEND_MESSAGES |
        Permissions.MANAGE_CHANNELS |
        Permissions.KICK_MEMBERS;
      expect(result).toBe(expected);
    });

    it('returns ALL_PERMISSIONS when ADMINISTRATOR is found in @everyone', () => {
      const everyone = Permissions.ADMINISTRATOR;
      const rolePerms: bigint[] = [];

      const result = computeBasePermissions(everyone, rolePerms);

      expect(result).toBe(ALL_PERMISSIONS);
    });

    it('returns ALL_PERMISSIONS when ADMINISTRATOR is found in a role', () => {
      const everyone = Permissions.VIEW_CHANNEL;
      const rolePerms = [Permissions.ADMINISTRATOR];

      const result = computeBasePermissions(everyone, rolePerms);

      expect(result).toBe(ALL_PERMISSIONS);
    });

    it('returns @everyone permissions when no roles are provided', () => {
      const everyone = Permissions.VIEW_CHANNEL | Permissions.CONNECT;

      const result = computeBasePermissions(everyone, []);

      expect(result).toBe(everyone);
    });

    it('returns 0n when @everyone is 0n and no roles exist', () => {
      const result = computeBasePermissions(0n, []);
      expect(result).toBe(0n);
    });
  });

  // ── computeChannelPermissions ──────────────────────────────────────────

  describe('computeChannelPermissions', () => {
    it('ADMINISTRATOR bypasses all channel overrides', () => {
      const base = Permissions.ADMINISTRATOR | Permissions.VIEW_CHANNEL;
      const everyoneOverride = {
        allow: 0n,
        deny: Permissions.VIEW_CHANNEL, // tries to deny VIEW_CHANNEL
      };

      const result = computeChannelPermissions(base, everyoneOverride, []);

      // ADMINISTRATOR means ALL_PERMISSIONS, ignoring the deny
      expect(result).toBe(ALL_PERMISSIONS);
    });

    it('applies @everyone override deny to remove permission', () => {
      const base = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      const everyoneOverride = {
        allow: 0n,
        deny: Permissions.SEND_MESSAGES,
      };

      const result = computeChannelPermissions(base, everyoneOverride, []);

      expect(result & Permissions.SEND_MESSAGES).toBe(0n);
      expect(result & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    });

    it('applies @everyone override allow to add permission', () => {
      const base = Permissions.VIEW_CHANNEL;
      const everyoneOverride = {
        allow: Permissions.SEND_MESSAGES,
        deny: 0n,
      };

      const result = computeChannelPermissions(base, everyoneOverride, []);

      expect(result & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
      expect(result & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    });

    it('returns base permissions when no overrides provided', () => {
      const base = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;

      const result = computeChannelPermissions(base, null, []);

      expect(result).toBe(base);
    });

    it('aggregates role overrides (allow wins over deny at same level)', () => {
      const base = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      // Role A denies SEND_MESSAGES but role B allows it
      const roleOverrides = [
        { allow: 0n, deny: Permissions.SEND_MESSAGES },
        { allow: Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES, deny: 0n },
      ];

      const result = computeChannelPermissions(base, null, roleOverrides);

      // Allow is applied after deny, so SEND_MESSAGES is restored
      expect(result & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
      expect(result & Permissions.ATTACH_FILES).toBe(Permissions.ATTACH_FILES);
    });

    it('@everyone override is applied before role overrides', () => {
      const base =
        Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES;
      // @everyone denies SEND_MESSAGES
      const everyoneOverride = {
        allow: 0n,
        deny: Permissions.SEND_MESSAGES,
      };
      // Role override allows SEND_MESSAGES back
      const roleOverrides = [
        { allow: Permissions.SEND_MESSAGES, deny: 0n },
      ];

      const result = computeChannelPermissions(base, everyoneOverride, roleOverrides);

      // @everyone deny first removes SEND_MESSAGES, then role allow restores it
      expect(result & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
    });

    it('role deny removes permissions even if @everyone allows them', () => {
      const base = Permissions.VIEW_CHANNEL;
      const everyoneOverride = {
        allow: Permissions.SEND_MESSAGES,
        deny: 0n,
      };
      const roleOverrides = [
        { allow: 0n, deny: Permissions.SEND_MESSAGES },
      ];

      const result = computeChannelPermissions(base, everyoneOverride, roleOverrides);

      // @everyone adds SEND_MESSAGES, then role removes it
      // But allow is applied after deny for role aggregation...
      // The deny removes, no allow counteract, so net is denied
      expect(result & Permissions.SEND_MESSAGES).toBe(0n);
    });

    it('handles multiple role overrides with complex allow/deny', () => {
      const base = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
      const roleOverrides = [
        { allow: Permissions.ATTACH_FILES, deny: Permissions.SEND_MESSAGES },
        { allow: Permissions.ADD_REACTIONS, deny: Permissions.ATTACH_FILES },
        { allow: Permissions.SEND_MESSAGES, deny: 0n },
      ];

      const result = computeChannelPermissions(base, null, roleOverrides);

      // Aggregated allow: ATTACH_FILES | ADD_REACTIONS | SEND_MESSAGES
      // Aggregated deny: SEND_MESSAGES | ATTACH_FILES
      // Apply deny first: removes SEND_MESSAGES & ATTACH_FILES from base
      // Then apply allow: adds ATTACH_FILES, ADD_REACTIONS, SEND_MESSAGES
      expect(result & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
      expect(result & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
      expect(result & Permissions.ATTACH_FILES).toBe(Permissions.ATTACH_FILES);
      expect(result & Permissions.ADD_REACTIONS).toBe(Permissions.ADD_REACTIONS);
    });
  });
});
