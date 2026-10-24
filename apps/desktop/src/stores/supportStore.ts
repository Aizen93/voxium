import { create } from 'zustand';
import { api } from '../services/api';
import type { SupportTicketStatus, SupportMessageData } from '@voxium/shared';
import axios from 'axios';
import i18n from '../i18n';
import { translateServerError } from '../utils/serverErrors';

interface SupportTicketLocal {
  id: string;
  status: SupportTicketStatus;
  claimedById: string | null;
  claimedByUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SupportState {
  ticket: SupportTicketLocal | null;
  messages: SupportMessageData[];
  isLoading: boolean;
  showSupportView: boolean;

  openTicket: () => Promise<void>;
  fetchTicket: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  setShowSupportView: (show: boolean) => void;
  addMessage: (message: SupportMessageData) => void;
  updateStatus: (status: SupportTicketStatus, claimedById?: string, claimedByUsername?: string) => void;
}

export const useSupportStore = create<SupportState>((set, get) => ({
  ticket: null,
  messages: [],
  isLoading: false,
  showSupportView: false,

  openTicket: async () => {
    set({ isLoading: true });
    try {
      const { data } = await api.post('/support/open');
      const t = data.data.ticket;
      set({
        ticket: { ...t, claimedById: t.claimedById ?? null, claimedByUsername: t.claimedByUsername ?? null },
        messages: data.data.messages,
        showSupportView: true,
        isLoading: false,
      });
    } catch (err) {
      set({ isLoading: false });
      // The server's answer in the user's language (mapped), else the generic failure
      const msg = axios.isAxiosError(err)
        ? translateServerError(err.response?.data?.error, i18n.t, 'dm.failedToOpenTicket')
        : i18n.t('dm.failedToOpenTicket');
      throw new Error(msg, { cause: err });
    }
  },

  fetchTicket: async () => {
    try {
      const { data } = await api.get('/support/ticket');
      if (data.data.ticket) {
        const t = data.data.ticket;
        set({
          ticket: { ...t, claimedById: t.claimedById ?? null, claimedByUsername: t.claimedByUsername ?? null },
          messages: data.data.messages,
        });
      }
    } catch {
      // Non-critical
    }
  },

  sendMessage: async (content: string) => {
    const ticket = get().ticket;
    if (!ticket) return;
    await api.post('/support/messages', { content });
    // Message will arrive via socket event
  },

  setShowSupportView: (show) => set({ showSupportView: show }),

  addMessage: (message) => {
    const { messages } = get();
    // Deduplicate
    if (messages.some((m) => m.id === message.id)) return;
    set({ messages: [...messages, message] });
  },

  updateStatus: (status, claimedById, claimedByUsername) => {
    const ticket = get().ticket;
    if (!ticket) return;
    set({ ticket: { ...ticket, status, claimedById: claimedById ?? null, claimedByUsername: claimedByUsername ?? null } });
  },
}));
