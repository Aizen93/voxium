// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireVaultOwnership,
  askVaultOwner,
  consumeTakeoverIntent,
  getVaultOwnershipState,
  noteVaultTeardown,
  registerVaultOwnershipHooks,
  releaseVaultOwnershipNotInUse,
  requestTakeoverByReload,
  requestVaultRelease,
  subscribeVaultOwnership,
  takeOverVault,
  vaultOwnershipFor,
  HANDOVER_STEAL_WAIT_MS,
  HIDDEN_START_DELAY_MS,
  OWNER_REPLY_TIMEOUT_MS,
  FENCE_START_QUERY_MS,
  LOCK_REQUEST_SETTLE_MS,
  START_CLAIM_PREFIX,
  START_CLAIM_STALE_MS,
  TAKEOVER_INTENT_KEY,
  VAULT_LOCK_PREFIX,
  vaultOwnershipModeOf,
  _resetVaultOwnershipForTests,
  _setVaultOwnershipEnvironmentForTests,
  _vaultKeyForTests,
  _vaultOwnershipPageIdForTests,
  type VaultLockManager,
} from '../../services/e2e/vaultOwnership';
import { Bus, FakeChannel, FakeLocks } from '../helpers/fakeVaultOwnership';
import { E2EVault, E2EVaultFencedError, VAULT_OWNER_KEY, stampVaultOwner, vaultDbName } from '../../services/e2e/vault';
import { registerE2ESessionUser } from '../../services/e2e/session';

// The page-level ownership of a vault (vaultOwnership.ts). The module is one
// page: THIS test process. Every other tab is played by the test itself,
// through the same fake lock manager (its own requests) and the same fake
// channel bus (a channel of its own), the way another tab's module would.

let n = 0;
let locks: FakeLocks;
let bus: Bus;
/** The other tab's end of the channel. */
let other: FakeChannel;
let visibility: 'visible' | 'hidden';
let visibilityListeners: Set<() => void>;
let pageHide: (persisted: boolean) => void;
let pageShow: (persisted: boolean) => void;
let session: Map<string, string>;
let local: Map<string, string>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let signedIn: string | null;

function storage(map: Map<string, string>) {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function install(opts: { locks?: boolean; channel?: boolean } = {}) {
  _setVaultOwnershipEnvironmentForTests({
    locks: opts.locks === false ? null : locks,
    openChannel: opts.channel === false ? null : () => new FakeChannel(bus),
    stamp: stampVaultOwner,
    visibility: () => visibility,
    watchVisibility: (onChange) => {
      visibilityListeners.add(onChange);
      return () => visibilityListeners.delete(onChange);
    },
    watchPageLifecycle: (onHide, onShow) => {
      pageHide = onHide;
      pageShow = onShow;
    },
    session: () => storage(session),
    local: () => storage(local),
    reload,
  });
}

function newUser() {
  n++;
  const userId = `owner-user-${n}`;
  return { userId, vaultName: vaultDbName(userId) };
}

/** Let the fake lock manager, the channel and IndexedDB run. */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function rawOwner(name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('kv', 'readonly').objectStore('kv').get(VAULT_OWNER_KEY);
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
    };
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase(name);
    del.onsuccess = () => resolve();
    del.onerror = () => reject(del.error);
  });
}

/** The database names IndexedDB holds now. */
async function databaseNames(): Promise<Array<string | undefined>> {
  return (await indexedDB.databases()).map((db) => db.name);
}

/** The vault's owner token deleted, the database kept (as if it had been made again without it). */
function removeOwnerToken(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(VAULT_OWNER_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/** Fake timers for the module's waits, with IndexedDB's own scheduling (setImmediate) left real. */
function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

beforeEach(() => {
  _resetVaultOwnershipForTests();
  locks = new FakeLocks();
  bus = new Bus();
  other = new FakeChannel(bus);
  visibility = 'visible';
  visibilityListeners = new Set();
  pageHide = () => {};
  pageShow = () => {};
  session = new Map();
  local = new Map();
  reload = vi.fn<() => void>();
  signedIn = null;
  registerE2ESessionUser(() => signedIn);
  install();
});

afterEach(() => {
  vi.useRealTimers();
  registerE2ESessionUser(null);
  _resetVaultOwnershipForTests();
});

describe('acquiring a vault (lock mode)', () => {
  it('takes a free vault at once, holds its lock and writes a token of its own on disk', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
    const handle = vaultOwnershipFor(userId);
    expect(handle.token()).toMatch(/^[0-9a-f]{32}$/);
    expect(await rawOwner(vaultName)).toBe(handle.token());
    expect(locks.requests).toEqual([{ name: `${VAULT_LOCK_PREFIX}${vaultName}`, ifAvailable: true, steal: undefined }]);
  });

  it('is busy while another tab owns it, waits in the queue, and takes over by itself when that tab lets go', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const tab = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await tab.granted;
    const seen: string[] = [];
    subscribeVaultOwnership(() => seen.push(getVaultOwnershipState(userId)));

    await expect(acquireVaultOwnership(userId)).resolves.toBe('busy');
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    expect(vaultOwnershipFor(userId).token()).toBeNull();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('waiting');

    tab.release(); // closed, crashed or signed out: the browser lets the lock go
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(seen.at(-1)).toBe('owned');
    // its token is written at the vault's first use, not before (the screen checks the session first)
    const handle = vaultOwnershipFor(userId);
    expect(handle.token()).toBeNull();
    expect(await rawOwner(vaultName)).toBeUndefined();
    await handle.ensure();
    expect(handle.token()).toMatch(/^[0-9a-f]{32}$/);
    expect(await rawOwner(vaultName)).toBe(handle.token());
  });

  it('writes nothing into a vault it got through the queue before its first use, over the token of the page that let go', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const stamps: string[] = [];
    _setVaultOwnershipEnvironmentForTests({
      locks,
      openChannel: () => new FakeChannel(bus),
      stamp: async (name, token, mode) => {
        stamps.push(mode);
        return stampVaultOwner(name, token, mode);
      },
      visibility: () => visibility,
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
    const tab = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await tab.granted;
    await stampVaultOwner(vaultName, 'the-page-that-lets-go', 'claim');
    await acquireVaultOwnership(userId);
    tab.release();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(stamps).toEqual([]); // an account the other page deleted is not made again here
    // the first use claims it, over the token the other page left
    await vaultOwnershipFor(userId).ensure();
    expect(stamps).toEqual(['claim']);
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
  });

  it('is single-flight per vault, and a second ask from the same page is answered from what it holds', async () => {
    const { userId } = newUser();
    signedIn = userId;
    const [a, b] = await Promise.all([acquireVaultOwnership(userId), acquireVaultOwnership(userId)]);
    expect([a, b]).toEqual(['owned', 'owned']);
    expect(await acquireVaultOwnership(userId)).toBe('owned');
    expect(locks.requests).toHaveLength(1);
  });

  it('keeps two accounts apart: one lock per vault', async () => {
    const first = newUser();
    const second = newUser();
    signedIn = first.userId;
    const tab = locks.otherTab(`${VAULT_LOCK_PREFIX}${first.vaultName}`);
    await tab.granted;
    expect(await acquireVaultOwnership(first.userId)).toBe('busy');
    expect(await acquireVaultOwnership(second.userId)).toBe('owned');
  });

  it('asks later when it starts hidden: after the delay, or as soon as it is shown', async () => {
    useFakeClock();
    const { userId } = newUser();
    signedIn = userId;
    visibility = 'hidden';
    const outcome = acquireVaultOwnership(userId, { deferWhenHidden: true });
    await vi.advanceTimersByTimeAsync(HIDDEN_START_DELAY_MS - 1);
    expect(locks.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('owned');

    const another = newUser();
    signedIn = another.userId;
    const shown = acquireVaultOwnership(another.userId, { deferWhenHidden: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(locks.requests).toHaveLength(1);
    visibility = 'visible';
    for (const listener of visibilityListeners) listener();
    await expect(shown).resolves.toBe('owned');
    expect(locks.requests).toHaveLength(2);
  });
});

describe('letting a vault go', () => {
  it('waits for the last teardown after a sign-out, then releases the lock', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    let finishTeardown = () => {};
    noteVaultTeardown(vaultName, new Promise<void>((r) => {
      finishTeardown = r;
    }));
    signedIn = null;
    releaseVaultOwnershipNotInUse();
    await settle();
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
    expect(getVaultOwnershipState(userId)).toBe('owned');

    finishTeardown();
    await settle();
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(false);
    expect(getVaultOwnershipState(userId)).toBe('none');
    expect(vaultOwnershipFor(userId).token()).toBeNull();
  });

  it('keeps it for a sign-in back to the same account during that teardown', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const token = vaultOwnershipFor(userId).token();
    let finishTeardown = () => {};
    noteVaultTeardown(vaultName, new Promise<void>((r) => {
      finishTeardown = r;
    }));
    signedIn = null;
    releaseVaultOwnershipNotInUse();
    // signed in again before the teardown ended: never "open in another tab"
    signedIn = userId;
    await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
    finishTeardown();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(vaultOwnershipFor(userId).token()).toBe(token);
    expect(locks.requests).toHaveLength(1);
  });

  it('keeps it when the page is still signed in to that account', async () => {
    const { userId } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    releaseVaultOwnershipNotInUse();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
  });

  it('waits for a teardown noted while the first one was awaited (signed out twice in a row)', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    let endFirst = () => {};
    noteVaultTeardown(vaultName, new Promise<void>((r) => {
      endFirst = r;
    }));
    signedIn = null;
    releaseVaultOwnershipNotInUse();
    // signed in again, a second service started (and stopped) before the first teardown ended
    let endSecond = () => {};
    noteVaultTeardown(vaultName, new Promise<void>((r) => {
      endSecond = r;
    }));
    endFirst();
    await settle();
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
    endSecond();
    await settle();
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(false);
  });

  it('stops waiting for a vault of an account the page signed out of', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const tab = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await tab.granted;
    await acquireVaultOwnership(userId);
    signedIn = null;
    releaseVaultOwnershipNotInUse();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('none');
    tab.release();
    await settle();
    expect(locks.held.size).toBe(0);
  });
});

