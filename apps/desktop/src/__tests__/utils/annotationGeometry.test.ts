import { describe, it, expect } from 'vitest';
import { computeContentRect, normToPx, pxToNorm } from '../../utils/annotationGeometry';

describe('computeContentRect', () => {
  it('letterboxes a wide video in a tall box (bars top/bottom)', () => {
    // 16:9 video in a 400x400 box → 400x225 centered vertically
    const r = computeContentRect(400, 400, 1920, 1080);
    expect(r.x).toBe(0);
    expect(r.w).toBe(400);
    expect(r.h).toBe(225);
    expect(r.y).toBeCloseTo((400 - 225) / 2);
  });

  it('pillarboxes a tall video in a wide box (bars left/right)', () => {
    // 9:16 video in a 800x450 box → height-bound: 253.125x450
    const r = computeContentRect(800, 450, 1080, 1920);
    expect(r.y).toBe(0);
    expect(r.h).toBe(450);
    expect(r.w).toBeCloseTo(253.125);
    expect(r.x).toBeCloseTo((800 - 253.125) / 2);
  });

  it('fills exactly when aspect ratios match', () => {
    const r = computeContentRect(960, 540, 1920, 1080);
    expect(r).toEqual({ x: 0, y: 0, w: 960, h: 540 });
  });

  it('returns a zero rect for unknown or degenerate dimensions', () => {
    expect(computeContentRect(0, 400, 1920, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(computeContentRect(400, 400, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(computeContentRect(400, 400, NaN, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(computeContentRect(-10, 400, 1920, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('coordinate round-trips', () => {
  const rect = { x: 50, y: 87.5, w: 400, h: 225 };

  it('normToPx → pxToNorm is the identity inside the frame', () => {
    for (const [nx, ny] of [[0, 0], [1, 1], [0.5, 0.5], [0.25, 0.8]]) {
      const px = normToPx(nx, ny, rect);
      const back = pxToNorm(px.x, px.y, rect);
      expect(back.x).toBeCloseTo(nx);
      expect(back.y).toBeCloseTo(ny);
    }
  });

  it('clamps out-of-frame pixels to the wire bounds [-0.1, 1.1]', () => {
    const far = pxToNorm(-10_000, 10_000, rect);
    expect(far.x).toBe(-0.1);
    expect(far.y).toBe(1.1);
  });

  it('clamps to [0, 1] when clampToFrame is set (stroke drawing)', () => {
    const far = pxToNorm(-10_000, 10_000, rect, true);
    expect(far.x).toBe(0);
    expect(far.y).toBe(1);
  });

  it('degrades safely on a zero rect', () => {
    expect(pxToNorm(100, 100, { x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 0, y: 0 });
  });
});
