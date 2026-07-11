// @vitest-environment node
// Full-stack client crypto test: two E2EService instances (Alice, Bob) talk
// through a fake in-memory key server implementing the real /e2e API shapes,
// with fake-indexeddb standing in for the vault. This exercises the entire
// path: registration → bundle claim → signature verification → session
// establishment → ratchet → pickle persistence → plaintext cache.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { E2E_LIMITS } from '@voxium/shared';

// The real api module drags in axios/socket.io — the service takes an
// injected client, so stub the module out entirely.
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EIdentityChangedError } from '../../services/e2e/e2eService';
import type { PickleKeyProvider } from '../../services/e2e/vault';

const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve('@voxium/crypto-engine/wasm'));

// ─── Fake key-distribution server (mirrors routes/e2e.ts semantics) ──────────

interface StoredDevice {
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  fallbackKey: { keyId: string; key: string; signature: string } | null;
  oneTimeKeys: Array<{ keyId: string; key: string; signature: string }>;
}

function createFakeServer() {
  const devices = new Map<string, StoredDevice>();

  const ok = (data: unknown) => ({ data: { success: true, data } });

  function apiFor(userId: string) {
    return {
      async get(url: string) {
        if (url === '/e2e/devices/me') {
          const d = devices.get(userId);
          if (!d) return ok({ registered: false });
          return ok({
            registered: true,
            curve25519Key: d.curve25519Key,
            ed25519Key: d.ed25519Key,
            oneTimeKeyCount: d.oneTimeKeys.length,
            hasFallbackKey: d.fallbackKey !== null,
          });
        }
        const deviceMatch = url.match(/^\/e2e\/devices\/(.+)$/);
        if (deviceMatch) {
          const d = devices.get(deviceMatch[1]);
          if (!d) return ok({ hasDevice: false });
          return ok({
            hasDevice: true,
            userId: deviceMatch[1],
            curve25519Key: d.curve25519Key,
            ed25519Key: d.ed25519Key,
            deviceSignature: d.deviceSignature,
          });
        }
        throw new Error(`unmocked GET ${url}`);
      },
      async put(url: string, body: any) {
        if (url === '/e2e/devices') {
          devices.set(userId, {
            curve25519Key: body.curve25519Key,
            ed25519Key: body.ed25519Key,
            deviceSignature: body.deviceSignature,
            fallbackKey: body.fallbackKey,
            oneTimeKeys: [...body.oneTimeKeys],
          });
          return ok({ registered: true, oneTimeKeyCount: body.oneTimeKeys.length });
        }
        throw new Error(`unmocked PUT ${url}`);
      },
      async post(url: string, body?: any) {
        if (url === '/e2e/devices/me/keys') {
          const d = devices.get(userId);
          if (!d) throw new Error('403: no device');
          if (body.oneTimeKeys) d.oneTimeKeys.push(...body.oneTimeKeys);
          if (body.fallbackKey) d.fallbackKey = body.fallbackKey;
          return ok({ oneTimeKeyCount: d.oneTimeKeys.length });
        }
        const bundleMatch = url.match(/^\/e2e\/bundles\/(.+)$/);
        if (bundleMatch) {
          const d = devices.get(bundleMatch[1]);
          if (!d) throw new Error('404: no device');
          const otk = d.oneTimeKeys.shift();
          const preKey = otk
            ? { ...otk, type: 'otk' }
            : d.fallbackKey
              ? { ...d.fallbackKey, type: 'fallback' }
              : null;
          if (!preKey) throw new Error('409: no keys');
          return ok({
            userId: bundleMatch[1],
            curve25519Key: d.curve25519Key,
            ed25519Key: d.ed25519Key,
            deviceSignature: d.deviceSignature,
            preKey,
          });
        }
        throw new Error(`unmocked POST ${url}`);
      },
    };
  }

  return { devices, apiFor };
}

function memoryKeyProvider(): PickleKeyProvider {
  const keys = new Map<string, string>();
  return {
    load: async (userId) => keys.get(userId) ?? null,
    save: async (userId, key) => void keys.set(userId, key),
  };
}

let uniq = 0;
function makeParty(server: ReturnType<typeof createFakeServer>, name: string, keyProvider = memoryKeyProvider()) {
  const userId = `${name}-${uniq}`;
  const service = new E2EService(userId, {
    api: server.apiFor(userId) as any,
    keyProvider,
    wasmInput: wasmBytes,
  });
  return { userId, service, keyProvider };
}

async function flushQueue() {
  // replenishment runs fire-and-forget; let microtasks settle
  await new Promise((r) => setTimeout(r, 10));
}

beforeAll(() => {
  uniq = Date.now() % 100000;
});

