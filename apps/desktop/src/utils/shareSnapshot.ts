import { LIMITS, type AnnotationScene } from '@voxium/shared';
import { drawScene } from '../components/voice/AnnotationCanvas';
import { createScratchCanvas } from './maskStyles';
import type { MaskRect } from '../stores/annotationStore';

/**
 * Snapshot of the share (item 10): the current frame with its annotations
 * burned in — composed video → masks → scene, in that order.
 *
 * THE MASK PASS IS NOT OPTIONAL FOR THE SHARER: their preview <video> is the
 * RAW capture (the compositor sits between capture and producer, not in the
 * preview), so a snapshot without the mask pass would be the one way covered
 * pixels leave the machine. Viewers' streams already carry the masks baked
 * in — they pass `masks: []`. The caller decides which, and the tests pin it.
 */

export const SNAPSHOT_MAX_EDGE = 2560;
export const SNAPSHOT_WEBP_QUALITY = 0.92;

type Fading = Parameters<typeof drawScene>[6];

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Compose the snapshot at SOURCE resolution. The scene pass runs on its own
 * transparent canvas (drawScene clears its surface first, which would erase
 * the video frame on a shared one) and is composited over the frame.
 * Vanishing strokes and the spotlight are captured exactly as currently seen
 * (the live fading clocks are passed through).
 */
export function composeSnapshotCanvas(
  video: HTMLVideoElement,
  scene: AnnotationScene,
  masks: MaskRect[],
  fading: Fading,
): HTMLCanvasElement | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w <= 0 || h <= 0) return null;
  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  const ctx = base.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);

  const overlay = document.createElement('canvas');
  overlay.width = w;
  overlay.height = h;
  const octx = overlay.getContext('2d');
  if (!octx) return null;
  // pruneCache: false — this one-shot canvas must not evict the live viewer
  // canvas's decoded images (same rule as the pre-flight's masks-only canvas)
  drawScene(octx, scene, masks, w, h, () => {}, fading, Date.now(), { video, scratch: createScratchCanvas() }, false);
  ctx.drawImage(overlay, 0, 0);
  return base;
}

/**
 * Encode WebP at q=0.92; a result over the attachment cap retries once at a
 * 2560px longest edge, and null means "still too big" (the caller toasts) —
 * never silently a different format or quality.
 */
export async function encodeSnapshot(canvas: HTMLCanvasElement): Promise<Blob | null> {
  let blob = await toBlob(canvas, 'image/webp', SNAPSHOT_WEBP_QUALITY);
  if (!blob) return null;
  if (blob.size > LIMITS.MAX_ATTACHMENT_SIZE && Math.max(canvas.width, canvas.height) > SNAPSHOT_MAX_EDGE) {
    const scale = SNAPSHOT_MAX_EDGE / Math.max(canvas.width, canvas.height);
    const scaled = document.createElement('canvas');
    scaled.width = Math.max(1, Math.round(canvas.width * scale));
    scaled.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = scaled.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    blob = await toBlob(scaled, 'image/webp', SNAPSHOT_WEBP_QUALITY);
    if (!blob) return null;
  }
  return blob.size <= LIMITS.MAX_ATTACHMENT_SIZE ? blob : null;
}

/** Clipboard wants PNG — ClipboardItem support for WebP is not universal. */
export function encodeSnapshotPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return toBlob(canvas, 'image/png');
}
