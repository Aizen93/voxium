import type { AnnotationScene } from '@voxium/shared';
import { getRedis } from './redis';

/**
 * Authoritative screen-share annotation scene, Redis-only. There is no owner
 * node for annotations (they touch no mediasoup state and are handled on
 * whichever node the sharer's socket lives on), so a node-local cache would
 * leak on nodes that never run voice cleanup paths. Only the single sharer
 * socket writes, so the read-modify-write in annotationHandler is effectively
 * single-writer.
 *
 * Leaf module (voiceMirror-style): imported by annotationHandler, voiceHandler
 * (hydration + cleanup), and voiceMirror without cycles.
 */

export interface StoredAnnotationState {
  rev: number;
  sharerUserId: string;
  scene: AnnotationScene;
}

/**
 * Belt-and-braces TTL: every cleanup path deletes the key explicitly; the
 * expiry only bounds leakage if a future path forgets to.
 */
export const ANNOTATION_STATE_TTL_SECONDS = 14_400;

export function annotationKey(channelId: string): string {
  return `voice:annotations:${channelId}`;
}

export async function getAnnotationState(channelId: string): Promise<StoredAnnotationState | null> {
  const raw = await getRedis().get(annotationKey(channelId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredAnnotationState;
    if (typeof parsed?.rev !== 'number' || typeof parsed?.sharerUserId !== 'string' || !Array.isArray(parsed?.scene?.objects)) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[Annotations] Corrupt scene state dropped:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Fire-and-forget delete (mirrorScreenShare style). */
export function deleteAnnotationState(channelId: string): void {
  getRedis().del(annotationKey(channelId)).catch((err) => console.warn('[Annotations] State delete failed:', err));
}

/**
 * Seed a FRESH share's empty scene (rev 0) at claim time — a plain SET that
 * replaces whatever the previous share left (fire-and-forget, like the
 * delete it stands in for). Without the seed, the share's first ops batch
 * finds no stored scene and takes the RESTART path: harmless when the local
 * scene held one stroke, but a pre-flight full of image drafts would be
 * re-sent WHOLESALE by the restart resync — double the bytes against the
 * 2MB/min budget, deterministically dropping batches. If this write is lost,
 * the fallback IS the restart path: correct, just redundant.
 */
export function initAnnotationState(channelId: string, sharerUserId: string): void {
  const seed: StoredAnnotationState = { rev: 0, sharerUserId, scene: { objects: [] } };
  getRedis()
    .set(annotationKey(channelId), JSON.stringify(seed), { EX: ANNOTATION_STATE_TTL_SECONDS })
    .catch((err) => console.warn('[Annotations] State init failed:', err));
}

/**
 * The rev `casAnnotationState` will read out of the stored value, derived the
 * SAME way its script derives it — a prefix match on the raw string, never
 * `JSON.parse`.
 *
 * Callers need this because the rev they must EXPECT is whatever is in Redis,
 * which is not always the rev of the scene they decided to build on. The two
 * diverge on exactly the paths that deliberately throw the stored scene away
 * (it belongs to a previous sharer, or it is structurally invalid): there the
 * base scene resets to empty, and expecting its rev of 0 against a stored rev
 * of 12 loses every CAS attempt. Reading it through the same prefix match the
 * script uses means the expectation and the check cannot disagree — including
 * on a corrupt value, where both read 0.
 */
export function observedSceneRev(raw: string | null | undefined): number {
  if (!raw) return 0;
  const m = /^\{"rev":(\d+)/.exec(raw);
  return m ? Number(m[1]) : 0;
}

/**
 * Compare-and-set the scene: write `serialized` only if the stored state is
 * still at `expectedRev` AND `sharerUserId` still holds the share.
 *
 * The handler's read-modify-write is only single-writer because the CLIENT
 * promises to serialize its batches on their acks. That is a fine optimisation
 * but a poor foundation: a modified client can pipeline freely, and a server
 * stall between the read and the write is enough on its own. Resting scene
 * integrity on a promise made by the party whose scene it is, is exactly the
 * kind of thing that reads fine until it doesn't.
 *
 * Checking the sharer INSIDE the script also closes the handoff window: the
 * slot can change between the handler's authorization read and its write, and
 * a departing sharer must not get one last batch in under the new one's name.
 *
 * Returns true on success, false when either check failed (the caller re-reads
 * and retries — contention is not an error the user should hear about).
 */
export async function casAnnotationState(
  channelId: string,
  sharerUserId: string,
  expectedRev: number,
  serialized: string,
): Promise<boolean> {
  // `rev` is ALWAYS the first key of the serialized object (StoredAnnotationState
  // is built as a literal in that order, and this module is its only writer), so
  // a prefix match is exact and costs nothing — cjson.decode of a scene up to
  // ANNOTATION_SCENE_MAX, on every batch, would not be. An unmatched or absent
  // value reads as rev 0, matching the handler's own "fresh scene" fallback.
  const result = await getRedis().eval(
    `if redis.call('get', KEYS[2]) ~= ARGV[3] then return 0 end
     local cur = redis.call('get', KEYS[1])
     local currev = 0
     if cur then
       local m = string.match(cur, '^{"rev":(%d+)')
       if m then currev = tonumber(m) end
     end
     if currev ~= tonumber(ARGV[1]) then return 0 end
     redis.call('set', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
     return 1`,
    {
      keys: [annotationKey(channelId), `voice:screen:${channelId}`],
      arguments: [String(expectedRev), serialized, sharerUserId, String(ANNOTATION_STATE_TTL_SECONDS)],
    },
  ) as number;
  return result === 1;
}
