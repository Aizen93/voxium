import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockServerMemberFindMany = vi.fn();
vi.mock('../../utils/prisma', () => ({
  prisma: {
    serverMember: { findMany: (...args: unknown[]) => mockServerMemberFindMany(...args) },
  },
}));

import { extractMentionIds, batchResolveMentions, attachMentions } from '../../utils/mentions';

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

// ─── Webhook rows never resolve mentions ────────────────────────────────────
// An unauthenticated webhook URL must never ping anyone: the live event says
// "no mentions" for a webhook row, and a refetch must agree.

const user2 = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null };
const user3 = { id: 'user-3', username: 'carol', displayName: 'Carol', avatarUrl: null };

describe('batchResolveMentions / attachMentions — webhook rows', () => {
  beforeEach(() => {
    mockServerMemberFindMany.mockReset();
  });

  it('never queries members for a page made only of webhook rows, even with @[id] tokens in them', async () => {
    const rows = [
      { content: 'ping @[user-2]', webhookId: 'wh-1' },
      { content: '@[user-3] deploy done', webhookId: 'wh-2' },
    ];
    const map = await batchResolveMentions(rows, 'srv-1');
    expect(map.size).toBe(0);
    expect(mockServerMemberFindMany).not.toHaveBeenCalled();
    for (const row of rows) expect(attachMentions(row, map)).toEqual([]);
  });

  it('a webhook row gets no mentions even when the map already holds its ids (from a human row on the page)', async () => {
    mockServerMemberFindMany.mockResolvedValueOnce([{ user: user2 }]);
    const human = { content: 'hey @[user-2]', webhookId: null };
    const webhook = { content: 'hey @[user-2]', webhookId: 'wh-1' };

    const map = await batchResolveMentions([human, webhook], 'srv-1');

    // only the HUMAN row's ids are looked up
    expect(mockServerMemberFindMany).toHaveBeenCalledTimes(1);
    expect(mockServerMemberFindMany.mock.calls[0][0].where).toEqual({ serverId: 'srv-1', userId: { in: ['user-2'] } });
    expect(attachMentions(human, map)).toEqual([user2]);
    expect(attachMentions(webhook, map)).toEqual([]);
  });

  it('only collects ids from human rows (a webhook-only id is never queried)', async () => {
    mockServerMemberFindMany.mockResolvedValueOnce([{ user: user2 }]);
    await batchResolveMentions(
      [{ content: '@[user-2]' }, { content: '@[user-3]', webhookId: 'wh-1' }],
      'srv-1',
    );
    expect(mockServerMemberFindMany.mock.calls[0][0].where.userId.in).toEqual(['user-2']);
  });

  it('a row of a DELETED webhook (webhookId SET NULL, frozen webhookName, authorId null) still gets no mentions', async () => {
    // Keying the skip on webhookId alone would start pinging people the day
    // the webhook is deleted: the refetch would no longer agree with the
    // live event
    const byName = { content: '@[user-2]', webhookId: null, webhookName: 'Old bot', authorId: null };
    const byAuthorless = { content: '@[user-3]', webhookId: null, webhookName: null, authorId: null };
    const map = await batchResolveMentions([byName, byAuthorless], 'srv-1');
    expect(mockServerMemberFindMany).not.toHaveBeenCalled();
    const full = new Map([['user-2', user2], ['user-3', user3]]);
    expect(attachMentions(byName, full)).toEqual([]);
    expect(attachMentions(byAuthorless, full)).toEqual([]);
    expect(map.size).toBe(0);
  });

  it('human rows (webhookId null or absent) resolve exactly as before', async () => {
    mockServerMemberFindMany.mockResolvedValueOnce([{ user: user2 }, { user: user3 }]);
    const a = { content: '@[user-2] and @[user-3]', webhookId: null };
    const b = { content: '@[user-3]' };
    const map = await batchResolveMentions([a, b], 'srv-1');
    expect(attachMentions(a, map)).toEqual([user2, user3]);
    expect(attachMentions(b, map)).toEqual([user3]);
  });

  it('still skips ciphertext rows (the existing rule is unchanged)', async () => {
    const enc = { content: '@[user-2]', encrypted: true };
    const map = await batchResolveMentions([enc], 'srv-1');
    expect(mockServerMemberFindMany).not.toHaveBeenCalled();
    expect(attachMentions(enc, new Map([['user-2', user2]]))).toEqual([]);
  });
});
