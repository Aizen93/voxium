import { create } from 'zustand';
import type { CustomEmoji } from '@voxium/shared';
import { api } from '../services/api';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

// Dedup concurrent resolveEmoji calls for the same emojiId
const pendingResolves = new Map<string, Promise<CustomEmoji | null>>();

interface EmojiState {
  /** All custom emojis keyed by ID */
  emojis: Map<string, CustomEmoji>;
  /** Custom emojis grouped by serverId */
  emojisByServer: Map<string, CustomEmoji[]>;

  initEmojis: (emojis: CustomEmoji[]) => void;
  addEmoji: (serverId: string, emoji: CustomEmoji) => void;
  removeEmoji: (serverId: string, emojiId: string) => void;
  resolveEmoji: (emojiId: string) => Promise<CustomEmoji | null>;
  getEmojiImageUrl: (emoji: CustomEmoji) => string;
  getAllEmojis: () => CustomEmoji[];
  clear: () => void;
}

export const useEmojiStore = create<EmojiState>((set, get) => ({
  emojis: new Map(),
  emojisByServer: new Map(),

  initEmojis: (emojis) => {
    const byId = new Map<string, CustomEmoji>();
    const byServer = new Map<string, CustomEmoji[]>();

    for (const e of emojis) {
      byId.set(e.id, e);
      const list = byServer.get(e.serverId) || [];
      list.push(e);
      byServer.set(e.serverId, list);
    }

    set({ emojis: byId, emojisByServer: byServer });
  },

  addEmoji: (serverId, emoji) => {
    set((state) => {
      const newById = new Map(state.emojis);
      newById.set(emoji.id, emoji);

      const newByServer = new Map(state.emojisByServer);
      const existing = newByServer.get(serverId) || [];
      // Replace if exists (rename), append if new
      const idx = existing.findIndex((e) => e.id === emoji.id);
      const list = idx >= 0
        ? existing.map((e) => e.id === emoji.id ? emoji : e)
        : [...existing, emoji];
      newByServer.set(serverId, list);

      return { emojis: newById, emojisByServer: newByServer };
    });
  },

  removeEmoji: (serverId, emojiId) => {
    set((state) => {
      const newById = new Map(state.emojis);
      newById.delete(emojiId);

      const newByServer = new Map(state.emojisByServer);
      const list = (newByServer.get(serverId) || []).filter((e) => e.id !== emojiId);
      if (list.length > 0) {
        newByServer.set(serverId, list);
      } else {
        newByServer.delete(serverId);
      }

      return { emojis: newById, emojisByServer: newByServer };
    });
  },

  resolveEmoji: async (emojiId) => {
    // Check cache first
    const cached = get().emojis.get(emojiId);
    if (cached) return cached;

    // Dedup: if a request for this ID is already in flight, return the same promise
    const pending = pendingResolves.get(emojiId);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const { data } = await api.get(`/emojis/${emojiId}`);
        const emoji = data.data as CustomEmoji;
        get().addEmoji(emoji.serverId, emoji);
        return emoji;
      } catch (err) {
        console.warn(`[EmojiStore] Failed to resolve emoji ${emojiId}:`, err instanceof Error ? err.message : err);
        return null;
      } finally {
        pendingResolves.delete(emojiId);
      }
    })();

    pendingResolves.set(emojiId, promise);
    return promise;
  },

  getEmojiImageUrl: (emoji) => {
    return `${API_URL}/uploads/${emoji.s3Key}?inline`;
  },

  getAllEmojis: () => {
    return Array.from(get().emojis.values());
  },

  clear: () => {
    set({ emojis: new Map(), emojisByServer: new Map() });
  },
}));
