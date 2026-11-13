// The rows the display gate could not open because their group session was not
// on this device, held so that they can be opened once it is
// (redecryptOnKeyArrival.ts). A refused row carries no ciphertext (refusedRow
// blanks it), so the row as the gate received it is kept here, outside every
// store and the DOM, and only ever handed back to the same gate.
//
// No store, service or crypto import: dmCrypto and channelCrypto use this
// module, and chatStore imports those.
import { E2E_ENGINE_MEGOLM1, parseE2EEnvelope } from '@voxium/shared';
import type { Message } from '@voxium/shared';

/** Rows held at most; the oldest is dropped beyond. */
export const UNDECRYPTED_ROWS_MAX = 500;
/** Announced sessions remembered at most (see arrivalMark); the oldest is dropped beyond. */
export const SESSION_ARRIVALS_MAX = 2000;

interface HeldRow {
  /** The row as the gate received it, the server's assertions dropped. */
  row: Message;
  scope: string;
  /** The group session its envelope names. */
  sessionId: string;
  /** arrivalMark() before the decrypt that failed. */
  mark: number;
}

/** How many announcements of stored sessions there have been (noteSessionsAvailable). */
let announcements = 0;
/** `scope|sessionId` → the announcement that named it, oldest first. */
const announcedAt = new Map<string, number>();
/** Message id → its held row, oldest first. */
const held = new Map<string, HeldRow>();
/** Scope → ids of held rows whose session was announced after their decrypt began. */
const due = new Map<string, Set<string>>();

const sessionKey = (scope: string, sessionId: string): string => `${scope}|${sessionId}`;

function markDue(scope: string, messageId: string): void {
  let ids = due.get(scope);
  if (!ids) {
    ids = new Set();
    due.set(scope, ids);
  }
  ids.add(messageId);
}

/**
 * Taken before a decrypt and handed to holdUndecrypted when it fails: a
 * session announced after this point makes the row due, also one stored
 * while the decrypt was running.
 */
export function arrivalMark(): number {
  return announcements;
}

/** The E2E service stored these inbound group sessions for `scope`: the rows held under them are due. */
export function noteSessionsAvailable(scope: string, sessionIds: readonly string[]): void {
  announcements += 1;
  const ids = new Set(sessionIds);
  for (const id of ids) {
    const key = sessionKey(scope, id);
    // re-inserted, so the map stays oldest first
    announcedAt.delete(key);
    announcedAt.set(key, announcements);
  }
  for (const key of announcedAt.keys()) {
    if (announcedAt.size <= SESSION_ARRIVALS_MAX) break;
    announcedAt.delete(key);
  }
  for (const [messageId, entry] of held) {
    if (entry.scope === scope && ids.has(entry.sessionId)) markDue(scope, messageId);
  }
}

/**
 * Hold a row whose decrypt failed (the stripped row the gate decrypted, its
 * scope, and the mark taken before the decrypt). Only a Megolm row is held:
 * a group session reaching this device later is the one thing that can open
 * it. It is due at once when its session was announced after the mark.
 */
export function holdUndecrypted(row: Message, scope: string, mark: number): void {
  forgetUndecrypted(row.id);
  const envelope = parseE2EEnvelope(row.content);
  if (!envelope || envelope.e !== E2E_ENGINE_MEGOLM1) return;
  held.set(row.id, { row, scope, sessionId: envelope.sid, mark });
  for (const messageId of held.keys()) {
    if (held.size <= UNDECRYPTED_ROWS_MAX) break;
    forgetUndecrypted(messageId);
  }
  const announced = announcedAt.get(sessionKey(scope, envelope.sid));
  if (held.has(row.id) && announced !== undefined && announced > mark) markDue(scope, row.id);
}

/** Drop a held row: the gate answered for its id again, or it was dropped from the view. */
export function forgetUndecrypted(messageId: string): void {
  const entry = held.get(messageId);
  if (!entry) return;
  held.delete(messageId);
  const ids = due.get(entry.scope);
  if (!ids) return;
  ids.delete(messageId);
  if (ids.size === 0) due.delete(entry.scope);
}

/** Whether a held row of `scope` waits to be tried again. */
export function hasDueRows(scope: string): boolean {
  return (due.get(scope)?.size ?? 0) > 0;
}

/**
 * The due rows of `scope` that `shown` accepts (the view shows them, in the
 * refused shape and at the version held), taken off the due list: each is
 * tried once per announcement of its session, and the gate holds one that
 * still fails again under a new mark. A due row the view does not show that
 * way yet stays due, for when it lands there.
 */
export function takeDueRows(scope: string, shown: (row: Message) => boolean): Message[] {
  const ids = due.get(scope);
  if (!ids) return [];
  const taken: Message[] = [];
  for (const messageId of [...ids]) {
    const entry = held.get(messageId);
    if (!entry) {
      ids.delete(messageId);
      continue;
    }
    if (!shown(entry.row)) continue;
    ids.delete(messageId);
    taken.push(entry.row);
  }
  if (ids.size === 0) due.delete(scope);
  return taken;
}

/** The view was cleared (chatStore.clearMessages): what it showed is fetched, and gated, again. */
export function clearUndecryptedRows(): void {
  held.clear();
  due.clear();
}

/** Logout (resetAccountStores): nothing of the account that is leaving stays. */
export function resetUndecryptedRows(): void {
  clearUndecryptedRows();
  announcedAt.clear();
}
