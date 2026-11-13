// A row the display gate could not open is tried again when its group session
// reaches this device, for the conversation or secure channel on screen, with
// no reopen: the service announces the sessions it stored
// (E2EService.onSessionsAvailable), the rows the view shows under them become
// due (undecryptedRows.ts), and each one the view still shows as "unable to
// decrypt" goes through the same gate as the first time. A row that now
// decrypts replaces the marker in place; one that still fails stays as it is.
// The quotes of it that found nothing in the local cache, and the
// conversation's preview of it, are then looked up in the cache again by the
// rules their own gating follows.
//
// Local only. A row is tried again only once its own session was announced,
// and the try (retry: true) never starts a key-share claim: a session no
// longer on the device leaves the row as it is. A failure of the vault during
// a try leaves the row held for the next announcement or change of the view.
// Nothing here acknowledges or deletes a key share. No sound, unread count or
// notification: those belong to a message's arrival.
//
// Imported by e2eStore alone; nothing chatStore imports reaches this module,
// so its static store imports form no cycle with resetStores.
import { e2eChannelScope, parseE2EScope } from '@voxium/shared';
import type { Message } from '@voxium/shared';
import { useChatStore } from '../../stores/chatStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { decryptMessageForDisplay, quotedTextFromCache, resolveEncryptedPreview } from './dmCrypto';
import { decryptChannelMessageForDisplay, quotedChannelTextFromCache } from './channelCrypto';
import { isRefusedShape } from './displayGate';
import type { E2ESessionsAvailable } from './e2eService';
import { currentE2ESessionUser } from './session';
import {
  hasDueRows,
  noteSessionsAvailable,
  retryLater,
  rowInScope,
  setViewScopeSource,
  syncWithView,
  takeDueRows,
  takeQuotesAwaiting,
} from './undecryptedRows';

type SessionsService = { onSessionsAvailable(listener: (event: E2ESessionsAvailable) => void): () => void };

/** The watch running: one per signed-in account, kept across a restart of that account's E2E start. */
let current: {
  userId: string;
  service: SessionsService;
  listener: (event: E2ESessionsAvailable) => void;
  unsubscribeService: () => void;
  stop: () => void;
} | null = null;
/** Advanced when a watch stops: a pass of a stopped watch applies nothing. */
let watchGeneration = 0;
/** The current watch's pass per scope, one at a time; `again` asks for exactly one more once it is done. */
const passes = new Map<string, { again: boolean }>();
/** Every pass not settled yet, a stopped watch's included (redecryptPassesSettled). */
const unsettled = new Set<Promise<void>>();

/**
 * The scope whose rows chatStore holds, by the rules MainLayout's handlers
 * follow: a channel only in the server view, a conversation only outside it.
 */
function scopeOnScreen(): string | null {
  const { activeServerId, activeChannelId } = useServerStore.getState();
  if (activeServerId) return activeChannelId ? e2eChannelScope(activeChannelId) : null;
  return useDMStore.getState().activeConversationId;
}

/** The same version by the same author: the row a held one was gated as. */
function sameVersion(a: Message, b: Message): boolean {
  return (a.editedAt ?? null) === (b.editedAt ?? null) && a.author?.id === b.author?.id;
}

const errorText = (err: unknown): unknown => (err instanceof Error ? err.message : err);

/**
 * Replace the marker of `heldRow` with what the gate opened, over that row
 * only while it still shows the marker for the same version: an edit, a
 * delete or a reload that landed meanwhile stands. The store's reactions and
 * author profile are kept; the held row's are as the server sent them then.
 */
function showOpened(heldRow: Message, opened: Message): boolean {
  let shown = false;
  useChatStore.setState((state) => {
    const index = state.messages.findIndex((m) => m.id === heldRow.id);
    if (index === -1) return state;
    const latest = state.messages[index];
    if (!isRefusedShape(latest) || !sameVersion(latest, heldRow)) return state;
    const messages = state.messages.slice();
    messages[index] = { ...opened, reactions: latest.reactions, author: latest.author };
    shown = true;
    return { messages };
  });
  return shown;
}

/**
 * Once `opened` shows its text: the rows whose quote of it found nothing in
 * the cache when they were gated, and the conversation's preview of it, are
 * looked up in the cache again, by the rules their gating follows (an entry
 * of this scope written by the author the quote or the preview names).
 */
