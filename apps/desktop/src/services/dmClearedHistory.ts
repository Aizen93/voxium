import { DM_CLEARED_LIST_MAX, OPAQUE_ID_RE } from '@voxium/shared';
import type { Conversation } from '@voxium/shared';
import { currentE2ESessionUser, isE2ESessionEnded } from './e2e/session';
import { clearedFloorOf, isAtOrBelowClearedFloor, parseServerTime, raiseClearedFloor, resetClearedFloors } from './e2e/clearedFloors';
import type { PlaintextPurgeEntry } from './e2e/vault';

/**
 * A removed conversation's cleared history, on this device (#47; spec §9.1,
 * "A cleared history"). The 2.2.0 client removes a conversation only after
 * its confirmation, with `?clearHistory=true`: the server then sets the
 * remover's FLOOR (the newest message's time) and serves them nothing at or
 * below it again. This module is the ONE place a floor is applied on the
 * client, from four ways in:
 *  - the answer to the removal (dmStore.removeConversation),
 *  - `dm:conversation:deleted { conversationId, clearedUntil? }`, sent to every
 *    device of the remover (dmStore.applyConversationRemoval, from MainLayout),
 *  - every conversation that enters the store carrying `clearedUntil` (the
 *    list, an open, dmStore.addConversation),
 *  - the list's `cleared` (applyClearedList): the floors of the conversations
 *    this account removed, which the list itself leaves out, at most
 *    DM_CLEARED_LIST_MAX of them, newest first. Every session's first list
 *    teaches them again, so a device that missed the removal, quit in the
 *    middle of a walk or never started its encryption purges at its next one.
 *
 * Only a direct conversation's id is taken (OPAQUE_ID_RE: a secure channel's
 * cache scope `ch:{id}` never is one), and only a floor no later than this
 * device's clock plus CLEARED_FLOOR_MAX_AHEAD_MS: the server names the floor
 * and the device cannot check it, so a floor far in the future, which would
 * refuse every later row of the conversation for the session, is ignored.
 *
 * Applying a floor:
 *  1. raises it in services/e2e/clearedFloors.ts, synchronously: from that
 *     moment the E2E service writes no `pt:` entry at or below it for that
 *     conversation and answers none (previews, quotes, own rows, local search),
 *     and the display gate shows no row at or below it. A floor never moves
 *     back, and the same floor twice changes nothing.
 *  2. purges this device's cache of that conversation up to it: every `pt:`
 *     entry whose recorded `createdAt` is at or below the floor, this
 *     account's own lines included (the server never serves them to this
 *     account again). An entry that records no time is kept. The `mi:`
 *     position bindings and every key are kept. One walk of the cache on the
 *     service's queue for every floor owed (E2EService.purgeCachedPlaintexts),
 *     recorded in the vault under a levelled mark
 *     (`ptpurge:cleared:{conversationId}` holding the floor) once the walk
 *     ended with no failure: a later session walks nothing for that floor or a
 *     lower one, and walks again for a higher one. A walk that fails records
 *     nothing and stays owed; so does one asked before the E2E service
 *     started (it waits for the start, then for the next list fetch, which
 *     tries every owed floor again, listed or not). A floor still owed when
 *     the session ends is taught again by the next session's list.
 *
 * Works for a conversation the store no longer holds (the removal has just
 * dropped it): nothing here reads the conversation list.
 *
 * Account scope: every floor and every owed purge belongs to the account
 * signed in when it was applied, and logout drops them all
 * (resetClearedHistory, from resetAccountStores); a pass of the account that
 * left applies nothing.
 *
 * KNOWN LIMITS: a conversation really deleted on the server (nobody could
 * reach it any more) while a device was offline leaves that device's cached
 * entries of it in its vault, unreachable from the interface (no list names
 * it again, so nothing displays or searches them). So do the removed
 * conversations beyond the DM_CLEARED_LIST_MAX newest floors, for a device
 * that missed their removal. A 2.1.x client ignores floors.
 *
 * No store is imported here (dmStore imports this module); the E2E service
 * and the E2E store are loaded when a purge runs.
 */

