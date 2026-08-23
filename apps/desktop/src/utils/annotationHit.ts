import type { AnnotationObject } from '@voxium/shared';

/**
 * Pure geometry for the editor: bounding boxes, hit-testing and wire-bounds
 * clamping, in normalized frame coordinates. No DOM, no store — the editor
 * layer and (later) the eraser and viewer tools all share this.
 */

export interface Bbox { x: number; y: number; w: number; h: number }

/** Normalize a possibly-inverted drag box (dragging up/left). */
export function normBox(x1: number, y1: number, x2: number, y2: number): Bbox {
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
export const clampPos = (v: number): number => Math.min(1.1, Math.max(-0.1, v));
export const clampSpan = (v: number): number => Math.min(1.1, Math.max(0, v));
export function clampBox(b: Bbox): Bbox {
  return { x: clampPos(b.x), y: clampPos(b.y), w: clampSpan(b.w), h: clampSpan(b.h) };
}

/**
 * Clamp a translation so the object's bbox stays inside the wire bounds —
 * the server REJECTS a translate whose result leaves them, so the client
 * must never emit one.
 */
export function clampTranslation(box: Bbox, dx: number, dy: number): { dx: number; dy: number } {
  const minX = -0.1 - box.x, maxX = 1.1 - (box.x + box.w);
  const minY = -0.1 - box.y, maxY = 1.1 - (box.y + box.h);
  return {
    dx: Math.min(maxX, Math.max(minX, dx)),
    dy: Math.min(maxY, Math.max(minY, dy)),
  };
}

/** Width estimate for a caption, in frame units. The canvas paints
 *  `600 {size·h}px system-ui`; ~0.55em per character is a fair average. */
export function textBbox(obj: { x: number; y: number; size: number; text: string }): Bbox {
  return { x: obj.x, y: obj.y, w: Math.max(0.02, obj.text.length * obj.size * 0.55), h: obj.size };
}

/** Axis-aligned bounds of any object; null only for objects of unknown kind. */
export function objectBbox(obj: AnnotationObject): Bbox | null {
  switch (obj.kind) {
    case 'shape':
    case 'image':
    case 'spotlight':
      return normBox(obj.x, obj.y, obj.x + obj.w, obj.y + obj.h);
    case 'text':
      return textBbox(obj);
    case 'callout':
      // A badge is a circle of diameter `size` centred on (x, y)
      return { x: obj.x - obj.size / 2, y: obj.y - obj.size / 2, w: obj.size, h: obj.size };
    case 'arrow':
      return normBox(obj.x1, obj.y1, obj.x2, obj.y2);
    case 'stroke': {
      if (obj.points.length < 2) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < obj.points.length; i += 2) {
        const x = obj.points[i], y = obj.points[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    default:
      return null;
  }
}

export function hitTestBox(box: Bbox | null, nx: number, ny: number, pad = 0.008): boolean {
  if (!box) return false;
  return nx >= box.x - pad && nx <= box.x + box.w + pad && ny >= box.y - pad && ny <= box.y + box.h + pad;
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * vx, cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}

/** True when (nx, ny) lies within `tolerance` of any segment of the polyline. */
export function hitTestPolyline(points: number[], nx: number, ny: number, tolerance: number): boolean {
  if (points.length < 2) return false;
  if (points.length === 2) return Math.hypot(nx - points[0], ny - points[1]) <= tolerance;
  for (let i = 2; i < points.length; i += 2) {
    if (distToSegment(nx, ny, points[i - 2], points[i - 1], points[i], points[i + 1]) <= tolerance) return true;
  }
  return false;
}

/**
 * Does (nx, ny) touch this object? Strokes and arrows are tested against
 * their path (a bbox would select the empty inside of a big loop); everything
 * else against its box. `pad` is in frame units; stroke tolerance adds half
 * the stroke's own width so a thick marker is as grabbable as it looks.
 */
export function hitTestObject(obj: AnnotationObject, nx: number, ny: number, pad = 0.008): boolean {
  switch (obj.kind) {
    case 'stroke':
      return hitTestPolyline(obj.points, nx, ny, obj.width / 2 + pad);
    case 'arrow':
      return distToSegment(nx, ny, obj.x1, obj.y1, obj.x2, obj.y2) <= obj.width / 2 + pad * 1.5;
    default:
      return hitTestBox(objectBbox(obj), nx, ny, pad);
  }
}

/** The topmost (last-drawn) object under the point, or null. */
export function topmostHit(objects: readonly AnnotationObject[], nx: number, ny: number, filter?: (obj: AnnotationObject) => boolean): AnnotationObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (filter && !filter(obj)) continue;
    if (hitTestObject(obj, nx, ny)) return obj;
  }
  return null;
}
