import { describe, it, expect } from 'vitest';
import {
  IDENTITY_ZOOM, ZOOM_MAX, MAGNIFIER_SIZE, MAGNIFIER_ZOOM,
  zoomAt, panBy, clampPan, magnifierSourceRect,
} from '../../utils/stageZoom';

const W = 800, H = 450;

describe('stageZoom math', () => {
  it('clamps the scale to [1, 4] however hard the wheel spins', () => {
    let z = IDENTITY_ZOOM;
    for (let i = 0; i < 50; i++) z = zoomAt(z, 400, 225, 1.5, W, H);
    expect(z.scale).toBe(ZOOM_MAX);
    for (let i = 0; i < 50; i++) z = zoomAt(z, 400, 225, 0.5, W, H);
    expect(z).toEqual(IDENTITY_ZOOM); // fully out snaps to the identity — no residual pan
  });

  it('keeps the stage point under the cursor fixed while zooming', () => {
    // The content point at the cursor: p = (cursor - t) / s. Zooming at the
    // cursor must preserve p (as long as no clamp engages).
    const cursor = { x: 300, y: 200 };
    const z0 = zoomAt(IDENTITY_ZOOM, cursor.x, cursor.y, 2, W, H);
    const p0 = { x: (cursor.x - z0.tx) / z0.scale, y: (cursor.y - z0.ty) / z0.scale };
    const z1 = zoomAt(z0, cursor.x, cursor.y, 1.5, W, H);
    const p1 = { x: (cursor.x - z1.tx) / z1.scale, y: (cursor.y - z1.ty) / z1.scale };
    expect(p1.x).toBeCloseTo(p0.x, 6);
    expect(p1.y).toBeCloseTo(p0.y, 6);
  });

  it('pan is bounded so the video never leaves the stage', () => {
    const z = zoomAt(IDENTITY_ZOOM, 400, 225, 2, W, H); // 2x
    const dragged = panBy(z, 10_000, 10_000, W, H);
    expect(dragged.tx).toBe(0); // top-left edge
    expect(dragged.ty).toBe(0);
    const other = panBy(z, -10_000, -10_000, W, H);
    expect(other.tx).toBe(W * (1 - 2)); // bottom-right edge
    expect(other.ty).toBe(H * (1 - 2));
  });

  it('pan at 1x is a no-op and clampPan pins any state inside the bounds', () => {
    expect(panBy(IDENTITY_ZOOM, 50, 50, W, H)).toBe(IDENTITY_ZOOM);
    expect(clampPan({ scale: 3, tx: 500, ty: -99_999 }, W, H)).toEqual({ scale: 3, tx: 0, ty: H * (1 - 3) });
  });

  it('zooming at a corner clamps the translation to the bounds', () => {
    const z = zoomAt(IDENTITY_ZOOM, 0, 0, 2, W, H); // zoom at top-left corner
    expect(z.tx).toBe(0);
    expect(z.ty).toBe(0);
    const z2 = zoomAt(IDENTITY_ZOOM, W, H, 2, W, H); // bottom-right corner
    expect(z2.tx).toBe(W * (1 - 2));
    expect(z2.ty).toBe(H * (1 - 2));
  });
});

describe('magnifierSourceRect', () => {
  // 1920x1080 video displayed object-contain in an 800x450 stage → content
  // fills the stage exactly (same aspect)
  const content = { x: 0, y: 0, w: 800, h: 450 };
  const side = (MAGNIFIER_SIZE / MAGNIFIER_ZOOM) * (1920 / 800); // displayed px → source px

  it('centers the source rect on the cursor in video pixels', () => {
    const src = magnifierSourceRect(400, 225, content, 1920, 1080)!;
    expect(src.sw).toBeCloseTo(side, 6);
    expect(src.sh).toBeCloseTo(side, 6);
    expect(src.sx).toBeCloseTo(960 - side / 2, 6);
    expect(src.sy).toBeCloseTo(540 - side / 2, 6);
  });

  it('clamps at the edges instead of sampling outside the frame', () => {
    const tl = magnifierSourceRect(0, 0, content, 1920, 1080)!;
    expect(tl.sx).toBe(0);
    expect(tl.sy).toBe(0);
    const br = magnifierSourceRect(800, 450, content, 1920, 1080)!;
    expect(br.sx).toBeCloseTo(1920 - side, 6);
    expect(br.sy).toBeCloseTo(1080 - side, 6);
  });

  it('accounts for letterboxing: cursor in the bars returns null', () => {
    // 4:3 video in a 16:9 stage → pillarboxed content rect
    const boxed = { x: 100, y: 0, w: 600, h: 450 };
    expect(magnifierSourceRect(50, 225, boxed, 800, 600)).toBeNull(); // left bar
    expect(magnifierSourceRect(400, 225, boxed, 800, 600)).not.toBeNull(); // content
  });

  it('refuses degenerate inputs (no content, tiny source, cursor outside)', () => {
    expect(magnifierSourceRect(10, 10, { x: 0, y: 0, w: 0, h: 0 }, 1920, 1080)).toBeNull();
    // A tiny video displayed 1:1 — the lens sample would cover more than the frame
    expect(magnifierSourceRect(50, 30, { x: 0, y: 0, w: 100, h: 60 }, 100, 60)).toBeNull();
    expect(magnifierSourceRect(-5, 225, content, 1920, 1080)).toBeNull();
  });
});
