import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma', () => ({
  prisma: { conversation: { findUnique: vi.fn() } },
}));

import { prisma } from '../../utils/prisma';
import {
  aboveFloorWhere,
  dmListedSql,
  dmUnreadSinceSql,
  isAboveFloor,
  isReadOnlyConversation,
  isVisibleMessage,
  loadConversationView,
  newMessageTime,
  rowForViewer,
  nobodyCanReach,
  quoteForViewer,
  readConversationView,
  sidesBelowFloor,
  type SideReach,
} from '../../utils/conversationVisibility';

const T = (iso: string) => new Date(iso);
const floor = T('2026-11-16T10:00:00.000Z');
const atFloor = T('2026-11-16T10:00:00.000Z');
const justAbove = T('2026-11-16T10:00:00.001Z');
const justBelow = T('2026-11-16T09:59:59.999Z');

describe('the floor: strictly above it is visible', () => {
  it('no floor: everything', () => {
    expect(isAboveFloor(justBelow, null)).toBe(true);
    expect(isAboveFloor(new Date(0), null)).toBe(true);
  });

  it('a row AT the floor is gone (the floor is the newest message at the removal), one a millisecond later is visible', () => {
    expect(isAboveFloor(atFloor, floor)).toBe(false);
    expect(isAboveFloor(justBelow, floor)).toBe(false);
    expect(isAboveFloor(justAbove, floor)).toBe(true);
  });

  it('the Prisma filter says the same: gt the floor, and nothing without one', () => {
    expect(aboveFloorWhere(null)).toEqual({});
    expect(aboveFloorWhere(floor)).toEqual({ createdAt: { gt: floor } });
  });
});

describe('isVisibleMessage: the one check every action makes', () => {
  it('a missing message, one of another conversation, one at or below the floor: all not visible', () => {
    expect(isVisibleMessage(null, 'conv-1', null)).toBe(false);
    expect(isVisibleMessage(undefined, 'conv-1', null)).toBe(false);
    expect(isVisibleMessage({ conversationId: 'conv-2', createdAt: justAbove }, 'conv-1', floor)).toBe(false);
    expect(isVisibleMessage({ conversationId: null, createdAt: justAbove }, 'conv-1', floor)).toBe(false);
    expect(isVisibleMessage({ conversationId: 'conv-1', createdAt: atFloor }, 'conv-1', floor)).toBe(false);
  });

  it('a message of this conversation above the floor, or with no floor, is visible', () => {
    expect(isVisibleMessage({ conversationId: 'conv-1', createdAt: justAbove }, 'conv-1', floor)).toBe(true);
    expect(isVisibleMessage({ conversationId: 'conv-1', createdAt: justBelow }, 'conv-1', null)).toBe(true);
  });
});

describe('sidesBelowFloor: who cannot see a row', () => {
  const sides = [
    { userId: 'a', hiddenAt: null, clearedAt: floor },
    { userId: 'b', hiddenAt: null, clearedAt: null },
  ];

  it('names the sides whose floor is at or above the row, and nobody else', () => {
    expect(sidesBelowFloor(sides, atFloor)).toEqual(['a']);
    expect(sidesBelowFloor(sides, justBelow)).toEqual(['a']);
    expect(sidesBelowFloor(sides, justAbove)).toEqual([]);
    expect(sidesBelowFloor([], justBelow)).toEqual([]);
  });
});

describe('quoteForViewer', () => {
  const quote = { id: 'q', content: 'c', createdAt: justBelow };

  it('a quote the viewer cleared becomes null (a deleted quote), and a kept one never carries its createdAt', () => {
    expect(quoteForViewer(quote, floor)).toBeNull();
    expect(quoteForViewer({ ...quote, createdAt: atFloor }, floor)).toBeNull();
    expect(quoteForViewer(quote, null)).toStrictEqual({ id: 'q', content: 'c' });
    expect(quoteForViewer({ ...quote, createdAt: justAbove }, floor)).toStrictEqual({ id: 'q', content: 'c' });
    expect(quoteForViewer(null, floor)).toBeNull();
  });
});

