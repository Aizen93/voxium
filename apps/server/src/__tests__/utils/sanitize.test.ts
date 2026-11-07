import { describe, it, expect } from 'vitest';
import { sanitizeText, stripHtml } from '../../utils/sanitize';

describe('stripHtml', () => {
  it('removes simple HTML tags', () => {
    expect(stripHtml('<b>bold</b>')).toBe('bold');
  });

  it('removes self-closing tags', () => {
    expect(stripHtml('line<br/>break')).toBe('linebreak');
  });

  it('removes nested tags', () => {
    expect(stripHtml('<div><span>text</span></div>')).toBe('text');
  });

  it('returns plain text unchanged', () => {
    expect(stripHtml('no tags here')).toBe('no tags here');
  });
});

describe('stripHtml — identical to the old /<[^>]*>/g replace, in linear time', () => {
  // The regex the linear scan replaced: the reference for every expectation
  const oldStripHtml = (str: string) => str.replace(/<[^>]*>/g, '');

  it.each([
    ['plain text', 'hello world', 'hello world'],
    ['one tag', 'a <b>bold</b> c', 'a bold c'],
    ['nested angle brackets', '<<a>>', '>'],
    ['an unclosed tag', 'text <abc', 'text <abc'],
    ['a comparison', 'a < b > c', 'a  c'],
    ['a < at the end', 'value <', 'value <'],
    ['a > before the <', 'x > y <z> w', 'x > y  w'],
    ['multiple tags', '<p>one</p><br/><i>two</i>', 'onetwo'],
    ['a closed tag then an unclosed one', '<b>x</b> and <tail', 'x and <tail'],
    ['several < before one >', 'a<b<c>d', 'ad'],
    ['only a <', '<', '<'],
    ['only a >', '>', '>'],
    ['an empty tag', 'a<>b', 'ab'],
    ['empty', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(stripHtml(input)).toBe(expected);
    expect(stripHtml(input)).toBe(oldStripHtml(input));
  });

  it('matches the old regex on every short string over < > a and space', () => {
    const alphabet = ['<', '>', 'a', ' '];
    const strings = [''];
    for (let len = 1; len <= 7; len++) {
      const previous = strings.filter((s) => s.length === len - 1);
      for (const s of previous) for (const ch of alphabet) strings.push(s + ch);
    }
    for (const s of strings) {
      expect(stripHtml(s)).toBe(oldStripHtml(s));
    }
  });

  it('strips nothing from a non-string through sanitizeText (coerced to empty)', () => {
    for (const value of [null, undefined, 42, {}, ['<b>x</b>']]) {
      expect(sanitizeText(value)).toBe('');
    }
  });

  // 64 KiB, not the 1 MiB a webhook body may carry: the old backtracking regex
  // is quadratic, so it takes over a second here (failing the bound) where
  // 1 MiB would hang a regressed run for ~7 minutes before failing
  it('a 64 KiB run of < completes in well under 200 ms (the old regex took over a second)', () => {
    const input = '<'.repeat(65_536);

    const start = performance.now();
    const result = stripHtml(input);
    const elapsed = performance.now() - start;

    expect(result).toBe(input);
    expect(elapsed).toBeLessThan(200);
  });

  it('a 64 KiB run of < through sanitizeText is just as fast', () => {
    const input = `x${'<'.repeat(65_536)}`;

    const start = performance.now();
    const result = sanitizeText(input);
    const elapsed = performance.now() - start;

    expect(result).toBe(input);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('sanitizeText', () => {
  it('strips HTML tags from input', () => {
    expect(sanitizeText('<script>alert("xss")</script>')).toBe('alert("xss")');
    expect(sanitizeText('Hello <b>world</b>')).toBe('Hello world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
    expect(sanitizeText('\n\ttabs and newlines\t\n')).toBe('tabs and newlines');
  });

  it('strips tags AND trims in one pass', () => {
    expect(sanitizeText('  <p>paragraph</p>  ')).toBe('paragraph');
  });

  it('returns empty string for null', () => {
    expect(sanitizeText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(sanitizeText(undefined)).toBe('');
  });

  it('returns empty string for a number', () => {
    expect(sanitizeText(42)).toBe('');
  });

  it('returns empty string for a boolean', () => {
    expect(sanitizeText(true)).toBe('');
  });

  it('returns empty string for an object', () => {
    expect(sanitizeText({ key: 'value' })).toBe('');
  });

  it('preserves @[userId] mention syntax (square brackets survive)', () => {
    const content = 'Hey @[abc123] check this out';
    expect(sanitizeText(content)).toBe('Hey @[abc123] check this out');
  });

  it('preserves multiple mentions', () => {
    const content = '@[user1] and @[user2] are here';
    expect(sanitizeText(content)).toBe('@[user1] and @[user2] are here');
  });

  it('strips angle-bracket mentions but keeps square-bracket mentions', () => {
    // <@userId> would be stripped by HTML tag removal, but @[userId] survives
    const content = '<@badMention> and @[goodMention]';
    expect(sanitizeText(content)).toBe('and @[goodMention]');
  });

  it('handles empty string input', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(sanitizeText('   ')).toBe('');
  });
});

describe('sanitizeText — U+0000', () => {
  const NUL = String.fromCharCode(0);

  it('drops NUL bytes (PostgreSQL refuses them in text: the insert would be a 500)', () => {
    expect(sanitizeText(`a${NUL}b`)).toBe('ab');
    expect(sanitizeText(`${NUL}${NUL}`)).toBe('');
    expect(sanitizeText(`<b>${NUL}</b> x `)).toBe('x');
  });

  it('stripHtml itself leaves NUL alone (it strips tags only)', () => {
    expect(stripHtml(`a${NUL}b`)).toBe(`a${NUL}b`);
  });
});
