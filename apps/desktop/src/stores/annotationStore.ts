import { create } from 'zustand';
import {
  applyAnnotationOps,
  ANNOTATION_BATCH_INTERVAL_MS,
  ANNOTATION_MAX_OPS_PER_BATCH,
  ANNOTATION_ACK_TIMEOUT_MS,
  type AnnotationOp,
  type AnnotationScene,
} from '@voxium/shared';
import { getSocket } from '../services/socket';
import { useVoiceStore } from './voiceStore';
import { toast } from './toastStore';
import i18n from '../i18n';
import { ensureComposite, stopComposite, teardownComposite, isCompositing } from '../services/screenComposite';

/**
 * Screen-share annotation state (both roles):
 * - Viewer: the scene received from the sharer, rendered by AnnotationCanvas.
 * - Sharer: the same scene (local echo) plus editing state and privacy masks.
 *
 * Masks are LOCAL-ONLY: they are composited into the outgoing video at the
 * source (services/screenComposite) and must never enter the op queue — the
 * network never learns their geometry.
 */

export interface MaskRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional cover-image data URL; plain black box when absent. Local-only. */
  src?: string;
}

export type AnnotationEditorTool =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'image'
  | 'mask';

interface AnnotationState {
  // Shared (viewer + sharer)
  scene: AnnotationScene;
  rev: number;
  sceneChannelId: string | null;

  // Sharer editing state
  isEditing: boolean;
  activeTool: AnnotationEditorTool;
  color: string;
  /** Stroke width, normalized to frame height (wire units). */
  strokeWidth: number;
  selectedObjectId: string | null;
  masks: MaskRect[];

  // Viewer path
  hydrate: (channelId: string, rev: number, scene: AnnotationScene) => void;
  applyRemoteOps: (channelId: string, rev: number, ops: AnnotationOp[]) => void;
  clearViewerScene: () => void;

  // Sharer path
  localApply: (ops: AnnotationOp[]) => void;
  flushOps: () => void;
  undo: () => void;
  clearAll: () => void;
  setIsEditing: (editing: boolean) => void;
  setActiveTool: (tool: AnnotationEditorTool) => void;
  setColor: (color: string) => void;
  setStrokeWidth: (width: number) => void;
  setSelectedObjectId: (id: string | null) => void;
  addMask: (mask: MaskRect) => void;
  updateMask: (id: string, patch: Partial<Omit<MaskRect, 'id'>>) => void;
  removeMask: (id: string) => void;
  clearMasks: () => void;
  teardownSharerSession: () => void;
}

const EMPTY_SCENE: AnnotationScene = { objects: [] };

// ─── Op flush queue (module-level: not renderable state) ─────────────────────

let pendingOps: AnnotationOp[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Recent remote batches, kept so hydrate() can REPLAY ops that raced a scene
 * snapshot: a late joiner's ops can arrive before its voice:join hydration
 * (partial scene built on an empty base), and a scene-restart snapshot arrives
 * AFTER the ops of its own batch. Applying the snapshot then re-applying every
 * buffered batch with rev > snapshot.rev converges both orderings.
 */
const RECENT_OPS_LIMIT = 32;
let recentRemoteOps: Array<{ rev: number; ops: AnnotationOp[] }> = [];

/**
 * The server rebuilt the scene from empty (Redis loss / TTL / corrupt state):
 * viewers were re-baselined by the broadcast snapshot, but the sharer's local
 * scene still holds every pre-restart object the server no longer knows —
 * re-send the whole local scene so both sides converge on the sharer's truth.
 */
function resyncFullScene(): void {
  const { scene } = useAnnotationStore.getState();
  if (scene.objects.length === 0) return;
  console.warn('[Annotations] Server scene restarted — re-sending the local scene');
  enqueue([{ t: 'clear' }, ...scene.objects.map((obj) => ({ t: 'add', obj }) as AnnotationOp)]);
  scheduleFlush(); // the active drain loop (if any) picks the queue up itself
}

/** In-flight drain-loop state: the server's scene write is a non-atomic
 *  read-modify-write, so two concurrent batches from this socket could read
 *  the same stale scene and clobber each other's ops — batches must be
 *  strictly serialized on their acks. */
let sending = false;
let activeSendSettle: (() => void) | null = null;

function sendBatchAcked(channelId: string, ops: AnnotationOp[]): Promise<void> {
  return new Promise((resolve) => {
    const socket = getSocket();
    if (!socket) return resolve();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeSendSettle === settle) activeSendSettle = null;
      resolve();
    };
    // A lost ack must not wedge the queue forever
    const timer = setTimeout(() => {
      console.warn('[Annotations] Batch ack timed out — continuing');
      settle();
    }, ANNOTATION_ACK_TIMEOUT_MS);
    activeSendSettle = settle;
    socket.emit('voice:annotation:ops', { channelId, ops }, (response) => {
      if (!response?.ok) {
        // EVERY rejection must be visible: the local echo already applied
        // these ops, so from here on the sharer's canvas shows things the
        // viewers will never receive — silence would hide the divergence.
        console.warn('[Annotations] Batch rejected:', response?.error);
        toast.error(i18n.t(response?.error === 'Scene limit reached'
          ? 'voice.annotations.sceneFull'
          : 'voice.annotations.syncError'));
      } else if (response.restarted) {
        resyncFullScene();
      }
      settle();
    });
  });
}

