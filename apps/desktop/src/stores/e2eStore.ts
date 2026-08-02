import { create } from 'zustand';
import { getE2EService, E2EIdentityChangedError, type E2EOwnDevices } from '../services/e2e/e2eService';

// UI-facing E2E state. The crypto itself lives in services/e2e — this store
// only tracks readiness and per-peer identity warnings so components can
// render badges/warnings without touching the vault.

/** Live device-list subscription; re-created per login, cleared on reset. */
let unsubscribeDeviceListChanges: (() => void) | null = null;

/**
 * The own-account slice of a device-list status, in one place: every caller
 * that recomputes it has to agree on which device is "this" one, or the badge
 * ends up warning about the device the user is sitting in front of (or worse,
 * staying silent about the one they are not).
 */
function ownStatusPatch(
  service: { deviceId: string; hasMasterSecret(): boolean; canApproveDevices(): boolean; hasMasterKeyConflict(): boolean },
  status: { changed: boolean; newDeviceIds: string[]; unsignedDeviceIds: string[] }
) {
  return {
    ownDeviceWarnings: status.changed ? status.newDeviceIds.filter((id) => id !== service.deviceId) : [],
    ownUnsignedDevices: status.unsignedDeviceIds.filter((id) => id !== service.deviceId),
    thisDeviceUnsigned: status.unsignedDeviceIds.includes(service.deviceId),
    masterReady: service.hasMasterSecret(),
    canApprove: service.canApproveDevices(),
    masterKeyConflict: service.hasMasterKeyConflict(),
  };
}

/**
 * A linking code that names no device of this account (spec §17, plan §4.3).
 *
 * Typed rather than a message so the UI never string-matches: "nothing is
 * showing that code" is the answer to a typo or to a code read off someone
 * else's screen, and it has to be told apart from "the lookup itself failed"
 * (offline, 429). Rendering the second as the first would send a user hunting
 * for a code that was correct all along.
 */
export class E2ELinkingCodeUnknownError extends Error {
  constructor(public readonly code: string) {
    super('No unapproved device of this account is showing that code');
    this.name = 'E2ELinkingCodeUnknownError';
  }
}

/** Called by resetAccountStores on logout — the service itself is disposed there. */
export function stopE2EDeviceListWatch(): void {
  if (unsubscribeDeviceListChanges) {
    unsubscribeDeviceListChanges();
    unsubscribeDeviceListChanges = null;
  }
}

/** The device a linking code named: everything the user gets to check before approving. */
export interface E2ELinkableDevice {
  deviceId: string;
  createdAt: string;
  /**
   * The code this device's PUBLISHED KEYS produce — carried so approval can
   * check it again against a fresh device list. Without it the confirmation
   * binds only a device id, and the server is free to answer the second
   * lookup with different keys under the same id.
   */
  linkingCode: string;
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
   * THIS device is not vouched for by the account key: it was installed but
   * never approved from an existing device. It cannot approve others, and
   * every peer sees it flagged — so the user needs to be told here rather
   * than only hearing about it from the person they are messaging.
   */
  thisDeviceUnsigned: boolean;
  /**
   * The account publishes a master key this device can neither prove nor
   * replace (spec §14.2). Sending still works — the pinned key is kept — but
   * the account's cross-signing is stuck until the user resets the identity.
   */
  masterKeyConflict: boolean;
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
  /**
   * The last device-list load failed (offline, 429, 5xx).
   *
   * Tracked separately because "the read failed" and "you have no other
   * devices" are opposite answers that rendered identically: an empty list. On
   * the one screen where a user would notice a device they did not add, a
   * failure that shows nothing is worse than useless — it is reassuring. Seen
   * live: three browser contexts sharing an IP exhausted the request budget,
   * the list 429'd, and the panel calmly reported no other devices.
   */
  ownDevicesError: boolean;
  /**
   * Whether the account has an encrypted key backup on the server, and when it
   * was last written (spec §15). `null` means "not read yet" — NOT "no backup":
   * both answers drive an action, and each is destructive in the wrong state
   * (creating over an existing blob invalidates a recovery key the user already
   * wrote down; offering a restore box for a blob that does not exist sends
   * them hunting for a key that was never created).
   *
   * The recovery key itself is never held here — see createKeyBackup.
   */
  keyBackup: { exists: boolean; updatedAt: string | null } | null;