describe('losing a vault', () => {
  it('to a steal: the token goes at once, the hooks then the services stop, and the vault refuses this page', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const handle = vaultOwnershipFor(userId);
    const vault = new E2EVault(userId, { load: async () => btoa('k'.repeat(32)), save: async () => {}, remove: async () => {} }, undefined, undefined, handle);
    await vault.open();
    await vault.putDeviceId('device-1');

    const order: string[] = [];
    registerVaultOwnershipHooks({ beforeLoss: (reason) => order.push(`calls:${reason}`) });
    handle.onLost(() => {
      order.push(`service:${handle.token() === null ? 'no-token' : 'token'}`);
    });

    const thief = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`, { steal: true });
    await thief.granted;
    await stampVaultOwner(vaultName, 'thief-token', 'claim');
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(order).toEqual(['calls:stolen', 'service:no-token']);
    await expect(vault.putDeviceId('device-2')).rejects.toBeInstanceOf(E2EVaultFencedError);
    // never owned again in this page: a reload is the way back
    expect(await acquireVaultOwnership(userId)).toBe('lost');
    await expect(handle.ensure()).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });
  });

  it('to a write that finds another token before the steal is heard of (the fence)', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const handle = vaultOwnershipFor(userId);
    const vault = new E2EVault(userId, { load: async () => btoa('k'.repeat(32)), save: async () => {}, remove: async () => {} }, undefined, undefined, handle);
    await vault.open();
    await stampVaultOwner(vaultName, 'another-page', 'claim');
    await expect(vault.putAccountPickle('stale')).rejects.toBeInstanceOf(E2EVaultFencedError);
    expect(getVaultOwnershipState(userId)).toBe('lost');
    await settle();
    // gave the lock up, after its (empty) teardown
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(false);
  });

  it('to a hand-over: answers at once, ends calls and services, says released, and keeps the lock for the asker’s steal', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const handle = vaultOwnershipFor(userId);
    let finishTeardown = () => {};
    handle.onLost(() => new Promise<void>((r) => {
      finishTeardown = r;
    }));
    const endCalls = vi.fn();
    registerVaultOwnershipHooks({ beforeLoss: endCalls });
    // a third tab already waits in the queue: the hand-over must not reach it
    const bystander = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);

    const vault = _vaultKeyForTests(vaultName);
    other.postMessage({ v: 1, type: 'release', vault, from: 'asker', nonce: 'n1' });
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'releasing', vault, to: 'asker', nonce: 'n1' });
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(endCalls).toHaveBeenCalledWith('released', userId);
    expect(other.received.some((m) => m.type === 'released')).toBe(false);

    finishTeardown();
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'released', vault, to: 'asker', nonce: 'n1' });
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
    const asker = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`, { steal: true });
    await asker.granted;
    await settle();
    expect(bystander.lost()).toBe(false);
    asker.release();
    await bystander.granted; // the queue gets it only after the asker
  });

  it('gives the lock to the queue when the asker does not take it', async () => {
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const waiter = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    other.postMessage({ v: 1, type: 'release', vault: _vaultKeyForTests(vaultName), from: 'gone', nonce: 'n2' });
    await vi.advanceTimersByTimeAsync(HANDOVER_STEAL_WAIT_MS - 1);
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await waiter.granted;
  });

  it('to a takeover notice in fence mode whose token is on disk, and never to its own', async () => {
    install({ locks: false });
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
    await settle();
    const vault = _vaultKeyForTests(vaultName);
    expect(other.received).toContainEqual({ v: 1, type: 'taken', vault, from: _vaultOwnershipPageIdForTests() });
    other.postMessage({ v: 1, type: 'taken', vault, from: _vaultOwnershipPageIdForTests() });
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    // a newer start claims the vault (its token on disk), then tells the other tabs
    await stampVaultOwner(vaultName, 'newer-tab-token', 'claim');
    other.postMessage({ v: 1, type: 'taken', vault, from: 'newer-tab' });
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(await rawOwner(vaultName)).toBe('newer-tab-token');
  });

  it('to a takeover notice read after the vault was deleted: gives it up, and does not make the database again', async () => {
    install({ locks: false });
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
    const handle = vaultOwnershipFor(userId);
    const stopped = vi.fn();
    handle.onLost(stopped);
    // another tab took the vault over, then deleted the account (its database
    // goes); this page reads its notice only now (it was frozen meanwhile)
    await deleteDatabase(vaultName);
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'the-tab-that-deleted-it' });
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(handle.token()).toBeNull();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(await databaseNames()).not.toContain(vaultName);

    // a vault of this page opens nothing and writes nothing from here
    const vault = new E2EVault(userId, keyProvider, undefined, undefined, handle);
    await expect(vault.putDeviceId('device-after')).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });
    expect(await databaseNames()).not.toContain(vaultName);
  });

  it('to a takeover notice whose check finds no token: gives it up, and writes none', async () => {
    install({ locks: false });
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    await removeOwnerToken(vaultName);
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'another-tab' });
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(await rawOwner(vaultName)).toBeUndefined();
  });

  it('to a takeover notice whose check cannot read the token: gives it up', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    _setVaultOwnershipEnvironmentForTests({
      locks: null,
      openChannel: () => new FakeChannel(bus),
      stamp: async (name, token, mode) => {
        if (mode === 'keep') throw new DOMException('the disk is busy', 'UnknownError');
        return stampVaultOwner(name, token, mode);
      },
      visibility: () => visibility,
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await acquireVaultOwnership(userId);
      const token = vaultOwnershipFor(userId).token();
      other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'another-tab' });
      await settle();
      expect(getVaultOwnershipState(userId)).toBe('lost');
      expect(await rawOwner(vaultName)).toBe(token); // nothing written either way
    } finally {
      warn.mockRestore();
    }
  });

  it('to the back/forward cache: lets the lock go at once, and reloads when shown from there', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    // a teardown that never ends in a frozen page: the lock does not wait for it
    const neverEnds = vi.fn(() => new Promise<void>(() => {}));
    vaultOwnershipFor(userId).onLost(neverEnds);
    pageHide(false); // an ordinary unload: the browser lets the lock go
    expect(getVaultOwnershipState(userId)).toBe('owned');
    pageHide(true);
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(neverEnds).toHaveBeenCalledTimes(1);
    await settle();
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(false);
    pageShow(false);
    expect(reload).not.toHaveBeenCalled();
    pageShow(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('answering and asking the other tabs', () => {
  it('answers which call it has running, and only for a vault it owns', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    registerVaultOwnershipHooks({ liveCall: () => 'voice' });
    const vault = _vaultKeyForTests(vaultName);
    other.postMessage({ v: 1, type: 'query', vault, from: 'asker', nonce: 'q0' });
    await settle();
    expect(other.received).toEqual([]);
    await acquireVaultOwnership(userId);
    other.postMessage({ v: 1, type: 'query', vault, from: 'asker', nonce: 'q1' });
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'status', vault, to: 'asker', nonce: 'q1', call: 'voice' });
    // malformed messages are dropped
    other.postMessage({ v: 1, type: 'query', vault, from: 42, nonce: 'q2' });
    other.postMessage({ v: 2, type: 'query', vault, from: 'asker', nonce: 'q3' });
    await settle();
    expect(other.received.filter((m) => m.type === 'status')).toHaveLength(1);
  });

  it('asks the owner for its call, and hears nothing from a tab that does not answer', async () => {
    useFakeClock();
    const { userId, vaultName } = newUser();
    other.onmessage = ({ data }) => {
      const m = data as Record<string, unknown>;
      if (m.type === 'query') other.postMessage({ v: 1, type: 'status', vault: m.vault, to: m.from, nonce: m.nonce, call: 'dm' });
    };
    const answer = askVaultOwner(userId);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ call: 'dm' });
    expect(other.received[0]).toMatchObject({ type: 'query', vault: _vaultKeyForTests(vaultName) });

    other.onmessage = null;
    const silent = askVaultOwner(userId);
    await vi.advanceTimersByTimeAsync(OWNER_REPLY_TIMEOUT_MS);
    await expect(silent).resolves.toBeNull();
  });

  it('carries no token, key or user id in any message', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    install({ locks: false });
    await acquireVaultOwnership(userId);
    other.postMessage({ v: 1, type: 'query', vault: _vaultKeyForTests(vaultName), from: 'asker', nonce: 'q' });
    await settle();
    const wire = JSON.stringify(other.received);
    expect(wire).not.toContain(userId);
    expect(wire).not.toContain(vaultOwnershipFor(userId).token() as string);
  });

  it('takes the vault over when the owner agrees and has finished: release, released, then a steal', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    other.onmessage = ({ data }) => {
      const m = data as Record<string, unknown>;
      if (m.type !== 'release') return;
      other.postMessage({ v: 1, type: 'releasing', vault: m.vault, to: m.from, nonce: m.nonce });
      other.postMessage({ v: 1, type: 'released', vault: m.vault, to: m.from, nonce: m.nonce });
    };
    await expect(requestVaultRelease(userId)).resolves.toBe('owned');
    expect(owner.lost()).toBe(true);
    expect(locks.requests.at(-1)).toMatchObject({ steal: true });
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: _vaultOwnershipPageIdForTests() });
  });

  it('reports no reply from a frozen owner, and takes over anyway on request', async () => {
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    const asked = requestVaultRelease(userId);
    await vi.advanceTimersByTimeAsync(OWNER_REPLY_TIMEOUT_MS);
    await expect(asked).resolves.toBe('noReply');
    expect(getVaultOwnershipState(userId)).toBe('waiting');

    await expect(takeOverVault(userId)).resolves.toBe('owned');
    expect(owner.lost()).toBe(true);
    // its place in the queue went with the steal: the lock is not granted twice
    owner.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(getVaultOwnershipState(userId)).toBe('owned');
  });
});

