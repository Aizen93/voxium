import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, LEGACY_CLIENT_KNOWN_PERMISSIONS, Permissions } from '@voxium/shared';
import { planOverrideWrite, readKnownPermissions, storedPermissionBits, SERVER_LEVEL_ONLY_PERMISSIONS } from '../../utils/permissionWrites';
import { BadRequestError } from '../../utils/errors';

// A bit no flag uses yet: a permission added after this build
const FUTURE = 1n << 22n;

describe('readKnownPermissions', () => {
  it('a request that names none is a 2.1.x client: the frozen 2.1.x set', () => {
    expect(readKnownPermissions(undefined)).toBe(LEGACY_CLIENT_KNOWN_PERMISSIONS);
  });

  it('a named mask is masked with this server\'s own bits', () => {
    expect(readKnownPermissions((ALL_PERMISSIONS | FUTURE).toString())).toBe(ALL_PERMISSIONS);
    expect(readKnownPermissions(Permissions.SEND_MESSAGES.toString())).toBe(Permissions.SEND_MESSAGES);
    expect(readKnownPermissions('0')).toBe(0n);
  });

  it.each([null, '', '0x1', ' 1', 7, '1'.repeat(41)])('%j is a 400', (value) => {
    expect(() => readKnownPermissions(value)).toThrow(BadRequestError);
  });
});

describe('storedPermissionBits', () => {
  it('keeps every stored bit, the ones this server does not know included', () => {
    expect(storedPermissionBits((FUTURE | Permissions.VIEW_CHANNEL).toString())).toBe(FUTURE | Permissions.VIEW_CHANNEL);
  });

  it('a column that is not a bitmask string reads as 0, as permissionsFromString reads it', () => {
    expect(storedPermissionBits('')).toBe(0n);
    expect(storedPermissionBits('-1')).toBe(0n);
    expect(storedPermissionBits('garbage')).toBe(0n);
  });
});

describe('planOverrideWrite', () => {
  it('merges allow and deny over the stored override and reports what changed, and what it turned on, in either', () => {
    const plan = planOverrideWrite(
      { allow: (Permissions.SEND_MESSAGES | Permissions.VIEW_CHANNEL).toString(), deny: FUTURE.toString() },
      Permissions.ATTACH_FILES,
      0n,
      Permissions.VIEW_CHANNEL | Permissions.ATTACH_FILES,
    );
    expect(plan).toEqual({
      allow: Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES,
      deny: FUTURE,
      changed: Permissions.VIEW_CHANNEL | Permissions.ATTACH_FILES,
      // VIEW_CHANNEL was turned off: changed, never turned on
      turnedOn: Permissions.ATTACH_FILES,
    });
  });

  it('a bit moved between allow and deny is turned on in the mask it lands in; one removed from either is turned on nowhere', () => {
    const plan = planOverrideWrite(
      { allow: Permissions.SEND_MESSAGES.toString(), deny: (Permissions.ATTACH_FILES | Permissions.ADD_REACTIONS).toString() },
      Permissions.ATTACH_FILES,
      Permissions.SEND_MESSAGES,
      ALL_PERMISSIONS,
    );
    expect(plan.turnedOn).toBe(Permissions.ATTACH_FILES | Permissions.SEND_MESSAGES);
    expect(plan.changed).toBe(Permissions.ATTACH_FILES | Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS);
  });

  it('none stored reads as 0/0: every bit it stores is a change it turned on', () => {
    expect(planOverrideWrite(null, Permissions.SEND_MESSAGES, Permissions.ATTACH_FILES, ALL_PERMISSIONS)).toEqual({
      allow: Permissions.SEND_MESSAGES,
      deny: Permissions.ATTACH_FILES,
      changed: Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES,
      turnedOn: Permissions.SEND_MESSAGES | Permissions.ATTACH_FILES,
    });
  });

  it('strips ADMINISTRATOR, CREATE_SECURE_CHANNELS and MANAGE_WEBHOOKS from the result, and nothing else', () => {
    expect(SERVER_LEVEL_ONLY_PERMISSIONS).toBe(Permissions.ADMINISTRATOR | Permissions.CREATE_SECURE_CHANNELS | Permissions.MANAGE_WEBHOOKS);
    const plan = planOverrideWrite({ allow: FUTURE.toString(), deny: '0' }, ALL_PERMISSIONS & ~Permissions.SEND_MESSAGES, Permissions.SEND_MESSAGES, ALL_PERMISSIONS);
    expect(plan.allow).toBe((ALL_PERMISSIONS & ~Permissions.SEND_MESSAGES & ~SERVER_LEVEL_ONLY_PERMISSIONS) | FUTURE);
    expect(plan.deny).toBe(Permissions.SEND_MESSAGES);
  });

  it('an overlap of the merged masks is a 400', () => {
    expect(() => planOverrideWrite(null, Permissions.SEND_MESSAGES, Permissions.SEND_MESSAGES, ALL_PERMISSIONS)).toThrow('allow and deny cannot have overlapping bits');
  });
});
