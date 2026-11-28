import {
  E2E_CHANNEL_SCOPE_PREFIX,
  E2E_SCOPE_STATES,
  E2E_SCOPE_STATES_MAX,
  isE2EScopeStatesScope,
  type E2EScopeState,
} from '@voxium/shared';
import { useDMStore } from '../stores/dmStore';
import { useServerStore } from '../stores/serverStore';
import { useChatStore } from '../stores/chatStore';
import { useE2EStore } from '../stores/e2eStore';
import { getE2EService, GONE_SCOPE_PURGE_MARK, PLAINTEXT_PURGE_BATCH, type E2EService } from './e2e/e2eService';
import type { CacheSweepRecord } from './e2e/vault';
import { currentE2ESessionUser, isE2ESessionEnded } from './e2e/session';
import { applyClearedFloor } from './dmClearedHistory';
import { isYoungerThan } from '../utils/age';

/**
 * The device's sweep of its plaintext cache (docs/e2e-dm-spec.md §9.1, "What
 * a device asks about its cache"). The cache (`pt:{messageId}` in the vault,
 * the scope a field of the entry) can hold the text of scopes no list will
 * ever name again: a conversation really deleted on the server while this
 * device was offline, a removed conversation whose floor is beyond the
 * DM_CLEARED_LIST_MAX newest the list teaches, a secure channel deleted, or
 * one this account is no longer a member of. The server knows; the device
 * asks it (`POST /e2e/scopes/states`). The rules, in one place (a native
 * client follows the same contract):
 *
 * WHEN. At most once per CACHE_SWEEP_INTERVAL_MS per vault: the vault's
 * record (`cache_sweep`) holds when the last run ended, read with
 * isYoungerThan, so a record dated ahead of the clock is not recent. A run
 * starts once BOTH this session's E2E service has started (the E2E store is
 * ready) and a first page of the conversation list has been applied for the
 * signed-in account (dmStore, noteConversationListApplied), never while
 * `navigator.onLine` is false (the next list asks again), and only for the
 * account signed in: every step after an await checks that the session that
 * started the run is still the current one (an epoch, bumped at logout by
 * resetCacheSweep, and the signed-in account), and ends without applying
 * anything otherwise. It runs on its own, after the start, and never fails or
 * delays it: every failure is one warning by message. A run that failed (a
 * request with no usable answer, a 429, a 5xx, a dropped answer, a vault
 * error) records the time of the failure in the record (`failedAt`) and is
 * not tried again before CACHE_SWEEP_RETRY_MS has passed, read with
 * isYoungerThan like the day (a time ahead of the clock is not recent); the
 * record makes a page reload respect it (a failure the record cannot take,
 * the vault itself failing, is remembered for the session only). The retry
 * comes at the next moment the sweep is considered (a first page of the
 * conversation list), from the position the failed run left (below).
 *
 * WHAT IT ASKS ABOUT. Every distinct scope the `pt:` cache holds that the
 * route takes (isE2EScopeStatesScope; anything else is never asked about,
 * so never purged), found by ONE read-only walk of the cache, a batch of
 * PLAINTEXT_PURGE_BATCH entries at a time, each batch a task of the service's
 * serial queue (ordered with the decrypts that write entries), resuming after
 * the last key; nothing loads the whole store. A run asks about at most
 * CACHE_SWEEP_MAX_REQUESTS x E2E_SCOPE_STATES_MAX scopes, in requests of
 * E2E_SCOPE_STATES_MAX, made OFF the queue (a slow answer holds no decrypt);
 * the walk stops at the last key it took a scope from, the record keeps that
 * key, and the next run resumes after it, so a big cache is covered over
 * several days and the walk then starts over. It never reads the
 * conversation list to decide what to ask: the list is paged, and a
 * conversation missing from the loaded pages says nothing.
 *
 * WHICH ANSWER IS USED. Only one that names exactly the scopes asked, each
 * once, each with a known state, a `clearedUntil` only on a conversation that
 * is not gone (the route serves none on a channel or a gone scope). Anything
 * else drops that answer whole, with one warning, and ends the run there like
 * any failure: nothing of IT is used. The answers kept before a failing
 * request ARE used (their floors and gone scopes, as at the end of a full
 * run, one purge walk for them) and, once they are, the record's position
 * moves to the key the last scope they covered was first found at: the next
 * run walks on from there, so it asks again about a scope with entries after
 * that key and skips none that was not answered. A run with no failure uses
 * its answers at its end and records the day. A 404 is a server without the
 * route: the day is recorded (asked again tomorrow, from the same key) and
 * nothing is purged. Any other failure records its time (above), not the day.
 *
 * WHAT IT DOES. `gone`: every cached text entry of that scope goes, this
 * account's own included, through the one primitive
 * (E2EService.purgeCachedPlaintexts), recorded per scope under its own mark
 * (`ptpurge:gone:{scope}`). The mark is cleared before each purge: the sweep
 * asks only about a scope its cache holds entries of, so a scope marked by
 * an earlier run that holds entries again (a secure channel rejoined under
 * the same id) is walked again. A `clearedUntil` on a conversation goes
 * through applyClearedFloor (services/dmClearedHistory.ts), the one place a
 * floor is applied, which checks its form and its bound. `open` and `hidden`
 * without a floor change nothing (a conversation hidden by a 2.1.x client
 * keeps its history and comes back whole).
 *
 * WHAT IT NEVER DOES. Delete a key: the purge removes `pt:` entries alone,
 * and the group sessions (`gs:`, `igs:`), the position bindings (`mi:`), the
 * kept shares (`pks:`), the owed acknowledgements (`pka:`), the Olm account
 * and sessions, the pinned identities and the secure-channel pins all stay,
 * as with floors. Purge a scope the server calls gone while this session
 * holds it on screen or in its stores (the conversation list, the channels
 * of the space shown, the chat view): it is kept, with one warning; the run
 * still records its day, and the scope is asked about again at the next sweep
 * whose walk reaches its entries; the purge asks again for every entry it
 * removes. Act
 * for another account than the one that asked.
 */

