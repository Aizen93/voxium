// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildMegolmEnvelope } from '@voxium/shared';

/**
 * A removed conversation's cleared history on this device (#47), end to end
 * over the real E2E service and vault: services/dmClearedHistory.ts applies a
 * floor, the service writes and answers nothing at or below it from that
 * moment, and one walk of the `pt:` cache removes what is there, recorded in
 * the vault under the levelled mark so a later session walks nothing for a
 * floor already purged.
 */

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

const harness = vi.hoisted(() => ({
  service: null as unknown,
  ready: true,
  error: null as string | null,
  listeners: new Set<(state: { ready: boolean; error: string | null }) => void>(),
}));

// dmClearedHistory reaches the service and the E2E store through dynamic
// imports: the service the test built, a store whose readiness the test sets
vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => {
      if (!harness.service) throw new Error('clearedHistoryCache.test: no service built');
      return harness.service;
    },
  };
});
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: {
    getState: () => ({ ready: harness.ready, error: harness.error }),
    subscribe: (listener: (state: { ready: boolean; error: string | null }) => void) => {
      harness.listeners.add(listener);
      return () => harness.listeners.delete(listener);
    },
  },
}));

import { E2EService, CLEARED_HISTORY_PURGE_MARK, PLAINTEXT_PURGE_BATCH } from '../../services/e2e/e2eService';
import type { E2EVault, PickleKeyProvider } from '../../services/e2e/vault';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { raiseClearedFloor } from '../../services/e2e/clearedFloors';
import {
  applyClearedFloor,
  clearedHistoryPurgesSettled,
  resetClearedHistory,
  retryOwedClearedPurges,
} from '../../services/dmClearedHistory';

const ME = 'me-cleared';
const OTHER = 'u-other';
const FLOOR = '2026-11-10T10:00:00.000Z';
const FLOOR_MS = Date.parse(FLOOR);
const at = (offsetMs: number) => new Date(FLOOR_MS + offsetMs).toISOString();
const ENVELOPE = buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy');

let n = 0;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const keyProvider = { load: async () => key, save: async () => {}, remove: async () => {} } as PickleKeyProvider;

const live: E2EService[] = [];
function serviceOn(namespace: string): E2EService {
  const service = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
  live.push(service);
  harness.service = service;
  return service;
}
function fresh(): { service: E2EService; namespace: string } {
  n++;
  const namespace = `cleared-${n}`;
  return { service: serviceOn(namespace), namespace };
}
const vaultOf = (service: E2EService) => (service as unknown as { vault: E2EVault }).vault;
/** What the vault really holds for a conversation (the service's own reads apply the floor). */
const stored = async (service: E2EService, scope: string) =>
  (await vaultOf(service).listPlaintexts(scope)).map((e) => e.messageId).sort();

function setReady(ready: boolean, error: string | null = null) {
  harness.ready = ready;
  harness.error = error;
  for (const listener of [...harness.listeners]) listener({ ready, error });
}

beforeEach(() => {
  registerE2ESessionUser(() => ME);
  harness.ready = true;
  harness.error = null;
  harness.listeners.clear();
});

afterEach(async () => {
  // a pass still waiting for the start (a test that failed early) applies nothing and ends
  resetClearedHistory();
  setReady(true);
  await clearedHistoryPurgesSettled();
  registerE2ESessionUser(null);
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
  harness.service = null;
});

/** The removal's floor, applied as the app applies it, and the walk it starts, settled. */
async function clear(scope: string, clearedUntil: string = FLOOR) {
  applyClearedFloor(scope, clearedUntil, 'test');
  await clearedHistoryPurgesSettled();
}