  initialize: (userId: string) => Promise<void>;
  flagIdentityChanged: (peerUserId: string) => void;
  acceptNewIdentity: (userId: string, peerUserId: string) => Promise<void>;
  refreshDeviceList: (userId: string, peerUserId: string) => Promise<void>;
  acknowledgeDeviceList: (userId: string, peerUserId: string, seenDeviceIds?: string[]) => Promise<void>;
  loadOwnDevices: (userId: string) => Promise<void>;
  revokeDevice: (userId: string, deviceId: string) => Promise<void>;
  approveDevice: (userId: string, deviceId: string, linkingCode?: string) => Promise<void>;
  linkDevice: (userId: string, code: string) => Promise<E2ELinkableDevice>;
  approveLinkedDevice: (userId: string, deviceId: string, linkingCode?: string) => Promise<void>;
  acknowledgeOwnDevices: (userId: string, seenDeviceIds: string[]) => Promise<void>;
  markAccountVerified: (userId: string, peerUserId: string) => Promise<void>;
  resetAccountIdentity: (userId: string) => Promise<void>;
  loadKeyBackup: (userId: string) => Promise<void>;
  createKeyBackup: (userId: string) => Promise<string>;
  deleteKeyBackup: (userId: string) => Promise<void>;
  restoreKeyBackup: (userId: string, recoveryKey: string) => Promise<void>;
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
  thisDeviceUnsigned: false,
  masterKeyConflict: false,
  ownDeviceWarnings: [],
  ownDevices: null,
  ownDevicesLoading: false,
  ownDevicesError: false,
  keyBackup: null,

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
                return ownStatusPatch(service, status);
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
        masterKeyConflict: service.hasMasterKeyConflict(),
      });
      // The master secret may still be in flight (initialize claims pending
      // transfers fire-and-forget): re-read once it settles so an approved
      // device flips to "can approve" without a restart.
      //
      // Re-read unconditionally. When the claim that runs inside initialize()
      // wins the race, this one returns false because there is nothing left to
      // import — which is exactly the case where the flags need updating.
      void service
        .claimMasterTransfers()
        .then(() => {
          set({ masterReady: service.hasMasterSecret(), canApprove: service.canApproveDevices() });
        })
        .catch((err) => {
          console.warn('e2e: master-secret claim failed:', err instanceof Error ? err.message : err);
        });
      // Warnings about our OWN devices are otherwise only computed when the
      // list CHANGES. On a device that was installed and never approved,
      // nothing changes for the whole session, so the badge would sit green
      // while the account key does not vouch for it.
      void service
        .deviceListStatus(userId)
        .then((status) => {
          set(ownStatusPatch(service, status));
        })
        .catch((err) => {
          console.warn('e2e: own device status check failed:', err instanceof Error ? err.message : err);
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
    set(ownStatusPatch(service, status));
  },

  /** The user compared the peer's ACCOUNT safety number out of band (D9). */
  markAccountVerified: async (userId: string, peerUserId: string) => {
    await getE2EService(userId).markIdentityVerified(peerUserId);
    set((state) => ({ accountVerified: { ...state.accountVerified, [peerUserId]: true } }));
  },

  /** Device-manager UI: (re)load this account's registered devices. */
  loadOwnDevices: async (userId: string) => {
    set({ ownDevicesLoading: true, ownDevicesError: false });
    try {
      const ownDevices = await getE2EService(userId).listOwnDevices();
      set({ ownDevices, ownDevicesLoading: false, ownDevicesError: false });
    } catch (err) {
      console.warn('e2e: loading own devices failed:', err instanceof Error ? err.message : err);
      // Leave any previously loaded list in place rather than blanking it — a
      // stale list is still true of some moment; an empty one is a claim.
      set({ ownDevicesLoading: false, ownDevicesError: true });
    }
  },

  revokeDevice: async (userId: string, deviceId: string) => {
    const service = getE2EService(userId);
    await service.revokeDevice(deviceId);
    await get().loadOwnDevices(userId);
    // the revoked device must stop being reported as unrecognised / unsigned
    const status = await service.deviceListStatus(userId);
    set(ownStatusPatch(service, status));
  },

  /**
   * Approve one of our own devices (spec §14, D6): cross-sign it with the
   * account key and hand that key over, so it becomes trusted everywhere and
   * can approve the next device itself.
   */
  approveDevice: async (userId: string, deviceId: string, linkingCode?: string) => {
    const service = getE2EService(userId);
    await service.approveDevice(deviceId, linkingCode);
    await get().loadOwnDevices(userId);
    const status = await service.deviceListStatus(userId);
    set(ownStatusPatch(service, status));
  },

  /**
   * Resolve a linking code to the device that is showing it (plan §4.3) —
   * and STOP there. Nothing is approved, nothing is signed, no key moves.
   *
   * The split is the whole security story of this flow. The code itself is not
   * a capability: it is derived from keys the server already publishes, so
   * knowing it grants nothing — approving still requires THIS device to hold
   * the account key and its user to act. What is left is phishing, someone
   * talked into typing a code that is not theirs, and the only defence against
   * that is showing the user what they are about to approve while they can
   * still say no. An action that looked up and approved in one step would
   * delete that moment, so the lookup deliberately returns the match instead.
   */
  linkDevice: async (userId: string, code: string) => {
    const match = await getE2EService(userId).findLinkableDevice(code);
    // Typed, so the UI can say "no device is showing that code" for this and
    // "try again" for a lookup that never got an answer. A `null` return is a
    // definite answer from the server; anything else propagates as itself.
    if (!match) throw new E2ELinkingCodeUnknownError(code);
    return match;
  },

  /**
   * Second half of the linking flow: the user confirmed the device named by
   * `linkDevice`, so approve exactly that one.
   *
   * Delegates to approveDevice rather than repeating it: a device approved by
   * code and a device approved from the list must end in the same state, and
   * two copies of "cross-sign, reload, recompute own status" would drift.
   */
  approveLinkedDevice: async (userId: string, deviceId: string, linkingCode?: string) => {
    await get().approveDevice(userId, deviceId, linkingCode);
  },

  /**
   * Start a new account identity (spec §14.4). The way out when no device
   * holds the account key any more — a reinstall that lost the vault, or a
   * published key this device cannot prove. Peers see the account safety
   * number change, which is the honest signal that trust has to be re-earned.
   */
  resetAccountIdentity: async (userId: string) => {
    const service = getE2EService(userId);
    await service.resetAccountIdentity();
    await get().loadOwnDevices(userId);
    const status = await service.deviceListStatus(userId);
    set(ownStatusPatch(service, status));
    // A reset that MINTED a new key drops the backup server-side (spec §15.5) —
    // the blob decrypts to a key this account no longer publishes. Re-read it
    // rather than leave the panel promising a recovery key that is now noise.
    await get().loadKeyBackup(userId);
  },

  /**
   * Device-manager UI: does this account have a key backup, and how old is it?
   *
   * Swallows its errors like loadOwnDevices, and for the same reason: it is
   * fired from a mount effect with nobody to report to. A failed read leaves
   * the previous answer (or `null`) in place instead of inventing "no backup" —
   * which the UI would render as an offer to create one, replacing the blob and
   * silently invalidating the recovery key the user already saved.
   */
  loadKeyBackup: async (userId: string) => {
    try {
      const keyBackup = await getE2EService(userId).keyBackupInfo();
      set({ keyBackup });
    } catch (err) {
      console.warn('e2e: reading key backup state failed:', err instanceof Error ? err.message : err);
    }
  },

  /**
   * Seal the account key under a fresh recovery key (spec §15.2) and hand that
   * key back to the CALLER — once.
   *
   * It is deliberately not stored: store state outlives the dialog that shows
   * it, survives in devtools and in any state dump, and this string is the
   * whole security of the backup. It lives in the dialog's own state and dies
   * with it. Errors propagate — a dialog that showed no key must not close as
   * if it had.
   */
  createKeyBackup: async (userId: string) => {
    const recoveryKey = await getE2EService(userId).createKeyBackup();
    // Optimistic before the re-read: the blob IS on the server now, so a failed
    // refresh must not leave the panel saying "no recovery set up" in the same
    // breath as we show the user their recovery key.
    set({ keyBackup: { exists: true, updatedAt: new Date().toISOString() } });
    await get().loadKeyBackup(userId);
    return recoveryKey;
  },

  /** Forget the backup. The recovery key that opened it is useless from here. */
  deleteKeyBackup: async (userId: string) => {
    await getE2EService(userId).deleteKeyBackup();
    set({ keyBackup: { exists: false, updatedAt: null } });
  },

  /**
   * Recover the account key from backup (spec §15.4) — the other exit from
   * "no device holds the account key", and the one to try FIRST: it restores
   * the same identity, so no peer sees a safety-number change and nobody has to
   * re-verify. Errors propagate: a key that did not open the blob has to be
   * reported as such, never absorbed into a UI that then looks restored.
   */
  restoreKeyBackup: async (userId: string, recoveryKey: string) => {
    const service = getE2EService(userId);
    await service.restoreKeyBackup(recoveryKey);
    await get().loadOwnDevices(userId);
    const status = await service.deviceListStatus(userId);
    set(ownStatusPatch(service, status));
  },
}));

export { E2EIdentityChangedError };
