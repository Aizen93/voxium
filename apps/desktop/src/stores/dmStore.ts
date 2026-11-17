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

/** The purge of a read-only conversation's cache, this session (services/dmReadOnly.ts). */
export type ReadOnlyPurgeState = 'running' | 'done';

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
   * purged this session ('done') or is being purged ('running'); an attempt
   * that failed leaves no entry, so the next list fetch tries again.
   */
  readOnlyPurges: Record<string, ReadOnlyPurgeState>;
  /**
   * Conversations `dm:conversation:read_only` named before the list loaded
   * them: read-only from then on (the display gate reads it too), applied by
   * the next list that has them (reconcileReadOnly). Reset at logout.
   */
  readOnlyPending: Record<string, true>;

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
  deleteConversation: (conversationId: string) => Promise<void>;
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
  readOnlyPending: {},

  fetchConversations: async () => {
    set({ isLoading: true });
    let conversations: Conversation[];
    let transitions: ReadOnlyTransition[];
    let applied: string[];
    // Only the FETCH is allowed to say the fetch failed. Preview hydration used
    // to sit inside this try, so a local cache read that threw — routinely,
    // after the window was hidden and the browser closed the IndexedDB
    // connection — surfaced as "Failed to load conversations" over a list that
    // had loaded perfectly well and was already on screen.
    try {
      const { data } = await api.get('/dm');
      ({ conversations, transitions, applied } = reconcileReadOnly(
        (data.data as Conversation[]).map(withLockedPreview),
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
      return {
        conversations,
        participantStatuses: { ...state.participantStatuses, ...statuses },
        isLoading: false,
        readOnlyPending,
      };
    });

    // Read-only conversations (the other side's account was deleted): the ones
    // that turned so since the last list are brought into line (the view on
    // screen, a call, open popups), whether or not `dm:conversation:read_only`
    // reached this client, and every one has its cached text of the other
    // person purged once this session (services/dmReadOnly.ts). Never a list
    // fetch from there: this is the list fetch.
    const readOnlyIds = conversations.filter(isParticipantDeleted).map((c) => c.id);
    if (readOnlyIds.length > 0) {
      void import('../services/dmReadOnly')
        .then(({ applyReadOnlyConversations }) => applyReadOnlyConversations(transitions, readOnlyIds))
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
            // is written into it
            c.id === conv.id && c.lastMessage?.id === conv.lastMessage!.id
              && c.lastMessage.encrypted === true && c.lastMessage.type !== DELETED_MESSAGE_TYPE
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
    try {
      const { data } = await api.post('/dm', { userId });
      const conversation: Conversation = withLockedPreview(data.data);

      // Add to list if not already present
      set((state) => {
        if (state.conversations.some((c) => c.id === conversation.id)) return state;
        return { conversations: [conversation, ...state.conversations] };
      });

      return conversation.id;
    } catch (err) {
      console.error('Failed to open DM:', err);
      throw err;
    }
  },

  addConversation: (incoming: Conversation) => {
    const conversation = withLockedPreview(incoming);
    set((state) => {
      if (state.conversations.some((c) => c.id === conversation.id)) return state;
      return { conversations: [conversation, ...state.conversations] };
    });
  },


  updateLastMessage: (conversationId: string, message: NonNullable<Conversation['lastMessage']>) => {
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

  deleteConversation: async (conversationId: string) => {
    try {
      await api.delete(`/dm/${conversationId}`);
      get().handleConversationDeleted(conversationId);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      throw err;
    }
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
