import { describe, it, expect } from 'vitest';
import type { AnnotationArrow, AnnotationCallout, AnnotationSpotlight } from '@voxium/shared';
import { drawArrow, drawCallout, drawSpotlight, arrowHeadLength, badgeTextColor, luminance, SPOTLIGHT_DIM } from '../../utils/annotationDraw';

function recordingContext() {
  const calls: Array<[string, unknown[]]> = [];
  const props: Record<string, unknown[]> = {};
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key in props) return props[key][props[key].length - 1];
      return (...args: unknown[]) => { calls.push([key, args]); };
    },
    set(_t, key: string, value) { (props[key] ??= []).push(value); return true; },
  });
  return { ctx: ctx as never, calls, props };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('drawArrow', () => {
  const arrow: AnnotationArrow = { id: 'a', kind: 'arrow', color: '#0a84ff', width: 0.005, x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5 };

  it('draws a shaft that stops short of the tip, then a filled head pointing along the arrow', () => {
    const { ctx, calls, props } = recordingContext();
    drawArrow(ctx, arrow, 1000, 500); // horizontal, left→right, 800px long
    const widthPx = 0.005 * 500;
    const head = arrowHeadLength(widthPx);
    const moves = calls.filter(([n]) => n === 'moveTo').map(([, a]) => a as number[]);
    const lines = calls.filter(([n]) => n === 'lineTo').map(([, a]) => a as number[]);
    // Shaft from p1 to (tip − 0.8·head)
    expect(moves[0]).toEqual([100, 250]);
    expect(near(lines[0][0], 900 - head * 0.8)).toBe(true);
    expect(lines[0][1]).toBe(250);
    // Head: tip at p2, base corners ±halfBase perpendicular, `head` behind the tip
    expect(moves[1]).toEqual([900, 250]);
    expect(near(lines[1][0], 900 - head)).toBe(true);
    expect(near(lines[1][1], 250 + head * 0.5)).toBe(true);
    expect(near(lines[2][1], 250 - head * 0.5)).toBe(true);
    expect(calls.filter(([n]) => n === 'fill')).toHaveLength(1);
    expect(calls.filter(([n]) => n === 'stroke')).toHaveLength(1);
    expect(props.fillStyle).toEqual(['#0a84ff']);
    expect(props.lineWidth).toEqual([widthPx]);
  });

  it('heads: both draws a second head at p1, pointing back', () => {
    const { ctx, calls } = recordingContext();
    drawArrow(ctx, { ...arrow, heads: 'both' }, 1000, 500);
    expect(calls.filter(([n]) => n === 'fill')).toHaveLength(2);
    const moves = calls.filter(([n]) => n === 'moveTo').map(([, a]) => a as number[]);
    expect(moves[2]).toEqual([100, 250]); // second head's tip at p1
  });

  it('a zero-length arrow draws nothing', () => {
    const { ctx, calls } = recordingContext();
    drawArrow(ctx, { ...arrow, x2: 0.1, y2: 0.5 }, 1000, 500);
    expect(calls).toEqual([]);
  });
});

describe('drawSpotlight', () => {
  const spot: AnnotationSpotlight = { id: 's', kind: 'spotlight', x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

  it('fills the whole frame with an even-odd path whose inner contour is the cut-out', () => {
    const { ctx, calls, props } = recordingContext();
    drawSpotlight(ctx, spot, 800, 400);
    const rects = calls.filter(([n]) => n === 'rect').map(([, a]) => a);
    expect(rects).toEqual([[0, 0, 800, 400], [200, 100, 400, 200]]);
    expect(calls.filter(([n]) => n === 'fill').map(([, a]) => a)).toEqual([['evenodd']]);
    expect(props.fillStyle).toEqual([SPOTLIGHT_DIM]);
    expect(calls.filter(([n]) => n === 'ellipse')).toHaveLength(0);
  });

  it('an elliptical spotlight cuts an ellipse inscribed in its box', () => {
    const { ctx, calls } = recordingContext();
    drawSpotlight(ctx, { ...spot, shape: 'ellipse' }, 800, 400);
    const [ellipse] = calls.filter(([n]) => n === 'ellipse').map(([, a]) => a as number[]);
    expect(ellipse.slice(0, 4)).toEqual([400, 200, 200, 100]);
    expect(calls.filter(([n]) => n === 'rect')).toHaveLength(1); // only the frame
  });
});

describe('drawCallout', () => {
  const badge: AnnotationCallout = { id: 'c', kind: 'callout', color: '#ffd60a', size: 0.06, x: 0.5, y: 0.5, n: 7 };

  it('paints a disc of the badge size at the centre with the number in a contrasting colour', () => {
    const { ctx, calls, props } = recordingContext();
    drawCallout(ctx, badge, 800, 450);
    const [arc] = calls.filter(([n]) => n === 'arc').map(([, a]) => a as number[]);
    expect(arc.slice(0, 3)).toEqual([400, 225, (0.06 * 450) / 2]);
    const [text] = calls.filter(([n]) => n === 'fillText').map(([, a]) => a);
    expect(text[0]).toBe('7');
    expect(text[1]).toBe(400);
    // Yellow is light → dark digits; the ring uses the same contrast colour
    expect(props.fillStyle).toEqual(['#ffd60a', '#111111']);
    expect(props.strokeStyle).toEqual(['#111111']);
    expect(props.textAlign).toEqual(['center']);
  });

  it('picks white digits on a dark badge', () => {
    expect(badgeTextColor('#111111')).toBe('#ffffff');
    expect(badgeTextColor('#ff3b30')).toBe('#ffffff');
    expect(badgeTextColor('#ffffff')).toBe('#111111');
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('nope')).toBe(0);
  });
});
