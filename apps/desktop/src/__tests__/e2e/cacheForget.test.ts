// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EServiceDisposedError } from '../../services/e2e/e2eService';
import type { PickleKeyProvider } from '../../services/e2e/vault';

/**
 * E2EService.forgetCachedPlaintext: the display gate drops the cache entry a
 * decrypt wrote when the conversation turned read-only while it ran (the
 * conversation's purge may have walked past it). One entry, and only when it
 * is of the scope and the author the gate names; on the serial queue.
 */

const ME = 'me-forget';
let n = 0;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const keyProvider: PickleKeyProvider = { load: async () => key, save: async () => {} };

const live: E2EService[] = [];
afterEach(async () => {
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

  it('refuses once the service is disposed', async () => {
    const service = fresh();
    await service.dispose();
    await expect(service.forgetCachedPlaintext('m', { scope: 'conv-a', authorId: 'u' })).rejects.toBeInstanceOf(E2EServiceDisposedError);
  });
});
