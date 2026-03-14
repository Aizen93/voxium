import { describe, it, expect } from 'vitest';
import { extractMentionIds } from '../../utils/mentions';

describe('extractMentionIds', () => {
  it('extracts a single mention', () => {
    const result = extractMentionIds('Hello @[user123]');
    expect(result).toEqual(['user123']);
  });

  it('extracts multiple mentions', () => {
    const result = extractMentionIds('@[aaa] said hi to @[bbb] and @[ccc]');
    expect(result).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('deduplicates repeated user IDs', () => {
    const result = extractMentionIds('@[same] hello @[same] again');
    expect(result).toEqual(['same']);
  });

  it('returns empty array for no mentions', () => {
    expect(extractMentionIds('no mentions here')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractMentionIds('')).toEqual([]);
  });

  it('caps at MAX_MENTIONS_PER_MESSAGE (10)', () => {
    // Build a message with 15 unique mentions
    const mentions = Array.from({ length: 15 }, (_, i) => `@[user${i}]`).join(' ');
    const result = extractMentionIds(mentions);
    expect(result).toHaveLength(10);
  });

  it('does not match angle-bracket mentions like <@userId>', () => {
    const result = extractMentionIds('Hey <@badformat>');
    expect(result).toEqual([]);
  });

  it('does not match incomplete bracket syntax', () => {
    expect(extractMentionIds('@[unclosed')).toEqual([]);
    expect(extractMentionIds('@unopened]')).toEqual([]);
  });

  it('calling twice in a row returns consistent results (no global regex lastIndex bug)', () => {
    const content = '@[abc] and @[def]';
    const first = extractMentionIds(content);
    const second = extractMentionIds(content);
    expect(first).toEqual(second);
    expect(first).toEqual(['abc', 'def']);
  });

  it('handles mentions embedded in longer text', () => {
    const content = 'Start @[id1] middle text @[id2] end';
    expect(extractMentionIds(content)).toEqual(['id1', 'id2']);
  });

  it('handles mention at start and end of string', () => {
    expect(extractMentionIds('@[first]')).toEqual(['first']);
    expect(extractMentionIds('text @[last]')).toEqual(['last']);
  });
});
