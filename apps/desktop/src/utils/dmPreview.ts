import { parseE2EEnvelope, isDMSystemNotice } from '@voxium/shared';
import type { Conversation } from '@voxium/shared';

/**
 * What the conversation list may print for a last message, or null for the
 * lock. Hydrated plaintext of an encrypted message (no longer an envelope) is
 * shown. An UNENCRYPTED row is shown only when it is one of the server's call
 * notices (DM_SYSTEM_NOTICES): every user DM is end-to-end encrypted since the
 * 2.0 cutover, and both the flag and the type are the server's word, so the
 * closed list of strings is what decides.
 */
export function dmPreviewText(last: NonNullable<Conversation['lastMessage']>): string | null {
  if (last.encrypted) {
    // hydrated plaintext shows; a blank locks (the store blanks the server's
    // text on arrival) — the envelope check is a backstop no current path needs
    return !last.content || parseE2EEnvelope(last.content) !== null ? null : last.content;
  }
  // a 2.0 server sends no `type`; the notice text is what decides either way
  return (last.type === 'system' || last.type === undefined) && isDMSystemNotice(last.content) ? last.content : null;
}