describe('without Web Locks (fence mode)', () => {
  it('claims at once, newest start wins, and tells the other tabs', async () => {
    install({ locks: false });
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await stampVaultOwner(vaultName, 'older-tab', 'claim');
    await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    expect(locks.requests).toHaveLength(0);
  });

  it('falls back to it when the lock manager throws', async () => {
    _setVaultOwnershipEnvironmentForTests({
      locks: { request: () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); } },
      openChannel: () => new FakeChannel(bus),
      stamp: stampVaultOwner,
      session: () => storage(session),
      local: () => storage(local),
      reload,
      watchPageLifecycle: () => {},
    });
    const { userId } = newUser();
    signedIn = userId;
    await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
  });

  it('makes a missing pickle key one start at a time, behind a claim in localStorage', async () => {
    install({ locks: false });
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const acquired = acquireVaultOwnership(userId);
    await vi.advanceTimersByTimeAsync(FENCE_START_QUERY_MS); // nobody answers the question first
    await expect(acquired).resolves.toBe('owned');
    const handle = vaultOwnershipFor(userId);
    const key = `${START_CLAIM_PREFIX}${_vaultKeyForTests(vaultName)}`;
    // another tab is making the key right now
    local.set(key, JSON.stringify({ id: 'other-tab', at: Date.now() }));
    const create = vi.fn(async () => 'made');
    const made = handle.serializeKeyCreation(create);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(create).not.toHaveBeenCalled();
    local.delete(key); // that start is done
    await vi.advanceTimersByTimeAsync(500);
    await expect(made).resolves.toBe('made');
    expect(create).toHaveBeenCalledTimes(1);
    expect(local.has(key)).toBe(false);

    // a claim left by a start that died is passed over
    local.set(key, JSON.stringify({ id: 'dead-tab', at: Date.now() - 60_000 }));
    const again = handle.serializeKeyCreation(async () => 'again');
    await vi.advanceTimersByTimeAsync(500);
    await expect(again).resolves.toBe('again');
  });

  it('makes the key at once in lock mode', async () => {
    const { userId } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    await expect(vaultOwnershipFor(userId).serializeKeyCreation(async () => 'now')).resolves.toBe('now');
  });
});

