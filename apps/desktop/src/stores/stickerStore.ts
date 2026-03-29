import { create } from 'zustand';
import type { StickerData, StickerPackData } from '@voxium/shared';
import { api } from '../services/api';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

// Dedup concurrent resolveSticker calls for the same stickerId
const pendingResolves = new Map<string, Promise<StickerData | null>>();

interface StickerState {
  serverPacks: StickerPackData[];
  personalPacks: StickerPackData[];

  initStickers: (serverPacks: StickerPackData[], personalPacks: StickerPackData[]) => void;
  addServerPack: (pack: StickerPackData) => void;
  removeServerPack: (packId: string) => void;
  addPersonalPack: (pack: StickerPackData) => void;
  removePersonalPack: (packId: string) => void;
  addSticker: (packId: string, sticker: StickerData) => void;
  removeSticker: (packId: string, stickerId: string) => void;
  resolveSticker: (stickerId: string) => Promise<StickerData | null>;
  getStickerImageUrl: (sticker: StickerData) => string;
  getAllStickers: () => StickerData[];
  clear: () => void;
}

export const useStickerStore = create<StickerState>((set, get) => ({
  serverPacks: [],
  personalPacks: [],

  initStickers: (serverPacks, personalPacks) => {
    set({ serverPacks, personalPacks });
  },

  addServerPack: (pack) => {
    set((state) => ({ serverPacks: [...state.serverPacks, pack] }));
  },

  removeServerPack: (packId) => {
    set((state) => ({ serverPacks: state.serverPacks.filter((p) => p.id !== packId) }));
  },

  addPersonalPack: (pack) => {
    set((state) => ({ personalPacks: [...state.personalPacks, pack] }));
  },

  removePersonalPack: (packId) => {
    set((state) => ({ personalPacks: state.personalPacks.filter((p) => p.id !== packId) }));
  },

  addSticker: (packId, sticker) => {
    set((state) => {
      const updatePacks = (packs: StickerPackData[]) =>
        packs.map((p) =>
          p.id === packId ? { ...p, stickers: [...p.stickers, sticker] } : p,
        );
      return {
        serverPacks: updatePacks(state.serverPacks),
        personalPacks: updatePacks(state.personalPacks),
      };
    });
  },

  removeSticker: (packId, stickerId) => {
    set((state) => {
      const updatePacks = (packs: StickerPackData[]) =>
        packs.map((p) =>
          p.id === packId
            ? { ...p, stickers: p.stickers.filter((s) => s.id !== stickerId) }
            : p,
        );
      return {
        serverPacks: updatePacks(state.serverPacks),
        personalPacks: updatePacks(state.personalPacks),
      };
    });
  },

  resolveSticker: async (stickerId) => {
    // Check local cache first
    const all = get().getAllStickers();
    const cached = all.find((s) => s.id === stickerId);
    if (cached) return cached;

    // Dedup: if a request for this ID is already in flight, return the same promise
    const pending = pendingResolves.get(stickerId);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const { data } = await api.get(`/stickers/${stickerId}`);
        return data.data as StickerData;
      } catch (err) {
        console.warn(`[StickerStore] Failed to resolve sticker ${stickerId}:`, err instanceof Error ? err.message : err);
        return null;
      } finally {
        pendingResolves.delete(stickerId);
      }
    })();

    pendingResolves.set(stickerId, promise);
    return promise;
  },

  getStickerImageUrl: (sticker) => {
    return `${API_URL}/uploads/${sticker.s3Key}?inline`;
  },

  getAllStickers: () => {
    const { serverPacks, personalPacks } = get();
    return [...serverPacks, ...personalPacks].flatMap((p) => p.stickers);
  },

  clear: () => {
    set({ serverPacks: [], personalPacks: [] });
  },
}));
