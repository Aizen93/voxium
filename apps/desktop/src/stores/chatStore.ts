import { create } from 'zustand';
import axios from 'axios';
import { api } from '../services/api';
import { getSocket } from '../services/socket';
import { toast } from './toastStore';
import type { Message, Attachment, ReactionGroup } from '@voxium/shared';

// Track typing timers per user to prevent leaks
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track current fetch to prevent duplicate requests
let activeFetchController: AbortController | null = null;
let lastFetchKey = '';

interface ChatState {
  messages: Message[];
  hasMore: boolean;
  hasMoreAfter: boolean;
  isLoading: boolean;
  typingUsers: Map<string, string>; // userId -> username
  replyingTo: Message | null;
  targetMessageId: string | null;

  setReplyingTo: (message: Message | null) => void;
  clearReplyingTo: () => void;
  fetchMessages: (channelId: string, before?: string) => Promise<void>;
  fetchMessagesAround: (channelId: string, messageId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, attachments?: Omit<Attachment, 'id' | 'expired'>[]) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteMessage: (channelId: string, messageId: string) => Promise<void>;
  toggleReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>;
  fetchDMMessages: (conversationId: string, before?: string) => Promise<void>;
  fetchDMMessagesAround: (conversationId: string, messageId: string) => Promise<void>;
  sendDMMessage: (conversationId: string, content: string, attachments?: Omit<Attachment, 'id' | 'expired'>[]) => Promise<void>;
  editDMMessage: (conversationId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteDMMessage: (conversationId: string, messageId: string) => Promise<void>;
  toggleDMReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (message: Message) => void;
  updateMessageReactions: (messageId: string, reactions: ReactionGroup[]) => void;
  deleteMessage: (messageId: string) => void;
  clearMessages: () => void;
  clearTargetMessage: () => void;
  setTypingUser: (userId: string, username: string) => void;
  removeTypingUser: (userId: string) => void;
  updateAuthorAvatar: (userId: string, avatarUrl: string | null) => void;
  updateAuthorProfile: (userId: string, fields: Record<string, unknown>) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  hasMore: false,
  hasMoreAfter: false,
  isLoading: false,
  typingUsers: new Map(),
  replyingTo: null,
  targetMessageId: null,

  setReplyingTo: (message) => set({ replyingTo: message }),
  clearReplyingTo: () => set({ replyingTo: null }),

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
        set({ messages: newMessages, hasMore: data.hasMore, hasMoreAfter: false, isLoading: false });
      }
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch messages:', err);
      toast.error('Failed to load messages');
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  fetchMessagesAround: async (channelId: string, messageId: string) => {
    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = `${channelId}:around:${messageId}`;

    set({ isLoading: true });
    try {
      const { data } = await api.get(`/channels/${channelId}/messages?around=${messageId}`, {
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      set({
        messages: data.data,
        hasMore: data.hasMore,
        hasMoreAfter: data.hasMoreAfter ?? false,
        targetMessageId: data.targetMessageId ?? messageId,
        isLoading: false,
      });
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch messages around:', err);
      toast.error('Failed to load messages');
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  sendMessage: async (channelId: string, content: string, attachments?: Omit<Attachment, 'id' | 'expired'>[]) => {
    try {
      const replyingTo = get().replyingTo;
      const body: Record<string, unknown> = { content };
      if (replyingTo) body.replyToId = replyingTo.id;
      if (attachments?.length) body.attachments = attachments;

      const { data } = await api.post(`/channels/${channelId}/messages`, body);
      // The message will be added via WebSocket, but we also handle it here as fallback
      const exists = get().messages.some((m) => m.id === data.data.id);
      if (!exists) {
        set((state) => ({ messages: [...state.messages, data.data] }));
      }

      if (replyingTo) set({ replyingTo: null });

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

  toggleReaction: async (channelId: string, messageId: string, emoji: string) => {
    try {
      await api.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
      throw err;
    }
  },

  fetchDMMessages: async (conversationId: string, before?: string) => {
    const fetchKey = `dm:${conversationId}:${before || 'initial'}`;
    if (fetchKey === lastFetchKey && get().isLoading) return;

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

      const { data } = await api.get(`/dm/${conversationId}/messages?${params}`, {
        signal: controller.signal,
      });
      const newMessages = data.data;

      if (controller.signal.aborted) return;

      if (before) {
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
        set({ messages: newMessages, hasMore: data.hasMore, hasMoreAfter: false, isLoading: false });
      }
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch DM messages:', err);
      toast.error('Failed to load messages');
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  fetchDMMessagesAround: async (conversationId: string, messageId: string) => {
    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = `dm:${conversationId}:around:${messageId}`;

    set({ isLoading: true });
    try {
      const { data } = await api.get(`/dm/${conversationId}/messages?around=${messageId}`, {
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      set({
        messages: data.data,
        hasMore: data.hasMore,
        hasMoreAfter: data.hasMoreAfter ?? false,
        targetMessageId: data.targetMessageId ?? messageId,
        isLoading: false,
      });
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch DM messages around:', err);
      toast.error('Failed to load messages');
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  sendDMMessage: async (conversationId: string, content: string, attachments?: Omit<Attachment, 'id' | 'expired'>[]) => {
    try {
      const replyingTo = get().replyingTo;
      const body: Record<string, unknown> = { content };
      if (replyingTo) body.replyToId = replyingTo.id;
      if (attachments?.length) body.attachments = attachments;

      const { data } = await api.post(`/dm/${conversationId}/messages`, body);
      const exists = get().messages.some((m) => m.id === data.data.id);
      if (!exists) {
        set((state) => ({ messages: [...state.messages, data.data] }));
      }

      if (replyingTo) set({ replyingTo: null });

      const socket = getSocket();
      if (socket) {
        socket.emit('dm:typing:stop', conversationId);
      }
    } catch (err) {
      console.error('Failed to send DM:', err);
      throw err;
    }
  },

  editDMMessage: async (conversationId: string, messageId: string, content: string) => {
    await api.patch(`/dm/${conversationId}/messages/${messageId}`, { content });
  },

  requestDeleteDMMessage: async (conversationId: string, messageId: string) => {
    await api.delete(`/dm/${conversationId}/messages/${messageId}`);
  },

  toggleDMReaction: async (conversationId: string, messageId: string, emoji: string) => {
    try {
      await api.put(`/dm/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    } catch (err) {
      console.error('Failed to toggle DM reaction:', err);
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

  updateMessageReactions: (messageId: string, reactions: ReactionGroup[]) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, reactions } : m
      ),
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

    set({ messages: [], hasMore: false, hasMoreAfter: false, isLoading: false, typingUsers: new Map(), replyingTo: null, targetMessageId: null });
  },

  clearTargetMessage: () => set({ targetMessageId: null }),

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

  updateAuthorAvatar: (userId: string, avatarUrl: string | null) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.author.id === userId ? { ...m, author: { ...m.author, avatarUrl } } : m
      ),
    }));
  },

  updateAuthorProfile: (userId: string, fields: Record<string, unknown>) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.author.id === userId ? { ...m, author: { ...m.author, ...fields } } : m
      ),
    }));
  },
}));
