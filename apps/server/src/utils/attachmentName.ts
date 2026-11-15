import { LIMITS } from '@voxium/shared';
import { sanitizeLabel } from './sanitize';

/** What a plaintext attachment is stored as when its file name comes out empty. */
export const ATTACHMENT_NAME_FALLBACK = 'attachment';

// A short trailing extension (`.pdf`, `.tar.gz`'s `.gz`): what a client saves
// the download under, so a cut keeps it. Longer, or holding a space or a
// dot, the tail is part of the name.
const EXTENSION_RE = /\.[^.\s]{1,16}$/u;

/** True for the first half of a UTF-16 surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * The file name a plaintext attachment is stored under: the client-supplied
 * name through sanitizeLabel (the label rule: one line, no direction-override,
 * control or stray zero-width characters; then sanitizeText), then cut to
 * LIMITS.ATTACHMENT_NAME_MAX code units, keeping its extension and never
 * splitting a surrogate pair; the rule runs again on the cut part, which can
 * end on a joiner or inside a flag's tag run.
 * Cut rather than refused: the client uploaded the file before it posted the
 * message, and a refusal would lose the message. A name that comes out empty
 * is stored as ATTACHMENT_NAME_FALLBACK. (A secure channel's or a DM's
 * attachment never stores the client's name: its real name is inside the
 * ciphertext.)
 */
export function storedAttachmentName(raw: string): string {
  const name = sanitizeLabel(raw);
  if (name.length === 0) return ATTACHMENT_NAME_FALLBACK;
  const max = LIMITS.ATTACHMENT_NAME_MAX;
  if (name.length <= max) return name;

  const extension = EXTENSION_RE.exec(name)?.[0] ?? '';
  const stem = name.slice(0, name.length - extension.length);
  let cut = max - extension.length;
  if (isHighSurrogate(stem.charCodeAt(cut - 1))) cut -= 1;
  const stored = `${sanitizeLabel(stem.slice(0, cut))}${extension}`;
  return stored.trim().length > 0 ? stored : ATTACHMENT_NAME_FALLBACK;
}
