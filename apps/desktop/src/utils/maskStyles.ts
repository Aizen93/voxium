/**
 * Mask fills beyond the black box: pixelate and blur. Both are COSMETIC —
 * a pixelated or blurred region still ships a low-pass of its content, and
 * pixelated text can sometimes be recovered — so the toolbar says so and
 * Cover (black) stays the default and the only style that removes
 * information.
 *
 * What the implementation guarantees, so the "cosmetic" claim means what it
 * says and no more:
 * - Every block is the MEAN of a PIXELATE_BLOCK_SRC_PX² source square, never
 *   a point sample (a nearest-neighbour downscale ships one raw pixel per
 *   block — a sliding raw-pixel dump the moment the mask or the content
 *   moves). Means come from a chain of exact 2× bilinear halvings.
 * - The block lattice is anchored to SOURCE coordinates, so dragging or
 *   resizing the mask re-samples nothing: the same source square always
 *   produces the same block.
 * - The scratch surfaces are pre-filled black and the sampled region is
 *   clamped to the video, so an edge cell or a not-yet-ready frame can only
 *   darken a block, never let the raw frame through.
 * - Blur is painted OVER the opaque pixelated pass (a blur alone goes
 *   translucent at its edges), inside a clip to the mask.
 * - Anything missing or failing (no scratch, no filter support, a throwing
 *   drawImage) falls back to the black box.
 *
 * Pure: a context to paint on, two scratch surfaces to halve through, an
 * image source to sample from. Shared by the compositor (source = the hidden
 * capture video, canvas at source resolution) and the sharer's preview
 * (source = the preview video, canvas at display size) so both show the
 * same picture.
 */

export type MaskStyle = 'cover' | 'pixelate' | 'blur';

/** Halvings from source resolution to one block — 2^5 = 32 source px. */
const HALVINGS = 5;
/** Block edge in SOURCE pixels (a power of two: reached by exact 2× halvings). */
export const PIXELATE_BLOCK_SRC_PX = 2 ** HALVINGS;
/** Blur radius in SOURCE pixels, applied over the pixelated pass. */
export const BLUR_RADIUS_SRC_PX = 18;

export interface ScratchSurface {
  canvas: CanvasImageSource & { width: number; height: number };
  ctx: Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect'> & { imageSmoothingEnabled: boolean; fillStyle: string | CanvasGradient | CanvasPattern };
}

/** Two surfaces to ping-pong the halvings through. */
export interface ScratchCanvas {
  a: ScratchSurface;
  b: ScratchSurface;
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
  /** The source's intrinsic size, to clamp sampling to real pixels. */
  sourceSize: { w: number; h: number };
  scratch: ScratchCanvas | null;
  /** Source pixels per destination pixel (1 for the compositor). */
  scale: number;
}

function blackBox(ctx: StyledMaskCtx, dst: MaskPaintArgs['dst']): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
}

/** Size a surface and pre-fill it black. Assigning width/height reallocates
 *  the backing store even for the same value — at 5 surfaces per mask per
 *  frame that was megabytes of churn per second — so only resize on change;
 *  the black fill alone fully overwrites stale content. */
function prepare(s: ScratchSurface, w: number, h: number): void {
  if (s.canvas.width !== w) s.canvas.width = w;
  if (s.canvas.height !== h) s.canvas.height = h;
  s.ctx.imageSmoothingEnabled = true;
  s.ctx.fillStyle = '#000000';
  s.ctx.fillRect(0, 0, w, h);
}

/**
 * The block lattice cell range covering `src`, in source pixels, clamped to
 * the source. Anchored to the source origin: independent of the mask.
 */
