// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EServiceDisposedError, PLAINTEXT_PURGE_BATCH, PURGE_MARK_RETRY_MS } from '../../services/e2e/e2eService';
import { E2EVault, type PickleKeyProvider, type PlaintextPurgeEntry } from '../../services/e2e/vault';

/**
 * The purge of the decrypted-text cache (`pt:`) for a set of scopes: a
 * conversation whose other side's account was deleted keeps this account's own
 * entries and loses the ones another author wrote. One primitive, on the
 * service's serial queue, bounded (a cursor walked a batch at a time), one walk
 * for every scope asked together, idempotent, with an optional per-scope mark
 * in the vault so a later session skips a scope done, deciding on an entry's
 * scope, author, id and times only, so a later change can purge up to a time.
 */

const ME = 'me-purge';
let n = 0;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const keyProvider = { load: async () => key, save: async () => {}, remove: async () => {} } as PickleKeyProvider;

function makeService() {
  n++;
  const namespace = `purge-${n}`;
  const service = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
  return { service, namespace };
}

const live: E2EService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});
function fresh() {
  const made = makeService();
  live.push(made.service);
  return made;
}

/** Entries of `scope`: two own, two of the other person, and one that records no author. */
async function seed(service: E2EService, scope: string, prefix = '') {
  await service.cachePlaintext(`${prefix}own-1`, scope, 'my first line', null, { authorId: ME, createdAt: '2026-11-01T10:00:00.000Z' });
  await service.cachePlaintext(`${prefix}theirs-1`, scope, 'their words', null, { authorId: 'u-gone', createdAt: '2026-11-01T10:01:00.000Z' });
  await service.cachePlaintext(`${prefix}own-2`, scope, 'my second line', '2026-11-02T00:00:00.000Z', { authorId: ME, createdAt: '2026-11-01T10:02:00.000Z' });
  await service.cachePlaintext(`${prefix}theirs-2`, scope, 'more of their words', null, { authorId: 'u-gone', createdAt: '2026-11-01T10:03:00.000Z' });
  await service.cachePlaintext(`${prefix}no-author`, scope, 'a line that names no author', null, { createdAt: '2026-11-01T09:00:00.000Z' });
}

/** The read-only conversation's rule (services/dmReadOnly.ts): another author's entries go, an entry naming none stays. */
const othersOnly = (entry: PlaintextPurgeEntry) => entry.authorId !== undefined && entry.authorId !== ME;

const ids = async (service: E2EService, scope: string) =>
  (await service.searchDecrypted(scope, '', 10_000)).map((h) => h.messageId).sort();

