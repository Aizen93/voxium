import { describe, it, expect } from 'vitest';
import { Permissions } from '@voxium/shared';
import { canOpenServerSettings, SERVER_SETTINGS_PERMISSIONS } from '../../utils/serverSettingsAccess';

/**
 * The Server settings button in the channel sidebar used to be gated on the
 * legacy owner/admin member role alone — a role-only moderator could be
 * granted "Manage members" and never reach the Join requests / Banned
 * sections the tab gates on that very bit.
 */
describe('canOpenServerSettings', () => {
  it('opens for each permission that has a surface inside the modal', () => {
    expect(SERVER_SETTINGS_PERMISSIONS).toEqual([Permissions.MANAGE_SERVER, Permissions.KICK_MEMBERS, Permissions.MANAGE_ROLES]);
    expect(canOpenServerSettings(Permissions.KICK_MEMBERS)).toBe(true);      // join requests + bans
    expect(canOpenServerSettings(Permissions.MANAGE_SERVER)).toBe(true);     // general + discovery
    expect(canOpenServerSettings(Permissions.MANAGE_ROLES)).toBe(true);      // roles
    expect(canOpenServerSettings(Permissions.ADMINISTRATOR)).toBe(true);     // implies everything
  });

  it('stays closed for a plain member, whatever else they may do', () => {
    expect(canOpenServerSettings(0n)).toBe(false);
    expect(canOpenServerSettings(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_MESSAGES)).toBe(false);
    expect(canOpenServerSettings(Permissions.MANAGE_CHANNELS | Permissions.CREATE_INVITES)).toBe(false);
  });
});
