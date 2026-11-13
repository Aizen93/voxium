// The rows the display gate could not open because their group session was not
// on this device, held so that they can be opened once it is
// (redecryptOnKeyArrival.ts). A refused row carries no ciphertext (refusedRow
// blanks it), so the row as the gate received it is kept here, outside every
// store and the DOM, and only ever handed back to the same gate.
//
// What is held follows the view, never the order in which gate calls finish:
// the gate notes each failure by version (scope, id, editedAt, author), and a
// failure is held only once the view shows that version of the row in the
// refused shape (syncWithView, on every change of the view). A gate answer the
// view drops (a duplicate, a page overlapping what it shows) never lets go of
// a held row; a row the view stops showing (deleted, opened, another version,
// another scope on screen) is no longer held. So the held rows are bounded by
// the view itself, and the failures waiting to reach it are bounded apart.
// Quotes the gate left empty are noted by the quote object itself, so a quote
// waits only while the view shows that very object.
//
// No store, service or crypto import: dmCrypto and channelCrypto use this
// module, and chatStore imports those.
import { E2E_ENGINE_MEGOLM1, parseE2EEnvelope, parseE2EScope } from '@voxium/shared';
import type { Message } from '@voxium/shared';
import { isRefusedShape } from './displayGate';

/**
 * Failures waiting to reach the view, at most; the oldest is dropped beyond.
 * The rows the view shows are held apart from these and are not counted.
 */
export const PENDING_FAILURES_MAX = 500;
/** Announced sessions remembered at most (see arrivalMark); the oldest is dropped beyond. */
export const SESSION_ARRIVALS_MAX = 2000;

interface Failure {
  /** The row as the gate received it, the server's assertions dropped. */
  row: Message;
  scope: string;
  /** The group session its envelope names. */
  sessionId: string;
  /** arrivalMark() before the decrypt that failed. */
  mark: number;
}

interface HeldRow extends Failure {
  /** versionKey() of the row the view shows. */
  key: string;
  /** Its session was announced after its decrypt began, and no pass has tried it since. */
  due: boolean;
}

/** What a quote the gate left empty waits for: the row it quotes, in which scope, by which author. */
interface QuoteWait {
  scope: string;
  quotedId: string;
  quotedAuthorId: string;
}

/** How many announcements of stored sessions there have been (noteSessionsAvailable). */
let announcements = 0;
/** `scope|sessionId` → the announcement that named it, oldest first. */
const announcedAt = new Map<string, number>();
/** `scope|versionKey` → the latest failure of the gate for that version, oldest first. */
const pending = new Map<string, Failure>();
/** The scope the view showed at its last change, and its rows a failure backs, by message id. */
let heldScope: string | null = null;
const held = new Map<string, HeldRow>();
/** The scope on screen, as the watcher reads it; null until a watcher registers. */
let viewScope: (() => string | null) | null = null;
/**
 * The quote objects the gate left empty because the cache had nothing for the
 * row they quote, each with what it waits for. Keyed by the object itself: a
 * quote the gate locked, or the quote of a row gated again, is another object
 * and was never noted, and an entry lives only as long as the row that shows
 * its quote.
 */
let waitingQuotes = new WeakMap<object, QuoteWait>();

const sessionKey = (scope: string, sessionId: string): string => `${scope}|${sessionId}`;

/** The version of a row the gate answered for: its id, its edit and its author. */
export function versionKey(row: Message): string {
  return `${row.id}|${row.editedAt ?? ''}|${row.author?.id ?? ''}`;
}

/** Whether a row belongs to `scope`: a channel's by its channel, a conversation's by its conversation. */
export function rowInScope(row: Message, scope: string): boolean {
  const parsed = parseE2EScope(scope);
  if (parsed.kind === 'channel') return row.channelId === parsed.channelId;
  if (parsed.kind === 'dm') return row.conversationId === parsed.conversationId;
  return false;
}

function announcedAfter(failure: Failure): boolean {
  const announced = announcedAt.get(sessionKey(failure.scope, failure.sessionId));
  return announced !== undefined && announced > failure.mark;
}

/** The watcher's reading of the scope on screen; null unregisters (the watcher stopped). */
export function setViewScopeSource(source: (() => string | null) | null): void {
  viewScope = source;
}

/**
 * Taken before a decrypt and handed to noteUndecrypted when it fails: a
 * session announced after this point makes the row due, also one stored
 * while the decrypt was running.
 */
export function arrivalMark(): number {
  return announcements;
}

/**
 * The gate could not open this Megolm row (the stripped row it decrypted, its
 * scope, the mark taken before the decrypt). Noted for its version until the
 * view shows that version (syncWithView). A row of a scope that is not on
 * screen is not noted: the view does not show it, and opening that scope
 * fetches and gates its rows afresh.
 */