describe('E2EService.purgeCachedPlaintexts', () => {
  it('keeps every entry this account wrote, and one naming no author, and removes another author\'s', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    // the cache is keyed by message id alone: each scope gets ids of its own
    await seed(service, 'conv-b', 'b-');
    await seed(service, 'ch:chan-1', 'c-');

    const { removed, marked } = await service.purgeCachedPlaintexts(['conv-a'], othersOnly);

    expect(removed).toBe(2);
    expect(marked).toEqual([]); // no mark asked for
    expect(await ids(service, 'conv-a')).toEqual(['no-author', 'own-1', 'own-2']);
    // own entries still answer the gate's own lookup, the edited version included
    expect(await service.getCachedPlaintext('own-2', { scope: 'conv-a', authorId: ME, editedAt: '2026-11-02T00:00:00.000Z' })).toBe('my second line');
    expect(await service.getCachedPlaintext('theirs-1', { scope: 'conv-a' })).toBeNull();
    // other scopes are untouched
    expect((await ids(service, 'conv-b')).length).toBe(5);
    expect((await ids(service, 'ch:chan-1')).length).toBe(5);
  });

  it('several scopes asked together are purged in ONE walk of the cache', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    await seed(service, 'conv-b', 'b-');
    await seed(service, 'conv-c', 'c-');
    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');

    const { removed } = await service.purgeCachedPlaintexts(['conv-a', 'conv-b', 'conv-a'], othersOnly);

    expect(removed).toBe(4);
    expect(batch).toHaveBeenCalledTimes(1);
    expect([...(batch.mock.calls[0][0] as ReadonlySet<string>)].sort()).toEqual(['conv-a', 'conv-b']);
    expect(await ids(service, 'conv-a')).toEqual(['no-author', 'own-1', 'own-2']);
    expect(await ids(service, 'conv-b')).toEqual(['b-no-author', 'b-own-1', 'b-own-2']);
    expect((await ids(service, 'conv-c')).length).toBe(5);
  });

  it('is idempotent: a second run over a purged scope removes nothing', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    expect((await service.purgeCachedPlaintexts(['conv-a'], othersOnly)).removed).toBe(2);
    expect((await service.purgeCachedPlaintexts(['conv-a'], othersOnly)).removed).toBe(0);
    expect(await ids(service, 'conv-a')).toEqual(['no-author', 'own-1', 'own-2']);
  });

  it('with a mark, a scope done is recorded in the vault and never walked again, in this session or the next', async () => {
    const { service, namespace } = fresh();
    await seed(service, 'conv-a');
    await seed(service, 'conv-b', 'b-');
    expect(await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' })).toEqual({ removed: 2, marked: ['conv-a'] });

    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');
    // a scope already marked still answers as marked
    expect(await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' })).toEqual({ removed: 0, marked: ['conv-a'] });
    expect(batch).not.toHaveBeenCalled();

    // a new session on the same vault: conv-a is skipped, conv-b (never done) is walked alone
    await service.dispose();
    const next = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
    live.push(next);
    expect(await next.purgeCachedPlaintexts(['conv-a', 'conv-b'], othersOnly, { mark: 'read-only' })).toEqual({ removed: 2, marked: ['conv-a', 'conv-b'] });
    expect(batch).toHaveBeenCalledTimes(1);
    expect([...(batch.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(['conv-b']);
    // a mark of another name does not skip anything
    batch.mockClear();
    await next.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'floor' });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('a purge that fails records no mark: the next run walks the scope again', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    await expect(service.purgeCachedPlaintexts(['conv-a'], () => { throw new Error('predicate failed'); }, { mark: 'read-only' }))
      .rejects.toThrow('predicate failed');
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(false);
    expect((await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' })).removed).toBe(2);
  });

  it('`record` narrows the mark to the scopes it names when the walk ends: the others are purged, not marked, and walked again', async () => {
    const { service, namespace } = fresh();
    await seed(service, 'conv-a');
    await seed(service, 'conv-b', 'b-');
    const asked: string[] = [];
    let confirmed = new Set<string>();
    const record = (scope: string) => {
      asked.push(scope);
      return confirmed.has(scope);
    };
    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch').mockImplementation(async function (this: E2EVault, ...args) {
      // confirmed while the walk runs: `record` is asked when it ends, not when it starts
      confirmed = new Set(['conv-a']);
      batch.mockRestore();
      return E2EVault.prototype.purgePlaintextBatch.apply(this, args);
    });

    expect(await service.purgeCachedPlaintexts(['conv-a', 'conv-b'], othersOnly, { mark: 'read-only', record })).toEqual({ removed: 4, marked: ['conv-a'] });
    expect(asked.sort()).toEqual(['conv-a', 'conv-b']);
    expect(await ids(service, 'conv-b')).toEqual(['b-no-author', 'b-own-1', 'b-own-2']);
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(true);
    expect(await service.scopePurged('read-only', 'conv-b')).toBe(false);

    // the next session: conv-a is skipped, conv-b is walked again, and marked once named
    await service.dispose();
    const next = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
    live.push(next);
    const again = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');
    expect(await next.purgeCachedPlaintexts(['conv-a', 'conv-b'], othersOnly, { mark: 'read-only', record: () => true })).toEqual({ removed: 0, marked: ['conv-a', 'conv-b'] });
    expect([...(again.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(['conv-b']);
  });

  it('a walk that records no scope writes no mark at all', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    const put = vi.spyOn(E2EVault.prototype, 'putScopesPurged');
    expect(await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only', record: () => false })).toEqual({ removed: 2, marked: [] });
    expect(put).not.toHaveBeenCalled();
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(false);
  });

  it('decides on scope, author, id and times only: the predicate never sees the text', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    const seen: PlaintextPurgeEntry[] = [];
    await service.purgeCachedPlaintexts(['conv-a'], (entry) => {
      seen.push(entry);
      return false;
    });
    expect(seen).toHaveLength(5);
    for (const entry of seen) {
      expect(Object.keys(entry).every((k) => ['scope', 'messageId', 'authorId', 'createdAt', 'editedAt'].includes(k))).toBe(true);
      expect(JSON.stringify(entry)).not.toMatch(/line|words/);
    }
    expect(seen.find((e) => e.messageId === 'own-2')).toEqual({
      scope: 'conv-a', messageId: 'own-2', authorId: ME, createdAt: '2026-11-01T10:02:00.000Z', editedAt: '2026-11-02T00:00:00.000Z',
    });
    expect(seen.find((e) => e.messageId === 'no-author')).toEqual({ scope: 'conv-a', messageId: 'no-author', createdAt: '2026-11-01T09:00:00.000Z', editedAt: null });
  });

  it('serves a time floor too: everything up to a time, whoever wrote it', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    const { removed } = await service.purgeCachedPlaintexts(['conv-a'], (e) => !!e.createdAt && e.createdAt <= '2026-11-01T10:01:00.000Z');
    expect(removed).toBe(3); // own-1, theirs-1, no-author
    expect(await ids(service, 'conv-a')).toEqual(['own-2', 'theirs-2']);
  });

  it('is bounded: the cache is walked a batch at a time, each batch its own queue task, never loaded whole', async () => {
    const { service } = fresh();
    const total = PLAINTEXT_PURGE_BATCH * 2 + 17;
    for (let i = 0; i < total; i++) {
      await service.cachePlaintext(`m-${String(i).padStart(5, '0')}`, i % 2 ? 'conv-a' : 'conv-b', `line ${i}`, null, {
        authorId: i % 4 === 1 ? ME : 'u-gone',
      });
    }
    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');
    const listAll = vi.spyOn(E2EVault.prototype, 'listPlaintexts');

    const { removed } = await service.purgeCachedPlaintexts(['conv-a'], othersOnly);

    // conv-a holds the odd i; those with i % 4 === 1 are mine, i % 4 === 3 theirs
    const theirs = Array.from({ length: total }, (_, i) => i).filter((i) => i % 4 === 3).length;
    expect(removed).toBe(theirs);
    expect(batch).toHaveBeenCalledTimes(3);
    for (const call of batch.mock.calls) expect(call[3]).toBe(PLAINTEXT_PURGE_BATCH);
    // each batch resumes after the key where the last one stopped
    expect(batch.mock.calls[0][2]).toBeNull();
    expect(batch.mock.calls[1][2]).toBe(`pt:m-${String(PLAINTEXT_PURGE_BATCH - 1).padStart(5, '0')}`);
    expect(listAll).not.toHaveBeenCalled();
    listAll.mockRestore();
    expect((await ids(service, 'conv-a')).length).toBe(Array.from({ length: total }, (_, i) => i).filter((i) => i % 4 === 1).length);
  });

  it('refuses once the service is disposed, and removes nothing', async () => {
    const { service, namespace } = fresh();
    await seed(service, 'conv-a');
    await service.dispose();
    await expect(service.purgeCachedPlaintexts(['conv-a'], othersOnly)).rejects.toBeInstanceOf(E2EServiceDisposedError);
    // the vault still holds everything (a new service on the same vault reads it)
    const again = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
    live.push(again);
    expect((await ids(again, 'conv-a')).length).toBe(5);
  });

  it('a dispose between two batches stops the purge at the next one', async () => {
    const { service } = fresh();
    for (let i = 0; i < PLAINTEXT_PURGE_BATCH + 5; i++) {
      await service.cachePlaintext(`m-${String(i).padStart(5, '0')}`, 'conv-a', `line ${i}`, null, { authorId: 'u-gone' });
    }
    const original = E2EVault.prototype.purgePlaintextBatch;
    let batches = 0;
    vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch').mockImplementation(function (this: E2EVault, ...args) {
      batches++;
      const run = original.apply(this, args);
      if (batches === 1) void run.then(() => service.dispose());
      return run;
    });
    await expect(service.purgeCachedPlaintexts(['conv-a'], othersOnly)).rejects.toBeInstanceOf(E2EServiceDisposedError);
    expect(batches).toBe(1);
  });

  it('a predicate that throws aborts its batch: nothing of that batch is removed, and the failure says what failed', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    await expect(service.purgeCachedPlaintexts(['conv-a'], (e) => {
      if (e.messageId === 'theirs-2') throw new Error('predicate failed');
      return othersOnly(e);
    })).rejects.toThrow('predicate failed');
    expect((await ids(service, 'conv-a')).length).toBe(5);
  });

  it('refuses no scope, an empty scope and a mark that is not a lowercase word', async () => {
    const { service } = fresh();
    await expect(service.purgeCachedPlaintexts([], othersOnly)).rejects.toThrow('a cache purge needs a scope');
    await expect(service.purgeCachedPlaintexts([''], othersOnly)).rejects.toThrow('a cache purge needs a scope');
    await expect(service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'Read Only:x' })).rejects.toThrow('a cache purge mark is a lowercase word');
  });
});

