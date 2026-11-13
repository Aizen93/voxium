// A row the display gate could not open is tried again when its group session
// reaches this device, for the conversation or secure channel on screen, with
// no reopen: the service announces the sessions it stored
// (E2EService.onSessionsAvailable), the rows held under them become due
// (undecryptedRows.ts), and each one the view still shows as "unable to
// decrypt" goes through the same gate as the first time. A row that now
// decrypts replaces the marker in place; one that still fails stays as it is.
//
// Local only. A row is tried again only once its own session was announced,
// so the decrypt finds that session on the device and asks the server
// nothing, and nothing here acknowledges or deletes a key share. No sound,
// unread count or notification: those belong to a message's arrival.
//
// Imported by e2eStore alone; nothing chatStore imports reaches this module,
// so its static store imports form no cycle with resetStores.
import { e2eChannelScope, parseE2EScope } from '@voxium/shared';
import type { Message } from '@voxium/shared';
import { useChatStore } from '../../stores/chatStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { decryptMessageForDisplay } from './dmCrypto';
import { decryptChannelMessageForDisplay } from './channelCrypto';
import { isRefusedShape } from './displayGate';
import type { E2ESessionsAvailable } from './e2eService';
import { currentE2ESessionUser } from './session';
import { hasDueRows, noteSessionsAvailable, takeDueRows } from './undecryptedRows';

/** Advanced by every watch that starts or stops: a pass of an earlier watch applies nothing. */
let watchGeneration = 0;
/** The watch running, stopped before another starts. */
let stopCurrentWatch: (() => void) | null = null;
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

function scopeOfRow(message: Message): string | null {
  if (message.channelId) return e2eChannelScope(message.channelId);
  return message.conversationId ?? null;
}

/** The same version by the same author: the row a held one was gated as. */
function sameVersion(a: Message, b: Message): boolean {
  return (a.editedAt ?? null) === (b.editedAt ?? null) && a.author?.id === b.author?.id;
}

/**
 * Replace the marker of `heldRow` with what the gate opened, over that row
 * only while it still shows the marker for the same version: an edit, a
 * delete or a reload that landed meanwhile stands. The store's reactions and
 * author profile are kept; the held row's are as the server sent them then.
 */
function showOpened(heldRow: Message, opened: Message): void {
  useChatStore.setState((state) => {
    const index = state.messages.findIndex((m) => m.id === heldRow.id);
    if (index === -1) return state;
    const latest = state.messages[index];
    if (!isRefusedShape(latest) || !sameVersion(latest, heldRow)) return state;
    const messages = state.messages.slice();
    messages[index] = { ...opened, reactions: latest.reactions, author: latest.author };
    return { messages };
  });
}

/** One pass over the due rows of `scope` that the view holds, one at a time. */
async function retryDueRows(scope: string, live: () => boolean): Promise<void> {
  if (!live() || scopeOnScreen() !== scope || !hasDueRows(scope)) return;
  const shown = new Map<string, Message>();
  for (const message of useChatStore.getState().messages) {
    if (scopeOfRow(message) === scope && isRefusedShape(message)) shown.set(message.id, message);
  }
  // A held version the view does not show yet (an edit still on its way to
  // the store) stays due, for when the view changes to it
  const rows = takeDueRows(scope, (heldRow) => {
    const current = shown.get(heldRow.id);
    return current !== undefined && sameVersion(current, heldRow);
  });
  const inChannel = parseE2EScope(scope).kind === 'channel';
  for (const heldRow of rows) {
    let opened: Message | null;
    try {
      opened = inChannel ? await decryptChannelMessageForDisplay(heldRow) : await decryptMessageForDisplay(heldRow);
    } catch (err) {
      if (!live()) return;
      console.warn(`e2e: message ${heldRow.id} could not be decrypted again:`, err instanceof Error ? err.message : err);
      continue;
    }
    // null: the E2E session ended during the decrypt. A logout, an account
    // switch or a view that moved on applies nothing of this pass
    if (!opened || !live() || scopeOnScreen() !== scope) return;
    // still closed: the row stays as it is, and the gate holds it again
    if (isRefusedShape(opened)) continue;
    showOpened(heldRow, opened);
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
      console.warn('e2e: trying undecrypted rows again stopped:', err instanceof Error ? err.message : err);
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
 * changes while a row it shows is due (a row can fail, its session be
 * announced, and only then reach the store). Subscribe before the service
 * starts, so that what its start-up stores is heard. Returns the stop, which
 * e2eStore calls at logout; a pass still running applies nothing after it.
 */
export function watchKeyArrivals(
  userId: string,
  service: { onSessionsAvailable(listener: (event: E2ESessionsAvailable) => void): () => void },
): () => void {
  stopCurrentWatch?.();
  const generation = ++watchGeneration;
  const live = (): boolean => {
    if (generation !== watchGeneration) return false;
    const signedIn = currentE2ESessionUser();
    return signedIn === undefined || signedIn === userId;
  };
  const unsubscribeService = service.onSessionsAvailable(({ scope, sessionIds }) => {
    if (!live()) return;
    noteSessionsAvailable(scope, sessionIds);
    if (scope === scopeOnScreen() && hasDueRows(scope)) schedulePass(scope, live);
  });
  const unsubscribeStore = useChatStore.subscribe((state, previous) => {
    if (state.messages === previous.messages || !live()) return;
    const scope = scopeOnScreen();
    if (scope && hasDueRows(scope)) schedulePass(scope, live);
  });
  const stop = (): void => {
    unsubscribeService();
    unsubscribeStore();
    if (stopCurrentWatch !== stop) return;
    stopCurrentWatch = null;
    watchGeneration += 1;
    passes.clear();
  };
  stopCurrentWatch = stop;
  return stop;
}

/** Settles once no pass is running, a stopped watch's included (tests). */
export async function redecryptPassesSettled(): Promise<void> {
  while (unsettled.size > 0) {
    await Promise.all([...unsettled]);
  }
}
