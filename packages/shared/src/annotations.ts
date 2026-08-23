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
//
// Wire v2 (arrow, callout, spotlight, stroke.fade, translate, width/n patches)
// is additive: the reducer keeps objects it does not understand and renderers
// skip them, so an old client in a call with a new sharer keeps working — it
// just does not see the new kinds. The SERVER rejects what it does not know,
// which is why it deploys first and advertises `annotationsVersion` on the
// screen-share claim ack.

export type AnnotationTool = 'pen' | 'highlighter';

/** Fields every wire object carries besides its kind-specific geometry. */
interface AnnotationBase {
  id: string;
  /**
   * Author userId, STAMPED BY THE SERVER on `add` — never trusted from the
   * client. Today every object is the sharer's; carrying it from the start
   * means scenes already hold ownership when viewer annotations arrive.
   */
  by?: string;
}

export interface AnnotationStroke extends AnnotationBase {
  kind: 'stroke';
  tool: AnnotationTool;
  /** '#rrggbb' */
  color: string;
  /** Line width as a fraction of the frame height, (0, 0.05] */
  width: number;
  /** Flattened [x0, y0, x1, y1, ...] normalized points */
  points: number[];
  /**
   * Vanishing ink: the sharer removes the stroke ~3 s after finishing it and
   * every client fades it on its OWN clock from the last append it saw. No
   * timestamp travels — a lost remove costs nothing, the stroke still hides.
   */
  fade?: true;
}

export interface AnnotationShape extends AnnotationBase {
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

export interface AnnotationText extends AnnotationBase {
  kind: 'text';
  /** Plain text, <= ANNOTATION_TEXT_MAX chars. Rendered via canvas fillText. */
  text: string;
  color: string;
  /** Font size as a fraction of the frame height, (0, 0.2] */
  size: number;
  x: number;
  y: number;
}

export interface AnnotationImage extends AnnotationBase {
  kind: 'image';
  /** data:image/(webp|png|jpeg);base64,... — length-capped, never a URL */
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A directed segment with an arrowhead at p2 (or both ends). */
export interface AnnotationArrow extends AnnotationBase {
  kind: 'arrow';
  color: string;
  /** Shaft width as a fraction of the frame height, (0, 0.05] */
  width: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  heads?: 'end' | 'both';
}

/** A numbered badge — ①②③ — for walkthroughs. */
export interface AnnotationCallout extends AnnotationBase {
  kind: 'callout';
  color: string;
  /** Badge diameter as a fraction of the frame height, (0, 0.2] */
  size: number;
  x: number;
  y: number;
  /** Integer in [1, ANNOTATION_CALLOUT_MAX] */
  n: number;
}

/** Dims everything OUTSIDE the region — the inverse of a mask, and unlike a
 *  mask it removes no information, so it is an ordinary wire object. */
export interface AnnotationSpotlight extends AnnotationBase {
  kind: 'spotlight';
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'rect' | 'ellipse';
}

export type AnnotationObject =
  | AnnotationStroke
  | AnnotationShape
  | AnnotationText
  | AnnotationImage
  | AnnotationArrow
  | AnnotationCallout
  | AnnotationSpotlight;

export type AnnotationKind = AnnotationObject['kind'];

/** Highest callout number a scene may carry. */
export const ANNOTATION_CALLOUT_MAX = 99;

export interface AnnotationScene {
  objects: AnnotationObject[];
}

/** Fields the sharer may patch on an existing object (kind-filtered by the reducer). */
export interface AnnotationPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  color?: string;
  width?: number;
  text?: string;
  size?: number;
  n?: number;
}

export type AnnotationOp =
  | { t: 'add'; obj: AnnotationObject }
  | { t: 'append'; id: string; points: number[] }
  | { t: 'update'; id: string; patch: AnnotationPatch }
  /** Move an object by a normalized delta — the only way to move a stroke
   *  without re-sending its points. */
  | { t: 'translate'; id: string; dx: number; dy: number }
  | { t: 'remove'; id: string }
  | { t: 'clear' };

// ─── Ephemeral events (voice:annotation:live) ────────────────────────────────
// Nothing here persists or hydrates. Kinds are authorized individually on the
// server (ANNOTATION_LIVE_AUTH): the pointer belongs to the sharer, reactions
// and snapshot notices to anyone in the voice channel.

export type AnnotationLiveEvent =
  /** Laser pointer position, normalized to the source frame. */
  | { k: 'pointer'; x: number; y: number }
  /** Pointer left the stage / tool switched — viewers fade it out at once. */
  | { k: 'pointer-off' }
  /** Index into ANNOTATION_REACTIONS. */
  | { k: 'reaction'; e: number }
  /** "{name} took a snapshot" — a courtesy to the sharer, not a control. */
  | { k: 'snapshot' };

export type AnnotationLiveKind = AnnotationLiveEvent['k'];

/** Patch keys the reducer will merge, per object kind. */
const PATCHABLE_KEYS: Record<AnnotationKind, readonly (keyof AnnotationPatch)[]> = {
  stroke: ['color', 'width'],
  shape: ['x', 'y', 'w', 'h', 'color', 'width'],
  text: ['x', 'y', 'color', 'text', 'size'],
  image: ['x', 'y', 'w', 'h'],
  arrow: ['x1', 'y1', 'x2', 'y2', 'color', 'width'],
  callout: ['x', 'y', 'color', 'size', 'n'],
  spotlight: ['x', 'y', 'w', 'h'],
};

/** The patch keys a given kind accepts (validators and editors share this). */
export function patchableKeysFor(kind: AnnotationKind): readonly (keyof AnnotationPatch)[] {
  return PATCHABLE_KEYS[kind] ?? [];
}

/** Pure: the object moved by (dx, dy). Unknown kinds are returned untouched. */
export function translateAnnotationObject(obj: AnnotationObject, dx: number, dy: number): AnnotationObject {
  switch (obj.kind) {
    case 'stroke': {
      const points = new Array<number>(obj.points.length);
      for (let i = 0; i < obj.points.length; i += 2) {
        points[i] = obj.points[i] + dx;
        points[i + 1] = obj.points[i + 1] + dy;
      }
      return { ...obj, points };
    }
    case 'arrow':
      return { ...obj, x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy };
    case 'shape':
    case 'text':
    case 'image':
    case 'callout':
    case 'spotlight':
      return { ...obj, x: obj.x + dx, y: obj.y + dy };
    default:
      return obj;
  }
}

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
          const allowed = patchableKeysFor(o.kind);
          const patch: Record<string, unknown> = {};
          for (const key of allowed) {
            if (op.patch[key] !== undefined) patch[key] = op.patch[key];
          }
          return { ...o, ...patch } as AnnotationObject;
        });
        break;
      }
      case 'translate': {
        objects = objects.map((o) => (o.id === op.id ? translateAnnotationObject(o, op.dx, op.dy) : o));
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
