/** Strip HTML tags from a string (defense-in-depth) */
export function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '');
}

/** Strip HTML tags and trim whitespace. Coerces non-strings to empty string. */
export function sanitizeText(str: unknown): string {
  if (typeof str !== 'string') return '';
  return stripHtml(str).trim();
}
