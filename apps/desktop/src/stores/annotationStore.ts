import { create } from 'zustand';
import {
  applyAnnotationOps,
  ANNOTATION_BATCH_INTERVAL_MS,
  ANNOTATION_MAX_OPS_PER_BATCH,
  ANNOTATION_OPS_MAX,
  ANNOTATION_ACK_TIMEOUT_MS,
  ANNOTATION_HISTORY_MAX,
  ANNOTATION_HISTORY_BYTES_MAX,
  ANNOTATION_FADE_AFTER_MS,
  type AnnotationOp,
  type AnnotationObject,
  type AnnotationScene,
} from '@voxium/shared';
import { inverseOf, addedIds, compactForward, entryBytes, type HistoryEntry } from '../utils/annotationHistory';
import { renumberOps } from '../utils/annotationCallouts';
import { loadAnnotationPrefs, saveAnnotationPrefs, pushRecentColor, clampTextSize, type InkMode } from '../utils/annotationPrefs';
import type { MaskStyle } from '../utils/maskStyles';
import { patchableKeysFor } from '@voxium/shared';
import { getSocket } from '../services/socket';
import { useVoiceStore, registerShareMaskHooks, isShareActivationInFlight } from './voiceStore';
import { toast } from './toastStore';
import i18n from '../i18n';
import { ensureComposite, stopComposite, teardownComposite, isCompositing, resumeSourceHold } from '../services/screenComposite';
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
  /** Fill style; absent = 'cover' (black). Pixelate/blur are COSMETIC. Local-only. */
  style?: MaskStyle;
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
  /** Pen/highlighter strokes vanish ~3 s after they are finished. Device pref. */
  inkMode: InkMode;
  /** Caption / badge size (fraction of frame height). Device pref. */
  textSize: number;
  /** Colours picked beyond the quick swatches, most recent first. Device pref. */
  recentColors: string[];
  /** Fill for NEW masks. Deliberately not persisted: Cover is the safe default every session. */
  maskStyle: MaskStyle;
  /** The shared source changed size while masks exist: the producer is paused
   *  and stays paused until the sharer confirms the covers are still right.
   *  Holds the old/new size for the banner. */
  sourceChangeHold: { fromW: number; fromH: number; toW: number; toH: number } | null;
  /** Renderable mirrors of the (module-level) undo/redo stacks. */
  canUndo: boolean;
  canRedo: boolean;

  // Viewer path
  /** `restarted`: the server's rev counter began a new generation (scene key
   *  lost mid-share) — take the snapshot wholesale and discard everything
   *  buffered from the previous generation. */
  hydrate: (channelId: string, rev: number, scene: AnnotationScene, restarted?: boolean) => void;
  applyRemoteOps: (channelId: string, rev: number, ops: AnnotationOp[]) => void;
  clearViewerScene: (opts?: { keepMasks?: boolean }) => void;

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
  setInkMode: (mode: InkMode) => void;
  /** The default for new objects — and, with a selection, that object's
   *  colour too (unless `selection: false`: a live picker drag previews the
   *  default only; the commit applies it). */
  setColor: (color: string, opts?: { recent?: boolean; selection?: boolean }) => void;
  /** The default for new captions/badges — and, with one selected, its size too. */
  setTextSize: (size: number) => void;
  /** The default for new masks — and, with a mask selected, that mask's style too. */
  setMaskStyle: (style: MaskStyle) => void;
  /** Per-viewer visibility of floating reactions (device pref). */
  showReactions: boolean;
  setShowReactions: (show: boolean) => void;
  /** "Masks are right — resume": the only way out of a source-change hold. */
  confirmSourceChange: () => void;
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
  /** The scene's objects when the gesture opened — a gesture that ends with
   *  the very same objects in the same order (a replaced-then-restored
   *  spotlight) changed nothing and records nothing. */
  before: AnnotationObject[];
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

function sameObjects(a: readonly AnnotationObject[], b: readonly AnnotationObject[]): boolean {
  return a.length === b.length && a.every((o, i) => o === b[i]);
}