export function noteUndecrypted(row: Message, scope: string, mark: number): void {
  const envelope = parseE2EEnvelope(row.content);
  if (!envelope || envelope.e !== E2E_ENGINE_MEGOLM1) return;
  const onScreen = viewScope?.();
  if (viewScope && onScreen !== scope) return;
  const key = `${scope}|${versionKey(row)}`;
  // re-inserted, so the map stays oldest first
  pending.delete(key);
  pending.set(key, { row, scope, sessionId: envelope.sid, mark });
  for (const oldest of pending.keys()) {
    if (pending.size <= PENDING_FAILURES_MAX) break;
    pending.delete(oldest);
  }
}

/** The E2E service stored these inbound group sessions for `scope`: the rows held under them are due. */
export function noteSessionsAvailable(scope: string, sessionIds: readonly string[]): void {
  announcements += 1;
  const ids = new Set(sessionIds);
  for (const id of ids) {
    const key = sessionKey(scope, id);
    announcedAt.delete(key);
    announcedAt.set(key, announcements);
  }
  for (const key of announcedAt.keys()) {
    if (announcedAt.size <= SESSION_ARRIVALS_MAX) break;
    announcedAt.delete(key);
  }
  if (scope !== heldScope) return;
  for (const entry of held.values()) {
    if (ids.has(entry.sessionId)) entry.due = true;
  }
}

/**
 * Bring the held rows in line with what the view shows (`rows`, chatStore's
 * messages, of the scope on screen): a row shown in the refused shape at a
 * version the gate noted a failure for is held under the newest such failure;
 * every other held row is let go. Another scope on screen lets go of them all.
 */
export function syncWithView(scope: string | null, rows: readonly Message[]): void {
  if (scope !== heldScope) {
    held.clear();
    heldScope = scope;
  }
  if (!scope) return;
  const shown = new Set<string>();
  for (const row of rows) {
    if (!isRefusedShape(row) || !rowInScope(row, scope)) continue;
    const key = versionKey(row);
    const fresh = pending.get(`${scope}|${key}`);
    if (fresh) {
      pending.delete(`${scope}|${key}`);
      held.set(row.id, { ...fresh, key, due: announcedAfter(fresh) });
    } else if (held.get(row.id)?.key !== key) {
      held.delete(row.id);
    }
    if (held.has(row.id)) shown.add(row.id);
  }
  for (const messageId of [...held.keys()]) {
    if (!shown.has(messageId)) held.delete(messageId);
  }
}

/** Whether a held row of `scope` waits to be tried again. */
export function hasDueRows(scope: string): boolean {
  if (scope !== heldScope) return false;
  for (const entry of held.values()) if (entry.due) return true;
  return false;
}

/**
 * The due rows of `scope`, taken off the due list: each is tried once per
 * announcement of its session (a failure noted by that try is held in its
 * place at the next change of the view).
 */
export function takeDueRows(scope: string): Message[] {
  if (scope !== heldScope) return [];
  const taken: Message[] = [];
  for (const entry of held.values()) {
    if (!entry.due) continue;
    entry.due = false;
    taken.push(entry.row);
  }
  return taken;
}

/**
 * A try of this held row ended in an error, not in an answer: it stays held
 * and due, for the next announcement or change of the view.
 */
export function retryLater(row: Message): void {
  const entry = held.get(row.id);
  if (entry && entry.key === versionKey(row)) entry.due = true;
}

/**
 * The gate left `quote` (the quote object it put on its answer) empty: the
 * cache had nothing for the row it quotes. Noted for the scope on screen only.
 */
export function noteQuoteAwaiting(quote: NonNullable<Message['replyTo']>, scope: string): void {
  if (!quote.author) return;
  if (viewScope && viewScope() !== scope) return;
  waitingQuotes.set(quote, { scope, quotedId: quote.id, quotedAuthorId: quote.author.id });
}

/**
 * Whether `quote` is one the gate left empty in `scope` waiting for
 * `quotedId`, and still is: the same object, still empty, still naming the
 * author it named then. A quote the gate locked never answers true.
 */
export function quoteAwaits(quote: Message['replyTo'] | undefined, scope: string, quotedId: string): boolean {
  if (!quote || quote.content) return false;
  const wait = waitingQuotes.get(quote);
  return !!wait && wait.scope === scope && wait.quotedId === quotedId && quote.author?.id === wait.quotedAuthorId;
}

/** Logout (resetAccountStores): nothing of the account that is leaving stays. */
export function resetUndecryptedRows(): void {
  pending.clear();
  held.clear();
  heldScope = null;
  announcedAt.clear();
  waitingQuotes = new WeakMap();
}
