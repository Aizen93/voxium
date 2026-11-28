// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { E2E_SCOPE_STATES_MAX } from '@voxium/shared';

/**
 * The device's sweep of its plaintext cache (services/cacheSweep.ts), over
 * the real E2E service and vault: once a day, after the E2E start and the
 * first conversation list, it walks the `pt:` cache read-only on the serial
 * queue, asks the server about each distinct scope (POST /e2e/scopes/states,
 * off the queue), and purges the cached TEXT of the scopes that are gone;
 * a floor goes through applyClearedFloor; nothing else, never a key.
 */

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

const ME = 'me-sweep';
const OTHER = 'u-other';

const harness = vi.hoisted(() => ({
  service: null as unknown,
  signedIn: 'me-sweep' as string | null,
  ready: true,
  listeners: new Set<(state: { ready: boolean }) => void>(),
  dm: { conversations: [] as Array<{ id: string }>, activeConversationId: null as string | null },
  server: { channels: [] as Array<{ id: string }>, activeChannelId: null as string | null },
  chat: { viewScope: null as { kind: 'channel' | 'conversation'; id: string } | null },
  applyClearedFloor: vi.fn<(conversationId: unknown, clearedUntil: unknown, source: string, askedBy?: string | null) => number | null>(() => null),
}));

// the service the test built, for the signed-in account only (getE2EService's own rule)
vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: (userId: string) => {
      if (!harness.service || userId !== harness.signedIn) throw new actual.E2EServiceDisposedError();
      return harness.service;
    },
  };
});
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: {
    getState: () => ({ ready: harness.ready }),
    subscribe: (listener: (state: { ready: boolean }) => void) => {
      harness.listeners.add(listener);
      return () => harness.listeners.delete(listener);
    },
  },
}));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => harness.dm } }));
vi.mock('../../stores/serverStore', () => ({ useServerStore: { getState: () => harness.server } }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => harness.chat } }));
vi.mock('../../services/dmClearedHistory', () => ({
  applyClearedFloor: (conversationId: unknown, clearedUntil: unknown, source: string, askedBy?: string | null) =>
    harness.applyClearedFloor(conversationId, clearedUntil, source, askedBy),
}));

import { E2EService, PLAINTEXT_PURGE_BATCH, SCOPE_STATES_REQUEST_TIMEOUT_MS } from '../../services/e2e/e2eService';
import { E2EVault, stampVaultOwner, type PickleKeyProvider } from '../../services/e2e/vault';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { activateSecurePins, deactivateSecurePins, isPinnedSecure, pinSecure, securePinStorageKey } from '../../utils/securePins';
import {
  CACHE_SWEEP_INTERVAL_MS,
  CACHE_SWEEP_MAX_REQUESTS,
  CACHE_SWEEP_RETRY_MS,
  cacheSweepSettled,
  noteConversationListApplied,
  resetCacheSweep,
} from '../../services/cacheSweep';

// ─── The server the service talks to ─────────────────────────────────────────

type Answer = { data: unknown };
const server = {
  /** Every POST /e2e/scopes/states, its scopes as sent. */
  posts: [] as string[][],
  /** The config each request was sent with. */
  configs: [] as unknown[],
  /** What the default answer says per scope (open when unnamed). */
  states: new Map<string, { state: string; clearedUntil?: string }>(),
  /** Replaces the default answer. */
  respond: null as null | ((scopes: string[]) => Promise<Answer>),
  /** How many queue tasks were running when each request left. */
  inTaskAtPost: [] as number[],
};
function answerFor(scopes: string[]): Answer {
  return { data: { success: true, data: scopes.map((scope) => ({ scope, ...(server.states.get(scope) ?? { state: 'open' }) })) } };
}
const fakeApi = {
  post: vi.fn(async (url: string, body: { scopes: string[] }, config?: unknown): Promise<Answer> => {
    if (url !== '/e2e/scopes/states') throw new Error(`cacheSweep.test: unexpected POST ${url}`);
    server.posts.push([...body.scopes]);
    server.configs.push(config);
    server.inTaskAtPost.push(inTask);
    return server.respond ? server.respond(body.scopes) : answerFor(body.scopes);
  }),
  get: vi.fn(async (url: string) => { throw new Error(`cacheSweep.test: unexpected GET ${url}`); }),
  put: vi.fn(async (url: string) => { throw new Error(`cacheSweep.test: unexpected PUT ${url}`); }),
  delete: vi.fn(async (url: string) => { throw new Error(`cacheSweep.test: unexpected DELETE ${url}`); }),
};
const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

// ─── The service, its queue, the raw vault ───────────────────────────────────

let n = 0;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const keyProvider = { load: async () => KEY, save: async () => {}, remove: async () => {} } as PickleKeyProvider;
const live: E2EService[] = [];
/** Queue tasks of the service running now (enqueue is wrapped: see fresh()). */
let inTask = 0;

function fresh(): E2EService {
  n++;
  const service = new E2EService(ME, { api: fakeApi as never, keyProvider, vaultNamespace: `sweep-${n}` });
  live.push(service);
  harness.service = service;
  // the serial queue, wrapped to count the tasks running: private there, read here only to watch it
  const holder = service as unknown as { enqueue: (fn: () => Promise<unknown>) => Promise<unknown> };
  const enqueue = holder.enqueue.bind(service);
  holder.enqueue = (fn) => enqueue(async () => {
    inTask++;
    try {
      return await fn();
    } finally {
      inTask--;
    }
  });
  return service;
}

const queueOf = (service: E2EService): Promise<unknown> => {
  const queue = (service as unknown as { queue?: unknown }).queue;
  // A renamed field must fail here, not turn the wait below into a no-op
  if (!(queue instanceof Promise)) throw new Error('cacheSweep.test: E2EService has no queue promise to wait for');
  return queue;
};

/** Every sweep started has settled, and the service's queue is at rest twice in a row. */
async function flushQueue(service: E2EService): Promise<void> {
  await cacheSweepSettled();
  for (let calm = 0; calm < 2; ) {
    const before = queueOf(service);
    await before;
    await new Promise((r) => setTimeout(r, 0));
    calm = queueOf(service) === before ? calm + 1 : 0;
  }
}

/** A first conversation list applied for the signed-in account, then every run it started settled. */
async function sweep(service: E2EService, askedBy: string | null = ME): Promise<void> {
  noteConversationListApplied(askedBy);
  await flushQueue(service);
}