function commitEntry(entry: OpenGesture, sceneAfter: AnnotationScene): void {
  if (sameObjects(entry.before, sceneAfter.objects)) return;
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

function persistPrefs(s: Pick<AnnotationState, 'inkMode' | 'textSize' | 'recentColors'>): void {
  // Merge over the stored copy: prefs this store does not own (skipPreflight
  // belongs to the pre-flight modal) must survive every write from here
  saveAnnotationPrefs({ ...loadAnnotationPrefs(), inkMode: s.inkMode, textSize: s.textSize, recentColors: s.recentColors });
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
  cancelVanishTimers();
}

// ─── Vanishing ink ───────────────────────────────────────────────────────────
// Two halves. The SHARER owns removal: ANNOTATION_FADE_AFTER_MS after a
// vanishing stroke is finished it ships an authoritative `remove`, so late
// joiners, old clients and the server's scene all drop it. EVERY client owns
// its own fade: a local clock per stroke (annotationLiveStore.fading),
// restarted by each append it sees, hides the stroke on time whether or not
// that remove has arrived. No timestamp travels.

const vanishTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleVanish(id: string): void {
  const existing = vanishTimers.get(id);
  if (existing) clearTimeout(existing);
  vanishTimers.set(id, setTimeout(() => {
    vanishTimers.delete(id);
    const store = useAnnotationStore.getState();
    if (!store.scene.objects.some((o) => o.id === id)) return; // already gone (undo, clear)
    store.localApply([{ t: 'remove', id }], { record: false });
    store.flushOps();
  }, ANNOTATION_FADE_AFTER_MS));
}

function cancelVanishTimers(): void {
  for (const timer of vanishTimers.values()) clearTimeout(timer);
  vanishTimers.clear();
}

/** Keep the live store's fade clocks in step with a scene transition. */
function trackFadeClocks(before: AnnotationScene, after: AnnotationScene, ops: AnnotationOp[]): void {
  const live = useAnnotationLiveStore.getState();
  const gone: string[] = [];
  for (const op of ops) {
    switch (op.t) {
      case 'add':
        if ((op.obj.kind === 'stroke' || op.obj.kind === 'arrow') && op.obj.fade) live.touchFading(op.obj.id);
        break;
      case 'append': {
        const target = after.objects.find((o) => o.id === op.id);
        if (target && target.kind === 'stroke' && target.fade) live.touchFading(op.id);
        break;
      }
      case 'update':
      case 'translate': {
        // Editing or moving a fading object restarts its clock — the last
        // touch is what the vanish countdown runs from, like a stroke's
        // last append
        const target = after.objects.find((o) => o.id === op.id);
        if (target && (target.kind === 'stroke' || target.kind === 'arrow') && target.fade) live.touchFading(op.id);
        break;
      }
      case 'remove':
        gone.push(op.id);
        break;
      case 'clear':
        for (const o of before.objects) gone.push(o.id);
        break;
    }
  }
  if (gone.length > 0) live.forgetFading(gone);
}

// ─── Mask → compositor sync ──────────────────────────────────────────────────
// Only the exists/none transition matters: the compositor samples getMasks()
// every frame, so geometry edits are live without another sync.

let lastMisalignToastAt = 0;

/** The compositor lifecycle callbacks — one set for the mid-share ensure path
 *  AND the pre-flight's pre-produce path, so holds, toasts and misalign hints
 *  behave identically however the session was born. */
function compositeLifecycleCallbacks(rawTrack: MediaStreamTrack) {
  return {
    rawTrack,
    getMasks: () => useAnnotationStore.getState().masks,
    onFatal: () => {
      toast.error(i18n.t('voice.annotations.maskFailed'));
    },
    onRestoreFailed: () => {
      toast.warning(i18n.t('voice.annotations.maskRestoreFailed'));
    },
    onSourceResize: () => {
      const now = Date.now();
      if (now - lastMisalignToastAt > 10_000) {
        lastMisalignToastAt = now;
        toast.warning(i18n.t('voice.annotations.masksMayMisalign'));
      }
    },
    onSourceHold: (change: { fromW: number; fromH: number; toW: number; toH: number }) => {
      useAnnotationStore.setState({ sourceChangeHold: change });
    },
  };
}

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
      ...compositeLifecycleCallbacks(rawTrack),
      replaceTrack: (track) => useVoiceStore.getState().replaceScreenVideoTrack(track),
      pauseProducer: () => useVoiceStore.getState().setScreenVideoProducerPaused(true),
      resumeProducer: () => useVoiceStore.getState().setScreenVideoProducerPaused(false),
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
  ...(() => {
    const prefs = loadAnnotationPrefs();
    return { inkMode: prefs.inkMode, textSize: prefs.textSize, recentColors: prefs.recentColors, showReactions: prefs.showReactions };
  })(),
  maskStyle: 'cover',
  sourceChangeHold: null,
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
    // A late joiner's clock for every vanishing stroke starts now — it sees
    // the stroke for up to ANNOTATION_FADE_AFTER_MS, then hides it locally
    // whether or not the sharer's remove reaches it
    const live = useAnnotationLiveStore.getState();
    for (const obj of next.objects) if (obj.kind === 'stroke' && obj.fade) live.touchFading(obj.id);
  },

  applyRemoteOps: (channelId, rev, ops) => {
    const state = get();
    if (state.sceneChannelId !== channelId) recentRemoteOps = [];
    recentRemoteOps.push({ rev, ops });
    if (recentRemoteOps.length > RECENT_OPS_LIMIT) recentRemoteOps.shift();
    // Stale or replayed batch (hydration snapshot already includes it)
    if (state.sceneChannelId === channelId && rev <= state.rev) return;
    const base = state.sceneChannelId === channelId ? state.scene : EMPTY_SCENE;
    const next = applyAnnotationOps(base, ops);
    set({ scene: next, rev, sceneChannelId: channelId });
    trackFadeClocks(base, next, ops);
  },

  clearViewerScene: (opts) => {
    resetQueue();
    recentRemoteOps = [];
    resetHistory();
    cancelVanishTimers();
    set((state) => ({
      scene: EMPTY_SCENE,
      rev: 0,
      sceneChannelId: null,
      isEditing: false,
      selectedObjectId: null,
      // keepMasks: a pre-flight is a PRIVATE mask-editing session — masks
      // being placed there belong to the UPCOMING share, not to whatever
      // share just started or stopped in the channel
      masks: opts?.keepMasks === true ? state.masks : [],
      sourceChangeHold: null,
      canUndo: false,
      canRedo: false,
    }));
  },

  localApply: (ops, opts) => {
    const state = get();
    const channelId = useVoiceStore.getState().activeChannelId;
    if (!channelId) return;
    const base = state.sceneChannelId === channelId ? state.scene : EMPTY_SCENE;
    const record = opts?.record !== false;
    let next: AnnotationScene | null = null;
    if (record) {
      // Inverses are computed op by op against the scene each op sees, so a
      // batch of [add, update] undoes correctly; collected in REVERSE so the
      // inverse list is already in application order. The last `working` IS
      // the post-batch scene — no second reducer pass.
      const entry = openGesture ?? { forward: [], inverse: [], added: new Set<string>(), before: base.objects };
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
      next = working;
    }
    next ??= applyAnnotationOps(base, ops);
    set({
      scene: next,
      sceneChannelId: channelId,
    });
    enqueue(ops);
    scheduleFlush();
    trackFadeClocks(base, next, ops);
    // A vanishing stroke added outside a drag (a redo, a resync) is finished
    // already — its removal is scheduled now; mid-drag ones wait for endGesture
    if (!openGesture) {
      for (const op of ops) {
        if (op.t === 'add' && (op.obj.kind === 'stroke' || op.obj.kind === 'arrow') && op.obj.fade) {
          scheduleVanish(op.obj.id);
        } else if (op.t === 'update' || op.t === 'translate') {
          // Editing a fading object restarts BOTH clocks: the client fade
          // (trackFadeClocks above) and the authoritative remove — otherwise
          // the alpha pops back to 1 and the object still vanishes on the
          // original schedule
          const touched = next.objects.find((o) => o.id === op.id);
          if (touched && (touched.kind === 'stroke' || touched.kind === 'arrow') && touched.fade) scheduleVanish(op.id);
        }
      }
    }
    if (record) syncHistoryFlags(set);
  },

  flushOps: () => {
    void doFlush();
  },

  beginGesture: () => {
    if (!openGesture) openGesture = { forward: [], inverse: [], added: new Set(), before: get().scene.objects };
  },

  endGesture: () => {
    const entry = openGesture;
    if (!entry) return;
    openGesture = null;
    const scene = get().scene;
    commitEntry(entry, scene);
    // Everything this drag finished OR touched starts a fresh countdown —
    // a move-gesture on a fading object restarted the client fade clocks,
    // so the authoritative remove must restart with them
    const touched = new Set<string>(entry.added);
    for (const op of entry.forward) {
      if (op.t === 'update' || op.t === 'translate' || op.t === 'append') touched.add(op.id);
    }
    for (const id of touched) {
      const obj = scene.objects.find((o) => o.id === id);
      if (obj && (obj.kind === 'stroke' || obj.kind === 'arrow') && obj.fade) scheduleVanish(id);
    }
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
  setInkMode: (inkMode) => {
    set({ inkMode });
    persistPrefs(get());
  },
  setColor: (color, opts) => {
    const { selectedObjectId, scene, recentColors } = get();
    const target = selectedObjectId && opts?.selection !== false ? scene.objects.find((o) => o.id === selectedObjectId) : undefined;
    if (target && patchableKeysFor(target.kind).includes('color') && (target as { color?: string }).color !== color) {
      get().localApply([{ t: 'update', id: target.id, patch: { color } }]); // its own undo step
      get().flushOps();
    }
    set({ color, ...(opts?.recent ? { recentColors: pushRecentColor(recentColors, color) } : {}) });
    if (opts?.recent) persistPrefs(get());
  },
  confirmSourceChange: () => {
    resumeSourceHold();
    set({ sourceChangeHold: null });
  },

  setMaskStyle: (maskStyle) => {
    const { selectedObjectId, masks } = get();
    if (selectedObjectId && masks.some((m) => m.id === selectedObjectId)) get().updateMask(selectedObjectId, { style: maskStyle });
    set({ maskStyle });
  },

  setShowReactions: (showReactions) => {
    set({ showReactions });
    // Direct merge-write (persistPrefs owns other fields): a partial save
    // must never drop prefs this store does not own
    saveAnnotationPrefs({ ...loadAnnotationPrefs(), showReactions });
  },
  setTextSize: (raw) => {
    const size = clampTextSize(raw);
    const { selectedObjectId, scene } = get();
    const target = selectedObjectId ? scene.objects.find((o) => o.id === selectedObjectId) : undefined;
    if (target && (target.kind === 'text' || target.kind === 'callout') && target.size !== size) {
      get().localApply([{ t: 'update', id: target.id, patch: { size } }]);
      get().flushOps();
    }
    set({ textSize: size });
    persistPrefs(get());
  },
  setStrokeWidth: (strokeWidth) => {
    // With a stroke/shape/arrow selected, its width follows too (own undo
    // step). `width` is a v2 patch key: never ship it to a v1 server.
    const { selectedObjectId, scene } = get();
    const v2 = useVoiceStore.getState().screenShareAnnotationsVersion >= 2;
    const target = selectedObjectId && v2 ? scene.objects.find((o) => o.id === selectedObjectId) : undefined;
    if (target && patchableKeysFor(target.kind).includes('width') && (target as { width?: number }).width !== strokeWidth) {
      get().localApply([{ t: 'update', id: target.id, patch: { width: strokeWidth } }]);
      get().flushOps();
    }
    set({ strokeWidth });
  },
  setSelectedObjectId: (selectedObjectId) => set({ selectedObjectId }),

  addMask: (mask) => {
    set((s) => ({ masks: [...s.masks, mask] }));
    syncCompositeToMasks();
  },
  updateMask: (id, patch) => set((s) => ({
    masks: s.masks.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  })),
  removeMask: (id) => {
    set((s) => {
      const masks = s.masks.filter((m) => m.id !== id);
      // With the last mask gone the compositor resumes the producer itself —
      // the banner must not outlive the hold
      return { masks, ...(masks.length === 0 ? { sourceChangeHold: null } : {}) };
    });
    syncCompositeToMasks();
  },
  clearMasks: () => {
    set({ masks: [], sourceChangeHold: null });
    syncCompositeToMasks();
  },

  teardownSharerSession: () => {
    // Flush nothing — the share is over; ship no trailing ops. The compositor
    // draw loop dies here too: this path also fires on teardowns that bypass
    // stopScreenShare (socket reconnect clears screen state directly).
    resetQueue();
    resetHistory();
    cancelVanishTimers();
    teardownComposite();
    // maskStyle goes back to Cover with the share: the safe default is per
    // SHARE, not per app start; a pending source-hold dies with the session
    set({ isEditing: false, selectedObjectId: null, masks: [], activeTool: 'pen', maskStyle: 'cover', sourceChangeHold: null, canUndo: false, canRedo: false });
  },
}));

