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