describe('the purge of a cleared history', () => {
  it('removes every entry at or below the floor, own and the other person\'s, compared as times; keeps one a millisecond above and one with no time', async () => {
    const { service } = fresh();
    await service.cachePlaintext('own-at', 'c1', 'my last line', null, { authorId: ME, createdAt: FLOOR });
    await service.cachePlaintext('theirs-below', 'c1', 'their words', null, { authorId: OTHER, createdAt: at(-60_000) });
    // the same instant as FLOOR - 1 ms, written with an offset: below as a time, above as a string
    await service.cachePlaintext('theirs-offset', 'c1', 'more words', null, { authorId: OTHER, createdAt: '2026-11-10T10:59:59.999+01:00' });
    await service.cachePlaintext('own-above', 'c1', 'written after', null, { authorId: ME, createdAt: at(1) });
    await service.cachePlaintext('theirs-above', 'c1', 'written after too', null, { authorId: OTHER, createdAt: at(1) });
    await service.cachePlaintext('no-time', 'c1', 'an entry with no time', null, { authorId: OTHER });
    await service.cachePlaintext('c2-at', 'c2', 'another conversation', null, { authorId: OTHER, createdAt: FLOOR });

    await clear('c1');

    expect(await stored(service, 'c1')).toEqual(['no-time', 'own-above', 'theirs-above']);
    expect(await stored(service, 'c2')).toEqual(['c2-at']);
  });

  it('keeps the ratchet-position bindings of what it removed (the replay firewall)', async () => {
    const { service } = fresh();
    const position = { sessionId: 'c2Vzc0lk', messageIndex: 3 };
    await service.cachePlaintext('own-at', 'c1', 'my last line', null, { authorId: ME, createdAt: FLOOR, position });

    await clear('c1');

    expect(await stored(service, 'c1')).toEqual([]);
    expect(await vaultOf(service).getMessagePosition('c2Vzc0lk', 3)).toEqual({ messageId: 'own-at', editedAt: null });
  });

  it('a floor named for a secure channel\'s scope (`ch:{id}`) is ignored: the channel\'s entries survive and still answer, its rows are never refused', async () => {
    const { service } = fresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.cachePlaintext('ch-msg', 'ch:chan-1', 'channel words', null, { authorId: OTHER, createdAt: FLOOR });
    await service.cachePlaintext('ch-own', 'ch:chan-1', 'my channel words', null, { authorId: ME, createdAt: at(-1) });

    expect(applyClearedFloor('ch:chan-1', FLOOR, 'dm:conversation:deleted')).toBeNull();
    // the registry's own line refuses it too, whoever would call it
    expect(raiseClearedFloor(ME, 'ch:chan-1', FLOOR_MS)).toBe(false);
    await clearedHistoryPurgesSettled();

    expect(warn).toHaveBeenCalledWith('[DM] Ignoring a cleared-history floor that names no direct conversation (dm:conversation:deleted)');
    expect(await stored(service, 'ch:chan-1')).toEqual(['ch-msg', 'ch-own']);
    expect(await service.getCachedPlaintext('ch-msg', { scope: 'ch:chan-1', authorId: OTHER })).toBe('channel words');
    expect((await service.searchDecrypted('ch:chan-1', 'words')).map((h) => h.messageId).sort()).toEqual(['ch-msg', 'ch-own']);
    // a channel row at that time is decrypted as before (no floor refuses it)
    const decryptGroupMessage = vi.fn(async () => ({ text: 'new channel words', position: { sessionId: 'c2Vzc0lk', messageIndex: 4 } }));
    (service as unknown as { decryptGroupMessage: unknown }).decryptGroupMessage = decryptGroupMessage;
    expect(await service.decryptMessage({ id: 'ch-new', conversationId: 'ch:chan-1', authorId: OTHER, content: ENVELOPE, createdAt: FLOOR }))
      .toEqual({ text: 'new channel words' });
  });

  it('works for a conversation nothing else on the device knows (no store is read)', async () => {
    const { service } = fresh();
    await service.cachePlaintext('m-1', 'never-listed', 'text', null, { authorId: OTHER, createdAt: FLOOR });

    await clear('never-listed');

    expect(await stored(service, 'never-listed')).toEqual([]);
  });
});

