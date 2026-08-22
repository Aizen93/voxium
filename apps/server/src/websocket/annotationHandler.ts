import type { Server as SocketServer, Socket } from 'socket.io';
import {
  applyAnnotationOps,
  ANNOTATION_OPS_MAX,
  ANNOTATION_MAX_OPS_PER_BATCH,
  ANNOTATION_SCENE_MAX,
  ANNOTATION_MAX_OBJECTS,
  ANNOTATION_STROKE_MAX_POINTS,
  ANNOTATION_TEXT_MAX,
  ANNOTATION_IMAGE_DATAURL_MAX,
  ANNOTATION_IMAGE_MAX_DECODED_EDGE,
  ANNOTATION_MAX_SCENE_POINTS,
  ANNOTATION_RATE_PER_MIN,
  ANNOTATION_BYTES_PER_MIN,
} from '@voxium/shared';
import type { ServerToClientEvents, ClientToServerEvents, AnnotationOp, AnnotationObject, AnnotationScene } from '@voxium/shared';
import { socketRateLimit } from '../middleware/rateLimiter';
import { getRedis } from '../utils/redis';
import { annotationKey, casAnnotationState, observedSceneRev, type StoredAnnotationState } from '../utils/annotationState';
import { imageDimensions } from '../utils/imageHeader';

/** CAS retries before refusing the batch. Two is generous for a scene that is
 *  supposed to have exactly one writer — more would just delay the diagnosis. */
const ANNOTATION_CAS_ATTEMPTS = 3;

/**
 * Screen-share annotation ops (spec: session-only sharer-drawn overlays).
 *
 * These events deliberately BYPASS the owner-node voice relay
 * (ROUTED_VOICE_EVENTS): they touch no mediasoup state, so there is no reason
 * to burn the shared 600/min voice:relay budget on stroke batches. The handler
 * runs on whichever node the sharer's socket lives on, authorizes against the
 * Redis screen-share mirror (voice:screen:{channelId} — written by the owner
 * node), and broadcasts to voice:{channelId} through the Redis adapter.
 *
 * Races with sharer stop/handoff are accepted: a stray late batch is dropped
 * by the viewer-side sharer guard, and the scene key is deleted by every
 * screen-share cleanup path plus a TTL backstop.
 */

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const IMAGE_DATAURL_RE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;
/** Client ids are crypto.randomUUID(); allow modest slack but keep keys short. */
const ID_RE = /^[\w-]{1,40}$/;
/** Text overlays are single-line captions rendered verbatim on every
 *  viewer's canvas: no control chars, and no bidi-override / zero-width /
 *  invisible format characters either (a U+202E override can make a caption
 *  visually read as something it is not: classic text spoofing). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

/**
 * Byte length caps don't bound DECODED size — a few-KB "image bomb" can
 * declare a multi-gigabyte pixel grid that hangs every viewer's decoder.
 * Parse the dimensions from the container header (no decode) and fail closed
 * on anything oversized or unparseable.
 */
function imageWithinDecodedBounds(src: string): boolean {
  const base64 = src.slice(src.indexOf(',') + 1);
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return false;
  }
  const dims = imageDimensions(buf);
  return dims !== null
    && dims.width > 0 && dims.height > 0
    && dims.width <= ANNOTATION_IMAGE_MAX_DECODED_EDGE
    && dims.height <= ANNOTATION_IMAGE_MAX_DECODED_EDGE;
}

function isNormCoord(v: unknown): v is number {
  // Small out-of-frame slack so objects can be dragged slightly past an edge
  return typeof v === 'number' && Number.isFinite(v) && v >= -0.1 && v <= 1.1;
}

function isStrokeWidth(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 0.05;
}

function isValidPoints(points: unknown): points is number[] {
  return Array.isArray(points)
    && points.length > 0
    && points.length % 2 === 0
    && points.every(isNormCoord);
}

function isValidObject(obj: unknown): obj is AnnotationObject {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return false;
  switch (o.kind) {
    case 'stroke':
      return (o.tool === 'pen' || o.tool === 'highlighter')
        && typeof o.color === 'string' && COLOR_RE.test(o.color)
        && isStrokeWidth(o.width)
        && isValidPoints(o.points)
        && (o.points as number[]).length <= ANNOTATION_STROKE_MAX_POINTS * 2;
    case 'shape':
      return (o.shape === 'rect' || o.shape === 'ellipse')
        && typeof o.color === 'string' && COLOR_RE.test(o.color)
        && isStrokeWidth(o.width)
        && isNormCoord(o.x) && isNormCoord(o.y) && isNormCoord(o.w) && isNormCoord(o.h)
        && (o.fill === undefined || typeof o.fill === 'boolean');
    case 'text':
      return typeof o.text === 'string'
        && o.text.length > 0 && o.text.length <= ANNOTATION_TEXT_MAX
        && !CONTROL_CHARS_RE.test(o.text)
        && typeof o.color === 'string' && COLOR_RE.test(o.color)
        && typeof o.size === 'number' && Number.isFinite(o.size) && o.size > 0 && o.size <= 0.2
        && isNormCoord(o.x) && isNormCoord(o.y);
    case 'image':
      return typeof o.src === 'string'
        && o.src.length <= ANNOTATION_IMAGE_DATAURL_MAX
        && IMAGE_DATAURL_RE.test(o.src)
        && isNormCoord(o.x) && isNormCoord(o.y) && isNormCoord(o.w) && isNormCoord(o.h)
        && imageWithinDecodedBounds(o.src);
    default:
      return false;
  }
}

