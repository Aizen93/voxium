import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import {
  E2EVault,
  E2EVaultClosedError,
  E2EVaultFencedError,
  E2EVaultNotOwnedError,
  VAULT_OWNER_KEY,
  stampVaultOwner,
  vaultDbName,
  type PickleKeyProvider,
  type VaultFence,
} from '../../services/e2e/vault';
import { isE2ESessionEnded } from '../../services/e2e/session';

// The fence (vault.ts): every read-write transaction of a vault compares the
// stored owner token with the page's own, in that same transaction, before it
// writes. Each test models TWO PAGES of one account on one vault: two E2EVault
// objects with one database name, each with the fence its page would give it
// (a token of its own). A takeover is the other page stamping its token, the
// way an acquisition does (stampVaultOwner 'claim').

let n = 0;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function keyProvider(): PickleKeyProvider & { saves: number; stored: string | null } {
  const provider = {
    saves: 0,
    stored: KEY as string | null,
    load: async () => provider.stored,
    save: async (_userId: string, value: string) => {
      provider.saves++;
      provider.stored = value;
    },
    remove: async () => {
      provider.stored = null;
    },
  };
  return provider;
}

interface Page {
  vault: E2EVault;
  fence: VaultFence & { owned: string | null; fencedCalls: number; serialized: number };
}

function page(userId: string, namespace: string, token: string | null, provider: PickleKeyProvider = keyProvider()): Page {
  const fence = {
    owned: token,
    fencedCalls: 0,
    serialized: 0,
    token: () => fence.owned,
    fenced: () => {
      fence.fencedCalls++;
    },
    serializeKeyCreation: <T,>(create: () => Promise<T>) => {
      fence.serialized++;
      return create();
    },
  };
  return { vault: new E2EVault(userId, provider, namespace, undefined, fence), fence };
}

/** Two pages of one account on one vault: `a` owns it, `b` is about to take it over. */
async function twoPages() {
  n++;
  const userId = `fence-user-${n}`;
  const namespace = `fence-${n}`;
  const name = vaultDbName(userId, namespace);
  await stampVaultOwner(name, 'token-a', 'claim');
  const a = page(userId, namespace, 'token-a');
  const b = page(userId, namespace, 'token-b');
  await a.vault.open();
  const takeOver = async () => {
    await stampVaultOwner(name, 'token-b', 'claim');
    await b.vault.open();
  };
  return { a, b, name, takeOver };
}

/** What the vault holds under `key`, read raw (no fence). */
function rawGet(name: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => {
        db.close();
        reject(get.error);
      };
    };
  });
}