describe('from the moment a floor is known, nothing at or below it is written, in either order of the queue', () => {
  it('a send answered before the removal, its cache write still queued when the floor lands: nothing is written (the binding is)', async () => {
    const { service } = fresh();
    const position = { sessionId: 'c2Vzc0lk', messageIndex: 7 };
    // queued now, run after this tick: the floor below is known by then
    const write = service.cachePlaintext('late-own', 'c1', 'sent just before', null, { authorId: ME, createdAt: FLOOR, position });
    const above = service.cachePlaintext('later-own', 'c1', 'sent just after', null, { authorId: ME, createdAt: at(1) });
    applyClearedFloor('c1', FLOOR, 'test');
    await Promise.all([write, above]);
    await clearedHistoryPurgesSettled();

    expect(await stored(service, 'c1')).toEqual(['later-own']);
    expect(await vaultOf(service).getMessagePosition('c2Vzc0lk', 7)).toEqual({ messageId: 'late-own', editedAt: null });
  });

  it('a send whose cache write comes after the walk ended (and recorded): nothing at or below the floor is written, what is above is', async () => {
    const { service } = fresh();
    await clear('c1');
    expect(await vaultOf(service).scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS]]))).toEqual([]);

    // a POST answered before the removal, cached after it: no walk comes back
    await service.cachePlaintext('late-send', 'c1', 'answered before the removal', null, { authorId: ME, createdAt: FLOOR });
    await service.cachePlaintext('new-send', 'c1', 'after', null, { authorId: ME, createdAt: at(1) });

    expect(await stored(service, 'c1')).toEqual(['new-send']);
  });

  it('a decrypt that passed its first check before the floor landed and reaches the queue after the walk ended writes nothing', async () => {
    const { service } = fresh();
    const vault = vaultOf(service);
    const realGet = vault.getPlaintext.bind(vault);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // the decrypt's off-queue cache read is still out when the removal lands
    vi.spyOn(vault, 'getPlaintext').mockImplementationOnce(async (id: string) => {
      await held;
      return realGet(id);
    });
    (service as unknown as { decryptGroupMessage: unknown }).decryptGroupMessage = vi.fn(async () =>
      ({ text: 'their words', position: { sessionId: 'c2Vzc0lk', messageIndex: 2 } }));

    // no floor known yet: its first check passes
    const decrypt = service.decryptMessage({ id: 'slow', conversationId: 'c1', authorId: OTHER, content: ENVELOPE, createdAt: FLOOR });
    await clear('c1'); // the walk runs and records while the read is out
    release();

    expect(await decrypt).toEqual({ text: '', failed: true });
    expect(await stored(service, 'c1')).toEqual([]);
  });

  it('the other order: an entry written before the floor was known is removed by the walk', async () => {
    const { service } = fresh();
    await service.cachePlaintext('early', 'c1', 'cached before', null, { authorId: OTHER, createdAt: FLOOR });
    expect(await stored(service, 'c1')).toEqual(['early']);

    await clear('c1');

    expect(await stored(service, 'c1')).toEqual([]);
  });

  it('a write landing between two batches of the walk, behind its cursor, writes nothing (the walk would not come back for it)', async () => {
    const { service } = fresh();
    // more than one batch: the walk visits every scope's entries in key order
    for (let i = 0; i < PLAINTEXT_PURGE_BATCH + 10; i++) {
      await service.cachePlaintext(`m-${String(i).padStart(4, '0')}`, 'filler', 'x', null, { authorId: OTHER, createdAt: FLOOR });
    }
    const vault = vaultOf(service);
    const real = vault.purgePlaintextBatch.bind(vault);
    const injected: Array<Promise<void>> = [];
    const batches = vi.spyOn(vault, 'purgePlaintextBatch').mockImplementation(async (...args) => {
      const out = await real(...args);
      if (injected.length === 0) {
        // queued from inside the first batch's task: it runs before the second
        // batch, and its key ('pt:a-…') sorts before the cursor already passed
        injected.push(service.cachePlaintext('a-late', 'c1', 'decrypted late', null, { authorId: OTHER, createdAt: FLOOR }));
        injected.push(service.cachePlaintext('a-later', 'c1', 'written after the removal', null, { authorId: OTHER, createdAt: at(1) }));
      }
      return out;
    });

    await clear('c1');
    await Promise.all(injected);

    expect(batches.mock.calls.length).toBeGreaterThan(1);
    expect(await stored(service, 'c1')).toEqual(['a-later']);
    // the filler conversation was never asked for
    expect((await stored(service, 'filler')).length).toBe(PLAINTEXT_PURGE_BATCH + 10);
  });

  it('a decrypt running when the floor lands writes no entry and answers nothing; one above the floor is cached as before', async () => {
    const { service } = fresh();
    const internals = service as unknown as { decryptGroupMessage: (...args: unknown[]) => Promise<unknown> };
    internals.decryptGroupMessage = vi.fn(async () => {
      // the removal's answer lands while the ratchet step runs
      applyClearedFloor('c1', FLOOR, 'test');
      return { text: 'their words', position: { sessionId: 'c2Vzc0lk', messageIndex: 1 } };
    });

    const covered = await service.decryptMessage({ id: 'in-flight', conversationId: 'c1', authorId: OTHER, content: ENVELOPE, createdAt: FLOOR });
    const above = await service.decryptMessage({ id: 'newer', conversationId: 'c1', authorId: OTHER, content: ENVELOPE, createdAt: at(1) });
    await clearedHistoryPurgesSettled();

    expect(covered).toEqual({ text: '', failed: true });
    expect(above).toEqual({ text: 'their words' });
    expect(await stored(service, 'c1')).toEqual(['newer']);
  });

  it('a row at or below a known floor is not decrypted at all', async () => {
    const { service } = fresh();
    const decryptGroupMessage = vi.fn();
    (service as unknown as { decryptGroupMessage: unknown }).decryptGroupMessage = decryptGroupMessage;
    raiseClearedFloor(ME, 'c1', FLOOR_MS);

    const out = await service.decryptMessage({ id: 'old', conversationId: 'c1', authorId: OTHER, content: ENVELOPE, createdAt: at(-5) });

    expect(out).toEqual({ text: '', failed: true });
    expect(decryptGroupMessage).not.toHaveBeenCalled();
  });
});

