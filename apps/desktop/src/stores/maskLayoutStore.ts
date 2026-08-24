import { create } from 'zustand';
import { useVoiceStore } from './voiceStore';
import { useAnnotationStore, type MaskRect } from './annotationStore';
import {
  loadMaskLayouts, saveMaskLayouts, findMaskLayout, upsertMaskLayout,
} from '../utils/maskLayouts';

/**
 * Remembered mask layouts, wired to the share lifecycle:
 *
 * - APPLY: when this client's share starts and a layout exists for the
 *   source (`voiceStore.screenShareSourceKey`), its masks are placed
 *   automatically — fail-closed toward privacy: applied by default, one
 *   click ("start fresh") to drop them. A banner says what happened.
 * - SAVE: while sharing, every mask edit re-saves the layout for the
 *   current source, debounced — a crash mid-share still remembers. An empty
 *   mask list deletes the entry (that is a memory too).
 *
 * Nothing here is ever networked. Storage is per user on this device
 * (utils/maskLayouts); logout resets only the in-memory state.
 */

const SAVE_DEBOUNCE_MS = 1_000;

interface AppliedLayout {
  key: string;
  count: number;
  /** The mask ids this application placed — what "start fresh" removes. */
  ids: string[];
}

interface MaskLayoutState {
  /** Set while the "N masks from your last share" banner should show. */
  appliedLayout: AppliedLayout | null;
  /** Keep the applied masks; just dismiss the banner. */
  keepApplied: () => void;
  /** Remove exactly the masks the auto-apply placed, and dismiss. */
  startFresh: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Suppresses the save-on-edit subscription while auto-apply itself edits. */
let applying = false;
/** Last mask list seen while LIVE-sharing. The stop transition needs it: the
 *  annotationStore lifecycle subscription runs first on the same voiceStore
 *  update and has already wiped the masks by the time ours flushes the
 *  debounced save — reading the store then would DELETE the layout. */
let lastLiveMasks: readonly MaskRect[] = [];
/** The layout was already applied for this capture (in the pre-flight) —
 *  the share-start transition must not apply it a second time. */
let appliedThisCapture = false;

export function resetMaskLayoutModuleState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  applying = false;
  appliedThisCapture = false;
  lastLiveMasks = [];
}

export const useMaskLayoutStore = create<MaskLayoutState>((set, get) => ({
  appliedLayout: null,

  keepApplied: () => set({ appliedLayout: null }),

  startFresh: () => {
    const applied = get().appliedLayout;
    set({ appliedLayout: null });
    if (!applied) return;
    const annotations = useAnnotationStore.getState();
    const ids = new Set(applied.ids);
    // removeMask one by one keeps the compositor transitions ordered
    for (const mask of annotations.masks.filter((m) => ids.has(m.id))) {
      useAnnotationStore.getState().removeMask(mask.id);
    }
    // Rejecting the remembered layout IS an edit to the memory — but in the
    // pre-flight the save-on-edit subscription is (correctly) gated on a live
    // share, so persist the rejection here or the exact masks the user just
    // dismissed come back on every future share of this source. Persist the
    // DELETION only: hand-placed pre-flight masks stay unsaved (saves are
    // gated on a live share precisely so a later cancel leaves no trace) —
    // if this share goes live, the debounced save remembers them then.
    const userId = useVoiceStore.getState().localUserId;
    if (userId) {
      saveMaskLayouts(userId, upsertMaskLayout(loadMaskLayouts(userId), applied.key, [], Date.now()));
    }
  },
}));

