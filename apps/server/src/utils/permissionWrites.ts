import {
  ALL_PERMISSIONS,
  LEGACY_CLIENT_KNOWN_PERMISSIONS,
  Permissions,
  mergeKnownPermissions,
  permissionBitsFromString,
  validateKnownPermissions,
} from '@voxium/shared';
import { BadRequestError } from './errors';

/**
 * Role and channel-override writes MERGE into the stored bitmask instead of
 * replacing it. A client reads a role through `permissionsFromString`, which
 * masks with the bits its own build knows, so a client built before a flag
 * existed sends that flag cleared on every save (a rename included). Each
 * write therefore names the bits its client knows (`knownPermissions`), the
 * server takes those bits from the request and keeps every other bit as
 * stored: `(stored & ~known) | (sent & known)`.
 */

/**
 * Flags a channel override never carries: ADMINISTRATOR, and the two
 * server-level-only flags CREATE_SECURE_CHANNELS and MANAGE_WEBHOOKS.
 */
export const SERVER_LEVEL_ONLY_PERMISSIONS =
  Permissions.ADMINISTRATOR | Permissions.CREATE_SECURE_CHANNELS | Permissions.MANAGE_WEBHOOKS;

/**
 * The bits a write's client knows: its `knownPermissions`, masked to the bits
 * this server knows (a bit only a newer client knows is kept as stored), or,
 * when the request names none (every 2.1.x client), the frozen 2.1.x set. A
 * value that is not a permission bitmask string is a 400.
 */
export function readKnownPermissions(value: unknown): bigint {
  if (value === undefined) return LEGACY_CLIENT_KNOWN_PERMISSIONS;
  const invalid = validateKnownPermissions(value);
  if (invalid) throw new BadRequestError(invalid);
  return BigInt(value as string) & ALL_PERMISSIONS;
}

/**
 * A stored permission column with EVERY bit kept, the ones this server does
 * not know included (a row written by a newer server keeps them through a
 * rollback); 0 for a column that is not a bitmask string, as
 * `permissionsFromString` reads one.
 */
export function storedPermissionBits(column: string): bigint {
  return permissionBitsFromString(column) ?? 0n;
}

/** What a channel-override write stores, and what it changes. */
export interface OverrideWrite {
  allow: bigint;
  deny: bigint;
  /** Every bit that differs from the stored override, in allow or in deny. */
  changed: bigint;
  /**
   * Every bit the write turns ON: set in allow where the stored allow lacks
   * it, or in deny where the stored deny lacks it. The actor must hold these;
   * a bit turned off, or left as stored, is never refused on that ground.
   */
  turnedOn: bigint;
}

/**
 * The override a write stores: allow and deny each merged over the stored
 * override (none stored reads as 0/0), then stripped of the server-level-only
 * flags. The overlap check and the delete-or-upsert choice are made on this
 * result, which is what the row will hold.
 */
export function planOverrideWrite(
  stored: { allow: string; deny: string } | null,
  sentAllow: bigint,
  sentDeny: bigint,
  known: bigint,
): OverrideWrite {
  const storedAllow = stored ? storedPermissionBits(stored.allow) : 0n;
  const storedDeny = stored ? storedPermissionBits(stored.deny) : 0n;
  const allow = mergeKnownPermissions(storedAllow, sentAllow, known) & ~SERVER_LEVEL_ONLY_PERMISSIONS;
  const deny = mergeKnownPermissions(storedDeny, sentDeny, known) & ~SERVER_LEVEL_ONLY_PERMISSIONS;
  if ((allow & deny) !== 0n) {
    throw new BadRequestError('allow and deny cannot have overlapping bits');
  }
  return {
    allow,
    deny,
    changed: (allow ^ storedAllow) | (deny ^ storedDeny),
    turnedOn: (allow & ~storedAllow) | (deny & ~storedDeny),
  };
}
