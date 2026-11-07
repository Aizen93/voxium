import { describe, it, expect } from 'vitest';
import type { Message, MessageAuthor } from '@voxium/shared';
import { startsMessageGroup, MESSAGE_GROUP_WINDOW_MS } from '../../utils/messageGrouping';

/**
 * The server channel list folds consecutive posts of one author under one
 * header. A webhook's id does not say who posted: one webhook may post under
 * a different name per message, and every deleted webhook shares the id
 * `webhook:deleted` — so for webhooks the name is part of the key.
 */

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const alice: MessageAuthor = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: MessageAuthor = { id: 'u-bob', username: 'bob', displayName: 'Bob', avatarUrl: null };
const hook = (id: string, name: string): MessageAuthor => ({ id, username: name, displayName: name, avatarUrl: null, isWebhook: true });

type Row = Pick<Message, 'author' | 'createdAt' | 'replyToId'>;
const row = (author: MessageAuthor, offsetMs = 0, replyToId: string | null = null): Row => ({ author, createdAt: at(offsetMs), replyToId });

describe('startsMessageGroup', () => {
  it('the first message always starts a group', () => {
    expect(startsMessageGroup(undefined, row(alice))).toBe(true);
  });

  describe('webhook authors', () => {
    it('same webhook, same name, within 5 minutes → grouped', () => {
      expect(startsMessageGroup(row(hook('webhook:w1', 'CI')), row(hook('webhook:w1', 'CI'), 60_000))).toBe(false);
    });

    it('same webhook id, different per-message names → a new header', () => {
      expect(startsMessageGroup(row(hook('webhook:w1', 'CI')), row(hook('webhook:w1', 'Deploy'), 1_000))).toBe(true);
    });

    it('two deleted webhooks (the shared webhook:deleted id) under different names → a new header', () => {
      expect(startsMessageGroup(row(hook('webhook:deleted', 'Old CI')), row(hook('webhook:deleted', 'Old alerts'), 1_000))).toBe(true);
    });

    it('two deleted webhook posts under the same name → grouped', () => {
      expect(startsMessageGroup(row(hook('webhook:deleted', 'Old CI')), row(hook('webhook:deleted', 'Old CI'), 1_000))).toBe(false);
    });

    it('different webhooks → a new header, whatever the names', () => {
      expect(startsMessageGroup(row(hook('webhook:w1', 'CI')), row(hook('webhook:w2', 'CI'), 1_000))).toBe(true);
    });

    it('same webhook and name past the 5-minute window → a new header', () => {
      expect(startsMessageGroup(row(hook('webhook:w1', 'CI')), row(hook('webhook:w1', 'CI'), MESSAGE_GROUP_WINDOW_MS + 1))).toBe(true);
    });

    it('a webhook followed by a human (and back) → a new header each time', () => {
      expect(startsMessageGroup(row(hook('webhook:w1', 'CI')), row(alice, 1_000))).toBe(true);
      expect(startsMessageGroup(row(alice), row(hook('webhook:w1', 'CI'), 1_000))).toBe(true);
    });
  });

  describe('humans (unchanged)', () => {
    it('same author within 5 minutes → grouped', () => {
      expect(startsMessageGroup(row(alice), row(alice, MESSAGE_GROUP_WINDOW_MS))).toBe(false);
    });

    it('same author whose display name changed between posts → still grouped (the id is the key)', () => {
      expect(startsMessageGroup(row(alice), row({ ...alice, displayName: 'Alice B.' }, 1_000))).toBe(false);
    });

    it('a different author → a new header', () => {
      expect(startsMessageGroup(row(alice), row(bob, 1_000))).toBe(true);
    });

    it('past 5 minutes → a new header', () => {
      expect(startsMessageGroup(row(alice), row(alice, MESSAGE_GROUP_WINDOW_MS + 1))).toBe(true);
    });

    it('a reply always shows its header', () => {
      expect(startsMessageGroup(row(alice), row(alice, 1_000, 'm-parent'))).toBe(true);
    });
  });
});
