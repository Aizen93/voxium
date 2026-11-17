import { isDeletedParticipantId, isDMSystemNotice } from '@voxium/shared';
import type { Message } from '@voxium/shared';
import { useDMStore, isConversationReadOnly, type ReadOnlyPurgeState, type ReadOnlyTransition } from '../stores/dmStore';
import { useServerStore } from '../stores/serverStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useE2EStore } from '../stores/e2eStore';
import { closeProfilePopupsOf } from '../utils/profilePopupBus';
import { getE2EService, scopeMarkedPurged, READ_ONLY_PURGE_MARK } from './e2e/e2eService';
import { isE2ESessionEnded } from './e2e/session';

/**
 * A direct conversation turning read-only: the other side's account was
 * deleted, the conversation outlived it (utils/dmParticipant.ts). Two ways in,
 * one result:
 *
 *  - `dm:conversation:read_only { conversationId }` (at-most-once), which
 *    MainLayout registers as handleConversationReadOnly;
 *  - a list fetch (connect, resume, any refetch) that serves the conversation
 *    with `participantDeleted: true`, because that event can be missed
 *    (dmStore.fetchConversations calls applyReadOnlyConversations).
 *
 * Kept here, out of the layout, so both are unit-testable (the
 * services/webhookSocketHandlers.ts precedent).
 */

/** The `dm:conversation:read_only` payload's one field, checked at runtime (TypeScript is erased). */
function readOnlyConversationId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const id = (data as { conversationId?: unknown }).conversationId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * `dm:conversation:read_only`: a conversation this client does not hold yet
 * is held read-only by its id (dmStore.readOnlyPending: the display gate reads
 * it at once, and the next list applies it and purges it). Otherwise the
 * conversation flips to the read-only state at once (so the
 * composer, the call button, the safety number and the profile card go even
 * if the refetch below fails), what is on screen for it is brought into line,
 * its cached text of the other person is purged, and the list is fetched again.
 */
export function handleConversationReadOnly(data: unknown): void {
  const conversationId = readOnlyConversationId(data);
  if (!conversationId) {
    console.warn('[DM] Ignoring a malformed dm:conversation:read_only payload');
    return;
  }
  const dm = useDMStore.getState();
  if (!dm.conversations.some((c) => c.id === conversationId)) {
    dm.notePendingReadOnly(conversationId);
    return;
  }
  const localUserId = useAuthStore.getState().user?.id ?? null;
  const transition = dm.markParticipantDeleted(conversationId, localUserId);
  // already read-only (a list said so first): only the once-per-session purge is left
  if (transition) bringIntoLine(transition);
  purgeReadOnlyConversation(conversationId);
  if (transition) void useDMStore.getState().fetchConversations();
}

/**
 * Whether a DM row the gate let through stands as deleted under the read-only
 * rule NOW: its conversation is held read-only (the list fetched after the row
 * arrived may say so) and it is neither this account's own nor a listed call
 * notice. Such a row is no news: MainLayout drops it before any preview,
 * unread count, sound or notification.
 */
export function standsAsDeletedNow(message: Pick<Message, 'conversationId' | 'type' | 'encrypted' | 'content' | 'author'>): boolean {
  if (!message.conversationId || !isConversationReadOnly(message.conversationId)) return false;
  if (message.type === 'system' && !message.encrypted && isDMSystemNotice(message.content)) return false;
  const userId = useAuthStore.getState().user?.id ?? null;
  return !userId || message.author?.id !== userId;
}

/**
 * The list's other half (dmStore.fetchConversations, after it stored the
 * list): a conversation it serves live loses its purge mark, in memory at once
 * and in the vault on the service's queue, so the display gate gates it as
 * live again (the purged text stays purged). Only the marked ones cost
 * anything: once the service has read its marks, the question is a lookup in
 * memory. Waits for the E2E service's start like the purge, and clears
 * nothing for a session whose start failed (its marks stay in the vault for
 * the next session's first list). A conversation on screen in the DM view
 * whose mark this cleared is loaded again: its rows were gated under the
 * mark. A failure is logged.
 */
export function clearMarksOfLiveConversations(conversationIds: readonly string[]): void {
  const userId = useAuthStore.getState().user?.id;
  if (!userId || conversationIds.length === 0) return;
  void clearMarks(userId, conversationIds).catch((err: unknown) => {
    if (isE2ESessionEnded(err)) {
      console.debug('[DM] Clearing the purge marks of live conversations ended with the session');
      return;
    }
    console.warn('[DM] Could not clear the purge marks of conversations a list served live:', errorSummary(err));
  });
}

