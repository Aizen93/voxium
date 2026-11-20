// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation } from '@voxium/shared';
import type { PlaintextPurgeEntry } from '../../services/e2e/vault';

/**
 * services/dmClearedHistory.ts, the one place a cleared history's floor is
 * applied on the client: what it takes (the server's ISO time only), that a
 * floor is monotonic and idempotent, what it asks the E2E service to purge
 * (the predicate, the levelled mark), what stays owed, and the payload checks
 * of the event and the answer. The walk itself, over a real vault, is
 * __tests__/e2e/clearedHistoryCache.test.ts.
 */

const purge = vi.hoisted(() => ({
  calls: [] as Array<{ scopes: string[]; remove: (e: PlaintextPurgeEntry) => boolean; opts: { mark?: string; levels?: ReadonlyMap<string, number> } }>,
  answer: null as null | ((scopes: string[]) => Promise<{ removed: number; marked: string[] }>),
}));

vi.mock('../../services/e2e/e2eService', () => ({
  CLEARED_HISTORY_PURGE_MARK: 'cleared',
  getE2EService: () => ({
    purgeCachedPlaintexts: (scopes: string[], remove: (e: PlaintextPurgeEntry) => boolean, opts: { mark?: string; levels?: ReadonlyMap<string, number> }) => {
      purge.calls.push({ scopes, remove, opts: { ...opts, levels: opts.levels && new Map(opts.levels) } });
      return purge.answer ? purge.answer(scopes) : Promise.resolve({ removed: 0, marked: scopes });
    },
  }),
}));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ ready: true, error: null }), subscribe: () => () => {} },
}));

import { registerE2ESessionUser } from '../../services/e2e/session';
import { DM_CLEARED_LIST_MAX } from '@voxium/shared';
import { clearedFloorOf, isAtOrBelowClearedFloor, raiseClearedFloor } from '../../services/e2e/clearedFloors';
import {
  CLEARED_FLOOR_MAX_AHEAD_MS,
  applyClearedFloor,
  applyClearedList,
  applyConversationFloors,
  clearedHistoryPurgesSettled,
  readConversationRemovedNotice,
  removalAnswerFloor,
  resetClearedHistory,
  retryOwedClearedPurges,
  withoutClearedPreview,
} from '../../services/dmClearedHistory';