describe('E2EService (client crypto core)', () => {
  it('registers a device with signed keys on first initialize', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    await alice.service.initialize();

    const stored = server.devices.get(alice.userId)!;
    expect(stored).toBeTruthy();
    expect(stored.oneTimeKeys.length).toBe(E2E_LIMITS.OTK_TARGET);
    expect(stored.fallbackKey).toBeTruthy();
    expect(stored.curve25519Key).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(stored.deviceSignature).toMatch(/^[A-Za-z0-9+/]{86}$/);
  });

  it('encrypts and decrypts a full two-way conversation, consuming an OTK', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const before = server.devices.get(bob.userId)!.oneTimeKeys.length;
    const envelope = await alice.service.encryptMessage(bob.userId, 'hello bob 🔐');
    expect(server.devices.get(bob.userId)!.oneTimeKeys.length).toBe(before - 1);

    const result = await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope,
    });
    expect(result).toEqual({ text: 'hello bob 🔐' });

    // reply flows back over the same ratchet
    const reply = await bob.service.encryptMessage(alice.userId, 'hey alice');
    const decrypted = await alice.service.decryptMessage({
      id: 'm2', conversationId: 'c1', authorId: bob.userId, content: reply,
    });
    expect(decrypted.text).toBe('hey alice');

    // several turns both ways
    for (let i = 0; i < 3; i++) {
      const a = await alice.service.encryptMessage(bob.userId, `a${i}`);
      expect((await bob.service.decryptMessage({ id: `ma${i}`, conversationId: 'c1', authorId: alice.userId, content: a })).text).toBe(`a${i}`);
      const b = await bob.service.encryptMessage(alice.userId, `b${i}`);
      expect((await alice.service.decryptMessage({ id: `mb${i}`, conversationId: 'c1', authorId: bob.userId, content: b })).text).toBe(`b${i}`);
    }
  });

  it('versions the plaintext cache by editedAt: edits decrypt fresh, stale entries never served', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    // original message
    const original = await alice.service.encryptMessage(bob.userId, 'original text');
    const first = await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: original, editedAt: null,
    });
    expect(first.text).toBe('original text');

    // alice edits: fresh ciphertext, same id, new editedAt
    const edited = await alice.service.encryptMessage(bob.userId, 'edited text');
    const second = await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: edited, editedAt: '2026-07-12T10:00:00.000Z',
    });
    expect(second.text).toBe('edited text');

    // repeat with the same version → cache hit on the edited entry
    const third = await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: edited, editedAt: '2026-07-12T10:00:00.000Z',
    });
    expect(third.text).toBe('edited text');

    // version-checked reads reject the stale version, unversioned reads serve latest
    expect(await bob.service.getCachedPlaintext('m1', null)).toBeNull();
    expect(await bob.service.getCachedPlaintext('m1', '2026-07-12T10:00:00.000Z')).toBe('edited text');
    expect(await bob.service.getCachedPlaintext('m1')).toBe('edited text');

    // sender side: own edit cached under the new version
    await alice.service.cachePlaintext('m1', 'c1', 'edited text', '2026-07-12T10:00:00.000Z');
    const own = await alice.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: 'irrelevant', editedAt: '2026-07-12T10:00:00.000Z',
    });
    expect(own.text).toBe('edited text');
  });

  it('decryption is idempotent via the plaintext cache (one-shot ratchet keys)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const envelope = await alice.service.encryptMessage(bob.userId, 'once only');
    const first = await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope });
    const second = await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope });
    expect(first.text).toBe('once only');
    expect(second.text).toBe('once only'); // served from cache, not the ratchet
  });

  it('caches own sent plaintext by server message id', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    await alice.service.encryptMessage(bob.userId, 'my own words');
    await alice.service.cachePlaintext('msg-42', 'c1', 'my own words');

    // own socket echo resolves through the cache (Olm can't decrypt-to-self)
    const own = await alice.service.decryptMessage({
      id: 'msg-42', conversationId: 'c1', authorId: alice.userId, content: 'irrelevant',
    });
    expect(own.text).toBe('my own words');

    // an own message missing from the cache is honestly unrecoverable
    const missing = await alice.service.decryptMessage({
      id: 'msg-unknown', conversationId: 'c1', authorId: alice.userId, content: 'irrelevant',
    });
    expect(missing.failed).toBe(true);
  });

  it('survives a restart: pickled account + sessions keep the conversation going', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceKeys = memoryKeyProvider();
    const bobKeys = memoryKeyProvider();
    const alice = makeParty(server, 'alice', aliceKeys);
    const bob = makeParty(server, 'bob', bobKeys);
    await alice.service.initialize();
    await bob.service.initialize();

    const m1 = await alice.service.encryptMessage(bob.userId, 'before restart');
    await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: m1 });

    // "restart" both clients: fresh service instances over the same vaults
    alice.service.dispose();
    bob.service.dispose();
    const alice2 = new E2EService(alice.userId, { api: server.apiFor(alice.userId) as any, keyProvider: aliceKeys, wasmInput: wasmBytes });
    const bob2 = new E2EService(bob.userId, { api: server.apiFor(bob.userId) as any, keyProvider: bobKeys, wasmInput: wasmBytes });
    await alice2.initialize();
    await bob2.initialize();

    // no re-registration (identity persisted) — server keys unchanged
    const otksBefore = server.devices.get(bob.userId)!.oneTimeKeys.length;

    const m2 = await alice2.encryptMessage(bob.userId, 'after restart');
    expect((await bob2.decryptMessage({ id: 'm2', conversationId: 'c1', authorId: alice.userId, content: m2 })).text).toBe('after restart');
    // continued the pickled session — no new bundle claim
    expect(server.devices.get(bob.userId)!.oneTimeKeys.length).toBe(otksBefore);
    // history is still readable from the cache after restart
    expect((await bob2.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: m1 })).text).toBe('before restart');
  });

  it('detects a peer identity change and recovers only after explicit acceptance', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const m1 = await alice.service.encryptMessage(bob.userId, 'hi');
    await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: m1 });

    // Bob loses his device and re-registers with a brand-new identity
    const bobRebornService = new E2EService(bob.userId, {
      api: server.apiFor(bob.userId) as any,
      keyProvider: memoryKeyProvider(), // fresh vault ⇒ fresh keys
      wasmInput: wasmBytes,
    });
    await bobRebornService.initialize();

    // Alice's pinned identity no longer matches → hard failure, no silent trust
    await alice.service.resetSession(bob.userId);
    await expect(alice.service.encryptMessage(bob.userId, 'are you there?')).rejects.toThrow(E2EIdentityChangedError);

    // After explicitly accepting the new identity, messaging resumes
    await alice.service.acceptNewIdentity(bob.userId);
    const m2 = await alice.service.encryptMessage(bob.userId, 'welcome back');
    expect((await bobRebornService.decryptMessage({ id: 'm2', conversationId: 'c1', authorId: alice.userId, content: m2 })).text).toBe('welcome back');
  });

  it('establishes sessions via the fallback key when OTKs are exhausted', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    server.devices.get(bob.userId)!.oneTimeKeys = []; // drain

    const envelope = await alice.service.encryptMessage(bob.userId, 'via fallback');
    expect((await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope })).text).toBe('via fallback');
  });

  it('returns a failure marker (not a throw) for garbage envelopes', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const garbage = await bob.service.decryptMessage({
      id: 'g1', conversationId: 'c1', authorId: alice.userId, content: 'not an envelope',
    });
    expect(garbage.failed).toBe(true);

    const truncated = await bob.service.decryptMessage({
      id: 'g2', conversationId: 'c1', authorId: alice.userId,
      content: JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'QWJjZA' }),
    });
    expect(truncated.failed).toBe(true);
  });

  it('searches locally decrypted history per conversation, newest first', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const send = async (id: string, text: string, createdAt: string) => {
      const envelope = await alice.service.encryptMessage(bob.userId, text);
      const result = await bob.service.decryptMessage({
        id, conversationId: 'c1', authorId: alice.userId, content: envelope, createdAt,
      });
      expect(result.failed).toBeUndefined();
    };
    await send('m1', 'the quick brown fox', '2026-07-11T10:00:00.000Z');
    await send('m2', 'lazy dog sleeps', '2026-07-11T11:00:00.000Z');
    await send('m3', 'another FOX appears', '2026-07-11T12:00:00.000Z');
    // a different conversation must not leak into results
    const other = await alice.service.encryptMessage(bob.userId, 'fox in another room');
    await bob.service.decryptMessage({
      id: 'x1', conversationId: 'c2', authorId: alice.userId, content: other, createdAt: '2026-07-11T13:00:00.000Z',
    });

    const hits = await bob.service.searchDecrypted('c1', 'fox');
    expect(hits.map((h) => h.messageId)).toEqual(['m3', 'm1']); // newest first, case-insensitive
    expect(hits[0].authorId).toBe(alice.userId);
    expect(hits[0].createdAt).toBe('2026-07-11T12:00:00.000Z');

    expect(await bob.service.searchDecrypted('c1', 'zebra')).toEqual([]);
  });

  it('computes identical safety numbers on both sides and tracks verification', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const fromAlice = await alice.service.safetyNumber(bob.userId);
    const fromBob = await bob.service.safetyNumber(alice.userId);
    expect(fromAlice!.digits).toBe(fromBob!.digits);
    expect(fromAlice!.digits).toMatch(/^\d{60}$/);
    expect(fromAlice!.verified).toBe(false);

    await alice.service.markIdentityVerified(bob.userId);
    expect((await alice.service.safetyNumber(bob.userId))!.verified).toBe(true);
  });

  it('replenishes one-time keys when the server stock is low', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    await alice.service.initialize();
    await flushQueue();

    // Drain the server below the low-water mark and replenish
    const device = server.devices.get(alice.userId)!;
    device.oneTimeKeys = device.oneTimeKeys.slice(0, E2E_LIMITS.OTK_LOW_WATER - 5);
    await alice.service.replenishOneTimeKeys();
    expect(server.devices.get(alice.userId)!.oneTimeKeys.length).toBeGreaterThanOrEqual(E2E_LIMITS.OTK_LOW_WATER);
  });
});
