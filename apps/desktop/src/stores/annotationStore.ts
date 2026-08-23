import { create } from 'zustand';
import {
  applyAnnotationOps,
  ANNOTATION_BATCH_INTERVAL_MS,
  ANNOTATION_MAX_OPS_PER_BATCH,
  ANNOTATION_OPS_MAX,
  ANNOTATION_ACK_TIMEOUT_MS,
  ANNOTATION_HISTORY_MAX,
  ANNOTATION_HISTORY_BYTES_MAX,
  type AnnotationOp,
  type AnnotationScene,
} from '@voxium/shared';
import { inverseOf, addedIds, compactForward, entryBytes, type HistoryEntry } from '../utils/annotationHistory';
import { renumberOps } from '../utils/annotationCallouts';
import { getSocket } from '../services/socket';
import { useVoiceStore } from './voiceStore';
import { toast } from './toastStore';
import i18n from '../i18n';
import { ensureComposite, stopComposite, teardownComposite, isCompositing } from '../services/screenComposite';
import { useAnnotationLiveStore } from './annotationLiveStore';

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
  | 'arrow'
  | 'callout'
  | 'spotlight'
  | 'text'
  | 'image'
  | 'laser'
  | 'eraser'
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
  /** Renderable mirrors of the (module-level) undo/redo stacks. */
  canUndo: boolean;
  canRedo: boolean;

  // Viewer path
  /** `restarted`: the server's rev counter began a new generation (scene key
   *  lost mid-share) — take the snapshot wholesale and discard everything
   *  buffered from the previous generation. */
  hydrate: (channelId: string, rev: number, scene: AnnotationScene, restarted?: boolean) => void;
  applyRemoteOps: (channelId: string, rev: number, ops: AnnotationOp[]) => void;
  clearViewerScene: () => void;

  // Sharer path
  /** Apply locally, enqueue for the wire, and (unless `record: false`) record
   *  the inverse in the history — into the open gesture if there is one. */
  localApply: (ops: AnnotationOp[], opts?: { record?: boolean }) => void;
  flushOps: () => void;
  /** Bracket a drag so its many ops form ONE history entry. Nested begins
   *  are absorbed; a begin while one is open just continues it. */
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  clearAll: () => void;
  /** Re-sequence every callout 1..N in reading order, as one undo step. */
  renumberCallouts: () => void;
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

/**
 * Take the next batch off the queue, bounded by BOTH server caps: op count
 * (ANNOTATION_MAX_OPS_PER_BATCH) and serialized size (ANNOTATION_OPS_MAX).
 * Sixty-four image adds are 23 MB against a 400K-char batch cap — chunking by
 * count alone had every such batch rejected after the local echo already
 * painted it. Reachable through a scene-restart resync and through undoing a
 * clear, both of which re-send whole objects.
 *
 * A single op that cannot fit any batch is dropped here with the same toast a
 * server rejection would show: sending it would only get it rejected.
 */