/** A new session of the same account on the same vault (a logout and a sign-in). */
function newSession(): void {
  resetCacheSweep();
}

function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}
/** Write raw entries in one transaction (the test's own seeding, outside the service). */
async function rawPut(name: string, entries: Array<[string, unknown]>): Promise<void> {
  const db = await openRaw(name);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    for (const [key, value] of entries) tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}
/** Every key and value of the vault, read raw. */
async function rawAll(name: string): Promise<Map<string, unknown>> {
  const db = await openRaw(name);
  const out = await new Promise<Map<string, unknown>>((resolve, reject) => {
    const store = db.transaction('kv', 'readonly').objectStore('kv');
    const keys = store.getAllKeys();
    const values = store.getAll();
    values.onsuccess = () => resolve(new Map(keys.result.map((k, i): [string, unknown] => [String(k), values.result[i]])));
    values.onerror = () => reject(values.error);
  });
  db.close();
  return out;
}
const rawGet = async (name: string, key: string) => (await rawAll(name)).get(key);
/** The `pt:` keys of the vault, sorted. */
const ptKeys = async (name: string) => [...(await rawAll(name)).keys()].filter((k) => k.startsWith('pt:')).sort();

/** A cache entry as a decrypt writes it: never read by the sweep, which sees the scope alone. */
const entry = (scope: string, over: Record<string, unknown> = {}) => ({
  conversationId: scope,
  text: 'words nobody but the reader saw',
  editedAt: null,
  authorId: OTHER,
  createdAt: '2026-11-01T10:00:00.000Z',
  ...over,
});
const pad = (i: number) => String(i).padStart(5, '0');

let warn: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetCacheSweep();
  registerE2ESessionUser(() => harness.signedIn);
  harness.signedIn = ME;
  harness.ready = true;
  harness.listeners.clear();
  harness.dm = { conversations: [], activeConversationId: null };
  harness.server = { channels: [], activeChannelId: null };
  harness.chat = { viewScope: null };
  harness.applyClearedFloor.mockClear();
  server.posts = [];
  server.configs = [];
  server.states = new Map();
  server.respond = null;
  server.inTaskAtPost = [];
  inTask = 0;
  fakeApi.post.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
  resetCacheSweep();
  await cacheSweepSettled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
  harness.service = null;
  registerE2ESessionUser(null);
});

/** The warnings the sweep wrote. */
const sweepWarnings = () => warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('cache sweep'));

// ─── When ────────────────────────────────────────────────────────────────────

describe('the cache sweep — when it runs', () => {
  it('waits for the E2E start: nothing before it, one run once the store reports it ready', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    const walk = vi.spyOn(E2EVault.prototype, 'listPlaintextScopes');
    harness.ready = false;

    await sweep(service);
    expect(walk).not.toHaveBeenCalled();
    expect(server.posts).toEqual([]);
    expect(harness.listeners.size).toBe(1);

    harness.ready = true;
    for (const listener of [...harness.listeners]) listener({ ready: true });
    await flushQueue(service);
    expect(server.posts).toEqual([['conv-a']]);
    // the wait ends with the run
    expect(harness.listeners.size).toBe(0);
  });

  it('waits for the first conversation list of the session, and only for the signed-in account\'s', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    // the E2E start alone starts nothing
    for (const listener of [...harness.listeners]) listener({ ready: true });
    await flushQueue(service);
    expect(server.posts).toEqual([]);

    // a list another account asked for, or one asked for by nobody signed in
    await sweep(service, 'someone-else');
    await sweep(service, null);
    expect(server.posts).toEqual([]);

    await sweep(service, ME);
    expect(server.posts).toEqual([['conv-a']]);
  });

  it('an E2E start that lands once another account is signed in starts nothing for either', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    const reads = vi.spyOn(service, 'readCacheSweepRecord');
    harness.ready = false;
    await sweep(service);
    expect(harness.listeners.size).toBe(1);

    harness.signedIn = 'someone-else';
    harness.ready = true;
    for (const listener of [...harness.listeners]) listener({ ready: true });
    await flushQueue(service);
    // not even started: the list was the other account's
    expect(reads).not.toHaveBeenCalled();
    expect(server.posts).toEqual([]);
  });

  it('never while the device is offline: the next list asks again', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    const walk = vi.spyOn(E2EVault.prototype, 'listPlaintextScopes');
    vi.stubGlobal('navigator', { onLine: false });

    await sweep(service);
    // every store change asks again: one debug line per offline period, not one per change
    await sweep(service);
    await sweep(service);
    expect(walk).not.toHaveBeenCalled();
    expect(server.posts).toEqual([]);
    const waits = () => debug.mock.calls.filter((c: unknown[]) => String(c[0]).includes('waits for the network'));
    expect(waits()).toHaveLength(1);

    vi.stubGlobal('navigator', { onLine: true });
    await sweep(service);
    expect(server.posts).toEqual([['conv-a']]);
    expect(waits()).toHaveLength(1);
  });

  it('runs at most once per day per vault: a later list, or a later session the same day, asks nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);

    await sweep(service);
    expect(server.posts).toHaveLength(1);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: t0, after: null });

    // the same session's next list
    await sweep(service);
    // a new session the same day: the vault's record decides
    newSession();
    vi.setSystemTime(t0 + CACHE_SWEEP_INTERVAL_MS - 60_000);
    await sweep(service);
    expect(server.posts).toHaveLength(1);

    // a day later
    newSession();
    vi.setSystemTime(t0 + CACHE_SWEEP_INTERVAL_MS + 1);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('a session that outlives a day runs again at a list after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    await sweep(service);
    vi.setSystemTime(t0 + CACHE_SWEEP_INTERVAL_MS + 1);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('a record dated ahead of the clock (the clock was set back) is not recent: the sweep runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [
      ['pt:m-1', entry('conv-a')],
      ['cache_sweep', { at: t0 + 2 * 60 * 60 * 1000, after: null }],
    ]);
    await sweep(service);
    expect(server.posts).toEqual([['conv-a']]);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: t0, after: null });
  });

  it('a record this build cannot read is no record: the sweep runs, from the start', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [
      ['pt:m-1', entry('conv-a')],
      ['cache_sweep', { at: 'yesterday', after: 'pt:m-9' }],
    ]);
    await sweep(service);
    expect(server.posts).toEqual([['conv-a']]);
  });
});