/** A vault is swept at most once in this long. */
export const CACHE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A run that failed is tried again no earlier than this long after the failure. */
export const CACHE_SWEEP_RETRY_MS = 3 * 60 * 60 * 1000;

/** At most this many requests a run, of E2E_SCOPE_STATES_MAX scopes each; the rest at the next run. */
export const CACHE_SWEEP_MAX_REQUESTS = 20;

/** The `applyClearedFloor` source of a floor the sweep was answered. */
const FLOOR_SOURCE = 'scope states';

/** One scope of an answer, checked. */
interface ScopeAnswer {
  scope: string;
  state: E2EScopeState;
  /** Unchecked: applyClearedFloor checks its form and bound. */
  clearedUntil: unknown;
}

/** Bumped at logout: a run of the session that ended applies nothing. */
let epoch = 0;
/** The account a first page of the conversation list was applied for, this session. */
let listAppliedFor: string | null = null;
/** When the last run ended, as this session knows it (the vault's record, read or written): no new run before CACHE_SWEEP_INTERVAL_MS. */
let knownAt: number | undefined;
/** When the last run of this session failed (the vault's record, read or written): no new run before CACHE_SWEEP_RETRY_MS. */
let failedAt: number | undefined;
/** The wait for the network was logged and the device has not been online since: one line per offline period. */
let offlineLogged = false;
/** The run in progress, if any. */
let running: Promise<void> | null = null;
/** The subscription waiting for the E2E start, if any. */
let stopReadinessWatch: (() => void) | null = null;
/** Every run not settled yet, one of a session that ended included (cacheSweepSettled). */
const unsettled = new Set<Promise<void>>();

/**
 * A first page of the conversation list was applied (dmStore), for `askedBy`
 * (the account that asked for it, read before its request). A run starts now
 * or once the E2E service has started, when one is due.
 */
export function noteConversationListApplied(askedBy: string | null | undefined): void {
  const account = currentE2ESessionUser();
  if (!account || askedBy !== account) return;
  listAppliedFor = account;
  considerRun();
}

