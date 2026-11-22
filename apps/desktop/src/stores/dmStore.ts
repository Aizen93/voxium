import { create } from 'zustand';
import { api } from '../services/api';
import { useChatStore } from './chatStore';
import { toast } from './toastStore';
import i18n from '../i18n';
import { DELETED_MESSAGE_TYPE, isDeletedParticipantId, isDMSystemNotice } from '@voxium/shared';
import type { Conversation, DMUnreadCount, UserStatus } from '@voxium/shared';
import { deletedParticipantAuthor } from '../services/e2e/displayGate';
import { isParticipantDeleted, isHeldReadOnly } from '../utils/dmParticipant';
import { currentE2ESessionUser } from '../services/e2e/session';
import { clearedFloorOf, isAtOrBelowClearedFloor, parseServerTime } from '../services/e2e/clearedFloors';
import {
  applyClearedFloor,
  applyClearedList,
  applyConversationFloors,
  removalAnswerFloor,
  retryOwedClearedPurges,
  withoutClearedPreview,
} from '../services/dmClearedHistory';

/**
 * The purge of a read-only conversation's cache, this session
 * (services/dmReadOnly.ts): 'running', 'done' (purged and marked in the
 * vault), or 'unmarked' (purged on the event's word alone, so not marked: it
 * runs again once a list confirms the conversation).
 */
export type ReadOnlyPurgeState = 'running' | 'done' | 'unmarked';

/**
 * A conversation that turned read-only (the other side's account was deleted):
 * its id, and the participant id it had before, when this client knew a real
 * one (null when it was never seen otherwise in this session).
 */
export interface ReadOnlyTransition {
  conversationId: string;
  previousParticipantId: string | null;
}

interface DMState {
  conversations: Conversation[];
  activeConversationId: string | null;
  dmUnreadCounts: Record<string, number>;
  participantStatuses: Record<string, UserStatus>;
  isLoading: boolean;
  /**
   * Read-only conversations whose local cache of the other person's text was
   * purged this session ('done', or 'unmarked' before a list confirmed it) or
   * is being purged ('running'); an attempt that failed leaves no entry, so
   * the next list fetch tries again.
   */
  readOnlyPurges: Record<string, ReadOnlyPurgeState>;
  /**
   * Conversations a LIST of this session served read-only (`participantDeleted:
   * true`, or the placeholder participant), never one the event alone named:
   * only those get the vault's purge mark, which holds them read-only from
   * the start of every later session until a list of that session names
   * them. A list that serves one live removes it from here. Reset at logout.
   */
  readOnlyConfirmed: Record<string, true>;
  /**
   * Conversations `dm:conversation:read_only` named before the list loaded
   * them: read-only from then on (the display gate reads it too), applied by
   * the next list that has them (reconcileReadOnly). Reset at logout.
   */
  readOnlyPending: Record<string, true>;
  /**
   * Removals of this account applied this session, per conversation: the
   * value of `removalSeq` that each one took. A list whose request started
   * before it does not bring that conversation back (fetchConversations), nor
   * does a call set up before it join (voiceStore.joinDMCall); a later open
   * of the conversation or a new message in it forgets it (forgetRemoval).
   * Reset at logout.
   */
  removedAt: Record<string, number>;
  /** Counts the removals applied this session: a list fetch or a call setup takes it as its mark (wasRemovedSince). */
  removalSeq: number;
  /**
   * Conversations added to the store locally this session (an open or an add
   * of one it did not hold), per conversation: the value of `openSeq` that
   * each took. A list whose request started before it still shows the entry
   * when the list lacks it (withLocalOpens). Reset at logout.
   */
  openedAt: Record<string, number>;
  /** Counts the local opens this session: a list fetch takes it as its mark. */
  openSeq: number;

