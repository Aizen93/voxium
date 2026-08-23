/**
 * Mask fills beyond the black box: pixelate and blur. Both are COSMETIC —
 * pixelated or blurred text is partially reversible in principle (a known
 * font on a known block grid), so the toolbar says so and Cover (black)
 * stays the default and the only style that removes information.
 *
 * Pure: a context to paint on, a scratch canvas to downsample into, an image
 * source to sample from. Shared by the compositor (source = the hidden
 * capture video, canvas at source resolution) and the sharer's preview
 * (source = the preview video, canvas at display size) so both show the
 * same picture. Anything missing (no scratch, no filter support) fails
 * CLOSED to a black box, never to the bare region.
 */

export type MaskStyle = 'cover' | 'pixelate' | 'blur';

/** Block edge in SOURCE pixels — large enough that body text is unreadable. */
export const PIXELATE_BLOCK_SRC_PX = 24;
/** Blur radius in SOURCE pixels, applied over the pixelated pass. */
export const BLUR_RADIUS_SRC_PX = 18;

export interface ScratchCanvas {
  canvas: CanvasImageSource & { width: number; height: number };
  ctx: Pick<CanvasRenderingContext2D, 'drawImage' | 'clearRect'> & { imageSmoothingEnabled: boolean };
}

export type StyledMaskCtx = Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect' | 'save' | 'restore' | 'beginPath' | 'rect' | 'clip'>
  & { fillStyle: string | CanvasGradient | CanvasPattern; imageSmoothingEnabled: boolean; filter?: string };

export interface MaskPaintArgs {
  ctx: StyledMaskCtx;
  /** Destination rect on `ctx`, in its pixels (already padded by the caller). */
  dst: { x: number; y: number; w: number; h: number };
  /** Where the same region lives in `source`'s pixels. */
  src: { x: number; y: number; w: number; h: number };
  source: CanvasImageSource;
  scratch: ScratchCanvas | null;
  /** Source pixels per destination pixel (1 for the compositor). */
  scale: number;
}

function blackBox(ctx: StyledMaskCtx, dst: MaskPaintArgs['dst']): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
}

/**
 * Paint one mask with `style`. Returns what was actually painted, so a
 * caller can know a fallback happened.
 */
export function paintStyledMask(style: MaskStyle, args: MaskPaintArgs): MaskStyle {
  const { ctx, dst, src, source, scratch, scale } = args;
  if (style === 'cover' || !scratch || src.w <= 0 || src.h <= 0 || dst.w <= 0 || dst.h <= 0) {
    blackBox(ctx, dst);
    return 'cover';
  }
  try {
    // Downsample the region into a grid of blocks…
    const blocksW = Math.max(1, Math.ceil(src.w / PIXELATE_BLOCK_SRC_PX));
    const blocksH = Math.max(1, Math.ceil(src.h / PIXELATE_BLOCK_SRC_PX));
    scratch.canvas.width = blocksW;
    scratch.canvas.height = blocksH;
    scratch.ctx.imageSmoothingEnabled = false;
    scratch.ctx.drawImage(source, src.x, src.y, src.w, src.h, 0, 0, blocksW, blocksH);

    // …and paint it back up without smoothing: that IS the pixelation
    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch.canvas, 0, 0, blocksW, blocksH, dst.x, dst.y, dst.w, dst.h);

    if (style === 'blur') {
      // Blur ON TOP of the opaque pixelated pass: a blur alone goes
      // translucent at its edges and the raw frame would show through.
      if (typeof ctx.filter !== 'string') {
        ctx.restore();
        blackBox(ctx, dst);
        return 'cover';
      }
      ctx.imageSmoothingEnabled = true;
      ctx.filter = `blur(${Math.max(1, Math.round(BLUR_RADIUS_SRC_PX / scale))}px)`;
      ctx.drawImage(scratch.canvas, 0, 0, blocksW, blocksH, dst.x, dst.y, dst.w, dst.h);
      ctx.filter = 'none';
    }
    ctx.restore();
    return style;
  } catch (err) {
    console.warn('[Masks] Styled mask failed — painting black:', err instanceof Error ? err.message : err);
    try { ctx.restore(); } catch { /* a failed save/clip pair leaves nothing to restore */ }
    blackBox(ctx, dst);
    return 'cover';
  }
}

/** A lazily created scratch canvas, or null where canvases do not exist (tests). */
export function createScratchCanvas(): ScratchCanvas | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}
