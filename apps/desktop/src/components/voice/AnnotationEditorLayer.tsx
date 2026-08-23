import { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ANNOTATION_STROKE_MAX_POINTS, ANNOTATION_TEXT_MAX } from '@voxium/shared';
import type { AnnotationObject } from '@voxium/shared';
import { useAnnotationStore, type AnnotationEditorTool } from '../../stores/annotationStore';
import { useVideoContentRect } from '../../hooks/useVideoContentRect';
import { useTextDraft } from '../../hooks/useTextDraft';
import { pxToNorm } from '../../utils/annotationGeometry';
import { normBox, clampBox, clampPos, objectBbox, hitTestBox, topmostHit, type Bbox } from '../../utils/annotationHit';
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

export const ALL_EDITOR_TOOLS: readonly AnnotationEditorTool[] = ['select', 'pen', 'highlighter', 'rect', 'ellipse', 'text', 'image', 'mask'];

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
const HIGHLIGHTER_WIDTH_FACTOR = 4;

/** Kinds a plain click can select and drag. Strokes and arrows join this list
 *  with the eraser/stroke-editing work; until then they are paint only. */
const SELECTABLE_KINDS: ReadonlySet<AnnotationObject['kind']> = new Set(['shape', 'image', 'text']);

type DragState =
  | { mode: 'stroke'; id: string; lastPx: { x: number; y: number }; pointCount: number }
  /** Two-point gestures: the object is created at pointerdown and reshaped
   *  from `start` to the current pointer on every move. `target` says what
   *  the second point reshapes — a box (normalized, inverted drags allowed)
   *  or a mask (same, local-only). */
  | { mode: 'create'; id: string; target: 'box' | 'mask'; start: { x: number; y: number } }
  | { mode: 'move'; id: string; isMask: boolean; grabOffset: { x: number; y: number } }
  | { mode: 'resize'; id: string; isMask: boolean; anchor: { x: number; y: number } };

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

  const text = useTextDraft((draft, value) => {
    if (!value) return;
    const store = useAnnotationStore.getState();
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
          const box = objectBbox(hitObj)!;
          dragRef.current = { mode: 'move', id: hitObj.id, isMask: false, grabOffset: { x: norm.x - box.x, y: norm.y - box.y } };
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

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
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
        const box = clampBox(normBox(drag.start.x, drag.start.y, norm.x, norm.y));
        if (drag.target === 'mask') store.updateMask(drag.id, box);
        else store.localApply([{ t: 'update', id: drag.id, patch: box }]);
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
        if (obj && obj.kind === 'shape' && (obj.w < MIN_DRAG_NORM || obj.h < MIN_DRAG_NORM)) {
          store.localApply([{ t: 'remove', id: drag.id }]);
        }
      }
    }
    // Closes the gesture opened on pointerdown (a no-op for mask drags, which
    // never open one — masks are local and have no history)
    store.endGesture();
    store.flushOps();
  };

  // Delete removes the selection; Escape cancels text entry / deselects
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never react to typing in ANY editable surface — chat/bio textareas and
      // contentEditable fields bubble Backspace to window too, and deleting a
      // shared annotation because someone fixed a typo elsewhere is a footgun.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const store = useAnnotationStore.getState();
      if (e.key === 'Escape') {
        text.cancel();
        store.setSelectedObjectId(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedObjectId) {
        const id = store.selectedObjectId;
        if (store.masks.some((m) => m.id === id)) {
          store.removeMask(id);
        } else {
          store.localApply([{ t: 'remove', id }]);
          store.flushOps();
        }
        store.setSelectedObjectId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [text.cancel]);

  if (rect.w <= 0 || rect.h <= 0) return null;

  // Selection chrome (outline + resize handle), in layer-local pixels
  const selected: { box: Bbox; isMask: boolean; resizable: boolean } | null = (() => {
    if (!selectedObjectId) return null;
    const mask = masks.find((m) => m.id === selectedObjectId);
    if (mask) return { box: mask, isMask: true, resizable: true };
    const obj = scene.objects.find((o) => o.id === selectedObjectId);
    const box = obj ? objectBbox(obj) : null;
    if (!obj || !box) return null;
    return { box, isMask: false, resizable: obj.kind !== 'text' };
  })();

  const cursor = activeTool === 'select' ? 'default' : activeTool === 'text' ? 'text' : 'crosshair';

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