describe('nothing at or below a known floor answers a cache read or local search, before the walk reaches it', () => {
  it('a preview, a quote or an own-row lookup (getCachedPlaintext) and the local search skip it; what is above still answers', async () => {
    const { service } = fresh();
    await service.cachePlaintext('own-at', 'c1', 'needle mine', null, { authorId: ME, createdAt: FLOOR });
    await service.cachePlaintext('theirs-below', 'c1', 'needle theirs', null, { authorId: OTHER, createdAt: at(-1) });
    await service.cachePlaintext('theirs-above', 'c1', 'needle newer', null, { authorId: OTHER, createdAt: at(1) });
    // known, not walked yet (the registry alone: no purge runs)
    raiseClearedFloor(ME, 'c1', FLOOR_MS);

    expect(await service.getCachedPlaintext('own-at', { scope: 'c1', authorId: ME })).toBeNull();
    expect(await service.getCachedPlaintext('theirs-below', { scope: 'c1', authorId: OTHER })).toBeNull();
    expect(await service.getCachedPlaintext('theirs-above', { scope: 'c1', authorId: OTHER })).toBe('needle newer');
    expect((await service.searchDecrypted('c1', 'needle')).map((h) => h.messageId)).toEqual(['theirs-above']);
    // still in the vault: only the walk removes
    expect(await stored(service, 'c1')).toEqual(['own-at', 'theirs-above', 'theirs-below']);
  });

  it('the decrypt\'s cache-first read never answers from an entry at or below the floor, whatever time the row claims', async () => {
    const { service } = fresh();
    await service.cachePlaintext('relabelled', 'c1', 'old words', null, { authorId: OTHER, createdAt: FLOOR });
    raiseClearedFloor(ME, 'c1', FLOOR_MS);

    // the row served with a time above the floor: the entry's own time decides
    const out = await service.decryptMessage(
      { id: 'relabelled', conversationId: 'c1', authorId: OTHER, content: ENVELOPE, createdAt: at(60_000) },
      { claimMissing: false },
    );

    expect(out).toEqual({ text: '', failed: true });
  });
});

describe('the record of a purge that ended (ptpurge:cleared:{id} holds the floor it purged up to)', () => {
  it('a later session walks nothing for the same floor or a lower one, and walks again for a higher one', async () => {
    const { service: first, namespace } = fresh();
    await first.cachePlaintext('m-1', 'c1', 'a', null, { authorId: OTHER, createdAt: FLOOR });
    await clear('c1');
    expect(await vaultOf(first).scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS]]))).toEqual([]);

    // logout, then the next session on the same vault: the floor comes again with the list
    resetClearedHistory();
    await first.dispose();
    const second = serviceOn(namespace);
    const walks = vi.spyOn(vaultOf(second), 'purgePlaintextBatch');
    await clear('c1', FLOOR);
    expect(walks).not.toHaveBeenCalled();

    resetClearedHistory();
    await clear('c1', at(-60_000));
    expect(walks).not.toHaveBeenCalled();

    // a higher floor (the conversation came back, and was removed again)
    await second.cachePlaintext('m-2', 'c1', 'b', null, { authorId: ME, createdAt: at(30_000) });
    await clear('c1', at(30_000));
    expect(walks).toHaveBeenCalled();
    expect(await stored(second, 'c1')).toEqual([]);
    expect(await vaultOf(second).scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS + 30_000]]))).toEqual([]);
  });

  it('a batch that fails records nothing and stays owed: the next list fetch walks it again', async () => {
    const { service } = fresh();
    await service.cachePlaintext('m-1', 'c1', 'a', null, { authorId: OTHER, createdAt: FLOOR });
    const vault = vaultOf(service);
    const real = vault.purgePlaintextBatch.bind(vault);
    vi.spyOn(vault, 'purgePlaintextBatch').mockRejectedValueOnce(new DOMException('disk full', 'QuotaExceededError')).mockImplementation(real);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await clear('c1');

    expect(await stored(service, 'c1')).toEqual(['m-1']);
    expect(await vault.scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS]]))).toEqual(['c1']);
    expect(warn).toHaveBeenCalledWith(
      '[DM] Could not purge the cached text of a cleared history (tried again at the next list):',
      'QuotaExceededError: disk full',
    );

    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();

    expect(await stored(service, 'c1')).toEqual([]);
    expect(await vault.scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS]]))).toEqual([]);
  });

  it('a record never moves back, and a levelled purge needs a mark and a level for every scope', async () => {
    const { service } = fresh();
    const vault = vaultOf(service);
    await vault.putScopesPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS + 10]]));
    await vault.putScopesPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS]]));
    expect(await vault.scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS + 10]]))).toEqual([]);
    expect(await vault.scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS + 11]]))).toEqual(['c1']);

    await expect(service.purgeCachedPlaintexts(['c1'], () => true, { levels: new Map([['c1', FLOOR_MS]]) })).rejects.toThrow(/needs a mark/);
    await expect(service.purgeCachedPlaintexts(['c1', 'c2'], () => true, { mark: CLEARED_HISTORY_PURGE_MARK, levels: new Map([['c1', FLOOR_MS]]) }))
      .rejects.toThrow(/a level for every scope/);
  });

  it('the read-only mark keeps its rules: a record without a level is done for it, whatever levels mean for another mark', async () => {
    const { service } = fresh();
    const vault = vaultOf(service);
    await vault.putScopesPurged('read-only', ['c1']);
    expect(await vault.scopesNotPurged('read-only', ['c1'])).toEqual([]);
    // the cleared mark is its own: nothing recorded there for c1
    expect(await vault.scopesNotPurged(CLEARED_HISTORY_PURGE_MARK, ['c1'], new Map([['c1', FLOOR_MS]]))).toEqual(['c1']);
    expect(await vault.listPurgedScopes('read-only')).toEqual(['c1']);
  });
});

