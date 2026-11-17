// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EServiceDisposedError, PLAINTEXT_PURGE_BATCH } from '../../services/e2e/e2eService';
import { E2EVault, type PickleKeyProvider, type PlaintextPurgeEntry } from '../../services/e2e/vault';

/**
 * The purge of the decrypted-text cache (`pt:`) for one scope: a conversation
 * whose other side's account was deleted keeps this account's own entries and
 * loses the rest. One primitive, on the service's serial queue, bounded (a
 * cursor walked a batch at a time), idempotent, deciding on an entry's author,
 * id and times only, so a later change can purge up to a time with it.
 */

const ME = 'me-purge';
let n = 0;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const keyProvider: PickleKeyProvider = { load: async () => key, save: async () => {} };

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

/** Entries of `scope`: own, the other person's, and one with no author (an older build's). */
async function seed(service: E2EService, scope: string, prefix = '') {
  await service.cachePlaintext(`${prefix}own-1`, scope, 'my first line', null, { authorId: ME, createdAt: '2026-11-01T10:00:00.000Z' });
  await service.cachePlaintext(`${prefix}theirs-1`, scope, 'their words', null, { authorId: 'u-gone', createdAt: '2026-11-01T10:01:00.000Z' });
  await service.cachePlaintext(`${prefix}own-2`, scope, 'my second line', '2026-11-02T00:00:00.000Z', { authorId: ME, createdAt: '2026-11-01T10:02:00.000Z' });
  await service.cachePlaintext(`${prefix}theirs-2`, scope, 'more of their words', null, { authorId: 'u-gone', createdAt: '2026-11-01T10:03:00.000Z' });
  await service.cachePlaintext(`${prefix}legacy`, scope, 'an old line, author unknown', null, { createdAt: '2026-01-01T00:00:00.000Z' });
}

const othersOnly = (entry: PlaintextPurgeEntry) => entry.authorId !== ME;

describe('E2EService.purgeCachedPlaintexts', () => {
  it('keeps every entry this account wrote and removes the rest of that scope (an entry without an author included)', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    // the cache is keyed by message id alone: each scope gets ids of its own
    await seed(service, 'conv-b', 'b-');
    await seed(service, 'ch:chan-1', 'c-');

    const removed = await service.purgeCachedPlaintexts('conv-a', othersOnly);

    expect(removed).toBe(3);
    const left = (await service.searchDecrypted('conv-a', '')).map((h) => h.messageId).sort();
    expect(left).toEqual(['own-1', 'own-2']);
    // own entries still answer the gate's own lookup, the edited version included
    expect(await service.getCachedPlaintext('own-2', { scope: 'conv-a', authorId: ME, editedAt: '2026-11-02T00:00:00.000Z' })).toBe('my second line');
    expect(await service.getCachedPlaintext('theirs-1', { scope: 'conv-a' })).toBeNull();
    // other scopes are untouched
    expect((await service.searchDecrypted('conv-b', '')).length).toBe(5);
    expect((await service.searchDecrypted('ch:chan-1', '')).length).toBe(5);
  });

  it('is idempotent: a second run over a purged scope removes nothing', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    expect(await service.purgeCachedPlaintexts('conv-a', othersOnly)).toBe(3);
    expect(await service.purgeCachedPlaintexts('conv-a', othersOnly)).toBe(0);
    expect((await service.searchDecrypted('conv-a', '')).map((h) => h.messageId).sort()).toEqual(['own-1', 'own-2']);
  });

  it('decides on author, id and times only: the predicate never sees the text', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    const seen: PlaintextPurgeEntry[] = [];
    await service.purgeCachedPlaintexts('conv-a', (entry) => {
      seen.push(entry);
      return false;
    });
    expect(seen).toHaveLength(5);
    for (const entry of seen) {
      expect(Object.keys(entry).every((k) => ['messageId', 'authorId', 'createdAt', 'editedAt'].includes(k))).toBe(true);
      expect(JSON.stringify(entry)).not.toMatch(/line|words/);
    }
    expect(seen.find((e) => e.messageId === 'own-2')).toEqual({
      messageId: 'own-2', authorId: ME, createdAt: '2026-11-01T10:02:00.000Z', editedAt: '2026-11-02T00:00:00.000Z',
    });
    expect(seen.find((e) => e.messageId === 'legacy')).toEqual({ messageId: 'legacy', createdAt: '2026-01-01T00:00:00.000Z', editedAt: null });
  });

  it('serves a time floor too: everything up to a time, whoever wrote it', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    const removed = await service.purgeCachedPlaintexts('conv-a', (e) => !!e.createdAt && e.createdAt <= '2026-11-01T10:01:00.000Z');
    expect(removed).toBe(3); // own-1, theirs-1, legacy
    expect((await service.searchDecrypted('conv-a', '')).map((h) => h.messageId).sort()).toEqual(['own-2', 'theirs-2']);
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

    const removed = await service.purgeCachedPlaintexts('conv-a', othersOnly);

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
    const mine = (await service.searchDecrypted('conv-a', '', total)).length;
    expect(mine).toBe(Array.from({ length: total }, (_, i) => i).filter((i) => i % 4 === 1).length);
  });

  it('refuses once the service is disposed, and removes nothing', async () => {
    const { service, namespace } = fresh();
    await seed(service, 'conv-a');
    await service.dispose();
    await expect(service.purgeCachedPlaintexts('conv-a', othersOnly)).rejects.toBeInstanceOf(E2EServiceDisposedError);
    // the vault still holds everything (a new service on the same vault reads it)
    const again = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: namespace });
    live.push(again);
    expect((await again.searchDecrypted('conv-a', '')).length).toBe(5);
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
    await expect(service.purgeCachedPlaintexts('conv-a', othersOnly)).rejects.toBeInstanceOf(E2EServiceDisposedError);
    expect(batches).toBe(1);
  });

  it('a predicate that throws aborts its batch: nothing of that batch is removed, and the failure says what failed', async () => {
    const { service } = fresh();
    await seed(service, 'conv-a');
    await expect(service.purgeCachedPlaintexts('conv-a', (e) => {
      if (e.messageId === 'theirs-2') throw new Error('predicate failed');
      return e.authorId !== ME;
    })).rejects.toThrow('predicate failed');
    expect((await service.searchDecrypted('conv-a', '')).length).toBe(5);
  });

  it('refuses an empty scope (it would name the entries of no conversation)', async () => {
    const { service } = fresh();
    await expect(service.purgeCachedPlaintexts('', othersOnly)).rejects.toThrow('a cache purge needs a scope');
  });
});
