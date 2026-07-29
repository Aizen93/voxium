import { create } from 'zustand';
import { getE2EService, E2EIdentityChangedError, type E2EOwnDevices } from '../services/e2e/e2eService';

// UI-facing E2E state. The crypto itself lives in services/e2e — this store
// only tracks readiness and per-peer identity warnings so components can
// render badges/warnings without touching the vault.

/** Live device-list subscription; re-created per login, cleared on reset. */
let unsubscribeDeviceListChanges: (() => void) | null = null;

/** Called by resetAccountStores on logout — the service itself is disposed there. */
export function stopE2EDeviceListWatch(): void {
  if (unsubscribeDeviceListChanges) {
    unsubscribeDeviceListChanges();
    unsubscribeDeviceListChanges = null;
  }
}

interface E2EState {
  ready: boolean;
  initializing: boolean;
  error: string | null;
  /** peers whose identity key changed since we pinned it (safety number changed) */
  identityWarnings: Record<string, boolean>;
  /** peers who added devices since the user last acknowledged their list (spec §12) */
  newDeviceWarnings: Record<string, string[]>;
  /** this account's own registered devices, as last loaded from the server */
  ownDevices: E2EOwnDevices | null;
  ownDevicesLoading: boolean;

  initialize: (userId: string) => Promise<void>;
  flagIdentityChanged: (peerUserId: string) => void;
  acceptNewIdentity: (userId: string, peerUserId: string) => Promise<void>;
  refreshDeviceList: (userId: string, peerUserId: string) => Promise<void>;
  acknowledgeDeviceList: (userId: string, peerUserId: string) => Promise<void>;
  loadOwnDevices: (userId: string) => Promise<void>;
  revokeDevice: (userId: string, deviceId: string) => Promise<void>;
}

export const useE2EStore = create<E2EState>((set, get) => ({
  ready: false,
  initializing: false,
  error: null,
  identityWarnings: {},
  newDeviceWarnings: {},
  ownDevices: null,
  ownDevicesLoading: false,

  initialize: async (userId: string) => {
    if (get().ready || get().initializing) return;
    set({ initializing: true, error: null });
    try {
      const service = getE2EService(userId);
      await service.initialize();
      // The send path refreshes device lists too (rotation decisions). Without
      // this subscription a device appearing mid-conversation would silently
      // receive session keys while the UI badge stayed green until remount.
      if (unsubscribeDeviceListChanges) unsubscribeDeviceListChanges();
      unsubscribeDeviceListChanges = service.onDeviceListChanged((changedUserId) => {
        if (changedUserId === userId) return; // own devices: shown in the device manager
        void service
          .deviceListStatus(changedUserId)
          .then((status) => {
            set((state) => {
              const newDeviceWarnings = { ...state.newDeviceWarnings };
              if (status.changed) newDeviceWarnings[changedUserId] = status.newDeviceIds;
              else delete newDeviceWarnings[changedUserId];
              return { newDeviceWarnings };
            });
          })
          .catch((err) => {
            console.warn('e2e: device-list status check failed:', err instanceof Error ? err.message : err);
          });
      });
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
      const newDeviceWarnings = { ...state.newDeviceWarnings };
      delete newDeviceWarnings[peerUserId];
      return { identityWarnings, newDeviceWarnings };
    });
  },

  /** Re-read a peer's device list and surface a warning if it grew/shrank. */
  refreshDeviceList: async (userId: string, peerUserId: string) => {
    const service = getE2EService(userId);
    try {
      await service.fetchDeviceList(peerUserId);
    } catch (err) {
      if (err instanceof E2EIdentityChangedError) {
        get().flagIdentityChanged(peerUserId);
        return;
      }
      console.warn('e2e: device list refresh failed:', err instanceof Error ? err.message : err);
      return;
    }
    const status = await service.deviceListStatus(peerUserId);
    set((state) => {
      const newDeviceWarnings = { ...state.newDeviceWarnings };
      if (status.changed) newDeviceWarnings[peerUserId] = status.newDeviceIds;
      else delete newDeviceWarnings[peerUserId];
      return { newDeviceWarnings };
    });
  },

  acknowledgeDeviceList: async (userId: string, peerUserId: string) => {
    await getE2EService(userId).acknowledgeDeviceList(peerUserId);
    set((state) => {
      const newDeviceWarnings = { ...state.newDeviceWarnings };
      delete newDeviceWarnings[peerUserId];
      return { newDeviceWarnings };
    });
  },

  /** Device-manager UI: (re)load this account's registered devices. */
  loadOwnDevices: async (userId: string) => {
    set({ ownDevicesLoading: true });
    try {
      const ownDevices = await getE2EService(userId).listOwnDevices();
      set({ ownDevices, ownDevicesLoading: false });
    } catch (err) {
      console.warn('e2e: loading own devices failed:', err instanceof Error ? err.message : err);
      set({ ownDevicesLoading: false });
    }
  },

  revokeDevice: async (userId: string, deviceId: string) => {
    await getE2EService(userId).revokeDevice(deviceId);
    await get().loadOwnDevices(userId);
  },
}));

export { E2EIdentityChangedError };
