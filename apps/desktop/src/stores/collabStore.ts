import { create } from 'zustand';
import * as Y from 'yjs';
import { api } from '../services/api';
import { getSocket } from '../services/socket';
import { SocketIOCollabProvider } from '../services/collabProvider';
import type { ChannelType, CodeLanguage } from '@voxium/shared';

interface CollabState {
  activeCollabChannelId: string | null;
  activeCollabType: 'canvas' | 'code' | null;
  codeLanguage: string;
  isConnected: boolean;

  // Yjs doc and provider are stored outside Zustand serialization
  // Access via getDoc() and getProvider()

  joinCollab: (channelId: string, type: 'canvas' | 'code') => void;
  leaveCollab: () => void;
  setCodeLanguage: (channelId: string, language: string) => Promise<void>;
  fetchDocumentInfo: (channelId: string) => Promise<void>;
}

// External refs for non-serializable Yjs objects
let currentDoc: Y.Doc | null = null;
let currentProvider: SocketIOCollabProvider | null = null;

export function getCollabDoc(): Y.Doc | null {
  return currentDoc;
}

export function getCollabProvider(): SocketIOCollabProvider | null {
  return currentProvider;
}

export const useCollabStore = create<CollabState>((set, get) => ({
  activeCollabChannelId: null,
  activeCollabType: null,
  codeLanguage: 'typescript',
  isConnected: false,

  joinCollab: (channelId: string, type: 'canvas' | 'code') => {
    // Already in this collab — skip
    const prev = get().activeCollabChannelId;
    if (prev === channelId) return;

    // Leave previous collab if any
    if (prev) {
      get().leaveCollab();
    }

    const socket = getSocket();
    if (!socket) {
      console.warn('[CollabStore] No socket connection available');
      return;
    }

    // Create fresh Yjs doc and provider
    const doc = new Y.Doc();
    const provider = new SocketIOCollabProvider(channelId, doc, socket);

    currentDoc = doc;
    currentProvider = provider;

    set({
      activeCollabChannelId: channelId,
      activeCollabType: type,
      isConnected: true,
    });

    // Fetch document metadata (language for code channels)
    get().fetchDocumentInfo(channelId);
  },

  leaveCollab: () => {
    if (currentProvider) {
      currentProvider.destroy();
      currentProvider = null;
    }
    if (currentDoc) {
      currentDoc.destroy();
      currentDoc = null;
    }

    set({
      activeCollabChannelId: null,
      activeCollabType: null,
      isConnected: false,
    });
  },

  setCodeLanguage: async (channelId: string, language: string) => {
    try {
      await api.put(`/channels/${channelId}/document/language`, { language });
      set({ codeLanguage: language });
    } catch (err) {
      console.error('[CollabStore] Failed to update language:', err);
      throw err;
    }
  },

  fetchDocumentInfo: async (channelId: string) => {
    try {
      const { data } = await api.get(`/channels/${channelId}/document`);
      if (data.data?.language) {
        set({ codeLanguage: data.data.language });
      }
    } catch (err) {
      console.warn('[CollabStore] Failed to fetch doc info:', err);
    }
  },
}));

export function handleCollabLanguageChanged(data: { channelId: string; language: string }) {
  const state = useCollabStore.getState();
  if (state.activeCollabChannelId === data.channelId) {
    useCollabStore.setState({ codeLanguage: data.language });
  }
}
