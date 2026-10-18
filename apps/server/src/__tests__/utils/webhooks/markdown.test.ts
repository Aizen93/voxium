import { describe, it, expect } from 'vitest';
import {
  collapseLineBreaks,
  escapeLinkDestination,
  escapeMarkdown,
  safeHttpUrl,
} from '../../../utils/webhooks/markdown';

const BS = String.fromCharCode(0x5c); // a single backslash, spelled out
const chr = (cp: number) => String.fromCharCode(cp);

describe('escapeMarkdown', () => {
  it.each(['\\', '*', '_', '~', '`', '[', ']', '(', ')', '#', '>', '|'])('backslash-escapes %s', (ch) => {
    expect(escapeMarkdown(`a${ch}b`)).toBe(`a${BS}${ch}b`);
  });

  it('escapes the backslash itself exactly once (no double processing)', () => {
    expect(escapeMarkdown(`${BS}*`)).toBe(`${BS}${BS}${BS}*`);
  });

  it('leaves ordinary text and other punctuation alone', () => {
    expect(escapeMarkdown('Build 42 passed: ok! (no) - yes.')).toBe(`Build 42 passed: ok! ${BS}(no${BS}) - yes.`);
    expect(escapeMarkdown('plain words, 100% fine & dandy')).toBe('plain words, 100% fine & dandy');
  });

  it('a title containing ](https://evil) cannot close a link early', () => {
    const escaped = escapeMarkdown('Click](https://evil.example)');
    expect(escaped).toBe(`Click${BS}]${BS}(https://evil.example${BS})`);
    // Inside a link, every bracket/paren the sender wrote is escaped: the only
    // unescaped "](" left is the one the formatter adds
    const link = `[${escaped}](https://good.example)`;
    const unescapedCloses = link.match(/(?<!\\)\]\(/g) ?? [];
    expect(unescapedCloses).toHaveLength(1);
  });

  it('collapses CR, LF and CRLF runs into one space', () => {
    expect(escapeMarkdown('line one\nline two')).toBe('line one line two');
    expect(escapeMarkdown('a\r\nb')).toBe('a b');
    expect(escapeMarkdown('a\rb')).toBe('a b');
    expect(escapeMarkdown('a\n\n\r\nb')).toBe('a b');
  });

  it('collapses the other line separators too (VT, FF, NEL, U+2028, U+2029)', () => {
    for (const cp of [0x0b, 0x0c, 0x85, 0x2028, 0x2029]) {
      expect(escapeMarkdown(`a${chr(cp)}b`)).toBe('a b');
    }
  });

  it('a newline cannot start a new markdown block (heading, quote, list)', () => {
    const escaped = escapeMarkdown('title\n# heading\n> quote');
    expect(escaped).not.toMatch(/[\r\n]/);
    expect(escaped).toBe(`title ${BS}# heading ${BS}> quote`);
  });
});

describe('collapseLineBreaks', () => {
  it('turns each run of line breaks into one space and leaves the rest', () => {
    expect(collapseLineBreaks(`a\r\n\nb${chr(0x2028)}c`)).toBe('a b c');
    expect(collapseLineBreaks('no breaks *here*')).toBe('no breaks *here*');
  });
});

describe('safeHttpUrl', () => {
  it('accepts https and http URLs (normalised href)', () => {
    expect(safeHttpUrl('https://ci.example.com/42')).toBe('https://ci.example.com/42');
    expect(safeHttpUrl('http://status.example.org/page?x=1#y')).toBe('http://status.example.org/page?x=1#y');
    expect(safeHttpUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });

  it('rejects javascript: and data: URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects other schemes', () => {
    expect(safeHttpUrl('ftp://example.com/file')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(safeHttpUrl('mailto:someone@example.com')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox')).toBeNull();
  });

  it('rejects garbage, relative paths and non-strings', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('/relative/path')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
    expect(safeHttpUrl({ href: 'https://example.com' })).toBeNull();
  });

  it('normalises away newlines, spaces and angle brackets (they cannot reach a link destination)', () => {
    const href = safeHttpUrl('https://example.com/a\nb c<d>');
    expect(href).toBe('https://example.com/ab%20c%3Cd%3E');
  });
});

describe('escapeLinkDestination', () => {
  it('escapes parentheses and backslashes so a ) in the URL cannot end the destination', () => {
    expect(escapeLinkDestination('https://en.example.org/wiki/Foo_(bar)')).toBe(`https://en.example.org/wiki/Foo_${BS}(bar${BS})`);
    expect(escapeLinkDestination(`https://example.com/?q=${BS}`)).toBe(`https://example.com/?q=${BS}${BS}`);
  });

  it('an injected second link stays inside the first destination', () => {
    const href = safeHttpUrl('https://good.example/x)[click](javascript:alert(1)')!;
    const dest = escapeLinkDestination(href);
    expect(dest.match(/(?<!\\)[()]/g)).toBeNull();
  });

  it('leaves an ordinary URL unchanged', () => {
    expect(escapeLinkDestination('https://ci.example.com/42?a=1&b=2#c')).toBe('https://ci.example.com/42?a=1&b=2#c');
  });
});
