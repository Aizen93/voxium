import { describe, it, expect, vi, afterEach } from 'vitest';
// The opaque-id check routes/servers.ts applies to every member lookup:
// anything that passes it could be looked up as a user id
import { OPAQUE_ID_RE } from '@voxium/shared';
import {
  isWebhookRow,
  shapeMessageAuthor,
  shapeMessageRow,
  WEBHOOK_AUTHOR_FALLBACK_NAME,
  WEBHOOK_AUTHOR_ID_PREFIX,
} from '../../utils/messageAuthor';

const sevenFieldAuthor = {
  id: 'user-1',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: 'avatars/user-1.png',
  role: 'user',
  isSupporter: true,
  supporterTier: 'first',
};

const fourFieldAuthor = {
  id: 'user-2',
  username: 'bob',
  displayName: 'Bob',
  avatarUrl: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shapeMessageAuthor', () => {
  it('passes a human author (seven-field select) through unchanged — same reference, no isWebhook', () => {
    const row = { author: sevenFieldAuthor, webhookId: null, webhookName: null };
    const author = shapeMessageAuthor(row);
    expect(author).toBe(sevenFieldAuthor);
    expect(author).not.toHaveProperty('isWebhook');
  });

  it('passes a human author (four-field select, as search.ts selects) through unchanged', () => {
    const row = { author: fourFieldAuthor, webhookId: null, webhookName: null };
    expect(shapeMessageAuthor(row)).toEqual(fourFieldAuthor);
  });

  it('keeps the human author even if a row somehow carries webhook columns too', () => {
    const row = { author: fourFieldAuthor, webhookId: 'wh-1', webhookName: 'CI' };
    expect(shapeMessageAuthor(row)).toBe(fourFieldAuthor);
  });

  it('synthesises the webhook author from webhookId + webhookName when author is null', () => {
    const row = { author: null, webhookId: 'wh_abc123', webhookName: 'GitHub' };
    expect(shapeMessageAuthor(row)).toEqual({
      id: 'webhook:wh_abc123',
      username: 'GitHub',
      displayName: 'GitHub',
      avatarUrl: null,
      isWebhook: true,
    });
  });

  it('labels a row whose webhook was deleted (webhookId SET NULL) as webhook:deleted, keeping the frozen name', () => {
    const row = { author: null, webhookId: null, webhookName: 'Deploy bot' };
    expect(shapeMessageAuthor(row)).toEqual({
      id: 'webhook:deleted',
      username: 'Deploy bot',
      displayName: 'Deploy bot',
      avatarUrl: null,
      isWebhook: true,
    });
  });

  it('falls back to a fixed placeholder name (and warns) when the write invariant is broken', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = { id: 'msg-9', author: null, webhookId: 'wh-1', webhookName: null };
    const author = shapeMessageAuthor(row);
    expect(author).toEqual({
      id: 'webhook:wh-1',
      username: WEBHOOK_AUTHOR_FALLBACK_NAME,
      displayName: WEBHOOK_AUTHOR_FALLBACK_NAME,
      avatarUrl: null,
      isWebhook: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[messageAuthor]'), { messageId: 'msg-9' });
  });

  it('treats an empty webhookName like a missing one (never an empty author label)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const author = shapeMessageAuthor({ author: null, webhookId: null, webhookName: '' });
    expect(author.username).toBe(WEBHOOK_AUTHOR_FALLBACK_NAME);
    expect(author.displayName).toBe(WEBHOOK_AUTHOR_FALLBACK_NAME);
  });

  it('never produces an id that passes the opaque-id check, so it can never be taken for a user id', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = [
      shapeMessageAuthor({ author: null, webhookId: 'cm1abcdefghijklmnop', webhookName: 'A' }).id,
      shapeMessageAuthor({ author: null, webhookId: null, webhookName: 'B' }).id,
      shapeMessageAuthor({ author: null, webhookId: 'x', webhookName: null }).id,
    ];
    for (const id of ids) {
      expect(id.startsWith(WEBHOOK_AUTHOR_ID_PREFIX)).toBe(true);
      expect(id).not.toMatch(OPAQUE_ID_RE);
    }
  });
});