// ─── What it asks about ──────────────────────────────────────────────────────

describe('the cache sweep — the walk and the requests', () => {
  it('collects the distinct scopes in read-only batches on the serial queue, and asks off the queue', async () => {
    const service = fresh();
    const scopes = ['conv-a', 'conv-b', 'ch:chan-1', 'conv-c'];
    const total = PLAINTEXT_PURGE_BATCH * 2 + 17;
    const seeded: Array<[string, unknown]> = [];
    for (let i = 0; i < total; i++) seeded.push([`pt:m-${pad(i)}`, entry(scopes[i % scopes.length])]);
    // what the route does not take is never asked about: a voice scope, a malformed one, none at all
    seeded.push(['pt:m-x1', entry('chv:chan-1')], ['pt:m-x2', entry('a scope')], ['pt:m-x3', { text: 'no scope' }]);
    await rawPut(service.vaultName, seeded);
    // the vault opened (its owner token written) before the transactions are counted
    await service.readCacheSweepRecord();

    const original = E2EVault.prototype.listPlaintextScopes;
    const batches: Array<{ after: string | null; limit: number; inTask: number }> = [];
    vi.spyOn(E2EVault.prototype, 'listPlaintextScopes').mockImplementation(function (this: E2EVault, after, limit) {
      batches.push({ after, limit, inTask });
      return original.call(this, after, limit);
    });
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');

    await sweep(service);

    expect(batches.map((b) => b.after)).toEqual([null, `pt:m-${pad(PLAINTEXT_PURGE_BATCH - 1)}`, `pt:m-${pad(PLAINTEXT_PURGE_BATCH * 2 - 1)}`]);
    expect(batches.every((b) => b.limit === PLAINTEXT_PURGE_BATCH && b.inTask === 1)).toBe(true);
    // the walk itself wrote nothing: every read-write transaction of the run is the record's write
    const readwrite = transactions.mock.calls.filter((c) => c[1] === 'readwrite');
    expect(readwrite).toHaveLength(1);
    // one request, every distinct scope once, off the queue, bounded
    expect(server.posts).toEqual([scopes]);
    expect(server.inTaskAtPost).toEqual([0]);
    expect(server.configs).toEqual([{ timeout: SCOPE_STATES_REQUEST_TIMEOUT_MS }]);
  });

  it(`asks ${E2E_SCOPE_STATES_MAX} scopes a request and ${CACHE_SWEEP_MAX_REQUESTS} requests a run, resumes where it stopped, then starts over`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    const perRun = CACHE_SWEEP_MAX_REQUESTS * E2E_SCOPE_STATES_MAX;
    const count = perRun + 150;
    // one scope per entry, a second entry of the first scope at the very end
    const seeded: Array<[string, unknown]> = Array.from({ length: count }, (_, i) => [`pt:m-${pad(i)}`, entry(`c-${pad(i)}`)]);
    seeded.push([`pt:m-${pad(count)}`, entry('c-00000')]);
    await rawPut(service.vaultName, seeded);

    await sweep(service);
    expect(server.posts).toHaveLength(CACHE_SWEEP_MAX_REQUESTS);
    expect(server.posts.every((p) => p.length === E2E_SCOPE_STATES_MAX)).toBe(true);
    expect(server.posts.flat()).toEqual(Array.from({ length: perRun }, (_, i) => `c-${pad(i)}`));
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: t0, after: `pt:m-${pad(perRun - 1)}` });

    // the next day: the rest, then the walk reaches the end
    server.posts = [];
    newSession();
    vi.setSystemTime(t0 + CACHE_SWEEP_INTERVAL_MS + 1);
    await sweep(service);
    expect(server.posts.map((p) => p.length)).toEqual([100, 51]);
    expect(server.posts.flat()).toEqual([...Array.from({ length: 150 }, (_, i) => `c-${pad(perRun + i)}`), 'c-00000']);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: t0 + CACHE_SWEEP_INTERVAL_MS + 1, after: null });

    // and the day after, from the start again
    server.posts = [];
    newSession();
    vi.setSystemTime(t0 + 2 * CACHE_SWEEP_INTERVAL_MS + 2);
    await sweep(service);
    expect(server.posts).toHaveLength(CACHE_SWEEP_MAX_REQUESTS);
    expect(server.posts[0][0]).toBe('c-00000');
  });

  it('an empty cache asks nothing and records the day', async () => {
    const service = fresh();
    await sweep(service);
    expect(server.posts).toEqual([]);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toMatchObject({ after: null });
  });
});

// ─── Which answer is used ────────────────────────────────────────────────────