describe('the vault fence', () => {
  it('writes for the page whose token the vault holds', async () => {
    const { a, name } = await twoPages();
    await a.vault.putAccountPickle('pickle-a');
    expect(await a.vault.getAccountPickle()).toBe('pickle-a');
    expect(await rawGet(name, VAULT_OWNER_KEY)).toBe('token-a');
    expect(a.fence.fencedCalls).toBe(0);
    a.vault.close();
  });

  it('refuses a put once another page stamped its token, writes nothing, and refuses everything after', async () => {
    const { a, b, name, takeOver } = await twoPages();
    await a.vault.putAccountPickle('pickle-a');
    await takeOver();
    await b.vault.putAccountPickle('pickle-b');

    await expect(a.vault.putAccountPickle('stale-a')).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await rawGet(name, 'account')).toBe('pickle-b');
    expect(a.fence.fencedCalls).toBe(1);
    // refused for good, reads included, and told once
    await expect(a.vault.getAccountPickle()).rejects.toMatchObject({ name: 'E2EVaultFencedError' });
    await expect(a.vault.putDeviceId('d')).rejects.toMatchObject({ name: 'E2EVaultFencedError' });
    expect(a.fence.fencedCalls).toBe(1);
    // the new owner is untouched
    expect(await b.vault.getAccountPickle()).toBe('pickle-b');
    b.vault.close();
  });

  it('refuses a prefix delete (the sessions of a user) and keeps every key under it', async () => {
    const { a, b, takeOver } = await twoPages();
    await a.vault.putSessionPickle('peer', 'dev1', 's1');
    await a.vault.putFallbackSessionPickle('peer', 'dev1', 'fb1');
    await takeOver();

    await expect(a.vault.deleteSessionsForUser('peer')).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await b.vault.getSessionPickle('peer', 'dev1')).toBe('s1');
    expect(await b.vault.getFallbackSessionPickle('peer', 'dev1')).toBe('fb1');
    // the owner's prefix delete runs as one request over the range
    await b.vault.deleteSessionsForUser('peer');
    expect(await b.vault.getSessionPickle('peer', 'dev1')).toBeUndefined();
    expect(await b.vault.getFallbackSessionPickle('peer', 'dev1')).toBeUndefined();
    b.vault.close();
  });

  it('refuses kept key shares, written as a page or one by one, and owed acknowledgements', async () => {
    const { a, b, takeOver } = await twoPages();
    await a.vault.putShareAck('cmkeyshare000000000001');
    await takeOver();

    const share = { key: 'pks:2026-11-20T10:00:00.000Z|cmkeyshare000000000009', record: { share: { id: 'cmkeyshare000000000009' }, attempts: 0, receivedAt: 1, leased: true } };
    await expect(a.vault.putPendingShares([share])).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await b.vault.listPendingShares()).toEqual([]);
    await expect(a.vault.putShareAck('cmkeyshare000000000002')).rejects.toBeInstanceOf(E2EVaultFencedError);
    await expect(a.vault.deleteShareAcks(['cmkeyshare000000000001'])).rejects.toBeInstanceOf(E2EVaultFencedError);
    // the acknowledgement the first page owed is still owed, to the new owner
    expect((await b.vault.listShareAcks()).map((ack) => ack.id)).toEqual(['cmkeyshare000000000001']);
    b.vault.close();
  });

  it('refuses the late write of a claimed page on the connection a teardown kept', async () => {
    const { a, b, takeOver } = await twoPages();
    a.vault.stopReopening();
    a.vault.closeKeepingConnectionForPendingShares();
    await takeOver();

    const share = { key: 'pks:2026-11-20T10:00:00.000Z|cmkeyshare000000000010', record: { share: { id: 'cmkeyshare000000000010' }, attempts: 0, receivedAt: 1, leased: true } };
    await expect(a.vault.writePendingSharesLate([share])).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await b.vault.listPendingShares()).toEqual([]);
    b.vault.close();
  });

  it('lets the late write through for the page that still owns the vault', async () => {
    const { a, name } = await twoPages();
    a.vault.stopReopening();
    a.vault.closeKeepingConnectionForPendingShares();
    const share = { key: 'pks:2026-11-20T10:00:00.000Z|cmkeyshare000000000011', record: { share: { id: 'cmkeyshare000000000011' }, attempts: 0, receivedAt: 1, leased: true } };
    await a.vault.writePendingSharesLate([share]);
    expect(await rawGet(name, share.key)).toEqual(share.record);
  });

  it('refuses a purge batch of the plaintext cache and the purge records', async () => {
    const { a, b, takeOver } = await twoPages();
    await a.vault.putPlaintext('m1', { conversationId: 'c1', text: 'hi', editedAt: null, authorId: 'u1' });
    await takeOver();

    await expect(a.vault.purgePlaintextBatch(new Set(['c1']), () => true, null, 10)).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await b.vault.getPlaintext('m1')).toMatchObject({ text: 'hi' });
    // a page refused once refuses the levelled record too, without reaching IndexedDB
    await expect(a.vault.putScopesPurged('cleared', ['c1'], new Map([['c1', 5]]))).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await b.vault.scopesNotPurged('cleared', ['c1'], new Map([['c1', 5]]))).toEqual(['c1']);
    b.vault.close();
  });

  it('refuses a levelled purge record on its own (the read-then-write transaction)', async () => {
    const { a, b, takeOver } = await twoPages();
    await takeOver();
    await expect(a.vault.putScopesPurged('cleared', ['c1'], new Map([['c1', 5]]))).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await b.vault.scopesNotPurged('cleared', ['c1'], new Map([['c1', 5]]))).toEqual(['c1']);
    b.vault.close();
  });

  it('refuses a write into a database made again under the page (no token at all)', async () => {
    n++;
    const userId = `fence-user-${n}`;
    const namespace = `fence-${n}`;
    const name = vaultDbName(userId, namespace);
    await stampVaultOwner(name, 'token-a', 'claim');
    const a = page(userId, namespace, 'token-a');
    await a.vault.open();
    await a.vault.putDeviceId('device-a');
    // an account deletion drops the database; the page's next access opens a new, empty one
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase(name);
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });
    await expect(a.vault.putDeviceId('device-a')).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(a.fence.fencedCalls).toBe(1);
    expect(await rawGet(name, 'device_id')).toBeUndefined();
  });

  it('refuses every write once the page gave the vault up (its token is gone)', async () => {
    const { a, name } = await twoPages();
    a.fence.owned = null;
    await expect(a.vault.putPlaintext('m1', { conversationId: 'c1', text: 'x' })).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(await rawGet(name, 'pt:m1')).toBeUndefined();
    expect(a.fence.fencedCalls).toBe(1);
  });

  it('answers a task start with a read of the token: refused for a page another one replaced', async () => {
    const { a, b, takeOver } = await twoPages();
    await expect(a.vault.assertOwner()).resolves.toBeUndefined();
    await takeOver();
    await expect(b.vault.assertOwner()).resolves.toBeUndefined();
    await expect(a.vault.assertOwner()).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(a.fence.fencedCalls).toBe(1);
    b.vault.close();
  });

  it('asks nothing of IndexedDB at a task start before the first open, only whether the page owns the vault', async () => {
    n++;
    const owner = page(`fence-user-${n}`, `fence-${n}`, 'token-a');
    const open = vi.spyOn(indexedDB, 'open');
    await expect(owner.vault.assertOwner()).resolves.toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    const stranger = page(`fence-user-${n}`, `fence-${n}`, null);
    await expect(stranger.vault.assertOwner()).rejects.toBeInstanceOf(E2EVaultFencedError);
  });

  it('opens nothing for a page that does not own the vault, and makes no pickle key for a replaced one', async () => {
    n++;
    const userId = `fence-user-${n}`;
    const namespace = `fence-${n}`;
    const name = vaultDbName(userId, namespace);
    const noKey = keyProvider();
    noKey.stored = null;
    const stranger = page(userId, namespace, null, noKey);
    await expect(stranger.vault.open()).rejects.toBeInstanceOf(E2EVaultFencedError);

    // replaced between its acquisition and its open: refused before the key is made
    await stampVaultOwner(name, 'token-b', 'claim');
    const replaced = page(userId, namespace, 'token-a', noKey);
    await expect(replaced.vault.open()).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(noKey.saves).toBe(0);
    expect(replaced.fence.serialized).toBe(0);
  });

  it('makes a missing pickle key through the ownership, once, and looks it up again first', async () => {
    n++;
    const userId = `fence-user-${n}`;
    const namespace = `fence-${n}`;
    await stampVaultOwner(vaultDbName(userId, namespace), 'token-a', 'claim');
    const provider = keyProvider();
    provider.stored = null;
    const owner = page(userId, namespace, 'token-a', provider);
    await owner.vault.open();
    expect(owner.fence.serialized).toBe(1);
    expect(provider.saves).toBe(1);
    expect(owner.vault.pickleKey()).toHaveLength(32);

    // a key another start saved while this one waited is used, not replaced
    const other = keyProvider();
    other.stored = null;
    const waiting = page(userId, `${namespace}-b`, 'token-c', other);
    await stampVaultOwner(vaultDbName(userId, `${namespace}-b`), 'token-c', 'claim');
    waiting.fence.serializeKeyCreation = <T,>(create: () => Promise<T>) => {
      other.stored = KEY;
      return create();
    };
    await waiting.vault.open();
    expect(other.saves).toBe(0);
    expect(btoa(String.fromCharCode(...waiting.vault.pickleKey()))).toBe(KEY);
  });

  it('never lets a raw IndexedDB error out once the fence refused the page', async () => {
    const { a, b, takeOver } = await twoPages();
    await a.vault.putPlaintext('m1', { conversationId: 'c1', text: 'one' });
    await takeOver();
    const results = await Promise.allSettled([
      a.vault.putPlaintext('m2', { conversationId: 'c1', text: 'two' }),
      a.vault.getPlaintext('m1'),
      a.vault.putPlaintext('m3', { conversationId: 'c1', text: 'three' }),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') expect((result.reason as Error).name).toBe('E2EVaultFencedError');
    }
    expect(results[0].status).toBe('rejected');
    expect(await b.vault.getPlaintext('m2')).toBeUndefined();
    expect(await b.vault.getPlaintext('m3')).toBeUndefined();
    b.vault.close();
  });
});

