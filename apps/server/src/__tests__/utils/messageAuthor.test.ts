import { describe, it, expect, vi, afterEach } from 'vitest';
// The opaque-id check routes/servers.ts applies to every member lookup:
// anything that passes it could be looked up as a user id
import { OPAQUE_ID_RE } from '@voxium/shared';
import {
  isWebhookRow,
  shapeConversationMessageAuthor,
  shapeConversationMessageRow,
  shapeMessageAuthor,
  shapeMessageRow,
  WEBHOOK_AUTHOR_FALLBACK_NAME,
  WEBHOOK_AUTHOR_ID_PREFIX,
  type WebhookRowMarkers,
} from '../../utils/messageAuthor';
import { deletedParticipant, deletedQuoteAuthor } from '../../utils/deletedParticipant';

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

  it('is false for an authorless row INSIDE a conversation: a deleted account\'s message, never a webhook', () => {
    expect(isWebhookRow({ webhookId: null, webhookName: null, authorId: null, conversationId: 'conv-1' })).toBe(false);
    expect(isWebhookRow({ authorId: null, conversationId: 'conv-1' })).toBe(false);
  });

  it('keeps the authorless reading outside a conversation (a channel row: conversationId null, absent or empty)', () => {
    expect(isWebhookRow({ webhookId: null, webhookName: null, authorId: null, conversationId: null })).toBe(true);
    expect(isWebhookRow({ authorId: null, conversationId: '' })).toBe(true);
  });

  it('lets the webhook columns win in a conversation too (column truth: webhooks never post there, but a marked row is one)', () => {
    expect(isWebhookRow({ webhookId: 'wh-1', webhookName: null, authorId: null, conversationId: 'conv-1' })).toBe(true);
    expect(isWebhookRow({ webhookId: null, webhookName: 'Old bot', authorId: null, conversationId: 'conv-1' })).toBe(true);
  });

  describe('every combination of the four markers', () => {
    // develop's predicate before conversations could lose an author, copied
    // as it was: what every row read outside a conversation must still get
    const before = (row: WebhookRowMarkers): boolean =>
      (row.webhookId !== null && row.webhookId !== undefined)
      || (row.webhookName !== null && row.webhookName !== undefined)
      || row.authorId === null;
    const ABSENT = Symbol('absent');
    type Marker = string | null | typeof ABSENT;
    const rows: WebhookRowMarkers[] = [];
    for (const webhookId of [ABSENT, null, 'wh-1'] as Marker[]) {
      for (const webhookName of [ABSENT, null, 'CI'] as Marker[]) {
        for (const authorId of [ABSENT, null, 'user-1'] as Marker[]) {
          for (const conversationId of [ABSENT, null, '', 'conv-1'] as Marker[]) {
            const row: WebhookRowMarkers = {};
            if (webhookId !== ABSENT) row.webhookId = webhookId;
            if (webhookName !== ABSENT) row.webhookName = webhookName;
            if (authorId !== ABSENT) row.authorId = authorId;
            if (conversationId !== ABSENT) row.conversationId = conversationId;
            rows.push(row);
          }
        }
      }
    }

    it('covers all 108 rows', () => {
      expect(rows).toHaveLength(108);
    });

    it('answers exactly as before for every row not in a conversation (absent, null or empty)', () => {
      const outside = rows.filter((r) => !r.conversationId);
      expect(outside).toHaveLength(81);
      for (const row of outside) expect(isWebhookRow(row), JSON.stringify(row)).toBe(before(row));
    });

    it('in a conversation, answers true only for a row a webhook column marks', () => {
      const inside = rows.filter((r) => r.conversationId === 'conv-1');
      expect(inside).toHaveLength(27);
      for (const row of inside) {
        const marked = typeof row.webhookId === 'string' || typeof row.webhookName === 'string';
        expect(isWebhookRow(row), JSON.stringify(row)).toBe(marked);
      }
    });
  });
});

