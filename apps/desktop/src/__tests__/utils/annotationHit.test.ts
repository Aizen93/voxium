import { describe, it, expect } from 'vitest';
import type { AnnotationObject } from '@voxium/shared';
import {
  normBox, clampBox, clampTranslation, objectBbox, textBbox,
  hitTestBox, distToSegment, hitTestPolyline, hitTestObject, topmostHit,
  type Bbox,
} from '../../utils/annotationHit';

/** Float-tolerant box comparison (0.4 - 0.1 is not 0.3 in IEEE 754). */
function expectBox(actual: Bbox | null, expected: Bbox) {
  expect(actual).not.toBeNull();
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(actual![key]).toBeCloseTo(expected[key], 10);
}

const stroke = (points: number[], width = 0.004): AnnotationObject =>
  ({ id: 'st', kind: 'stroke', tool: 'pen', color: '#ff0000', width, points });
const shape = (x: number, y: number, w: number, h: number): AnnotationObject =>
  ({ id: 'sh', kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x, y, w, h });
const arrow = (x1: number, y1: number, x2: number, y2: number): AnnotationObject =>
  ({ id: 'ar', kind: 'arrow', color: '#00ff00', width: 0.004, x1, y1, x2, y2 });

describe('annotationHit — boxes and clamping', () => {
  it('normBox normalizes inverted drags', () => {
    expectBox(normBox(0.8, 0.7, 0.2, 0.1), { x: 0.2, y: 0.1, w: 0.6, h: 0.6 });
  });

  it('clampBox keeps every value inside the wire bounds', () => {
    expect(clampBox({ x: -0.5, y: 2, w: 3, h: -1 })).toEqual({ x: -0.1, y: 1.1, w: 1.1, h: 0 });
  });

  it('clampTranslation stops a move at the wire edge (the server rejects, never clamps)', () => {
    const box = { x: 0.9, y: 0.9, w: 0.15, h: 0.15 };
    const atEdge = clampTranslation(box, 0.5, 0.5);
    expect(atEdge.dx).toBeCloseTo(0.05, 10);
    expect(atEdge.dy).toBeCloseTo(0.05, 10);
    const atStart = clampTranslation(box, -2, -2);
    expect(atStart.dx).toBeCloseTo(-1, 10);
    expect(atStart.dy).toBeCloseTo(-1, 10);
    expect(clampTranslation(box, 0.01, -0.02)).toEqual({ dx: 0.01, dy: -0.02 });
  });
});

describe('annotationHit — objectBbox per kind', () => {
  it('shape / image / spotlight use their box', () => {
    expectBox(objectBbox(shape(0.1, 0.2, 0.3, 0.4)), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expectBox(objectBbox({ id: 'sp', kind: 'spotlight', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it('text is estimated from its length and size', () => {
    const box = textBbox({ x: 0.1, y: 0.1, size: 0.05, text: 'hello' });
    expect(box).toEqual({ x: 0.1, y: 0.1, w: 5 * 0.05 * 0.55, h: 0.05 });
    expect(objectBbox({ id: 't', kind: 'text', text: '', color: '#fff000', size: 0.05, x: 0, y: 0 })!.w).toBe(0.02);
  });

  it('a callout is a circle centred on its point', () => {
    expect(objectBbox({ id: 'c', kind: 'callout', color: '#fff000', size: 0.1, x: 0.5, y: 0.5, n: 1 })).toEqual({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 });
  });

  it('an arrow is the box of its endpoints, a stroke the box of its points', () => {
    expectBox(objectBbox(arrow(0.9, 0.1, 0.2, 0.6)), { x: 0.2, y: 0.1, w: 0.7, h: 0.5 });
    expectBox(objectBbox(stroke([0.5, 0.5, 0.1, 0.9, 0.7, 0.2])), { x: 0.1, y: 0.2, w: 0.6, h: 0.7 });
    expect(objectBbox(stroke([]))).toBeNull();
  });

  it('unknown kinds (a future wire version) have no box', () => {
    expect(objectBbox({ id: 'z', kind: 'alien' } as unknown as AnnotationObject)).toBeNull();
  });
});

describe('annotationHit — hit-testing', () => {
  it('hitTestBox pads the box and rejects null', () => {
    expect(hitTestBox({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 0.205, 0.15)).toBe(true);
    expect(hitTestBox({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 0.22, 0.15)).toBe(false);
    expect(hitTestBox(null, 0.1, 0.1)).toBe(false);
  });

  it('distToSegment measures to the segment, not the infinite line', () => {
    expect(distToSegment(0.5, 0.6, 0, 0.5, 1, 0.5)).toBeCloseTo(0.1);
    expect(distToSegment(2, 0.5, 0, 0.5, 1, 0.5)).toBeCloseTo(1); // past the end → distance to the endpoint
    expect(distToSegment(0.3, 0.3, 0.3, 0.3, 0.3, 0.3)).toBe(0);   // degenerate segment
  });

  it('a stroke is hit along its path within half its width plus the pad, not inside its loop', () => {
    // A big square loop
    const loop = stroke([0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8, 0.2, 0.2], 0.01);
    expect(hitTestObject(loop, 0.5, 0.2)).toBe(true);    // on the top edge
    expect(hitTestObject(loop, 0.5, 0.212)).toBe(true);  // within width/2 + pad = 0.013
    expect(hitTestObject(loop, 0.5, 0.5)).toBe(false);   // the empty middle — a bbox would say yes
    expect(hitTestPolyline([0.5, 0.5], 0.505, 0.5, 0.01)).toBe(true); // single-point stroke = a dot
    expect(hitTestPolyline([], 0, 0, 1)).toBe(false);
  });

  it('an arrow is hit along its shaft', () => {
    const a = arrow(0.1, 0.1, 0.9, 0.9);
    expect(hitTestObject(a, 0.5, 0.5)).toBe(true);
    expect(hitTestObject(a, 0.5, 0.6)).toBe(false);
  });

  it('topmostHit returns the LAST drawn object under the point and honours the filter', () => {
    const under = shape(0.1, 0.1, 0.5, 0.5);
    const over = { ...shape(0.2, 0.2, 0.2, 0.2), id: 'over' } as AnnotationObject;
    expect(topmostHit([under, over], 0.3, 0.3)?.id).toBe('over');
    expect(topmostHit([under, over], 0.3, 0.3, (o) => o.id !== 'over')?.id).toBe('sh');
    expect(topmostHit([under, over], 0.95, 0.95)).toBeNull();
  });
});