/** Logout (resetAccountStores): a run still going applies nothing, and the next session starts from nothing. */
export function resetCacheSweep(): void {
  epoch += 1;
  listAppliedFor = null;
  knownAt = undefined;
  failedAt = undefined;
  offlineLogged = false;
  running = null;
  stopWatchingReadiness();
}

/** Resolves once every run started so far has settled (tests; nothing in the app awaits a sweep). */
export async function cacheSweepSettled(): Promise<void> {
  while (unsettled.size > 0) await Promise.allSettled([...unsettled]);
}

function considerRun(): void {
  const account = currentE2ESessionUser();
  if (!account || listAppliedFor !== account) return;
  if (running || isYoungerThan(failedAt, CACHE_SWEEP_RETRY_MS) || isYoungerThan(knownAt, CACHE_SWEEP_INTERVAL_MS)) return;
  if (!useE2EStore.getState().ready) {
    watchReadiness();
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (!offlineLogged) {
      offlineLogged = true;
      console.debug('[E2E] The cache sweep waits for the network (the next list asks again)');
    }
    return;
  }
  offlineLogged = false;
  stopWatchingReadiness();
  const mine = epoch;
  // the session that started the run is still the current one
  const live = () => epoch === mine && currentE2ESessionUser() === account;
  const run: Promise<void> = sweep(account, live)
    .catch((err: unknown) => {
      if (!live() || isE2ESessionEnded(err)) {
        console.debug('[E2E] The cache sweep ended with the session');
        return;
      }
      // a failure before the record was read is remembered here only
      if (!isYoungerThan(failedAt, CACHE_SWEEP_RETRY_MS)) failedAt = Date.now();
      console.warn('[E2E] The cache sweep stopped (tried again in a few hours):', errorSummary(err));
    })
    .finally(() => {
      unsettled.delete(run);
      if (running === run) running = null;
    });
  running = run;
  unsettled.add(run);
}

/** Waits for the E2E start of this session (a start that failed may be tried again): one subscription at most. */
function watchReadiness(): void {
  if (stopReadinessWatch) return;
  stopReadinessWatch = useE2EStore.subscribe((state) => {
    if (state.ready) considerRun();
  });
}

function stopWatchingReadiness(): void {
  const stop = stopReadinessWatch;
  stopReadinessWatch = null;
  stop?.();
}

/**
 * One run, for `account`, while `live` holds (checked after every await: a
 * run the session overtook returns, applying nothing more). Throws what
 * failed, after recording the failure (see below).
 */
async function sweep(account: string, live: () => boolean): Promise<void> {
  const service = getE2EService(account);

  const record = readRecord(await service.readCacheSweepRecord());
  if (!live()) return;
  if (record && isYoungerThan(record.at, CACHE_SWEEP_INTERVAL_MS)) {
    knownAt = record.at;
    return;
  }
  if (record && isYoungerThan(record.failedAt, CACHE_SWEEP_RETRY_MS)) {
    failedAt = record.failedAt;
    return;
  }

  // where the next run resumes if this one fails: after the last scope whose answer was kept
  const start = record?.after ?? null;
  let resumeAfter = start;
  try {
    const walk = await collectScopes(service, start, live);
    if (!walk) return;

    const answers: ScopeAnswer[] = [];
    let failure: { error: unknown } | null = null;
    for (let i = 0; i < walk.scopes.length; i += E2E_SCOPE_STATES_MAX) {
      const asked = walk.scopes.slice(i, i + E2E_SCOPE_STATES_MAX);
      let body: unknown;
      try {
        body = await service.fetchScopeStates(asked);
      } catch (err) {
        if (!live() || isE2ESessionEnded(err)) throw err;
        if (statusOf(err) === 404) {
          // a server without the route: not asked again before tomorrow, from the same key
          const at = Date.now();
          await service.writeCacheSweepRecord({ at, after: start });
          if (live()) {
            knownAt = at;
            failedAt = undefined;
          }
          console.debug('[E2E] The server does not answer cached scope states: the cache sweep waits a day');
          return;
        }
        failure = { error: err };
        break;
      }
      if (!live()) return;
      const kept = readAnswer(asked, body);
      if (!kept) {
        failure = { error: new Error('dropped an answer that does not name exactly the scopes asked') };
        break;
      }
      answers.push(...kept);
    }
    // what the kept answers say is applied, a failure after them or not
    if (!(await applyAnswers(service, account, answers, live))) return;
    if (failure) {
      // Only once they ARE applied does the position move, to the key the last
      // scope they covered was first found at (none kept: where this run
      // started). Every scope not answered was first found after that key, so
      // none is skipped; had the position moved before a purge that then
      // failed, the gone scopes of those answers would wait for the walk to
      // start over.
      if (answers.length > 0) resumeAfter = walk.firstKeys[answers.length - 1];
      throw failure.error;
    }

    const at = Date.now();
    await service.writeCacheSweepRecord({ at, after: walk.resumeAfter });
    if (live()) {
      knownAt = at;
      failedAt = undefined;
    }
  } catch (err) {
    if (live() && !isE2ESessionEnded(err)) await recordFailure(service, record, resumeAfter);
    throw err;
  }
}