async function clearMarks(userId: string, conversationIds: readonly string[]): Promise<void> {
  if (!(await whenE2EReady())) return;
  if (useAuthStore.getState().user?.id !== userId) return;
  const marked: string[] = [];
  for (const id of conversationIds) {
    const answer = scopeMarkedPurged(userId, id);
    if (answer === true || (answer !== false && (await answer))) marked.push(id);
  }
  if (marked.length === 0 || useAuthStore.getState().user?.id !== userId) return;
  await getE2EService(userId).clearPurgeMarks(READ_ONLY_PURGE_MARK, marked);
  if (useAuthStore.getState().user?.id !== userId) return;
  // the rows on screen were gated under the mark: shown again by the live rule
  const dm = useDMStore.getState();
  const shown = dm.activeConversationId;
  if (!shown || !marked.includes(shown) || isConversationReadOnly(shown)) return;
  try {
    if (!useServerStore.getState().activeServerId) dm.reloadConversationView(shown);
  } catch (err) {
    console.warn('[DM] Could not reload a conversation whose purge mark a list cleared:', errorSummary(err));
  }
}

/**
 * The list fetch's side (dmStore.fetchConversations, after it stored the
 * list): the conversations that turned read-only since the last list are
 * brought into line, and every read-only one is purged once this session.
 * Never fetches the list itself.
 */
export function applyReadOnlyConversations(transitions: ReadOnlyTransition[], readOnlyConversationIds: string[]): void {
  for (const transition of transitions) bringIntoLine(transition);
  for (const conversationId of readOnlyConversationIds) purgeReadOnlyConversation(conversationId);
}

/**
 * What the screen still holds of the conversation's live state, each step on
 * its own (one that throws is logged and the others still run):
 *  - the view, when that conversation is the one shown in the DM view: loaded
 *    again, so the server's placeholder rows replace what was shown (and the
 *    reply being composed and the typing line go with the old rows);
 *  - a call of THAT conversation, ringing in or out or connected: ended
 *    locally (the server ends it on its side; nothing is emitted back);
 *  - the profile cards open on that person, wherever they were opened. Their
 *    safety-number dialog closes with the conversation header, which no
 *    longer renders the encryption controls (DMChatArea).
 */
function bringIntoLine({ conversationId, previousParticipantId }: ReadOnlyTransition): void {
  try {
    if (!useServerStore.getState().activeServerId) useDMStore.getState().reloadConversationView(conversationId);
  } catch (err) {
    console.warn('[DM] Could not reload a conversation that turned read-only:', err instanceof Error ? err.message : err);
  }
  try {
    const voice = useVoiceStore.getState();
    if (voice.dmCallConversationId === conversationId) voice.handleDMCallEnded();
    if (voice.incomingCall?.conversationId === conversationId) voice.setIncomingCall(null);
  } catch (err) {
    console.warn('[DM] Could not end the call of a conversation that turned read-only:', err instanceof Error ? err.message : err);
  }
  if (previousParticipantId && !isDeletedParticipantId(previousParticipantId)) {
    closeProfilePopupsOf(previousParticipantId);
  }
}

/** Conversations waiting for the next purge pass, each with the account that asked. */
let purgeQueue = new Map<string, string>();
/** A pass is running: what is asked meanwhile joins the next one. */
let passRunning = false;

/**
 * Drop this device's decrypted text of a read-only conversation that another
 * author wrote (E2EService.purgeCachedPlaintexts, on the service's queue),
 * keeping every entry this account wrote: its own messages still display,
 * from the cache or its own outbound session. An entry that records no author
 * is kept too: no reachable vault holds one (the author is recorded on every
 * entry an E2E build has written).
 *
 * The conversations asked for together (a list's read-only ones, asked in one
 * loop) are purged in ONE walk of the cache; one asked while a walk runs joins
 * the next. A scope is marked in the vault when its walk ends only if a LIST
 * served it read-only by then (dmStore.readOnlyConfirmed), never on the
 * event's word alone: a marked scope is held read-only from the start of every
 * later session, which skips its walk, until a list of that session names it
 * (the list's word decides then, and one serving it live clears the mark:
 * clearMarksOfLiveConversations). Once per conversation per session: a
 * purge running or done is not started again, one purged unmarked runs again
 * once a list confirms the conversation, one that failed runs again (the next
 * list fetch asks). A failure is logged, never the text, and never stops
 * anything on screen.
 */