describe('shapeMessageAuthor — a deleted account in a conversation', () => {
  it('shapes an authorless conversation row as the deleted-account placeholder, with no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = { id: 'msg-1', conversationId: 'conv-1', author: null, webhookId: null, webhookName: null };
    expect(shapeMessageAuthor(row)).toStrictEqual(deletedParticipant('conv-1'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives an id of the conversation that never passes the opaque-id check and is no webhook id', () => {
    const author = shapeMessageAuthor({ conversationId: 'cmconv000000000000000001', author: null, webhookId: null, webhookName: null });
    expect(author.id).toBe('deleted:cmconv000000000000000001');
    expect(author.id).not.toMatch(OPAQUE_ID_RE);
    expect(author.id.startsWith(WEBHOOK_AUTHOR_ID_PREFIX)).toBe(false);
    expect(author).not.toHaveProperty('isWebhook');
  });

  it('differs per conversation', () => {
    const a = shapeMessageAuthor({ conversationId: 'conv-1', author: null, webhookId: null, webhookName: null });
    const b = shapeMessageAuthor({ conversationId: 'conv-2', author: null, webhookId: null, webhookName: null });
    expect(a.id).not.toBe(b.id);
  });

  it('leaves a live author in a conversation untouched (same reference)', () => {
    const row = { conversationId: 'conv-1', author: sevenFieldAuthor, webhookId: null, webhookName: null };
    expect(shapeMessageAuthor(row)).toBe(sevenFieldAuthor);
  });

  it('lets the webhook columns win over the conversation (as isWebhookRow does)', () => {
    const row = { conversationId: 'conv-1', author: null, webhookId: 'wh-1', webhookName: 'CI' };
    expect(shapeMessageAuthor(row)).toEqual({ id: 'webhook:wh-1', username: 'CI', displayName: 'CI', avatarUrl: null, isWebhook: true });
  });

  it('keeps the webhook shaping for a row outside a conversation (null, empty, or not selected)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(shapeMessageAuthor({ conversationId: null, author: null, webhookId: null, webhookName: 'CI' }).id).toBe('webhook:deleted');
    expect(shapeMessageAuthor({ author: null, webhookId: null, webhookName: null }).id).toBe('webhook:deleted');
    expect(shapeMessageAuthor({ conversationId: '', author: null, webhookId: null, webhookName: null }).id).toBe('webhook:deleted');
  });

  it('agrees with isWebhookRow on every authorless row (one rule decides both)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const webhookId of [null, 'wh-1']) {
      for (const webhookName of [null, 'CI']) {
        for (const conversationId of [undefined, null, '', 'conv-1']) {
          const row = { author: null, authorId: null, webhookId, webhookName, ...(conversationId !== undefined && { conversationId }) };
          const author = shapeMessageAuthor(row);
          expect('isWebhook' in author, JSON.stringify(row)).toBe(isWebhookRow(row));
        }
      }
    }
  });
});

