// ─── Screen-share annotations (docs: session-only sharer-drawn overlays) ─────
//
// The active screen sharer draws annotations/highlights/text/image overlays
// that every voice participant renders client-side over the shared video.
// All coordinates are normalized [0..1] relative to the SOURCE video frame so
// they re-project onto any viewer's letterboxed content rect.
//
// Privacy masks are deliberately NOT part of these wire types: masks are
// composited into the outgoing video at the sharer's machine (covered pixels
// never leave it), so the network never learns their geometry.

export type AnnotationTool = 'pen' | 'highlighter';

export interface AnnotationStroke {
  id: string;
  kind: 'stroke';
  tool: AnnotationTool;
  /** '#rrggbb' */
  color: string;
  /** Line width as a fraction of the frame height, (0, 0.05] */
  width: number;
  /** Flattened [x0, y0, x1, y1, ...] normalized points */
  points: number[];
}

export interface AnnotationShape {
  id: string;
  kind: 'shape';
  shape: 'rect' | 'ellipse';
  color: string;
  /** Outline width as a fraction of the frame height, (0, 0.05] */
  width: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Filled translucent = "highlight this area" */
  fill?: boolean;
}

export interface AnnotationText {
  id: string;
  kind: 'text';
  /** Plain text, <= ANNOTATION_TEXT_MAX chars. Rendered via canvas fillText. */
  text: string;
  color: string;
  /** Font size as a fraction of the frame height, (0, 0.2] */
  size: number;
  x: number;
  y: number;
}

export interface AnnotationImage {
  id: string;
  kind: 'image';
  /** data:image/(webp|png|jpeg);base64,... — length-capped, never a URL */
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationObject = AnnotationStroke | AnnotationShape | AnnotationText | AnnotationImage;

export interface AnnotationScene {
  objects: AnnotationObject[];
}

/** Fields the sharer may patch on an existing object (kind-filtered by the reducer). */
export interface AnnotationPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
  text?: string;
  size?: number;
}

export type AnnotationOp =
  | { t: 'add'; obj: AnnotationObject }
  | { t: 'append'; id: string; points: number[] }
  | { t: 'update'; id: string; patch: AnnotationPatch }
  | { t: 'remove'; id: string }
  | { t: 'clear' };

/** Patch keys the reducer will merge, per object kind. */
const PATCHABLE_KEYS: Record<AnnotationObject['kind'], readonly (keyof AnnotationPatch)[]> = {
  stroke: ['color'],
  shape: ['x', 'y', 'w', 'h', 'color'],
  text: ['x', 'y', 'color', 'text', 'size'],
  image: ['x', 'y', 'w', 'h'],
};

/**
 * Pure reducer shared by the server (authoritative scene read-modify-write),
 * viewers, and tests. Returns a NEW scene; never mutates the input. Enforces
 * structural semantics only — size/count caps and value validation are the
 * caller's job (the server validates before applying).
 */
export function applyAnnotationOps(scene: AnnotationScene, ops: AnnotationOp[]): AnnotationScene {
  let objects = scene.objects;
  for (const op of ops) {
    switch (op.t) {
      case 'add': {
        // Same-id re-add replaces (idempotent against client retries)
        const withoutDup = objects.some((o) => o.id === op.obj.id)
          ? objects.filter((o) => o.id !== op.obj.id)
          : objects;
        objects = [...withoutDup, op.obj];
        break;
      }
      case 'append': {
        objects = objects.map((o) =>
          o.id === op.id && o.kind === 'stroke'
            ? { ...o, points: [...o.points, ...op.points] }
            : o,
        );
        break;
      }
      case 'update': {
        objects = objects.map((o) => {
          if (o.id !== op.id) return o;
          const allowed = PATCHABLE_KEYS[o.kind];
          const patch: Record<string, unknown> = {};
          for (const key of allowed) {
            if (op.patch[key] !== undefined) patch[key] = op.patch[key];
          }
          return { ...o, ...patch } as AnnotationObject;
        });
        break;
      }
      case 'remove': {
        objects = objects.filter((o) => o.id !== op.id);
        break;
      }
      case 'clear': {
        objects = [];
        break;
      }
    }
  }
  return { objects };
}
