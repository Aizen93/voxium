import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Helpers for the screen-share spec: reading what a viewer really sees.
 *
 * Nothing here touches application internals. The share stage is found by
 * the testid of its zoom surface (the transformed parent that holds the
 * <video> and the annotation <canvas>), and pixels are read through the DOM
 * in page.evaluate.
 */

/** The <video> of the share stage (the sharer's own preview or a viewer's). */
export function stageVideo(page: Page): Locator {
  return page.getByTestId('zoom-surface').locator('video');
}

/** The annotation overlay canvas of the share stage. */
export function stageCanvas(page: Page): Locator {
  return page.getByTestId('zoom-surface').locator('canvas');
}

/** A rectangle in the video frame, as fractions of its width and height. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mean colour (0-255) of a region of the stage video's CURRENT frame. */
export async function sampleVideoRegion(
  page: Page,
  r: NormRect,
): Promise<{ r: number; g: number; b: number; luma: number; width: number; height: number }> {
  return stageVideo(page).evaluate((video: HTMLVideoElement, rect: NormRect) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return { r: -1, g: -1, b: -1, luma: -1, width: w, height: h };
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(video, 0, 0, w, h);
    const x = Math.floor(rect.x * w);
    const y = Math.floor(rect.y * h);
    const rw = Math.max(1, Math.floor(rect.w * w));
    const rh = Math.max(1, Math.floor(rect.h * h));
    const data = ctx.getImageData(x, y, rw, rh).data;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
    }
    const mr = sr / n;
    const mg = sg / n;
    const mb = sb / n;
    return { r: mr, g: mg, b: mb, luma: 0.2126 * mr + 0.7152 * mg + 0.0722 * mb, width: w, height: h };
  }, r);
}

/**
 * Highest alpha (0-255) in a small square around a point of the annotation
 * canvas. The canvas is transparent wherever nothing is drawn, so a value
 * above zero means ink (or a mask) sits there.
 */
export async function maxCanvasAlphaAround(page: Page, nx: number, ny: number, radiusPx = 4): Promise<number> {
  return stageCanvas(page)
    .first()
    .evaluate(
      (canvas: HTMLCanvasElement, args: { nx: number; ny: number; radiusPx: number }) => {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no 2d context');
        const cx = Math.round(args.nx * canvas.width);
        const cy = Math.round(args.ny * canvas.height);
        const x = Math.max(0, cx - args.radiusPx);
        const y = Math.max(0, cy - args.radiusPx);
        const w = Math.min(canvas.width - x, args.radiusPx * 2 + 1);
        const h = Math.min(canvas.height - y, args.radiusPx * 2 + 1);
        const data = ctx.getImageData(x, y, w, h).data;
        let max = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > max) max = data[i];
        return max;
      },
      { nx, ny, radiusPx },
    );
}

/**
 * Drag the mouse across a layer from one normalized point to another, in
 * several steps so the pointermove handlers see a path and not a jump.
 */
export async function dragOnLayer(
  page: Page,
  layer: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  const box = await layer.boundingBox();
  if (!box) throw new Error('layer has no bounding box');
  const at = (p: { x: number; y: number }) => ({ x: box.x + p.x * box.width, y: box.y + p.y * box.height });
  const a = at(from);
  const b = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  await page.mouse.up();
}

/** Wait until the stage video plays: decoded frames and an advancing clock. */
export async function expectVideoPlaying(page: Page): Promise<void> {
  const video = stageVideo(page);
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { message: 'video has decoded frames' })
    .toBeGreaterThan(0);
  const first = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { message: 'video clock advances' })
    .toBeGreaterThan(first);
}
