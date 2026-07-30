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
  /** this device holds the account master key (spec §14) — it is cross-signed */
  masterReady: boolean;
  /** …and can therefore approve other devices of this account (D6) */
  canApprove: boolean;
  /** peers whose identity key changed since we pinned it (safety number changed) */
  identityWarnings: Record<string, boolean>;
  /** peers whose ACCOUNT safety number the user compared out of band (D9) */
  accountVerified: Record<string, boolean>;
  /** peers who added devices since the user last acknowledged their list (spec §12) */
  newDeviceWarnings: Record<string, string[]>;
  /**
   * Devices of a peer that their account key does NOT vouch for (§14, D8).
   * Rendered as "not signed by <name>'s account key"; unlike a new-device
   * notice this cannot be acknowledged away, only approved or revoked.
   */
  unsignedDeviceWarnings: Record<string, string[]>;
  /** the same, for OUR OWN account (excluding this device) */
  ownUnsignedDevices: string[];
  /**
   * Device ids that appeared on OUR OWN account without the user adding them.
   * A hostile server can register a device under the victim's userId and it
   * would otherwise receive every future group-session key with no signal —
   * the mirror image of the peer-side injection warning (spec §12.5).
   */
  ownDeviceWarnings: string[];
  /** this account's own registered devices, as last loaded from the server */
  ownDevices: E2EOwnDevices | null;
  ownDevicesLoading: boolean;

  initialize: (userId: string) => Promise<void>;
  flagIdentityChanged: (peerUserId: string) => void;
  acceptNewIdentity: (userId: string, peerUserId: string) => Promise<void>;
  refreshDeviceList: (userId: string, peerUserId: string) => Promise<void>;
  acknowledgeDeviceList: (userId: string, peerUserId: string, seenDeviceIds?: string[]) => Promise<void>;
  loadOwnDevices: (userId: string) => Promise<void>;
  revokeDevice: (userId: string, deviceId: string) => Promise<void>;
  approveDevice: (userId: string, deviceId: string) => Promise<void>;
  acknowledgeOwnDevices: (userId: string, seenDeviceIds: string[]) => Promise<void>;
  markAccountVerified: (userId: string, peerUserId: string) => Promise<void>;
}