describe('shapeConversationMessageAuthor — the conversation is the caller\'s, never the select\'s', () => {
  it('gives the placeholder to an authorless row whose select carries no conversationId at all', () => {
    expect(shapeConversationMessageAuthor({ author: null, webhookId: null, webhookName: null }, 'conv-5'))
      .toStrictEqual(deletedParticipant('conv-5'));
  });

  it('uses the conversation it is given over one the row carries', () => {
    expect(shapeConversationMessageAuthor({ conversationId: 'conv-6', author: null, webhookId: null, webhookName: null }, 'conv-5').id)
      .toBe('deleted:conv-5');
  });

  it('leaves a live author untouched, and lets the webhook columns win (as everywhere)', () => {
    expect(shapeConversationMessageAuthor({ author: sevenFieldAuthor, webhookId: null, webhookName: null }, 'conv-1')).toBe(sevenFieldAuthor);
    expect(shapeConversationMessageAuthor({ author: null, webhookId: 'wh-1', webhookName: 'CI' }, 'conv-1').id).toBe('webhook:wh-1');
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

  it('shapes an authorless quote in a conversation with the QUOTING row\'s conversation (a quote selects none), as a quote author', () => {
    const row = {
      ...baseRow,
      channelId: null,
      conversationId: 'conv-1',
      authorId: 'user-1',
      author: sevenFieldAuthor,
      webhookId: null,
      webhookName: null,
      replyTo: { id: 'msg-0', content: '', encrypted: false, author: null, webhookId: null, webhookName: null },
    };
    const shaped = shapeMessageRow(row);
    expect(shaped.author).toBe(sevenFieldAuthor);
    expect(shaped.replyTo!.author).toStrictEqual(deletedQuoteAuthor('conv-1'));
    expect(shaped.replyTo!.author).not.toHaveProperty('status');
  });

  it('keeps the webhook shaping of an authorless quote in a channel (the quoting row has no conversation)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = {
      ...baseRow,
      conversationId: null,
      authorId: 'user-1',
      author: sevenFieldAuthor,
      webhookId: null,
      webhookName: null,
      replyTo: { id: 'msg-0', content: 'x', author: null, webhookId: null, webhookName: null },
    };
    expect(shapeMessageRow(row).replyTo!.author.id).toBe('webhook:deleted');
  });

  it('shapes an authorless conversation row itself as the placeholder', () => {
    const row = { ...baseRow, channelId: null, conversationId: 'conv-2', content: '', type: 'deleted', author: null, webhookId: null, webhookName: null, replyTo: null };
    const shaped = shapeMessageRow(row);
    expect(shaped.author).toStrictEqual(deletedParticipant('conv-2'));
    expect(shaped.conversationId).toBe('conv-2');
    expect(shaped.replyTo).toBeNull();
  });

  it('works on a row with no replyTo key at all (search-style select) and adds none', () => {
    const row = { id: 'msg-2', content: 'x', author: fourFieldAuthor, webhookId: null, webhookName: null };
    const shaped = shapeMessageRow(row);
    expect(shaped).toEqual(row);
    expect(shaped).not.toHaveProperty('replyTo');
  });
});

describe('shapeConversationMessageRow — every DM reader', () => {
  const dmRow = {
    id: 'msg-1',
    content: '',
    encrypted: false,
    type: 'deleted',
    channelId: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    reactions: [],
  };

  it('shapes an authorless row and an authorless quote with the conversation it is given, whatever the select carries', () => {
    const row = {
      ...dmRow,
      author: null,
      webhookId: null,
      webhookName: null,
      replyTo: { id: 'msg-0', content: '', encrypted: false, author: null, webhookId: null, webhookName: null },
    };
    const shaped = shapeConversationMessageRow(row, 'conv-9');
    expect(shaped.author).toStrictEqual(deletedParticipant('conv-9'));
    expect(shaped.replyTo!.author).toStrictEqual(deletedQuoteAuthor('conv-9'));
    expect(row.author).toBeNull();
    expect(row.replyTo.author).toBeNull();
  });

  it('gives a quote\'s placeholder exactly the keys of a live quote author (no presence), the row\'s those of a live row author', () => {
    // dm.ts selects the row author with status, the quote author without it
    const liveRowAuthorKeys = ['id', 'username', 'displayName', 'avatarUrl', 'status', 'role', 'isSupporter', 'supporterTier'];
    const liveQuoteAuthorKeys = ['id', 'username', 'displayName', 'avatarUrl', 'role', 'isSupporter', 'supporterTier'];
    expect(Object.keys(deletedParticipant('c')).sort()).toEqual([...liveRowAuthorKeys].sort());
    expect(Object.keys(deletedQuoteAuthor('c')).sort()).toEqual([...liveQuoteAuthorKeys].sort());
  });

  it('passes a live row and a live quote through as they are', () => {
    const row = {
      ...dmRow,
      type: 'user',
      encrypted: true,
      author: sevenFieldAuthor,
      webhookId: null,
      webhookName: null,
      replyTo: { id: 'msg-0', content: 'x', encrypted: true, author: fourFieldAuthor, webhookId: null, webhookName: null },
    };
    const shaped = shapeConversationMessageRow(row, 'conv-9');
    expect(shaped.author).toBe(sevenFieldAuthor);
    expect(shaped.replyTo!.author).toBe(fourFieldAuthor);
    expect(shaped).toEqual(row);
  });
});