const ME = 'me';
const FLOOR = '2026-11-10T10:00:00.000Z';
const FLOOR_MS = Date.parse(FLOOR);
const at = (offsetMs: number) => new Date(FLOOR_MS + offsetMs).toISOString();

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  registerE2ESessionUser(() => ME);
  purge.calls.length = 0;
  purge.answer = null;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  resetClearedHistory();
  await clearedHistoryPurgesSettled();
  registerE2ESessionUser(null);
  vi.restoreAllMocks();
});

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  user1Id: ME,
  user2Id: 'u2',
  participant: { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null },
  lastMessage: null,
  encryptedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('applyClearedFloor', () => {
  it('raises the floor at once (before any purge ran) and asks for ONE walk under the levelled mark', async () => {
    expect(applyClearedFloor('c1', FLOOR, 'test')).toBe(FLOOR_MS);
    // synchronous: what reads the floor knows it before the walk
    expect(isAtOrBelowClearedFloor(ME, 'c1', FLOOR)).toBe(true);

    await clearedHistoryPurgesSettled();

    expect(purge.calls).toHaveLength(1);
    expect(purge.calls[0].scopes).toEqual(['c1']);
    expect(purge.calls[0].opts).toEqual({ mark: 'cleared', levels: new Map([['c1', FLOOR_MS]]) });
  });

  it('idempotent and monotonic: the same floor again, or a lower one, walks nothing; a higher one walks again with it', async () => {
    applyClearedFloor('c1', FLOOR, 'test');
    await clearedHistoryPurgesSettled();
    applyClearedFloor('c1', FLOOR, 'test');
    applyClearedFloor('c1', at(-1), 'test');
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(1);
    expect(clearedFloorOf(ME, 'c1')).toBe(FLOOR_MS);

    applyClearedFloor('c1', at(5), 'test');
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(2);
    expect(purge.calls[1].opts.levels).toEqual(new Map([['c1', FLOOR_MS + 5]]));
  });

  it('the walk\'s predicate: at or below the floor, own and the other person\'s, compared as times; never one above, one with no time, or another scope', async () => {
    applyClearedFloor('c1', FLOOR, 'test');
    await clearedHistoryPurgesSettled();
    const { remove } = purge.calls[0];
    const entry = (over: Partial<PlaintextPurgeEntry>): PlaintextPurgeEntry => ({ scope: 'c1', messageId: 'm', editedAt: null, ...over });

    expect(remove(entry({ authorId: ME, createdAt: FLOOR }))).toBe(true);
    expect(remove(entry({ authorId: 'u2', createdAt: FLOOR }))).toBe(true);
    expect(remove(entry({ authorId: 'u2', createdAt: at(-1) }))).toBe(true);
    expect(remove(entry({ authorId: ME, createdAt: '2026-11-10T11:00:00.000+01:00' }))).toBe(true);
    expect(remove(entry({ authorId: ME, createdAt: at(1) }))).toBe(false);
    expect(remove(entry({ authorId: 'u2', createdAt: at(1) }))).toBe(false);
    expect(remove(entry({ authorId: 'u2' }))).toBe(false);
    expect(remove(entry({ authorId: 'u2', createdAt: 'yesterday' }))).toBe(false);
    expect(remove(entry({ scope: 'c2', authorId: 'u2', createdAt: FLOOR }))).toBe(false);
  });

  it('floors asked together are walked together; one that rises during a walk stays owed and is walked next', async () => {
    let releaseFirst!: () => void;
    purge.answer = (scopes) => purge.calls.length === 1
      ? new Promise((resolve) => { releaseFirst = () => resolve({ removed: 0, marked: scopes }); })
      : Promise.resolve({ removed: 0, marked: scopes });
    applyClearedFloor('c1', FLOOR, 'test');
    applyClearedFloor('c2', FLOOR, 'test');
    await vi.waitFor(() => expect(purge.calls).toHaveLength(1));
    expect(purge.calls[0].scopes).toEqual(['c1', 'c2']);

    // the removal again on another device, after a newer message: a higher floor
    applyClearedFloor('c1', at(10), 'test');
    releaseFirst();
    await clearedHistoryPurgesSettled();

    expect(purge.calls).toHaveLength(2);
    expect(purge.calls[1].opts.levels).toEqual(new Map([['c1', FLOOR_MS + 10]]));
    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(2);
  });

  it('a floor the walk did not mark stays owed and is tried again at the next list fetch; once marked, it is not', async () => {
    purge.answer = async () => ({ removed: 0, marked: [] });
    applyClearedFloor('c1', FLOOR, 'test');
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(1);

    purge.answer = null;
    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(2);
    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(2);
  });

  it('a walk that the session\'s end stopped is no failure: logged at debug, never as a warning', async () => {
    const ended = new Error('disposed');
    ended.name = 'E2EServiceDisposedError';
    purge.answer = () => Promise.reject(ended);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    applyClearedFloor('c1', FLOOR, 'test');
    await clearedHistoryPurgesSettled();

    expect(debug).toHaveBeenCalledWith('[DM] The purge of cleared histories ended with the session');
    expect(warn).not.toHaveBeenCalled();
  });

  it('absent (undefined or null): nothing happens, silently', async () => {
    expect(applyClearedFloor('c1', undefined, 'test')).toBeNull();
    expect(applyClearedFloor('c1', null, 'test')).toBeNull();
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a malformed floor is ignored with one warning naming where it came from; a floor naming no conversation too', async () => {
    for (const value of ['yesterday', '1', 1762768800000, {}, '2026-11-10']) {
      warn.mockClear();
      expect(applyClearedFloor('c1', value, 'dm:conversation:deleted')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[DM] Ignoring a malformed clearedUntil (dm:conversation:deleted)');
    }
    warn.mockClear();
    expect(applyClearedFloor(42, FLOOR, 'removal answer')).toBeNull();
    expect(applyClearedFloor('', FLOOR, 'removal answer')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a cleared-history floor that names no direct conversation (removal answer)');
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(0);
    expect(clearedFloorOf(ME, 'c1')).toBeNull();
  });

  it('only a direct conversation\'s id (OPAQUE_ID_RE): a secure channel\'s scope, or any id with a colon or a slash, is ignored with one warning', async () => {
    for (const id of ['ch:chan-1', 'deleted:c1', 'webhook:w1', 'c1/..', 'a'.repeat(65)]) {
      warn.mockClear();
      expect(applyClearedFloor(id, FLOOR, 'dm:conversation:deleted'), id).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[DM] Ignoring a cleared-history floor that names no direct conversation (dm:conversation:deleted)');
      expect(clearedFloorOf(ME, id)).toBeNull();
    }
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(0);
  });

  it('a floor more than a day ahead of the device\'s clock is ignored with one warning, at every entrance; one just inside the day is taken', async () => {
    const tooFar = new Date(Date.now() + CLEARED_FLOOR_MAX_AHEAD_MS + 60_000).toISOString();
    const inside = new Date(Date.now() + CLEARED_FLOOR_MAX_AHEAD_MS - 60_000).toISOString();
    expect(CLEARED_FLOOR_MAX_AHEAD_MS).toBe(24 * 60 * 60 * 1000);

    expect(applyClearedFloor('c1', tooFar, 'removal answer')).toBeNull();
    applyConversationFloors([conversation({ id: 'c2', clearedUntil: tooFar })]);
    applyClearedList([{ conversationId: 'c3', clearedUntil: tooFar }]);
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a clearedUntil more than a day ahead of this device\'s clock (removal answer)');
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a clearedUntil more than a day ahead of this device\'s clock (conversation)');
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a clearedUntil more than a day ahead of this device\'s clock (cleared list)');
    expect(warn).toHaveBeenCalledTimes(3);
    for (const id of ['c1', 'c2', 'c3']) expect(clearedFloorOf(ME, id)).toBeNull();

    expect(applyClearedFloor('c1', inside, 'removal answer')).toBe(Date.parse(inside));
    await clearedHistoryPurgesSettled();
    expect(purge.calls.map((c) => c.scopes)).toEqual([['c1']]);
  });

  it('nobody signed in: nothing is applied', async () => {
    registerE2ESessionUser(() => null);
    expect(applyClearedFloor('c1', FLOOR, 'test')).toBeNull();
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(0);
  });

  it('an answer for an account that is no longer the one signed in (askedBy) applies nothing; the same account applies as usual', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(applyClearedFloor('c1', FLOOR, 'removal answer', 'account-that-left')).toBeNull();
    expect(clearedFloorOf(ME, 'c1')).toBeNull();
    expect(clearedFloorOf('account-that-left', 'c1')).toBeNull();
    expect(debug).toHaveBeenCalledWith('[DM] A cleared-history floor answered to an account that has signed out is dropped (removal answer)');
    applyConversationFloors([conversation({ id: 'c2', clearedUntil: FLOOR })], 'account-that-left');
    expect(clearedFloorOf(ME, 'c2')).toBeNull();

    expect(applyClearedFloor('c1', FLOOR, 'removal answer', ME)).toBe(FLOOR_MS);
    await clearedHistoryPurgesSettled();
    expect(purge.calls.map((c) => c.scopes)).toEqual([['c1']]);
  });

  it('logout drops the floors and what was owed', async () => {
    purge.answer = async () => ({ removed: 0, marked: [] });
    applyClearedFloor('c1', FLOOR, 'test');
    await clearedHistoryPurgesSettled();

    resetClearedHistory();

    expect(clearedFloorOf(ME, 'c1')).toBeNull();
    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(1);
  });
});

