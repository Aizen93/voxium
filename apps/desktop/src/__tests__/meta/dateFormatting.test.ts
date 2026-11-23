// @vitest-environment node
// Dates and times a person reads follow the language chosen in the app, through
// utils/formatDate.ts alone. This scans the desktop sources (tests, the helper
// and the legal documents excluded) for:
//   covered:     toLocaleDateString( and toLocaleTimeString( anywhere,
//                toLocaleString( (on a number the OS decides the grouping too:
//                listed with its reason), Intl.DateTimeFormat( and
//                `format` imported from date-fns;
//   NOT covered: a date assembled by hand from getHours() and friends, month
//                names in a literal, or a formatter built in another file
//                through a wrapper; those need a reader, not a pattern.
// The legal documents print their dates through formatLegalDate on purpose
// (fixed month names, no Intl): that folder is left out whole.
// Comments and the contents of strings are ignored.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(p, out); }
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** The source with comments and string/template contents blanked out */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < src.length && src[i] !== quote) { if (src.charCodeAt(i) === 92) i++; i++; }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'toLocaleDateString(', re: /\.toLocaleDateString\s*\(/g },
  { name: 'toLocaleTimeString(', re: /\.toLocaleTimeString\s*\(/g },
  { name: 'toLocaleString(', re: /\.toLocaleString\s*\(/g },
  { name: 'Intl.DateTimeFormat(', re: /Intl\.DateTimeFormat\s*\(/g },
];
const DATE_FNS_FORMAT = /import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*'date-fns'/g;

export function findDateFormatting(src: string): string[] {
  const code = stripCommentsAndStrings(src);
  const hits: string[] = [];
  for (const f of FORBIDDEN) for (const _ of code.matchAll(f.re)) hits.push(f.name);
  // the import line itself holds a string, so read it from the original with comments removed
  const withStrings = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const _ of withStrings.matchAll(DATE_FNS_FORMAT)) hits.push("import { format } from 'date-fns'");
  return hits;
}

const HELPER = 'utils/formatDate.ts';
const LEGAL = 'components/legal/';

const RIGHT_AS_THEY_ARE: Array<{ file: string; count: number; reason: string }> = [
  { file: 'components/settings/ThemeEditor.tsx', count: 3, reason: 'a number of characters, not a date: the grouping of the reader is right' },
  { file: 'pages/LandingPage.tsx', count: 1, reason: 'a count on the landing page, fixed to en-US on purpose: the page is English' },
];

describe('desktop sources: dates and times go through utils/formatDate.ts', () => {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === HELPER || rel.startsWith(LEGAL)) continue;
    const n = findDateFormatting(readFileSync(file, 'utf8')).length;
    if (n > 0) found.set(rel, n);
  }

  it('finds exactly the listed ones, file by file and count by count', () => {
    const expected = new Map(RIGHT_AS_THEY_ARE.map((e) => [e.file, e.count]));
    expect(Object.fromEntries([...found].sort())).toEqual(Object.fromEntries([...expected].sort()));
  });

  it('lists each file once, with a reason', () => {
    expect(new Set(RIGHT_AS_THEY_ARE.map((e) => e.file)).size).toBe(RIGHT_AS_THEY_ARE.length);
    for (const e of RIGHT_AS_THEY_ARE) expect(e.reason.length).toBeGreaterThan(10);
  });

  it('leaves the legal documents alone: they still print through formatLegalDate', () => {
    const legal = walk(join(SRC, 'components', 'legal')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(legal).toContain('formatLegalDate');
    expect(legal).not.toContain('formatDate(');
  });
});

describe('the scanner itself, on in-memory sources', () => {
  const count = (src: string) => findDateFormatting(src).length;

  it.each([
    ['toLocaleDateString', 'const a = d.toLocaleDateString();'],
    ['toLocaleTimeString with a locale list', "const a = d.toLocaleTimeString([], { hour: '2-digit' });"],
    ['toLocaleString', 'const a = new Date(x).toLocaleString();'],
    ['a spaced call', 'const a = d.toLocaleString ();'],
    ['Intl.DateTimeFormat with the language', 'const a = new Intl.DateTimeFormat(i18n.language, {}).format(d);'],
    ['date-fns format', "import { format, isToday } from 'date-fns';"],
  ])('refuses %s', (_name, src) => {
    expect(count(src)).toBe(1);
  });

  it.each([
    ['a comment', '// d.toLocaleString() would follow the OS\nconst a = 1;'],
    ['a block comment', '/* new Intl.DateTimeFormat(x) */ const a = 1;'],
    ['a string', "const a = 'toLocaleDateString()';"],
    ['the date-fns helpers that print nothing', "import { isToday, isYesterday, isSameDay } from 'date-fns';"],
    ['Intl.RelativeTimeFormat', 'const f = new Intl.RelativeTimeFormat(lang);'],
    ['the helper', "const a = formatDate('date', d);"],
  ])('accepts %s', (_name, src) => {
    expect(count(src)).toBe(0);
  });
});
