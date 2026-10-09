import { ANNOTATION_LIVE_POINTER_FADE_MS } from '@voxium/shared';
import type { LivePointer } from '../stores/annotationLiveStore';

/** The laser's colour — the pen's default red, so it reads as "the sharer". */
export const LIVE_POINTER_COLOR = '#ff3b30';

type Ctx = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'arc' | 'fill' | 'stroke' | 'moveTo' | 'lineTo'>
  & { globalAlpha: number; fillStyle: string | CanvasGradient | CanvasPattern; strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; lineCap: CanvasLineCap };

/**
 * Paint the laser pointer: a short tail fading along its length, then the
 * dot with a white ring, the whole thing fading out over the last part of
 * ANNOTATION_LIVE_POINTER_FADE_MS after the latest update (on the LOCAL
 * clock — a missed pointer-off costs nothing). Returns false once fully
 * faded so the scheduler knows there is nothing left to animate.
 */
export function drawLivePointer(ctx: Ctx, pointer: LivePointer, now: number, w: number, h: number): boolean {
  const age = now - pointer.at;
  if (age >= ANNOTATION_LIVE_POINTER_FADE_MS) return false;
  // Hold at full strength for the first third, then fade to nothing
  const hold = ANNOTATION_LIVE_POINTER_FADE_MS / 3;
  const alpha = age <= hold ? 1 : 1 - (age - hold) / (ANNOTATION_LIVE_POINTER_FADE_MS - hold);
  const radius = Math.max(5, h * 0.012);

  ctx.save();
  // Tail: oldest→newest, each segment a little more opaque and a little wider
  const tail = pointer.trail;
  if (tail.length > 0) {
    ctx.strokeStyle = LIVE_POINTER_COLOR;
    ctx.lineCap = 'round';
    for (let i = 0; i < tail.length; i++) {
      const from = tail[i];
      const to = i + 1 < tail.length ? tail[i + 1] : pointer;
      const k = (i + 1) / (tail.length + 1);
      ctx.globalAlpha = alpha * 0.5 * k;
      ctx.lineWidth = radius * (0.4 + 0.6 * k);
      ctx.beginPath();
      ctx.moveTo(from.x * w, from.y * h);
      ctx.lineTo(to.x * w, to.y * h);
      ctx.stroke();
    }
  }
  // Dot with a white ring so it reads on any background
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(pointer.x * w, pointer.y * h, radius + 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(pointer.x * w, pointer.y * h, radius, 0, Math.PI * 2);
  ctx.fillStyle = LIVE_POINTER_COLOR;
  ctx.fill();
  ctx.restore();
  return true;
}
