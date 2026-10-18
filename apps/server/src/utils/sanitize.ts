/**
 * Strip HTML tags from a string (defense-in-depth).
 *
 * A tag is a '<' through the next '>'; a '<' with no '>' after it is kept as
 * text, with the rest of the string. These are exactly the semantics of
 * `str.replace(/<[^>]*>/g, '')`, but as a LINEAR scan: that regex backtracks
 * to the end of the string at every '<' that has no '>' after it, so a 1 MB
 * run of '<' (an incoming-webhook body) blocked the event loop for minutes.
 */
export function stripHtml(str: string): string {
  let lt = str.indexOf('<');
  if (lt === -1) return str;

  let out = '';
  let from = 0;
  while (lt !== -1) {
    const gt = str.indexOf('>', lt + 1);
    // No '>' anywhere after this '<': no later '<' can close either, so the
    // rest of the string is text
    if (gt === -1) break;
    out += str.slice(from, lt);
    from = gt + 1;
    lt = str.indexOf('<', from);
  }
  return out + str.slice(from);
}

/** Strip HTML tags and trim whitespace. Coerces non-strings to empty string. */
export function sanitizeText(str: unknown): string {
  if (typeof str !== 'string') return '';
  return stripHtml(str).trim();
}