describe('a service start (ensure)', () => {
  it('acquires a vault no gate acquired, and a later start finds its own token and keeps it', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const handle = vaultOwnershipFor(userId);
    await expect(handle.ensure()).resolves.toBeUndefined();
    const token = handle.token();
    await expect(handle.ensure()).resolves.toBeUndefined();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(await rawOwner(vaultName)).toBe(token);
  });

  it('gives the vault up when the database was deleted under the page, and does not make it again', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const handle = vaultOwnershipFor(userId);
    await handle.ensure();
    await deleteDatabase(vaultName);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(handle.ensure()).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });
    } finally {
      warn.mockRestore();
    }
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(handle.token()).toBeNull();
    expect(await databaseNames()).not.toContain(vaultName);
  });

  it('gives the vault up when the database holds no token, and writes none', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const handle = vaultOwnershipFor(userId);
    await handle.ensure();
    await removeOwnerToken(vaultName);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(handle.ensure()).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });
    } finally {
      warn.mockRestore();
    }
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(await rawOwner(vaultName)).toBeUndefined();
  });

  it('a check that cannot read the token fails the start, and keeps the vault for the next start', async () => {
    const { userId } = newUser();
    signedIn = userId;
    let failChecks = false;
    _setVaultOwnershipEnvironmentForTests({
      locks,
      openChannel: () => new FakeChannel(bus),
      stamp: async (name, token, mode) => {
        if (failChecks && mode === 'keep') throw new DOMException('the disk is busy', 'UnknownError');
        return stampVaultOwner(name, token, mode);
      },
      visibility: () => visibility,
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
    const handle = vaultOwnershipFor(userId);
    await handle.ensure();
    failChecks = true;
    await expect(handle.ensure()).rejects.toMatchObject({ name: 'UnknownError' });
    expect(getVaultOwnershipState(userId)).toBe('owned');
    failChecks = false;
    await expect(handle.ensure()).resolves.toBeUndefined();
  });

  it('refuses while another tab owns the vault, and loses it when another page’s token is on disk', async () => {
    const busy = newUser();
    signedIn = busy.userId;
    const tab = locks.otherTab(`${VAULT_LOCK_PREFIX}${busy.vaultName}`);
    await tab.granted;
    await expect(vaultOwnershipFor(busy.userId).ensure()).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });

    const replaced = newUser();
    signedIn = replaced.userId;
    const handle = vaultOwnershipFor(replaced.userId);
    await handle.ensure();
    await stampVaultOwner(replaced.vaultName, 'someone-else', 'claim');
    await expect(handle.ensure()).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });
    expect(getVaultOwnershipState(replaced.userId)).toBe('lost');
    expect(await rawOwner(replaced.vaultName)).toBe('someone-else');
  });
});

describe('"Use it here" in a tab that lost its vault', () => {
  it('is remembered across one reload, for that account only', () => {
    const { userId } = newUser();
    requestTakeoverByReload(userId);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.has(TAKEOVER_INTENT_KEY)).toBe(true);
    expect(JSON.stringify([...session.values()])).not.toContain(userId);
    expect(consumeTakeoverIntent(userId)).toBe(true);
    expect(consumeTakeoverIntent(userId)).toBe(false);

    requestTakeoverByReload(userId);
    expect(consumeTakeoverIntent(newUser().userId)).toBe(false);
    expect(session.has(TAKEOVER_INTENT_KEY)).toBe(false);
  });

  it('is forgotten when it is old', () => {
    useFakeClock();
    const { userId } = newUser();
    requestTakeoverByReload(userId);
    vi.advanceTimersByTime(61_000);
    expect(consumeTakeoverIntent(userId)).toBe(false);
  });
});

const keyProvider = { load: async () => btoa('k'.repeat(32)), save: async () => {}, remove: async () => {} };

/** Let IndexedDB and the fakes run while the module's timers are fake (setImmediate stays real). */
async function settleImmediate(rounds = 100) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function showPage() {
  visibility = 'visible';
  for (const listener of [...visibilityListeners]) listener();
}

function hidePage() {
  visibility = 'hidden';
  for (const listener of [...visibilityListeners]) listener();
}

