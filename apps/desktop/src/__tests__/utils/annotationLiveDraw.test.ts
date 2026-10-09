import { describe, it, expect } from 'vitest';
import { ANNOTATION_LIVE_POINTER_FADE_MS } from '@voxium/shared';
import { drawLivePointer, LIVE_POINTER_COLOR } from '../../utils/annotationLiveDraw';

/** A recording 2D context: every call and property write, in order. */
function recordingContext() {
  const calls: Array<[string, unknown[]]> = [];
  const props: Record<string, unknown[]> = {};
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key in props) return props[key][props[key].length - 1];
      return (...args: unknown[]) => { calls.push([key, args]); };
    },
    set(_t, key: string, value) {
      (props[key] ??= []).push(value);
      return true;
    },
  });
  return { ctx: ctx as never, calls, props };
}

const pointer = (at: number, trail = 0) => ({
  x: 0.5, y: 0.25, at,
  trail: Array.from({ length: trail }, (_, i) => ({ x: 0.1 * i, y: 0.1, at: at - (trail - i) * 50 })),
});

describe('drawLivePointer', () => {
  it('paints the ring then the dot at the scaled position, fully opaque while fresh', () => {
    const { ctx, calls, props } = recordingContext();
    const alive = drawLivePointer(ctx, pointer(1000), 1000, 800, 400);
    expect(alive).toBe(true);
    const arcs = calls.filter(([name]) => name === 'arc').map(([, args]) => args);
    expect(arcs).toHaveLength(2);
    expect(arcs[0].slice(0, 3)).toEqual([400, 100, Math.max(5, 400 * 0.012) + 2]); // ring, 2px wider
    expect(arcs[1].slice(0, 3)).toEqual([400, 100, Math.max(5, 400 * 0.012)]);
    expect(props.fillStyle).toEqual(['#ffffff', LIVE_POINTER_COLOR]);
    expect(props.globalAlpha).toEqual([1]);
    expect(calls[0][0]).toBe('save');
    expect(calls[calls.length - 1][0]).toBe('restore');
  });

  it('draws one tail segment per trail point, each more opaque and wider than the last', () => {
    const { ctx, calls, props } = recordingContext();
    drawLivePointer(ctx, pointer(1000, 3), 1000, 800, 400);
    expect(calls.filter(([name]) => name === 'stroke')).toHaveLength(3);
    const alphas = props.globalAlpha.slice(0, 3) as number[];
    expect(alphas[0]).toBeLessThan(alphas[1]);
    expect(alphas[1]).toBeLessThan(alphas[2]);
    const widths = props.lineWidth as number[];
    expect(widths[0]).toBeLessThan(widths[2]);
    expect(props.strokeStyle).toEqual([LIVE_POINTER_COLOR]);
  });

  it('fades out over the tail of the window and reports false once gone', () => {
    const third = ANNOTATION_LIVE_POINTER_FADE_MS / 3;
    const at = 5000;
    const alphaAt = (now: number) => {
      const { ctx, props } = recordingContext();
      const alive = drawLivePointer(ctx, pointer(at), now, 800, 400);
      return alive ? (props.globalAlpha as number[]).at(-1)! : null;
    };
    expect(alphaAt(at + third)).toBe(1);
    expect(alphaAt(at + third + (ANNOTATION_LIVE_POINTER_FADE_MS - third) / 2)).toBeCloseTo(0.5);
    expect(alphaAt(at + ANNOTATION_LIVE_POINTER_FADE_MS - 1)).toBeGreaterThan(0);
    expect(alphaAt(at + ANNOTATION_LIVE_POINTER_FADE_MS)).toBeNull();
  });
});