describe('newMessageTime: a new message is above every floor and after every message', () => {
  const now = T('2026-11-16T12:00:00.000Z');

  it('now, when every floor and the newest message are older', () => {
    expect(newMessageTime(now, [], null)).toBe(now);
    expect(newMessageTime(now, [{ clearedAt: null }, { clearedAt: floor }], T('2026-11-16T11:59:59.999Z'))).toBe(now);
  });

  it('one millisecond after the highest floor when it is now or later (another clock, the same millisecond)', () => {
    const ahead = T('2026-11-16T12:00:05.000Z');
    expect(newMessageTime(now, [{ clearedAt: floor }, { clearedAt: ahead }], null).toISOString()).toBe('2026-11-16T12:00:05.001Z');
    expect(newMessageTime(now, [{ clearedAt: now }], null).toISOString()).toBe('2026-11-16T12:00:00.001Z');
  });

  it('one millisecond after the newest message when that is later still: under a floor ahead of the clock, stamps keep increasing', () => {
    const ahead = T('2026-11-16T12:00:05.000Z');
    const first = newMessageTime(now, [{ clearedAt: ahead }], ahead);
    const second = newMessageTime(T('2026-11-16T12:00:00.020Z'), [{ clearedAt: ahead }], first);
    expect(first.toISOString()).toBe('2026-11-16T12:00:05.001Z');
    expect(second.toISOString()).toBe('2026-11-16T12:00:05.002Z');
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it('never before an existing message, with or without a floor', () => {
    const newest = T('2026-11-16T12:00:09.000Z');
    expect(newMessageTime(now, [], newest).toISOString()).toBe('2026-11-16T12:00:09.001Z');
    expect(newMessageTime(now, [{ clearedAt: floor }], newest).toISOString()).toBe('2026-11-16T12:00:09.001Z');
  });

  it('whatever it returns is visible to every side and later than the newest message', () => {
    for (const [floors, newest] of [[[null, null], null], [[floor, null], floor], [[now, T('2026-11-16T13:00:00.000Z')], T('2026-11-16T14:00:00.000Z')]] as const) {
      const sides = floors.map((clearedAt) => ({ clearedAt }));
      const at = newMessageTime(now, sides, newest);
      for (const s of sides) expect(isAboveFloor(at, s.clearedAt)).toBe(true);
      if (newest) expect(at.getTime()).toBeGreaterThan(newest.getTime());
    }
  });
});

describe('rowForViewer', () => {
  it("keeps the row and decides its quote by the viewer's floor alone", () => {
    const row = { id: 'm', createdAt: T('2026-11-16T11:00:00.000Z'), replyTo: { id: 'q', createdAt: T('2026-11-09T00:00:00.000Z') } };
    expect(rowForViewer(row, floor)).toStrictEqual({ id: 'm', createdAt: row.createdAt, replyTo: null });
    expect(rowForViewer(row, null)).toStrictEqual({ id: 'm', createdAt: row.createdAt, replyTo: { id: 'q' } });
    expect(rowForViewer({ id: 'm', replyTo: null }, floor)).toStrictEqual({ id: 'm', replyTo: null });
  });
});

describe('the SQL forms of the rule', () => {
  it('unread: after the later of the last read and the floor, each defaulting to the epoch for a missing read row', () => {
    expect(dmUnreadSinceSql('cr')).toBe(
      "GREATEST(COALESCE(cr.last_read_at, '1970-01-01'::timestamp), COALESCE(cr.cleared_at, '1970-01-01'::timestamp))",
    );
  });

  it('listed: not hidden by that read row (a missing read row is listed)', () => {
    expect(dmListedSql('cr')).toBe('cr.hidden_at IS NULL');
  });
});

describe('nobodyCanReach: when the rows can really be deleted', () => {
  const live = (userId: string, hidden: boolean, messageAboveFloor: boolean): SideReach => ({ userId, hidden, messageAboveFloor });
  const gone: SideReach = { userId: null, hidden: true, messageAboveFloor: false };

  it('every combination of two live sides: only both hidden with nothing above either floor', () => {
    for (const aHidden of [false, true]) {
      for (const aAbove of [false, true]) {
        for (const bHidden of [false, true]) {
          for (const bAbove of [false, true]) {
            const expected = aHidden && !aAbove && bHidden && !bAbove;
            expect(nobodyCanReach([live('a', aHidden, aAbove), live('b', bHidden, bAbove)]), JSON.stringify({ aHidden, aAbove, bHidden, bAbove })).toBe(expected);
          }
        }
      }
    }
  });

  it('a live side facing a deleted side: hidden is enough, whatever lies above its floor (no message can arrive, nobody to reopen it with)', () => {
    for (const above of [false, true]) {
      expect(nobodyCanReach([live('a', true, above), gone])).toBe(true);
      expect(nobodyCanReach([gone, live('a', true, above)])).toBe(true);
      expect(nobodyCanReach([live('a', false, above), gone])).toBe(false);
      expect(nobodyCanReach([gone, live('a', false, above)])).toBe(false);
    }
  });

  it('both sides deleted: nobody is left', () => {
    expect(nobodyCanReach([gone, gone])).toBe(true);
  });

  it('a deleted side counts as hidden with an infinite floor whatever the flags it is given', () => {
    const odd: SideReach = { userId: null, hidden: false, messageAboveFloor: true };
    expect(nobodyCanReach([live('a', true, false), odd])).toBe(true);
  });
});

describe("isReadOnlyConversation: one side's account is gone", () => {
  it('is read-only with either side NULL, both included', () => {
    expect(isReadOnlyConversation({ user1Id: null, user2Id: 'user-2' })).toBe(true);
    expect(isReadOnlyConversation({ user1Id: 'user-1', user2Id: null })).toBe(true);
    expect(isReadOnlyConversation({ user1Id: null, user2Id: null })).toBe(true);
  });

  it('a live conversation is not, whatever the sides are called', () => {
    expect(isReadOnlyConversation({ user1Id: 'user-1', user2Id: 'user-2' })).toBe(false);
    // the placeholder's name or id as a side value is not a NULL side
    expect(isReadOnlyConversation({ user1Id: 'deleted', user2Id: 'deleted:conv-1' })).toBe(false);
  });
});

describe('the conversation view', () => {
  const row = {
    id: 'conv-1',
    user1Id: 'user-1',
    user2Id: 'user-2',
    reads: [
      { userId: 'user-1', hiddenAt: T('2026-11-16T10:05:00.000Z'), clearedAt: floor },
      { userId: 'user-2', hiddenAt: null, clearedAt: null },
    ],
  };

  beforeEach(() => {
    vi.mocked(prisma.conversation.findUnique).mockReset();
  });

  it('reads the sides and both read rows in one statement, and gives the viewer their own floor and hidden state', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(row as any);

    const mine = await loadConversationView('conv-1', 'user-1');
    expect(mine).toEqual({ id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2', floor, hidden: true, sides: row.reads });
    const theirs = await readConversationView('conv-1', 'user-2');
    expect(theirs).toMatchObject({ floor: null, hidden: false });
    expect(prisma.conversation.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      select: { id: true, user1Id: true, user2Id: true, reads: { select: { userId: true, hiddenAt: true, clearedAt: true } } },
    });
  });

  it('a viewer without a read row has no floor and is not hidden', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({ ...row, reads: [] } as any);
    expect(await loadConversationView('conv-1', 'user-2')).toMatchObject({ floor: null, hidden: false, sides: [] });
  });

  it('404 for a missing conversation, 403 for a non-participant (and null from the reading form)', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null);
    await expect(loadConversationView('conv-x', 'user-1')).rejects.toMatchObject({ statusCode: 404, message: 'Conversation not found' });
    expect(await readConversationView('conv-x', 'user-1')).toBeNull();

    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(row as any);
    await expect(loadConversationView('conv-1', 'user-3')).rejects.toMatchObject({ statusCode: 403, message: 'Not a participant of this conversation' });
    expect(await readConversationView('conv-1', 'user-3')).toBeNull();
  });

  it('a NULL side admits nobody as the deleted account, the remaining person as before', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({ ...row, user2Id: null, reads: [row.reads[0]] } as any);
    expect(await readConversationView('conv-1', 'user-1')).not.toBeNull();
    expect(await readConversationView('conv-1', 'user-2')).toBeNull();
  });

  it('reads through the client it is given (a transaction reads only through its own)', async () => {
    const tx = { conversation: { findUnique: vi.fn().mockResolvedValue(row) } };
    expect(await readConversationView('conv-1', 'user-1', tx as any)).toMatchObject({ floor });
    expect(tx.conversation.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });
});