describe('the list\'s `cleared`: the floors of the removed conversations it leaves out', () => {
  it('each entry is applied like any floor (one walk for them together); a floor already known this session costs nothing at the next list', async () => {
    const cleared = [{ conversationId: 'c8', clearedUntil: at(5) }, { conversationId: 'c9', clearedUntil: FLOOR }];

    applyClearedList(cleared, ME);
    await clearedHistoryPurgesSettled();
    expect(clearedFloorOf(ME, 'c8')).toBe(FLOOR_MS + 5);
    expect(clearedFloorOf(ME, 'c9')).toBe(FLOOR_MS);
    expect(purge.calls.map((c) => c.scopes)).toEqual([['c8', 'c9']]);
    expect(purge.calls[0].opts.levels).toEqual(new Map([['c8', FLOOR_MS + 5], ['c9', FLOOR_MS]]));

    // the next list of the session names the same floors: no walk, no vault read
    applyClearedList(cleared, ME);
    await clearedHistoryPurgesSettled();
    expect(purge.calls).toHaveLength(1);
  });

  it('absent: nothing, silently; not a list: one warning; malformed entries: one warning for the list, the good ones applied', async () => {
    applyClearedList(undefined);
    applyClearedList(null);
    expect(warn).not.toHaveBeenCalled();

    applyClearedList({ conversationId: 'c1', clearedUntil: FLOOR });
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a malformed list of cleared conversations');
    expect(clearedFloorOf(ME, 'c1')).toBeNull();

    warn.mockClear();
    applyClearedList([null, 'c1', { conversationId: 'c2' }, { conversationId: 'c3', clearedUntil: FLOOR }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[DM] Ignoring malformed entries of the list of cleared conversations');
    expect(clearedFloorOf(ME, 'c3')).toBe(FLOOR_MS);
  });

  it('a secure channel\'s scope in the list is ignored; at most DM_CLEARED_LIST_MAX entries are read; another account\'s answer applies nothing', async () => {
    applyClearedList([{ conversationId: 'ch:chan-1', clearedUntil: FLOOR }]);
    expect(clearedFloorOf(ME, 'ch:chan-1')).toBeNull();

    const many = Array.from({ length: DM_CLEARED_LIST_MAX + 1 }, (_, i) => ({ conversationId: `k${i}`, clearedUntil: FLOOR }));
    applyClearedList(many, ME);
    expect(clearedFloorOf(ME, `k${DM_CLEARED_LIST_MAX - 1}`)).toBe(FLOOR_MS);
    expect(clearedFloorOf(ME, `k${DM_CLEARED_LIST_MAX}`)).toBeNull();

    vi.spyOn(console, 'debug').mockImplementation(() => {});
    applyClearedList([{ conversationId: 'z1', clearedUntil: FLOOR }], 'account-that-left');
    expect(clearedFloorOf(ME, 'z1')).toBeNull();
    await clearedHistoryPurgesSettled();
  });
});

describe('the conversations that enter the store', () => {
  it('applyConversationFloors applies every clearedUntil a list carries, and only those', async () => {
    applyConversationFloors([
      conversation({ id: 'c1', clearedUntil: FLOOR }),
      conversation({ id: 'c2' }),
      conversation({ id: 'c3', clearedUntil: at(7) }),
    ]);
    await clearedHistoryPurgesSettled();

    expect(clearedFloorOf(ME, 'c1')).toBe(FLOOR_MS);
    expect(clearedFloorOf(ME, 'c2')).toBeNull();
    expect(clearedFloorOf(ME, 'c3')).toBe(FLOOR_MS + 7);
    expect(purge.calls.flatMap((c) => c.scopes).sort()).toEqual(['c1', 'c3']);
  });

  it('withoutClearedPreview: a last message at or below the known floor is no preview; above it, or with no floor, the conversation is as it was', () => {
    applyClearedFloor('c1', FLOOR, 'test');
    const last = { id: 'm1', content: '', encrypted: true, type: 'user' as const, authorId: 'u2' };

    expect(withoutClearedPreview(conversation({ lastMessage: { ...last, createdAt: FLOOR } })).lastMessage).toBeNull();
    const above = conversation({ lastMessage: { ...last, createdAt: at(1) } });
    expect(withoutClearedPreview(above)).toBe(above);
    const elsewhere = conversation({ id: 'c2', lastMessage: { ...last, createdAt: FLOOR } });
    expect(withoutClearedPreview(elsewhere)).toBe(elsewhere);
  });
});

describe('the registry\'s own line', () => {
  it('raiseClearedFloor refuses a secure channel\'s scope (or any id OPAQUE_ID_RE refuses) whoever calls it', () => {
    expect(raiseClearedFloor(ME, 'ch:chan-1', FLOOR_MS)).toBe(false);
    expect(raiseClearedFloor(ME, 'deleted:c1', FLOOR_MS)).toBe(false);
    expect(clearedFloorOf(ME, 'ch:chan-1')).toBeNull();
    expect(raiseClearedFloor(ME, 'c1', FLOOR_MS)).toBe(true);
  });
});

describe('the payloads, checked at runtime', () => {
  it('dm:conversation:deleted: an id is required; the floor is handed on unchecked (applyClearedFloor checks it)', () => {
    expect(readConversationRemovedNotice({ conversationId: 'c1' })).toEqual({ conversationId: 'c1', clearedUntil: undefined });
    expect(readConversationRemovedNotice({ conversationId: 'c1', clearedUntil: FLOOR })).toEqual({ conversationId: 'c1', clearedUntil: FLOOR });
    expect(readConversationRemovedNotice({ conversationId: 'c1', clearedUntil: 7 })).toEqual({ conversationId: 'c1', clearedUntil: 7 });
    expect(warn).not.toHaveBeenCalled();

    for (const data of [null, undefined, 'c1', {}, { conversationId: '' }, { conversationId: 5 }]) {
      warn.mockClear();
      expect(readConversationRemovedNotice(data)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[DM] Ignoring a malformed dm:conversation:deleted payload');
    }
  });

  it('the removal\'s answer: data.clearedUntil when present, nothing otherwise', () => {
    expect(removalAnswerFloor({ success: true, message: 'Conversation deleted', data: { clearedUntil: FLOOR } })).toBe(FLOOR);
    expect(removalAnswerFloor({ success: true, message: 'Conversation deleted' })).toBeUndefined();
    expect(removalAnswerFloor({ success: true, data: null })).toBeUndefined();
    expect(removalAnswerFloor({ success: true, data: 'x' })).toBeUndefined();
    expect(removalAnswerFloor(null)).toBeUndefined();
    expect(removalAnswerFloor('')).toBeUndefined();
  });
});