  fetchConversations: () => Promise<void>;
  setActiveConversation: (conversationId: string) => void;
  clearActiveConversation: () => void;
  openDM: (userId: string) => Promise<string>;
  addConversation: (conversation: Conversation) => void;
  updateLastMessage: (conversationId: string, message: NonNullable<Conversation['lastMessage']>) => void;
  incrementDMUnread: (conversationId: string) => void;
  clearDMUnread: (conversationId: string) => void;
  initDMUnreadCounts: (unreads: DMUnreadCount[]) => void;
  markConversationRead: (conversationId: string) => void;
  /**
   * Remove a conversation for this account only, its history cleared
   * (`DELETE /dm/:id?clearHistory=true`: what this client sends, always after
   * its confirmation). Rejects when the server refused or could not be
   * reached (nothing changed here then); resolves once the answer is applied
   * (applyConversationRemoval).
   */
  removeConversation: (conversationId: string) => Promise<void>;
  /**
   * A removal of this account's, from the answer or from
   * `dm:conversation:deleted` (every device of the remover): the floor it
   * carries applied first (services/dmClearedHistory.ts, also for a
   * conversation the store no longer holds), then the conversation dropped,
   * and a call of it on this device ended locally (the server ended it
   * already; nothing is emitted back). `askedBy`: the account that sent the
   * request whose answer this is (see applyClearedFloor).
   */
  applyConversationRemoval: (conversationId: string, clearedUntil: unknown, source: string, askedBy?: string | null) => void;
  /** The conversation came back (opened again, or a new message in it): no list or call setup counts its earlier removal against it any more. */
  forgetRemoval: (conversationId: string) => void;
  handleConversationDeleted: (conversationId: string) => void;
  totalDMUnread: () => number;
  updateParticipantStatus: (userId: string, status: UserStatus) => void;
  /**
   * The other side's account of this conversation was deleted
   * (`dm:conversation:read_only`): flips the loaded conversation to the
   * read-only state at once — the placeholder participant, the flag, a
   * preview the other person wrote replaced by "Message deleted" — before the
   * list is fetched again. Answers the transition (the participant id it had
   * before), or null for a conversation not loaded or already read-only.
   */
  markParticipantDeleted: (conversationId: string, localUserId: string | null) => ReadOnlyTransition | null;
  /**
   * The conversation on screen loaded again from the server (its rows replaced,
   * the composer's reply and the typing indicator cleared): only while it is
   * the active conversation, and the caller checks that the DM view (not a
   * server channel) is the one shown. dmStore owns the clear of the shared
   * chat store for DM transitions.
   */
  reloadConversationView: (conversationId: string) => void;
  /** Hold a conversation the list has not loaded read-only, for the next list (readOnlyPending). */
  notePendingReadOnly: (conversationId: string) => void;
}

/**
 * Whether the store holds `conversationId` read-only (utils/dmParticipant.ts):
 * a loaded read-only conversation, or one an event named before the list
 * loaded it.
 */
export function isConversationReadOnly(conversationId: string | null | undefined): boolean {
  return isHeldReadOnly(useDMStore.getState(), conversationId);
}

/**
 * Whether a removal of `conversationId` was applied after `mark` (a value of
 * `removalSeq` taken earlier) and not forgotten since (an open of it, a new
 * message in it).
 */
export function wasRemovedSince(conversationId: string, mark: number): boolean {
  return (useDMStore.getState().removedAt[conversationId] ?? -1) > mark;
}

// List requests take a ticket when they start; an answer older than a list
// already applied is dropped (the newer request began later, so it is the
// fresher). Monotonic, so a logout needs no reset.
let _listTicket = 0;
let _listAppliedTicket = 0;

/**
 * A list whose request began before a local open (openDM, addConversation:
 * an entry the store did not hold) does not lose that entry: each entry the
 * store holds that was added after `mark` (a value of openSeq) and that the
 * list lacks goes in front of the list's rows. A row the list has stands as
 * the list serves it (a conversation's answer to POST /dm carries no preview);
 * one the store no longer holds (a removal since) is not brought back.
 */
function withLocalOpens(
  conversations: Conversation[],
  mark: number,
  openedAt: Readonly<Record<string, number>>,
  held: readonly Conversation[],
): Conversation[] {
  const listed = new Set(conversations.map((c) => c.id));
  const added = held.filter((c) => (openedAt[c.id] ?? -1) > mark && !listed.has(c.id));
  return added.length === 0 ? conversations : [...added, ...conversations];
}

