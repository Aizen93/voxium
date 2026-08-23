import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { ANNOTATION_IMAGE_MAX_DECODED_EDGE, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS } from '@voxium/shared';
import type { AnnotationScene } from '@voxium/shared';
import { useAnnotationStore, type MaskRect } from '../../stores/annotationStore';
import { useAnnotationLiveStore, hasLiveActivity, fadeAlpha, type FadeClock } from '../../stores/annotationLiveStore';
import { useVideoContentRect } from '../../hooks/useVideoContentRect';
import { drawLivePointer } from '../../utils/annotationLiveDraw';
import { drawArrow, drawCallout, drawSpotlight } from '../../utils/annotationDraw';

/**
 * Render-only overlay for screen-share annotations. Positions itself over the
 * video CONTENT rect (object-contain letterboxing accounted for) inside a
 * position:relative wrapper shared with the <video>. Pointer events pass
 * through — the sharer's editor layer (separate component) handles input.
 *
 * Masks are local-only sharer state (empty for viewers): the sharer previews
 * the RAW capture, so masks are painted here exactly as viewers receive them
 * baked into the composited video — black boxes or cover images.
 */

interface AnnotationCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

// Decoded overlay images, keyed by cache id. Entries no longer referenced by
// the scene/masks are dropped after each draw, so the cache tracks the scene.
const imageCache = new Map<string, { src: string; img: HTMLImageElement; loaded: boolean }>();