describe('a token write that fails at the acquisition', () => {
  it('is made at the first use, in the claiming mode, over the token of this tab’s previous page load: one tab never sees the screen', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    // what the previous page load of this tab left on disk
    await stampVaultOwner(vaultName, 'previous-page-load', 'claim');
    const stamps: string[] = [];
    let failNext = true;
    _setVaultOwnershipEnvironmentForTests({
      locks,
      openChannel: () => new FakeChannel(bus),
      stamp: async (name, token, mode) => {
        stamps.push(mode);
        if (failNext) {
          failNext = false;
          throw new DOMException('the disk is busy', 'UnknownError');
        }
        return stampVaultOwner(name, token, mode);
      },
      visibility: () => visibility,
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
      const handle = vaultOwnershipFor(userId);
      expect(handle.token()).toBeNull(); // nothing reads or writes the vault before its first use
      // the service's start: the vault opens and takes a write
      const vault = new E2EVault(userId, keyProvider, undefined, undefined, handle);
      await vault.open();
      await vault.putDeviceId('device-1');
      expect(getVaultOwnershipState(userId)).toBe('owned');
      expect(stamps).toEqual(['claim', 'claim']);
      expect(await rawOwner(vaultName)).toBe(handle.token());
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the hooks, after an account switch in this tab', () => {
  it('a question or a release about the previous account’s vault answers no call and ends nothing of the account signed in now', async () => {
    const previous = newUser();
    signedIn = previous.userId;
    await acquireVaultOwnership(previous.userId);
    // signed in to another account now; the previous account's teardown is still pending
    let finishTeardown = () => {};
    noteVaultTeardown(previous.vaultName, new Promise<void>((r) => {
      finishTeardown = r;
    }));
    const current = newUser();
    signedIn = current.userId;
    releaseVaultOwnershipNotInUse();
    const liveCall = vi.fn(() => 'voice' as const);
    const endCalls = vi.fn();
    registerVaultOwnershipHooks({ liveCall, beforeLoss: endCalls });

    const vault = _vaultKeyForTests(previous.vaultName);
    other.postMessage({ v: 1, type: 'query', vault, from: 'asker', nonce: 'q' });
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'status', vault, to: 'asker', nonce: 'q', call: 'none' });
    other.postMessage({ v: 1, type: 'release', vault, from: 'asker', nonce: 'r' });
    await settle();
    expect(getVaultOwnershipState(previous.userId)).toBe('lost');
    expect(liveCall).not.toHaveBeenCalled();
    expect(endCalls).not.toHaveBeenCalled();
    finishTeardown();
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'released', vault, to: 'asker', nonce: 'r' });
  });

  it('for the account signed in now: its call is answered and ended, the hooks given its id', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const liveCall = vi.fn(() => 'dm' as const);
    const endCalls = vi.fn();
    registerVaultOwnershipHooks({ liveCall, beforeLoss: endCalls });
    const vault = _vaultKeyForTests(vaultName);
    other.postMessage({ v: 1, type: 'query', vault, from: 'asker', nonce: 'q' });
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'status', vault, to: 'asker', nonce: 'q', call: 'dm' });
    expect(liveCall).toHaveBeenCalledWith(userId);
    other.postMessage({ v: 1, type: 'release', vault, from: 'asker', nonce: 'r' });
    await settle();
    expect(endCalls).toHaveBeenCalledWith('released', userId);
  });
});

describe('a hand-over keeps the token for the teardowns it waits for', () => {
  it('lets a teardown in flight write, starts nothing new, and clears the token before it says released', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const handle = vaultOwnershipFor(userId);
    const vault = new E2EVault(userId, keyProvider, undefined, undefined, handle);
    await vault.open();
    const token = handle.token();
    let finishTeardown = () => {};
    handle.onLost(() => new Promise<void>((r) => {
      finishTeardown = r;
    }));
    other.postMessage({ v: 1, type: 'release', vault: _vaultKeyForTests(vaultName), from: 'asker', nonce: 'n' });
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');

    // what a key-share claim in flight was handed still lands
    expect(handle.token()).toBe(token);
    await vault.putPendingShares([{ key: 'pks:2026-11-20|share-1', record: { share: { id: 'share-1' }, attempts: 0, receivedAt: Date.now(), leased: true } }]);
    // nothing new starts
    await expect(handle.ensure()).rejects.toMatchObject({ name: 'E2EVaultNotOwnedError' });
    expect(await acquireVaultOwnership(userId)).toBe('lost');
    expect(other.received.some((m) => m.type === 'released')).toBe(false);

    finishTeardown();
    await settle();
    expect(handle.token()).toBeNull();
    expect(other.received).toContainEqual({ v: 1, type: 'released', vault: _vaultKeyForTests(vaultName), to: 'asker', nonce: 'n' });
    await expect(vault.putDeviceId('after the hand-over')).rejects.toBeInstanceOf(E2EVaultFencedError);
  });

  it('a steal while it waits clears the token at once, and the asker is not told released', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const handle = vaultOwnershipFor(userId);
    let finishTeardown = () => {};
    handle.onLost(() => new Promise<void>((r) => {
      finishTeardown = r;
    }));
    other.postMessage({ v: 1, type: 'release', vault: _vaultKeyForTests(vaultName), from: 'asker', nonce: 'n' });
    await settle();
    expect(handle.token()).not.toBeNull();
    const thief = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`, { steal: true });
    await thief.granted;
    await settle();
    expect(handle.token()).toBeNull();
    finishTeardown();
    await settle();
    expect(other.received.some((m) => m.type === 'released')).toBe(false);
  });

  it.each<[string, (vaultName: string, userId: string) => Promise<void>]>([
    ['stolen', async (vaultName: string) => {
      const thief = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`, { steal: true });
      await thief.granted;
    }],
    ['fenced', async (_vaultName: string, userId: string) => {
      vaultOwnershipFor(userId).fenced();
    }],
    ['taken', async (vaultName: string) => {
      other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'another-tab' });
    }],
    ['bfcache', async () => {
      pageHide(true);
    }],
  ])('the token goes at once when the vault is %s, whatever teardown is pending', async (reason, give) => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await acquireVaultOwnership(userId);
    const handle = vaultOwnershipFor(userId);
    handle.onLost(() => new Promise<void>(() => {}));
    expect(handle.token()).not.toBeNull();
    await give(vaultName, userId);
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(handle.token()).toBeNull();
    expect(reason).toBeTruthy();
  });
});

describe('a take-over in flight: the page reads owned only while it holds the lock', () => {
  const queuedFor = (name: string) => (locks.queues.get(name) ?? []).length;

  /** The fake lock manager, whose steals reach this page's callback only once `grantSteal` is called. */
  function heldSteals() {
    let grantSteal = () => {};
    const stealGranted = new Promise<void>((r) => (grantSteal = r));
    const manager: VaultLockManager = {
      request: (name, options, callback) =>
        options.steal
          ? locks.request(name, options, async (lock) => {
            await stealGranted;
            return callback(lock);
          })
          : locks.request(name, options, callback),
    };
    return { manager, grantSteal };
  }

  function installManager(manager: VaultLockManager, stamp = stampVaultOwner) {
    _setVaultOwnershipEnvironmentForTests({
      locks: manager,
      openChannel: () => new FakeChannel(bus),
      stamp,
      visibility: () => visibility,
      watchVisibility: (onChange) => {
        visibilityListeners.add(onChange);
        return () => visibilityListeners.delete(onChange);
      },
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
  }

  it('a page hidden and shown while its steal is on its way queues nothing, and a later steal of its lock is a loss', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const name = `${VAULT_LOCK_PREFIX}${vaultName}`;
    const holder = locks.otherTab(name);
    await holder.granted;
    const steals = heldSteals();
    installManager(steals.manager);
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    expect(queuedFor(name)).toBe(1);

    const take = takeOverVault(userId);
    await settle();
    expect(queuedFor(name)).toBe(0); // its place in the queue went with the steal
    hidePage();
    showPage();
    await settle();
    expect(queuedFor(name)).toBe(0);
    steals.grantSteal();
    await expect(take).resolves.toBe('owned');
    await settle();
    expect(holder.lost()).toBe(true);
    expect(queuedFor(name)).toBe(0); // no request of this page waits behind its own lock

    // a third tab steals, saying nothing (no channel, or its message missed)
    const third = locks.otherTab(name, { steal: true });
    await third.granted;
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('lost');
    expect(vaultOwnershipFor(userId).token()).toBeNull();
    third.release();
    await settle();
    expect(locks.held.has(name)).toBe(false);
    expect(getVaultOwnershipState(userId)).toBe('lost');
  });

  it('a page shown again while it writes its token after the steal queues nothing either', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const name = `${VAULT_LOCK_PREFIX}${vaultName}`;
    const holder = locks.otherTab(name);
    await holder.granted;
    let reached = () => {};
    const atWrite = new Promise<void>((r) => (reached = r));
    let release = () => {};
    const released = new Promise<void>((r) => (release = r));
    installManager(locks, async (vault, token, mode) => {
      if (mode === 'claim') {
        reached();
        await released;
      }
      return stampVaultOwner(vault, token, mode);
    });
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    const take = takeOverVault(userId);
    await atWrite;
    hidePage();
    showPage();
    await settle();
    expect(queuedFor(name)).toBe(0);
    release();
    await expect(take).resolves.toBe('owned');
    await settle();
    expect(queuedFor(name)).toBe(0);
    expect(holder.lost()).toBe(true);
  });
});

