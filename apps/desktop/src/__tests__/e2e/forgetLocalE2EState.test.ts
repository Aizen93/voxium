import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { forgetLocalE2EState, VAULT_DELETE_WAIT_MS } from '../../services/e2e/e2eService';
import { E2EVault, vaultDbName, type PickleKeyProvider } from '../../services/e2e/vault';

// Self-service account deletion drops this device's E2E state: the vault, then
// the pickle key that opens it (the OS credential store in the desktop app,
// localStorage in a browser or after a failed keychain write). A logout keeps
// both. Nothing here may fail the account deletion: the server side is done.

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** An in-memory key store that records what is left of the vault when its key is removed. */
function keyStore(remove?: (userId: string) => Promise<void>) {
  const vaultsAtRemoval: string[][] = [];
  const provider: PickleKeyProvider = {
    load: async () => KEY,
    save: async () => {},
    remove: vi.fn(async (userId: string) => {
      vaultsAtRemoval.push((await indexedDB.databases()).map((db) => db.name ?? ''));
      await remove?.(userId);
    }),
  };
  return { provider, vaultsAtRemoval };
}

async function vaultNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((db) => db.name ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('forgetLocalE2EState', () => {
  it('deletes the vault, then removes its key', async () => {
    const { provider, vaultsAtRemoval } = keyStore();
    const vault = new E2EVault('gone-1', provider);
    await vault.open();
    vault.close();
    expect(await vaultNames()).toContain(vaultDbName('gone-1'));

    await forgetLocalE2EState('gone-1', provider);

    expect(provider.remove).toHaveBeenCalledTimes(1);
    expect(provider.remove).toHaveBeenCalledWith('gone-1');
    // the vault was gone by the time its key went
    expect(vaultsAtRemoval[0]).not.toContain(vaultDbName('gone-1'));
    expect(await vaultNames()).not.toContain(vaultDbName('gone-1'));
  });

  it('makes the delete request before it returns', () => {
    const { provider } = keyStore();
    const drop = vi.spyOn(indexedDB, 'deleteDatabase');
    void forgetLocalE2EState('gone-2', provider);
    expect(drop).toHaveBeenCalledWith(vaultDbName('gone-2'));
  });

  it('never rejects: a key the store cannot remove is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = keyStore(async () => {
      throw new Error('keychain locked');
    });

    await expect(forgetLocalE2EState('gone-3', provider)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('e2e: could not remove the vault key of the deleted account:', 'keychain locked');
  });

  it('removes the key even when the vault cannot be deleted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const { provider } = keyStore();

    await forgetLocalE2EState('gone-4', provider);

    expect(warn).toHaveBeenCalledWith('e2e: could not drop the local vault of the deleted account:', 'storage disabled');
    expect(provider.remove).toHaveBeenCalledWith('gone-4');
  });

  it('a delete an open connection blocks: the key waits until the connection closes and the vault is gone', async () => {
    const { provider, vaultsAtRemoval } = keyStore();
    // a connection that does not let go on versionchange
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(vaultDbName('gone-5'));
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    let blocked = false;
    const deleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((name: string) => {
      const request = deleteDatabase(name);
      request.addEventListener('blocked', () => (blocked = true));
      return request;
    });

    const forgotten = forgetLocalE2EState('gone-5', provider);
    await vi.waitFor(() => expect(blocked).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.remove).not.toHaveBeenCalled();

    held.close();
    await forgotten;
    expect(provider.remove).toHaveBeenCalledWith('gone-5');
    expect(vaultsAtRemoval[0]).not.toContain(vaultDbName('gone-5'));
  });

  it(`waits at most ${VAULT_DELETE_WAIT_MS} ms for a delete request that never answers`, async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => ({}) as IDBOpenDBRequest);
    const { provider } = keyStore();

    const forgotten = forgetLocalE2EState('gone-6', provider);
    await vi.advanceTimersByTimeAsync(VAULT_DELETE_WAIT_MS - 1);
    expect(provider.remove).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await forgotten;
    expect(provider.remove).toHaveBeenCalledWith('gone-6');
    expect(warn).toHaveBeenCalledWith('e2e: the local vault of the deleted account did not answer its delete request in time');
  });
});

describe('who removes a vault key', () => {
  const SRC = join(__dirname, '..', '..') + '/';

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sources(path);
      return /\.tsx?$/.test(entry) ? [path] : [];
    });
  }

  const files = sources(SRC).map((path) => ({
    path: path.slice(SRC.length).replace(/\\/g, '/'),
    text: readFileSync(path, 'utf-8').replace(/\r\n/g, '\n'),
  }));

  /** The text of the store action `name` in authStore.ts (its implementation, after the interface), up to the next action. */
  function action(name: string): string {
    const store = files.find((f) => f.path === 'stores/authStore.ts')!.text;
    const start = store.lastIndexOf(`\n  ${name}: `);
    expect(start, name).toBeGreaterThan(-1);
    const next = store.slice(start + 1).search(/\n {2}[a-zA-Z]+: /);
    return store.slice(start, start + 1 + next);
  }

  it('only the account deletion forgets the local E2E state, never the logout', () => {
    const callers = files.filter((f) => /\bforgetLocalE2EState\(/.test(f.text) && f.path !== 'services/e2e/e2eService.ts');
    expect(callers.map((f) => f.path)).toEqual(['stores/authStore.ts']);
    expect(action('deleteAccount')).toContain('forgetLocalE2EState(userId)');
    expect(action('logout')).not.toContain('forgetLocalE2EState');
    // the store calls it once, in the deletion
    expect(callers[0].text.match(/\bforgetLocalE2EState\(/g)).toHaveLength(1);
  });

  it('the keychain delete is asked for by the key provider alone, and the provider is asked by the deletion alone', () => {
    expect(files.filter((f) => f.text.includes('e2e_pickle_key_delete')).map((f) => f.path)).toEqual([
      'services/e2e/pickleKeyProvider.ts',
    ]);
    const service = files.find((f) => f.path === 'services/e2e/e2eService.ts')!.text;
    const forget = service.slice(service.indexOf('export async function forgetLocalE2EState('));
    const body = forget.slice(0, forget.indexOf('\n}\n'));
    expect(body).toContain('await keys.remove(userId)');
    expect(service.match(/\.remove\(userId\)/g)).toHaveLength(1);
  });
});
