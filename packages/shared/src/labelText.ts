import { DISCOVERY_TEXT_FORBIDDEN_RE } from './constants.js';

// ─── Single-line labels shown next to other people's ────────────────────────
// A space name, a webhook name, a display name, a nickname, a role or
// category name, an attachment's file name: one line, and none of the
// direction-override, zero-width, control and other characters that render as
// nothing and let one label read as another, except where an emoji sequence
// or a script's ordinary spelling needs one.
//
// One scan over the code points, never a lookbehind regex: this module ships
// in the desktop bundle, and the oldest WebKit the desktop runs on rejects a
// lookbehind at parse time. Every exception looks at a fixed number of
// neighbours, so the scan is linear.

// Line breaks and the tab: each run becomes ONE space. LF, TAB, VT, FF, CR,
// NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR.
const SPACE_LIKE = new Set([0x0a, 0x09, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);

// Characters that render as nothing, removed whatever the engine supports:
// HANGUL FILLER, HANGUL CHOSEONG FILLER, HANGUL JUNGSEONG FILLER, HALFWIDTH
// HANGUL FILLER, BRAILLE PATTERN BLANK (not default-ignorable, but blank),
// COMBINING GRAPHEME JOINER.
const BLANK_RENDERING = new Set([0x3164, 0x115f, 0x1160, 0xffa0, 0x2800, 0x034f]);

/**
 * Default_Ignorable_Code_Point as of Unicode 17, used where the engine has no
 * `\p{Default_Ignorable_Code_Point}`: there the rule removes these ranges, so
 * it removes at least as much as with the property, never less.
 */
export const DEFAULT_IGNORABLE_FALLBACK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const VARIATION_SELECTOR_15 = 0xfe0e;
const VARIATION_SELECTOR_16 = 0xfe0f;
const COMBINING_ENCLOSING_KEYCAP = 0x20e3;
const WAVING_BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const MONGOLIAN_FREE_VARIATION_SELECTORS = new Set([0x180b, 0x180c, 0x180d, 0x180f]);
const KEYCAP_BASES = new Set(Array.from('0123456789#*', (c) => c.charCodeAt(0)));
// The ideographic variation selectors (VARIATION SELECTOR-17 to -256)
const IDEOGRAPHIC_VARIATION_SELECTOR_FIRST = 0xe0100;
const IDEOGRAPHIC_VARIATION_SELECTOR_LAST = 0xe01ef;
// The viramas of the joiner scripts (canonical combining class 9; no regex
// property names them): Devanagari, Bengali, Gurmukhi, Gujarati, Oriya,
// Tamil, Telugu, Kannada, Malayalam (three), Sinhala
const JOINER_SCRIPT_VIRAMAS = new Set([0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d3b, 0x0d3c, 0x0d4d, 0x0dca]);

// The three subdivision flags that are emoji (England, Scotland, Wales): WAVING
// BLACK FLAG, the tag spelling of the region, CANCEL TAG. No other tag run.
const SUBDIVISION_FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'].map((region) => Array.from(region, (c) => 0xe0000 + c.charCodeAt(0)));

const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isVariationSelector = (cp: number) => cp === VARIATION_SELECTOR_15 || cp === VARIATION_SELECTOR_16;

// Scripts whose ordinary spelling uses ZERO WIDTH NON-JOINER or ZERO WIDTH
// JOINER between their own letters and marks (an Indic joiner follows a
// virama, a mark of the script)
const JOINER_SCRIPTS = [
  'Arabic', 'Syriac', 'Mongolian', 'Nko',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala',
];

interface LabelMatchers {
  pictographic: (ch: string) => boolean;
  defaultIgnorable: (ch: string, cp: number) => boolean;
  /** the index in JOINER_SCRIPTS of a letter or mark of one of those scripts, else -1 */
  joinerScriptLetterOrMark: (ch: string) => number;
  mongolianLetter: (ch: string) => boolean;
  han: (ch: string) => boolean;
}

const inFallbackRanges = (cp: number) => DEFAULT_IGNORABLE_FALLBACK_RANGES.some(([from, to]) => cp >= from && cp <= to);

/** Without Unicode property escapes: every listed ignorable removed, and no exception that needs a property. */
const FALLBACK_MATCHERS: LabelMatchers = {
  pictographic: () => false,
  defaultIgnorable: (_ch, cp) => inFallbackRanges(cp),
  joinerScriptLetterOrMark: () => -1,
  mongolianLetter: () => false,
  han: () => false,
};

let matchers: LabelMatchers | undefined;

/**
 * The Unicode-property tests, built on first use rather than at module load,
 * so an engine without one of these properties never fails the bundle: it
 * falls back to FALLBACK_MATCHERS, which keeps fewer characters, never more.
 */
function labelMatchers(): LabelMatchers {
  if (matchers) return matchers;
  try {
    const pictographic = new RegExp('^\\p{Extended_Pictographic}$', 'u');
    const ignorable = new RegExp('^\\p{Default_Ignorable_Code_Point}$', 'u');
    const letterOrMark = new RegExp('^[\\p{L}\\p{M}]$', 'u');
    const letter = new RegExp('^\\p{L}$', 'u');
    const scripts = JOINER_SCRIPTS.map((s) => new RegExp(`^\\p{Script=${s}}$`, 'u'));
    const mongolian = scripts[JOINER_SCRIPTS.indexOf('Mongolian')];
    const han = new RegExp('^\\p{Script=Han}$', 'u');
    matchers = {
      pictographic: (ch) => pictographic.test(ch),
      defaultIgnorable: (ch) => ignorable.test(ch),
      joinerScriptLetterOrMark: (ch) => (letterOrMark.test(ch) ? scripts.findIndex((re) => re.test(ch)) : -1),
      mongolianLetter: (ch) => letter.test(ch) && mongolian.test(ch),
      han: (ch) => han.test(ch),
    };
  } catch {
    // No Unicode property support in this engine: the stricter reading
    matchers = FALLBACK_MATCHERS;
  }
  return matchers;
}

/** A character the rule removes unless one of its exceptions keeps it. */
function isRemovable(cp: number, ch: string, m: LabelMatchers): boolean {
  return BLANK_RENDERING.has(cp) || DISCOVERY_TEXT_FORBIDDEN_RE.test(ch) || m.defaultIgnorable(ch, cp);
}

/**
 * Whether the removable character at `i` stays, by one of the exceptions:
 * - ZERO WIDTH JOINER between two pictographs, the one before it found by
 *   skipping VARIATION SELECTOR-16 and the skin-tone modifiers;
 * - ZERO WIDTH NON-JOINER or ZERO WIDTH JOINER between two letters or marks
 *   of the SAME joiner script;
 * - ZERO WIDTH NON-JOINER or ZERO WIDTH JOINER directly after a virama of a
 *   joiner script and before a space, a line break, a tab or the end of the
 *   text (a word ending in a legacy-encoded Malayalam chillu);
 * - VARIATION SELECTOR-15 or -16 directly after a pictograph, or between a
 *   keycap base (0-9, #, *) and COMBINING ENCLOSING KEYCAP;
 * - one ideographic variation selector directly after a Han character;
 * - a Mongolian free variation selector directly after a Mongolian letter.
 * Each neighbour an exception looks at is a character that stays itself (a
 * line break or tab stays as the space it becomes), so the result of a strip
 * strips to itself.
 */
function keepsRemovable(chars: string[], cps: number[], i: number, m: LabelMatchers): boolean {
  const cp = cps[i];
  const prev = i - 1;
  const next = i + 1 < chars.length ? i + 1 : -1;

  if (cp === ZWJ || cp === ZWNJ) {
    if (prev >= 0 && JOINER_SCRIPT_VIRAMAS.has(cps[prev]) && (next === -1 || SPACE_LIKE.has(cps[next]) || cps[next] === 0x20)) return true;
    if (next === -1 || isRemovable(cps[next], chars[next], m)) return false;
    if (cp === ZWJ) {
      let before = prev;
      while (before >= 0 && (cps[before] === VARIATION_SELECTOR_16 || isSkinTone(cps[before]))) before--;
      if (before >= 0 && m.pictographic(chars[before]) && m.pictographic(chars[next])) return true;
    }
    if (prev < 0 || isRemovable(cps[prev], chars[prev], m)) return false;
    const script = m.joinerScriptLetterOrMark(chars[prev]);
    return script !== -1 && m.joinerScriptLetterOrMark(chars[next]) === script;
  }

  if (isVariationSelector(cp)) {
    if (prev < 0) return false;
    if (m.pictographic(chars[prev])) return true;
    return KEYCAP_BASES.has(cps[prev]) && next !== -1 && cps[next] === COMBINING_ENCLOSING_KEYCAP;
  }

  if (cp >= IDEOGRAPHIC_VARIATION_SELECTOR_FIRST && cp <= IDEOGRAPHIC_VARIATION_SELECTOR_LAST) {
    return prev >= 0 && m.han(chars[prev]);
  }

  if (MONGOLIAN_FREE_VARIATION_SELECTORS.has(cp)) {
    return prev >= 0 && m.mongolianLetter(chars[prev]);
  }

  return false;
}

/** The length of the emoji subdivision flag starting at `i`, or 0. */
function subdivisionFlagAt(cps: number[], i: number): number {
  if (cps[i] !== WAVING_BLACK_FLAG) return 0;
  for (const tags of SUBDIVISION_FLAG_TAGS) {
    if (tags.every((tag, k) => cps[i + 1 + k] === tag) && cps[i + 1 + tags.length] === CANCEL_TAG) return tags.length + 2;
  }
  return 0;
}

/**
 * A single-line label with what it may not carry taken out. Every run of line
 * breaks and tabs becomes one space; every character of DISCOVERY_TEXT_FORBIDDEN_RE,
 * every default-ignorable code point and every blank-rendering character is
 * removed, except:
 * - ZERO WIDTH JOINER between two pictographs, the one before it found by
 *   skipping VARIATION SELECTOR-16 and the skin-tone modifiers (joined emoji:
 *   a family, the rainbow and transgender flags, a profession with a skin tone);
 * - the flags of England, Scotland and Wales (WAVING BLACK FLAG, the tag
 *   spelling gbeng, gbsct or gbwls, CANCEL TAG); every other tag run goes;
 * - ZERO WIDTH NON-JOINER or ZERO WIDTH JOINER between two letters or marks of
 *   the same script that uses them in ordinary spelling (Arabic, Syriac,
 *   Mongolian, N'Ko and the Indic scripts);
 * - ZERO WIDTH NON-JOINER or ZERO WIDTH JOINER directly after a virama of one
 *   of those scripts and before a space or the end of the text (a legacy
 *   Malayalam chillu, such as the end of avan);
 * - VARIATION SELECTOR-15 or -16 directly after a pictograph, or between a
 *   keycap base and COMBINING ENCLOSING KEYCAP (emoji presentation and keycap
 *   sequences);
 * - one ideographic variation selector (U+E0100 to U+E01EF) directly after a
 *   Han character (a Japanese ideographic variation sequence);
 * - a Mongolian free variation selector directly after a Mongolian letter.
 * Idempotent: a stripped label strips to itself. Not trimmed: the caller trims
 * after its own sanitising.
 */
export function stripUnsupportedLabelText(text: string): string {
  const chars = Array.from(text);
  const cps = chars.map((ch) => ch.codePointAt(0) ?? 0);
  const m = labelMatchers();
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const cp = cps[i];
    if (SPACE_LIKE.has(cp)) {
      out += ' ';
      while (i < chars.length && SPACE_LIKE.has(cps[i])) i++;
      continue;
    }
    const flag = subdivisionFlagAt(cps, i);
    if (flag > 0) {
      out += chars.slice(i, i + flag).join('');
      i += flag;
      continue;
    }
    if (!isRemovable(cp, chars[i], m) || keepsRemovable(chars, cps, i, m)) out += chars[i];
    i++;
  }
  return out;
}

/** Whether a single-line label carries anything stripUnsupportedLabelText would change: a validator never refuses what the stripper keeps. */
export function hasUnsupportedLabelText(text: string): boolean {
  return stripUnsupportedLabelText(text) !== text;
}
