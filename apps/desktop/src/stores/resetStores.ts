import { useServerStore } from './serverStore';
import { useChatStore } from './chatStore';
import { useDMStore } from './dmStore';
import { useFriendStore } from './friendStore';
import { useSupportStore } from './supportStore';
import { useAnnouncementStore } from './announcementStore';
import { useVoiceStore } from './voiceStore';
import { useE2EStore } from './e2eStore';
import { useAnnotationStore, resetAnnotationModuleState } from './annotationStore';
import { useAnnotationLiveStore, resetAnnotationLiveModuleState } from './annotationLiveStore';
import { useMaskLayoutStore, resetMaskLayoutModuleState } from './maskLayoutStore';
import { disposeE2EService } from '../services/e2e/e2eService';
import { stopE2EDeviceListWatch } from './e2eStore';

/**
 * Account-scoped stores that MUST be wiped on logout. Without this, the next
 * account on a shared machine briefly sees the previous user's servers, DM
 * list, unreads, and support-ticket transcript until its own refetches land.
 *
 * Deliberately excluded:
 * - authStore    — resets itself in logout()
 * - settingsStore — device-level preferences (theme, audio devices), not account data
 * - toastStore    — transient UI, may still be showing the "logged out" toast
 */
const ACCOUNT_STORES = [
  useServerStore,
  useChatStore,
  useDMStore,
  useFriendStore,
  useSupportStore,
  useAnnouncementStore,
  useVoiceStore,
  useE2EStore,
  useAnnotationStore,
  useAnnotationLiveStore,
  // In-memory only: the on-disk layouts are keyed per user (another account
  // reads a different key) and deliberately survive logout, like trusted
  // devices and the E2E vault
  useMaskLayoutStore,
] as const;

// Captured at module import — before any user interaction — so this is each
// store's pristine initial state. Zustand keeps actions in the state object,
// so a full replace restores both data and (identical) action references.
// Store actions must keep treating state as immutable (they do — new Map/array
// on every update); mutating a container in place would corrupt this snapshot.
const initialStates = ACCOUNT_STORES.map((store) => store.getState());

/** Reset every account-scoped store to its initial state. Called on logout. */
export function resetAccountStores(): void {
  // Device-scoped, localStorage-backed fields living inside otherwise
  // account-scoped stores must SURVIVE the reset. The snapshot holds their
  // module-load values; reverting to those would make the next persist call
  // (toggleMute/dismissAnnouncement) write STALE prefs back to localStorage —
  // dropping mute/deafen prefs and resurrecting dismissed announcements after
  // a client-side logout→login.
  const { selfMute, selfDeaf } = useVoiceStore.getState();
  const { dismissedIds } = useAnnouncementStore.getState();

  ACCOUNT_STORES.forEach((store, i) => {
    (store.setState as (state: unknown, replace: true) => void)(initialStates[i], true);
  });

  useVoiceStore.setState({ selfMute, selfDeaf });
  useAnnouncementStore.setState({ dismissedIds });

  // Module-level annotation state (op queue, history stacks, pointer
  // throttle, the layout-save debounce) lives outside the slices the loop
  // above replaced
  resetAnnotationModuleState();
  resetAnnotationLiveModuleState();
  resetMaskLayoutModuleState();

  // Free the WASM crypto objects and close the vault. Key material stays in
  // the vault (device keys persist across logout, like trusted-device tokens).
  stopE2EDeviceListWatch();
  disposeE2EService();
}
