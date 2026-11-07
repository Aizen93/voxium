// Test helpers for the webhook renderers' markdown (not a test file itself).
//
// The desktop renders message content with react-markdown + remark-gfm, whose
// autolink literals turn a bare URL, a `www.` host or an e-mail address into
// a link with no markup at all. These helpers read rendered content the way a
// reader sees it, so a test can assert that no sender text autolinks.

const BACKSLASH = String.fromCharCode(0x5c);
const AUTOLINKABLE_RE = /https?:\/\/\S*|www\.\S*|[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/gi;

type Skipped = 'code' | 'destination';

/**
 * The text of `markdown` outside the skipped constructs: backslash escapes
 * resolved (an escaped character is plain text), each code span and/or link
 * destination replaced by one space, so the text on either side never joins.
 */
function visibleText(markdown: string, skip: ReadonlySet<Skipped>): string {
  let out = '';
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i];
    if (ch === BACKSLASH && i + 1 < markdown.length) {
      out += markdown[i + 1];
      i += 1;
      continue;
    }
    if (ch === '`' && skip.has('code')) {
      // No escape works inside a span: the next backtick closes it
      const close = markdown.indexOf('`', i + 1);
      if (close !== -1) {
        out += ' ';
        i = close;
        continue;
      }
    }
    if (ch === ']' && markdown[i + 1] === '(' && skip.has('destination')) {
      let j = i + 2;
      while (j < markdown.length && markdown[j] !== ')') j += markdown[j] === BACKSLASH ? 2 : 1;
      out += ' ';
      i = j;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Every run remark-gfm would autolink on its own (an http(s):// or www.
 * address, an e-mail address) in the text OUTSIDE code spans and OUTSIDE
 * `](...)` link destinations, after the entities the renderers write are
 * decoded. Broader than GFM (any preceding character, any case). Empty: no
 * sender text in `markdown` can become a link.
 */
export function bareLinkRuns(markdown: string): string[] {
  const visible = visibleText(markdown, new Set<Skipped>(['code', 'destination']))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return visible.match(AUTOLINKABLE_RE) ?? [];
}

/** The markdown with every code span cut out (escapes resolved): what may not hold a raw `<`. */
export function outsideCodeSpans(markdown: string): string {
  return visibleText(markdown, new Set<Skipped>(['code']));
}
