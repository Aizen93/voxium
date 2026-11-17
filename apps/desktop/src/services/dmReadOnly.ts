import { isDeletedParticipantId } from '@voxium/shared';
import { useDMStore, type ReadOnlyTransition } from '../stores/dmStore';
import { useServerStore } from '../stores/serverStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useE2EStore } from '../stores/e2eStore';
import { closeProfilePopupsOf } from '../utils/profilePopupBus';
import { getE2EService } from './e2e/e2eService';
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
 * `dm:conversation:read_only`: a conversation this client does not hold is
 * ignored (the next list brings it in, read-only, and purges it then).
 * Otherwise the conversation flips to the read-only state at once (so the
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
  if (!dm.conversations.some((c) => c.id === conversationId)) return;
  const localUserId = useAuthStore.getState().user?.id ?? null;
  const transition = dm.markParticipantDeleted(conversationId, localUserId);
  // already read-only (a list said so first): only the once-per-session purge is left
  if (transition) bringIntoLine(transition);
  purgeReadOnlyConversation(conversationId);
  if (transition) void useDMStore.getState().fetchConversations();
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

/**
 * Drop this device's decrypted text of a read-only conversation that this
 * account did not write (E2EService.purgeCachedPlaintexts, on the service's
 * queue), keeping every entry it wrote: its own messages still display, from
 * the cache or its own outbound session. An entry that does not say who wrote
 * it (written before authors were recorded) cannot be shown to be this
 * account's own and goes too. Once per conversation per session: a purge
 * running or done is not started again, one that failed is (the next list
 * fetch asks again). A failure is logged, never the text, and never stops
 * anything on screen.
 */
export function purgeReadOnlyConversation(conversationId: string): void {
  if (useDMStore.getState().readOnlyPurges[conversationId]) return;
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;
  setPurgeState(conversationId, 'running');
  void (async () => {
    try {
      // After the service's own start, never beside it: the start opens the
      // vault (and on a new device creates its key), which a purge must not
      // race. A start that failed leaves the purge for the next list.
      if (!(await whenE2EReady())) {
        if (useAuthStore.getState().user?.id === userId) setPurgeState(conversationId, null);
        console.debug('[DM] The purge of a read-only conversation waits for the encryption to start');
        return;
      }
      if (useAuthStore.getState().user?.id !== userId) return;
      const removed = await getE2EService(userId).purgeCachedPlaintexts(
        conversationId,
        (entry) => entry.authorId !== userId,
      );
      // the session that asked has ended: its store is gone, the next one's is not ours
      if (useAuthStore.getState().user?.id !== userId) return;
      setPurgeState(conversationId, 'done');
      if (removed > 0) console.debug(`[DM] Purged ${removed} cached entries of a read-only conversation`);
    } catch (err) {
      if (useAuthStore.getState().user?.id !== userId) return;
      setPurgeState(conversationId, null);
      if (isE2ESessionEnded(err)) {
        console.debug('[DM] The purge of a read-only conversation ended with the session');
        return;
      }
      console.warn(
        '[DM] Could not purge the cached text of a read-only conversation (tried again at the next list):',
        errorSummary(err),
      );
    }
  })();
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

/** True once the E2E service of this session has started; false when its start failed or did not end in time. */
function whenE2EReady(): Promise<boolean> {
  const initial = useE2EStore.getState();
  if (initial.ready) return Promise.resolve(true);
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

function setPurgeState(conversationId: string, state: 'running' | 'done' | null): void {
  useDMStore.setState((s) => {
    const readOnlyPurges = { ...s.readOnlyPurges };
    if (state) readOnlyPurges[conversationId] = state;
    else delete readOnlyPurges[conversationId];
    return { readOnlyPurges };
  });
}
