import type { AnnotationArrow, AnnotationCallout } from '@voxium/shared';

/**
 * Painters for the v2 object kinds, kept pure (a canvas context in, drawing
 * calls out) so geometry can be asserted with a recording context.
 */

type Ctx = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'stroke' | 'fill' | 'arc' | 'fillText'>
  & { strokeStyle: string | CanvasGradient | CanvasPattern; fillStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline };

/** Arrowhead length in px for a shaft of `widthPx`. */
export function arrowHeadLength(widthPx: number): number {
  return Math.max(10, widthPx * 4);
}

/**
 * Shaft + filled triangular head(s). The shaft stops short of the tip by the
 * head's length so a round cap never pokes through the point.
 */
export function drawArrow(ctx: Ctx, obj: AnnotationArrow, w: number, h: number): void {
  const x1 = obj.x1 * w, y1 = obj.y1 * h, x2 = obj.x2 * w, y2 = obj.y2 * h;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  const ux = dx / len, uy = dy / len;
  const widthPx = Math.max(1, obj.width * h);
  const head = Math.min(arrowHeadLength(widthPx), len / (obj.heads === 'both' ? 2 : 1));
  const halfBase = head * 0.5;

  ctx.save();
  ctx.strokeStyle = obj.color;
  ctx.fillStyle = obj.color;
  ctx.lineWidth = widthPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Shaft, trimmed under each head
  const sx = obj.heads === 'both' ? x1 + ux * head * 0.8 : x1;
  const sy = obj.heads === 'both' ? y1 + uy * head * 0.8 : y1;
  const ex = x2 - ux * head * 0.8;
  const ey = y2 - uy * head * 0.8;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  const headAt = (tipX: number, tipY: number, dirX: number, dirY: number) => {
    const bx = tipX - dirX * head, by = tipY - dirY * head;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(bx - dirY * halfBase, by + dirX * halfBase);
    ctx.lineTo(bx + dirY * halfBase, by - dirX * halfBase);
    ctx.closePath();
    ctx.fill();
  };
  headAt(x2, y2, ux, uy);
  if (obj.heads === 'both') headAt(x1, y1, -ux, -uy);
  ctx.restore();
}

/** Relative luminance of a #rrggbb colour, 0..1. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  if (Number.isNaN(n)) return 0;
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Text colour that reads on a badge of `fill`. */
export function badgeTextColor(fill: string): string {
  return luminance(fill) > 0.45 ? '#111111' : '#ffffff';
}

/** A filled disc with the number centred, and a thin contrasting ring. */
export function drawCallout(ctx: Ctx, obj: AnnotationCallout, w: number, h: number): void {
  const cx = obj.x * w, cy = obj.y * h;
  const r = Math.max(6, (obj.size * h) / 2);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = obj.color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.strokeStyle = badgeTextColor(obj.color);
  ctx.stroke();
  ctx.fillStyle = badgeTextColor(obj.color);
  ctx.font = `700 ${Math.max(8, r * 1.1)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(obj.n), cx, cy + r * 0.04);
  ctx.restore();
}
