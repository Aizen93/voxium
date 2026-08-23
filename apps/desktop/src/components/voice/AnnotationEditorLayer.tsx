import { useRef, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ANNOTATION_STROKE_MAX_POINTS, ANNOTATION_TEXT_MAX, ANNOTATION_TEXT_FORBIDDEN_RE } from '@voxium/shared';
import type { AnnotationObject } from '@voxium/shared';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useVideoContentRect } from '../../hooks/useVideoContentRect';
import { pxToNorm } from '../../utils/annotationGeometry';
import { toast } from '../../stores/toastStore';
import { processOverlayImage } from '../../utils/imageProcessing';

/**
 * The sharer's input surface: an absolutely positioned layer over the video
 * content rect that turns pointer gestures into annotation ops (broadcast) or
 * mask edits (local-only). Rendered only for the local sharer while editing —
 * AnnotationCanvas below it does all the painting.
 */

interface AnnotationEditorLayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

const MIN_DRAG_NORM = 0.005;
/** px of pointer travel before a new stroke point is recorded */
const MIN_STROKE_STEP_PX = 2;
const TEXT_SIZE = 0.045;
const HIGHLIGHTER_WIDTH_FACTOR = 4;

interface Bbox { x: number; y: number; w: number; h: number }

/** Normalize a possibly-inverted drag box (dragging up/left). */
function normBox(x1: number, y1: number, x2: number, y2: number): Bbox {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

// Every emitted geometry MUST fit the server's wire bounds ([-0.1, 1.1] per
// coordinate, spans ≤ 1.1) — one out-of-range value rejects the WHOLE batch
// while the local echo already applied it, silently desyncing every viewer.
const clampPos = (v: number) => Math.min(1.1, Math.max(-0.1, v));
const clampSpan = (v: number) => Math.min(1.1, Math.max(0, v));
function clampBox(b: Bbox): Bbox {
  return { x: clampPos(b.x), y: clampPos(b.y), w: clampSpan(b.w), h: clampSpan(b.h) };
}

function objectBbox(obj: AnnotationObject): Bbox | null {
  switch (obj.kind) {
    case 'shape':
    case 'image':
      return normBox(obj.x, obj.y, obj.x + obj.w, obj.y + obj.h);
    case 'text': {
      // Rough monospace-ish estimate — good enough for hit-testing/handles
      const h = obj.size;
      const w = Math.max(0.02, obj.text.length * obj.size * 0.55);
      return { x: obj.x, y: obj.y, w, h };
    }
    default:
      return null; // strokes are not selectable
  }
}

function hitTest(box: Bbox | null, nx: number, ny: number): boolean {
  if (!box) return false;
  const pad = 0.008;
  return nx >= box.x - pad && nx <= box.x + box.w + pad && ny >= box.y - pad && ny <= box.y + box.h + pad;
}

interface TextDraft { x: number; y: number; value: string }

/** What the text tool is allowed to ship: trimmed, capped, and free of the
 *  control/bidi/zero-width characters the server rejects the WHOLE batch for
 *  (the local echo would already show a caption the viewers never get). */
export function sanitizeAnnotationText(raw: string): string {
  return raw
    .replace(new RegExp(ANNOTATION_TEXT_FORBIDDEN_RE.source, 'g'), '')
    .trim()
    .slice(0, ANNOTATION_TEXT_MAX);
}

type DragState =
  | { mode: 'stroke'; id: string; lastPx: { x: number; y: number }; pointCount: number }
  | { mode: 'create-box'; id: string; isMask: boolean; startNorm: { x: number; y: number } }
  | { mode: 'move'; id: string; isMask: boolean; grabOffset: { x: number; y: number } }
  | { mode: 'resize'; id: string; isMask: boolean; anchor: { x: number; y: number } };

export function AnnotationEditorLayer({ videoRef }: AnnotationEditorLayerProps) {
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

  // The draft lives in state (it renders) AND in a ref (it commits): the commit
  // runs from pointer, key and blur handlers that can fire back-to-back for
  // one gesture (Enter unmounts the input, which blurs it), so it must be
  // idempotent — and it must never run inside a setState updater, which
  // StrictMode invokes twice and would add the caption twice.
  const [textDraft, setTextDraftState] = useState<TextDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const setTextDraft = useCallback((draft: TextDraft | null) => {
    textDraftRef.current = draft;
    setTextDraftState(draft);
  }, []);

  /** Pointer event → normalized frame coords. */
  const toNorm = useCallback((e: { clientX: number; clientY: number }, clampToFrame = false) => {
    const layer = layerRef.current;
    if (!layer) return { x: 0, y: 0 };
    const box = layer.getBoundingClientRect();
    return pxToNorm(e.clientX - box.left, e.clientY - box.top, { x: 0, y: 0, w: box.width, h: box.height }, clampToFrame);
  }, []);

  const commitTextDraft = useCallback(() => {
    const draft = textDraftRef.current;
    if (!draft) return;
    setTextDraft(null);
    const text = sanitizeAnnotationText(draft.value);
    if (!text) return;
    const store = useAnnotationStore.getState();
    store.localApply([{
      t: 'add',
      obj: { id: crypto.randomUUID(), kind: 'text', text, color: store.color, size: TEXT_SIZE, x: draft.x, y: draft.y },
    }]);
    store.flushOps();
  }, [setTextDraft]);

  // The image tool is a file dialog, not a canvas gesture. Reset the tool
  // immediately after opening the picker: cancelling the dialog fires no
  // 'change' event, and since re-clicking the same tool doesn't re-trigger
  // this effect, the toolbar would otherwise wedge on an inert 'image' tool.
  useEffect(() => {
    if (activeTool === 'image') {
      fileInputRef.current?.click();
      useAnnotationStore.getState().setActiveTool('select');
    }
  }, [activeTool]);

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
    if (textDraftRef.current) {
      commitTextDraft();
      if (activeTool === 'text') return;
    }

    layerRef.current?.setPointerCapture(e.pointerId);

    switch (activeTool) {
      case 'pen':
      case 'highlighter': {
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
        const id = crypto.randomUUID();
        store.localApply([{
          t: 'add',
          obj: { id, kind: 'shape', shape: activeTool, color, width: strokeWidth, x: norm.x, y: norm.y, w: 0, h: 0, fill: false },
        }]);
        dragRef.current = { mode: 'create-box', id, isMask: false, startNorm: norm };
        break;
      }
      case 'mask': {
        const id = crypto.randomUUID();
        store.addMask({ id, x: norm.x, y: norm.y, w: 0, h: 0 });
        dragRef.current = { mode: 'create-box', id, isMask: true, startNorm: norm };
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
        setTextDraft({ x: norm.x, y: norm.y, value: '' });
        break;
      }
      case 'select': {
        // Annotations first (drawn on top), then masks
        const objects = [...scene.objects].reverse();
        const hitObj = objects.find((o) => hitTest(objectBbox(o), norm.x, norm.y));
        if (hitObj) {
          store.setSelectedObjectId(hitObj.id);
          const box = objectBbox(hitObj)!;
          dragRef.current = { mode: 'move', id: hitObj.id, isMask: false, grabOffset: { x: norm.x - box.x, y: norm.y - box.y } };
          break;
        }
        const hitMask = [...masks].reverse().find((m) => hitTest(m, norm.x, norm.y));
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
      case 'create-box': {
        const norm = toNorm(e, true);
        const box = clampBox(normBox(drag.startNorm.x, drag.startNorm.y, norm.x, norm.y));
        if (drag.isMask) store.updateMask(drag.id, box);
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

    if (drag.mode === 'create-box') {
      // Discard degenerate click-without-drag boxes
      if (drag.isMask) {
        const mask = useAnnotationStore.getState().masks.find((m) => m.id === drag.id);
        if (mask && (mask.w < MIN_DRAG_NORM || mask.h < MIN_DRAG_NORM)) store.removeMask(drag.id);
      } else {
        const obj = useAnnotationStore.getState().scene.objects.find((o) => o.id === drag.id);
        if (obj && obj.kind === 'shape' && (obj.w < MIN_DRAG_NORM || obj.h < MIN_DRAG_NORM)) {
          store.localApply([{ t: 'remove', id: drag.id }]);
        }
      }
    }
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
        setTextDraft(null);
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
  }, [setTextDraft]);

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
      {masks.map((m) => (
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

      {textDraft && (
        <input
          autoFocus
          data-testid="annotation-text-draft"
          value={textDraft.value}
          maxLength={ANNOTATION_TEXT_MAX}
          placeholder={t('voice.annotations.addTextPlaceholder')}
          className="absolute rounded border border-vox-accent-primary bg-black/70 px-1.5 py-0.5 font-semibold outline-none"
          style={{
            left: textDraft.x * rect.w,
            top: textDraft.y * rect.h,
            minWidth: 160,
            // Same size and colour the committed caption is painted with
            fontSize: Math.max(9, TEXT_SIZE * rect.h),
            color,
          }}
          onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTextDraft();
            if (e.key === 'Escape') setTextDraft(null);
          }}
          onBlur={commitTextDraft}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
