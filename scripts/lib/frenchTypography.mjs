// The French typography rules for the locale file, in one place. The script
// scripts/fix-french-typography.mjs applies them to fr.json and the desktop
// test (src/__tests__/i18n/frenchTypography.test.ts) holds them for the whole
// file, so the rule lives only here. Pure functions, no I/O, no dependency.
//
// The two characters are written as escapes so a reader can see them:
//   U+2019  typographic apostrophe
//   U+00A0  no-break space (not U+202F: the project's French tests use U+00A0)

export const APOSTROPHE = '\u2019';
export const NBSP = '\u00a0';

// Private-use sentinels that stand in for a protected span while the rules
// run. SOFT: a placeholder or a tag, which is text like any other next to a
// mark (`{{name}}:` is a candidate). OPAQUE: an address, a code span or an
// emoji shortcode, which no rule may look into or touch from outside.
const SOFT = '\ue000';
const OPAQUE = '\ue001';

// Values kept as written, with the reason. An exact value, never a key.
export const KEPT_AS_WRITTEN = new Map([
  [
    'Which events would you like to trigger this webhook?',
    'English wording quoted from GitHub\u2019s own screen, which the person must recognise there',
  ],
]);

// Protected spans, in the order they are cut out.
const PROTECTED = [
  // A code span between backticks, cut out first so what it holds stays whole.
  { name: 'code span', pattern: /`[^`]*`/g, sentinel: OPAQUE },
  // i18next interpolation, `{{name}}`, `{{- name}}`, `{{count, number}}`.
  { name: 'placeholder', pattern: /\{\{[^{}]*\}\}/g, sentinel: SOFT },
  // An HTML-like tag of <Trans>: `<0>`, `</0>`, `<strong>`, `<a href="...">`.
  { name: 'tag', pattern: /<\/?[0-9A-Za-z]+(?:\s[^<>]*)?\/?>/g, sentinel: SOFT },
  // An address: a scheme and what follows up to a space; trailing prose
  // punctuation stays outside.
  {
    name: 'address',
    pattern: /\b(?:https?|wss?|ftp):\/\/[^\s<>"\u00ab\u00bb]*[^\s<>"\u00ab\u00bb.,;:!?)]|\bmailto:[^\s<>"\u00ab\u00bb]*[^\s<>"\u00ab\u00bb.,;:!?)]/g,
    sentinel: OPAQUE,
  },
];

// An emoji shortcode `:smile:`, alone between spaces or at an edge.
const SHORTCODE = /(^|\s)(:[a-z0-9_+-]+:)(?=$|[\s.,!?])/g;

// The sentinels above and their index characters live in this private-use
// range; a value already holding one would be corrupted, so it is refused.
const SENTINEL_RANGE = /[\ue000-\ue1ff]/;

function protect(value) {
  if (SENTINEL_RANGE.test(value)) {
    throw new Error(
      `a value holds a private-use character (U+E000 to U+E1FF), which the pass uses internally: ${JSON.stringify(value.slice(0, 40))}`,
    );
  }
  let text = value;
  const spans = [];
  for (const { pattern, sentinel } of PROTECTED) {
    text = text.replace(pattern, (match) => {
      spans.push(match);
      return sentinel + String.fromCharCode(0xe100 + spans.length - 1);
    });
  }
  text = text.replace(SHORTCODE, (_m, lead, code) => {
    spans.push(code);
    return lead + OPAQUE + String.fromCharCode(0xe100 + spans.length - 1);
  });
  return { text, spans };
}

// A span may hold another one (a placeholder inside a tag's attribute or an
// address), so restore until no sentinel is left.
function restore(text, spans) {
  const once = (t) => t.replace(/[\ue000\ue001][\ue100-\ue1ff]/g, (pair) => spans[pair.charCodeAt(1) - 0xe100]);
  let current = text;
  for (let next = once(current); next !== current; next = once(current)) current = next;
  return current;
}

const isSpace = (ch) => ch !== undefined && /\s/.test(ch);
const isIndexChar = (ch) => ch !== undefined && ch >= '\ue100' && ch <= '\ue1ff';

// What may follow a mark for it to be punctuation. A colon or a semicolon
// needs a space or the end (`10:30`, `16:9`, `:)`, `;)`, `host:3001` are not
// French punctuation); a question or exclamation mark may also stand before a
// closing bracket or a quotation mark.
function followsAsPunctuation(mark, next) {
  if (next === undefined || isSpace(next)) return true;
  if (mark === ':' || mark === ';') return false;
  return /[)\]\u00bb\u201d"'\u2019.,;:\u2026]/.test(next) || next === SOFT;
}

// What may stand directly before a mark that sits stuck to its word. A
// shortcut such as `Ctrl+;` and a path or option (`/`, `=`, `\`) are not
// prose.
const NEVER_BEFORE_A_MARK = /[+/\\=([{<>|]/;

function setMarkSpacing(text, jsonEscapes) {
  const chars = [...text];
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const isRun = ch === '?' || ch === '!';
    const isSingle = ch === ':' || ch === ';';
    if (!isRun && !isSingle) {
      out.push(ch);
      i += 1;
      continue;
    }
    let end = i + 1;
    if (isRun) while (end < chars.length && (chars[end] === '?' || chars[end] === '!')) end += 1;
    const mark = chars[i];
    // On RAW JSON text a line break is written as an escape (\n, \r, \t): a
    // space here. On a parsed value a backslash is a backslash (`C:\nom`).
    const escapedBreak = jsonEscapes && chars[end] === '\\' && 'nrt'.includes(chars[end + 1] ?? '-');
    const next = escapedBreak ? ' ' : chars[end];
    const prev = chars[i - 1];
    // The start of a string, or only blanks before it: nothing to attach to.
    const stuck = i > 0 && !isSpace(prev);
    const spaced = i > 0 && (prev === ' ' || prev === '\u202f') && i > 1 && !isSpace(chars[i - 2]);
    if (!followsAsPunctuation(mark, next)) {
      out.push(...chars.slice(i, end));
    } else if (spaced) {
      out[out.length - 1] = NBSP;
      out.push(...chars.slice(i, end));
    } else if (stuck) {
      const before = chars[i - 1];
      // An opaque span's own index char (an address, a code span) ends the
      // span; a soft one (placeholder, tag) is ordinary text.
      const afterOpaque = isIndexChar(before) && chars[i - 2] === OPAQUE;
      if (NEVER_BEFORE_A_MARK.test(before) || afterOpaque) out.push(...chars.slice(i, end));
      else out.push(NBSP, ...chars.slice(i, end));
    } else {
      out.push(...chars.slice(i, end));
    }
    i = end;
  }
  return out.join('');
}

function setGuillemetSpacing(text) {
  return text
    .replace(/\u00ab[ \u00a0\u202f]*(?=\S)/g, '\u00ab' + NBSP)
    .replace(/(\S)[ \u00a0\u202f]*\u00bb/g, '$1' + NBSP + '\u00bb');
}

/**
 * The rules, on one string VALUE.
 *  1. A straight apostrophe after a letter and before a letter, a digit, a
 *     guillemet, a placeholder or an opening tag becomes U+2019.
 *  2. A plain space before `?`, `!`, `:` or `;` becomes U+00A0; a mark stuck
 *     to a word gets one. A `?!` pair takes one space before it, none inside.
 *  3. A space inside « » becomes U+00A0, and one is set where none stands.
 * Placeholders, tags, addresses, code spans and emoji shortcodes are never
 * looked into. Nothing else changes.
 */
export function setFrenchTypography(value, { jsonEscapes = false } = {}) {
  if (KEPT_AS_WRITTEN.has(value)) return value;
  const { text, spans } = protect(value);
  return restore(setGuillemetSpacing(setMarkSpacing(setApostrophes(text, spans), jsonEscapes)), spans);
}

// An elision: a straight apostrophe after a letter and before a letter, a digit,
// a guillemet, a placeholder or an opening tag (a closing tag, an address, a
// code span and a shortcode are not). An apostrophe that opens or closes a
// quotation ('texte') or follows a digit (a prime, 5') is not an elision.
function setApostrophes(text, spans) {
  return text.replace(/(\p{L})'(?=\p{L}|\d|\u00ab|\ue000[\ue100-\ue1ff])/gu, (m, letter, offset) => {
    if (text[offset + 2] === SOFT && spans[text.charCodeAt(offset + 3) - 0xe100].startsWith('</')) return m;
    return letter + APOSTROPHE;
  });
}

/** Only the apostrophe rule, for a test that wants to see it alone. */
export function setFrenchApostrophes(value) {
  if (KEPT_AS_WRITTEN.has(value)) return value;
  const { text, spans } = protect(value);
  return restore(setApostrophes(text, spans), spans);
}

// One line of the locale file: `<indent>"key": "value"<comma>` (or a bare
// string of an array). The key is never touched; the value is taken as written
// between its quotes, so every escape stays as it is.
const VALUE_LINE = /^(\s*(?:"(?:[^"\\]|\\.)*"\s*:\s*)?")((?:[^"\\]|\\.)*)("\s*,?\s*)$/;

/**
 * The same rules over a whole JSON locale file's text, line by line, so the
 * line endings, the indent, the key order, the final newline and every escape
 * stay byte for byte. Returns the new text.
 */
export function setFrenchTypographyInJson(text) {
  return text
    .split(/(\r?\n)/)
    .map((piece) => {
      const m = VALUE_LINE.exec(piece);
      if (!m) return piece;
      try {
        return m[1] + setFrenchTypography(m[2], { jsonEscapes: true }) + m[3];
      } catch (err) {
        // Say which entry, then stop: the caller writes nothing.
        throw new Error(`${m[1].trim()} ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    })
    .join('');
}

/** Every string value of a parsed locale bundle, with its dotted key. */
export function stringValues(bundle, prefix = '') {
  if (typeof bundle === 'string') return [[prefix, bundle]];
  if (!bundle || typeof bundle !== 'object') return [];
  return Object.entries(bundle).flatMap(([k, v]) => stringValues(v, prefix ? `${prefix}.${k}` : k));
}