describe('the cache sweep — an answer is used only when it names exactly the scopes asked', () => {
  const FLOOR = '2026-11-20T10:00:00.000Z';
  const reply = (data: unknown, success: unknown = true) => async (): Promise<Answer> => ({ data: { success, data } });

  it.each([
    ['missing a scope', reply([{ scope: 'conv-a', state: 'gone' }])],
    ['naming an extra one', reply([{ scope: 'conv-a', state: 'gone' }, { scope: 'ch:chan-b', state: 'gone' }, { scope: 'conv-x', state: 'gone' }])],
    ['naming one twice', reply([{ scope: 'conv-a', state: 'gone' }, { scope: 'conv-a', state: 'gone' }])],
    ['naming one not asked', reply([{ scope: 'conv-a', state: 'gone' }, { scope: 'conv-x', state: 'gone' }])],
    ['with an unknown state', reply([{ scope: 'conv-a', state: 'deleted' }, { scope: 'ch:chan-b', state: 'gone' }])],
    ['with no state', reply([{ scope: 'conv-a' }, { scope: 'ch:chan-b', state: 'gone' }])],
    ['with a clearedUntil on a channel', reply([{ scope: 'conv-a', state: 'gone' }, { scope: 'ch:chan-b', state: 'open', clearedUntil: FLOOR }])],
    ['with a clearedUntil on a gone scope', reply([{ scope: 'conv-a', state: 'gone', clearedUntil: FLOOR }, { scope: 'ch:chan-b', state: 'gone' }])],
    ['with a scope that is not a string', reply([{ scope: 1, state: 'gone' }, { scope: 'ch:chan-b', state: 'gone' }])],
    ['with an entry that is not an object', reply(['conv-a', { scope: 'ch:chan-b', state: 'gone' }])],
    ['not marked a success', reply([{ scope: 'conv-a', state: 'gone' }, { scope: 'ch:chan-b', state: 'gone' }], false)],
    ['whose data is not a list', reply({ 'conv-a': 'gone', 'ch:chan-b': 'gone' })],
    ['that is not an object', async (): Promise<Answer> => ({ data: 'gone' })],
  ])('an answer %s is dropped whole: nothing purged, no floor applied, the failure recorded (not the day)', async (_what, respond) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a', { authorId: ME })], ['pt:m-2', entry('ch:chan-b')], ['pt:m-3', entry('conv-a')]]);
    server.respond = respond;

    await sweep(service);

    expect(server.posts).toEqual([['conv-a', 'ch:chan-b']]);
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1', 'pt:m-2', 'pt:m-3']);
    expect(harness.applyClearedFloor).not.toHaveBeenCalled();
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: null, failedAt: t0 });
    expect(sweepWarnings()).toHaveLength(1);
    expect(String(sweepWarnings()[0][1])).toContain('dropped an answer');

    // not tried again before the retry time; then it is
    await sweep(service);
    expect(server.posts).toHaveLength(1);
    server.respond = null;
    vi.setSystemTime(t0 + CACHE_SWEEP_RETRY_MS + 1);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('an answer naming the scopes asked in another order is used', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')], ['pt:m-2', entry('ch:chan-b')]]);
    server.respond = async () => ({ data: { success: true, data: [{ scope: 'ch:chan-b', state: 'open' }, { scope: 'conv-a', state: 'gone' }] } });
    await sweep(service);
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-2']);
  });

  it('a 404 is a server without the route: the day is recorded, from the same key, and nothing is purged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [
      ['pt:m-1', entry('conv-a')],
      ['pt:m-2', entry('conv-b')],
      ['cache_sweep', { at: t0 - CACHE_SWEEP_INTERVAL_MS - 1, after: 'pt:m-1' }],
    ]);
    server.respond = async () => { throw httpError(404); };

    await sweep(service);

    expect(server.posts).toEqual([['conv-b']]);
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1', 'pt:m-2']);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: t0, after: 'pt:m-1' });
    expect(sweepWarnings()).toEqual([]);
    // not asked again before tomorrow
    newSession();
    await sweep(service);
    expect(server.posts).toHaveLength(1);
  });

  it('any other failure records its time, not the day: tried again after the retry time, in the same session too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    server.states.set('conv-a', { state: 'gone' });
    server.respond = async () => { throw httpError(500); };

    await sweep(service);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: null, failedAt: t0 });
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1']);
    expect(sweepWarnings()).toHaveLength(1);
    expect(String(sweepWarnings()[0][0])).toContain('tried again');
    // the warning names the failure by its message, never the object
    expect(sweepWarnings()[0].slice(1).every((part: unknown) => typeof part === 'string')).toBe(true);

    await sweep(service);
    expect(server.posts).toHaveLength(1);

    server.respond = null;
    vi.setSystemTime(t0 + CACHE_SWEEP_RETRY_MS + 1);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
    expect(await ptKeys(service.vaultName)).toEqual([]);
  });
});

// ─── After a failure ─────────────────────────────────────────────────────────

