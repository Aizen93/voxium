// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EServiceDisposedError } from '../../services/e2e/e2eService';
import { E2EVault, type PickleKeyProvider } from '../../services/e2e/vault';

/**
 * E2EService.forgetCachedPlaintext: the display gate drops the cache entry a
 * decrypt wrote when the conversation turned read-only while it ran (the
 * conversation's purge may have walked past it). One entry, and only when it
 * is of the scope and the author the gate names; on the serial queue.
 */

const ME = 'me-forget';
let n = 0;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const keyProvider = { load: async () => key, save: async () => {}, remove: async () => {} } as PickleKeyProvider;

const live: E2EService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});
function fresh(): E2EService {
  n++;
  const service = new E2EService(ME, { api: {} as never, keyProvider, vaultNamespace: `forget-${n}` });
  live.push(service);
  return service;
}

const ids = async (service: E2EService, scope: string) =>
  (await service.searchDecrypted(scope, '')).map((h) => h.messageId).sort();

describe('E2EService.forgetCachedPlaintext', () => {
  it('drops the entry of that message when it is of that scope and author, and nothing else', async () => {
    const service = fresh();
    await service.cachePlaintext('theirs-1', 'conv-a', 'their words', null, { authorId: 'u-gone' });
    await service.cachePlaintext('theirs-2', 'conv-a', 'more of their words', null, { authorId: 'u-gone' });
    await service.cachePlaintext('mine', 'conv-a', 'my words', null, { authorId: ME });

    await service.forgetCachedPlaintext('theirs-1', { scope: 'conv-b', authorId: 'u-gone' }); // another scope: kept
    await service.forgetCachedPlaintext('theirs-1', { scope: 'conv-a', authorId: ME }); // another author: kept
    expect(await ids(service, 'conv-a')).toEqual(['mine', 'theirs-1', 'theirs-2']);

    await service.forgetCachedPlaintext('theirs-1', { scope: 'conv-a', authorId: 'u-gone' });
    await service.forgetCachedPlaintext('never-cached', { scope: 'conv-a', authorId: 'u-gone' });
    expect(await ids(service, 'conv-a')).toEqual(['mine', 'theirs-2']);
  });

  it('a removal that fails deletes the purge record of its scope (the next walk runs again), keeps the in-memory mark, and rejects', async () => {
    const service = fresh();
    await service.cachePlaintext('theirs-1', 'conv-a', 'their words', null, { authorId: 'u-gone' });
    await service.cachePlaintext('b-theirs', 'conv-b', 'other words', null, { authorId: 'u-gone' });
    await service.purgeCachedPlaintexts(['conv-a', 'conv-b'], () => false, { mark: 'read-only' });
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(true);
    await service.cachePlaintext('theirs-2', 'conv-a', 'late words', null, { authorId: 'u-gone' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(E2EVault.prototype, 'deletePlaintext').mockRejectedValueOnce(new Error('write refused'));

    await expect(service.forgetCachedPlaintext('theirs-2', { scope: 'conv-a', authorId: 'u-gone' }, { mark: 'read-only' }))
      .rejects.toThrow('write refused');
    // the gate still holds the scope read-only: the memory set feeds it alone
    expect(service.scopePurged('read-only', 'conv-a')).toBe(true);
    expect(service.scopePurged('read-only', 'conv-b')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    // the vault record is gone: the next purge walks conv-a again
    const vault = (service as unknown as { vault: E2EVault }).vault;
    expect(await vault.listPurgedScopes('read-only')).toEqual(['conv-b']);
    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');
    await service.purgeCachedPlaintexts(['conv-a', 'conv-b'], () => false, { mark: 'read-only' });
    expect([...(batch.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(['conv-a']);
  });

  it('a removal that fails while a walk of its scope runs: that walk writes no mark for it, the others are marked', async () => {
    const service = fresh();
    await service.cachePlaintext('theirs-1', 'conv-a', 'their words', null, { authorId: 'u-gone' });
    await service.cachePlaintext('b-theirs', 'conv-b', 'other words', null, { authorId: 'u-gone' });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const original = E2EVault.prototype.purgePlaintextBatch;
    vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch').mockImplementationOnce(async function (this: E2EVault, ...args) {
      const result = await original.apply(this, args);
      await held;
      return result;
    });
    vi.spyOn(E2EVault.prototype, 'deletePlaintext').mockRejectedValueOnce(new Error('write refused'));

    const walk = service.purgeCachedPlaintexts(['conv-a', 'conv-b'], () => false, { mark: 'read-only' });
    // queued behind the batch, and run before the walk decides its marks
    const forget = service.forgetCachedPlaintext('theirs-1', { scope: 'conv-a', authorId: 'u-gone' }, { mark: 'read-only' });
    release();
    await expect(forget).rejects.toThrow('write refused');
    expect(await walk).toEqual({ removed: 0, marked: ['conv-b'] });
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(false);
    expect(service.scopePurged('read-only', 'conv-b')).toBe(true);
    const vault = (service as unknown as { vault: E2EVault }).vault;
    expect(await vault.listPurgedScopes('read-only')).toEqual(['conv-b']);

    // the next walk marks it
    expect((await service.purgeCachedPlaintexts(['conv-a'], () => false, { mark: 'read-only' })).marked).toEqual(['conv-a']);
  });

  it('a removal that fails after a walk began, landing while its marks are being decided, voids them too', async () => {
    const service = fresh();
    await service.cachePlaintext('theirs-1', 'conv-a', 'their words', null, { authorId: 'u-gone' });
    vi.spyOn(E2EVault.prototype, 'deletePlaintext').mockRejectedValueOnce(new Error('write refused'));
    let forget: Promise<void> | null = null;
    // the removal is asked while the walk runs `record` (the last moment before it writes)
    const walk = service.purgeCachedPlaintexts(['conv-a'], () => false, {
      mark: 'read-only',
      record: () => {
        forget ??= service.forgetCachedPlaintext('theirs-1', { scope: 'conv-a', authorId: 'u-gone' }, { mark: 'read-only' });
        return true;
      },
    });
    expect(await walk).toEqual({ removed: 0, marked: ['conv-a'] });
    await expect(forget!).rejects.toThrow('write refused');
    // queued after the mark was written: the failed removal deleted its record (memory still holds it)
    const vault = (service as unknown as { vault: E2EVault }).vault;
    expect(await vault.listPurgedScopes('read-only')).toEqual([]);
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(true);
  });

  it('without a mark, a removal that fails clears nothing', async () => {
    const service = fresh();
    await service.cachePlaintext('theirs-1', 'conv-a', 'their words', null, { authorId: 'u-gone' });
    await service.purgeCachedPlaintexts(['conv-a'], () => false, { mark: 'read-only' });
    vi.spyOn(E2EVault.prototype, 'deletePlaintext').mockRejectedValueOnce(new Error('write refused'));
    await expect(service.forgetCachedPlaintext('theirs-1', { scope: 'conv-a', authorId: 'u-gone' })).rejects.toThrow('write refused');
    expect(await service.scopePurged('read-only', 'conv-a')).toBe(true);
  });

  it('refuses once the service is disposed', async () => {
    const service = fresh();
    await service.dispose();
    await expect(service.forgetCachedPlaintext('m', { scope: 'conv-a', authorId: 'u' })).rejects.toBeInstanceOf(E2EServiceDisposedError);
  });
});
