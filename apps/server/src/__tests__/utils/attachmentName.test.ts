import { describe, it, expect } from 'vitest';
import { LIMITS, hasUnsupportedLabelText } from '@voxium/shared';
import { storedAttachmentName, ATTACHMENT_NAME_FALLBACK } from '../../utils/attachmentName';

const MAX = LIMITS.ATTACHMENT_NAME_MAX;
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const SMILE = String.fromCodePoint(0x1f600); // two UTF-16 code units

describe('storedAttachmentName (#158)', () => {
  it('keeps an ordinary name as it is', () => {
    expect(storedAttachmentName('report-2026 (final).pdf')).toBe('report-2026 (final).pdf');
    expect(storedAttachmentName('Élodie 🎉.png')).toBe('Élodie 🎉.png');
  });

  it('removes control, bidi-override and zero-width characters, and puts the name on one line', () => {
    expect(storedAttachmentName(`invoice${RLO}fdp.exe`)).toBe('invoicefdp.exe');
    expect(storedAttachmentName(`a${ZWSP}b${String.fromCharCode(0)}c${String.fromCharCode(7)}.txt`)).toBe('abc.txt');
    expect(storedAttachmentName(`two\r\nlines.txt`)).toBe('two lines.txt');
  });

  it('passes through sanitizeText (HTML tags removed, trimmed)', () => {
    expect(storedAttachmentName('  <b>bold</b>.txt  ')).toBe('bold.txt');
  });

  it('cuts an over-long name to the cap and keeps its extension (the client saves the download under it)', () => {
    const name = `${'a'.repeat(400)}.pdf`;
    const stored = storedAttachmentName(name);
    expect(stored).toHaveLength(MAX);
    expect(stored.endsWith('.pdf')).toBe(true);
    expect(stored).toBe(`${'a'.repeat(MAX - 4)}.pdf`);
  });

  it('cuts an over-long name without an extension at the cap', () => {
    expect(storedAttachmentName('b'.repeat(1000))).toBe('b'.repeat(MAX));
  });

  it('a name exactly at the cap is kept whole; one over it is cut', () => {
    expect(storedAttachmentName('c'.repeat(MAX))).toHaveLength(MAX);
    expect(storedAttachmentName(`${'c'.repeat(MAX - 4)}.txt`)).toBe(`${'c'.repeat(MAX - 4)}.txt`);
    expect(storedAttachmentName(`${'c'.repeat(MAX - 3)}.txt`)).toBe(`${'c'.repeat(MAX - 4)}.txt`);
  });

  it('never splits a surrogate pair at the cut', () => {
    // The stem's cut point (MAX - 4 code units) falls between the two halves of the emoji
    const name = `${'d'.repeat(MAX - 5)}${SMILE}${'e'.repeat(50)}.pdf`;
    const stored = storedAttachmentName(name);
    expect(stored).toBe(`${'d'.repeat(MAX - 5)}.pdf`);
    expect(stored.length).toBeLessThanOrEqual(MAX);
    // no lone surrogate anywhere
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(stored)).toBe(false);
  });

  it('keeps a joined emoji, and a cut that ends on its joiner leaves no stray joiner', () => {
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(storedAttachmentName(`${family} holiday.jpg`)).toBe(`${family} holiday.jpg`);
    // the stem's cut (MAX - 4) lands right after the first joiner
    const stored = storedAttachmentName(`${'a'.repeat(MAX - 7)}${family}${'z'.repeat(50)}.pdf`);
    expect(stored).toBe(`${'a'.repeat(MAX - 7)}${String.fromCodePoint(0x1f468)}.pdf`);
    expect(hasUnsupportedLabelText(stored)).toBe(false);
  });

  it('a cut inside a subdivision flag leaves none of its tag characters', () => {
    const england = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
    // the cut falls after the black flag and two of its tags
    const stored = storedAttachmentName(`${'a'.repeat(MAX - 4 - 6)}${england}${'z'.repeat(50)}.pdf`);
    expect(stored).toBe(`${'a'.repeat(MAX - 4 - 6)}${String.fromCodePoint(0x1f3f4)}.pdf`);
    expect(hasUnsupportedLabelText(stored)).toBe(false);
  });

  it('treats a trailing segment that is too long, or holds a space, as part of the name, not as an extension', () => {
    const longTail = `${'f'.repeat(300)}.${'g'.repeat(40)}`;
    expect(storedAttachmentName(longTail)).toBe(longTail.slice(0, MAX));
    const spaced = `${'h'.repeat(300)}.not an extension`;
    expect(storedAttachmentName(spaced)).toBe(spaced.slice(0, MAX));
  });

  it('a name that comes out empty is stored as a fixed name', () => {
    expect(storedAttachmentName(`${ZWSP}${RLO}`)).toBe(ATTACHMENT_NAME_FALLBACK);
    expect(storedAttachmentName('   ')).toBe(ATTACHMENT_NAME_FALLBACK);
    expect(storedAttachmentName('<b></b>')).toBe(ATTACHMENT_NAME_FALLBACK);
  });
});