export function takeNextBatch(): AnnotationOp[] {
  const batch: AnnotationOp[] = [];
  let chars = 2; // "[]"
  while (pendingOps.length > 0 && batch.length < ANNOTATION_MAX_OPS_PER_BATCH) {
    const op = pendingOps[0];
    const opChars = JSON.stringify(op).length + (batch.length > 0 ? 1 : 0); // + ","
    if (chars + opChars > ANNOTATION_OPS_MAX) {
      if (batch.length === 0) {
        // Oversized on its own — never sendable
        pendingOps.shift();
        console.warn('[Annotations] Dropping an op larger than a whole batch');
        toast.error(i18n.t('voice.annotations.sceneFull'));
        continue;
      }
      break;
    }
    pendingOps.shift();
    batch.push(op);
    chars += opChars;
  }
  return batch;
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
      const chunk = takeNextBatch();
      if (chunk.length === 0) continue; // only oversized ops were dropped
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
    } else if (tail && op.t === 'translate' && tail.t === 'translate' && tail.id === op.id) {
      // A drag is one translate per mousemove; the wire (and the 600/min ops
      // bucket) only needs the sum
      pendingOps[pendingOps.length - 1] = { t: 'translate', id: op.id, dx: tail.dx + op.dx, dy: tail.dy + op.dy };
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

// ─── Undo/redo history (module-level: not renderable state) ──────────────────
// Entries are per GESTURE (see utils/annotationHistory). `openGesture`
// accumulates while the editor holds a drag; everything else is committed as
// its own entry. The store exposes only canUndo/canRedo for rendering.

interface OpenGesture {
  forward: AnnotationOp[];
  inverse: AnnotationOp[];
  added: Set<string>;
}

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let openGesture: OpenGesture | null = null;

function historyBytes(): number {
  let total = 0;
  for (const e of undoStack) total += e.bytes;
  for (const e of redoStack) total += e.bytes;
  return total;
}

function commitEntry(entry: OpenGesture, sceneAfter: AnnotationScene): void {
  const forward = compactForward(entry.forward, entry.added, sceneAfter);
  // Compaction only ever drops ops on objects the gesture itself added, so an
  // empty forward means every one of them is gone again (a degenerate
  // click-shape discarded on pointerup): the scene is what it was, the
  // inverse would net to nothing — no entry, and no stale redo either.
  if (forward.length === 0) return;
  undoStack.push({ forward, inverse: entry.inverse, bytes: entryBytes(forward, entry.inverse) });
  redoStack = []; // a fresh action forks the timeline
  // Two bounds, oldest dropped first: entries, and bytes — an undone `clear`
  // retains every object it removed, images included
  if (undoStack.length > ANNOTATION_HISTORY_MAX) undoStack.splice(0, undoStack.length - ANNOTATION_HISTORY_MAX);
  while (undoStack.length > 1 && historyBytes() > ANNOTATION_HISTORY_BYTES_MAX) undoStack.shift();
}

function syncHistoryFlags(set: (partial: Partial<AnnotationState>) => void): void {
  set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  openGesture = null;
}

/**
 * Everything this module keeps OUTSIDE the zustand slice: the op queue, the
 * remote-batch buffer, the history. `resetAccountStores` replaces the slice
 * but cannot see these — and must not depend on the voiceStore subscription
 * below happening to fire first.
 */
export function resetAnnotationModuleState(): void {
  resetQueue();
  recentRemoteOps = [];
  resetHistory();
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
      onRestoreFailed: () => {
        // Masks are gone and the share is still live — it is just still going
        // out through the compositor. A warning, not an error: nothing the
        // sharer must act on, but they should know why their CPU is busy.
        toast.warning(i18n.t('voice.annotations.maskRestoreFailed'));
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
  canUndo: false,
  canRedo: false,

  hydrate: (channelId, rev, scene, restarted = false) => {
    // A restart snapshot opens a NEW rev generation: every buffered batch is
    // from the old one, and "rev > snapshot.rev" is true of all of them — the
    // exact comparison that, for a join-race snapshot, correctly selects the
    // batches that raced ahead. Replaying them here rebuilt the pre-restart
    // scene on top of the fresh one and pinned rev at the old maximum, so the
    // sharer's resync (rev 2, 3, …) was dropped as stale for the rest of the
    // share. Revs cannot tell the two apart; the flag can.
    if (restarted) recentRemoteOps = [];
    // Replay buffered batches NEWER than the snapshot: ops that raced ahead of
    // a voice:join hydration (applied to an empty base), or that arrived after
    // a restart snapshot was taken. The snapshot always includes its own
    // batch, so only rev > snapshot.rev is re-applied — never a double-apply.
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
    resetHistory();
    set({
      scene: EMPTY_SCENE,
      rev: 0,
      sceneChannelId: null,
      isEditing: false,
      selectedObjectId: null,
      masks: [],
      canUndo: false,
      canRedo: false,
    });
  },

  localApply: (ops, opts) => {
    const state = get();
    const channelId = useVoiceStore.getState().activeChannelId;
    if (!channelId) return;
    const base = state.sceneChannelId === channelId ? state.scene : EMPTY_SCENE;
    const record = opts?.record !== false;
    if (record) {
      // Inverses are computed op by op against the scene each op sees, so a
      // batch of [add, update] undoes correctly; collected in REVERSE so the
      // inverse list is already in application order.
      const entry = openGesture ?? { forward: [], inverse: [], added: new Set<string>() };
      let working = base;
      const inverses: AnnotationOp[][] = [];
      for (const op of ops) {
        inverses.push(inverseOf(op, working, entry.added));
        for (const id of addedIds([op])) entry.added.add(id);
        working = applyAnnotationOps(working, [op]);
      }
      entry.forward.push(...ops);
      entry.inverse.unshift(...inverses.reverse().flat());
      if (!openGesture) commitEntry(entry, working);
    }
    set({
      scene: applyAnnotationOps(base, ops),
      sceneChannelId: channelId,
    });
    enqueue(ops);
    scheduleFlush();
    if (record) syncHistoryFlags(set);
  },

  flushOps: () => {
    void doFlush();
  },

  beginGesture: () => {
    if (!openGesture) openGesture = { forward: [], inverse: [], added: new Set() };
  },

  endGesture: () => {
    const entry = openGesture;
    if (!entry) return;
    openGesture = null;
    commitEntry(entry, get().scene);
    syncHistoryFlags(set);
  },

  undo: () => {
    get().endGesture(); // a drag still in progress counts as done
    // localApply is a silent no-op without a voice channel — the entry must
    // not change stacks unless it is actually applied
    if (!useVoiceStore.getState().activeChannelId) return;
    const entry = undoStack.pop();
    if (!entry) return;
    get().localApply(entry.inverse, { record: false });
    redoStack.push(entry);
    get().flushOps();
    set({ selectedObjectId: null });
    syncHistoryFlags(set);
  },

  redo: () => {
    get().endGesture();
    if (!useVoiceStore.getState().activeChannelId) return;
    const entry = redoStack.pop();
    if (!entry) return;
    get().localApply(entry.forward, { record: false });
    undoStack.push(entry);
    get().flushOps();
    set({ selectedObjectId: null });
    syncHistoryFlags(set);
  },

  clearAll: () => {
    get().localApply([{ t: 'clear' }]);
    get().flushOps();
    set({ selectedObjectId: null });
  },

  renumberCallouts: () => {
    const ops = renumberOps(get().scene.objects);
    if (ops.length === 0) return;
    get().localApply(ops); // one batch = one history entry
    get().flushOps();
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
    resetHistory();
    teardownComposite();
    set({ isEditing: false, selectedObjectId: null, masks: [], activeTool: 'pen', canUndo: false, canRedo: false });
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
  // Ephemeral overlay state dies with the share too (pointer, reactions)
  useAnnotationLiveStore.getState().clear();
});
