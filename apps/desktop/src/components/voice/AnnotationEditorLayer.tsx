import { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ANNOTATION_STROKE_MAX_POINTS, ANNOTATION_TEXT_MAX, ANNOTATION_CALLOUT_MAX } from '@voxium/shared';
import type { AnnotationObject } from '@voxium/shared';
import { useAnnotationStore, type AnnotationEditorTool } from '../../stores/annotationStore';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';
import { useVideoContentRect } from '../../hooks/useVideoContentRect';
import { useTextDraft } from '../../hooks/useTextDraft';
import { isEditableTarget } from '../../hooks/useAnnotationShortcuts';
import { pxToNorm } from '../../utils/annotationGeometry';
import { normBox, clampBox, clampPos, clampTranslation, objectBbox, hitTestBox, topmostHit, type Bbox } from '../../utils/annotationHit';
import { nextCalloutNumber } from '../../utils/annotationCallouts';
import { toast } from '../../stores/toastStore';
import { processOverlayImage } from '../../utils/imageProcessing';

export { sanitizeAnnotationText } from '../../hooks/useTextDraft';

/**
 * The sharer's input surface: an absolutely positioned layer over the video
 * content rect that turns pointer gestures into annotation ops (broadcast) or
 * mask edits (local-only). AnnotationCanvas below it does all the painting.
 *
 * The layer never decides WHO it is for — `capabilities` does. The sharer
 * passes everything; the pre-share preview passes masks only; a viewer with
 * drawing rights would pass a handful of marking tools. Anything outside the
 * set is ignored at pointerdown, so a stale activeTool cannot leak through.
 */

export interface ToolCapabilities {
  tools: ReadonlySet<AnnotationEditorTool>;
  /** Privacy masks (local-only compositing). */
  masks: boolean;
  /** Image overlays (the file picker). */
  images: boolean;
}

export const ALL_EDITOR_TOOLS: readonly AnnotationEditorTool[] = [
  'select', 'pen', 'highlighter', 'rect', 'ellipse', 'arrow', 'callout', 'spotlight', 'text', 'image', 'laser', 'eraser', 'mask',
];

export const ALL_TOOL_CAPABILITIES: ToolCapabilities = {
  tools: new Set(ALL_EDITOR_TOOLS),
  masks: true,
  images: true,
};

interface AnnotationEditorLayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  capabilities?: ToolCapabilities;
}

const MIN_DRAG_NORM = 0.005;
/** px of pointer travel before a new stroke point is recorded */
const MIN_STROKE_STEP_PX = 2;
const TEXT_SIZE = 0.045;
/** Callout badge diameter, in frame units. */
const CALLOUT_SIZE = 0.06;
const HIGHLIGHTER_WIDTH_FACTOR = 4;

/** Kinds a plain click can select and drag. Strokes join this list with the
 *  eraser/stroke-editing work; until then they are paint only. */
const SELECTABLE_KINDS: ReadonlySet<AnnotationObject['kind']> = new Set(['shape', 'image', 'text', 'arrow', 'callout', 'spotlight']);

/** Kinds whose position is NOT a box corner: moved with `translate`, so the
 *  geometry (stroke points, arrow endpoints, a badge centre) shifts as one. */
const TRANSLATE_KINDS: ReadonlySet<AnnotationObject['kind']> = new Set(['stroke', 'arrow', 'callout']);

type DragState =
  | { mode: 'stroke'; id: string; lastPx: { x: number; y: number }; pointCount: number }
  /** Two-point gestures: the object is created at pointerdown and reshaped
   *  from `start` to the current pointer on every move. `target` says what
   *  the second point reshapes — a box (normalized, inverted drags allowed),
   *  a mask (same, local-only), or an arrow's tip (direction kept). */
  | {
      mode: 'create'; id: string; target: 'box' | 'mask' | 'arrow'; start: { x: number; y: number };
      /** Objects this gesture replaced (the previous spotlight): put back if
       *  the new one turns out degenerate, so a stray click costs nothing. */
      replaced?: { obj: AnnotationObject; at: number }[];
    }
  /** Box-anchored kinds: the patch sets x/y from the grab offset. */
  | { mode: 'move'; id: string; isMask: boolean; grabOffset: { x: number; y: number } }
  /** TRANSLATE_KINDS: each move ships the delta since the last one, clamped
   *  so the object's box stays inside the wire bounds. */
  | { mode: 'translate'; id: string; last: { x: number; y: number } }
  | { mode: 'resize'; id: string; isMask: boolean; anchor: { x: number; y: number } }
  /** Dragging one end of an arrow. */
  | { mode: 'arrow-end'; id: string; end: 1 | 2 };

