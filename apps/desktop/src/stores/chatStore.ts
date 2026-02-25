import { create } from 'zustand';
import { api } from '../services/api';
import { getSocket } from '../services/socket';
import type { Message } from '@voxium/shared';

// Track typing timers per user to prevent leaks
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track current fetch to prevent duplicate requests
let activeFetchController: AbortController | null = null;
let lastFetchKey = '';

interface ChatState {
  messages: Message[];
  hasMore: boolean;
  isLoading: boolean;
  typingUsers: Map<string, string>; // userId -> username

  fetchMessages: (channelId: string, before?: string) => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteMessage: (channelId: string, messageId: string) => Promise<void>;
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
    // Deduplicate: skip if same request is already in-flight
    const fetchKey = `${channelId}:${before || 'initial'}`;
    if (fetchKey === lastFetchKey && get().isLoading) return;

    // Abort any previous pending fetch (e.g. rapid channel switching)
    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = fetchKey;

    set({ isLoading: true });
    try {
      const params = new URLSearchParams();
      if (before) params.set('before', before);

      const { data } = await api.get(`/channels/${channelId}/messages?${params}`, {
        signal: controller.signal,
      });
      const newMessages = data.data;

      // Check if this fetch is still relevant (channel may have changed)
      if (controller.signal.aborted) return;

      if (before) {
        // Prepend older messages, dedup by ID
        set((state) => {
          const existingIds = new Set(state.messages.map((m) => m.id));
          const uniqueNew = newMessages.filter((m: Message) => !existingIds.has(m.id));
          return {
            messages: [...uniqueNew, ...state.messages],
            hasMore: data.hasMore,
            isLoading: false,
          };
        });
      } else {
        set({ messages: newMessages, hasMore: data.hasMore, isLoading: false });
      }
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      console.error('Failed to fetch messages:', err);
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
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

      const socket = getSocket();
      if (socket) {
        socket.emit('typing:stop', channelId);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      throw err;
    }
  },

  editMessage: async (channelId: string, messageId: string, content: string) => {
    await api.patch(`/channels/${channelId}/messages/${messageId}`, { content });
  },

  requestDeleteMessage: async (channelId: string, messageId: string) => {
    await api.delete(`/channels/${channelId}/messages/${messageId}`);
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
    // Abort any in-flight fetch when switching channels
    if (activeFetchController) {
      activeFetchController.abort();
      activeFetchController = null;
    }
    lastFetchKey = '';

    // Clear all typing timers
    typingTimers.forEach((timer) => clearTimeout(timer));
    typingTimers.clear();

    set({ messages: [], hasMore: false, isLoading: false, typingUsers: new Map() });
  },

  setTypingUser: (userId: string, username: string) => {
    // Clear existing timer for this user to prevent accumulation
    const existingTimer = typingTimers.get(userId);
    if (existingTimer) clearTimeout(existingTimer);

    set((state) => {
      const newMap = new Map(state.typingUsers);
      newMap.set(userId, username);
      return { typingUsers: newMap };
    });

    // Auto-remove after 3 seconds
    const timer = setTimeout(() => {
      typingTimers.delete(userId);
      get().removeTypingUser(userId);
    }, 3000);
    typingTimers.set(userId, timer);
  },

  removeTypingUser: (userId: string) => {
    // Clear the timer if it exists
    const timer = typingTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      typingTimers.delete(userId);
    }

    set((state) => {
      if (!state.typingUsers.has(userId)) return state;
      const newMap = new Map(state.typingUsers);
      newMap.delete(userId);
      return { typingUsers: newMap };
    });
  },
}));
