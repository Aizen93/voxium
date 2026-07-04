import { useServerStore } from './serverStore';
import { useChatStore } from './chatStore';
import { useDMStore } from './dmStore';
import { useFriendStore } from './friendStore';
import { useSupportStore } from './supportStore';
import { useAnnouncementStore } from './announcementStore';
import { useVoiceStore } from './voiceStore';

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
] as const;

// Captured at module import — before any user interaction — so this is each
// store's pristine initial state. Zustand keeps actions in the state object,
// so a full replace restores both data and (identical) action references.
// Store actions must keep treating state as immutable (they do — new Map/array
// on every update); mutating a container in place would corrupt this snapshot.
const initialStates = ACCOUNT_STORES.map((store) => store.getState());

/** Reset every account-scoped store to its initial state. Called on logout. */
export function resetAccountStores(): void {
  ACCOUNT_STORES.forEach((store, i) => {
    (store.setState as (state: unknown, replace: true) => void)(initialStates[i], true);
  });
}