describe('when the E2E service has not started', () => {
  it('the walk waits for the start, then runs (the floor is known at once meanwhile)', async () => {
    const { service } = fresh();
    await service.cachePlaintext('m-1', 'c1', 'a', null, { authorId: OTHER, createdAt: FLOOR });
    setReady(false);

    applyClearedFloor('c1', FLOOR, 'test');
    // known before any walk: nothing answers for it
    expect(await service.getCachedPlaintext('m-1', { scope: 'c1', authorId: OTHER })).toBeNull();
    expect(await stored(service, 'c1')).toEqual(['m-1']);

    setReady(true);
    await clearedHistoryPurgesSettled();

    expect(await stored(service, 'c1')).toEqual([]);
  });

  it('a start that failed leaves the walk owed; the next list fetch runs it once the service is up', async () => {
    const { service } = fresh();
    await service.cachePlaintext('m-1', 'c1', 'a', null, { authorId: OTHER, createdAt: FLOOR });
    setReady(false, 'engine failed to load');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await clear('c1');
    expect(await stored(service, 'c1')).toEqual(['m-1']);
    expect(debug).toHaveBeenCalledWith('[DM] The purge of cleared histories waits for the encryption to start');

    setReady(true);
    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();

    expect(await stored(service, 'c1')).toEqual([]);
  });
});

describe('account scope', () => {
  it('logout drops the floors and the owed walks; a pass of the account that left applies nothing', async () => {
    const { service } = fresh();
    await service.cachePlaintext('m-1', 'c1', 'a', null, { authorId: OTHER, createdAt: FLOOR });
    setReady(false);
    applyClearedFloor('c1', FLOOR, 'test');

    resetClearedHistory();
    // the floor is gone with the session that knew it
    expect(await service.getCachedPlaintext('m-1', { scope: 'c1', authorId: OTHER })).toBe('a');
    setReady(true);
    await clearedHistoryPurgesSettled();
    retryOwedClearedPurges();
    await clearedHistoryPurgesSettled();

    expect(await stored(service, 'c1')).toEqual(['m-1']);
  });

  it('a floor is the signed-in account\'s: nobody signed in applies nothing, and another account\'s service is never asked', async () => {
    const { service } = fresh();
    await service.cachePlaintext('m-1', 'c1', 'a', null, { authorId: OTHER, createdAt: FLOOR });

    registerE2ESessionUser(() => null);
    expect(applyClearedFloor('c1', FLOOR, 'test')).toBeNull();
    await clearedHistoryPurgesSettled();

    // a service of ME sees no floor another account applied
    registerE2ESessionUser(() => 'someone-else');
    applyClearedFloor('c1', FLOOR, 'test');
    // the pass is the other account's: stop it before it reaches the test's service
    resetClearedHistory();
    await clearedHistoryPurgesSettled();

    expect(await service.getCachedPlaintext('m-1', { scope: 'c1', authorId: OTHER })).toBe('a');
    expect(await stored(service, 'c1')).toEqual(['m-1']);
  });
});