function isValidPatch(patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const p = patch as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.length > 7) return false;
  for (const key of keys) {
    switch (key) {
      case 'x': case 'y': case 'w': case 'h':
        if (!isNormCoord(p[key])) return false;
        break;
      case 'color':
        if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) return false;
        break;
      case 'text':
        if (typeof p.text !== 'string' || p.text.length === 0 || p.text.length > ANNOTATION_TEXT_MAX || CONTROL_CHARS_RE.test(p.text)) return false;
        break;
      case 'size':
        if (typeof p.size !== 'number' || !Number.isFinite(p.size) || p.size <= 0 || p.size > 0.2) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function isValidOp(op: unknown): op is AnnotationOp {
  if (!op || typeof op !== 'object') return false;
  const o = op as Record<string, unknown>;
  switch (o.t) {
    case 'add': return isValidObject(o.obj);
    case 'append':
      // Same per-op point bound as 'add' — without it a single append sized to
      // the batch cap forces a full parse/spread/serialize cycle before the
      // scene-limit check finally rejects it.
      return typeof o.id === 'string' && ID_RE.test(o.id)
        && isValidPoints(o.points)
        && (o.points as number[]).length <= ANNOTATION_STROKE_MAX_POINTS * 2;
    case 'update': return typeof o.id === 'string' && ID_RE.test(o.id) && isValidPatch(o.patch);
    case 'remove': return typeof o.id === 'string' && ID_RE.test(o.id);
    case 'clear': return true;
    default: return false;
  }
}

function sceneWithinLimits(scene: AnnotationScene): boolean {
  if (scene.objects.length > ANNOTATION_MAX_OBJECTS) return false;
  let totalPoints = 0;
  for (const obj of scene.objects) {
    if (obj.kind === 'stroke') {
      if (obj.points.length > ANNOTATION_STROKE_MAX_POINTS * 2) return false;
      totalPoints += obj.points.length;
    }
  }
  // Scene-wide point budget: 300 max-length strokes would force every viewer
  // to redraw ~600K line segments per batch — a sharer-driven client DoS.
  return totalPoints <= ANNOTATION_MAX_SCENE_POINTS * 2;
}

// Per-socket serialized-byte budget (rolling minute window, node-local like
// socketRateLimit). The request-count limiter alone permits 600 batches/min at
// up to ANNOTATION_OPS_MAX chars each — an authenticated sharer could sustain
// multi-MB/s Redis writes while staying inside every other cap.
const byteBudgets = new WeakMap<object, { used: number; resetAt: number }>();

function chargeByteBudget(socket: object, chars: number): boolean {
  const now = Date.now();
  let bucket = byteBudgets.get(socket);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { used: 0, resetAt: now + 60_000 };
    byteBudgets.set(socket, bucket);
  }
  bucket.used += chars;
  return bucket.used <= ANNOTATION_BYTES_PER_MIN;
}