// Dedup: prevent redundant mark-as-read API calls (same pattern as serverStore)
let _lastMarkedConv = '';
let _lastMarkedConvAt = 0;

/**
 * An encrypted last message's text is the server's word until this client
 * decrypted it: the list shows only plaintext from the local cache (the
 * hydration below) or from the live decrypt path, never what GET /dm put in
 * `content` — an `encrypted: true` row with readable text is a forgery the
 * chat view's gate would refuse. Blanked here; dmPreviewText locks a blank.
 *
 * A deleted account's message (`type: DELETED_MESSAGE_TYPE`) shows the
 * localised "Message deleted" whatever it carries: its text is dropped here
 * too, and the row is marked unencrypted so no hydration asks the cache for it.
 */
function withLockedPreview(conversation: Conversation): Conversation {
  const last = conversation.lastMessage;
  if (last?.type === DELETED_MESSAGE_TYPE) {
    return last.content || last.encrypted ? { ...conversation, lastMessage: { ...last, content: '', encrypted: false } } : conversation;
  }
  return last?.encrypted && last.content ? { ...conversation, lastMessage: { ...last, content: '' } } : conversation;
}

/**
 * The conversations a server answer or a list carries, with their floors
 * applied first (services/dmClearedHistory.ts: nothing at or below one is
 * cached or shown from now on) and a preview at or below one dropped. Rows of
 * them the chat view still holds at or below their floor go as well (a view
 * loaded before the floor was known: the server serves none of them again).
 * `askedBy`: the account that sent the request, read before it (an answer
 * landing after a switch of account applies no floor).
 */
function withClearedFloors(conversations: Conversation[], askedBy: string | null | undefined): Conversation[] {
  applyConversationFloors(conversations, askedBy);
  dropClearedRows(conversations.filter((c) => c.clearedUntil !== undefined).map((c) => c.id));
  return conversations.map(withoutClearedPreview);
}

/**
 * A list whose request began before a removal does not bring the removed
 * conversation back. Left out of `conversations` (with its floors already
 * applied, withClearedFloors):
 *  - one whose removal was applied after the list request started (`mark`, a
 *    value of removalSeq), with or without a floor (a removal from a 2.1.x
 *    device of this account carries none), unless an open of it or a new
 *    message in it came since (forgetRemoval);
 *  - one whose floor known this session is higher than the floor the row
 *    carries (or it carries none) and that shows no message above it (its
 *    preview at or below the floor is gone already): a list computed before
 *    the floor was set, whichever way the floor reached this device.
 * One that legitimately came back stays: a newer message shows above the
 * floor, and a reopened one carries the floor this device knows.
 */
function withoutStaleRemovals(conversations: Conversation[], mark: number, removedAt: Readonly<Record<string, number>>): Conversation[] {
  const account = currentE2ESessionUser();
  return conversations.filter((c) => {
    if ((removedAt[c.id] ?? -1) > mark) return false;
    const known = clearedFloorOf(account, c.id);
    if (known === null || c.lastMessage) return true;
    const served = parseServerTime(c.clearedUntil);
    return served !== null && served >= known;
  });
}

/**
 * The rows of these conversations the chat view holds at or below their
 * floor, removed (server channel rows carry no conversation id and are never
 * touched). dmStore owns the chat store's DM transitions.
 */
function dropClearedRows(conversationIds: readonly string[]): void {
  if (conversationIds.length === 0) return;
  const account = currentE2ESessionUser();
  const chat = useChatStore.getState();
  for (const row of chat.messages ?? []) {
    if (row.conversationId && conversationIds.includes(row.conversationId)
      && isAtOrBelowClearedFloor(account, row.conversationId, row.createdAt)) {
      chat.deleteMessage(row.id);
    }
  }
}

/**
 * The conversation as the read-only state shows it: the placeholder participant
 * built here from the conversation id (never the server's strings), the flag,
 * and a last message that is neither this account's own nor a listed call
 * notice standing as deleted (the display gate's rule: the other person's
 * row, rewritten by the server or not yet). `localUserId` null (nobody known
 * to be signed in): no preview can be shown to be our own, so none is kept
 * but a call notice. Idempotent.
 */
