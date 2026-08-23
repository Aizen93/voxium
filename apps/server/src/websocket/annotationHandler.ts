import type { Server as SocketServer, Socket } from 'socket.io';
import {
  applyAnnotationOps,
  ANNOTATION_OPS_MAX,
  ANNOTATION_MAX_OPS_PER_BATCH,
  ANNOTATION_SCENE_MAX,
  ANNOTATION_MAX_OBJECTS,
  ANNOTATION_STROKE_MAX_POINTS,
  ANNOTATION_TEXT_MAX,
  ANNOTATION_TEXT_FORBIDDEN_RE,
  ANNOTATION_IMAGE_DATAURL_MAX,
  ANNOTATION_IMAGE_MAX_DECODED_EDGE,
  ANNOTATION_MAX_SCENE_POINTS,
  ANNOTATION_RATE_PER_MIN,
  ANNOTATION_BYTES_PER_MIN,
  ANNOTATION_CALLOUT_MAX,
  ANNOTATION_LIVE_MAX,
  ANNOTATION_LIVE_POINTER_RATE_PER_MIN,
  ANNOTATION_LIVE_REACTION_RATE_PER_MIN,
  ANNOTATION_LIVE_SNAPSHOT_RATE_PER_MIN,
  ANNOTATION_REACTIONS,
} from '@voxium/shared';
import type {
  ServerToClientEvents, ClientToServerEvents, AnnotationOp, AnnotationObject, AnnotationScene,
  AnnotationLiveEvent, AnnotationLiveKind,
} from '@voxium/shared';
import { socketRateLimit } from '../middleware/rateLimiter';
import { isFeatureEnabled } from '../utils/featureFlags';
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
 *  visually read as something it is not: classic text spoofing). The class is
 *  shared with the editor, which strips the same set before committing. */
const CONTROL_CHARS_RE = ANNOTATION_TEXT_FORBIDDEN_RE;

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

function isColor(v: unknown): v is string {
  return typeof v === 'string' && COLOR_RE.test(v);
}

function isSize(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 0.2;
}

function isCalloutNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ANNOTATION_CALLOUT_MAX;
}

/**
 * Wire v2 (arrow, callout, spotlight, stroke.fade, translate, width/n patches)
 * is validated only while the `annotations_v2` flag is on: with it off this
 * node rejects v2 constructs exactly like unknown ones AND stops advertising
 * version 2 on the share claim, so new clients hide the tools rather than
 * drawing things the server will refuse.
 */
export function annotationsWireVersion(): 1 | 2 {
  return isFeatureEnabled('annotations_v2') ? 2 : 1;
}

function isValidObject(obj: unknown, v2: boolean): obj is AnnotationObject {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return false;
  switch (o.kind) {
    case 'stroke':
      return (o.tool === 'pen' || o.tool === 'highlighter')
        && isColor(o.color)
        && isStrokeWidth(o.width)
        && isValidPoints(o.points)
        && (o.points as number[]).length <= ANNOTATION_STROKE_MAX_POINTS * 2
        && (o.fade === undefined || (v2 && o.fade === true));
    case 'shape':
      return (o.shape === 'rect' || o.shape === 'ellipse')
        && isColor(o.color)
        && isStrokeWidth(o.width)
        && isNormCoord(o.x) && isNormCoord(o.y) && isNormCoord(o.w) && isNormCoord(o.h)
        && (o.fill === undefined || typeof o.fill === 'boolean');
    case 'text':
      return typeof o.text === 'string'
        && o.text.length > 0 && o.text.length <= ANNOTATION_TEXT_MAX
        && !CONTROL_CHARS_RE.test(o.text)
        && isColor(o.color)
        && isSize(o.size)
        && isNormCoord(o.x) && isNormCoord(o.y);
    case 'image':
      return typeof o.src === 'string'
        && o.src.length <= ANNOTATION_IMAGE_DATAURL_MAX
        && IMAGE_DATAURL_RE.test(o.src)
        && isNormCoord(o.x) && isNormCoord(o.y) && isNormCoord(o.w) && isNormCoord(o.h)
        && imageWithinDecodedBounds(o.src);
    case 'arrow':
      return v2
        && isColor(o.color)
        && isStrokeWidth(o.width)
        && isNormCoord(o.x1) && isNormCoord(o.y1) && isNormCoord(o.x2) && isNormCoord(o.y2)
        && (o.heads === undefined || o.heads === 'end' || o.heads === 'both');
    case 'callout':
      return v2
        && isColor(o.color)
        && isSize(o.size)
        && isNormCoord(o.x) && isNormCoord(o.y)
        && isCalloutNumber(o.n);
    case 'spotlight':
      return v2
        && isNormCoord(o.x) && isNormCoord(o.y) && isNormCoord(o.w) && isNormCoord(o.h)
        && (o.shape === undefined || o.shape === 'rect' || o.shape === 'ellipse');
    default:
      return false;
  }
}

