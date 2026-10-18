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
const LINE_BREAK_CHARS = [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]
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