describe('the owner stamp', () => {
  /** The database names IndexedDB holds now. */
  const databaseNames = async () => (await indexedDB.databases()).map((db) => db.name);

  it('claims whatever is there, making the database when there is none', async () => {
    n++;
    const name = vaultDbName(`stamp-user-${n}`, `stamp-${n}`);
    expect(await stampVaultOwner(name, 'token-a', 'claim')).toBe('stamped');
    expect(await rawGet(name, VAULT_OWNER_KEY)).toBe('token-a');
    expect(await stampVaultOwner(name, 'token-b', 'claim')).toBe('stamped');
    expect(await rawGet(name, VAULT_OWNER_KEY)).toBe('token-b');
  });

  it('checks without writing: its own token kept, another page’s answered, and nothing written over either', async () => {
    n++;
    const name = vaultDbName(`stamp-user-${n}`, `stamp-${n}`);
    await stampVaultOwner(name, 'token-a', 'claim');
    expect(await stampVaultOwner(name, 'token-a', 'keep')).toBe('kept');
    expect(await stampVaultOwner(name, 'token-b', 'keep')).toBe('other');
    expect(await rawGet(name, VAULT_OWNER_KEY)).toBe('token-a');
  });

  it('a check never makes a database that is not there, and leaves nothing behind', async () => {
    n++;
    const name = vaultDbName(`stamp-user-${n}`, `stamp-${n}`);
    expect(await stampVaultOwner(name, 'token-a', 'keep')).toBe('missing');
    expect(await databaseNames()).not.toContain(name);
    // a later open of that name is the first one: nothing was made before it
    const oldVersion = await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      let seen = -1;
      req.onupgradeneeded = (event) => {
        seen = event.oldVersion;
        req.result.createObjectStore('kv');
      };
      req.onsuccess = () => {
        req.result.close();
        resolve(seen);
      };
      req.onerror = () => reject(req.error);
    });
    expect(oldVersion).toBe(0);
  });

  it('a check of a database that holds no token writes none', async () => {
    n++;
    const name = vaultDbName(`stamp-user-${n}`, `stamp-${n}`);
    await stampVaultOwner(name, 'token-a', 'claim');
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(VAULT_OWNER_KEY);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
      req.onerror = () => reject(req.error);
    });
    expect(await stampVaultOwner(name, 'token-a', 'keep')).toBe('missing');
    expect(await rawGet(name, VAULT_OWNER_KEY)).toBeUndefined();
  });

  it('a check rejects when the database cannot be read, and the caller decides', async () => {
    n++;
    const name = vaultDbName(`stamp-user-${n}`, `stamp-${n}`);
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('the disk is busy', 'UnknownError');
    });
    try {
      await expect(stampVaultOwner(name, 'token-a', 'keep')).rejects.toMatchObject({ name: 'UnknownError' });
    } finally {
      open.mockRestore();
    }
  });
});

describe('the errors of the fence', () => {
  it('end a session like a dispose: closed-vault errors, matched by name', () => {
    expect(new E2EVaultFencedError()).toBeInstanceOf(E2EVaultClosedError);
    expect(new E2EVaultNotOwnedError()).toBeInstanceOf(E2EVaultClosedError);
    expect(isE2ESessionEnded(new E2EVaultFencedError())).toBe(true);
    expect(isE2ESessionEnded(new E2EVaultNotOwnedError())).toBe(true);
    const copy = new Error('from another module instance');
    copy.name = 'E2EVaultFencedError';
    expect(isE2ESessionEnded(copy)).toBe(true);
  });
});