describe('isWebhookRow', () => {
  it('is true while the webhook exists (webhookId set)', () => {
    expect(isWebhookRow({ webhookId: 'wh-1', webhookName: 'CI', authorId: null })).toBe(true);
    expect(isWebhookRow({ webhookId: 'wh-1' })).toBe(true);
  });

  it('stays true after the webhook is deleted (webhookId SET NULL, the frozen name remains)', () => {
    expect(isWebhookRow({ webhookId: null, webhookName: 'Old bot', authorId: null })).toBe(true);
    expect(isWebhookRow({ webhookId: null, webhookName: 'Old bot' })).toBe(true);
  });

  it('is true for an authorless row even with both webhook columns null (column-level truth)', () => {
    expect(isWebhookRow({ webhookId: null, webhookName: null, authorId: null })).toBe(true);
  });

  it('is false for a human row, and an absent (unselected) field never counts', () => {
    expect(isWebhookRow({ webhookId: null, webhookName: null, authorId: 'user-1' })).toBe(false);
    expect(isWebhookRow({ authorId: 'user-1' })).toBe(false);
    expect(isWebhookRow({})).toBe(false);
  });
});

describe('shapeMessageRow', () => {
  const baseRow = {
    id: 'msg-1',
    content: 'Build passed',
    channelId: 'ch-1',
    authorId: null,
    createdAt: new Date('2026-10-18T12:00:00Z'),
    reactions: [],
  };

  it('shapes the row author and leaves every other field as is', () => {
    const row = { ...baseRow, author: null, webhookId: 'wh-1', webhookName: 'CI', replyTo: null };
    const shaped = shapeMessageRow(row);
    expect(shaped.author).toEqual({ id: 'webhook:wh-1', username: 'CI', displayName: 'CI', avatarUrl: null, isWebhook: true });
    expect(shaped.id).toBe('msg-1');
    expect(shaped.content).toBe('Build passed');
    expect(shaped.webhookId).toBe('wh-1');
    expect(shaped.createdAt).toBe(row.createdAt);
    expect(shaped.replyTo).toBeNull();
    // the input row is not mutated
    expect(row.author).toBeNull();
  });

  it('shapes the quoted message author too: a human reply quoting a webhook message', () => {
    const row = {
      ...baseRow,
      authorId: 'user-1',
      author: sevenFieldAuthor,
      webhookId: null,
      webhookName: null,
      replyTo: { id: 'msg-0', content: 'Deploy failed', author: null, webhookId: 'wh-7', webhookName: 'Deploy bot' },
    };
    const shaped = shapeMessageRow(row);
    expect(shaped.author).toBe(sevenFieldAuthor);
    expect(shaped.replyTo).toEqual({
      id: 'msg-0',
      content: 'Deploy failed',
      webhookId: 'wh-7',
      webhookName: 'Deploy bot',
      author: { id: 'webhook:wh-7', username: 'Deploy bot', displayName: 'Deploy bot', avatarUrl: null, isWebhook: true },
    });
    expect(row.replyTo.author).toBeNull();
  });

  it('passes a human quote through unchanged', () => {
    const row = {
      ...baseRow,
      author: null,
      webhookId: 'wh-1',
      webhookName: 'CI',
      replyTo: { id: 'msg-0', content: 'ping', author: fourFieldAuthor, webhookId: null, webhookName: null },
    };
    const shaped = shapeMessageRow(row);
    expect(shaped.replyTo!.author).toBe(fourFieldAuthor);
    expect((shaped.author as { isWebhook?: boolean }).isWebhook).toBe(true);
  });

  it('works on a row with no replyTo key at all (search-style select) and adds none', () => {
    const row = { id: 'msg-2', content: 'x', author: fourFieldAuthor, webhookId: null, webhookName: null };
    const shaped = shapeMessageRow(row);
    expect(shaped).toEqual(row);
    expect(shaped).not.toHaveProperty('replyTo');
  });
});