// The pre-flight lives in voiceStore, which cannot import this module (it
// imports voiceStore at eval time — a cycle). It calls through these hooks:
registerShareMaskHooks({
  hasMasks: () => useAnnotationStore.getState().masks.length > 0,
  preflightCompositeHandles: (rawTrack) => compositeLifecycleCallbacks(rawTrack),
  clearPreflightMasks: () => {
    useAnnotationStore.getState().clearMasks();
  },
});

// ─── Cross-store lifecycle guard ─────────────────────────────────────────────
// Every existing screen-share teardown path (stop, leave, reconnect, stale-
// sharer reconciliation, sharer handoff) funnels through a change of
// voiceStore.screenSharingUserId — clearing here catches them all without
// touching each call site. A NEW sharer id also clears: the fresh share's
// scene arrives via hydration/ops.
useVoiceStore.subscribe((state, prevState) => {
  if (state.screenSharingUserId === prevState.screenSharingUserId) return;
  // OUR OWN share starting: the server's claim broadcast races the claim ack
  // (single-node the broadcast arrives first; multi-node either order), so
  // this fires while activateScreenShare is still mid-flight. Clearing here
  // would wipe the pre-flight masks BEFORE masksPreplaced is read — the raw
  // track gets produced — or, in the ack-first ordering, tear down the live
  // compositor under the producer. The pre-flight's masks and the compositor
  // session must survive the local user going live; everything they own is
  // torn down on the me→null transition when the share actually ends.
  if (state.screenSharingUserId !== null && state.screenSharingUserId === state.localUserId) return;
  const annotations = useAnnotationStore.getState();
  if (prevState.isScreenSharing) annotations.teardownSharerSession();
  // ANOTHER user's share starting or stopping while our pre-flight is open
  // must not delete the masks being placed — the slot is unclaimed for the
  // whole pre-flight, so this is an ordinary race, and going live afterwards
  // would read hasMasks() === false and produce the RAW track. The same holds
  // through the confirm→claim window (pendingShare already null, the claim
  // ack still in flight): a previous sharer's STOP broadcast landing there
  // wiped the masks the compositor was about to be built from.
  annotations.clearViewerScene({ keepMasks: state.pendingShare !== null || isShareActivationInFlight() });
  // Ephemeral overlay state dies with the share too (pointer, reactions)
  useAnnotationLiveStore.getState().clear();
});
