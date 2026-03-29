import { create } from 'zustand';
import type { GiphyGif, GifUploadData } from '@voxium/shared';
import { api } from '../services/api';

interface GifState {
  // Giphy (external, feature-flagged)
  giphyResults: GiphyGif[];
  giphyTrending: GiphyGif[];
  giphyQuery: string;
  giphyOffset: number;
  giphyEnabled: boolean;

  // Self-hosted library
  libraryResults: GifUploadData[];
  libraryQuery: string;
  libraryTotal: number;
  myGifs: GifUploadData[];

  isSearching: boolean;

  // Giphy actions
  searchGiphy: (query: string) => Promise<void>;
  fetchGiphyTrending: () => Promise<void>;
  setGiphyEnabled: (enabled: boolean) => void;

  // Library actions
  searchLibrary: (query: string) => Promise<void>;
  fetchMyGifs: () => Promise<void>;
  uploadGif: (s3Key: string, fileName: string, fileSize: number, tags: string[]) => Promise<void>;
  deleteGif: (gifId: string) => Promise<void>;

  clearSearch: () => void;
  clear: () => void;
}

export const useGifStore = create<GifState>((set, get) => ({
  giphyResults: [],
  giphyTrending: [],
  giphyQuery: '',
  giphyOffset: 0,
  giphyEnabled: false,

  libraryResults: [],
  libraryQuery: '',
  libraryTotal: 0,
  myGifs: [],

  isSearching: false,

  // ─── Giphy ──────────────────────────────────────────────────────────

  searchGiphy: async (query) => {
    if (!query.trim()) {
      set({ giphyResults: [], giphyQuery: '', giphyOffset: 0 });
      return;
    }
    set({ isSearching: true, giphyQuery: query });
    try {
      const { data } = await api.get('/gifs/giphy/search', { params: { q: query, limit: 20 } });
      set({ giphyResults: data.data.gifs, giphyOffset: data.data.offset, isSearching: false });
    } catch {
      set({ isSearching: false });
    }
  },

  fetchGiphyTrending: async () => {
    set({ isSearching: true });
    try {
      const { data } = await api.get('/gifs/giphy/trending', { params: { limit: 20 } });
      set({ giphyTrending: data.data.gifs, isSearching: false });
    } catch {
      set({ isSearching: false });
    }
  },

  setGiphyEnabled: (enabled) => set({ giphyEnabled: enabled }),

  // ─── Self-Hosted Library ────────────────────────────────────────────

  searchLibrary: async (query) => {
    set({ isSearching: true, libraryQuery: query });
    try {
      const params: Record<string, string | number> = { limit: 40 };
      if (query.trim()) params.q = query;
      const { data } = await api.get('/gifs/library', { params });
      set({ libraryResults: data.data.gifs, libraryTotal: data.data.total, isSearching: false });
    } catch {
      set({ isSearching: false });
    }
  },

  fetchMyGifs: async () => {
    try {
      const { data } = await api.get('/gifs/my');
      set({ myGifs: data.data });
    } catch (err) {
      console.warn('[GifStore] fetchMyGifs failed:', err instanceof Error ? err.message : err);
    }
  },

  uploadGif: async (s3Key, fileName, fileSize, tags) => {
    const { data } = await api.post('/gifs', { s3Key, fileName, fileSize, tags });
    set((state) => ({ myGifs: [data.data, ...state.myGifs] }));
  },

  deleteGif: async (gifId) => {
    await api.delete(`/gifs/${gifId}`);
    set((state) => ({ myGifs: state.myGifs.filter((g) => g.id !== gifId) }));
  },

  clearSearch: () => set({ giphyResults: [], giphyQuery: '', giphyOffset: 0, libraryResults: [], libraryQuery: '', libraryTotal: 0 }),

  clear: () => set({
    giphyResults: [], giphyTrending: [], giphyQuery: '', giphyOffset: 0,
    libraryResults: [], libraryQuery: '', libraryTotal: 0, myGifs: [],
    isSearching: false,
  }),
}));