export function alignedCells(src: MaskPaintArgs['src'], sourceSize: MaskPaintArgs['sourceSize']): { x0: number; y0: number; x1: number; y1: number } | null {
  const B = PIXELATE_BLOCK_SRC_PX;
  const x0 = Math.max(0, Math.floor(src.x / B) * B);
  const y0 = Math.max(0, Math.floor(src.y / B) * B);
  const x1 = Math.min(Math.ceil(sourceSize.w / B) * B, Math.ceil((src.x + src.w) / B) * B);
  const y1 = Math.min(Math.ceil(sourceSize.h / B) * B, Math.ceil((src.y + src.h) / B) * B);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Paint one mask with `style`. Returns what was actually painted, so a
 * caller can know a fallback happened.
 */
export function paintStyledMask(style: MaskStyle, args: MaskPaintArgs): MaskStyle {
  const { ctx, dst, src, source, sourceSize, scratch, scale } = args;
  if (style === 'cover' || !scratch || dst.w <= 0 || dst.h <= 0 || sourceSize.w <= 0 || sourceSize.h <= 0) {
    blackBox(ctx, dst);
    return 'cover';
  }
  const cells = alignedCells(src, sourceSize);
  if (!cells) {
    blackBox(ctx, dst);
    return 'cover';
  }
  let saved = false;
  try {
    const B = PIXELATE_BLOCK_SRC_PX;
    const gw = cells.x1 - cells.x0, gh = cells.y1 - cells.y0;
    const blocksW = gw / B, blocksH = gh / B;

    // Halve down to one pixel per block. Each bilinear 2× reduction is an
    // exact 2×2 box mean, so the final pixel is the mean of a B×B square.
    // The part of the last cell column/row that lies outside the source is
    // pre-filled black: an edge block can only darken, never leak.
    let from: CanvasImageSource = source;
    let fromRect = { x: cells.x0, y: cells.y0, w: Math.min(gw, sourceSize.w - cells.x0), h: Math.min(gh, sourceSize.h - cells.y0) };
    let w = gw, h = gh;
    let surfaces = [scratch.a, scratch.b];
    for (let i = 0; i < HALVINGS; i++) {
      const target = surfaces[0];
      const nw = w / 2, nh = h / 2;
      prepare(target, nw, nh);
      target.ctx.drawImage(from, fromRect.x, fromRect.y, fromRect.w, fromRect.h, 0, 0, (fromRect.w / w) * nw, (fromRect.h / h) * nh);
      from = target.canvas;
      fromRect = { x: 0, y: 0, w: nw, h: nh };
      w = nw; h = nh;
      surfaces = [surfaces[1], surfaces[0]];
    }
    const blocks = from; // blocksW × blocksH

    // Paint the lattice back at its SOURCE-anchored position, clipped to the
    // mask: the mask's edges cut through blocks, the blocks never move.
    const dx = dst.x + (cells.x0 - src.x) / scale;
    const dy = dst.y + (cells.y0 - src.y) / scale;
    const dw = gw / scale, dh = gh / scale;
    ctx.save();
    saved = true;
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    // Fail-closed BY CONSTRUCTION, not by drawImage semantics: a video with
    // no current frame makes drawImage a silent no-op (no throw, so the
    // catch never runs) — the region must already be opaque before the
    // block pass lands on top.
    ctx.fillStyle = '#000000';
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(blocks, 0, 0, blocksW, blocksH, dx, dy, dw, dh);

    if (style === 'blur') {
      // Blur ON TOP of the opaque pixelated pass: a blur alone goes
      // translucent at its edges and the raw frame would show through.
      if (typeof ctx.filter !== 'string') {
        ctx.restore();
        saved = false; // balanced — the catch must not restore a second time
        blackBox(ctx, dst);
        return 'cover';
      }
      ctx.imageSmoothingEnabled = true;
      ctx.filter = `blur(${Math.max(1, Math.round(BLUR_RADIUS_SRC_PX / scale))}px)`;
      ctx.drawImage(blocks, 0, 0, blocksW, blocksH, dx, dy, dw, dh);
      ctx.filter = 'none';
    }
    ctx.restore();
    return style;
  } catch (err) {
    console.warn('[Masks] Styled mask failed — painting black:', err instanceof Error ? err.message : err);
    // Only pop what THIS function pushed — a throw before save() must not
    // steal a caller's stacked state
    if (saved) {
      try { ctx.restore(); } catch { /* a broken context; the black box below is what matters */ }
    }
    blackBox(ctx, dst);
    return 'cover';
  }
}

function surface(): ScratchSurface | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

/** A lazily created pair of scratch surfaces, or null where canvases do not exist (tests). */
export function createScratchCanvas(): ScratchCanvas | null {
  if (typeof document === 'undefined') return null;
  const a = surface();
  const b = surface();
  return a && b ? { a, b } : null;
}