describe('the cache sweep — after a failure', () => {
  const T0 = Date.parse('2026-11-27T08:00:00.000Z');
  const FLOOR_A = '2026-11-20T10:00:00.000Z';
  const FLOOR_B = '2026-11-21T10:00:00.000Z';
  const FLOOR_C = '2026-11-22T10:00:00.000Z';
  const clock = (ms: number) => vi.setSystemTime(ms);

  /** One scope per entry: c-00000 and on, so 250 scopes are three requests of 100, 100 and 50. */
  async function seeded(count = 250): Promise<E2EService> {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock(T0);
    const service = fresh();
    await rawPut(service.vaultName, Array.from({ length: count }, (_, i): [string, unknown] => [`pt:m-${pad(i)}`, entry(`c-${pad(i)}`)]));
    return service;
  }
  /** The answer of each request in order: a function per request, the default answer where none is given. */
  function answers(...per: Array<((scopes: string[]) => Promise<Answer>) | undefined>) {
    let call = 0;
    server.respond = async (scopes) => {
      const one = per[call++];
      return one ? one(scopes) : answerFor(scopes);
    };
  }
  const fail = (status: number) => async (): Promise<Answer> => { throw httpError(status); };

  it('a failure at the first request records its time, purges nothing and keeps the position', async () => {
    const service = await seeded(3);
    await rawPut(service.vaultName, [['cache_sweep', { at: T0 - CACHE_SWEEP_INTERVAL_MS - 1, after: 'pt:m-00000' }]]);
    server.states.set('c-00001', { state: 'gone' });
    answers(fail(503));

    await sweep(service);

    expect(server.posts).toEqual([['c-00001', 'c-00002']]);
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-00000', 'pt:m-00001', 'pt:m-00002']);
    expect(harness.applyClearedFloor).not.toHaveBeenCalled();
    // the day of the last run that ended stays, so does the position; the failure's time is new
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0 - CACHE_SWEEP_INTERVAL_MS - 1, after: 'pt:m-00000', failedAt: T0 });
  });

  it('a 429, a request with no answer and a vault error fail the same way', async () => {
    for (const thrown of [httpError(429), Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })]) {
      const service = await seeded(2);
      server.respond = async () => { throw thrown; };
      await sweep(service);
      expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: null, failedAt: T0 });
      newSession();
    }
    const service = await seeded(2);
    server.respond = null;
    server.posts = [];
    vi.spyOn(E2EVault.prototype, 'listPlaintextScopes').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await sweep(service);
    expect(server.posts).toEqual([]);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: null, failedAt: T0 });
  });

  it('the same session sweeps again once the retry time has passed, and not before', async () => {
    const service = await seeded(3);
    answers(fail(500));
    await sweep(service);
    expect(server.posts).toHaveLength(1);

    clock(T0 + CACHE_SWEEP_RETRY_MS - 1);
    await sweep(service);
    expect(server.posts).toHaveLength(1);

    clock(T0 + CACHE_SWEEP_RETRY_MS);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
    // a run that ends records the day and drops the failure
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0 + CACHE_SWEEP_RETRY_MS, after: null });
  });

  it('a failure that cannot be recorded is still not retried at the next list: the session remembers it', async () => {
    const service = await seeded(3);
    answers(fail(500));
    vi.spyOn(service, 'writeCacheSweepRecord').mockRejectedValue(new Error('QuotaExceededError'));

    await sweep(service);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toBeUndefined();
    expect(sweepWarnings().some((c: unknown[]) => String(c[0]).includes('could not record its failure'))).toBe(true);

    clock(T0 + CACHE_SWEEP_RETRY_MS - 1);
    await sweep(service);
    expect(server.posts).toHaveLength(1);
    clock(T0 + CACHE_SWEEP_RETRY_MS);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('after a full success the daily rule is the one in force, as before', async () => {
    const service = await seeded(3);
    await sweep(service);
    expect(server.posts).toHaveLength(1);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0, after: null });

    clock(T0 + CACHE_SWEEP_RETRY_MS + 1);
    await sweep(service);
    expect(server.posts).toHaveLength(1);
    newSession();
    clock(T0 + CACHE_SWEEP_INTERVAL_MS + 1);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('a page reload (a new sweep over the same vault) respects the recorded time', async () => {
    const service = await seeded(3);
    answers(fail(500));
    await sweep(service);

    newSession();
    clock(T0 + CACHE_SWEEP_RETRY_MS - 1);
    await sweep(service);
    expect(server.posts).toHaveLength(1);

    newSession();
    clock(T0 + CACHE_SWEEP_RETRY_MS);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('a clock set back after a failure does not block the retry, in the session or after a reload', async () => {
    const service = await seeded(3);
    answers(fail(500));
    await sweep(service);
    expect(server.posts).toHaveLength(1);

    clock(T0 - 60 * 60 * 1000);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
    // the run that follows ends, on the clock as it now reads
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0 - 60 * 60 * 1000, after: null });
  });

  it('a clock set back after a failure and a reload: the record is ahead of the clock, so it is not recent', async () => {
    const service = await seeded(3);
    answers(fail(500));
    await sweep(service);
    expect(server.posts).toHaveLength(1);

    newSession();
    clock(T0 - 90 * 60 * 1000);
    await sweep(service);
    expect(server.posts).toHaveLength(2);
  });

  it('a failure at the third request applies the first two answers and resumes after the last scope they covered', async () => {
    const service = await seeded(250);
    server.states.set('c-00005', { state: 'gone' });
    server.states.set('c-00010', { state: 'hidden', clearedUntil: FLOOR_A });
    server.states.set('c-00150', { state: 'gone' });
    server.states.set('c-00120', { state: 'open', clearedUntil: FLOOR_B });
    // what the third request would have said
    server.states.set('c-00220', { state: 'gone' });
    server.states.set('c-00230', { state: 'open', clearedUntil: FLOOR_C });
    answers(undefined, undefined, fail(502));
    const purges = vi.spyOn(service, 'purgeCachedPlaintexts');

    await sweep(service);

    expect(server.posts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(harness.applyClearedFloor.mock.calls).toEqual([
      ['c-00010', FLOOR_A, 'scope states', ME],
      ['c-00120', FLOOR_B, 'scope states', ME],
    ]);
    // one purge walk for the two answers
    expect(purges).toHaveBeenCalledTimes(1);
    expect(purges.mock.calls[0][0]).toEqual(['c-00005', 'c-00150']);
    const left = await ptKeys(service.vaultName);
    expect(left).toHaveLength(248);
    expect(left).not.toContain('pt:m-00005');
    expect(left).not.toContain('pt:m-00150');
    expect(left).toContain('pt:m-00220');
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: 'pt:m-00199', failedAt: T0 });

    // the retry walks on from that key: here each scope has one entry, so it asks about the fifty not answered
    server.posts = [];
    harness.applyClearedFloor.mockClear();
    clock(T0 + CACHE_SWEEP_RETRY_MS);
    await sweep(service);
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]).toEqual(Array.from({ length: 50 }, (_, i) => `c-${pad(200 + i)}`));
    expect(harness.applyClearedFloor.mock.calls).toEqual([['c-00230', FLOOR_C, 'scope states', ME]]);
    expect(await ptKeys(service.vaultName)).not.toContain('pt:m-00220');
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0 + CACHE_SWEEP_RETRY_MS, after: null });
  });

  it('a dropped answer at the second request applies the first only', async () => {
    const service = await seeded(150);
    server.states.set('c-00005', { state: 'gone' });
    server.states.set('c-00010', { state: 'hidden', clearedUntil: FLOOR_A });
    // the second answer is one scope short, and says things that must not be used
    server.states.set('c-00120', { state: 'gone' });
    server.states.set('c-00130', { state: 'open', clearedUntil: FLOOR_B });
    answers(undefined, async (scopes) => {
      const full = answerFor(scopes).data as { success: boolean; data: unknown[] };
      return { data: { success: true, data: full.data.slice(1) } };
    });

    await sweep(service);

    expect(server.posts.map((p) => p.length)).toEqual([100, 50]);
    expect(harness.applyClearedFloor.mock.calls).toEqual([['c-00010', FLOOR_A, 'scope states', ME]]);
    const left = await ptKeys(service.vaultName);
    expect(left).toHaveLength(149);
    expect(left).not.toContain('pt:m-00005');
    expect(left).toContain('pt:m-00120');
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: 'pt:m-00099', failedAt: T0 });
    expect(sweepWarnings()).toHaveLength(1);
    expect(String(sweepWarnings()[0][1])).toContain('dropped an answer');
  });

  it('scopes whose entries interleave: the retry asks again about an answered scope with later entries and skips none not answered', async () => {
    const service = await seeded(100);
    // a later entry of the first scope, then the 101st scope: the second request, which fails
    await rawPut(service.vaultName, [
      ['pt:m-00100', entry('c-00000')],
      ['pt:m-00101', entry('c-00100')],
    ]);
    answers(undefined, fail(503));

    await sweep(service);

    expect(server.posts.map((p) => p.length)).toEqual([100, 1]);
    expect(server.posts[1]).toEqual(['c-00100']);
    // the key the last answered scope (c-00099) was first found at
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: 'pt:m-00099', failedAt: T0 });

    server.posts = [];
    clock(T0 + CACHE_SWEEP_RETRY_MS);
    await sweep(service);
    expect(server.posts).toEqual([['c-00000', 'c-00100']]);
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0 + CACHE_SWEEP_RETRY_MS, after: null });
  });

  it('kept answers whose purge fails leave the position where the run started: their gone scopes are asked about again', async () => {
    const service = await seeded(150);
    server.states.set('c-00005', { state: 'gone' });
    answers(undefined, fail(502));
    const purges = vi.spyOn(service, 'purgeCachedPlaintexts').mockRejectedValueOnce(new Error('QuotaExceededError'));

    await sweep(service);

    expect(server.posts.map((p) => p.length)).toEqual([100, 50]);
    expect(purges).toHaveBeenCalledTimes(1);
    expect(await ptKeys(service.vaultName)).toContain('pt:m-00005');
    // not 'pt:m-00099': a walk resumed there would not reach c-00005 before it starts over
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: 0, after: null, failedAt: T0 });

    // the retry starts where the failed run started, and c-00005 goes
    server.posts = [];
    clock(T0 + CACHE_SWEEP_RETRY_MS);
    await sweep(service);
    expect(server.posts.map((p) => p.length)).toEqual([100, 50]);
    expect(server.posts[0]).toContain('c-00005');
    expect(await ptKeys(service.vaultName)).not.toContain('pt:m-00005');
    expect(await rawGet(service.vaultName, 'cache_sweep')).toEqual({ at: T0 + CACHE_SWEEP_RETRY_MS, after: null });
  });
});

