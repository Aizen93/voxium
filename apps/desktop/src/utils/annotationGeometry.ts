/**
 * Coordinate mapping between normalized annotation space ([0..1] relative to
 * the source video frame) and the on-screen content rect of an object-contain
 * <video> element. Pure math — unit-tested in isolation.
 */

export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the video frame actually renders inside a box under object-contain
 * (letterboxed vertically or pillarboxed horizontally, centered).
 * Returns a zero rect when either size is unknown/degenerate.
 */
export function computeContentRect(boxW: number, boxH: number, videoW: number, videoH: number): ContentRect {
  if (!(boxW > 0) || !(boxH > 0) || !(videoW > 0) || !(videoH > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Normalized frame coords → pixel coords inside the content rect's box. */
export function normToPx(nx: number, ny: number, rect: ContentRect): { x: number; y: number } {
  return { x: rect.x + nx * rect.w, y: rect.y + ny * rect.h };
}

/**
 * Pixel coords (relative to the content rect's box) → normalized frame coords.
 * Clamped to the wire-protocol bounds [-0.1, 1.1] so a drag past the edge
 * still produces a valid op; pass `clampToFrame` to pin inside [0, 1] (used
 * while drawing strokes, which should never leave the frame).
 */
export function pxToNorm(px: number, py: number, rect: ContentRect, clampToFrame = false): { x: number; y: number } {
  if (!(rect.w > 0) || !(rect.h > 0)) return { x: 0, y: 0 };
  const min = clampToFrame ? 0 : -0.1;
  const max = clampToFrame ? 1 : 1.1;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return {
    x: clamp((px - rect.x) / rect.w),
    y: clamp((py - rect.y) / rect.h),
  };
}