async function doFlush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (sending) return; // the active drain loop picks up the queue tail
  sending = true;
  try {
    while (pendingOps.length > 0) {
      const channelId = useVoiceStore.getState().activeChannelId;
      if (!channelId) {
        pendingOps = []; // left voice mid-draw — nothing to annotate anymore
        break;
      }
      const chunk = pendingOps.splice(0, ANNOTATION_MAX_OPS_PER_BATCH);
      await sendBatchAcked(channelId, chunk);
    }
  } finally {
    sending = false;
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(doFlush, ANNOTATION_BATCH_INTERVAL_MS);
}

/**
 * Enqueue with coalescing: a 60Hz drag emits one update per mousemove, but
 * only the latest patch per object matters — merge into the tail op instead
 * of flooding the batch. Same for consecutive stroke appends.
 */
function enqueue(ops: AnnotationOp[]): void {
  for (const op of ops) {
    const tail = pendingOps[pendingOps.length - 1];
    if (tail && op.t === 'update' && tail.t === 'update' && tail.id === op.id) {
      pendingOps[pendingOps.length - 1] = { t: 'update', id: op.id, patch: { ...tail.patch, ...op.patch } };
    } else if (tail && op.t === 'append' && tail.t === 'append' && tail.id === op.id) {
      pendingOps[pendingOps.length - 1] = { t: 'append', id: op.id, points: [...tail.points, ...op.points] };
    } else {
      pendingOps.push(op);
    }
  }
}

function resetQueue(): void {
  pendingOps = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Unblock an in-flight drain so it observes the empty queue and exits
  activeSendSettle?.();
}

// ─── Mask → compositor sync ──────────────────────────────────────────────────
// Only the exists/none transition matters: the compositor samples getMasks()
// every frame, so geometry edits are live without another sync.

let lastMisalignToastAt = 0;