export function AnnotationEditorLayer({ videoRef, capabilities = ALL_TOOL_CAPABILITIES }: AnnotationEditorLayerProps) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const rect = useVideoContentRect(videoRef);

  const activeTool = useAnnotationStore((s) => s.activeTool);
  const color = useAnnotationStore((s) => s.color);
  const strokeWidth = useAnnotationStore((s) => s.strokeWidth);
  const selectedObjectId = useAnnotationStore((s) => s.selectedObjectId);
  const scene = useAnnotationStore((s) => s.scene);
  const masks = useAnnotationStore((s) => s.masks);

  const canUse = (tool: AnnotationEditorTool) => capabilities.tools.has(tool);

  // A drag opens a gesture on pointerdown and closes it on pointerup. If the
  // layer unmounts in between (panel collapse, view-mode toggle, the video
  // rect going to zero) no pointerup ever arrives, and the gesture — which is
  // store-level state — would swallow everything drawn afterwards into one
  // undo step. Close it with the layer.
  useEffect(() => () => useAnnotationStore.getState().endGesture(), []);

  // The laser follows the cursor whenever the tool is active (no button held)
  // and goes out when the cursor leaves the stage, the tool changes, or the
  // layer unmounts — a lost pointer-off only costs viewers a 700 ms fade.
  const laserActive = activeTool === 'laser' && canUse('laser');
  useEffect(() => {
    if (!laserActive) return;
    return () => useAnnotationLiveStore.getState().pointerOff();
  }, [laserActive]);

  const text = useTextDraft((draft, value) => {
    const store = useAnnotationStore.getState();
    if (draft.editingId) {
      // Editing an existing object: a callout's number (a caption's text
      // arrives with the stroke-editing work)
      const target = store.scene.objects.find((o) => o.id === draft.editingId);
      if (!target) return;
      if (target.kind === 'callout') {
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n < 1 || n > ANNOTATION_CALLOUT_MAX || n === target.n) return;
        store.localApply([{ t: 'update', id: target.id, patch: { n } }]);
        store.flushOps();
      }
      return;
    }
    if (!value) return;
    store.localApply([{
      t: 'add',
      obj: { id: crypto.randomUUID(), kind: 'text', text: value, color: store.color, size: TEXT_SIZE, x: draft.x, y: draft.y },
    }]);
    store.flushOps();
  });

  /** Pointer event → normalized frame coords. */
  const toNorm = useCallback((e: { clientX: number; clientY: number }, clampToFrame = false) => {
    const layer = layerRef.current;
    if (!layer) return { x: 0, y: 0 };
    const box = layer.getBoundingClientRect();
    return pxToNorm(e.clientX - box.left, e.clientY - box.top, { x: 0, y: 0, w: box.width, h: box.height }, clampToFrame);
  }, []);

  // The image tool is a file dialog, not a canvas gesture. Reset the tool
  // immediately after opening the picker: cancelling the dialog fires no
  // 'change' event, and since re-clicking the same tool doesn't re-trigger
  // this effect, the toolbar would otherwise wedge on an inert 'image' tool.
  const imagesAllowed = capabilities.images && capabilities.tools.has('image');
  useEffect(() => {
    if (activeTool === 'image') {
      if (imagesAllowed) fileInputRef.current?.click();
      useAnnotationStore.getState().setActiveTool('select');
    }
  }, [activeTool, imagesAllowed]);

  const handleImagePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const store = useAnnotationStore.getState();
    store.setActiveTool('select');
    if (!file) return;
    try {
      const processed = await processOverlayImage(file);
      if (!processed) {
        toast.error(t('voice.annotations.imageTooLarge'));
        return;
      }
      // ~25% of frame width, aspect preserved in frame-normalized units.
      // Tall images can push h past the wire bounds (h = w·ratio·frameAspect
      // has no intrinsic cap) — shrink both dims so the op stays valid.
      const frameAspect = rect.h > 0 ? rect.w / rect.h : 16 / 9;
      let w = 0.25;
      let h = w * (processed.height / processed.width) * frameAspect;
      if (h > 0.9) {
        w *= 0.9 / h;
        h = 0.9;
      }
      const id = crypto.randomUUID();
      store.localApply([{ t: 'add', obj: { id, kind: 'image', src: processed.dataUrl, x: 0.5 - w / 2, y: 0.5 - h / 2, w, h } }]);
      store.flushOps();
      store.setSelectedObjectId(id);
    } catch (err) {
      console.error('[Annotations] Overlay image processing failed:', err);
      toast.error(t('voice.annotations.imageTooLarge'));
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const store = useAnnotationStore.getState();
    const norm = toNorm(e, true);

    // An open caption is finished by the next press anywhere on the layer,
    // whatever the tool — decided here, not left to the input's blur, whose
    // timing against this handler is the browser's business (see below).
    if (text.draftRef.current) {
      text.commit();
      if (activeTool === 'text') return;
    }

    if (!canUse(activeTool)) return;
    layerRef.current?.setPointerCapture(e.pointerId);

    switch (activeTool) {
      case 'pen':
      case 'highlighter': {
        store.beginGesture(); // the whole stroke is ONE undo step
        const id = crypto.randomUUID();
        store.localApply([{
          t: 'add',
          obj: {
            id,
            kind: 'stroke',
            tool: activeTool,
            color,
            width: activeTool === 'highlighter' ? Math.min(0.05, strokeWidth * HIGHLIGHTER_WIDTH_FACTOR) : strokeWidth,
            points: [norm.x, norm.y],
          },
        }]);
        dragRef.current = { mode: 'stroke', id, lastPx: { x: e.clientX, y: e.clientY }, pointCount: 1 };
        break;
      }
      case 'rect':
      case 'ellipse': {
        store.beginGesture();
        const id = crypto.randomUUID();
        store.localApply([{
          t: 'add',
          obj: { id, kind: 'shape', shape: activeTool, color, width: strokeWidth, x: norm.x, y: norm.y, w: 0, h: 0, fill: false },
        }]);
        dragRef.current = { mode: 'create', id, target: 'box', start: norm };
        break;
      }
      case 'arrow': {
        store.beginGesture();
        const id = crypto.randomUUID();
        store.localApply([{
          t: 'add',
          // Shift at the start of the drag = heads at both ends
          obj: { id, kind: 'arrow', color, width: strokeWidth, x1: norm.x, y1: norm.y, x2: norm.x, y2: norm.y, ...(e.shiftKey ? { heads: 'both' as const } : {}) },
        }]);
        dragRef.current = { mode: 'create', id, target: 'arrow', start: norm };
        break;
      }
      case 'callout': {
        const n = nextCalloutNumber(scene.objects);
        if (n === null) {
          toast.error(t('voice.annotations.calloutLimit', { max: ANNOTATION_CALLOUT_MAX }));
          break;
        }
        const id = crypto.randomUUID();
        // One add = one history entry; a click has no drag to bracket
        store.localApply([{ t: 'add', obj: { id, kind: 'callout', color, size: CALLOUT_SIZE, x: norm.x, y: norm.y, n } }]);
        store.flushOps();
        store.setSelectedObjectId(id);
        break;
      }
      case 'spotlight': {
        // One spotlight per scene: a new one replaces the old in the same
        // gesture (one undo step). Shift at the start = elliptical cut-out.
        store.beginGesture();
        const id = crypto.randomUUID();
        const replaced = scene.objects.map((obj, at) => ({ obj, at })).filter(({ obj }) => obj.kind === 'spotlight');
        store.localApply([
          ...replaced.map(({ obj }) => ({ t: 'remove' as const, id: obj.id })),
          { t: 'add', obj: { id, kind: 'spotlight', x: norm.x, y: norm.y, w: 0, h: 0, ...(e.shiftKey ? { shape: 'ellipse' as const } : {}) } },
        ]);
        dragRef.current = { mode: 'create', id, target: 'box', start: norm, replaced };
        break;
      }
      case 'mask': {
        if (!capabilities.masks) break;
        const id = crypto.randomUUID();
        store.addMask({ id, x: norm.x, y: norm.y, w: 0, h: 0 });
        dragRef.current = { mode: 'create', id, target: 'mask', start: norm };
        break;
      }
      case 'text': {
        // The draft input mounts (and autofocuses) in React's commit right
        // after this handler — BEFORE the browser fires the compatibility
        // mousedown for this same press. Its default action moves focus to
        // the nearest focusable ancestor, and this layer has none, so the
        // fresh input blurred to <body> and committed its empty draft before
        // a single character could be typed. Cancelling pointerdown is the
        // spec'd way to suppress that mousedown (click still fires).
        e.preventDefault();
        text.open(norm.x, norm.y);
        break;
      }
      case 'select': {
        // Annotations first (drawn on top), then masks
        const hitObj = topmostHit(scene.objects, norm.x, norm.y, (o) => SELECTABLE_KINDS.has(o.kind));
        if (hitObj) {
          store.setSelectedObjectId(hitObj.id);
          store.beginGesture(); // a move is one undo step however many updates it sends
          if (TRANSLATE_KINDS.has(hitObj.kind)) {
            dragRef.current = { mode: 'translate', id: hitObj.id, last: norm };
          } else {
            const box = objectBbox(hitObj)!;
            dragRef.current = { mode: 'move', id: hitObj.id, isMask: false, grabOffset: { x: norm.x - box.x, y: norm.y - box.y } };
          }
          break;
        }
        const hitMask = capabilities.masks ? [...masks].reverse().find((m) => hitTestBox(m, norm.x, norm.y)) : undefined;
        if (hitMask) {
          store.setSelectedObjectId(hitMask.id);
          dragRef.current = { mode: 'move', id: hitMask.id, isMask: true, grabOffset: { x: norm.x - hitMask.x, y: norm.y - hitMask.y } };
          break;
        }
        store.setSelectedObjectId(null);
        break;
      }
    }
  };

  const beginResize = (e: React.PointerEvent, id: string, isMask: boolean, anchor: { x: number; y: number }) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    layerRef.current?.setPointerCapture(e.pointerId);
    if (!isMask) useAnnotationStore.getState().beginGesture();
    dragRef.current = { mode: 'resize', id, isMask, anchor };
  };

  const beginArrowEnd = (e: React.PointerEvent, id: string, end: 1 | 2) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    layerRef.current?.setPointerCapture(e.pointerId);
    useAnnotationStore.getState().beginGesture();
    dragRef.current = { mode: 'arrow-end', id, end };
  };

  /** Double-click a callout to retype its number. */
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!canUse('select') || activeTool !== 'select') return;
    const norm = toNorm(e, true);
    const hit = topmostHit(scene.objects, norm.x, norm.y, (o) => o.kind === 'callout');
    if (!hit || hit.kind !== 'callout') return;
    e.preventDefault();
    text.open(hit.x, hit.y, String(hit.n), hit.id);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      if (laserActive) {
        const norm = toNorm(e, true);
        useAnnotationLiveStore.getState().pointTo(norm.x, norm.y);
      }
      return;
    }
    const store = useAnnotationStore.getState();

    switch (drag.mode) {
      case 'stroke': {
        const dx = e.clientX - drag.lastPx.x;
        const dy = e.clientY - drag.lastPx.y;
        if (dx * dx + dy * dy < MIN_STROKE_STEP_PX * MIN_STROKE_STEP_PX) return;
        drag.lastPx = { x: e.clientX, y: e.clientY };
        const norm = toNorm(e, true);
        if (drag.pointCount >= ANNOTATION_STROKE_MAX_POINTS) {
          // Server-side per-stroke cap reached — roll seamlessly into a fresh
          // stroke instead of silently desyncing (server would reject appends
          // the local echo already rendered).
          const nextId = crypto.randomUUID();
          const current = useAnnotationStore.getState().scene.objects.find((o) => o.id === drag.id);
          const style = current && current.kind === 'stroke'
            ? { tool: current.tool, color: current.color, width: current.width }
            : { tool: 'pen' as const, color, width: strokeWidth };
          store.localApply([{ t: 'add', obj: { id: nextId, kind: 'stroke', ...style, points: [norm.x, norm.y] } }]);
          dragRef.current = { mode: 'stroke', id: nextId, lastPx: drag.lastPx, pointCount: 1 };
        } else {
          drag.pointCount += 1;
          store.localApply([{ t: 'append', id: drag.id, points: [norm.x, norm.y] }]);
        }
        break;
      }
      case 'create': {
        const norm = toNorm(e, true);
        if (drag.target === 'arrow') {
          store.localApply([{ t: 'update', id: drag.id, patch: { x2: clampPos(norm.x), y2: clampPos(norm.y) } }]);
          break;
        }
        const box = clampBox(normBox(drag.start.x, drag.start.y, norm.x, norm.y));
        if (drag.target === 'mask') store.updateMask(drag.id, box);
        else store.localApply([{ t: 'update', id: drag.id, patch: box }]);
        break;
      }
      case 'translate': {
        const norm = toNorm(e);
        const obj = useAnnotationStore.getState().scene.objects.find((o) => o.id === drag.id);
        const box = obj ? objectBbox(obj) : null;
        if (!box) break;
        // The server REJECTS a translate whose result leaves the wire bounds —
        // clamp the delta to what the object's box can take
        const { dx, dy } = clampTranslation(box, norm.x - drag.last.x, norm.y - drag.last.y);
        if (dx === 0 && dy === 0) break;
        drag.last = { x: drag.last.x + dx, y: drag.last.y + dy };
        store.localApply([{ t: 'translate', id: drag.id, dx, dy }]);
        break;
      }
      case 'arrow-end': {
        const norm = toNorm(e, true);
        const patch = drag.end === 1 ? { x1: norm.x, y1: norm.y } : { x2: norm.x, y2: norm.y };
        store.localApply([{ t: 'update', id: drag.id, patch }]);
        break;
      }
      case 'move': {
        const norm = toNorm(e);
        const patch = { x: clampPos(norm.x - drag.grabOffset.x), y: clampPos(norm.y - drag.grabOffset.y) };
        if (drag.isMask) store.updateMask(drag.id, patch);
        else store.localApply([{ t: 'update', id: drag.id, patch }]);
        break;
      }
      case 'resize': {
        const norm = toNorm(e);
        const box = clampBox(normBox(drag.anchor.x, drag.anchor.y, norm.x, norm.y));
        if (drag.isMask) store.updateMask(drag.id, box);
        else store.localApply([{ t: 'update', id: drag.id, patch: box }]);
        break;
      }
    }
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const store = useAnnotationStore.getState();

    if (drag.mode === 'create') {
      // Discard degenerate click-without-drag boxes
      if (drag.target === 'mask') {
        const mask = useAnnotationStore.getState().masks.find((m) => m.id === drag.id);
        if (mask && (mask.w < MIN_DRAG_NORM || mask.h < MIN_DRAG_NORM)) store.removeMask(drag.id);
      } else {
        const obj = useAnnotationStore.getState().scene.objects.find((o) => o.id === drag.id);
        if (obj && (obj.kind === 'shape' || obj.kind === 'spotlight') && (obj.w < MIN_DRAG_NORM || obj.h < MIN_DRAG_NORM)) {
          store.localApply([
            { t: 'remove', id: drag.id },
            // A stray click must not eat the spotlight it was about to replace
            ...(drag.replaced ?? []).map(({ obj: prev, at }) => ({ t: 'add' as const, obj: prev, at })),
          ]);
        }
        if (obj && obj.kind === 'arrow' && Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) < MIN_DRAG_NORM) {
          store.localApply([{ t: 'remove', id: drag.id }]);
        }
      }
    }
    // Closes the gesture opened on pointerdown (a no-op for mask drags, which
    // never open one — masks are local and have no history)
    store.endGesture();
    store.flushOps();
  };

  // Escape cancels an open caption. Selection keys (Delete, Escape-deselect)
  // and every other shortcut live in useAnnotationShortcuts — one listener,
  // one editable-target guard, one PTT rule.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isEditableTarget(e.target)) return;
      text.cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [text.cancel]);

  if (rect.w <= 0 || rect.h <= 0) return null;

  // Selection chrome (outline + handles), in layer-local pixels. Arrows get a
  // handle per endpoint instead of a corner; captions and badges scale with
  // their size setting rather than a handle.
  const selected: { box: Bbox; isMask: boolean; resizable: boolean; arrow?: { x1: number; y1: number; x2: number; y2: number } } | null = (() => {
    if (!selectedObjectId) return null;
    const mask = masks.find((m) => m.id === selectedObjectId);
    if (mask) return { box: mask, isMask: true, resizable: true };
    const obj = scene.objects.find((o) => o.id === selectedObjectId);
    const box = obj ? objectBbox(obj) : null;
    if (!obj || !box) return null;
    if (obj.kind === 'arrow') return { box, isMask: false, resizable: false, arrow: { x1: obj.x1, y1: obj.y1, x2: obj.x2, y2: obj.y2 } };
    return { box, isMask: false, resizable: obj.kind === 'shape' || obj.kind === 'image' || obj.kind === 'spotlight' };
  })();

  const cursor = activeTool === 'select' ? 'default' : activeTool === 'text' ? 'text' : laserActive ? 'none' : 'crosshair';

  return (
    <div
      ref={layerRef}
      data-testid="annotation-editor-layer"
      className="absolute touch-none"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, cursor }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={laserActive ? () => useAnnotationLiveStore.getState().pointerOff() : undefined}
      onDoubleClick={handleDoubleClick}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleImagePicked}
      />

      {/* Mask affordance while editing: dashed outline so black boxes are grabbable */}
      {capabilities.masks && masks.map((m) => (
        <div
          key={m.id}
          className="pointer-events-none absolute border border-dashed border-white/40"
          style={{ left: m.x * rect.w, top: m.y * rect.h, width: m.w * rect.w, height: m.h * rect.h }}
        />
      ))}

      {selected && (
        <div
          className="pointer-events-none absolute border border-vox-accent-primary"
          style={{
            left: selected.box.x * rect.w - 2,
            top: selected.box.y * rect.h - 2,
            width: selected.box.w * rect.w + 4,
            height: selected.box.h * rect.h + 4,
          }}
        >
          {selected.resizable && (
            <div
              className="pointer-events-auto absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm bg-vox-accent-primary"
              onPointerDown={(e) => beginResize(e, selectedObjectId!, selected.isMask, { x: selected.box.x, y: selected.box.y })}
            />
          )}
        </div>
      )}

      {selected?.arrow && ([1, 2] as const).map((end) => {
        const a = selected.arrow!;
        const px = (end === 1 ? a.x1 : a.x2) * rect.w;
        const py = (end === 1 ? a.y1 : a.y2) * rect.h;
        return (
          <div
            key={end}
            data-testid={`arrow-handle-${end}`}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border border-white bg-vox-accent-primary"
            style={{ left: px, top: py }}
            onPointerDown={(e) => beginArrowEnd(e, selectedObjectId!, end)}
          />
        );
      })}

      {text.draft && (
        <input
          autoFocus
          data-testid="annotation-text-draft"
          value={text.draft.value}
          maxLength={ANNOTATION_TEXT_MAX}
          placeholder={t('voice.annotations.addTextPlaceholder')}
          className="absolute rounded border border-vox-accent-primary bg-black/70 px-1.5 py-0.5 font-semibold outline-none"
          style={{
            left: text.draft.x * rect.w,
            top: text.draft.y * rect.h,
            minWidth: 160,
            // Same size and colour the committed caption is painted with
            fontSize: Math.max(9, TEXT_SIZE * rect.h),
            color,
          }}
          onChange={(e) => text.setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') text.commit();
            if (e.key === 'Escape') text.cancel();
          }}
          onBlur={text.commit}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
