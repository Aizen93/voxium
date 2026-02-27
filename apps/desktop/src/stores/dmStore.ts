import { create } from 'zustand';
import { api } from '../services/api';
import { useChatStore } from './chatStore';
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
      set({ conversations: data.data, isLoading: false });
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      set({ isLoading: false });
    }
  },

  setActiveConversation: (conversationId: string) => {
    if (get().activeConversationId !== conversationId) {
      useChatStore.getState().clearMessages();
    }
    set({ activeConversationId: conversationId });
    get().clearDMUnread(conversationId);
    get().markConversationRead(conversationId);
  },

  clearActiveConversation: () => {
    if (get().activeConversationId) {
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
      const { [conversationId]: _, ...rest } = state.dmUnreadCounts;
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
    api.post(`/dm/${conversationId}/read`).catch(() => {});
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
      const { [conversationId]: _, ...restUnreads } = state.dmUnreadCounts;
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
