import { create } from 'zustand';
import { api } from '../services/api';
import { useChatStore } from './chatStore';
import { toast } from './toastStore';
import type { Conversation, DMUnreadCount, UserStatus } from '@voxium/shared';

interface DMState {
  conversations: Conversation[];
  activeConversationId: string | null;
  dmUnreadCounts: Record<string, number>;
  participantStatuses: Record<string, UserStatus>;
  isLoading: boolean;

  fetchConversations: () => Promise<void>;
  setActiveConversation: (conversationId: string) => void;
  clearActiveConversation: () => void;
  openDM: (userId: string) => Promise<string>;
  addConversation: (conversation: Conversation) => void;
  updateLastMessage: (conversationId: string, message: { id: string; content: string; encrypted?: boolean; createdAt: string; authorId: string }) => void;
  incrementDMUnread: (conversationId: string) => void;
  clearDMUnread: (conversationId: string) => void;
  initDMUnreadCounts: (unreads: DMUnreadCount[]) => void;
  markConversationRead: (conversationId: string) => void;
  deleteConversation: (conversationId: string) => Promise<void>;
  handleConversationDeleted: (conversationId: string) => void;
  totalDMUnread: () => number;
  updateParticipantStatus: (userId: string, status: UserStatus) => void;
}

// Dedup: prevent redundant mark-as-read API calls (same pattern as serverStore)
let _lastMarkedConv = '';
let _lastMarkedConvAt = 0;

export const useDMStore = create<DMState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  dmUnreadCounts: {},
  participantStatuses: {},
  isLoading: false,

  fetchConversations: async () => {
    set({ isLoading: true });
    let conversations: Conversation[];
    // Only the FETCH is allowed to say the fetch failed. Preview hydration used
    // to sit inside this try, so a local cache read that threw — routinely,
    // after the window was hidden and the browser closed the IndexedDB
    // connection — surfaced as "Failed to load conversations" over a list that
    // had loaded perfectly well and was already on screen.
    try {
      const { data } = await api.get('/dm');
      conversations = data.data;
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      toast.error('Failed to load conversations');
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
      const participant = conv.participant as
        | (typeof conv.participant & { status?: import('@voxium/shared').UserStatus })
        | undefined;
      if (participant?.status) {
        statuses[participant.id] = participant.status;
      }
    }

    set((state) => ({
      conversations,
      participantStatuses: { ...state.participantStatuses, ...statuses },
      isLoading: false,
    }));

    // E2E previews arrive as ciphertext — hydrate them from the local
    // plaintext cache (async; placeholders render until this lands).
    //
    // Best-effort by design: a preview that will not resolve costs a lock icon,
    // not a conversation. Failures are logged and the loop continues, so one
    // unreadable entry cannot stop the rest from hydrating.
    const encrypted = conversations.filter((c) => c.lastMessage?.encrypted);
    if (encrypted.length === 0) return;
    try {
      const { resolveEncryptedPreview } = await import('../services/e2e/dmCrypto');
      for (const conv of encrypted) {
        let text: string | null;
        try {
          text = await resolveEncryptedPreview(conv.lastMessage!.id);
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
            c.id === conv.id && c.lastMessage?.id === conv.lastMessage!.id
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
    try {
      const { data } = await api.post('/dm', { userId });
      const conversation: Conversation = data.data;

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

  addConversation: (conversation: Conversation) => {
    set((state) => {
      if (state.conversations.some((c) => c.id === conversation.id)) return state;
      return { conversations: [conversation, ...state.conversations] };
    });
  },


  updateLastMessage: (conversationId: string, message: { id: string; content: string; encrypted?: boolean; createdAt: string; authorId: string }) => {
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
}));
