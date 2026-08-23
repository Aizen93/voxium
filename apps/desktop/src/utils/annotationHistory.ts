import { patchableKeysFor, type AnnotationObject, type AnnotationOp, type AnnotationPatch, type AnnotationScene } from '@voxium/shared';

/**
 * Undo/redo for the sharer, as INVERSE OPS.
 *
 * The wire only speaks ops, so undoing has to send something; the inverse of
 * each op, computed against the scene it was applied to, is exactly what the
 * viewers need and is small (a scene-snapshot diff would be a second reducer).
 * The one heavy case is undoing `clear`, which re-sends whole objects — the
 * op queue chunks by bytes for that reason.
 *
 * A history ENTRY is one user gesture: a whole stroke, a whole drag, one
 * recolour. The editor brackets drags with begin/endGesture; everything
 * applied outside a gesture is an entry of its own.
 */

export interface HistoryEntry {
  /** What to re-apply on redo (compacted: a stroke is one add, not 300 appends). */
  forward: AnnotationOp[];
  /** What to apply on undo, already in application order. */
  inverse: AnnotationOp[];
  /** Serialized size of both lists — what the byte budget counts. */
  bytes: number;
}

/** Serialized size of an entry (objects shared between entries are counted
 *  once per entry — a deliberate over-estimate that keeps the budget simple). */
export function entryBytes(forward: AnnotationOp[], inverse: AnnotationOp[]): number {
  return JSON.stringify(forward).length + JSON.stringify(inverse).length;
}

function findObject(scene: AnnotationScene, id: string): AnnotationObject | undefined {
  return scene.objects.find((o) => o.id === id);
}

/** Re-add an object at the z-index it had — `add` appends on top otherwise,
 *  and "undo put it back above what was drawn over it" is not a restore. */
function readdInPlace(scene: AnnotationScene, existing: AnnotationObject): AnnotationOp {
  return { t: 'add', obj: existing, at: scene.objects.indexOf(existing) };
}

/**
 * The inverse of ONE op against the scene it is about to be applied to.
 * `addedInGesture` lists ids added earlier in the same gesture: later ops on
 * those need no inverse, because the add's own inverse (`remove`) already
 * takes the whole object away. That is what keeps a stroke's undo a single op.
 */
export function inverseOf(op: AnnotationOp, scene: AnnotationScene, addedInGesture: ReadonlySet<string>): AnnotationOp[] {
  switch (op.t) {
    case 'add': {
      const existing = findObject(scene, op.obj.id);
      // Same-id re-add replaces — the inverse restores what was replaced
      return existing ? [readdInPlace(scene, existing)] : [{ t: 'remove', id: op.obj.id }];
    }
    case 'append': {
      if (addedInGesture.has(op.id)) return [];
      const existing = findObject(scene, op.id);
      // No truncate op on the wire: restore the pre-append object wholesale
      return existing && existing.kind === 'stroke' ? [readdInPlace(scene, existing)] : [];
    }
    case 'update': {
      if (addedInGesture.has(op.id)) return [];
      const existing = findObject(scene, op.id);
      if (!existing) return [];
      // Patch back the previous values of the keys this patch touches. A key
      // that was UNSET before (optional fields) cannot be patched back to
      // undefined, so fall back to restoring the object whole.
      const previous: AnnotationPatch = {};
      const allowed = patchableKeysFor(existing.kind);
      for (const key of allowed) {
        if (op.patch[key] === undefined) continue;
        const prev = (existing as unknown as Record<string, unknown>)[key];
        if (prev === undefined) return [readdInPlace(scene, existing)];
        (previous as Record<string, unknown>)[key] = prev;
      }
      return Object.keys(previous).length > 0 ? [{ t: 'update', id: op.id, patch: previous }] : [];
    }
    case 'translate': {
      if (addedInGesture.has(op.id)) return [];
      return findObject(scene, op.id) ? [{ t: 'translate', id: op.id, dx: -op.dx, dy: -op.dy }] : [];
    }
    case 'remove': {
      const existing = findObject(scene, op.id);
      return existing ? [readdInPlace(scene, existing)] : [];
    }
    case 'clear':
      return scene.objects.map((obj) => ({ t: 'add', obj }) as AnnotationOp);
    default:
      return [];
  }
}

/** The ids a batch of ops adds (for the same-gesture rule above). */
export function addedIds(ops: AnnotationOp[]): string[] {
  return ops.filter((op): op is { t: 'add'; obj: AnnotationObject } => op.t === 'add').map((op) => op.obj.id);
}

/**
 * Compact a gesture's forward ops for redo: every object ADDED in the gesture
 * collapses to one `add` of its final state (a stroke's 300 appends become
 * the finished stroke), other ops are kept as they were. An object added and
 * removed again in the same gesture (a degenerate click-shape discarded on
 * pointerup) contributes nothing.
 */
export function compactForward(forward: AnnotationOp[], added: ReadonlySet<string>, sceneAfter: AnnotationScene): AnnotationOp[] {
  const result: AnnotationOp[] = [];
  const emitted = new Set<string>();
  for (const op of forward) {
    const id = op.t === 'add' ? op.obj.id : 'id' in op ? op.id : null;
    if (id !== null && added.has(id)) {
      if (!emitted.has(id)) {
        emitted.add(id);
        const final = findObject(sceneAfter, id);
        if (final) result.push({ t: 'add', obj: final });
      }
      continue;
    }
    result.push(op);
  }
  return result;
}
