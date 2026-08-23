import { describe, it, expect } from 'vitest';
import { applyAnnotationOps, type AnnotationObject, type AnnotationOp, type AnnotationScene } from '@voxium/shared';
import { inverseOf, addedIds, compactForward } from '../../utils/annotationHistory';

const stroke = (id: string, points = [0.1, 0.1, 0.2, 0.2]): AnnotationObject =>
  ({ id, kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.005, points });
const shape = (id: string, extra: Partial<Record<string, unknown>> = {}): AnnotationObject =>
  ({ id, kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x: 0.1, y: 0.1, w: 0.3, h: 0.2, ...extra }) as AnnotationObject;
const image = (id: string): AnnotationObject =>
  ({ id, kind: 'image', src: 'data:image/webp;base64,AAAA', x: 0.2, y: 0.2, w: 0.2, h: 0.2 });

/** Apply an op, then its inverse, and check the scene is what it was. */
function roundTrip(scene: AnnotationScene, op: AnnotationOp): { after: AnnotationScene; restored: AnnotationScene; inverse: AnnotationOp[] } {
  const inverse = inverseOf(op, scene, new Set());
  const after = applyAnnotationOps(scene, [op]);
  const restored = applyAnnotationOps(after, inverse);
  return { after, restored, inverse };
}

describe('inverseOf — each op round-trips through the shared reducer', () => {
  it('add ↔ remove', () => {
    const { after, restored, inverse } = roundTrip({ objects: [] }, { t: 'add', obj: stroke('a') });
    expect(inverse).toEqual([{ t: 'remove', id: 'a' }]);
    expect(after.objects).toHaveLength(1);
    expect(restored).toEqual({ objects: [] });
  });

  it('a same-id re-add restores what it replaced', () => {
    const before = { objects: [stroke('a', [0, 0, 1, 1])] };
    const { restored, inverse } = roundTrip(before, { t: 'add', obj: stroke('a') });
    expect(inverse).toEqual([{ t: 'add', obj: stroke('a', [0, 0, 1, 1]) }]);
    expect(restored).toEqual(before);
  });

  it('remove ↔ add(snapshot), and removing a missing id needs no inverse', () => {
    const before = { objects: [shape('s')] };
    const { restored } = roundTrip(before, { t: 'remove', id: 's' });
    expect(restored).toEqual(before);
    expect(inverseOf({ t: 'remove', id: 'nope' }, before, new Set())).toEqual([]);
  });

  it('update ↔ update(previous values), only for the keys the patch touched', () => {
    const before = { objects: [shape('s')] };
    const { restored, inverse } = roundTrip(before, { t: 'update', id: 's', patch: { x: 0.5, color: '#0000ff' } });
    expect(inverse).toEqual([{ t: 'update', id: 's', patch: { x: 0.1, color: '#00ff00' } }]);
    expect(restored).toEqual(before);
  });

  it('update of a key that was UNSET before falls back to restoring the object whole', () => {
    // There is no way to patch a key back to undefined on the wire
    const unset = { objects: [{ ...image('i'), w: undefined } as unknown as AnnotationObject] };
    expect(inverseOf({ t: 'update', id: 'i', patch: { w: 0.5 } }, unset, new Set())).toEqual([{ t: 'add', obj: unset.objects[0] }]);
  });

  it('update with only non-patchable keys for that kind needs no inverse (the reducer ignores it too)', () => {
    const before = { objects: [image('i')] };
    const { restored, inverse } = roundTrip(before, { t: 'update', id: 'i', patch: { color: '#123456' } });
    expect(inverse).toEqual([]);
    expect(restored).toEqual(before);
  });

  it('translate ↔ translate(−dx, −dy)', () => {
    const before = { objects: [stroke('a')] };
    const { restored, inverse } = roundTrip(before, { t: 'translate', id: 'a', dx: 0.25, dy: -0.1 });
    expect(inverse).toEqual([{ t: 'translate', id: 'a', dx: -0.25, dy: 0.1 }]);
    expect((restored.objects[0] as { points: number[] }).points.map((v) => Number(v.toFixed(6)))).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it('append ↔ add(pre-append stroke) when the stroke was not added in this gesture', () => {
    const before = { objects: [stroke('a')] };
    const { restored, inverse } = roundTrip(before, { t: 'append', id: 'a', points: [0.3, 0.3] });
    expect(inverse).toEqual([{ t: 'add', obj: stroke('a') }]);
    expect(restored).toEqual(before);
  });

  it('ops on an object ADDED IN THE SAME GESTURE need no inverse — the add\'s remove covers them', () => {
    const added = new Set(['a']);
    const scene = { objects: [stroke('a')] };
    expect(inverseOf({ t: 'append', id: 'a', points: [0.3, 0.3] }, scene, added)).toEqual([]);
    expect(inverseOf({ t: 'update', id: 'a', patch: { color: '#000000' } }, scene, added)).toEqual([]);
    expect(inverseOf({ t: 'translate', id: 'a', dx: 0.1, dy: 0.1 }, scene, added)).toEqual([]);
  });

  it('clear ↔ re-add everything in order', () => {
    const before = { objects: [stroke('a'), shape('s'), image('i')] };
    const { restored, inverse } = roundTrip(before, { t: 'clear' });
    expect(inverse.map((op) => (op as { obj: AnnotationObject }).obj.id)).toEqual(['a', 's', 'i']);
    expect(restored).toEqual(before);
  });
});

describe('addedIds / compactForward', () => {
  it('addedIds lists only the adds', () => {
    expect(addedIds([{ t: 'add', obj: stroke('a') }, { t: 'remove', id: 'b' }, { t: 'add', obj: shape('s') }])).toEqual(['a', 's']);
  });

  it('compacts a stroke gesture (add + N appends) into one add of the finished stroke', () => {
    const forward: AnnotationOp[] = [
      { t: 'add', obj: stroke('a', [0, 0]) },
      { t: 'append', id: 'a', points: [0.1, 0.1] },
      { t: 'append', id: 'a', points: [0.2, 0.2] },
    ];
    const after = applyAnnotationOps({ objects: [] }, forward);
    expect(compactForward(forward, new Set(['a']), after)).toEqual([{ t: 'add', obj: stroke('a', [0, 0, 0.1, 0.1, 0.2, 0.2]) }]);
  });

  it('keeps ops on pre-existing objects verbatim and drops objects added-then-removed', () => {
    const forward: AnnotationOp[] = [
      { t: 'add', obj: shape('tmp') },
      { t: 'update', id: 'tmp', patch: { w: 0.001 } },
      { t: 'remove', id: 'tmp' },          // degenerate click-shape discarded
      { t: 'update', id: 'old', patch: { x: 0.4 } },
    ];
    const after = applyAnnotationOps({ objects: [shape('old')] }, forward);
    expect(compactForward(forward, new Set(['tmp']), after)).toEqual([{ t: 'update', id: 'old', patch: { x: 0.4 } }]);
  });
});
