import { describe, it, expect, vi, afterEach } from 'vitest';
import { validatePassword, LIMITS } from '@voxium/shared';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Shared validators — validatePassword (P2 — bcrypt 72-BYTE limit)', () => {
  it('accepts a normal short password', () => {
    expect(validatePassword('password123')).toBeNull();
  });

  it('accepts exactly 72 ASCII characters (72 bytes)', () => {
    expect(validatePassword('a'.repeat(72))).toBeNull();
  });

  it('rejects 73 ASCII characters (73 bytes)', () => {
    expect(validatePassword('a'.repeat(73))).not.toBeNull();
  });

  it('rejects a multi-byte password that is under 72 chars but over 72 UTF-8 bytes', () => {
    // 30 CJK chars = 30 UTF-16 code units, but 90 UTF-8 bytes — bcrypt would
    // silently truncate at byte 72, so this must be rejected
    const password = '密'.repeat(30);
    expect(password.length).toBeLessThanOrEqual(LIMITS.PASSWORD_MAX);

    const err = validatePassword(password);
    expect(err).not.toBeNull();
    expect(err).toContain('bytes');
  });

  it('rejects passwords below PASSWORD_MIN', () => {
    const err = validatePassword('a'.repeat(LIMITS.PASSWORD_MIN - 1));
    expect(err).not.toBeNull();
    expect(err).toContain(`at least ${LIMITS.PASSWORD_MIN}`);
  });
});

// ─── Registration abuse defenses ─────────────────────────────────────────────

import { canonicalizeEmail, isDisposableEmailDomain } from '@voxium/shared';

describe('canonicalizeEmail', () => {
  it('collapses gmail dot/plus aliases to one canonical inbox', () => {
    // THE bot vector: every one of these is the same mailbox
    for (const alias of [
      'john.doe@gmail.com',
      'j.o.h.n.d.o.e@gmail.com',
      'johndoe+voxium@gmail.com',
      'John.Doe+a.b.c@GMAIL.COM',
      'johndoe@googlemail.com'.replace('googlemail', 'gmail'),
    ]) {
      expect(canonicalizeEmail(alias)).toBe('johndoe@gmail.com');
    }
    expect(canonicalizeEmail('j.doe@googlemail.com')).toBe('jdoe@googlemail.com');
  });

  it('leaves other providers untouched beyond lowercase/trim — dots are significant there', () => {
    expect(canonicalizeEmail('  John.Doe@Example.com ')).toBe('john.doe@example.com');
    expect(canonicalizeEmail('user+tag@proton.me')).toBe('user+tag@proton.me');
  });

  it('is safe on malformed input', () => {
    expect(canonicalizeEmail('not-an-email')).toBe('not-an-email');
    expect(canonicalizeEmail('')).toBe('');
  });
});