/**
 * The time of a failed run goes in the record, beside the day of the last run
 * that ended (none: 0) and the position the next run resumes from; a record
 * that cannot be written leaves the failure remembered in memory only, and
 * is reported by its message.
 */
async function recordFailure(service: E2EService, record: CacheSweepRecord | null, after: string | null): Promise<void> {
  const at = Date.now();
  failedAt = at;
  try {
    await service.writeCacheSweepRecord({ at: record?.at ?? 0, after, failedAt: at });
  } catch (err) {
    console.warn('[E2E] The cache sweep could not record its failure:', errorSummary(err));
  }
}

/**
 * What kept answers say: floors first, then the gone scopes the session does
 * not hold, purged in one walk. False when the session ended meanwhile.
 */
async function applyAnswers(service: E2EService, account: string, answers: readonly ScopeAnswer[], live: () => boolean): Promise<boolean> {
  // Floors first, through the one place that applies them (it checks each)
  for (const answer of answers) {
    if (answer.clearedUntil !== undefined) applyClearedFloor(answer.scope, answer.clearedUntil, FLOOR_SOURCE, account);
  }

  const gone = answers.filter((a) => a.state === 'gone').map((a) => a.scope);
  const held = gone.filter(isHeldHere);
  if (held.length > 0) {
    console.warn(`[E2E] The cache sweep keeps the cached text of ${held.length} scope(s) the server calls gone that this session holds (asked again at the next sweep)`);
  }
  const purge = gone.filter((scope) => !held.includes(scope));
  if (purge.length > 0) {
    // a record only: a scope found again holds entries again, and is walked
    // again. One queue task per slice of E2E_SCOPE_STATES_MAX scopes (a task
    // deletes its slice's records one by one), so no task holds the queue long
    for (let i = 0; i < purge.length; i += E2E_SCOPE_STATES_MAX) {
      await service.clearPurgeMarks(GONE_SCOPE_PURGE_MARK, purge.slice(i, i + E2E_SCOPE_STATES_MAX));
      if (!live()) return false;
    }
    // asked again for every entry, inside each batch: a scope this session
    // comes to hold, or a session that ended, keeps what is left
    const mayPurge = (scope: string) => live() && !isHeldHere(scope);
    const { removed } = await service.purgeCachedPlaintexts(purge, (entry) => mayPurge(entry.scope), {
      mark: GONE_SCOPE_PURGE_MARK,
      record: mayPurge,
    });
    if (!live()) return false;
    if (removed > 0) console.debug(`[E2E] The cache sweep removed ${removed} cached entries of scopes that are gone`);
  }
  return live();
}

/**
 * The read-only walk: the distinct scopes the cache holds after the key
 * `after`, up to what one run asks about, the key each was first found at
 * (what a run that failed resumes after), and the key the next run resumes
 * after (null once the walk reached the end). Null when the session ended.
 */
