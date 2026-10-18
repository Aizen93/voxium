/**
 * Markdown helpers for text an incoming webhook interpolates into markup.
 *
 * The desktop renders message content with react-markdown + remark-gfm +
 * remark-breaks (allowlist: p strong em del code pre blockquote ul ol li a br
 * input). A webhook formatter builds markup AROUND sender-controlled strings
 * (an embed title inside **[...](...)**, an author name inside _..._), so
 * those strings must not be able to close the markup early or open their own.
 */

// \ * _ ~ ` [ ] ( ) # > |  (the backslash first in the class, escaped)
const MARKDOWN_SPECIAL_RE = /[\\*_~`[\]()#>|]/g;

// LF, VT, FF, CR, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR — built from code
// points so no raw line-separator character sits in the source
export const LINE_BREAK_CHARS = [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]
  .map((cp) => String.fromCharCode(cp))
  .join('');
const LINE_BREAKS_RE = new RegExp(`[${LINE_BREAK_CHARS}]+`, 'g');

/** Every run of line breaks (CR, LF, VT, FF, NEL, U+2028, U+2029) → one space. */
export function collapseLineBreaks(text: string): string {
  return text.replace(LINE_BREAKS_RE, ' ');
}

/**
 * Escape a SINGLE-LINE field for interpolation into markdown: every run of
 * line breaks becomes one space (a newline would end the enclosing markup or
 * the blockquote line), then each markdown-significant character gets a
 * backslash, so `](https://evil)` in a title cannot close the link early.
 */
export function escapeMarkdown(text: string): string {
  return collapseLineBreaks(text).replace(MARKDOWN_SPECIAL_RE, '\\$&');
}

/**
 * `&`, `<` and `>` as HTML entities (`&` first, so an entity the sender typed
 * stays literal). Markdown decodes them back, so the reader sees the
 * characters as typed — `Option<T>` stays `Option<T>`, `&lt;b&gt;` stays
 * `&lt;b&gt;` — and no raw angle bracket of a field reaches a later
 * tag-stripping pass over the whole content, where a `<` in one field and a
 * `>` in another would be stripped as one "tag" across the markup between.
 */
export function encodeHtmlEntities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A single-line field inside a link label: `&`, `<` and `>` as entities
 * (rendered as the characters as typed, so a title keeps its `Option<T>` and no
 * raw angle bracket of a field reaches a later tag-stripping pass over the
 * whole content), then the markdown escape, so the label cannot close its link
 * early. GFM never autolinks inside a link. Shared by both formatters: an
 * escaping rule fixed in one must hold in the other.
 */
export function labelText(raw: string): string {
  return escapeMarkdown(encodeHtmlEntities(raw));
}

/** A JSON object (not null, not an array): what a payload field must be to be read. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A run remark-gfm would turn into a link on its own (a GFM autolink
// literal): an http(s):// or www. address, or an e-mail address (which also
// covers the mailto:/xmpp: forms, whose address part it matches). Broader
// than GFM on purpose — any case, no rule about the character before
// `https://`, and `www.` after anything but a letter or digit: wrapping a run
// GFM would have left alone costs a code span, missing one costs a link. A
// URL run ends at whitespace, an angle bracket or a backtick: GFM's own URL
// ends at whitespace or `<`, and none of the three may sit raw in the span.
// An address starts only where a run of address characters starts (the
// lookbehind): a match found inside such a run also starts at its beginning,
// and without it a long run without an `@` is rescanned from every position.
const AUTOLINK_RUN_RE =
  /(?:https?:\/\/|(?<![A-Za-z0-9])www\.)[^\s<>`]*|(?<![A-Za-z0-9._+-])[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/gi;
// Punctuation GFM leaves out of the end of an autolink; kept out of the span
// too, so `see https://x.example/1.` reads as the address and a full stop
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '!', '?', '*', '_', '~', "'", '"']);

/** The run without trailing punctuation, nor a trailing `)` that has no `(` to close. */
function trimRunEnd(run: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of run) {
    if (ch === '(') opens += 1;
    else if (ch === ')') closes += 1;
  }
  let end = run.length;
  while (end > 0) {
    const ch = run[end - 1];
    if (TRAILING_PUNCTUATION.has(ch)) {
      end -= 1;
    } else if (ch === ')' && closes > opens) {
      closes -= 1;
      end -= 1;
    } else {
      break;
    }
  }
  return run.slice(0, end);
}

/**
 * A SINGLE-LINE field for interpolation into markdown OUTSIDE a link label:
 * every run remark-gfm would autolink by itself (a bare URL, a `www.` host,
 * an e-mail address) goes into an inline code span, verbatim — no escape
 * works inside a span (an escape there would show as a backslash, and a
 * backslash escape inside an autolink ends up in its address), and a
 * backtick would end the span early, so backticks are replaced with `'`.
 * A URL inside a code span is never linked: a sender string cannot add a
 * link to any host. Everything around the runs goes through `escapeRest`
 * (markdown escapes by default). Line breaks are collapsed first.
 *
 * Not for a link label (GFM never autolinks inside a link, and the label
 * would read as code), nor for free text kept as the sender wrote it.
 */
export function neutraliseAutolinks(text: string, escapeRest: (segment: string) => string = escapeMarkdown): string {
  const line = collapseLineBreaks(text);
  let out = '';
  let from = 0;
  for (const match of line.matchAll(AUTOLINK_RUN_RE)) {
    const run = trimRunEnd(match[0]);
    if (run === '') continue;
    out += `${escapeRest(line.slice(from, match.index))}\`${run.replace(/`/g, "'")}\``;
    from = match.index + run.length;
  }
  return out + escapeRest(line.slice(from));
}

/**
 * The URL in its normalised form (`new URL(url).href`) when it parses and is
 * http(s), else null — `javascript:`, `data:`, relative paths and garbage
 * never become a link target. The normalised form is returned rather than the
 * raw string: the parser strips tabs/newlines and percent-encodes spaces and
 * angle brackets, so the result can sit inside a markdown link destination.
 */
export function safeHttpUrl(url: unknown): string | null {
  // Not a URL at all: the caller drops the link and keeps the text
  if (typeof url !== 'string' || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
}

/**
 * A link destination for `[text](destination)`: backslash-escape `\`, `(` and
 * `)` (CommonMark honours backslash escapes in destinations, so the target is
 * unchanged), so a `)` inside the URL cannot end the destination early and
 * start a second, sender-chosen link. Pass only what safeHttpUrl() returned.
 */
export function escapeLinkDestination(href: string): string {
  return href.replace(/[\\()]/g, '\\$&');
}