async function refreshWhatShowsIt(scope: string, opened: Message, live: () => boolean): Promise<void> {
  const inChannel = parseE2EScope(scope).kind === 'channel';
  for (const [rowId, quotedAuthorId] of takeQuotesAwaiting(scope, opened.id)) {
    const waits = (m: Message | undefined): m is Message =>
      !!m && rowInScope(m, scope) && m.replyTo?.id === opened.id &&
      m.replyTo.author?.id === quotedAuthorId && !m.replyTo.content;
    const row = useChatStore.getState().messages.find((m) => m.id === rowId);
    if (!waits(row)) continue;
    let text: string | null;
    try {
      text = inChannel ? await quotedChannelTextFromCache(row) : await quotedTextFromCache(row);
    } catch (err) {
      if (!live()) return;
      console.warn(`e2e: the quote in message ${rowId} could not be read again:`, errorText(err));
      continue;
    }
    if (!live() || scopeOnScreen() !== scope) return;
    if (text === null) continue;
    useChatStore.setState((state) => {
      const index = state.messages.findIndex((m) => m.id === rowId);
      const latest = index === -1 ? undefined : state.messages[index];
      if (!waits(latest)) return state;
      const messages = state.messages.slice();
      messages[index] = { ...latest, replyTo: { ...latest.replyTo!, content: text } };
      return { messages };
    });
  }
  if (inChannel) return;
  const last = useDMStore.getState().conversations.find((c) => c.id === scope)?.lastMessage;
  if (!last || last.id !== opened.id || !last.encrypted || last.content) return;
  let preview: string | null;
  try {
    preview = await resolveEncryptedPreview(last.id, scope, last.authorId);
  } catch (err) {
    if (!live()) return;
    console.warn('e2e: a conversation preview could not be read again:', errorText(err));
    return;
  }
  if (preview === null || !live()) return;
  useDMStore.setState((state) => {
    let changed = false;
    const conversations = state.conversations.map((c) => {
      if (c.id !== scope || c.lastMessage?.id !== last.id || c.lastMessage.content) return c;
      changed = true;
      return { ...c, lastMessage: { ...c.lastMessage, content: preview } };
    });
    return changed ? { conversations } : state;
  });
}

/** One pass over the due rows of `scope` that the view shows, one at a time. */
async function retryDueRows(scope: string, live: () => boolean): Promise<void> {
  if (!live() || scopeOnScreen() !== scope) return;
  syncWithView(scope, useChatStore.getState().messages);
  const rows = takeDueRows(scope);
  const inChannel = parseE2EScope(scope).kind === 'channel';
  for (const heldRow of rows) {
    let opened: Message | null;
    try {
      opened = inChannel
        ? await decryptChannelMessageForDisplay(heldRow, { retry: true })
        : await decryptMessageForDisplay(heldRow, { retry: true });
    } catch (err) {
      if (!live()) return;
      console.warn(`e2e: message ${heldRow.id} could not be decrypted again:`, errorText(err));
      // an error, not an answer: tried again at the next announcement or view change
      retryLater(heldRow);
      continue;
    }
    // null: the E2E session ended during the decrypt. A logout, an account
    // switch or a view that moved on applies nothing of this pass
    if (!opened || !live() || scopeOnScreen() !== scope) return;
    // still closed: the row stays as it is (its new failure is held at the next view change)
    if (isRefusedShape(opened)) continue;
    if (showOpened(heldRow, opened)) await refreshWhatShowsIt(scope, opened, live);
  }
}

/** Run a pass for `scope`, or ask the one running for exactly one more. */
function schedulePass(scope: string, live: () => boolean): void {
  const running = passes.get(scope);
  if (running) {
    running.again = true;
    return;
  }
  const pass = { again: false };
  passes.set(scope, pass);
  const done = (async () => {
    try {
      do {
        pass.again = false;
        await retryDueRows(scope, live);
      } while (pass.again && live());
    } catch (err) {
      console.warn('e2e: trying undecrypted rows again stopped:', errorText(err));
    } finally {
      if (passes.get(scope) === pass) passes.delete(scope);
    }
  })();
  unsettled.add(done);
  void done.finally(() => unsettled.delete(done));
}

/**
 * Start trying undecrypted rows again for `userId`, whose E2E service is
 * `service`: on every announcement of stored sessions, and whenever the view
 * changes (a row can fail, its session be announced, and only then reach the
 * store). Subscribe before the service starts, so that what its start-up
 * stores is heard. For the account already watched it keeps that watch,
 * passes in flight included, and listens to `service` if it is another one.
 * Returns the stop, which e2eStore calls at logout; a pass still running
 * applies nothing after it.
 */
export function watchKeyArrivals(userId: string, service: SessionsService): () => void {
  if (current && current.userId === userId) {
    if (current.service !== service) {
      current.unsubscribeService();
      current.service = service;
      current.unsubscribeService = service.onSessionsAvailable(current.listener);
    }
    return current.stop;
  }
  current?.stop();
  const generation = watchGeneration;
  const live = (): boolean => {
    if (generation !== watchGeneration) return false;
    const signedIn = currentE2ESessionUser();
    return signedIn === undefined || signedIn === userId;
  };
  const listener = ({ scope, sessionIds }: E2ESessionsAvailable): void => {
    if (!live()) return;
    noteSessionsAvailable(scope, sessionIds);
    if (scope === scopeOnScreen() && hasDueRows(scope)) schedulePass(scope, live);
  };
  setViewScopeSource(scopeOnScreen);
  const unsubscribeStore = useChatStore.subscribe((state, previous) => {
    if (state.messages === previous.messages || !live()) return;
    const scope = scopeOnScreen();
    syncWithView(scope, state.messages);
    if (scope && hasDueRows(scope)) schedulePass(scope, live);
  });
  const watch = {
    userId,
    service,
    listener,
    unsubscribeService: service.onSessionsAvailable(listener),
    stop: (): void => {
      if (current !== watch) return;
      current = null;
      watch.unsubscribeService();
      unsubscribeStore();
      setViewScopeSource(null);
      watchGeneration += 1;
      passes.clear();
    },
  };
  current = watch;
  return watch.stop;
}

/** Settles once no pass is running, a stopped watch's included (tests). */
export async function redecryptPassesSettled(): Promise<void> {
  while (unsettled.size > 0) {
    await Promise.all([...unsettled]);
  }
}