describe('E2EService.scopePurged: the marks an earlier session wrote', () => {
  it('read in ONE range read of the mark, a promise only until then, a boolean after', async () => {
    const { service, namespace } = fresh();
    await seed(service, 'conv-a');
    await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' });
    await service.dispose();

    const next = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
    live.push(next);
    const list = vi.spyOn(E2EVault.prototype, 'listPurgedScopes');
    const first = next.scopePurged('read-only', 'conv-a');
    const second = next.scopePurged('read-only', 'conv-z');
    expect(first).toBeInstanceOf(Promise);
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('read-only');
    // loaded: answered from memory
    expect(next.scopePurged('read-only', 'conv-a')).toBe(true);
    expect(next.scopePurged('read-only', 'conv-z')).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    // another mark is its own read
    expect(await next.scopePurged('floor', 'conv-a')).toBe(false);
  });

  it('a mark this service writes before its read ended is not lost by that read', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const original = E2EVault.prototype.listPurgedScopes;
    vi.spyOn(E2EVault.prototype, 'listPurgedScopes').mockImplementation(async function (this: E2EVault, mark: string) {
      const before = await original.call(this, mark); // read before the purge writes its mark
      await gate;
      return before;
    });
    const pending = service.scopePurged('read-only', 'conv-a');
    await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' });
    release();
    expect(await pending).toBe(true);
    expect(service.scopePurged('read-only', 'conv-a')).toBe(true);
  });

  it('a read that fails answers false and is logged; for 30 s every question answers false at once with no new read, then the marks are read again', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' });
    const fresher = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: `purge-${n}` });
    live.push(fresher);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // the clock only: IndexedDB keeps its own timers
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-18T10:00:00.000Z'));
      const list = vi.spyOn(E2EVault.prototype, 'listPurgedScopes').mockRejectedValueOnce(new Error('store gone'));
      expect(await fresher.scopePurged('read-only', 'conv-a')).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"read-only" purge marks could not be read'), 'store gone');

      // a failing vault costs no read per row: answered at once, until the window ends
      expect(fresher.scopePurged('read-only', 'conv-a')).toBe(false);
      vi.advanceTimersByTime(PURGE_MARK_RETRY_MS - 1);
      expect(fresher.scopePurged('read-only', 'conv-a')).toBe(false);
      expect(list).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(await fresher.scopePurged('read-only', 'conv-a')).toBe(true);
      expect(list).toHaveBeenCalledTimes(2);
      // read: from memory now
      expect(fresher.scopePurged('read-only', 'conv-a')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('E2EService.clearPurgeMarks: a list served the conversation live', () => {
  const vaultOf = (service: E2EService) => (service as unknown as { vault: E2EVault }).vault;

  it('clears the mark in memory at once and in the vault, and keeps the others', async () => {
    const { service } = fresh();
    await service.purgeCachedPlaintexts(['conv-a', 'conv-b'], othersOnly, { mark: 'read-only' });
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(true);

    const cleared = service.clearPurgeMarks('read-only', ['conv-a', 'conv-never']);
    // the gate asks before the queue gets there
    expect(service.scopePurged('read-only', 'conv-a')).toBe(false);
    await cleared;
    expect(service.scopePurged('read-only', 'conv-b')).toBe(true);
    expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual(['conv-b']);
    // the next walk of it runs again
    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');
    await service.purgeCachedPlaintexts(['conv-a', 'conv-b'], othersOnly, { mark: 'read-only' });
    expect([...(batch.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(['conv-a']);
  });

  it('a walk of the scope running when it is cleared writes no mark for it', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const original = E2EVault.prototype.purgePlaintextBatch;
    vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch').mockImplementationOnce(async function (this: E2EVault, ...args) {
      const result = await original.apply(this, args);
      await held;
      return result;
    });
    const walk = service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' });
    const cleared = service.clearPurgeMarks('read-only', ['conv-a']);
    release();
    await cleared;
    expect(await walk).toEqual({ removed: 2, marked: [] });
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(false);
    expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual([]);
  });

  it('a read of the marks in flight cannot bring a cleared scope back', async () => {
    const { service, namespace } = fresh();
    await service.purgeCachedPlaintexts(['conv-a'], othersOnly, { mark: 'read-only' });
    await service.dispose();
    const next = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
    live.push(next);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const original = E2EVault.prototype.listPurgedScopes;
    vi.spyOn(E2EVault.prototype, 'listPurgedScopes').mockImplementationOnce(async function (this: E2EVault, mark: string) {
      const before = await original.call(this, mark); // read while the mark is still there
      await held;
      return before;
    });
    const asked = next.scopePurged('read-only', 'conv-a');
    const cleared = next.clearPurgeMarks('read-only', ['conv-a']);
    release();
    await cleared;
    await asked;
    expect(next.scopePurged('read-only', 'conv-a')).toBe(false);
    expect(await vaultOf(next).listPurgedScopes('read-only')).toEqual([]);
  });

  it('refuses once the service is disposed', async () => {
    const { service } = fresh();
    await service.dispose();
    await expect(service.clearPurgeMarks('read-only', ['conv-a'])).rejects.toBeInstanceOf(E2EServiceDisposedError);
  });
});
