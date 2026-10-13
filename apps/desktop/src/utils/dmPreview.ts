import { parseE2EEnvelope } from '@voxium/shared';
import type { Conversation } from '@voxium/shared';

/**
 * What the conversation list may print for a last message, or null for the
 * lock. Hydrated plaintext of an encrypted message (no longer an envelope) is
 * shown. An UNENCRYPTED row is shown only when it is a system notice ("Voice
 * call started"): every user DM is end-to-end encrypted since the 2.0
 * cutover, so plaintext on a user row is the server's word, not the sender's.
 */
export function dmPreviewText(last: NonNullable<Conversation['lastMessage']>): string | null {
  if (last.encrypted) {
    return !last.content || parseE2EEnvelope(last.content) !== null ? null : last.content;
  }
  return last.type === 'system' ? last.content : null;
}