describe('a waiting tab queues for the vault only while it is visible', () => {
  const queued = (vaultName: string) => (locks.queues.get(`${VAULT_LOCK_PREFIX}${vaultName}`) ?? []).length;

  it('the owner reloads with a hidden waiter: the reloaded page gets the vault back, the waiter keeps waiting', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    visibility = 'hidden';
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    expect(queued(vaultName)).toBe(0);

    // the reload: the old page lets go, the new page of that tab asks
    owner.release();
    const reloaded = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await reloaded.granted;
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('waiting');

    // shown later: it queues behind the reloaded owner
    showPage();
    await settle();
    expect(queued(vaultName)).toBe(1);
    expect(getVaultOwnershipState(userId)).toBe('waiting');
  });

  it('the owner reloads with a visible waiter (another window): the waiter takes the vault, as when the owner closes', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    expect(queued(vaultName)).toBe(1);
    owner.release();
    const reloaded = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(queued(vaultName)).toBe(1); // the reloaded page waits behind this one
    expect(reloaded.lost()).toBe(false);
  });

  it('the owner closes with only a hidden waiter: the waiter takes the vault once it is shown', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    visibility = 'hidden';
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    owner.release();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(false);
    showPage();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
  });

  it('a visible waiter sent to the background leaves the queue, and joins it again when shown', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    expect(queued(vaultName)).toBe(1);
    hidePage();
    await settle();
    expect(queued(vaultName)).toBe(0);
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    showPage();
    await settle();
    expect(queued(vaultName)).toBe(1);
    owner.release();
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
  });

  it('a tab that starts hidden asks after the start delay and, the vault busy, does not queue until shown', async () => {
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await vi.advanceTimersByTimeAsync(0);
    await owner.granted;
    visibility = 'hidden';
    const outcome = acquireVaultOwnership(userId, { deferWhenHidden: true });
    await vi.advanceTimersByTimeAsync(HIDDEN_START_DELAY_MS);
    await expect(outcome).resolves.toBe('busy');
    expect(queued(vaultName)).toBe(0);
    showPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued(vaultName)).toBe(1);
  });

  it('a hidden waiter that goes into the back/forward cache gives the vault up, and queues for nothing when shown', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    visibility = 'hidden';
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    pageHide(true);
    expect(getVaultOwnershipState(userId)).toBe('lost');
    showPage();
    await settle();
    expect(queued(vaultName)).toBe(0);
    pageShow(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('without Web Locks, a start asks the tab that owns the vault first', () => {
  it('claims at once when there is no channel to ask on: no wait at all', async () => {
    install({ locks: false, channel: false });
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    let outcome: string | null = null;
    void acquireVaultOwnership(userId).then((o) => (outcome = o));
    await settleImmediate(); // no fake timer is advanced
    expect(outcome).toBe('owned');
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
  });

  it('claims after FENCE_START_QUERY_MS when nobody answers', async () => {
    install({ locks: false });
    useFakeClock();
    const { userId } = newUser();
    signedIn = userId;
    let outcome: string | null = null;
    void acquireVaultOwnership(userId).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(FENCE_START_QUERY_MS - 1);
    await settleImmediate();
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settleImmediate();
    expect(outcome).toBe('owned');
    expect(other.received.map((m) => m.type)).toEqual(['query', 'taken']);
  });

  it('claims as soon as the owner says no call runs there', async () => {
    install({ locks: false });
    useFakeClock();
    other.onmessage = ({ data }) => {
      const m = data as Record<string, unknown>;
      if (m.type === 'query') other.postMessage({ v: 1, type: 'status', vault: m.vault, to: m.from, nonce: m.nonce, call: 'none' });
    };
    const { userId } = newUser();
    signedIn = userId;
    let outcome: string | null = null;
    void acquireVaultOwnership(userId).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(0);
    await settleImmediate();
    expect(outcome).toBe('owned');
  });

  it('with a call running in the owner: waits, writes nothing, tells nobody; "Use it here" then claims it', async () => {
    install({ locks: false });
    const { userId, vaultName } = newUser();
    signedIn = userId;
    await stampVaultOwner(vaultName, 'owner-tab', 'claim');
    other.onmessage = ({ data }) => {
      const m = data as Record<string, unknown>;
      if (m.type === 'query') other.postMessage({ v: 1, type: 'status', vault: m.vault, to: m.from, nonce: m.nonce, call: 'voice' });
    };
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    expect(vaultOwnershipFor(userId).token()).toBeNull();
    expect(await rawOwner(vaultName)).toBe('owner-tab');
    await settle();
    expect(other.received.map((m) => m.type)).toEqual(['query']);

    // the person agreed: the vault is claimed, and the owner told
    await expect(requestVaultRelease(userId)).resolves.toBe('owned');
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: _vaultOwnershipPageIdForTests() });
  });

  /** Our claim's write, held at `when` until released; the test plays the other start meanwhile. */
  function holdOwnClaim(when: 'before' | 'after') {
    let reached = () => {};
    const atWrite = new Promise<void>((r) => (reached = r));
    let release = () => {};
    const released = new Promise<void>((r) => (release = r));
    let held = false;
    _setVaultOwnershipEnvironmentForTests({
      locks: null,
      openChannel: () => new FakeChannel(bus),
      stamp: async (name, token, mode) => {
        if (mode !== 'claim' || held) return stampVaultOwner(name, token, mode);
        held = true;
        if (when === 'before') {
          reached();
          await released;
          return stampVaultOwner(name, token, mode);
        }
        const done = await stampVaultOwner(name, token, mode);
        reached();
        await released;
        return done;
      },
      visibility: () => visibility,
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
    return { atWrite, release };
  }

  it('two starts at once, the other one written last: this one waits instead of showing the app', async () => {
    const own = holdOwnClaim('after');
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const outcome = acquireVaultOwnership(userId);
    await own.atWrite;
    // the other start writes after this one and tells the tabs
    await stampVaultOwner(vaultName, 'other-start', 'claim');
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'other-start-page' });
    await settle();
    own.release();
    await expect(outcome).resolves.toBe('busy');
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    expect(await rawOwner(vaultName)).toBe('other-start');
    await settle();
    expect(other.received.some((m) => m.type === 'taken')).toBe(false);
  });

  it('two starts at once, this one written last: it owns the vault, and a late notice of the other changes nothing', async () => {
    const own = holdOwnClaim('before');
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const outcome = acquireVaultOwnership(userId);
    await own.atWrite;
    await stampVaultOwner(vaultName, 'other-start', 'claim');
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'other-start-page' });
    await settle();
    own.release();
    await expect(outcome).resolves.toBe('owned');
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    // the other start's notice again, after: its token is no longer on disk
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'other-start-page' });
    await settle();
    expect(getVaultOwnershipState(userId)).toBe('owned');
  });

  it.each<[string, (vaultName: string) => Promise<void>, boolean]>([
    ['the database deleted', (vaultName) => deleteDatabase(vaultName), false],
    ['no token left in it', (vaultName) => removeOwnerToken(vaultName), true],
  ])('two starts at once, the read-back finding %s: this one waits, and makes nothing again', async (_label, after, databaseKept) => {
    const own = holdOwnClaim('after');
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const outcome = acquireVaultOwnership(userId);
    await own.atWrite;
    // the other start won, and its tab deleted the account since (or the database lost the token)
    await after(vaultName);
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'other-start-page' });
    await settle();
    own.release();
    await expect(outcome).resolves.toBe('busy');
    expect(getVaultOwnershipState(userId)).toBe('waiting');
    expect(vaultOwnershipFor(userId).token()).toBeNull();
    expect((await databaseNames()).includes(vaultName)).toBe(databaseKept);
    if (databaseKept) expect(await rawOwner(vaultName)).toBeUndefined();
    await settle();
    expect(other.received.some((m) => m.type === 'taken')).toBe(false);
  });

  it('two starts at once, the read-back failing: this one waits rather than guess', async () => {
    const own = holdOwnClaim('after');
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const outcome = acquireVaultOwnership(userId);
    await own.atWrite;
    other.postMessage({ v: 1, type: 'taken', vault: _vaultKeyForTests(vaultName), from: 'other-start-page' });
    await settle();
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('the disk is busy', 'UnknownError');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      own.release();
      await expect(outcome).resolves.toBe('busy');
    } finally {
      open.mockRestore();
      warn.mockRestore();
    }
    expect(getVaultOwnershipState(userId)).toBe('waiting');
  });

  it('removes a start claim an interrupted start left behind, and keeps one in progress', async () => {
    install({ locks: false, channel: false });
    const stale = newUser();
    const staleKey = `${START_CLAIM_PREFIX}${_vaultKeyForTests(stale.vaultName)}`;
    local.set(staleKey, JSON.stringify({ id: 'a-start-that-died', at: Date.now() - START_CLAIM_STALE_MS - 1_000 }));
    signedIn = stale.userId;
    await acquireVaultOwnership(stale.userId);
    expect(local.has(staleKey)).toBe(false);

    const busy = newUser();
    const busyKey = `${START_CLAIM_PREFIX}${_vaultKeyForTests(busy.vaultName)}`;
    local.set(busyKey, JSON.stringify({ id: 'another-tab-making-its-key', at: Date.now() }));
    signedIn = busy.userId;
    await acquireVaultOwnership(busy.userId);
    expect(local.has(busyKey)).toBe(true);
  });

  it('a start with Web Locks removes a start claim left behind too, and writes none', async () => {
    const stale = newUser();
    const staleKey = `${START_CLAIM_PREFIX}${_vaultKeyForTests(stale.vaultName)}`;
    local.set(staleKey, JSON.stringify({ id: 'a-start-that-died', at: Date.now() - START_CLAIM_STALE_MS - 1_000 }));
    signedIn = stale.userId;
    await expect(acquireVaultOwnership(stale.userId)).resolves.toBe('owned');
    expect(vaultOwnershipModeOf(stale.userId)).toBe('lock');
    expect(local.has(staleKey)).toBe(false);
    await vaultOwnershipFor(stale.userId).serializeKeyCreation(async () => 'made');
    expect([...local.keys()].filter((key) => key.startsWith(START_CLAIM_PREFIX))).toEqual([]);
  });
});