function isValidPatch(patch: unknown, v2: boolean): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const p = patch as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.length > 8) return false;
  for (const key of keys) {
    switch (key) {
      case 'x': case 'y': case 'w': case 'h':
        if (!isNormCoord(p[key])) return false;
        break;
      case 'x1': case 'y1': case 'x2': case 'y2':
        if (!v2 || !isNormCoord(p[key])) return false;
        break;
      case 'color':
        if (!isColor(p.color)) return false;
        break;
      case 'width':
        if (!v2 || !isStrokeWidth(p.width)) return false;
        break;
      case 'n':
        if (!v2 || !isCalloutNumber(p.n)) return false;
        break;
      case 'text':
        if (typeof p.text !== 'string' || p.text.length === 0 || p.text.length > ANNOTATION_TEXT_MAX || CONTROL_CHARS_RE.test(p.text)) return false;
        break;
      case 'size':
        if (!isSize(p.size)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function isTranslateDelta(v: unknown): v is number {
  // A delta can at most carry an object from one edge of the slack to the other
  return typeof v === 'number' && Number.isFinite(v) && v >= -1.2 && v <= 1.2;
}

function isValidOp(op: unknown, v2: boolean): op is AnnotationOp {
  if (!op || typeof op !== 'object') return false;
  const o = op as Record<string, unknown>;
  switch (o.t) {
    case 'add':
      return isValidObject(o.obj, v2)
        && (o.at === undefined || (v2 && typeof o.at === 'number' && Number.isInteger(o.at) && o.at >= 0 && o.at <= ANNOTATION_MAX_OBJECTS));
    case 'append':
      // Same per-op point bound as 'add' — without it a single append sized to
      // the batch cap forces a full parse/spread/serialize cycle before the
      // scene-limit check finally rejects it.
      return typeof o.id === 'string' && ID_RE.test(o.id)
        && isValidPoints(o.points)
        && (o.points as number[]).length <= ANNOTATION_STROKE_MAX_POINTS * 2;
    case 'update': return typeof o.id === 'string' && ID_RE.test(o.id) && isValidPatch(o.patch, v2);
    case 'translate':
      return v2 && typeof o.id === 'string' && ID_RE.test(o.id) && isTranslateDelta(o.dx) && isTranslateDelta(o.dy);
    case 'remove': return typeof o.id === 'string' && ID_RE.test(o.id);
    case 'clear': return true;
    default: return false;
  }
}

/**
 * A translate is validated on its DELTA, so the resulting geometry has to be
 * re-checked against the wire bounds after the reducer ran — otherwise a stroke
 * could be walked off the frame one legal step at a time. The client clamps
 * its deltas first; the server rejects rather than clamps.
 */
function geometryWithinBounds(obj: AnnotationObject): boolean {
  switch (obj.kind) {
    case 'stroke': return obj.points.every(isNormCoord);
    case 'arrow': return isNormCoord(obj.x1) && isNormCoord(obj.y1) && isNormCoord(obj.x2) && isNormCoord(obj.y2);
    default: return isNormCoord(obj.x) && isNormCoord(obj.y);
  }
}

function translatedObjectsWithinBounds(scene: AnnotationScene, ops: AnnotationOp[]): boolean {
  const moved = new Set<string>();
  for (const op of ops) if (op.t === 'translate') moved.add(op.id);
  if (moved.size === 0) return true;
  return scene.objects.every((o) => !moved.has(o.id) || geometryWithinBounds(o));
}

/**
 * `by` is the server's word, not the client's: strip whatever the sender put
 * there and stamp the authenticated userId on every added object. Viewers'
 * reducers keep it (spread-through), so scenes carry ownership from day one.
 */
function stampOwner(ops: AnnotationOp[], userId: string): AnnotationOp[] {
  return ops.map((op) => (op.t === 'add' ? { ...op, obj: { ...op.obj, by: userId } } : op));
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

// ─── voice:annotation:live — the ephemeral sibling of :ops ───────────────────
//
// Fire-and-forget: no Redis write, no rev, no ack, no hydration. A late joiner
// sees the next event; a lost one costs nothing (the laser fades on the
// viewer's own clock). Authorization is decided PER KIND in one table so that
// opening a kind to viewers later (viewer annotations) is a row change:
//   sharer — only the active sharer (Redis voice:screen:{channelId}, cached
//            per socket for a couple of seconds: 20 GETs/s per sharer is
//            harmless but pointless, and a stale "still sharer" for ≤2 s after
//            a handoff is too — the previous sharer's last dot fades anyway)
//   member — anyone whose socket is in the voice:{channelId} room (relay
//            shims join it adapter-wide, so this holds on the home node too)
// Each kind has its OWN socketRateLimit bucket: a reaction burst must not be
// able to starve the sharer's pointer, and none of them touches the :ops one.

const LIVE_AUTH: Record<AnnotationLiveKind, { who: 'sharer' | 'member'; bucket: string; perMin: number }> = {
  'pointer':     { who: 'sharer', bucket: 'voice:annotation:live:pointer',  perMin: ANNOTATION_LIVE_POINTER_RATE_PER_MIN },
  'pointer-off': { who: 'sharer', bucket: 'voice:annotation:live:pointer',  perMin: ANNOTATION_LIVE_POINTER_RATE_PER_MIN },
  'reaction':    { who: 'member', bucket: 'voice:annotation:live:reaction', perMin: ANNOTATION_LIVE_REACTION_RATE_PER_MIN },
  'snapshot':    { who: 'member', bucket: 'voice:annotation:live:snapshot', perMin: ANNOTATION_LIVE_SNAPSHOT_RATE_PER_MIN },
};

/** How long a positive sharer check is trusted before Redis is asked again. */
const SHARER_CACHE_MS = 2_000;
const sharerCache = new WeakMap<object, { channelId: string; until: number }>();

function isValidLiveEvent(ev: unknown): ev is AnnotationLiveEvent {
  if (!ev || typeof ev !== 'object') return false;
  const e = ev as Record<string, unknown>;
  const keys = Object.keys(e);
  switch (e.k) {
    case 'pointer':
      return keys.length === 3 && isNormCoord(e.x) && isNormCoord(e.y);
    case 'pointer-off':
      return keys.length === 1;
    case 'reaction':
      return keys.length === 2 && typeof e.e === 'number' && Number.isInteger(e.e) && e.e >= 0 && e.e < ANNOTATION_REACTIONS.length;
    case 'snapshot':
      return keys.length === 1;
    default:
      return false;
  }
}

async function isActiveSharer(socket: object, channelId: string, userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = sharerCache.get(socket);
  if (cached && cached.channelId === channelId && now < cached.until) return true;
  const sharer = await getRedis().get(`voice:screen:${channelId}`);
  if (sharer !== userId) return false; // a miss is never cached — fail closed
  sharerCache.set(socket, { channelId, until: now + SHARER_CACHE_MS });
  return true;
}

export function handleAnnotationEvents(
  _io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
): void {
  const userId = socket.data.userId as string;

  socket.on('voice:annotation:live', async (data) => {
    // No ack by design: nothing here is worth a round trip, and a rejected
    // event is simply not seen. Shape first, cheapest checks first.
    if (!data || typeof data !== 'object') return;
    const { channelId, ev } = data as { channelId: unknown; ev: unknown };
    if (typeof channelId !== 'string' || !channelId || channelId.length > 64) return;
    if (!isValidLiveEvent(ev)) return;
    if (JSON.stringify(ev).length > ANNOTATION_LIVE_MAX) return;
    const rule = LIVE_AUTH[ev.k];
    if (!socketRateLimit(socket, rule.bucket, rule.perMin)) return;

    try {
      if (rule.who === 'sharer') {
        if (!(await isActiveSharer(socket, channelId, userId))) return;
      } else if (!socket.rooms.has(`voice:${channelId}`)) {
        return;
      }
      // To the whole voice room, sender excluded (it local-echoes, exactly
      // like :ops) — a snapshot notice is seen by everyone in the share, not
      // only the sharer.
      socket.to(`voice:${channelId}`).emit('voice:annotation:live', { channelId, userId, ev });
    } catch (err) {
      console.warn('[Annotations] live event dropped:', err instanceof Error ? err.message : err);
    }
  });

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
    const v2 = annotationsWireVersion() === 2;
    if (!ops.every((op) => isValidOp(op, v2))) return ack({ ok: false, error: 'Invalid payload' });
    const stampedOps = stampOwner(ops as AnnotationOp[], userId);

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

        scene = applyAnnotationOps(baseScene, stampedOps);
        if (!translatedObjectsWithinBounds(scene, stampedOps)) {
          return ack({ ok: false, error: 'Invalid payload' });
        }
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

      // Sender excluded — the sharer local-echoes its own ops. Viewers get the
      // STAMPED ops, so their scenes carry the same `by` the stored one does.
      socket.to(`voice:${channelId}`).emit('voice:annotation:ops', {
        channelId,
        userId,
        rev: next.rev,
        ops: stampedOps,
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