function cachedImage(id: string, src: string, usedIds: Set<string>, requestRedraw: () => void): HTMLImageElement | null {
  usedIds.add(id);
  let entry = imageCache.get(id);
  if (!entry || entry.src !== src) {
    const img = new Image();
    entry = { src, img, loaded: false };
    imageCache.set(id, entry);
    img.onload = () => {
      // Server-side header validation is the primary bomb gate; this is the
      // viewer's own belt — never draw (or keep) an image that decoded larger
      // than anything a legitimate client can produce.
      if (img.naturalWidth > ANNOTATION_IMAGE_MAX_DECODED_EDGE || img.naturalHeight > ANNOTATION_IMAGE_MAX_DECODED_EDGE) {
        console.warn('[Annotations] Overlay image exceeds decoded-size cap — dropped');
        imageCache.delete(id);
        return;
      }
      const current = imageCache.get(id);
      if (current) current.loaded = true;
      requestRedraw();
    };
    img.onerror = () => {
      console.warn('[Annotations] Overlay image failed to decode');
    };
    img.src = src;
  }
  return entry.loaded ? entry.img : null;
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: AnnotationScene,
  masks: MaskRect[],
  w: number,
  h: number,
  requestRedraw: () => void,
  fading: ReadonlyMap<string, FadeClock> = new Map(),
  now: number = Date.now(),
): void {
  ctx.clearRect(0, 0, w, h);
  const usedIds = new Set<string>();

  // Masks under annotations — annotations must stay visible over a cover
  for (const mask of masks) {
    const x = mask.x * w, y = mask.y * h, bw = mask.w * w, bh = mask.h * h;
    if (mask.src) {
      const img = cachedImage(`mask:${mask.id}`, mask.src, usedIds, requestRedraw);
      if (img) {
        ctx.drawImage(img, x, y, bw, bh);
      } else {
        ctx.fillStyle = '#000000';
        ctx.fillRect(x, y, bw, bh);
      }
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(x, y, bw, bh);
    }
  }

  // The spotlight dims the frame under every other annotation, wherever it
  // sits in the scene order (the editor keeps at most one)
  for (const obj of scene.objects) {
    if (obj.kind === 'spotlight') drawSpotlight(ctx, obj, w, h);
  }

  for (const obj of scene.objects) {
    switch (obj.kind) {
      case 'spotlight':
        break; // painted above
      case 'stroke': {
        if (obj.points.length < 4) break;
        // Vanishing ink: fade on THIS client's clock, and skip once gone even
        // if the sharer's remove has not arrived
        const alpha = obj.fade ? fadeAlpha(fading.get(obj.id), now, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS) : 1;
        if (alpha <= 0) break;
        ctx.save();
        ctx.globalAlpha = alpha;
        if (obj.tool === 'highlighter') {
          ctx.globalAlpha = 0.35 * alpha;
          ctx.globalCompositeOperation = 'multiply';
        }
        ctx.strokeStyle = obj.color;
        ctx.lineWidth = Math.max(1, obj.width * h);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(obj.points[0] * w, obj.points[1] * h);
        for (let i = 2; i < obj.points.length; i += 2) {
          ctx.lineTo(obj.points[i] * w, obj.points[i + 1] * h);
        }
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'shape': {
        ctx.save();
        ctx.strokeStyle = obj.color;
        ctx.fillStyle = obj.color;
        ctx.lineWidth = Math.max(1, obj.width * h);
        const x = obj.x * w, y = obj.y * h, bw = obj.w * w, bh = obj.h * h;
        ctx.beginPath();
        if (obj.shape === 'ellipse') {
          ctx.ellipse(x + bw / 2, y + bh / 2, Math.abs(bw / 2), Math.abs(bh / 2), 0, 0, Math.PI * 2);
        } else {
          ctx.rect(x, y, bw, bh);
        }
        if (obj.fill) {
          ctx.globalAlpha = 0.25;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'text': {
        ctx.save();
        ctx.fillStyle = obj.color;
        const px = Math.max(9, obj.size * h);
        ctx.font = `600 ${px}px system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        // Subtle halo so text stays readable on any background
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = Math.max(2, px * 0.12);
        ctx.fillText(obj.text, obj.x * w, obj.y * h);
        ctx.restore();
        break;
      }
      case 'image': {
        const img = cachedImage(obj.id, obj.src, usedIds, requestRedraw);
        if (img) {
          ctx.drawImage(img, obj.x * w, obj.y * h, obj.w * w, obj.h * h);
        }
        break;
      }
      case 'arrow':
        drawArrow(ctx, obj, w, h);
        break;
      case 'callout':
        drawCallout(ctx, obj, w, h);
        break;
      // No default on purpose: an object kind this client predates is skipped,
      // never thrown on — that is what lets an old viewer follow a new sharer.
    }
  }

  for (const id of imageCache.keys()) {
    if (!usedIds.has(id)) imageCache.delete(id);
  }
}

/**
 * Drive a requestAnimationFrame loop ONLY while the live store holds
 * something time-dependent (a pointer still fading, reactions in flight).
 * The loop prunes expired items, redraws, and stops itself on the first idle
 * frame — no viewer ever runs a permanent loop for an overlay that is usually
 * static. A fresh event while idle starts it again via the subscription.
 */
export function useLiveScheduler(draw: () => void): void {
  const drawRef = useRef(draw);
  useLayoutEffect(() => {
    drawRef.current = draw;
  });

  useEffect(() => {
    let handle = 0;
    let running = false;
    const tick = () => {
      const live = useAnnotationLiveStore.getState();
      live.prune(Date.now());
      drawRef.current();
      if (hasLiveActivity(useAnnotationLiveStore.getState())) {
        handle = requestAnimationFrame(tick);
      } else {
        running = false;
      }
    };
    const start = () => {
      if (running) return;
      running = true;
      handle = requestAnimationFrame(tick);
    };
    const unsubscribe = useAnnotationLiveStore.subscribe((state) => {
      if (hasLiveActivity(state)) start();
    });
    if (hasLiveActivity(useAnnotationLiveStore.getState())) start();
    return () => {
      unsubscribe();
      cancelAnimationFrame(handle);
      running = false;
    };
  }, []);
}

export function AnnotationCanvas({ videoRef }: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useAnnotationStore((s) => s.scene);
  const masks = useAnnotationStore((s) => s.masks);
  const rect = useVideoContentRect(videoRef);
  const [redrawTick, setRedrawTick] = useState(0);

  // The cache is module-level (survives re-renders); without this, decoded
  // images from a share leak until the NEXT annotated share prunes them.
  // Inline/floating render exactly one canvas at a time, so a full clear on
  // unmount is safe — the next mount's draw repopulates from the scene.
  useEffect(() => () => imageCache.clear(), []);

  // One draw routine for both triggers: scene/mask/rect changes (effect
  // below) and the live scheduler (time-driven frames). It is cheap enough to
  // repaint the whole scene per frame for the handful of seconds a pointer
  // is visible — and far simpler than a second, layered canvas.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || rect.w <= 0 || rect.h <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.w * dpr));
    const height = Math.max(1, Math.round(rect.h * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = Date.now();
    const { pointer, fading } = useAnnotationLiveStore.getState();
    drawScene(ctx, scene, masks, rect.w, rect.h, () => setRedrawTick((t) => t + 1), fading, now);
    if (pointer) drawLivePointer(ctx, pointer, now, rect.w, rect.h);
  }, [scene, masks, rect]);

  useEffect(() => {
    draw();
  }, [draw, redrawTick]);

  useLiveScheduler(draw);

  if (rect.w <= 0 || rect.h <= 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      aria-hidden="true"
    />
  );
}
