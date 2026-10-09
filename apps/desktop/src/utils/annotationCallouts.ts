import { ANNOTATION_CALLOUT_MAX, type AnnotationCallout, type AnnotationObject, type AnnotationOp } from '@voxium/shared';

/**
 * Numbered callouts: ①②③ placed by clicking. Numbers are STABLE — deleting
 * ② does not turn ③ into ② (a walkthrough references its numbers) — and a
 * new badge takes max + 1. "Renumber" re-sequences on demand, in reading
 * order, as one undo step.
 */

export function callouts(objects: readonly AnnotationObject[]): AnnotationCallout[] {
  return objects.filter((o): o is AnnotationCallout => o.kind === 'callout');
}

/** The number the next badge gets, or null once the cap is reached. */
export function nextCalloutNumber(objects: readonly AnnotationObject[]): number | null {
  let max = 0;
  for (const c of callouts(objects)) if (c.n > max) max = c.n;
  return max >= ANNOTATION_CALLOUT_MAX ? null : max + 1;
}

/** Row height, in frame units, within which badges count as "the same line". */
const ROW_BAND = 0.08;

/**
 * Reading order: rows top-to-bottom (badges within ROW_BAND of each other
 * share a row), left-to-right within a row. Banding is what makes two badges
 * placed "on the same line" by hand, a few pixels apart vertically, number
 * left-to-right instead of by their exact y.
 */
export function readingOrder(items: readonly AnnotationCallout[]): AnnotationCallout[] {
  const byY = [...items].sort((a, b) => a.y - b.y);
  const rows: AnnotationCallout[][] = [];
  for (const c of byY) {
    const row = rows[rows.length - 1];
    if (row && c.y - row[0].y <= ROW_BAND) row.push(c);
    else rows.push([c]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** The update ops that renumber every badge 1..N in reading order (only those that change). */
export function renumberOps(objects: readonly AnnotationObject[]): AnnotationOp[] {
  const ordered = readingOrder(callouts(objects));
  const ops: AnnotationOp[] = [];
  ordered.forEach((c, i) => {
    if (c.n !== i + 1) ops.push({ t: 'update', id: c.id, patch: { n: i + 1 } });
  });
  return ops;
}