function syncCompositeToMasks(): void {
  const voice = useVoiceStore.getState();
  if (!voice.isScreenSharing || !voice.screenStream) return;
  const rawTrack = voice.screenStream.getVideoTracks()[0];
  if (!rawTrack) return;
  if (useAnnotationStore.getState().masks.length > 0) {
    // The privacy gate must land NOW, not when ensureComposite's turn in the
    // transition queue comes up — a queued stop/ensure pair would otherwise
    // leave raw frames flowing while a mask exists. Idempotent; skipped when a
    // live session is already compositing (pausing then would freeze the share
    // with nobody left to resume it).
    if (!isCompositing()) {
      useVoiceStore.getState().setScreenVideoProducerPaused(true);
    }
    void ensureComposite({
      rawTrack,
      getMasks: () => useAnnotationStore.getState().masks,
      replaceTrack: (track) => useVoiceStore.getState().replaceScreenVideoTrack(track),
      pauseProducer: () => useVoiceStore.getState().setScreenVideoProducerPaused(true),
      resumeProducer: () => useVoiceStore.getState().setScreenVideoProducerPaused(false),
      onFatal: () => {
        // The producer is left PAUSED (viewers see a frozen frame, never the
        // content under the mask) — the sharer must know why, and that
        // removing the mask unfreezes the share.
        toast.error(i18n.t('voice.annotations.maskFailed'));
      },
      onSourceResize: () => {
        // Source resolution changed (window switch) — masks re-project but the
        // content underneath moved. Debounced: live window-resizing fires this
        // once per dimension step.
        const now = Date.now();
        if (now - lastMisalignToastAt > 10_000) {
          lastMisalignToastAt = now;
          toast.warning(i18n.t('voice.annotations.masksMayMisalign'));
        }
      },
    });
  } else {
    void stopComposite();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  scene: EMPTY_SCENE,
  rev: 0,
  sceneChannelId: null,

  isEditing: false,
  activeTool: 'pen',
  color: '#ff3b30',
  strokeWidth: 0.004,
  selectedObjectId: null,
  masks: [],

  hydrate: (channelId, rev, scene) => {
    // Replay buffered batches NEWER than the snapshot: ops that raced ahead of
    // a voice:join hydration (applied to an empty base) or that follow a
    // scene-restart snapshot. The snapshot always includes its own batch, so
    // only rev > snapshot.rev is re-applied — never a double-apply.
    const buffered = get().sceneChannelId === channelId
      ? recentRemoteOps.filter((b) => b.rev > rev).sort((a, b) => a.rev - b.rev)
      : [];
    let next = scene;
    let maxRev = rev;
    for (const batch of buffered) {
      next = applyAnnotationOps(next, batch.ops);
      maxRev = Math.max(maxRev, batch.rev);
    }
    set({ scene: next, rev: maxRev, sceneChannelId: channelId });
  },

  applyRemoteOps: (channelId, rev, ops) => {
    const state = get();
    if (state.sceneChannelId !== channelId) recentRemoteOps = [];
    recentRemoteOps.push({ rev, ops });
    if (recentRemoteOps.length > RECENT_OPS_LIMIT) recentRemoteOps.shift();
    // Stale or replayed batch (hydration snapshot already includes it)
    if (state.sceneChannelId === channelId && rev <= state.rev) return;
    const base = state.sceneChannelId === channelId ? state.scene : EMPTY_SCENE;
    set({ scene: applyAnnotationOps(base, ops), rev, sceneChannelId: channelId });
  },

  clearViewerScene: () => {
    resetQueue();
    recentRemoteOps = [];
    set({
      scene: EMPTY_SCENE,
      rev: 0,
      sceneChannelId: null,
      isEditing: false,
      selectedObjectId: null,
      masks: [],
    });
  },

  localApply: (ops) => {
    const state = get();
    const channelId = useVoiceStore.getState().activeChannelId;
    if (!channelId) return;
    set({
      scene: applyAnnotationOps(state.sceneChannelId === channelId ? state.scene : EMPTY_SCENE, ops),
      sceneChannelId: channelId,
    });
    enqueue(ops);
    scheduleFlush();
  },

  flushOps: () => {
    void doFlush();
  },

  undo: () => {
    const { scene } = get();
    const last = scene.objects[scene.objects.length - 1];
    if (!last) return;
    get().localApply([{ t: 'remove', id: last.id }]);
    get().flushOps();
  },

  clearAll: () => {
    get().localApply([{ t: 'clear' }]);
    get().flushOps();
    set({ selectedObjectId: null });
  },

  setIsEditing: (isEditing) => set({ isEditing, ...(isEditing ? {} : { selectedObjectId: null }) }),
  setActiveTool: (activeTool) => set({ activeTool, selectedObjectId: null }),
  setColor: (color) => set({ color }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
  setSelectedObjectId: (selectedObjectId) => set({ selectedObjectId }),

  addMask: (mask) => {
    set((s) => ({ masks: [...s.masks, mask] }));
    syncCompositeToMasks();
  },
  updateMask: (id, patch) => set((s) => ({
    masks: s.masks.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  })),
  removeMask: (id) => {
    set((s) => ({ masks: s.masks.filter((m) => m.id !== id) }));
    syncCompositeToMasks();
  },
  clearMasks: () => {
    set({ masks: [] });
    syncCompositeToMasks();
  },

  teardownSharerSession: () => {
    // Flush nothing — the share is over; ship no trailing ops. The compositor
    // draw loop dies here too: this path also fires on teardowns that bypass
    // stopScreenShare (socket reconnect clears screen state directly).
    resetQueue();
    teardownComposite();
    set({ isEditing: false, selectedObjectId: null, masks: [], activeTool: 'pen' });
  },
}));

// ─── Cross-store lifecycle guard ─────────────────────────────────────────────
// Every existing screen-share teardown path (stop, leave, reconnect, stale-
// sharer reconciliation, sharer handoff) funnels through a change of
// voiceStore.screenSharingUserId — clearing here catches them all without
// touching each call site. A NEW sharer id also clears: the fresh share's
// scene arrives via hydration/ops.
useVoiceStore.subscribe((state, prevState) => {
  if (state.screenSharingUserId === prevState.screenSharingUserId) return;
  const annotations = useAnnotationStore.getState();
  if (prevState.isScreenSharing) annotations.teardownSharerSession();
  annotations.clearViewerScene();
});