describe('isDisposableEmailDomain', () => {
  it('flags known disposable providers, case-insensitively', () => {
    expect(isDisposableEmailDomain('bot@mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('bot@YOPMAIL.com')).toBe(true);
    expect(isDisposableEmailDomain('x@10minutemail.net')).toBe(true);
  });

  it('passes normal providers and malformed input', () => {
    expect(isDisposableEmailDomain('user@gmail.com')).toBe(false);
    expect(isDisposableEmailDomain('user@proton.me')).toBe(false);
    expect(isDisposableEmailDomain('no-at-sign')).toBe(false);
  });
});

import { validateEmail } from '@voxium/shared';

describe('Shared validators — validateEmail (one mailbox, as the mailer reads it)', () => {
  it.each([
    'alice@example.com',
    'first.last@example.co.uk',
    'alice+newsletter@example.com',
    'o\'brien@example.ie',
    'user-name_1@sub.domain.example',
    'jürgen@müller.de',
    'a@b.co',
    'x@mail-1.a-b.example.co.uk',
  ])('accepts %s', (email) => {
    expect(validateEmail(email)).toBeNull();
  });

  it.each([
    ['a comment after the domain', 'victim@gmail.com(1)'],
    ['a comment in the local part', 'victim(1)@gmail.com'],
    ['a comment that looks like a TLD', 'x@mailinator.com(.org)'],
    ['a list separator', 'a,victim@corp.com'],
    ['a group/semicolon tail', 'victim@corp.com;x.y'],
    ['an angle-addr', '<victim@corp.com>'],
    ['a quoted local part', '"victim"@corp.com'],
    ['a domain literal', 'victim@[127.0.0.1].com'],
    ['a colon', 'victim:x@corp.com'],
    ['a backslash', 'vic\tim@corp.com'],
    ['a space', 'vic tim@corp.com'],
    ['a tab', 'victim@corp.com\t'],
    ['a control character', 'victim\u0001@corp.com'],
    ['a DEL character', 'victim\u007f@corp.com'],
    ['two @', 'a@b@corp.com'],
    ['no @', 'victim.corp.com'],
    ['no dot in the domain', 'victim@localhost'],
    ['an empty local part', '@corp.com'],
    ['a trailing dot after the domain', 'a@gmail.com.'],
    ['a trailing dot after a listed domain', 'a@mailinator.com.'],
    ['two trailing dots', 'a@gmail.com..'],
    ['a leading dot in the domain', 'a@.gmail.com'],
    ['two dots in a row in the domain', 'a@gmail..com'],
    ['a domain that is only dots', 'a@..'],
  ])('refuses %s', (_label, email) => {
    expect(validateEmail(email)).toBe('Invalid email address');
  });

  it('caps the whole address at 254 characters (RFC 5321)', () => {
    // a 64-character local part, the domain padded to make exactly 254
    const local = 'a'.repeat(64);
    const host = 'b'.repeat(254 - local.length - '@'.length - '.com'.length);
    expect(`${local}@${host}.com`).toHaveLength(LIMITS.EMAIL_MAX);
    expect(validateEmail(`${local}@${host}.com`)).toBeNull();
    expect(validateEmail(`${local}@${host}x.com`)).toBe('Invalid email address');
  });

  it('caps the local part at 64 characters', () => {
    expect(validateEmail(`${'a'.repeat(64)}@example.com`)).toBeNull();
    expect(validateEmail(`${'a'.repeat(65)}@example.com`)).toBe('Invalid email address');
  });

  it('refuses the 98 KB comma list that made the address parser quadratic, in linear time', () => {
    const list = 'a,'.repeat(49_000) + 'a@b.co';
    const started = performance.now();
    expect(validateEmail(list)).toBe('Invalid email address');
    expect(performance.now() - started).toBeLessThan(50);
  });
});

// ─── Single-line labels shown next to other people's (issue #148) ────────────

import {
  hasUnsupportedLabelText, stripUnsupportedLabelText, DEFAULT_IGNORABLE_FALLBACK_RANGES,
  validateDisplayName, validateNickname, validateRoleName, validateCategoryName,
  validateServerName, validateWebhookName,
} from '@voxium/shared';

// Built from code points: no raw joiner, tag, selector or control character sits in this file
const cps = (...points: number[]) => String.fromCodePoint(...points);
const tagged = (ascii: string) => cps(...Array.from(ascii, (c) => 0xe0000 + c.charCodeAt(0)));
const RLO = cps(0x202e); // RIGHT-TO-LEFT OVERRIDE
const ZWSP = cps(0x200b); // ZERO WIDTH SPACE
const ZWNJ = cps(0x200c); // ZERO WIDTH NON-JOINER
const ZWJ = cps(0x200d); // ZERO WIDTH JOINER
const LRM = cps(0x200e); // LEFT-TO-RIGHT MARK
const BOM = cps(0xfeff); // ZERO WIDTH NO-BREAK SPACE
const VS15 = cps(0xfe0e);
const VS16 = cps(0xfe0f);
const KEYCAP = cps(0x20e3);
const TAG_A = cps(0xe0061); // TAG LATIN SMALL LETTER A
const CANCEL_TAG = cps(0xe007f);
const BLACK_FLAG = cps(0x1f3f4);
const PARTY = cps(0x1f389);
const LF = cps(10);
const CR = cps(13);
const TAB = cps(9);
const flagOf = (region: string) => `${BLACK_FLAG}${tagged(region)}${CANCEL_TAG}`;

// Sequences people really put in their names: every one is kept whole
const KEPT: Array<[string, string]> = [
  ['family', cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)],
  ['rainbow flag', cps(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)],
  ['transgender flag', cps(0x1f3f3, 0xfe0f, 0x200d, 0x26a7, 0xfe0f)],
  ['pirate flag', cps(0x1f3f4, 0x200d, 0x2620, 0xfe0f)],
  ['woman technologist, medium skin tone', cps(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb)],
  ['heart on fire', cps(0x2764, 0xfe0f, 0x200d, 0x1f525)],
  ['flag of England', flagOf('gbeng')],
  ['flag of Scotland', flagOf('gbsct')],
  ['flag of Wales', flagOf('gbwls')],
  ['red heart in emoji presentation (a pictograph and VARIATION SELECTOR-16)', cps(0x2764, 0xfe0f)],
  ['smiling face in text presentation (VARIATION SELECTOR-15)', cps(0x263a, 0xfe0e)],
  ['keycap one (1, VARIATION SELECTOR-16, COMBINING ENCLOSING KEYCAP)', cps(0x31, 0xfe0f, 0x20e3)],
  ['keycap number sign', cps(0x23, 0xfe0f, 0x20e3)],
  ['Persian "I want" (a zero-width non-joiner)', cps(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645)],
  ['Sinhala "Sri Lanka" (a joiner after a virama)', cps(0x0dc1, 0x0dca, 0x200d, 0x0dbb, 0x0dd3, 0x20, 0x0dbd, 0x0d82, 0x0d9a, 0x0dcf)],
  ['Malayalam conjunct (a joiner after a virama)', cps(0x0d15, 0x0d4d, 0x200d, 0x0d37)],
  ['Mongolian letter with a free variation selector', cps(0x1820, 0x180b, 0x1821)],
  ['Japanese ideographic variation sequence (a Han character and VARIATION SELECTOR-17)', cps(0x845b, 0xe0100)],
  ['Han character with the last ideographic selector', cps(0x8fbb, 0xe01ef)],
  ['legacy Malayalam chillu "avan" (virama, ZERO WIDTH JOINER, word end)', cps(0x0d05, 0x0d35, 0x0d28, 0x0d4d, 0x200d)],
];

// Characters that render as nothing (one of each class), each removed
const BLANK = [
  0x3164, 0x115f, 0x1160, 0xffa0, 0x2800, 0x034f, // fillers, braille blank, grapheme joiner
  0xfe00, 0xfe01, 0xe0100, 0xe01ef, 0xe0fff, // variation selectors (outside an emoji sequence) and their supplement
  0x17b4, 0x17b5, 0x180b, 0x180f, 0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a,
].map((cp) => cps(cp));

describe('stripUnsupportedLabelText — what a label keeps', () => {
  for (const [name, sequence] of KEPT) {
    it(`keeps ${name}`, () => {
      expect(stripUnsupportedLabelText(sequence)).toBe(sequence);
      expect(stripUnsupportedLabelText(`Alice ${sequence} Bob`)).toBe(`Alice ${sequence} Bob`);
      expect(hasUnsupportedLabelText(`Alice ${sequence}`)).toBe(false);
    });
  }

  it('keeps an ordinary name as it is', () => {
    expect(stripUnsupportedLabelText('Élodie 🎉 Ünal-Ōno (mod) #2')).toBe('Élodie 🎉 Ünal-Ōno (mod) #2');
  });
});

describe('stripUnsupportedLabelText — what a label loses', () => {
  it('a joiner that joins no emoji and no letters of one joiner script', () => {
    expect(stripUnsupportedLabelText(`Al${ZWJ}ice`)).toBe('Alice');
    expect(stripUnsupportedLabelText(`${PARTY}${ZWJ}admin`)).toBe(`${PARTY}admin`);
    expect(stripUnsupportedLabelText(`admin${ZWJ}${PARTY}`)).toBe(`admin${PARTY}`);
    expect(stripUnsupportedLabelText(`Al${ZWNJ}ice`)).toBe('Alice');
    // at an edge, or between a joiner-script letter and a Latin one
    expect(stripUnsupportedLabelText(`${PARTY}${ZWJ}`)).toBe(PARTY);
    expect(stripUnsupportedLabelText(`${cps(0x0628)}${ZWNJ}`)).toBe(cps(0x0628));
    expect(stripUnsupportedLabelText(`${cps(0x0628)}${ZWNJ}b`)).toBe(`${cps(0x0628)}b`);
    // two joiners in a row join nothing
    expect(stripUnsupportedLabelText(cps(0x1f468, 0x200d, 0x200d, 0x1f469))).toBe(cps(0x1f468, 0x1f469));
  });

  it('a joiner between letters of two different joiner scripts, or beside a digit or a sign of the script', () => {
    // Arabic | Devanagari
    expect(stripUnsupportedLabelText(cps(0x0628, 0x200c, 0x0915))).toBe(cps(0x0628, 0x0915));
    expect(stripUnsupportedLabelText(cps(0x0915, 0x200d, 0x0d15))).toBe(cps(0x0915, 0x0d15));
    // ARABIC-INDIC DIGIT ONE and DEVANAGARI DIGIT ONE are of the script, but not letters or marks
    expect(stripUnsupportedLabelText(cps(0x0661, 0x200c, 0x0628))).toBe(cps(0x0661, 0x0628));
    expect(stripUnsupportedLabelText(cps(0x0915, 0x200d, 0x0967))).toBe(cps(0x0915, 0x0967));
    // ARABIC COMMA, a sign of the script
    expect(stripUnsupportedLabelText(cps(0x0628, 0x200c, 0x060c))).toBe(cps(0x0628, 0x060c));
  });

  it('a joiner whose neighbour is itself removed (ARABIC LETTER MARK, MONGOLIAN VOWEL SEPARATOR) is removed with it', () => {
    expect(stripUnsupportedLabelText(cps(0x0628, 0x061c, 0x200c, 0x0628))).toBe(cps(0x0628, 0x0628));
    expect(stripUnsupportedLabelText(cps(0x78, 0x061c, 0x200c, 0x0628))).toBe(cps(0x78, 0x0628));
    expect(stripUnsupportedLabelText(cps(0x1820, 0x180e, 0x200d, 0x1821))).toBe(cps(0x1820, 0x1821));
  });

  it('every tag run but the three flags: hidden text after the black flag goes, and the black flag stays', () => {
    expect(stripUnsupportedLabelText(`${BLACK_FLAG}${tagged('admin is here')}${CANCEL_TAG}`)).toBe(BLACK_FLAG);
    expect(stripUnsupportedLabelText(flagOf('usca'))).toBe(BLACK_FLAG); // a valid-looking region that is not an emoji
    expect(stripUnsupportedLabelText(flagOf('gbenx'))).toBe(BLACK_FLAG);
    expect(stripUnsupportedLabelText(flagOf('gbengx'))).toBe(BLACK_FLAG);
    expect(stripUnsupportedLabelText(`Bob${TAG_A}`)).toBe('Bob');
    expect(stripUnsupportedLabelText(`Bob${CANCEL_TAG}`)).toBe('Bob');
    expect(stripUnsupportedLabelText(`${BLACK_FLAG}${tagged('gbeng')}`)).toBe(BLACK_FLAG); // never cancelled
    expect(stripUnsupportedLabelText(`${BLACK_FLAG}${VS16}${tagged('gbeng')}${CANCEL_TAG}`)).toBe(`${BLACK_FLAG}${VS16}`);
    expect(stripUnsupportedLabelText(`${cps(0x1f3f3)}${tagged('gbeng')}${CANCEL_TAG}`)).toBe(cps(0x1f3f3));
  });

  it('two role names can no longer differ only by hidden tag text', () => {
    expect(stripUnsupportedLabelText(`Mod ${BLACK_FLAG}${tagged('x')}${CANCEL_TAG}`)).toBe(stripUnsupportedLabelText(`Mod ${BLACK_FLAG}`));
  });

  it('an ideographic variation selector anywhere but directly after a Han character, and a second one', () => {
    expect(stripUnsupportedLabelText(cps(0x61, 0xe0100))).toBe('a'); // after a Latin letter
    expect(stripUnsupportedLabelText(cps(0x30ab, 0xe0100))).toBe(cps(0x30ab)); // after katakana, not Han
    expect(stripUnsupportedLabelText(cps(0x845b, 0xe0100, 0xe0101))).toBe(cps(0x845b, 0xe0100)); // one only
    expect(stripUnsupportedLabelText(cps(0x845b, 0x200b, 0xe0100))).toBe(cps(0x845b)); // not directly after
    expect(stripUnsupportedLabelText(cps(0xe0100, 0x845b))).toBe(cps(0x845b));
    // a mathematical variant (a symbol and VARIATION SELECTOR-1) and a Han character with VARIATION SELECTOR-1 stay removed
    expect(stripUnsupportedLabelText(cps(0x2229, 0xfe00))).toBe(cps(0x2229));
    expect(stripUnsupportedLabelText(cps(0x845b, 0xfe00))).toBe(cps(0x845b));
  });

  it('a joiner after a virama is kept only before a space or the end of the text', () => {
    const avan = cps(0x0d05, 0x0d35, 0x0d28, 0x0d4d, 0x200d);
    // before a space, a tab or a line break (which become one space)
    expect(stripUnsupportedLabelText(`${avan} x`)).toBe(`${avan} x`);
    expect(stripUnsupportedLabelText(`${avan}${TAB}${LF}x`)).toBe(`${avan} x`);
    expect(stripUnsupportedLabelText(cps(0x0915, 0x094d, 0x200c))).toBe(cps(0x0915, 0x094d, 0x200c)); // Devanagari, non-joiner at the end
    // after a virama but followed by a letter of another script, or by another removed character
    expect(stripUnsupportedLabelText(cps(0x0d28, 0x0d4d, 0x200d, 0x61))).toBe(cps(0x0d28, 0x0d4d, 0x61));
    expect(stripUnsupportedLabelText(cps(0x0d28, 0x0d4d, 0x200d, 0x0915))).toBe(cps(0x0d28, 0x0d4d, 0x0915));
    expect(stripUnsupportedLabelText(cps(0x0d28, 0x0d4d, 0x200d, 0x200b))).toBe(cps(0x0d28, 0x0d4d));
    // at the end, but after a letter (not a virama), or after a virama of no joiner script
    expect(stripUnsupportedLabelText(cps(0x0d28, 0x200d))).toBe(cps(0x0d28));
    expect(stripUnsupportedLabelText(`${cps(0x0d28, 0x200d)} x`)).toBe(`${cps(0x0d28)} x`);
    expect(stripUnsupportedLabelText(cps(0x0e01, 0x0e3a, 0x200d))).toBe(cps(0x0e01, 0x0e3a)); // Thai PHINTHU
    expect(stripUnsupportedLabelText(`a${ZWJ}`)).toBe('a');
    // two joiners after the virama: the first is not followed by a space, the second is not after a virama
    expect(stripUnsupportedLabelText(cps(0x0d28, 0x0d4d, 0x200d, 0x200d))).toBe(cps(0x0d28, 0x0d4d));
  });

  it('a variation selector outside an emoji presentation or keycap sequence', () => {
    expect(stripUnsupportedLabelText(`Al${VS16}ice`)).toBe('Alice');
    expect(stripUnsupportedLabelText(`Al${VS15}ice`)).toBe('Alice');
    expect(stripUnsupportedLabelText(`1${VS16}`)).toBe('1'); // a keycap base without the keycap
    expect(stripUnsupportedLabelText(`a${VS16}${KEYCAP}`)).toBe(`a${KEYCAP}`); // not a keycap base
    expect(stripUnsupportedLabelText(`${PARTY}${VS16}${VS16}`)).toBe(`${PARTY}${VS16}`); // only the first follows the pictograph
    expect(stripUnsupportedLabelText(`${VS16}Bob`)).toBe('Bob');
    // a Mongolian free variation selector after anything but a Mongolian letter
    expect(stripUnsupportedLabelText(`a${cps(0x180b)}b`)).toBe('ab');
  });

  it('direction overrides and the other zero-width and control characters', () => {
    expect(stripUnsupportedLabelText(`Ali${RLO}ce`)).toBe('Alice');
    expect(stripUnsupportedLabelText(`${ZWSP}Bob${BOM}${LRM}`)).toBe('Bob');
    expect(stripUnsupportedLabelText(`a${cps(0)}b${cps(7)}c`)).toBe('abc');
  });

  it('each run of line breaks and tabs becomes one space', () => {
    expect(stripUnsupportedLabelText(`Line${CR}${LF}${LF}two`)).toBe('Line two');
    expect(stripUnsupportedLabelText(`a${cps(0x2028)}b`)).toBe('a b');
    expect(stripUnsupportedLabelText(`a${TAB}b`)).toBe('a b');
    expect(stripUnsupportedLabelText(`a${TAB}${LF}${TAB}b`)).toBe('a b');
  });

  it('every character that renders as nothing, so a name made only of them (doubled, too) is empty and refused as such', () => {
    for (const blank of BLANK) {
      expect(stripUnsupportedLabelText(`Bo${blank}b`), blank.codePointAt(0)!.toString(16)).toBe('Bob');
      expect(stripUnsupportedLabelText(`${blank}${blank}`)).toBe('');
      expect(validateDisplayName(stripUnsupportedLabelText(`${blank}${blank}`).trim())).toBe('Display name cannot be empty');
    }
    expect(stripUnsupportedLabelText(BLANK.join(''))).toBe('');
  });

  it('every default-ignorable code point outside the exceptions, all 4,000 and more of them', () => {
    let checked = 0;
    for (const [from, to] of DEFAULT_IGNORABLE_FALLBACK_RANGES) {
      for (let cp = from; cp <= to; cp++) {
        expect(stripUnsupportedLabelText(`a${cps(cp)}b`), cp.toString(16)).toBe('ab');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  it('every occurrence goes, not only the first', () => {
    expect(stripUnsupportedLabelText(`${ZWSP}a${ZWSP}b${ZWSP}`)).toBe('ab');
  });
});

describe('the explicit default-ignorable list (the fallback) holds every code point the property does', () => {
  it('equals \\p{Default_Ignorable_Code_Point} on this engine', () => {
    const property = /^\p{Default_Ignorable_Code_Point}$/u;
    const listed = (cp: number) => DEFAULT_IGNORABLE_FALLBACK_RANGES.some(([from, to]) => cp >= from && cp <= to);
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (property.test(cps(cp)) !== listed(cp)) throw new Error(`U+${cp.toString(16)} differs`);
    }
  });
});

// A seeded mix of the characters every rule turns on, joined at random
const ALPHABET = [
  'a', 'B', '1', '#', ' ', PARTY, cps(0x1f468), cps(0x1f469), cps(0x1f3f3), BLACK_FLAG, cps(0x2620), cps(0x00a9), cps(0x2764),
  VS15, VS16, cps(0x1f3fd), ZWJ, ZWNJ, ZWSP, RLO, LRM, BOM, LF, CR, TAB, cps(0x2029), KEYCAP,
  ...Array.from('gbenscwlt', (c) => cps(0xe0000 + c.charCodeAt(0))), TAG_A, CANCEL_TAG, cps(0xe0001),
  cps(0x0628), cps(0x06cc), cps(0x0661), cps(0x060c), cps(0x061c), cps(0x1820), cps(0x180e), cps(0x180b),
  cps(0x0dca), cps(0x0dbb), cps(0x094d), cps(0x0915), cps(0x0d4d), cps(0x0d37), cps(0x0967),
  cps(0x0d28), cps(0x0d05), cps(0x0e3a), cps(0x845b), cps(0x8fbb), cps(0x30ab), cps(0x2229), cps(0xe0100), cps(0xe0101), cps(0xe01ef),
  ...BLANK,
];
function seeded(count: number, seed: number): string[] {
  let state = seed;
  const next = () => { state = (state * 1103515245 + 12345) % 0x80000000; return state; };
  const inputs: string[] = [];
  for (let n = 0; n < count; n++) {
    let input = '';
    const length = next() % 14;
    for (let k = 0; k < length; k++) input += ALPHABET[next() % ALPHABET.length];
    inputs.push(input);
  }
  return inputs;
}

describe('hasUnsupportedLabelText is exactly "the stripper would change it"', () => {
  it('flags every kind the stripper removes', () => {
    for (const bad of [RLO, ZWSP, ZWJ, ZWNJ, LRM, BOM, TAG_A, CANCEL_TAG, VS16, LF, CR, TAB, cps(0x2028), cps(0x85), cps(0), ...BLANK]) {
      expect(hasUnsupportedLabelText(`Ali${bad}ce`)).toBe(true);
    }
  });

  it('a stripped label strips to itself and is never flagged, whatever went in', () => {
    for (const input of seeded(5000, 0x2f6b1)) {
      const once = stripUnsupportedLabelText(input);
      expect(stripUnsupportedLabelText(once), JSON.stringify(input)).toBe(once);
      expect(hasUnsupportedLabelText(once), JSON.stringify(input)).toBe(false);
    }
    for (const [, sequence] of KEPT) expect(hasUnsupportedLabelText(stripUnsupportedLabelText(`${RLO}${sequence}${ZWSP}`))).toBe(false);
  });

  it('is linear: a long label of the costliest shapes strips in proportion to its length', () => {
    const unit = `${cps(0x1f468)}${VS16.repeat(40)}${ZWJ}${BLACK_FLAG}${tagged('gbeng')}${cps(0x0628, 0x200c, 0x0628)}`;
    const small = unit.repeat(200);
    const large = unit.repeat(2000);
    const time = (s: string) => { const t = performance.now(); stripUnsupportedLabelText(s); return performance.now() - t; };
    time(small);
    expect(time(large)).toBeLessThan(Math.max(time(small) * 40, 250));
  });
});

describe('every label validator applies the same rule (#148)', () => {
  const cases: Array<[string, (s: string) => string | null, string]> = [
    ['validateDisplayName', validateDisplayName, 'Display name contains unsupported characters'],
    ['validateNickname', validateNickname, 'Nickname contains unsupported characters'],
    ['validateRoleName', validateRoleName, 'Role name contains unsupported characters'],
    ['validateCategoryName', validateCategoryName, 'Category name contains unsupported characters'],
    ['validateServerName', validateServerName, 'Server name contains unsupported characters'],
    ['validateWebhookName', validateWebhookName, 'Webhook name contains unsupported characters'],
  ];
  for (const [name, validate, refused] of cases) {
    it(`${name}: a direction override, a stray joiner or selector, a zero-width space, a tag, a filler and a line break are refused`, () => {
      expect(validate(`Ali${RLO}ce`)).toBe(refused);
      expect(validate(`Al${ZWJ}ice`)).toBe(refused);
      expect(validate(`Al${VS16}ice`)).toBe(refused);
      expect(validate(`Al${ZWSP}ice`)).toBe(refused);
      expect(validate(`Alice${LF}Admin`)).toBe(refused);
      expect(validate(`Alice${TAG_A}`)).toBe(refused);
      expect(validate(`Ali${cps(0x3164)}ce`)).toBe(refused);
      expect(validate(`Ali${cps(0x17b4)}ce`)).toBe(refused);
    });

    it(`${name}: an ordinary name, and every kept sequence, passes`, () => {
      expect(validate('Élodie 🎉')).toBeNull();
      for (const [, sequence] of KEPT) expect(validate(`Al ${sequence}`), sequence).toBeNull();
    });
  }

  it('the length and emptiness rules still come first', () => {
    expect(validateDisplayName('  ')).toBe('Display name cannot be empty');
    expect(validateNickname('')).toBe('Nickname cannot be empty');
    expect(validateRoleName('')).toBe(`Role name must be at least ${LIMITS.ROLE_NAME_MIN} character`);
    expect(validateCategoryName('x'.repeat(LIMITS.CATEGORY_NAME_MAX + 1))).toBe(`Category name must be at most ${LIMITS.CATEGORY_NAME_MAX} characters`);
  });
});

describe('stripUnsupportedLabelText on an engine without Unicode property escapes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function fallbackShared() {
    vi.resetModules();
    const RealRegExp = RegExp;
    vi.stubGlobal('RegExp', function FakeRegExp(pattern: string | RegExp, flags?: string) {
      if (String(pattern).includes('\\p{')) throw new SyntaxError('Invalid property name');
      return new RealRegExp(pattern, flags);
    });
    return import('@voxium/shared');
  }

  it('keeps no joiner and no selector that needs a property, removes every listed ignorable, and never throws', async () => {
    const shared = await fallbackShared();
    expect(shared.stripUnsupportedLabelText(KEPT[0][1])).toBe(cps(0x1f468, 0x1f469, 0x1f467));
    expect(shared.stripUnsupportedLabelText(cps(0x2764, 0xfe0f))).toBe(cps(0x2764));
    expect(shared.stripUnsupportedLabelText(KEPT[13][1])).toBe(cps(0x0645, 0x06cc, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645));
    for (const blank of BLANK) expect(shared.stripUnsupportedLabelText(`${blank}${blank}`)).toBe('');
    // what needs no property test is unchanged
    expect(shared.stripUnsupportedLabelText(`Ali${RLO}ce`)).toBe('Alice');
    expect(shared.stripUnsupportedLabelText(flagOf('gbeng'))).toBe(flagOf('gbeng'));
    expect(shared.stripUnsupportedLabelText(cps(0x31, 0xfe0f, 0x20e3))).toBe(cps(0x31, 0xfe0f, 0x20e3));
    // no ideographic selector without the Han property
    expect(shared.stripUnsupportedLabelText(cps(0x845b, 0xe0100))).toBe(cps(0x845b));
  });

  it('removes at least what the full rule removes: the full rule changes nothing the fallback kept', async () => {
    const full = stripUnsupportedLabelText;
    const fallback = (await fallbackShared()).stripUnsupportedLabelText;
    for (const input of seeded(5000, 0x51a7e)) {
      const kept = fallback(input);
      expect(full(kept), JSON.stringify(input)).toBe(kept);
    }
  });
});