function asReadOnly(conversation: Conversation, localUserId: string | null): Conversation {
  const participant = deletedParticipantAuthor(conversation.id);
  const last = conversation.lastMessage;
  const standsAsDeleted = !!last && (localUserId === null || last.authorId !== localUserId)
    && !(last.type === 'system' && !last.encrypted && isDMSystemNotice(last.content));
  return {
    ...conversation,
    participant,
    participantDeleted: true,
    lastMessage: standsAsDeleted && last
      ? { ...last, type: DELETED_MESSAGE_TYPE, content: '', encrypted: false, authorId: participant.id }
      : last,
  };
}

/**
 * The fetched list against what this session already knew. Every read-only
 * conversation (served so, flipped by the event, or named by an event before
 * it was loaded) goes through asReadOnly, so the event path and the list path
 * end in one state, a preview the server has not rewritten yet included. An
 * account deletion is final: a conversation seen read-only stays read-only
 * even when a list answered from before the deletion (a request already on
 * its way when the event came) still names the old participant. Answers the
 * list to store, the conversations that turned read-only with this fetch, and
 * the pending ids it applied.
 */
function reconcileReadOnly(
  fetched: Conversation[],
  known: Conversation[],
  pending: Readonly<Record<string, true>>,
  localUserId: string | null,
): { conversations: Conversation[]; transitions: ReadOnlyTransition[]; applied: string[] } {
  const before = new Map(known.map((c) => [c.id, c]));
  const transitions: ReadOnlyTransition[] = [];
  const applied: string[] = [];
  const conversations = fetched.map((conv) => {
    const prev = before.get(conv.id);
    const wasReadOnly = isParticipantDeleted(prev);
    const named = pending[conv.id] === true;
    const servedReadOnly = isParticipantDeleted(conv);
    if (!servedReadOnly && !wasReadOnly && !named) return conv;
    if (named) applied.push(conv.id);
    if (!wasReadOnly && (prev || named)) {
      // Seen with a real participant earlier this session, or named by an
      // event before the list had it: the transition (the event that said so
      // may have been missed). Neither: the first list of the session,
      // nothing on screen to bring into line.
      const previous = prev ? prev.participant : servedReadOnly ? null : conv.participant;
      transitions.push({ conversationId: conv.id, previousParticipantId: previous?.id ?? null });
    }
    // the local flip (or an earlier list) said read-only and this list does
    // not: its preview is kept (this list's may be from before the deletion)
    const source = wasReadOnly && !servedReadOnly && prev ? { ...conv, lastMessage: prev.lastMessage } : conv;
    return asReadOnly(source, localUserId);
  });
  return { conversations, transitions, applied };
}