// ─── What it does ────────────────────────────────────────────────────────────

describe('the cache sweep — what it does with an answer', () => {
  it('gone: every cached text entry of the scope goes, own ones included, and every key stays', async () => {
    const service = fresh();
    // the vault opened (its owner token written) before the snapshot
    await service.readCacheSweepRecord();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    activateSecurePins(ME);
    pinSecure('chan-gone', ME);
    const pins = store.get(securePinStorageKey(ME));

    await rawPut(service.vaultName, [
      ['pt:m-01', entry('conv-gone', { authorId: ME })],
      ['pt:m-02', entry('conv-gone')],
      ['pt:m-03', entry('conv-gone', { authorId: undefined, createdAt: undefined })],
      ['pt:m-04', entry('conv-gone', { failed: true, text: '' })],
      ['pt:m-05', entry('ch:chan-gone', { authorId: ME })],
      ['pt:m-06', entry('ch:chan-gone')],
      ['pt:m-07', entry('conv-open')],
      ['pt:m-08', entry('conv-hidden')],
      ['pt:m-09', entry('ch:chan-open')],
      // the keys and records of the gone scopes and of everything else: all stay
      ['account', 'account-pickle'],
      ['device_id', 'device-0001'],
      ['master_secret', 'sealed-master'],
      [`master:${OTHER}`, { masterKey: 'mk', verified: false }],
      [`identity:${OTHER}:dev-1`, { curve25519Key: 'c', ed25519Key: 'e', verified: true }],
      [`session:${OTHER}:dev-1`, 'olm-session-pickle'],
      [`session:${OTHER}:dev-1:fb`, 'olm-fallback-pickle'],
      [`dlv:${OTHER}`, { version: 2, deviceIds: ['dev-1'], acknowledgedVersion: 2, acknowledgedDeviceIds: ['dev-1'] }],
      ['gs:conv-gone', { pickle: 'outbound', sessionId: 'sid-out', createdAt: 1, messageCount: 3, deviceListVersions: {}, pendingShareFailures: [] }],
      ['gs:ch:chan-gone', { pickle: 'outbound-ch', sessionId: 'sid-out-ch', createdAt: 1, messageCount: 1, deviceListVersions: {}, pendingShareFailures: [] }],
      ['igs:sid-gone', { pickle: 'inbound', sessionId: 'sid-gone', conversationId: 'conv-gone', senderUserId: OTHER, senderDeviceId: 'dev-1' }],
      ['igs:sid-ch', { pickle: 'inbound-ch', sessionId: 'sid-ch', conversationId: 'ch:chan-gone', senderUserId: OTHER, senderDeviceId: 'dev-1' }],
      ['mi:sid-gone:0', { messageId: 'm-02', editedAt: null }],
      ['mi:sid-ch:4', { messageId: 'm-06', editedAt: null }],
      ['pks:2026-11-01T10:00:00.000Z|share-1', { share: { conversationId: 'conv-gone' }, attempts: 0, receivedAt: 1, leased: true }],
      ['pka:share-2', { id: 'share-2', at: 1 }],
      ['history_pull', { masterKey: 'mk', cursor: null, pages: 1 }],
      ['ptpurge:cleared:conv-gone', { at: 1, level: 1 }],
      ['ptpurge:read-only:conv-open', { at: 1 }],
      ['repair:outbound-sessions-rotated', { at: 1 }],
      ['bku:sessions', ['sid-gone']],
      ['claim_sent', { at: 1 }],
      ['key_backup_writes', { unconfirmed: [] }],
    ]);
    const before = await rawAll(service.vaultName);
    server.states.set('conv-gone', { state: 'gone' });
    server.states.set('ch:chan-gone', { state: 'gone' });
    server.states.set('conv-hidden', { state: 'hidden' });

    await sweep(service);

    const after = await rawAll(service.vaultName);
    const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
    const added = [...after.keys()].filter((k) => !before.has(k)).sort();
    expect(removed).toEqual(['pt:m-01', 'pt:m-02', 'pt:m-03', 'pt:m-04', 'pt:m-05', 'pt:m-06']);
    expect(added).toEqual(['cache_sweep', 'ptpurge:gone:ch:chan-gone', 'ptpurge:gone:conv-gone']);
    for (const [key, value] of after) {
      if (before.has(key)) expect(value, key).toEqual(before.get(key));
    }
    // the secure-channel pin of the channel that is gone is never removed
    expect(isPinnedSecure('chan-gone')).toBe(true);
    expect(store.get(securePinStorageKey(ME))).toBe(pins);
    deactivateSecurePins();
  });

  it('a scope purged by an earlier run that holds text again is purged again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-27T08:00:00.000Z');
    vi.setSystemTime(t0);
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('ch:chan-1')]]);
    server.states.set('ch:chan-1', { state: 'gone' });
    await sweep(service);
    expect(await ptKeys(service.vaultName)).toEqual([]);
    expect(await rawGet(service.vaultName, 'ptpurge:gone:ch:chan-1')).toBeDefined();

    // invited again under the same id, text cached, then removed again
    await service.cachePlaintext('m-2', 'ch:chan-1', 'new words', null, { authorId: OTHER, createdAt: '2026-11-27T09:00:00.000Z' });
    newSession();
    vi.setSystemTime(t0 + CACHE_SWEEP_INTERVAL_MS + 1);
    await sweep(service);
    expect(server.posts).toEqual([['ch:chan-1'], ['ch:chan-1']]);
    expect(await ptKeys(service.vaultName)).toEqual([]);
  });

  it('the gone scopes of a run are purged in one walk, their records cleared a slice at a time (no queue task holds them all)', async () => {
    const service = fresh();
    const count = E2E_SCOPE_STATES_MAX + 50;
    await rawPut(service.vaultName, Array.from({ length: count }, (_, i): [string, unknown] => [`pt:m-${pad(i)}`, entry(`c-${pad(i)}`)]));
    for (let i = 0; i < count; i++) server.states.set(`c-${pad(i)}`, { state: 'gone' });
    const clears = vi.spyOn(service, 'clearPurgeMarks');
    const purges = vi.spyOn(service, 'purgeCachedPlaintexts');

    await sweep(service);

    expect(clears.mock.calls.map(([mark, scopes]) => [mark, scopes.length])).toEqual([['gone', E2E_SCOPE_STATES_MAX], ['gone', 50]]);
    expect(purges).toHaveBeenCalledTimes(1);
    expect(purges.mock.calls[0][0]).toHaveLength(count);
    expect(await ptKeys(service.vaultName)).toEqual([]);
  });

  it('a floor goes through applyClearedFloor, with a source of its own, for the account that asked; open and hidden change nothing else', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [
      ['pt:m-1', entry('conv-hidden-floor')],
      ['pt:m-2', entry('conv-open-floor')],
      ['pt:m-3', entry('conv-hidden')],
      ['pt:m-4', entry('ch:chan-1')],
    ]);
    server.states.set('conv-hidden-floor', { state: 'hidden', clearedUntil: '2026-11-20T10:00:00.000Z' });
    server.states.set('conv-open-floor', { state: 'open', clearedUntil: '2026-11-21T10:00:00.000Z' });
    server.states.set('conv-hidden', { state: 'hidden' });

    await sweep(service);

    expect(harness.applyClearedFloor.mock.calls).toEqual([
      ['conv-hidden-floor', '2026-11-20T10:00:00.000Z', 'scope states', ME],
      ['conv-open-floor', '2026-11-21T10:00:00.000Z', 'scope states', ME],
    ]);
    // the sweep itself purges nothing for them (the floor's own walk does, elsewhere)
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1', 'pt:m-2', 'pt:m-3', 'pt:m-4']);
  });

  it('a malformed floor on a conversation still goes to applyClearedFloor, which checks it', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
    server.states.set('conv-a', { state: 'open', clearedUntil: 'yesterday' });
    await sweep(service);
    expect(harness.applyClearedFloor.mock.calls).toEqual([['conv-a', 'yesterday', 'scope states', ME]]);
  });

  it('a scope this session holds on screen or in its stores is kept, with one warning; the others go', async () => {
    const service = fresh();
    await rawPut(service.vaultName, [
      ['pt:m-01', entry('conv-listed')],
      ['pt:m-02', entry('conv-open-now')],
      ['pt:m-03', entry('conv-in-view')],
      ['pt:m-04', entry('ch:chan-listed')],
      ['pt:m-05', entry('ch:chan-open-now')],
      // the channel of the id the chat view shows as a conversation is not held: the kind counts
      ['pt:m-06', entry('ch:conv-in-view')],
      ['pt:m-07', entry('conv-free')],
      ['pt:m-08', entry('ch:chan-free')],
    ]);
    harness.dm = { conversations: [{ id: 'conv-listed' }], activeConversationId: 'conv-open-now' };
    harness.server = { channels: [{ id: 'chan-listed' }], activeChannelId: 'chan-open-now' };
    harness.chat = { viewScope: { kind: 'conversation', id: 'conv-in-view' } };
    const everything = ['conv-listed', 'conv-open-now', 'conv-in-view', 'ch:chan-listed', 'ch:chan-open-now', 'ch:conv-in-view', 'conv-free', 'ch:chan-free'];
    for (const scope of everything) server.states.set(scope, { state: 'gone' });

    await sweep(service);
    expect(server.posts).toEqual([everything]);
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-01', 'pt:m-02', 'pt:m-03', 'pt:m-04', 'pt:m-05']);
    expect(sweepWarnings()).toHaveLength(1);
    // a held scope is not recorded as purged
    expect(await rawGet(service.vaultName, 'ptpurge:gone:conv-listed')).toBeUndefined();

    // a channel in the chat view is held too; what this session no longer holds goes
    harness.chat = { viewScope: { kind: 'channel', id: 'chan-in-view' } };
    harness.dm = { conversations: [], activeConversationId: null };
    harness.server = { channels: [], activeChannelId: null };
    await rawPut(service.vaultName, [
      ['pt:m-09', entry('ch:chan-in-view')],
      ['pt:m-10', entry('chan-in-view')],
      ['cache_sweep', { at: 0, after: null }],
    ]);
    server.states.set('ch:chan-in-view', { state: 'gone' });
    server.states.set('chan-in-view', { state: 'gone' });
    newSession();
    await sweep(service);
    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-09']);
    expect(sweepWarnings()).toHaveLength(2);
  });

  it('a scope this session comes to hold while the purge walks is kept from then on', async () => {
    const service = fresh();
    const total = PLAINTEXT_PURGE_BATCH + 5;
    await rawPut(service.vaultName, Array.from({ length: total }, (_, i): [string, unknown] => [`pt:m-${pad(i)}`, entry('conv-late')]));
    server.states.set('conv-late', { state: 'gone' });
    const original = E2EVault.prototype.purgePlaintextBatch;
    let batches = 0;
    vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch').mockImplementation(function (this: E2EVault, ...args) {
      batches++;
      // the conversation opens on screen while its first batch is purged
      if (batches === 2) harness.dm = { conversations: [], activeConversationId: 'conv-late' };
      return original.apply(this, args);
    });
    await sweep(service);
    expect(await ptKeys(service.vaultName)).toHaveLength(5);
    // and its purge is not recorded as done
    expect(await rawGet(service.vaultName, 'ptpurge:gone:conv-late')).toBeUndefined();
  });

  it('a session that ends while the purge walks purges nothing more: what is left stays, no mark, no record', async () => {
    const service = fresh();
    const total = PLAINTEXT_PURGE_BATCH + 5;
    await rawPut(service.vaultName, Array.from({ length: total }, (_, i): [string, unknown] => [`pt:m-${pad(i)}`, entry('conv-gone')]));
    server.states.set('conv-gone', { state: 'gone' });
    const original = E2EVault.prototype.purgePlaintextBatch;
    let batches = 0;
    vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch').mockImplementation(function (this: E2EVault, ...args) {
      batches++;
      // the session ends (a logout) before the second batch of the purge is applied
      if (batches === 2) resetCacheSweep();
      return original.apply(this, args);
    });
    await sweep(service);
    expect(batches).toBe(2);
    // the first batch went; the 5 entries of the second were not touched
    expect(await ptKeys(service.vaultName)).toEqual(Array.from({ length: 5 }, (_, i) => `pt:m-${pad(PLAINTEXT_PURGE_BATCH + i)}`));
    expect(await rawGet(service.vaultName, 'ptpurge:gone:conv-gone')).toBeUndefined();
    expect(await rawGet(service.vaultName, 'cache_sweep')).toBeUndefined();
  });
});

