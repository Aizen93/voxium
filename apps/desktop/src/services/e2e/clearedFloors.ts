// The floors this device knows, per account: for each direct conversation
// whose history the signed-in account cleared (it removed the conversation
// after the confirmation, #47), the time at or below which nothing of it may
// be shown, previewed, found by local search or written to the plaintext
// cache again (docs/e2e-dm-spec.md §9.1, "A cleared history").
//
// A module of its own that imports no store, service or crypto module (only
// the shared package), like undecryptedRows.ts: the E2E service (every `pt:`
// write and read), the display gate (dmCrypto) and the DM store all read it,
// and none of them may pull in the others. Floors are RAISED only by
// services/dmClearedHistory.ts, the one place that applies a floor; everyone
// else only asks. A floor is only ever a direct conversation's (OPAQUE_ID_RE):
// never a secure channel's cache scope `ch:{id}`.
//
// Times are compared as times (milliseconds since the epoch), never as
// strings. The floor is the server's `createdAt` of the newest message when
// the history was cleared, and every cache entry records the server's
// `createdAt` of its row (the POST / PATCH answer for an own send or edit,
// the row as served for a decrypt), so both sides of the comparison come
// from the same clock.

import { OPAQUE_ID_RE } from '@voxium/shared';

/** account id → conversation id → floor (ms since the epoch) */
const floors = new Map<string, Map<string, number>>();

/**
 * The server's ISO form of a time (`Date.prototype.toISOString`, or an
 * explicit offset), and nothing looser: `Date.parse` alone takes forms such as
 * "1" or "Nov 10" that no server sends, and a floor read from one would purge
 * what nobody asked to purge.
 */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A time as the server sends it, in ms since the epoch; null for anything else. */
export function parseServerTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40 || !ISO_TIME_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Raise `account`'s floor for `conversationId` to `floorMs`. A floor never
 * moves back: a lower or equal one changes nothing. Answers whether it rose.
 * Refuses an id that is no direct conversation's (OPAQUE_ID_RE), as
 * dmClearedHistory does first: a second line, so no secure channel's scope
 * can ever hold a floor.
 */
export function raiseClearedFloor(account: string, conversationId: string, floorMs: number): boolean {
  if (!account || typeof conversationId !== 'string' || !OPAQUE_ID_RE.test(conversationId) || !Number.isFinite(floorMs)) return false;
  let mine = floors.get(account);
  if (!mine) {
    mine = new Map();
    floors.set(account, mine);
  }
  const known = mine.get(conversationId);
  if (known !== undefined && known >= floorMs) return false;
  mine.set(conversationId, floorMs);
  return true;
}

/** `account`'s floor for `conversationId` (ms), null when it cleared nothing there this session. */
export function clearedFloorOf(account: string | null | undefined, conversationId: string | null | undefined): number | null {
  if (!account || !conversationId) return null;
  return floors.get(account)?.get(conversationId) ?? null;
}

/**
 * Whether a row or cache entry written at `createdAt` (the server's time, as
 * sent) lies at or below `account`'s floor for `conversationId`. A time that
 * does not read as the server's form says nothing: never at or below.
 */
export function isAtOrBelowClearedFloor(
  account: string | null | undefined,
  conversationId: string | null | undefined,
  createdAt: unknown,
): boolean {
  const floor = clearedFloorOf(account, conversationId);
  if (floor === null) return false;
  const at = parseServerTime(createdAt);
  return at !== null && at <= floor;
}

/** Logout (resetAccountStores): nothing of the account that is leaving stays. */
export function resetClearedFloors(): void {
  floors.clear();
}
