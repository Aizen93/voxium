import { describe, it, expect } from 'vitest';
import { aggregateReactions } from '../../utils/reactions';

describe('aggregateReactions', () => {
  it('groups reactions by emoji with correct counts and userIds', () => {
    const raw = [
      { emoji: '👍', userId: 'user1' },
      { emoji: '👍', userId: 'user2' },
      { emoji: '❤️', userId: 'user1' },
    ];
    const result = aggregateReactions(raw);

    expect(result).toHaveLength(2);

    const thumbsUp = result.find((r) => r.emoji === '👍');
    expect(thumbsUp).toBeDefined();
    expect(thumbsUp!.count).toBe(2);
    expect(thumbsUp!.userIds).toEqual(['user1', 'user2']);

    const heart = result.find((r) => r.emoji === '❤️');
    expect(heart).toBeDefined();
    expect(heart!.count).toBe(1);
    expect(heart!.userIds).toEqual(['user1']);
  });

  it('handles empty array', () => {
    const result = aggregateReactions([]);
    expect(result).toEqual([]);
  });

  it('returns objects with emoji, count, and userIds properties', () => {
    const raw = [{ emoji: '🎉', userId: 'u1' }];
    const result = aggregateReactions(raw);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('emoji', '🎉');
    expect(result[0]).toHaveProperty('count', 1);
    expect(result[0]).toHaveProperty('userIds');
    expect(Array.isArray(result[0].userIds)).toBe(true);
  });

  it('preserves insertion order of emojis', () => {
    const raw = [
      { emoji: '🔥', userId: 'u1' },
      { emoji: '👀', userId: 'u2' },
      { emoji: '🔥', userId: 'u3' },
    ];
    const result = aggregateReactions(raw);

    expect(result[0].emoji).toBe('🔥');
    expect(result[1].emoji).toBe('👀');
  });

  it('handles a single reaction', () => {
    const raw = [{ emoji: '😊', userId: 'onlyUser' }];
    const result = aggregateReactions(raw);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ emoji: '😊', count: 1, userIds: ['onlyUser'] });
  });

  it('handles many different emojis', () => {
    const emojis = ['👍', '👎', '❤️', '🎉', '😂'];
    const raw = emojis.map((emoji, i) => ({ emoji, userId: `user${i}` }));
    const result = aggregateReactions(raw);

    expect(result).toHaveLength(5);
    result.forEach((group) => {
      expect(group.count).toBe(1);
      expect(group.userIds).toHaveLength(1);
    });
  });

  it('accumulates multiple users for the same emoji', () => {
    const raw = [
      { emoji: '💯', userId: 'a' },
      { emoji: '💯', userId: 'b' },
      { emoji: '💯', userId: 'c' },
    ];
    const result = aggregateReactions(raw);

    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
    expect(result[0].userIds).toEqual(['a', 'b', 'c']);
  });
});