// ─── The session that asked ──────────────────────────────────────────────────

describe('the cache sweep — only for the session that asked', () => {
  /** The next request held until the test answers it. */
  function holdNextAnswer() {
    let release!: (answer: Answer) => void;
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => { arrived = r; });
    server.respond = (scopes) => {
      arrived();
      return new Promise<Answer>((resolve) => {
        release = resolve;
      }).then((answer) => answer ?? answerFor(scopes));
    };
    return { arrival, release: (answer?: Answer) => release(answer as Answer) };
  }

  it.each([
    ['a logout', () => { resetCacheSweep(); harness.signedIn = null; }],
    ['an account switch', () => { resetCacheSweep(); harness.signedIn = 'someone-else'; }],
    ['a sign-out and a sign-in again as the same account', () => { resetCacheSweep(); }],
  ])('%s while a request is out applies nothing of its answer', async (_what, end) => {
    const service = fresh();
    await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')], ['pt:m-2', entry('conv-b')]]);
    server.states.set('conv-a', { state: 'gone' });
    server.states.set('conv-b', { state: 'hidden', clearedUntil: '2026-11-20T10:00:00.000Z' });
    const held = holdNextAnswer();
    noteConversationListApplied(ME);
    await held.arrival;

    end();
    held.release();
    await flushQueue(service);

    expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1', 'pt:m-2']);
    expect(harness.applyClearedFloor).not.toHaveBeenCalled();
    expect(await rawGet(service.vaultName, 'cache_sweep')).toBeUndefined();
    expect(sweepWarnings()).toEqual([]);
  });

  it('a logout during the walk stops it before any request', async () => {
    const service = fresh();
    await rawPut(service.vaultName, Array.from({ length: PLAINTEXT_PURGE_BATCH + 5 }, (_, i): [string, unknown] => [`pt:m-${pad(i)}`, entry(`c-${i % 3}`)]));
    const original = E2EVault.prototype.listPlaintextScopes;
    let batches = 0;
    vi.spyOn(E2EVault.prototype, 'listPlaintextScopes').mockImplementation(function (this: E2EVault, after, limit) {
      batches++;
      resetCacheSweep();
      harness.signedIn = null;
      return original.call(this, after, limit);
    });
    await sweep(service);
    expect(batches).toBe(1);
    expect(server.posts).toEqual([]);
  });

  it('a service disposed while a request is out ends the sweep quietly: no unhandled rejection, nothing applied', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const service = fresh();
      await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')]]);
      server.states.set('conv-a', { state: 'gone' });
      const held = holdNextAnswer();
      noteConversationListApplied(ME);
      await held.arrival;

      await service.dispose();
      held.release();
      await cacheSweepSettled();

      expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1']);
      expect(await rawGet(service.vaultName, 'cache_sweep')).toBeUndefined();
      expect(sweepWarnings()).toEqual([]);
      expect(debug.mock.calls.some((c: unknown[]) => String(c[0]).includes('ended with the session'))).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a vault another page took over (the fence) ends the sweep quietly: nothing written, no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const service = fresh();
      await rawPut(service.vaultName, [['pt:m-1', entry('conv-a')], ['pt:m-2', entry('conv-b')]]);
      server.states.set('conv-a', { state: 'gone' });
      const held = holdNextAnswer();
      noteConversationListApplied(ME);
      await held.arrival;

      await stampVaultOwner(service.vaultName, 'another-page-token', 'claim');
      held.release();
      await cacheSweepSettled();

      expect(await ptKeys(service.vaultName)).toEqual(['pt:m-1', 'pt:m-2']);
      expect(await rawGet(service.vaultName, 'cache_sweep')).toBeUndefined();
      expect(await rawGet(service.vaultName, 'vault_owner')).toBe('another-page-token');
      expect(sweepWarnings()).toEqual([]);
      await new Promise((r) => setTimeout(r, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// ─── The read-only walk, on the vault alone ──────────────────────────────────

describe('E2EVault.listPlaintextScopes', () => {
  it('answers each entry\'s key and scope in key order, never its text, a batch at a time, resuming after a key', async () => {
    n++;
    const vault = new E2EVault(ME, keyProvider, `sweep-vault-${n}`);
    await vault.open();
    await vault.putPlaintext('m-3', { conversationId: 'conv-a', text: 'three' });
    await vault.putPlaintext('m-1', { conversationId: 'ch:chan-1', text: 'one' });
    await vault.putPlaintext('m-2', { conversationId: 'conv-b', text: 'two' });
    await vault.putAccountPickle('not a cache entry');

    const first = await vault.listPlaintextScopes(null, 2);
    expect(first).toEqual({ entries: [{ key: 'pt:m-1', scope: 'ch:chan-1' }, { key: 'pt:m-2', scope: 'conv-b' }], next: 'pt:m-2' });
    const second = await vault.listPlaintextScopes(first.next, 2);
    expect(second).toEqual({ entries: [{ key: 'pt:m-3', scope: 'conv-a' }], next: null });
    expect(JSON.stringify([first, second])).not.toMatch(/one|two|three/);
    // after the last key: nothing, and done
    expect(await vault.listPlaintextScopes('pt:m-3', 2)).toEqual({ entries: [], next: null });
    vault.close();
  });
});
