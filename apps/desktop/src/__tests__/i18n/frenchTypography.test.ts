// @vitest-environment node
// Pure filesystem check over the whole French locale. The rules live once, in
// scripts/lib/frenchTypography.mjs (the script scripts/fix-french-typography.mjs
// applies them): this test fails the day a French string is added with a
// straight apostrophe or a plain space before ? ! : ; . The fix is to run
// `node scripts/fix-french-typography.mjs`, never to edit the file by hand.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  APOSTROPHE,
  NBSP,
  KEPT_AS_WRITTEN,
  setFrenchTypography,
  setFrenchApostrophes,
  setFrenchTypographyInJson,
  stringValues,
} from '../../../../../scripts/lib/frenchTypography.mjs';

const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));
const frText = readFileSync(LOCALE_DIR + 'fr.json', 'utf8');
const fr = stringValues(JSON.parse(frText));
const en = new Map(stringValues(JSON.parse(readFileSync(LOCALE_DIR + 'en.json', 'utf8'))));

// The placeholders and tags a value carries, as a sorted multiset.
const markup = (s: string) =>
  (s.match(/\{\{[^{}]*\}\}|<\/?[0-9A-Za-z]+(?:\s[^<>]*)?\/?>/g) ?? []).sort().join('|');

describe('French typography of fr.json', () => {
  it('reads the whole file', () => {
    expect(fr.length).toBeGreaterThan(2000);
  });

  it('every value is already as the rules set it', () => {
    const wrong = fr.filter(([, v]) => setFrenchTypography(v) !== v).map(([k]) => k);
    expect(wrong, 'run node scripts/fix-french-typography.mjs').toEqual([]);
  });

  it('the whole text is unchanged by a second run (idempotence on the real data)', () => {
    expect(setFrenchTypographyInJson(frText) === frText).toBe(true);
  });

  // Independent of the script's functions: these are the visible faults.
  it('no straight apostrophe of an elision (the script\'s own apostrophe rule)', () => {
    expect(fr.filter(([, v]) => setFrenchApostrophes(v) !== v).map(([k]) => k)).toEqual([]);
  });

  it('no straight apostrophe after a letter and before a letter, a digit, « or a placeholder', () => {
    expect(fr.filter(([, v]) => /\p{L}'(\p{L}|\d|«|\{\{)/u.test(v)).map(([k]) => k)).toEqual([]);
  });

  it('no narrow no-break space: the project uses U+00A0', () => {
    const narrow = String.fromCharCode(0x202f);
    expect(
      fr.filter(([, v]) => v.includes(narrow)).map(([k]) => k),
      'fr.json must use U+00A0 (no-break space), never U+202F',
    ).toEqual([]);
  });

  it('no plain space before ? ! : ; (a value kept as written excepted)', () => {
    const plain = fr
      .filter(([, v]) => !KEPT_AS_WRITTEN.has(v))
      .filter(([, v]) => / [?!:;]($|[\s)\u00bb])/.test(v))
      .map(([k]) => k);
    expect(plain).toEqual([]);
  });

  it('no mark stuck to a word before a space or the end (addresses, times and kept values excepted)', () => {
    // A colon or semicolon followed by a space or the end must have a no-break
    // space before it, whatever stands there. Addresses are cut out first.
    const stuck = fr
      .filter(([, v]) => !KEPT_AS_WRITTEN.has(v))
      .filter(([, v]) => /[^\s\u00a0][:;](\s|$)/.test(v.replace(/https?:\/\/\S*|mailto:\S*/g, '')))
      .map(([k]) => k);
    expect(stuck).toEqual([]);
  });

  it('every guillemet pair has a no-break space inside it', () => {
    const bad = fr.filter(([, v]) => /\u00ab(?!\u00a0)|(?<!\u00a0)\u00bb/.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('uses the two code points the project French tests use', () => {
    expect(APOSTROPHE).toBe('\u2019');
    expect(NBSP).toBe('\u00a0');
    expect(fr.some(([, v]) => v.includes('\u2019'))).toBe(true);
    expect(fr.some(([, v]) => v.includes('\u00a0?'))).toBe(true);
  });

  it('keeps the file as the project writes it: one line ending throughout, two-space indent, final newline', () => {
    // Git stores LF and a Windows checkout turns it into CRLF: either is fine,
    // a mixture is not.
    const crlf = frText.includes('\r\n');
    expect(crlf ? /[^\r]\n/.test(frText) : frText.includes('\r')).toBe(false);
    expect(frText.endsWith(crlf ? '}\r\n' : '}\n')).toBe(true);
    expect(frText.startsWith(crlf ? '{\r\n  "' : '{\n  "')).toBe(true);
  });

  it('has the same keys as en.json, and each value the same placeholders and tags', () => {
    expect(fr.length).toBe(en.size);
    for (const [key, value] of fr) {
      expect(en.has(key), key).toBe(true);
      expect(markup(value), key).toBe(markup(en.get(key)!));
    }
  });

  it('lists every value kept as written, each with a reason', () => {
    for (const [value, reason] of KEPT_AS_WRITTEN) {
      expect(fr.some(([, v]) => v === value), value).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