async function collectScopes(
  service: E2EService,
  after: string | null,
  live: () => boolean,
): Promise<{ scopes: string[]; firstKeys: string[]; resumeAfter: string | null } | null> {
  const cap = CACHE_SWEEP_MAX_REQUESTS * E2E_SCOPE_STATES_MAX;
  const found = new Set<string>();
  const firstKeys: string[] = [];
  let cursor = after;
  for (;;) {
    const batch = await service.listCachedScopes(cursor, PLAINTEXT_PURGE_BATCH);
    if (!live()) return null;
    let last = cursor;
    for (const { key, scope } of batch.entries) {
      if (isE2EScopeStatesScope(scope) && !found.has(scope)) {
        // one scope more than a run asks about: the next run starts with it
        if (found.size >= cap) return { scopes: [...found], firstKeys, resumeAfter: last };
        found.add(scope);
        firstKeys.push(key);
      }
      last = key;
    }
    if (batch.next === null) return { scopes: [...found], firstKeys, resumeAfter: null };
    cursor = batch.next;
  }
}

/** The vault's record, checked: null for none or one this build cannot read (then a run is due, from the start). */
function readRecord(value: unknown): CacheSweepRecord | null {
  if (!value || typeof value !== 'object') return null;
  const { at, after, failedAt: failed } = value as { at?: unknown; after?: unknown; failedAt?: unknown };
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const record: CacheSweepRecord = { at, after: typeof after === 'string' && after.startsWith('pt:') ? after : null };
  if (typeof failed === 'number' && Number.isFinite(failed)) record.failedAt = failed;
  return record;
}

/**
 * An answer, used only when it names exactly the scopes asked, each once,
 * each with a known state, and a `clearedUntil` only on a conversation that
 * is not gone; null otherwise (the answer is dropped whole).
 */
function readAnswer(asked: readonly string[], body: unknown): ScopeAnswer[] | null {
  if (!body || typeof body !== 'object') return null;
  const { success, data } = body as { success?: unknown; data?: unknown };
  if (success !== true || !Array.isArray(data) || data.length !== asked.length) return null;
  const wanted = new Set(asked);
  const seen = new Set<string>();
  const out: ScopeAnswer[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') return null;
    const { scope, state, clearedUntil } = raw as { scope?: unknown; state?: unknown; clearedUntil?: unknown };
    if (typeof scope !== 'string' || !wanted.has(scope) || seen.has(scope)) return null;
    if (typeof state !== 'string' || !(E2E_SCOPE_STATES as readonly string[]).includes(state)) return null;
    if (clearedUntil !== undefined && (scope.startsWith(E2E_CHANNEL_SCOPE_PREFIX) || state === 'gone')) return null;
    seen.add(scope);
    out.push({ scope, state: state as E2EScopeState, clearedUntil });
  }
  return out;
}

/**
 * Whether this session holds `scope` on screen or in its stores: a
 * conversation of the loaded list, the one open, or the chat view's; a
 * secure channel of the space shown, the one open, or the chat view's.
 */
function isHeldHere(scope: string): boolean {
  const view = useChatStore.getState().viewScope;
  if (scope.startsWith(E2E_CHANNEL_SCOPE_PREFIX)) {
    const channelId = scope.slice(E2E_CHANNEL_SCOPE_PREFIX.length);
    const server = useServerStore.getState();
    return (
      server.activeChannelId === channelId ||
      server.channels.some((c) => c.id === channelId) ||
      (view?.kind === 'channel' && view.id === channelId)
    );
  }
  const dm = useDMStore.getState();
  return (
    dm.activeConversationId === scope ||
    dm.conversations.some((c) => c.id === scope) ||
    (view?.kind === 'conversation' && view.id === scope)
  );
}

/** The HTTP status of a failed request, when it got one. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A failure as its name and message (an IndexedDB DOMException is not always
 * an Error instance): never a scope's text (the sweep reads none).
 */
function errorSummary(err: unknown): string {
  if (err && typeof err === 'object') {
    const { name, message } = err as { name?: unknown; message?: unknown };
    const parts = [name, message].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(': ');
  }
  return 'unknown error';
}
