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
  updateLastMessage: (conversationId: string, message: { content: string; createdAt: string; authorId: string }) => void;
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
    try {
      const { data } = await api.get('/dm');
      const conversations = data.data;

      // Initialize participant statuses from the conversation data
      const statuses: Record<string, import('@voxium/shared').UserStatus> = {};
      for (const conv of conversations) {
        if (conv.participant?.status) {
          statuses[conv.participant.id] = conv.participant.status;
        }
      }

      set((state) => ({
        conversations,
        participantStatuses: { ...state.participantStatuses, ...statuses },
        isLoading: false,
      }));
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      toast.error('Failed to load conversations');
      set({ isLoading: false });
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

  updateLastMessage: (conversationId: string, message: { content: string; createdAt: string; authorId: string }) => {
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
      setTimeout(() => api.post(url).catch(() => {}), 2000);
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