export const useE2EStore = create<E2EState>((set, get) => ({
  ready: false,
  initializing: false,
  error: null,
  masterReady: false,
  canApprove: false,
  identityWarnings: {},
  accountVerified: {},
  newDeviceWarnings: {},
  unsignedDeviceWarnings: {},
  ownUnsignedDevices: [],
  ownDeviceWarnings: [],
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
        void service
          .deviceListStatus(changedUserId)
          .then((status) => {
            set((state) => {
              // Our own list: a device we did not add is as dangerous as an
              // injected peer device — it receives every session key we fan out.
              if (changedUserId === userId) {
                const mine = status.newDeviceIds.filter((id) => id !== service.deviceId);
                return {
                  ownDeviceWarnings: status.changed ? mine : [],
                  ownUnsignedDevices: status.unsignedDeviceIds.filter((id) => id !== service.deviceId),
                  masterReady: service.hasMasterSecret(),
                  canApprove: service.canApproveDevices(),
                };
              }
              const newDeviceWarnings = { ...state.newDeviceWarnings };
              if (status.changed) newDeviceWarnings[changedUserId] = status.newDeviceIds;
              else delete newDeviceWarnings[changedUserId];
              const unsignedDeviceWarnings = { ...state.unsignedDeviceWarnings };
              if (status.unsignedDeviceIds.length > 0) {
                unsignedDeviceWarnings[changedUserId] = status.unsignedDeviceIds;
              } else {
                delete unsignedDeviceWarnings[changedUserId];
              }
              return { newDeviceWarnings, unsignedDeviceWarnings };
            });
          })
          .catch((err) => {
            console.warn('e2e: device-list status check failed:', err instanceof Error ? err.message : err);
          });
      });
      set({
        ready: true,
        initializing: false,
        masterReady: service.hasMasterSecret(),
        canApprove: service.canApproveDevices(),
      });
      // The master secret may still be in flight (initialize claims pending
      // transfers fire-and-forget): re-read once it settles so an approved
      // device flips to "can approve" without a restart.
      void service
        .claimMasterTransfers()
        .then((imported) => {
          if (imported) set({ masterReady: true, canApprove: service.canApproveDevices() });
        })
        .catch((err) => {
          console.warn('e2e: master-secret claim failed:', err instanceof Error ? err.message : err);
        });
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
      // The account key was re-pinned unverified — the old comparison is void.
      const accountVerified = { ...state.accountVerified };
      delete accountVerified[peerUserId];
      return { identityWarnings, newDeviceWarnings, accountVerified };
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
    const verified = await service.isAccountVerified(peerUserId);
    set((state) => {
      const newDeviceWarnings = { ...state.newDeviceWarnings };
      if (status.changed) newDeviceWarnings[peerUserId] = status.newDeviceIds;
      else delete newDeviceWarnings[peerUserId];
      const unsignedDeviceWarnings = { ...state.unsignedDeviceWarnings };
      if (status.unsignedDeviceIds.length > 0) unsignedDeviceWarnings[peerUserId] = status.unsignedDeviceIds;
      else delete unsignedDeviceWarnings[peerUserId];
      return {
        newDeviceWarnings,
        unsignedDeviceWarnings,
        accountVerified: { ...state.accountVerified, [peerUserId]: verified },
      };
    });
  },

  acknowledgeDeviceList: async (userId: string, peerUserId: string, seenDeviceIds?: string[]) => {
    await getE2EService(userId).acknowledgeDeviceList(peerUserId, seenDeviceIds);
    set((state) => {
      const newDeviceWarnings = { ...state.newDeviceWarnings };
      delete newDeviceWarnings[peerUserId];
      return { newDeviceWarnings };
    });
  },

  /**
   * The user has reviewed their own device list. This clears the "new device"
   * notice only — a device the account key does not vouch for stays flagged
   * until it is approved or revoked (spec §14, D8).
   */
  acknowledgeOwnDevices: async (userId: string, seenDeviceIds: string[]) => {
    const service = getE2EService(userId);
    await service.acknowledgeDeviceList(userId, seenDeviceIds);
    const status = await service.deviceListStatus(userId);
    set({
      ownDeviceWarnings: status.changed ? status.newDeviceIds.filter((id) => id !== service.deviceId) : [],
      ownUnsignedDevices: status.unsignedDeviceIds.filter((id) => id !== service.deviceId),
    });
  },

  /** The user compared the peer's ACCOUNT safety number out of band (D9). */
  markAccountVerified: async (userId: string, peerUserId: string) => {
    await getE2EService(userId).markIdentityVerified(peerUserId);
    set((state) => ({ accountVerified: { ...state.accountVerified, [peerUserId]: true } }));
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
    const service = getE2EService(userId);
    await service.revokeDevice(deviceId);
    await get().loadOwnDevices(userId);
    // the revoked device must stop being reported as unrecognised / unsigned
    const status = await service.deviceListStatus(userId);
    set({
      ownDeviceWarnings: status.changed ? status.newDeviceIds.filter((id) => id !== service.deviceId) : [],
      ownUnsignedDevices: status.unsignedDeviceIds.filter((id) => id !== service.deviceId),
    });
  },

  /**
   * Approve one of our own devices (spec §14, D6): cross-sign it with the
   * account key and hand that key over, so it becomes trusted everywhere and
   * can approve the next device itself.
   */
  approveDevice: async (userId: string, deviceId: string) => {
    const service = getE2EService(userId);
    await service.approveDevice(deviceId);
    await get().loadOwnDevices(userId);
    const status = await service.deviceListStatus(userId);
    set({
      ownDeviceWarnings: status.changed ? status.newDeviceIds.filter((id) => id !== service.deviceId) : [],
      ownUnsignedDevices: status.unsignedDeviceIds.filter((id) => id !== service.deviceId),
    });
  },
}));

export { E2EIdentityChangedError };