describe('a lock request that does not settle', () => {
  /** A lock manager that never answers; the callbacks it was given, to grant late. */
  function hangingLocks() {
    const callbacks: Array<(lock: unknown) => unknown> = [];
    const manager: VaultLockManager = {
      request: (_name, _options, callback) => {
        callbacks.push(callback);
        return new Promise<unknown>(() => {});
      },
    };
    return { manager, callbacks };
  }

  /**
   * The fake lock manager, except that a request asking for the lock only if
   * it is free (the start's) reaches it `lateMs` later, or never (null): a
   * lock manager slow to answer that one.
   */
  function slowFirstRequest(lateMs: number | null): VaultLockManager {
    return {
      request: (name, options, callback) => {
        if (!options.ifAvailable) return locks.request(name, options, callback);
        if (lateMs === null) return new Promise<unknown>(() => {});
        return new Promise<unknown>((resolve, reject) => {
          setTimeout(() => locks.request(name, options, callback).then(resolve, reject), lateMs);
        });
      },
    };
  }

  function installLocks(manager: VaultLockManager, stamps?: string[]) {
    _setVaultOwnershipEnvironmentForTests({
      locks: manager,
      openChannel: () => new FakeChannel(bus),
      stamp: async (name, token, mode) => {
        stamps?.push(mode);
        return stampVaultOwner(name, token, mode);
      },
      visibility: () => visibility,
      watchVisibility: (onChange) => {
        visibilityListeners.add(onChange);
        return () => visibilityListeners.delete(onChange);
      },
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
  }

  it('a first request that never settles: after LOCK_REQUEST_SETTLE_MS the page waits as a second tab does, and a healthy owner keeps its vault', async () => {
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await vi.advanceTimersByTimeAsync(0);
    await owner.granted;
    await stampVaultOwner(vaultName, 'the-owner-tab', 'claim');
    const stamps: string[] = [];
    installLocks(slowFirstRequest(null), stamps);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let outcome: string | null = null;
      void acquireVaultOwnership(userId).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS - 1);
      await settleImmediate();
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await settleImmediate();
      expect(outcome).toBe('busy');
      expect(getVaultOwnershipState(userId)).toBe('waiting');
      expect(vaultOwnershipModeOf(userId)).toBe('lock');
      // nothing written, nobody told, the owner untouched
      expect(stamps).toEqual([]);
      expect(vaultOwnershipFor(userId).token()).toBeNull();
      expect(await rawOwner(vaultName)).toBe('the-owner-tab');
      expect(other.received).toEqual([]);
      expect(owner.lost()).toBe(false);
      // in the queue like any waiting tab
      expect(locks.queues.get(`${VAULT_LOCK_PREFIX}${vaultName}`)).toHaveLength(1);

      // the owner closes: the vault comes to this page through the queue, its token written at the first use
      owner.release();
      await vi.advanceTimersByTimeAsync(0);
      await settleImmediate();
      expect(getVaultOwnershipState(userId)).toBe('owned');
      expect(stamps).toEqual([]);
      await vaultOwnershipFor(userId).ensure();
      expect(stamps).toEqual(['claim']);
      expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    } finally {
      warn.mockRestore();
    }
  });

  it('a first request granted after LOCK_REQUEST_SETTLE_MS is let go at once, and changes nothing', async () => {
    useFakeClock();
    const hanging = hangingLocks();
    installLocks(hanging.manager);
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let outcome: string | null = null;
      void acquireVaultOwnership(userId).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS);
      await settleImmediate();
      expect(outcome).toBe('busy');
      // the first request, then this page's place in the queue
      expect(hanging.callbacks).toHaveLength(2);

      // granted after all: the callback holds nothing, so the lock goes at once
      expect(hanging.callbacks[0]({ name: 'late', mode: 'exclusive' })).toBeUndefined();
      expect(hanging.callbacks[0](null)).toBeUndefined();
      await settleImmediate();
      expect(getVaultOwnershipState(userId)).toBe('waiting');
      expect(vaultOwnershipFor(userId).token()).toBeNull();
      expect(await databaseNames()).not.toContain(vaultName);
    } finally {
      warn.mockRestore();
    }
  });

  it('one tab and a slow lock manager: the vault through the queue, and the late answer to the first request changes nothing', async () => {
    useFakeClock();
    installLocks(slowFirstRequest(LOCK_REQUEST_SETTLE_MS + 1_000));
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let outcome: string | null = null;
      void acquireVaultOwnership(userId).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS);
      await settleImmediate();
      expect(outcome).toBe('busy');
      // nobody holds the lock: the queued request gets it at once
      await vi.advanceTimersByTimeAsync(0);
      await settleImmediate();
      expect(getVaultOwnershipState(userId)).toBe('owned');
      expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);

      // the first request reaches the manager now: the lock is held (by this page), and nothing moves
      await vi.advanceTimersByTimeAsync(1_000);
      await settleImmediate();
      expect(getVaultOwnershipState(userId)).toBe('owned');
      expect(locks.held.has(`${VAULT_LOCK_PREFIX}${vaultName}`)).toBe(true);
      await vaultOwnershipFor(userId).ensure();
      expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    } finally {
      warn.mockRestore();
    }
  });

  it('a first request the lock manager refuses (not an abort) leaves the page in fence mode', async () => {
    _setVaultOwnershipEnvironmentForTests({
      locks: { request: () => Promise.reject(Object.assign(new Error('the lock manager is gone'), { name: 'InvalidStateError' })) },
      openChannel: null,
      stamp: stampVaultOwner,
      session: () => storage(session),
      local: () => storage(local),
      reload,
      watchPageLifecycle: () => {},
    });
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(acquireVaultOwnership(userId)).resolves.toBe('owned');
      expect(vaultOwnershipModeOf(userId)).toBe('fence');
      expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    } finally {
      warn.mockRestore();
    }
  });

  it('a take-over whose steal does not settle takes the vault by the fence alone', async () => {
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const owner = locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultName}`);
    await owner.granted;
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    useFakeClock();
    const hanging = hangingLocks();
    _setVaultOwnershipEnvironmentForTests({
      locks: hanging.manager,
      openChannel: () => new FakeChannel(bus),
      stamp: stampVaultOwner,
      visibility: () => visibility,
      watchPageLifecycle: () => {},
      session: () => storage(session),
      local: () => storage(local),
      reload,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let outcome: string | null = null;
      void takeOverVault(userId).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS);
      await settleImmediate();
      expect(outcome).toBe('owned');
      expect(vaultOwnershipModeOf(userId)).toBe('fence');
      expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
    } finally {
      warn.mockRestore();
    }
  });

  it('a queued grant that lands as the person takes over anyway, with a steal that settles late: the page keeps the vault by the fence, and its own steal landing is no loss', async () => {
    useFakeClock();
    const { userId, vaultName } = newUser();
    signedIn = userId;
    const name = `${VAULT_LOCK_PREFIX}${vaultName}`;
    const owner = locks.otherTab(name);
    await owner.granted;
    // a queued grant reaches the page's callback one task after the manager
    // decided it; a steal reaches the manager after 6 s
    const manager: VaultLockManager = {
      request: (lockName, options, callback) => {
        if (options.steal) {
          return new Promise<unknown>((resolve, reject) => {
            setTimeout(() => {
              if (options.signal?.aborted) {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                return;
              }
              locks.request(lockName, options, callback).then(resolve, reject);
            }, 6_000);
          });
        }
        if (options.ifAvailable) return locks.request(lockName, options, callback);
        return locks.request(lockName, options, (lock) => new Promise((r) => setTimeout(r, 0)).then(() => callback(lock)));
      },
    };
    installLocks(manager);
    const lost: string[] = [];
    registerVaultOwnershipHooks({ beforeLoss: (reason) => lost.push(reason) });
    expect(await acquireVaultOwnership(userId)).toBe('busy');
    owner.release();
    await settleImmediate(5); // the manager grants the queued request; its callback waits for its task
    let outcome: string | null = null;
    void takeOverVault(userId).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(0);
    await settleImmediate();
    expect(getVaultOwnershipState(userId)).toBe('owned');
    await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS + 100);
    await settleImmediate();
    expect(outcome).toBe('owned');
    expect(vaultOwnershipModeOf(userId)).toBe('fence');
    expect(locks.held.has(name)).toBe(true); // the grant the page still holds
    // the abandoned steal lands and takes the page's own grant
    await vi.advanceTimersByTimeAsync(1_000);
    await settleImmediate();
    expect(locks.held.has(name)).toBe(false);
    expect(lost).toEqual([]);
    expect(getVaultOwnershipState(userId)).toBe('owned');
    expect(vaultOwnershipModeOf(userId)).toBe('fence');
    expect(await rawOwner(vaultName)).toBe(vaultOwnershipFor(userId).token());
  });
});
