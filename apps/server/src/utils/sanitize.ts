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

// U+0000 cannot be stored in a PostgreSQL text column: the insert fails and
// the caller gets a 500 with a logged stack. Dropped here, so neither a member's
// message nor an incoming-webhook body (an unauthenticated caller) can turn one
// byte into that. Built from the code point: no raw NUL in the source.
const NUL_RE = new RegExp(String.fromCharCode(0), 'g');

/** Strip HTML tags, drop NUL bytes and trim whitespace. Coerces non-strings to empty string. */
export function sanitizeText(str: unknown): string {
  if (typeof str !== 'string') return '';
  return stripHtml(str).replace(NUL_RE, '').trim();
}
