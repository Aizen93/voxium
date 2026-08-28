import type { ContentRect } from './annotationGeometry';

/**
 * Viewer-side stage zoom (item 13) — pure math, CLIENT-ONLY. Nothing here
 * touches the network: the transform is CSS on a wrapper that contains both
 * the <video> and the AnnotationCanvas, so the canvas stays registered to the
 * video for free (useVideoContentRect reads clientWidth/offsetLeft, which CSS
 * transforms do not change).
 *
 * Convention: transform is `translate(tx, ty) scale(scale)` with origin 0 0 on
 * a wrapper that exactly fills the stage. Pan bounds keep the scaled content
 * covering the stage — the video can never be dragged off-screen.
 */

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const IDENTITY_ZOOM: ZoomState = { scale: 1, tx: 0, ty: 0 };

/** Lens diameter in CSS px. */
export const MAGNIFIER_SIZE = 220;
/** Magnification relative to the DISPLAYED size. */
export const MAGNIFIER_ZOOM = 3;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Keep the scaled wrapper covering the stage: tx ∈ [W·(1−s), 0], same for y. */
export function clampPan(state: ZoomState, stageW: number, stageH: number): ZoomState {
  return {
    scale: state.scale,
    tx: clamp(state.tx, stageW * (1 - state.scale), 0),
    ty: clamp(state.ty, stageH * (1 - state.scale), 0),
  };
}

/**
 * Scale by `factor` keeping the stage point under the cursor fixed.
 * Fully zoomed out snaps to the identity (no residual pan).
 */
export function zoomAt(
  state: ZoomState,
  cursorX: number,
  cursorY: number,
  factor: number,
  stageW: number,
  stageH: number,
): ZoomState {
  const scale = clamp(state.scale * factor, ZOOM_MIN, ZOOM_MAX);
  if (scale === ZOOM_MIN) return IDENTITY_ZOOM;
  const ratio = scale / state.scale;
  return clampPan(
    {
      scale,
      tx: cursorX - (cursorX - state.tx) * ratio,
      ty: cursorY - (cursorY - state.ty) * ratio,
    },
    stageW,
    stageH,
  );
}

/** Drag pan; a no-op at 1× (the stage is not a scroll surface then). */
export function panBy(state: ZoomState, dx: number, dy: number, stageW: number, stageH: number): ZoomState {
  if (state.scale === ZOOM_MIN) return state;
  return clampPan({ scale: state.scale, tx: state.tx + dx, ty: state.ty + dy }, stageW, stageH);
}

/**
 * Source rectangle (in VIDEO pixels) for the magnifier lens: the lens shows
 * `lensPx / magnification` displayed pixels around the cursor, mapped through
 * the object-contain content rect, clamped so the rect never leaves the frame
 * (the lens sticks at the edge instead of sampling outside).
 * Returns null when the cursor is outside the content or nothing is mappable.
 */
export function magnifierSourceRect(
  cursorX: number,
  cursorY: number,
  content: ContentRect,
  videoW: number,
  videoH: number,
  lensPx: number = MAGNIFIER_SIZE,
  magnification: number = MAGNIFIER_ZOOM,
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (content.w <= 0 || content.h <= 0 || videoW <= 0 || videoH <= 0) return null;
  const nx = (cursorX - content.x) / content.w;
  const ny = (cursorY - content.y) / content.h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  // object-contain: horizontal and vertical px ratios are equal by construction
  const ratio = videoW / content.w;
  const side = (lensPx / magnification) * ratio;
  if (side >= videoW || side >= videoH) return null; // source too small to magnify
  return {
    sx: clamp(nx * videoW - side / 2, 0, videoW - side),
    sy: clamp(ny * videoH - side / 2, 0, videoH - side),
    sw: side,
    sh: side,
  };
}
