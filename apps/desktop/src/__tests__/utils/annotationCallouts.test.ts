import { describe, it, expect } from 'vitest';
import { ANNOTATION_CALLOUT_MAX, type AnnotationObject } from '@voxium/shared';
import { nextCalloutNumber, readingOrder, renumberOps, callouts } from '../../utils/annotationCallouts';

const c = (id: string, n: number, x: number, y: number): AnnotationObject =>
  ({ id, kind: 'callout', color: '#ff3b30', size: 0.06, x, y, n });
const shape: AnnotationObject = { id: 'sh', kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x: 0, y: 0, w: 0.1, h: 0.1 };

describe('annotationCallouts', () => {
  it('the next number is max + 1 — stable across deletions, never a reused gap', () => {
    expect(nextCalloutNumber([])).toBe(1);
    expect(nextCalloutNumber([c('a', 1, 0, 0), c('b', 3, 0, 0), shape])).toBe(4); // ② was deleted; ④ comes next
    expect(nextCalloutNumber([c('a', ANNOTATION_CALLOUT_MAX, 0, 0)])).toBeNull();
  });

  it('reading order is rows top-to-bottom, left-to-right within a row band', () => {
    const items = callouts([
      c('right-top', 9, 0.8, 0.10),
      c('left-top', 9, 0.2, 0.13),    // 0.03 lower but the same row: left first
      c('bottom', 9, 0.1, 0.60),
      c('mid', 9, 0.5, 0.35),
    ]);
    expect(readingOrder(items).map((x) => x.id)).toEqual(['left-top', 'right-top', 'mid', 'bottom']);
  });

  it('renumberOps emits updates only for badges whose number changes', () => {
    const objects = [c('a', 5, 0.1, 0.1), c('b', 2, 0.5, 0.1), c('cc', 3, 0.1, 0.5), shape];
    expect(renumberOps(objects)).toEqual([
      { t: 'update', id: 'a', patch: { n: 1 } },
      // b is already ② in reading order → no op
      // cc is already ③ → no op
    ]);
    expect(renumberOps([shape])).toEqual([]);
  });
});
