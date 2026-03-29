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

  it('preserves custom emoji tokens <:name:id>', () => {
    const content = 'Check this <:pepe_laugh:clxyz123abc> out!';
    expect(sanitizeText(content)).toBe('Check this <:pepe_laugh:clxyz123abc> out!');
  });

  it('preserves multiple custom emoji tokens', () => {
    const content = '<:emoji1:abcdefghij> and <:emoji2:klmnopqrst>';
    expect(sanitizeText(content)).toBe('<:emoji1:abcdefghij> and <:emoji2:klmnopqrst>');
  });

  it('strips HTML tags but preserves custom emojis in the same string', () => {
    const content = '<b>bold</b> <:pepe:abcdef1234> <script>xss</script>';
    expect(sanitizeText(content)).toBe('bold <:pepe:abcdef1234> xss');
  });

  it('does not preserve malformed custom emoji tokens', () => {
    // Missing colon or wrong format — should be stripped as HTML
    expect(sanitizeText('<:short:ab>')).toBe(''); // id too short (< 10 chars)
    expect(sanitizeText('<notEmoji>')).toBe('');
  });

  it('preserves custom emojis alongside mentions', () => {
    const content = '@[user123] sent <:wave:abcdefghij>';
    expect(sanitizeText(content)).toBe('@[user123] sent <:wave:abcdefghij>');
  });
});
