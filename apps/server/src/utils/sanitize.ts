import { CUSTOM_EMOJI_RE } from '@voxium/shared';

/** Strip HTML tags from a string (defense-in-depth) */
export function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '');
}

/** Strip HTML tags and trim whitespace. Coerces non-strings to empty string.
 *  Preserves custom emoji tokens (<:name:id>) through HTML stripping. */
export function sanitizeText(str: unknown): string {
  if (typeof str !== 'string') return '';
  // Extract custom emoji tokens before HTML stripping (stripHtml removes <...> tags)
  const placeholders: string[] = [];
  const safe = str.replace(new RegExp(CUSTOM_EMOJI_RE.source, CUSTOM_EMOJI_RE.flags), (match) => {
    placeholders.push(match);
    return `\x00CE${placeholders.length - 1}\x00`;
  });
  let result = stripHtml(safe).trim();
  // Restore custom emoji tokens
  result = result.replace(/\x00CE(\d+)\x00/g, (_, i) => placeholders[parseInt(i)]);
  return result;
}
