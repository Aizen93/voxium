import { create } from 'zustand';
import { api } from '../services/api';
import { getSocket } from '../services/socket';
import type { Message } from '@voxium/shared';

interface ChatState {
  messages: Message[];
  hasMore: boolean;
  isLoading: boolean;
  typingUsers: Map<string, string>; // userId -> username

  fetchMessages: (channelId: string, before?: string) => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (message: Message) => void;
  deleteMessage: (messageId: string) => void;
  clearMessages: () => void;
  setTypingUser: (userId: string, username: string) => void;
  removeTypingUser: (userId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  hasMore: false,
  isLoading: false,
  typingUsers: new Map(),

  fetchMessages: async (channelId: string, before?: string) => {
    set({ isLoading: true });
    try {
      const params = new URLSearchParams();
      if (before) params.set('before', before);

      const { data } = await api.get(`/channels/${channelId}/messages?${params}`);
      const newMessages = data.data;

      if (before) {
        // Prepend older messages
        set((state) => ({
          messages: [...newMessages, ...state.messages],
          hasMore: data.hasMore,
          isLoading: false,
        }));
      } else {
        set({ messages: newMessages, hasMore: data.hasMore, isLoading: false });
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      set({ isLoading: false });
    }
  },

  sendMessage: async (channelId: string, content: string) => {
    try {
      const { data } = await api.post(`/channels/${channelId}/messages`, { content });
      // The message will be added via WebSocket, but we also handle it here as fallback
      const exists = get().messages.some((m) => m.id === data.data.id);
      if (!exists) {
        set((state) => ({ messages: [...state.messages, data.data] }));
      }

      // Emit via WebSocket for real-time delivery to others
      const socket = getSocket();
      if (socket) {
        socket.emit('typing:stop', channelId);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      throw err;
    }
  },

  addMessage: (message: Message) => {
    set((state) => {
      if (state.messages.some((m) => m.id === message.id)) return state;
      return { messages: [...state.messages, message] };
    });
  },

  updateMessage: (message: Message) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === message.id ? message : m)),
    }));
  },

  deleteMessage: (messageId: string) => {
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== messageId),
    }));
  },

  clearMessages: () => {
    set({ messages: [], hasMore: false, typingUsers: new Map() });
  },

  setTypingUser: (userId: string, username: string) => {
    set((state) => {
      const newMap = new Map(state.typingUsers);
      newMap.set(userId, username);
      return { typingUsers: newMap };
    });

    // Auto-remove after 3 seconds
    setTimeout(() => {
      get().removeTypingUser(userId);
    }, 3000);
  },

  removeTypingUser: (userId: string) => {
    set((state) => {
      const newMap = new Map(state.typingUsers);
      newMap.delete(userId);
      return { typingUsers: newMap };
    });
  },
}));