function applyLayoutForShare(sourceKey: string | null): void {
  const voice = useVoiceStore.getState();
  const userId = voice.localUserId;
  if (!userId || !sourceKey) return;
  const entry = findMaskLayout(loadMaskLayouts(userId), sourceKey);
  if (!entry || entry.masks.length === 0) return;

  applying = true;
  try {
    const annotations = useAnnotationStore.getState();
    // Fresh ids per application: stored ids could collide with masks the
    // sharer already placed by hand in this session
    const ids: string[] = [];
    for (const mask of entry.masks) {
      const id = crypto.randomUUID();
      ids.push(id);
      annotations.addMask({ ...mask, id });
    }
    useMaskLayoutStore.setState({ appliedLayout: { key: sourceKey, count: ids.length, ids } });
    saveMaskLayouts(userId, upsertMaskLayout(loadMaskLayouts(userId), sourceKey, entry.masks, Date.now()));
  } finally {
    applying = false;
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const voice = useVoiceStore.getState();
    // Only a live local share writes: mask edits made in a preflight or after
    // the share ended must not clobber the remembered layout for this key
    if (!voice.isScreenSharing || !voice.localUserId || !voice.screenShareSourceKey) return;
    const masks = useAnnotationStore.getState().masks;
    saveMaskLayouts(voice.localUserId, upsertMaskLayout(loadMaskLayouts(voice.localUserId), voice.screenShareSourceKey, masks, Date.now()));
  }, SAVE_DEBOUNCE_MS);
}

// ─── Lifecycle wiring ────────────────────────────────────────────────────────

// The layout applies as early as its source is known: in the PRE-FLIGHT when
// one opens (the modal shows the covers before anything ships), otherwise at
// share start (the skip-pre-flight path). Never twice for one capture; a
// cancelled pre-flight or an ended share clears the banner.
useVoiceStore.subscribe((state, prev) => {
  if (state.pendingShare && !prev.pendingShare) {
    appliedThisCapture = true;
    applyLayoutForShare(state.pendingShare.sourceKey);
  } else if (!state.pendingShare && prev.pendingShare && !state.isScreenSharing && !state.screenShareSourceKey) {
    // Pre-flight CANCELLED: confirmPendingShare stamps screenShareSourceKey in
    // the very same update it clears pendingShare, so a missing key here can
    // only be the cancel path (voiceStore clears the masks through the share
    // hooks; the banner goes with them).
    appliedThisCapture = false;
    useMaskLayoutStore.setState({ appliedLayout: null });
  }

  // Confirm went out but ACTIVATION FAILED (claim rejected, produce threw,
  // compositor refused): the key is cleared with no share having started. The
  // pendingShare-cleared edge above classified that update as a confirm, so
  // the cancel-side reset never ran — run it now or the stale banner and the
  // once-per-capture latch leak into the next capture.
  if (!state.screenShareSourceKey && prev.screenShareSourceKey && !state.isScreenSharing && !prev.isScreenSharing) {
    appliedThisCapture = false;
    useMaskLayoutStore.setState({ appliedLayout: null });
  }

  if (state.isScreenSharing && !prev.isScreenSharing) {
    if (!appliedThisCapture) applyLayoutForShare(state.screenShareSourceKey);
    appliedThisCapture = false; // consumed either way
    lastLiveMasks = useAnnotationStore.getState().masks;
  } else if (!state.isScreenSharing && prev.isScreenSharing) {
    // A debounced save may still be pending — it holds the last second of
    // mask edits before the stop. Flush it with the last LIVE mask list (the
    // store itself was already wiped by the annotationStore subscription).
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (prev.localUserId && prev.screenShareSourceKey) {
        saveMaskLayouts(prev.localUserId, upsertMaskLayout(loadMaskLayouts(prev.localUserId), prev.screenShareSourceKey, lastLiveMasks, Date.now()));
      }
    }
    resetMaskLayoutModuleState();
    useMaskLayoutStore.setState({ appliedLayout: null });
  }
});

// Mask edits while sharing → debounced save (skipping the auto-apply's own writes).
useAnnotationStore.subscribe((state, prev) => {
  if (state.masks === prev.masks || applying) return;
  if (!useVoiceStore.getState().isScreenSharing) return;
  lastLiveMasks = state.masks;
  scheduleSave();
});
