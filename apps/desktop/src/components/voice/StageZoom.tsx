import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  IDENTITY_ZOOM, MAGNIFIER_SIZE, MAGNIFIER_ZOOM,
  zoomAt, panBy, magnifierSourceRect, type ZoomState,
} from '../../utils/stageZoom';
import { computeContentRect } from '../../utils/annotationGeometry';

/**
 * Viewer-side zoom + magnifier for the screen-share stage (item 13).
 * CLIENT-ONLY — a CSS transform on a wrapper containing both the <video> and
 * the AnnotationCanvas; nothing about it ever reaches the wire.
 *
 * Disabled for the sharer while editing: the editor maps pointer → normalized
 * coordinates from the layer's bounding rect, and a transformed layer would
 * need the inverse matrix. Cheaper to not zoom while drawing — flipping
 * `enabled` off also RESETS the zoom so the layer is never mounted transformed.
 */
export function useStageZoom(stageRef: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [zoom, setZoom] = useState<ZoomState>(IDENTITY_ZOOM);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!enabled) setZoom(IDENTITY_ZOOM);
  }, [enabled]);

  // Native listener: React's synthetic wheel is passive, so preventDefault()
  // (page scroll / browser pinch-zoom suppression) needs our own registration.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !enabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // ctrlKey = trackpad pinch (browsers report pinch as ctrl+wheel) —
      // larger step because pinch deltas are small
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0015));
      setZoom((z) => zoomAt(z, e.clientX - rect.left, e.clientY - rect.top, factor, rect.width, rect.height));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stageRef, enabled]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (zoom.scale === 1 || e.button !== 0) return;
      dragRef.current = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = dragRef.current;
      const el = stageRef.current;
      if (!d || !el) return;
      const rect = el.getBoundingClientRect();
      setZoom((z) => panBy(z, e.clientX - d.x, e.clientY - d.y, rect.width, rect.height));
      dragRef.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: () => {
      dragRef.current = null;
    },
    onDoubleClick: () => setZoom(IDENTITY_ZOOM),
  };

  const style: React.CSSProperties | undefined = zoom.scale === 1
    ? undefined
    : { transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`, transformOrigin: '0 0' };

  return { zoom, style, handlers, reset: () => setZoom(IDENTITY_ZOOM) };
}

export function ZoomPill({ zoom, onReset }: { zoom: ZoomState; onReset: () => void }) {
  const { t } = useTranslation();
  if (zoom.scale === 1) return null;
  return (
    <div
      className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white"
      data-testid="zoom-pill"
    >
      {zoom.scale.toFixed(1)}×
      <button
        onClick={onReset}
        className="rounded-full p-0.5 hover:bg-white/20"
        title={t('voice.zoom.reset')}
        aria-label={t('voice.zoom.reset')}
        data-testid="zoom-reset"
      >
        <X size={11} />
      </button>
    </div>
  );
}

const isEditableTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

/**
 * 220px lens at 3× following the cursor while Z is held. Reads straight from
 * the <video> element (drawImage source-rect math in utils/stageZoom) on its
 * own rAF loop only while active; pointer-events: none throughout.
 * Disabled while the stage is zoomed (the lens math assumes the untransformed
 * content rect) and while the sharer is editing (Z must stay a free key there).
 */
export function MagnifierLens({
  videoRef,
  stageRef,
  disabled = false,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stageRef: React.RefObject<HTMLElement | null>;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lensRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const [held, setHeld] = useState(false);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    if (disabled) {
      setHeld(false);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'KeyZ' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      setHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyZ') setHeld(false);
    };
    const onBlur = () => setHeld(false); // a keyup lost to focus change must not wedge the lens on
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [disabled]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onMove = (e: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      posRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setHovering(true);
    };
    const onLeave = () => {
      posRef.current = null;
      setHovering(false);
    };
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);
    return () => {
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
    };
  }, [stageRef]);

  const active = held && hovering && !disabled;

  useEffect(() => {
    if (!active) return;
    let handle = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const lens = lensRef.current;
      const video = videoRef.current;
      const pos = posRef.current;
      if (canvas && lens && video && pos) {
        lens.style.left = `${pos.x - MAGNIFIER_SIZE / 2}px`;
        lens.style.top = `${pos.y - MAGNIFIER_SIZE / 2}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const inner = computeContentRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
          const content = { x: video.offsetLeft + inner.x, y: video.offsetTop + inner.y, w: inner.w, h: inner.h };
          const src = magnifierSourceRect(pos.x, pos.y, content, video.videoWidth, video.videoHeight, MAGNIFIER_SIZE, MAGNIFIER_ZOOM);
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
          if (src) {
            try {
              ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
            } catch (err) {
              // A frameless/detached video mid-teardown throws — lens goes
              // black for that frame, nothing else is affected
              console.warn('[Magnifier] draw failed:', err);
            }
          }
        }
      }
      handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [active, videoRef]);

  if (!active) return null;
  return (
    <div
      ref={lensRef}
      className="pointer-events-none absolute z-20 overflow-hidden rounded-full border-2 border-white/70 shadow-xl"
      style={{ width: MAGNIFIER_SIZE, height: MAGNIFIER_SIZE }}
      data-testid="magnifier-lens"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} width={MAGNIFIER_SIZE} height={MAGNIFIER_SIZE} />
    </div>
  );
}
