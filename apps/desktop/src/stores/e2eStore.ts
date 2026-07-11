import { create } from 'zustand';
import { getE2EService, E2EIdentityChangedError } from '../services/e2e/e2eService';

// UI-facing E2E state. The crypto itself lives in services/e2e — this store
// only tracks readiness and per-peer identity warnings so components can
// render badges/warnings without touching the vault.

interface E2EState {
  ready: boolean;
  initializing: boolean;
  error: string | null;
  /** peers whose identity key changed since we pinned it (safety number changed) */
  identityWarnings: Record<string, boolean>;

  initialize: (userId: string) => Promise<void>;
  flagIdentityChanged: (peerUserId: string) => void;
  acceptNewIdentity: (userId: string, peerUserId: string) => Promise<void>;
}

export const useE2EStore = create<E2EState>((set, get) => ({
  ready: false,
  initializing: false,
  error: null,
  identityWarnings: {},

  initialize: async (userId: string) => {
    if (get().ready || get().initializing) return;
    set({ initializing: true, error: null });
    try {
      await getE2EService(userId).initialize();
      set({ ready: true, initializing: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'E2E initialization failed';
      console.warn('e2e: initialization failed:', message);
      set({ ready: false, initializing: false, error: message });
    }
  },

  flagIdentityChanged: (peerUserId: string) => {
    set((state) => ({ identityWarnings: { ...state.identityWarnings, [peerUserId]: true } }));
  },

  acceptNewIdentity: async (userId: string, peerUserId: string) => {
    await getE2EService(userId).acceptNewIdentity(peerUserId);
    set((state) => {
      const identityWarnings = { ...state.identityWarnings };
      delete identityWarnings[peerUserId];
      return { identityWarnings };
    });
  },
}));

export { E2EIdentityChangedError };