export function purgeReadOnlyConversation(conversationId: string): void {
  const dm = useDMStore.getState();
  const state = dm.readOnlyPurges[conversationId];
  if (state === 'running' || state === 'done') return;
  if (state === 'unmarked' && !dm.readOnlyConfirmed[conversationId]) return;
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;
  setPurgeStates([conversationId], 'running');
  purgeQueue.set(conversationId, userId);
  if (passRunning) return;
  passRunning = true;
  void runPurgePasses().finally(() => {
    passRunning = false;
  });
}

async function runPurgePasses(): Promise<void> {
  // the first await lets every conversation asked in the same loop join the pass
  while (purgeQueue.size > 0) {
    // After the service's own start, never beside it: the start opens the
    // vault (and on a new device creates its key), which a purge must not
    // race. A start that failed leaves the purge for the next list.
    const ready = await whenE2EReady();
    const userId = useAuthStore.getState().user?.id ?? null;
    // what an account that has signed out asked for is dropped with it
    const scopes = [...purgeQueue].filter(([, askedBy]) => askedBy === userId).map(([scope]) => scope);
    purgeQueue = new Map();
    if (!userId || scopes.length === 0) continue;
    if (!ready) {
      setPurgeStates(scopes, null);
      console.debug('[DM] The purge of read-only conversations waits for the encryption to start');
      continue;
    }
    await purgePass(userId, scopes);
  }
}

async function purgePass(userId: string, scopes: string[]): Promise<void> {
  try {
    const { removed, marked } = await getE2EService(userId).purgeCachedPlaintexts(
      scopes,
      (entry) => entry.authorId !== undefined && entry.authorId !== userId,
      // asked when the walk ends: a list that confirmed the scope meanwhile counts
      { mark: READ_ONLY_PURGE_MARK, record: (scope) => useDMStore.getState().readOnlyConfirmed[scope] === true },
    );
    // the session that asked has ended: its store is gone, the next one's is not ours
    if (useAuthStore.getState().user?.id !== userId) return;
    const done = new Set(marked);
    const unmarked = scopes.filter((scope) => !done.has(scope));
    setPurgeStates(scopes.filter((scope) => done.has(scope)), 'done');
    setPurgeStates(unmarked, 'unmarked');
    if (removed > 0) console.debug(`[DM] Purged ${removed} cached entries of read-only conversations`);
    // confirmed by a list after the walk ended: the mark is still owed
    for (const scope of unmarked) {
      if (useDMStore.getState().readOnlyConfirmed[scope]) purgeReadOnlyConversation(scope);
    }
  } catch (err) {
    if (useAuthStore.getState().user?.id !== userId) return;
    setPurgeStates(scopes, null);
    if (isE2ESessionEnded(err)) {
      console.debug('[DM] The purge of read-only conversations ended with the session');
      return;
    }
    console.warn(
      '[DM] Could not purge the cached text of read-only conversations (tried again at the next list):',
      errorSummary(err),
    );
  }
}

/**
 * A failure as its name and message (an IndexedDB DOMException is not always
 * an Error instance): what a storage or vault error says, never the text the
 * purge was about (the predicate sees none).
 */
function errorSummary(err: unknown): string {
  if (err && typeof err === 'object') {
    const { name, message } = err as { name?: unknown; message?: unknown };
    const parts = [name, message].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(': ');
  }
  return 'unknown error';
}

/** How long a purge waits for the E2E service to finish starting before it leaves the work to the next list. */
export const PURGE_E2E_READY_WAIT_MS = 60_000;

/**
 * True once the E2E service of this session has started; false when its start
 * failed (at once when the store already holds the error) or did not end in time.
 */
function whenE2EReady(): Promise<boolean> {
  const initial = useE2EStore.getState();
  if (initial.ready) return Promise.resolve(true);
  if (initial.error) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, PURGE_E2E_READY_WAIT_MS);
    const unsubscribe = useE2EStore.subscribe((s) => {
      if (!s.ready && !s.error) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(s.ready);
    });
  });
}

function setPurgeStates(conversationIds: readonly string[], state: ReadOnlyPurgeState | null): void {
  if (conversationIds.length === 0) return;
  useDMStore.setState((s) => {
    const readOnlyPurges = { ...s.readOnlyPurges };
    for (const id of conversationIds) {
      if (state) readOnlyPurges[id] = state;
      else delete readOnlyPurges[id];
    }
    return { readOnlyPurges };
  });
}