/** Floors whose purge has not ended on this device yet: conversation id → floor (ms). */
let owed = new Map<string, number>();
/** The account `owed` belongs to. */
let owedBy: string | null = null;
/** The pass running, if any: what is asked meanwhile runs once more after it. */
let passing: Promise<void> | null = null;
let passAgain = false;
/** Bumped at logout: a pass of the account that left applies nothing. */
let epoch = 0;
/** Every pass not settled yet, one of an account that left included (clearedHistoryPurgesSettled). */
const unsettled = new Set<Promise<void>>();
/** The waits for the E2E start still out: logout ends them at once (answering "not ready"). */
const readinessWaits = new Set<() => void>();

/** How long a purge waits for the E2E service to finish starting before it leaves the work to the next list fetch. */
export const CLEARED_PURGE_E2E_READY_WAIT_MS = 60_000;

/**
 * A floor later than this device's clock by more than this is ignored: the
 * server's word can make a device delete its cached text up to the time it
 * names, and a floor in the future would also refuse every later row of the
 * conversation for the session. A device whose clock is more than a day
 * behind only keeps a leftover in its cache.
 */
export const CLEARED_FLOOR_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Apply the floor `clearedUntil` (the server's ISO time) to `conversationId`
 * for the signed-in account. Absent (undefined or null): nothing was
 * cleared, nothing happens. Malformed (not the server's ISO form): ignored,
 * with one warning naming where it came from. Answers the floor now known for
 * that conversation (ms), or null.
 *
 * `askedBy`: the account that sent the request this floor answers (read
 * BEFORE the request). An answer landing after that account signed out, and
 * someone else signed in, applies nothing: its floor is not theirs.
 */
export function applyClearedFloor(conversationId: unknown, clearedUntil: unknown, source: string, askedBy?: string | null): number | null {
  if (clearedUntil === undefined || clearedUntil === null) return null;
  // a direct conversation's id only: never a secure channel's cache scope
  // (`ch:{id}`, which the colon keeps out of OPAQUE_ID_RE) or anything else
  if (typeof conversationId !== 'string' || !OPAQUE_ID_RE.test(conversationId)) {
    console.warn(`[DM] Ignoring a cleared-history floor that names no direct conversation (${source})`);
    return null;
  }
  const floor = parseServerTime(clearedUntil);
  if (floor === null) {
    console.warn(`[DM] Ignoring a malformed clearedUntil (${source})`);
    return null;
  }
  if (floor > Date.now() + CLEARED_FLOOR_MAX_AHEAD_MS) {
    console.warn(`[DM] Ignoring a clearedUntil more than a day ahead of this device's clock (${source})`);
    return null;
  }
  const account = currentE2ESessionUser();
  if (!account) return null;
  if (askedBy !== undefined && askedBy !== account) {
    console.debug(`[DM] A cleared-history floor answered to an account that has signed out is dropped (${source})`);
    return null;
  }
  if (raiseClearedFloor(account, conversationId, floor)) {
    if (owedBy !== account) {
      owed = new Map();
      owedBy = account;
    }
    // risen: higher than anything owed for it
    owed.set(conversationId, floor);
    requestPass();
  }
  return clearedFloorOf(account, conversationId);
}

/**
 * The floors a server answer or a list carries (`clearedUntil`), applied
 * before any of them reaches the store, for `askedBy` only (see
 * applyClearedFloor).
 */
export function applyConversationFloors(conversations: readonly Conversation[], askedBy?: string | null): void {
  for (const conversation of conversations) {
    if (conversation?.clearedUntil !== undefined) {
      applyClearedFloor(conversation.id, conversation.clearedUntil, 'conversation', askedBy);
    }
  }
}

/**
 * The list's `cleared` (GET /dm): the floors of the conversations this
 * account removed, off its list, checked at runtime and applied each like any
 * other floor (applyClearedFloor), for `askedBy` only. Absent: nothing. One
 * that is not a list, or entries that are not `{ conversationId,
 * clearedUntil }`, are ignored with one warning; at most DM_CLEARED_LIST_MAX
 * are read. A floor this session already knows costs nothing (no walk, no
 * vault read); a new one walks only when the vault's record is below it.
 */
export function applyClearedList(cleared: unknown, askedBy?: string | null): void {
  if (cleared === undefined || cleared === null) return;
  if (!Array.isArray(cleared)) {
    console.warn('[DM] Ignoring a malformed list of cleared conversations');
    return;
  }
  let malformed = false;
  for (const entry of cleared.slice(0, DM_CLEARED_LIST_MAX)) {
    if (!entry || typeof entry !== 'object') {
      malformed = true;
      continue;
    }
    const { conversationId, clearedUntil } = entry as { conversationId?: unknown; clearedUntil?: unknown };
    if (clearedUntil === undefined || clearedUntil === null) {
      malformed = true;
      continue;
    }
    applyClearedFloor(conversationId, clearedUntil, 'cleared list', askedBy);
  }
  if (malformed) console.warn('[DM] Ignoring malformed entries of the list of cleared conversations');
}

/**
 * The conversation as the store may hold it: a last message at or below the
 * known floor (a list answered from before the removal) is no preview.
 */
export function withoutClearedPreview(conversation: Conversation): Conversation {
  const last = conversation.lastMessage;
  if (!last || !isAtOrBelowClearedFloor(currentE2ESessionUser(), conversation.id, last.createdAt)) return conversation;
  return { ...conversation, lastMessage: null };
}

/** The `clearedUntil` a removal's answer (`{ success, message, data?: { clearedUntil } }`) carries, unchecked. */
export function removalAnswerFloor(answer: unknown): unknown {
  if (!answer || typeof answer !== 'object') return undefined;
  const data = (answer as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return (data as { clearedUntil?: unknown }).clearedUntil;
}

/** `dm:conversation:deleted`, checked at runtime (TypeScript is erased). */
export interface ConversationRemovedNotice {
  conversationId: string;
  /** Checked by applyClearedFloor (a malformed one is ignored there, with its warning). */
  clearedUntil: unknown;
}

/** The event's payload, or null (logged once) when it names no conversation. */
export function readConversationRemovedNotice(data: unknown): ConversationRemovedNotice | null {
  const conversationId = data && typeof data === 'object' ? (data as { conversationId?: unknown }).conversationId : undefined;
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    console.warn('[DM] Ignoring a malformed dm:conversation:deleted payload');
    return null;
  }
  return { conversationId, clearedUntil: (data as { clearedUntil?: unknown }).clearedUntil };
}

/** Every owed purge of the signed-in account is tried again (dmStore.fetchConversations, at every list fetch). */
export function retryOwedClearedPurges(): void {
  if (owed.size > 0) requestPass();
}

/** Logout (resetAccountStores): the floors and the owed purges of the account that is leaving go. */
export function resetClearedHistory(): void {
  epoch += 1;
  owed = new Map();
  owedBy = null;
  passing = null;
  passAgain = false;
  // a pass waiting for the start ends now and applies nothing (its epoch is gone)
  for (const end of [...readinessWaits]) end();
  resetClearedFloors();
}

/** Resolves once every pass started so far has settled (tests; nothing in the app awaits a purge). */
export async function clearedHistoryPurgesSettled(): Promise<void> {
  while (unsettled.size > 0) await Promise.allSettled([...unsettled]);
}

/** Whether a cache entry lies at or below the floor this pass purges its scope to: own and others' alike, never one without a time. */
function entryAtOrBelow(entry: PlaintextPurgeEntry, floors: ReadonlyMap<string, number>): boolean {
  const floor = floors.get(entry.scope);
  if (floor === undefined) return false;
  const at = parseServerTime(entry.createdAt);
  return at !== null && at <= floor;
}

function requestPass(): void {
  if (passing) {
    passAgain = true;
    return;
  }
  const mine = epoch;
  const run: Promise<void> = (async () => {
    do {
      passAgain = false;
      await purgePass(mine);
    } while (passAgain && epoch === mine);
  })()
    .catch((err: unknown) => {
      console.warn('[DM] The purge of cleared histories stopped:', errorSummary(err));
    })
    .finally(() => {
      unsettled.delete(run);
      if (passing === run) passing = null;
    });
  passing = run;
  unsettled.add(run);
}

/**
 * One walk for every floor owed when it starts, after the E2E service's own
 * start (the start opens the vault, which a purge must not race). A floor
 * that rises during the walk stays owed and is walked by the next pass.
 */
async function purgePass(mine: number): Promise<void> {
  if (owed.size === 0) return;
  const ready = await whenE2EReady(mine);
  if (epoch !== mine) return;
  const account = currentE2ESessionUser();
  // what an account that has signed out asked for is dropped with it
  if (!account || account !== owedBy) {
    owed = new Map();
    owedBy = null;
    return;
  }
  if (!ready) {
    console.debug('[DM] The purge of cleared histories waits for the encryption to start');
    return;
  }
  const floors = new Map(owed);
  try {
    const { getE2EService, CLEARED_HISTORY_PURGE_MARK } = await import('./e2e/e2eService');
    if (epoch !== mine) return;
    const { removed, marked } = await getE2EService(account).purgeCachedPlaintexts(
      [...floors.keys()],
      (entry) => entryAtOrBelow(entry, floors),
      { mark: CLEARED_HISTORY_PURGE_MARK, levels: floors },
    );
    if (epoch !== mine) return;
    // done for the floor it walked; a higher one that came meanwhile stays owed
    for (const conversationId of marked) {
      if (owed.get(conversationId) === floors.get(conversationId)) owed.delete(conversationId);
    }
    if (removed > 0) console.debug(`[DM] Purged ${removed} cached entries of cleared histories`);
  } catch (err) {
    if (epoch !== mine) return;
    if (isE2ESessionEnded(err)) {
      console.debug('[DM] The purge of cleared histories ended with the session');
      return;
    }
    // owed still: the next list fetch, or the next floor, tries again
    console.warn('[DM] Could not purge the cached text of a cleared history (tried again at the next list):', errorSummary(err));
  }
}

/**
 * True once the E2E service of this session has started; false when its start
 * failed (at once when the store already holds the error), did not end in
 * time, the store could not be loaded, or the session ended meanwhile.
 */
async function whenE2EReady(mine: number): Promise<boolean> {
  let store: typeof import('../stores/e2eStore').useE2EStore;
  try {
    ({ useE2EStore: store } = await import('../stores/e2eStore'));
  } catch (err) {
    console.warn('[DM] The encryption state could not be read for a purge:', errorSummary(err));
    return false;
  }
  // the session ended while the store was loading: nothing to wait for
  if (epoch !== mine) return false;
  const initial = store.getState();
  if (initial.ready) return true;
  if (initial.error) return false;
  return new Promise<boolean>((resolve) => {
    const settle = (ready: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      readinessWaits.delete(end);
      resolve(ready);
    };
    const end = () => settle(false);
    const timer = setTimeout(end, CLEARED_PURGE_E2E_READY_WAIT_MS);
    const unsubscribe = store.subscribe((s) => {
      if (s.ready || s.error) settle(s.ready);
    });
    readinessWaits.add(end);
  });
}

/**
 * A failure as its name and message (an IndexedDB DOMException is not always
 * an Error instance): never the text the purge was about (the predicate sees
 * none).
 */
function errorSummary(err: unknown): string {
  if (err && typeof err === 'object') {
    const { name, message } = err as { name?: unknown; message?: unknown };
    const parts = [name, message].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(': ');
  }
  return 'unknown error';
}