export function handleAnnotationEvents(
  _io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
): void {
  const userId = socket.data.userId as string;

  socket.on('voice:annotation:ops', async (data, callback) => {
    const ack = (r: { ok: boolean; error?: string; restarted?: boolean }) => {
      if (typeof callback === 'function') callback(r);
    };
    if (!socketRateLimit(socket, 'voice:annotation:ops', ANNOTATION_RATE_PER_MIN)) {
      return ack({ ok: false, error: 'Rate limited' });
    }
    if (!data || typeof data !== 'object') return ack({ ok: false, error: 'Invalid payload' });
    const { channelId, ops } = data as { channelId: unknown; ops: unknown };
    if (typeof channelId !== 'string' || !channelId) return ack({ ok: false, error: 'Invalid payload' });
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > ANNOTATION_MAX_OPS_PER_BATCH) {
      return ack({ ok: false, error: 'Invalid payload' });
    }
    const opsChars = JSON.stringify(ops).length;
    if (opsChars > ANNOTATION_OPS_MAX) return ack({ ok: false, error: 'Payload too large' });
    // Charge BEFORE per-op validation: a flood of large malformed batches must
    // burn the sender's budget, not free CPU on image-header parsing.
    if (!chargeByteBudget(socket, opsChars)) return ack({ ok: false, error: 'Rate limited' });
    if (!ops.every(isValidOp)) return ack({ ok: false, error: 'Invalid payload' });

    try {
      const redis = getRedis();
      let scene!: AnnotationScene;
      let next!: StoredAnnotationState;
      let sceneRestarted = true;
      let written = false;

      // Read → apply → COMPARE-AND-SET, retried on contention. The read and
      // the write are not one operation, so anything that lands between them
      // (a pipelined batch from a modified client, a sharer handoff, the
      // fire-and-forget scene delete) would otherwise be clobbered by a write
      // computed from a scene that no longer exists. Contention is normal, not
      // an error: retrying re-applies these ops on top of whatever landed, and
      // the sharer never hears about it.
      for (let attempt = 0; attempt < ANNOTATION_CAS_ATTEMPTS && !written; attempt++) {
        // One round trip: sharer authorization + current scene
        const [sharer, storedRaw] = await redis.mGet([`voice:screen:${channelId}`, annotationKey(channelId)]);
        if (sharer !== userId) return ack({ ok: false, error: 'Not the active sharer' });

        // The rev to EXPECT is whatever is in Redis — kept separate from the
        // scene we build on, because the two diverge on every path that throws
        // the stored scene away. Expecting the discarded scene's rev of 0
        // against a stored rev of 12 loses all ANNOTATION_CAS_ATTEMPTS races,
        // and since nothing on that path rewrites the key, every later batch
        // loses identically: annotations wedge for the rest of the share while
        // the sharer's own canvas has already local-echoed them.
        const observedRev = observedSceneRev(storedRaw);
        // Continue the counter from what is stored rather than restarting at 1.
        // A backwards rev under viewers who hydrated the discarded scene would
        // make them drop these ops as stale; the restart snapshot below already
        // re-baselines them, and monotonic is one less thing to depend on.
        let baseScene: AnnotationScene = { objects: [] };
        sceneRestarted = true;
        if (storedRaw) {
          try {
            const parsed = JSON.parse(storedRaw) as StoredAnnotationState;
            if (typeof parsed?.rev === 'number' && Array.isArray(parsed?.scene?.objects)) {
              // A scene left by the PREVIOUS sharer is not ours to extend: the
              // release-side delete is fire-and-forget, so a fast first batch
              // can still see it. Inheriting it would ship someone else's
              // objects to viewers under this sharer's name.
              if (parsed.sharerUserId === userId) {
                baseScene = parsed.scene;
                sceneRestarted = false;
              } else {
                console.warn(`[Annotations] Discarding channel ${channelId}'s scene from a previous sharer`);
              }
            }
          } catch {
            // Corrupt state — fall through to a fresh scene rather than wedging the share
            console.warn(`[Annotations] Corrupt scene for channel ${channelId}, resetting`);
          }
        }

        scene = applyAnnotationOps(baseScene, ops as AnnotationOp[]);
        next = { rev: observedRev + 1, sharerUserId: userId, scene };
        const serialized = JSON.stringify(next);
        if (!sceneWithinLimits(scene) || serialized.length > ANNOTATION_SCENE_MAX) {
          return ack({ ok: false, error: 'Scene limit reached' });
        }

        written = await casAnnotationState(channelId, userId, observedRev, serialized);
      }

      if (!written) {
        // Sustained contention on a single-writer scene means something is
        // wrong (a pipelining client, or a sharer slot flapping). Refusing is
        // right — a blind write here is the clobber the CAS exists to prevent.
        console.warn(`[Annotations] Scene write for channel ${channelId} lost ${ANNOTATION_CAS_ATTEMPTS} races — refusing`);
        return ack({ ok: false, error: 'Scene is being modified concurrently' });
      }

      // Sender excluded — the sharer local-echoes its own ops.
      socket.to(`voice:${channelId}`).emit('voice:annotation:ops', {
        channelId,
        userId,
        rev: next.rev,
        ops: ops as AnnotationOp[],
      });
      if (sceneRestarted) {
        // Tell the SHARER too (via the ack — it is excluded from the room
        // broadcasts): its local scene still holds pre-restart objects that no
        // longer exist server-side, and it must re-send them or every
        // subsequent update/remove on those ids silently no-ops for viewers.
        // The rev counter just restarted at 1 (fresh share, TTL expiry, Redis
        // loss, or corrupt-state reset). Viewers that hydrated a HIGHER rev in
        // this same session would silently drop every rev-1..N op as stale —
        // a full snapshot re-baselines them (hydrate overwrites rev wholesale).
        // On a genuinely fresh share this is one tiny redundant emit.
        // `restarted` is what lets a viewer tell this snapshot from the
        // join-race kind: revs alone cannot. A viewer at rev 60 that receives
        // a rev-1 snapshot would otherwise replay its buffered rev-29..60
        // batches on top of it and pin itself at 60, dropping the sharer's
        // resync (rev 2..) as stale for the rest of the share.
        socket.to(`voice:${channelId}`).emit('voice:annotation:state', {
          channelId,
          sharingUserId: userId,
          rev: next.rev,
          scene,
          restarted: true,
        });
      }
      ack(sceneRestarted ? { ok: true, restarted: true } : { ok: true });
    } catch (err) {
      console.error('[Annotations] ops handling failed:', err instanceof Error ? err.message : err);
      ack({ ok: false, error: 'Internal error' });
    }
  });
}
