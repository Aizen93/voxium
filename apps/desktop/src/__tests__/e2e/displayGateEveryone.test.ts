// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withoutServerAssertions } from '../../services/e2e/displayGate';
import type { Message } from '@voxium/shared';

/**
 * `mentionsEveryone` is the server's word that the author held MENTION_EVERYONE
 * and wrote `@everyone`. The server never reads ciphertext, so on an encrypted
 * row the flag can only be the server deciding that an authentic message pings
 * everyone — a badge, the mention sound, a "mentioned everyone" notification.
 * The gate strips it like every other server assertion about a row it cannot
 * have read.
 */

const row = (over: Partial<Message> = {}): Message => ({
  id: 'm-1',
  content: 'ciphertext',
  encrypted: true,
  type: 'user',
  channelId: null,
  conversationId: 'c-1',
  author: { id: 'u-1', username: 'alice', displayName: 'Alice', avatarUrl: null },
  createdAt: '2026-10-24T00:00:00.000Z',
  editedAt: null,
  reactions: [],
  ...over,
} as unknown as Message);

describe('withoutServerAssertions — mentionsEveryone', () => {
  it('drops the flag from an encrypted row, true or false', () => {
    for (const value of [true, false]) {
      const cleaned = withoutServerAssertions(row({ mentionsEveryone: value }));
      expect('mentionsEveryone' in cleaned).toBe(false);
      expect(cleaned.content).toBe('ciphertext');
    }
  });

  it('leaves a row that carries no server assertion untouched (same object)', () => {
    const plain = row();
    expect(withoutServerAssertions(plain)).toBe(plain);
  });

  it('strips it together with the other assertions, keeping the rest of the row', () => {
    const cleaned = withoutServerAssertions(row({ mentionsEveryone: true, webhookName: 'bot', mentions: [{ id: 'u-2', username: 'bob', displayName: 'Bob', avatarUrl: null }] }));
    expect(cleaned.mentionsEveryone).toBeUndefined();
    expect(cleaned.webhookName).toBeUndefined();
    expect(cleaned.mentions).toEqual([]);
    expect(cleaned.id).toBe('m-1');
  });
});