export const useDMStore = create<DMState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  dmUnreadCounts: {},
  participantStatuses: {},
  isLoading: false,
  readOnlyPurges: {},
  readOnlyConfirmed: {},
  readOnlyPending: {},
  removedAt: {},
  removalSeq: 0,
  openedAt: {},
  openSeq: 0,

  fetchConversations: async () => {
    set({ isLoading: true });
    const ticket = ++_listTicket;
    // the local opens before the request: one after it is not undone by its answer
    const openMark = get().openSeq;
    // a purge of a cleared history that failed, or waited for the encryption
    // to start, is tried again at every list fetch (listed or not: a removed
    // conversation is off the list)
    retryOwedClearedPurges();
    // the account the list is fetched for (its floors are applied for it only)
    const askedBy = currentE2ESessionUser();
    // the removals applied before the request: one applied after it is not undone by its answer
    const removalMark = get().removalSeq;
    let clearedList: unknown;
    let conversations: Conversation[];
    let transitions: ReadOnlyTransition[];
    let applied: string[];
    let served: string[];
    let servedLive: string[];
    // Only the FETCH is allowed to say the fetch failed. Preview hydration used
    // to sit inside this try, so a local cache read that threw — routinely,
    // after the window was hidden and the browser closed the IndexedDB
    // connection — surfaced as "Failed to load conversations" over a list that
    // had loaded perfectly well and was already on screen.
    try {
      const { data } = await api.get('/dm');
      // the floors of this account's removed conversations, beside the list
      clearedList = (data as { cleared?: unknown }).cleared;
      const fetched = (data.data as Conversation[]).map(withLockedPreview);
      // what the list itself says, before this session's own knowledge joins it
      served = fetched.filter(isParticipantDeleted).map((c) => c.id);
      servedLive = fetched.filter((c) => !isParticipantDeleted(c)).map((c) => c.id);
      // the local opens joined in BEFORE the read-only reconciliation, so
      // the flags, the id set and the statuses below all follow the final list
      ({ conversations, transitions, applied } = reconcileReadOnly(
        withLocalOpens(fetched, openMark, get().openedAt, get().conversations),
        get().conversations,
        get().readOnlyPending,
        // the signed-in account, as the E2E layer reads it (no store import:
        // authStore imports this store's reset list)
        currentE2ESessionUser() ?? null,
      ));
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      toast.error(i18n.t('dm.failedToLoadConversations'));
      set({ isLoading: false });
      return;
    }

    // Another account is signed in now: this answer is not its to apply
    if ((currentE2ESessionUser() ?? null) !== (askedBy ?? null)) {
      if (ticket === _listTicket) set({ isLoading: false });
      return;
    }
    // An answer older than a list already applied is dropped: that list began
    // later and set isLoading itself.
    if (ticket < _listAppliedTicket) return;
    _listAppliedTicket = ticket;

    // The reader's floors, before anything of the list reaches the store:
    // those of the removed conversations it leaves out (`cleared`), then those
    // it carries (clearedUntil); applied outside the try above, which only the
    // fetch may fail. Then what a list begun before a removal must not bring
    // back is left out.
    applyClearedList(clearedList, askedBy);
    conversations = withoutStaleRemovals(withClearedFloors(conversations, askedBy), removalMark, get().removedAt);

    // Initialize participant statuses from the conversation data.
    //
    // GET /dm serves a presence `status` on each participant that the shared
    // `Conversation` type does not declare — a real contract gap, surfaced here
    // because this variable used to be implicitly `any`. Narrowed explicitly
    // rather than re-widened, so the mismatch stays visible instead of hiding
    // behind an untyped value.
    const statuses: Record<string, import('@voxium/shared').UserStatus> = {};
    for (const conv of conversations) {
      // a deleted account has no presence: its placeholder gets no status
      if (isParticipantDeleted(conv)) continue;
      const participant = conv.participant as
        | (typeof conv.participant & { status?: import('@voxium/shared').UserStatus })
        | undefined;
      if (participant?.status) {
        statuses[participant.id] = participant.status;
      }
    }

    set((state) => {
      // a pending id the list now holds is held by the conversation itself
      let readOnlyPending = state.readOnlyPending;
      if (applied.length > 0) {
        readOnlyPending = { ...state.readOnlyPending };
        for (const id of applied) delete readOnlyPending[id];
      }
      // The list's word both ways: one served read-only is confirmed, one served
      // live is not any more (a walk that ends now records no mark for it, and
      // a purge done this session runs again, marking, once a list confirms it)
      let readOnlyConfirmed = served.some((id) => !state.readOnlyConfirmed[id])
        ? { ...state.readOnlyConfirmed, ...Object.fromEntries(served.map((id) => [id, true as const])) }
        : state.readOnlyConfirmed;
      let readOnlyPurges = state.readOnlyPurges;
      const unconfirmed = servedLive.filter((id) => readOnlyConfirmed[id] || readOnlyPurges[id] === 'done');
      if (unconfirmed.length > 0) {
        readOnlyConfirmed = { ...readOnlyConfirmed };
        readOnlyPurges = { ...readOnlyPurges };
        for (const id of unconfirmed) {
          delete readOnlyConfirmed[id];
          if (readOnlyPurges[id] === 'done') readOnlyPurges[id] = 'unmarked';
        }
      }
      return {
        conversations,
        participantStatuses: { ...state.participantStatuses, ...statuses },
        isLoading: false,
        readOnlyPending,
        readOnlyConfirmed,
        readOnlyPurges,
      };
    });

    // Read-only conversations (the other side's account was deleted): the ones
    // that turned so since the last list are brought into line (the view on
    // screen, a call, open popups), whether or not `dm:conversation:read_only`
    // reached this client, and every one has its cached text of the other
    // person purged once this session (services/dmReadOnly.ts). Never a list
    // fetch from there: this is the list fetch.
    // A conversation the list serves live loses the purge mark an earlier
    // session (or this one) wrote for it: the device follows the list, and the
    // display gate gates it as live again (what was purged stays purged). One
    // the list does not name keeps its mark.
    const readOnlyIds = conversations.filter(isParticipantDeleted).map((c) => c.id);
    if (readOnlyIds.length > 0 || servedLive.length > 0) {
      void import('../services/dmReadOnly')
        .then(({ applyReadOnlyConversations, clearMarksOfLiveConversations }) => {
          clearMarksOfLiveConversations(servedLive);
          if (readOnlyIds.length > 0) applyReadOnlyConversations(transitions, readOnlyIds);
        })
        .catch((err) => {
          console.warn('dm: could not bring read-only conversations into line:', err instanceof Error ? err.message : err);
        });
    }

    // E2E previews arrive blanked (withLockedPreview) — hydrate them from the
    // local plaintext cache (async; the lock renders until this lands).
    //
    // Best-effort by design: a preview that will not resolve costs a lock icon,
    // not a conversation. Failures are logged and the loop continues, so one
    // unreadable entry cannot stop the rest from hydrating. A row the deleted
    // account's placeholder stands for is never looked up.
    const encrypted = conversations.filter((c) => c.lastMessage?.encrypted && !isDeletedParticipantId(c.lastMessage.authorId));
    if (encrypted.length === 0) return;
    try {
      const { resolveEncryptedPreview } = await import('../services/e2e/dmCrypto');
      for (const conv of encrypted) {
        let text: string | null;
        try {
          text = await resolveEncryptedPreview(conv.lastMessage!.id, conv.id, conv.lastMessage!.authorId);
        } catch (err) {
          console.warn(
            'dm: could not hydrate an encrypted preview:',
            err instanceof Error ? err.message : err
          );
          continue;
        }
        if (text === null) continue;
        set((state) => ({
          conversations: state.conversations.map((c) =>
            // only over the very row it read: still that encrypted message.
            // A conversation that turned read-only meanwhile has the other
            // person's preview standing as deleted (asReadOnly), and no text
            // is written into it; nor into a preview at or below a floor
            // learnt during the read
            c.id === conv.id && c.lastMessage?.id === conv.lastMessage!.id
              && c.lastMessage.encrypted === true && c.lastMessage.type !== DELETED_MESSAGE_TYPE
              && !isAtOrBelowClearedFloor(currentE2ESessionUser(), c.id, c.lastMessage.createdAt)
              ? { ...c, lastMessage: { ...c.lastMessage, content: text } }
              : c
          ),
        }));
      }
    } catch (err) {
      // The dynamic import itself failed (offline chunk fetch). Previews stay
      // locked; the conversation list is unaffected and stays on screen.
      console.warn(
        'dm: preview hydration unavailable:',
        err instanceof Error ? err.message : err
      );
    }
  },

  setActiveConversation: (conversationId: string) => {
    const prevConvId = get().activeConversationId;
    // Mark the previous conversation as read (captures messages received while viewing)
    if (prevConvId && prevConvId !== conversationId) {
      get().markConversationRead(prevConvId);
    }
    if (prevConvId !== conversationId) {
      useChatStore.getState().clearMessages();
    }
    set({ activeConversationId: conversationId });
    get().clearDMUnread(conversationId);
    get().markConversationRead(conversationId);
  },

  clearActiveConversation: () => {
    const prevConvId = get().activeConversationId;
    if (prevConvId) {
      // Mark as read before leaving (captures messages received while viewing)
      get().markConversationRead(prevConvId);
      useChatStore.getState().clearMessages();
    }
    set({ activeConversationId: null });
  },

  openDM: async (userId: string) => {
    // the deleted-account placeholder names nobody: no POST /dm for it
    if (isDeletedParticipantId(userId)) throw new Error('A deleted account cannot be messaged');
    const askedBy = currentE2ESessionUser();
    try {
      const { data } = await api.post('/dm', { userId });
      // reopened after a removal that cleared the history: its floor first
      const [conversation] = withClearedFloors([withLockedPreview(data.data)], askedBy);
      // opened again: its earlier removal no longer keeps a list from showing it
      get().forgetRemoval(conversation.id);

      // Add to list if not already present; a list begun before this open
      // keeps the entry (withLocalOpens)
      // (opening one the store holds adds nothing and records no mark)
      set((state) => {
        if (state.conversations.some((c) => c.id === conversation.id)) return state;
        return {
          openSeq: state.openSeq + 1,
          openedAt: { ...state.openedAt, [conversation.id]: state.openSeq + 1 },
          conversations: [conversation, ...state.conversations],
        };
      });

      return conversation.id;
    } catch (err) {
      console.error('Failed to open DM:', err);
      throw err;
    }
  },

  addConversation: (incoming: Conversation) => {
    const [conversation] = withClearedFloors([withLockedPreview(incoming)], currentE2ESessionUser());
    set((state) => {
      if (state.conversations.some((c) => c.id === conversation.id)) return state;
      return {
        openSeq: state.openSeq + 1,
        openedAt: { ...state.openedAt, [conversation.id]: state.openSeq + 1 },
        conversations: [conversation, ...state.conversations],
      };
    });
  },


  updateLastMessage: (conversationId: string, message: NonNullable<Conversation['lastMessage']>) => {
    // a row at or below a cleared floor is no preview (the gate shows none of them)
    if (isAtOrBelowClearedFloor(currentE2ESessionUser(), conversationId, message.createdAt)) return;
    // a new message in it: an earlier removal no longer keeps a list from showing it
    get().forgetRemoval(conversationId);
    set((state) => {
      const updated = state.conversations.map((c) =>
        c.id === conversationId ? { ...c, lastMessage: message } : c
      );
      // Re-sort by most recent activity
      updated.sort((a, b) => {
        const aTime = a.lastMessage?.createdAt || a.createdAt;
        const bTime = b.lastMessage?.createdAt || b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      return { conversations: updated };
    });
  },

  incrementDMUnread: (conversationId: string) => {
    set((state) => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [conversationId]: (state.dmUnreadCounts[conversationId] || 0) + 1,
      },
    }));
  },

  clearDMUnread: (conversationId: string) => {
    set((state) => {
      const rest = { ...state.dmUnreadCounts };
      delete rest[conversationId];
      return { dmUnreadCounts: rest };
    });
  },

  initDMUnreadCounts: (unreads: DMUnreadCount[]) => {
    const dmUnreadCounts: Record<string, number> = {};
    for (const u of unreads) {
      dmUnreadCounts[u.conversationId] = u.count;
    }
    set({ dmUnreadCounts });
  },

  markConversationRead: (conversationId: string) => {
    // Dedup: skip if same conversation was marked within the last 2s
    const now = Date.now();
    if (conversationId === _lastMarkedConv && now - _lastMarkedConvAt < 2000) return;
    _lastMarkedConv = conversationId;
    _lastMarkedConvAt = now;
    // Retry once on failure to prevent stale lastReadAt causing phantom unreads on reconnect
    const url = `/dm/${conversationId}/read`;
    api.post(url).catch(() => {
      setTimeout(() => api.post(url).catch((err) => { console.warn('[DM] Mark-read retry failed:', err); }), 2000);
    });
  },

  removeConversation: async (conversationId: string) => {
    // the account that removes it, read before the request
    const askedBy = currentE2ESessionUser();
    let answer: unknown;
    try {
      // always the confirmed removal: the 2.2.0 client asks first
      ({ data: answer } = await api.delete(`/dm/${conversationId}`, { params: { clearHistory: true } }));
    } catch (err) {
      console.error('Failed to remove conversation:', err);
      throw err;
    }
    // Signed out (and maybe someone else signed in) while the request ran:
    // nothing of the answer is the store's to apply now. The server did it;
    // the next session of that account learns the floor from its list.
    if (currentE2ESessionUser() !== askedBy) return;
    // the answer's floor (data.clearedUntil): this device purges even when
    // its socket misses the event
    get().applyConversationRemoval(conversationId, removalAnswerFloor(answer), 'removal answer', askedBy);
  },

  applyConversationRemoval: (conversationId: string, clearedUntil: unknown, source: string, askedBy?: string | null) => {
    // the floor FIRST, synchronously: from here on nothing at or below it is
    // cached or shown, a decrypt or a page already on its way included
    applyClearedFloor(conversationId, clearedUntil, source, askedBy);
    dropClearedRows([conversationId]);
    // the removal's mark, floor or none: a list already on its way, or a call
    // being set up, does not bring it back (withoutStaleRemovals, joinDMCall)
    set((state) => ({
      removalSeq: state.removalSeq + 1,
      removedAt: { ...state.removedAt, [conversationId]: state.removalSeq + 1 },
    }));
    get().handleConversationDeleted(conversationId);
    // A call of that conversation on this device: the server ended the
    // remover's call before it answered and announced (dm:voice:ended, which
    // a socket that was down meanwhile never got: the panel would stay up and
    // the reconnect would join the call again). Ended locally, nothing
    // emitted. A ring from the other person is left alone, as the server
    // leaves it.
    void import('./voiceStore')
      .then(({ useVoiceStore }) => {
        const voice = useVoiceStore.getState();
        if (voice.dmCallConversationId === conversationId) voice.handleDMCallEnded();
      })
      .catch((err: unknown) => {
        console.warn('[DM] Could not end the call of a removed conversation:', err instanceof Error ? err.message : err);
      });
  },

  forgetRemoval: (conversationId: string) => {
    if (get().removedAt[conversationId] === undefined) return;
    set((state) => {
      const removedAt = { ...state.removedAt };
      delete removedAt[conversationId];
      return { removedAt };
    });
  },

  handleConversationDeleted: (conversationId: string) => {
    set((state) => {
      const restUnreads = { ...state.dmUnreadCounts };
      delete restUnreads[conversationId];
      return {
        conversations: state.conversations.filter((c) => c.id !== conversationId),
        activeConversationId: state.activeConversationId === conversationId ? null : state.activeConversationId,
        dmUnreadCounts: restUnreads,
      };
    });
  },

  totalDMUnread: () => {
    const counts = get().dmUnreadCounts;
    return Object.values(counts).reduce((sum, c) => sum + c, 0);
  },

  updateParticipantStatus: (userId: string, status: UserStatus) => {
    set((state) => ({
      participantStatuses: { ...state.participantStatuses, [userId]: status },
    }));
  },

  markParticipantDeleted: (conversationId: string, localUserId: string | null) => {
    const conversation = get().conversations.find((c) => c.id === conversationId);
    if (!conversation || isParticipantDeleted(conversation)) return null;
    const previousParticipantId = conversation.participant?.id ?? null;
    set((state) => ({
      conversations: state.conversations.map((c) => (c.id === conversationId ? asReadOnly(c, localUserId) : c)),
    }));
    return { conversationId, previousParticipantId };
  },

  notePendingReadOnly: (conversationId: string) => {
    if (get().readOnlyPending[conversationId]) return;
    set((state) => ({ readOnlyPending: { ...state.readOnlyPending, [conversationId]: true } }));
  },

  reloadConversationView: (conversationId: string) => {
    // the caller checks the DM view is the one shown (a server channel on
    // screen keeps activeConversationId behind it, and the chat store is shared)
    if (get().activeConversationId !== conversationId) return;
    const chat = useChatStore.getState();
    chat.clearMessages();
    void chat.fetchDMMessages(conversationId);
  },
}));
