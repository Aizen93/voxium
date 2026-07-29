// @vitest-environment node
// Full-stack client crypto test: several E2EService instances (Alice's and
// Bob's devices) talk through a fake in-memory key server implementing the real
// /e2e API shapes, with fake-indexeddb standing in for the vault. This
// exercises the entire path: registration → device lists → bundle claim →
// signature verification → Olm key-share fanout → Megolm group session →
// pickle persistence → plaintext cache.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { E2E_LIMITS, buildE2EEnvelope, parseE2EEnvelope } from '@voxium/shared';

// The real api module drags in axios/socket.io — the service takes an
// injected client, so stub the module out entirely.
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EIdentityChangedError } from '../../services/e2e/e2eService';
import type { PickleKeyProvider } from '../../services/e2e/vault';

const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve('@voxium/crypto-engine/wasm'));

// ─── Fake key-distribution server (mirrors routes/e2e.ts semantics) ──────────

interface PreKey {
  keyId: string;
  key: string;
  signature: string;
}

interface StoredDevice {
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  fallbackKey: PreKey | null;
  oneTimeKeys: PreKey[];
  createdAt: string;
}

interface StoredShare {
  id: string;
  recipientUserId: string;
  recipientDeviceId: string;
  senderUserId: string;
  senderDeviceId: string;
  conversationId: string;
  sessionId: string;
  body: string;
  createdAt: string;
}

interface StoredUser {
  devices: Map<string, StoredDevice>;
  listVersion: number;
}

function createFakeServer() {
  const users = new Map<string, StoredUser>();
  const shares: StoredShare[] = [];
  let shareSeq = 0;
  let failKeyshareUploads = false;

  const ok = (data: unknown) => ({ data: { success: true, data } });
  const userOf = (userId: string): StoredUser => {
    let user = users.get(userId);
    if (!user) {
      user = { devices: new Map(), listVersion: 0 };
      users.set(userId, user);
    }
    return user;
  };
  const serialize = (d: StoredDevice) => ({
    deviceId: d.deviceId,
    curve25519Key: d.curve25519Key,
    ed25519Key: d.ed25519Key,
    deviceSignature: d.deviceSignature,
    createdAt: d.createdAt,
  });
  const split = (url: string): [string, URLSearchParams] => {
    const [path, query] = url.split('?');
    return [path, new URLSearchParams(query ?? '')];
  };

  function apiFor(userId: string) {
    return {
      async get(url: string) {
        const [path, query] = split(url);

        if (path === '/e2e/devices/me') {
          const user = userOf(userId);
          const all = [...user.devices.values()];
          const base = { devices: all.map(serialize), listVersion: user.listVersion };
          const deviceId = query.get('deviceId');
          const self = deviceId ? user.devices.get(deviceId) : undefined;
          if (!self) return ok({ registered: !deviceId && all.length > 0, ...base });
          return ok({
            registered: true,
            deviceId: self.deviceId,
            curve25519Key: self.curve25519Key,
            ed25519Key: self.ed25519Key,
            oneTimeKeyCount: self.oneTimeKeys.length,
            hasFallbackKey: self.fallbackKey !== null,
            ...base,
          });
        }

        if (path === '/e2e/keyshares') {
          const deviceId = query.get('deviceId')!;
          if (!userOf(userId).devices.has(deviceId)) throw new Error('403: unknown device');
          const mine = shares.filter((s) => s.recipientUserId === userId && s.recipientDeviceId === deviceId);
          const claimed = mine.slice(0, E2E_LIMITS.KEYSHARE_CLAIM_MAX);
          // claim-and-delete: Olm pre-key bodies are one-shot
          for (const s of claimed) shares.splice(shares.indexOf(s), 1);
          return ok({ shares: claimed.map(({ recipientUserId: _r, recipientDeviceId: _d, ...rest }) => rest) });
        }

        const deviceMatch = path.match(/^\/e2e\/devices\/(.+)$/);
        if (deviceMatch) {
          const user = userOf(deviceMatch[1]);
          return ok({ devices: [...user.devices.values()].map(serialize), listVersion: user.listVersion });
        }
        throw new Error(`unmocked GET ${url}`);
      },

      async put(url: string, body: any) {
        if (url === '/e2e/devices') {
          const user = userOf(userId);
          if (!user.devices.has(body.deviceId) && user.devices.size >= E2E_LIMITS.MAX_DEVICES) {
            throw new Error('409: device limit reached');
          }
          user.devices.set(body.deviceId, {
            deviceId: body.deviceId,
            curve25519Key: body.curve25519Key,
            ed25519Key: body.ed25519Key,
            deviceSignature: body.deviceSignature,
            fallbackKey: body.fallbackKey,
            oneTimeKeys: [...body.oneTimeKeys],
            createdAt: new Date(Date.now() + user.devices.size).toISOString(),
          });
          user.listVersion += 1;
          return ok({
            registered: true,
            deviceId: body.deviceId,
            oneTimeKeyCount: body.oneTimeKeys.length,
            listVersion: user.listVersion,
          });
        }
        throw new Error(`unmocked PUT ${url}`);
      },

      async post(url: string, body?: any) {
        const [path, query] = split(url);

        if (path === '/e2e/devices/me/keys') {
          const device = userOf(userId).devices.get(body.deviceId);
          if (!device) throw new Error('403: no device');
          if (body.oneTimeKeys) device.oneTimeKeys.push(...body.oneTimeKeys);
          if (body.fallbackKey) device.fallbackKey = body.fallbackKey;
          return ok({ oneTimeKeyCount: device.oneTimeKeys.length });
        }

        if (path === '/e2e/keyshares') {
          if (failKeyshareUploads) throw new Error('503: key-share upload unavailable');
          if (!userOf(userId).devices.has(body.deviceId)) throw new Error('403: unknown sender device');
          if (!Array.isArray(body.shares) || body.shares.length > E2E_LIMITS.KEYSHARE_BATCH_MAX) {
            throw new Error('400: bad batch');
          }
          for (const s of body.shares) {
            const envelope = parseE2EEnvelope(s.body);
            if (!envelope || envelope.e !== 'olm1') throw new Error('400: invalid body envelope');
            shares.push({
              id: `share-${++shareSeq}`,
              recipientUserId: s.recipientUserId,
              recipientDeviceId: s.recipientDeviceId,
              senderUserId: userId,
              senderDeviceId: body.deviceId,
              conversationId: s.conversationId,
              sessionId: s.sessionId,
              body: s.body,
              createdAt: new Date().toISOString(),
            });
          }
          return ok({ stored: body.shares.length, evicted: 0 });
        }

        const bundleMatch = path.match(/^\/e2e\/bundles\/([^/]+)\/([^/]+)$/);
        if (bundleMatch) {
          const [, targetUserId, targetDeviceId] = bundleMatch;
          if (targetUserId === userId) {
            const from = query.get('fromDeviceId');
            if (!from) throw new Error('400: fromDeviceId required');
            if (from === targetDeviceId) throw new Error('400: cannot claim your own bundle');
          }
          const device = userOf(targetUserId).devices.get(targetDeviceId);
          if (!device) throw new Error('404: no device');
          const otk = device.oneTimeKeys.shift();
          const preKey = otk
            ? { ...otk, type: 'otk' }
            : device.fallbackKey
              ? { ...device.fallbackKey, type: 'fallback' }
              : null;
          if (!preKey) throw new Error('409: no keys');
          return ok({
            userId: targetUserId,
            deviceId: targetDeviceId,
            curve25519Key: device.curve25519Key,
            ed25519Key: device.ed25519Key,
            deviceSignature: device.deviceSignature,
            preKey,
          });
        }
        throw new Error(`unmocked POST ${url}`);
      },

      async delete(url: string) {
        const revokeMatch = url.match(/^\/e2e\/devices\/me\/([^/]+)$/);
        if (revokeMatch) {
          const user = userOf(userId);
          const deviceId = revokeMatch[1];
          if (!user.devices.delete(deviceId)) throw new Error('404: no device');
          for (let i = shares.length - 1; i >= 0; i--) {
            if (shares[i].recipientUserId === userId && shares[i].recipientDeviceId === deviceId) {
              shares.splice(i, 1);
            }
          }
          user.listVersion += 1;
          return ok({ revoked: true, deviceId, listVersion: user.listVersion });
        }
        throw new Error(`unmocked DELETE ${url}`);
      },
    };
  }

  return {
    users,
    shares,
    apiFor,
    deviceOf: (u: string, d: string) => userOf(u).devices.get(d)!,
    setKeyshareUploadFailure: (fail: boolean) => { failKeyshareUploads = fail; },
  };
}

function memoryKeyProvider(): PickleKeyProvider {
  const keys = new Map<string, string>();
  return {
    load: async (userId) => keys.get(userId) ?? null,
    save: async (userId, key) => void keys.set(userId, key),
  };
}

type Server = ReturnType<typeof createFakeServer>;

let uniq = 0;
let vaultSeq = 0;

/** One installed device: its own vault, its own pickle key, its own account. */
function makeDevice(
  server: Server,
  userId: string,
  opts: { keyProvider?: PickleKeyProvider; vaultNamespace?: string } = {}
) {
  const keyProvider = opts.keyProvider ?? memoryKeyProvider();
  const vaultNamespace = opts.vaultNamespace ?? `v${++vaultSeq}`;
  const service = new E2EService(userId, {
    api: server.apiFor(userId) as any,
    keyProvider,
    wasmInput: wasmBytes,
    vaultNamespace,
    deviceListCacheMs: 0, // tests observe device-list changes immediately
  });
  return { userId, service, keyProvider, vaultNamespace };
}

function makeParty(server: Server, name: string, keyProvider = memoryKeyProvider()) {
  return makeDevice(server, `${name}-${uniq}`, { keyProvider });
}

async function flushQueue() {
  // replenishment / initial share claim run fire-and-forget; let them settle
  await new Promise((r) => setTimeout(r, 20));
}

const sidOf = (envelope: string) => JSON.parse(envelope).sid as string;

beforeAll(() => {
  uniq = Date.now() % 100000;
});

describe('E2EService (client crypto core)', () => {
  it('registers a device with signed keys and a stable device id on first initialize', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    await alice.service.initialize();

    const deviceId = alice.service.deviceId;
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{8,32}$/);
    const stored = server.deviceOf(alice.userId, deviceId);
    expect(stored).toBeTruthy();
    expect(stored.oneTimeKeys.length).toBe(E2E_LIMITS.OTK_TARGET);
    expect(stored.fallbackKey).toBeTruthy();
    expect(stored.curve25519Key).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(stored.deviceSignature).toMatch(/^[A-Za-z0-9+/]{86}$/);
    expect(server.users.get(alice.userId)!.listVersion).toBe(1);

    // the device id survives a restart of the same install
    const restarted = makeDevice(server, alice.userId, {
      keyProvider: alice.keyProvider,
      vaultNamespace: alice.vaultNamespace,
    });
    await restarted.service.initialize();
    expect(restarted.service.deviceId).toBe(deviceId);
    expect(server.users.get(alice.userId)!.listVersion).toBe(1); // no re-registration
  });

  it('encrypts and decrypts a full two-way conversation, consuming an OTK for the key share', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const bobDevice = server.deviceOf(bob.userId, bob.service.deviceId);
    const before = bobDevice.oneTimeKeys.length;
    const envelope = await alice.service.encryptMessage('c1', bob.userId, 'hello bob 🔐');
    expect(JSON.parse(envelope).e).toBe('megolm1');
    expect(bobDevice.oneTimeKeys.length).toBe(before - 1); // Olm session for the share

    const result = await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope,
    });
    expect(result).toEqual({ text: 'hello bob 🔐' });

    // reply flows back over Bob's own group session
    const reply = await bob.service.encryptMessage('c1', alice.userId, 'hey alice');
    const decrypted = await alice.service.decryptMessage({
      id: 'm2', conversationId: 'c1', authorId: bob.userId, content: reply,
    });
    expect(decrypted.text).toBe('hey alice');

    // several turns both ways, all on the same two group sessions
    const aliceSid = sidOf(envelope);
    for (let i = 0; i < 3; i++) {
      const a = await alice.service.encryptMessage('c1', bob.userId, `a${i}`);
      expect(sidOf(a)).toBe(aliceSid);
      expect((await bob.service.decryptMessage({ id: `ma${i}`, conversationId: 'c1', authorId: alice.userId, content: a })).text).toBe(`a${i}`);
      const b = await bob.service.encryptMessage('c1', alice.userId, `b${i}`);
      expect((await alice.service.decryptMessage({ id: `mb${i}`, conversationId: 'c1', authorId: bob.userId, content: b })).text).toBe(`b${i}`);
    }
    // no further bundle claims once the pairwise sessions exist
    expect(bobDevice.oneTimeKeys.length).toBe(before - 1);
  });

  it('lets the sender decrypt its own message (self-import) and fans out to its other devices', async () => {
    uniq++;
    const server = createFakeServer();
    const userId = `alice-${uniq}`;
    const laptop = makeDevice(server, userId);
    const phone = makeDevice(server, userId);
    const bob = makeParty(server, 'bob');
    await laptop.service.initialize();
    await phone.service.initialize();
    await bob.service.initialize();

    const envelope = await laptop.service.encryptMessage('c1', bob.userId, 'sent from the laptop');

    // the sending device reads it back from the session it imported for itself
    expect((await laptop.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: userId, content: envelope,
    })).text).toBe('sent from the laptop');

    // the account's OTHER device got a key share and reads it too
    expect((await phone.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: userId, content: envelope,
    })).text).toBe('sent from the laptop');

    // …and so does the peer
    expect((await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: userId, content: envelope,
    })).text).toBe('sent from the laptop');
  });

  it('delivers one message to every device of the recipient', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    const bobTablet = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await bobTablet.service.initialize();

    const envelope = await alice.service.encryptMessage('c1', bobId, 'to all your devices');
    const message = { id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope };

    expect((await bobPhone.service.decryptMessage(message)).text).toBe('to all your devices');
    expect((await bobTablet.service.decryptMessage(message)).text).toBe('to all your devices');
    // each device drained only its own inbox
    expect(server.shares.length).toBe(0);
  });

  it('re-keys when the peer adds a device, and the new device cannot read older sessions', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    const first = await alice.service.encryptMessage('c1', bobId, 'before the new device');
    expect((await bobPhone.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: first,
    })).text).toBe('before the new device');

    // Bob installs a second device → his list version bumps
    const bobTablet = makeDevice(server, bobId);
    await bobTablet.service.initialize();

    const second = await alice.service.encryptMessage('c1', bobId, 'after the new device');
    expect(sidOf(second)).not.toBe(sidOf(first)); // rotation

    // the pre-existing device follows the new session
    expect((await bobPhone.service.decryptMessage({
      id: 'm2', conversationId: 'c1', authorId: alice.userId, content: second,
    })).text).toBe('after the new device');
    // the new device reads what was sent after it appeared…
    expect((await bobTablet.service.decryptMessage({
      id: 'm2', conversationId: 'c1', authorId: alice.userId, content: second,
    })).text).toBe('after the new device');
    // …but never the history it was not part of
    expect((await bobTablet.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: first,
    })).failed).toBe(true);
  });

  it('stops delivering to a revoked device', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    const bobOldTablet = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await bobOldTablet.service.initialize();

    const before = await alice.service.encryptMessage('c1', bobId, 'while both devices are active');
    expect((await bobOldTablet.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: before,
    })).text).toBe('while both devices are active');

    // Bob revokes the tablet from his phone
    const own = await bobPhone.service.listOwnDevices();
    expect(own.devices.map((d) => d.deviceId).sort()).toEqual(
      [bobPhone.service.deviceId, bobOldTablet.service.deviceId].sort()
    );
    expect(own.currentDeviceId).toBe(bobPhone.service.deviceId);
    await expect(bobPhone.service.revokeDevice(bobPhone.service.deviceId)).rejects.toThrow(/device you are using/);
    await bobPhone.service.revokeDevice(bobOldTablet.service.deviceId);
    expect(server.users.get(bobId)!.devices.has(bobOldTablet.service.deviceId)).toBe(false);

    const after = await alice.service.encryptMessage('c1', bobId, 'after the revocation');
    expect(sidOf(after)).not.toBe(sidOf(before));
    expect((await bobPhone.service.decryptMessage({
      id: 'm2', conversationId: 'c1', authorId: alice.userId, content: after,
    })).text).toBe('after the revocation');
    // the revoked device gets no share and stays locked out
    expect((await bobOldTablet.service.decryptMessage({
      id: 'm2', conversationId: 'c1', authorId: alice.userId, content: after,
    })).failed).toBe(true);
  });

  it('rotates the group session after the message cap', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const first = await alice.service.encryptMessage('c1', bob.userId, 'm0');
    const sid = sidOf(first);
    let last = first;
    for (let i = 1; i < E2E_LIMITS.GROUP_SESSION_MAX_MESSAGES; i++) {
      last = await alice.service.encryptMessage('c1', bob.userId, `m${i}`);
      expect(sidOf(last)).toBe(sid);
    }
    // the cap is reached → the next send re-keys and re-shares
    const rotated = await alice.service.encryptMessage('c1', bob.userId, 'over the cap');
    expect(sidOf(rotated)).not.toBe(sid);

    expect((await bob.service.decryptMessage({
      id: 'cap-old', conversationId: 'c1', authorId: alice.userId, content: last,
    })).text).toBe(`m${E2E_LIMITS.GROUP_SESSION_MAX_MESSAGES - 1}`);
    expect((await bob.service.decryptMessage({
      id: 'cap-new', conversationId: 'c1', authorId: alice.userId, content: rotated,
    })).text).toBe('over the cap');
  });

  it('claims each key share exactly once (claimed shares are deleted server-side)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();
    await flushQueue();

    const envelope = await alice.service.encryptMessage('c1', bob.userId, 'one shot');
    expect(server.shares.length).toBe(1);

    expect((await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope,
    })).text).toBe('one shot');
    expect(server.shares.length).toBe(0); // claim-and-delete

    // re-decrypting the same ciphertext under a new id needs no new share
    expect((await bob.service.decryptMessage({
      id: 'm1-again', conversationId: 'c1', authorId: alice.userId, content: envelope,
    })).text).toBe('one shot');
    expect(server.shares.length).toBe(0);
  });

  it('re-decrypts Megolm history after a restart, from the pickled session', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const m1 = await alice.service.encryptMessage('c1', bob.userId, 'before restart');
    await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: m1 });

    // "restart" both clients: fresh service instances over the same vaults
    alice.service.dispose();
    bob.service.dispose();
    const alice2 = makeDevice(server, alice.userId, { keyProvider: alice.keyProvider, vaultNamespace: alice.vaultNamespace });
    const bob2 = makeDevice(server, bob.userId, { keyProvider: bob.keyProvider, vaultNamespace: bob.vaultNamespace });
    await alice2.service.initialize();
    await bob2.service.initialize();

    const otksBefore = server.deviceOf(bob.userId, bob2.service.deviceId).oneTimeKeys.length;

    const m2 = await alice2.service.encryptMessage('c1', bob.userId, 'after restart');
    expect(sidOf(m2)).toBe(sidOf(m1)); // pickled group session continues
    expect((await bob2.service.decryptMessage({ id: 'm2', conversationId: 'c1', authorId: alice.userId, content: m2 })).text).toBe('after restart');
    // no rotation, no new share, no bundle claim
    expect(server.deviceOf(bob.userId, bob2.service.deviceId).oneTimeKeys.length).toBe(otksBefore);
    // history re-decrypts from the restored inbound pickle (fresh message id ⇒ no cache hit)
    expect((await bob2.service.decryptMessage({ id: 'm1-fresh', conversationId: 'c1', authorId: alice.userId, content: m1 })).text).toBe('before restart');
  });

  it('rejects a message whose author does not own the group session', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    const mallory = makeParty(server, 'mallory');
    await alice.service.initialize();
    await bob.service.initialize();
    await mallory.service.initialize();

    const envelope = await alice.service.encryptMessage('c1', bob.userId, 'from alice');
    await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope });

    // same ciphertext, attributed to someone else → refused (D6)
    expect((await bob.service.decryptMessage({
      id: 'm1-forged', conversationId: 'c1', authorId: mallory.userId, content: envelope,
    })).failed).toBe(true);

    // …and refused when replayed into another conversation
    expect((await bob.service.decryptMessage({
      id: 'm1-replayed', conversationId: 'c2', authorId: alice.userId, content: envelope,
    })).failed).toBe(true);
  });

  it('still decrypts legacy olm1 ciphertext (pre-multi-device history)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    // establishes the pairwise session both directions use for key shares
    const envelope = await alice.service.encryptMessage('c1', bob.userId, 'megolm era');
    await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope });

    // an olm1 envelope, as Phase B produced them
    const internals = alice.service as unknown as {
      ensureOlmSession(userId: string, deviceId: string): Promise<{ encrypt(text: string): { messageType: 0 | 1; body: string } }>;
      persistOlmSession(userId: string, deviceId: string, session: unknown): Promise<void>;
    };
    const olm = await internals.ensureOlmSession(bob.userId, bob.service.deviceId);
    const { messageType, body } = olm.encrypt('legacy hello');
    await internals.persistOlmSession(bob.userId, bob.service.deviceId, olm);
    const legacy = buildE2EEnvelope(messageType, body);

    expect((await bob.service.decryptMessage({
      id: 'legacy-1', conversationId: 'c1', authorId: alice.userId, content: legacy,
    })).text).toBe('legacy hello');
  });

  it('versions the plaintext cache by editedAt: edits decrypt fresh, stale entries never served', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    // original message
    const original = await alice.service.encryptMessage('c1', bob.userId, 'original text');
    const first = await bob.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: original, editedAt: null,
    });
    expect(first.text).toBe('original text');

    // alice edits: fresh ciphertext, same id, new editedAt
    const edited = await alice.service.encryptMessage('c1', bob.userId, 'edited text');
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

  it('serves repeat decryptions from the plaintext cache', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const envelope = await alice.service.encryptMessage('c1', bob.userId, 'once only');
    const first = await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope });
    const second = await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope });
    expect(first.text).toBe('once only');
    expect(second.text).toBe('once only');
  });

  it('caches own sent plaintext by server message id', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    await alice.service.encryptMessage('c1', bob.userId, 'my own words');
    await alice.service.cachePlaintext('msg-42', 'c1', 'my own words');

    const own = await alice.service.decryptMessage({
      id: 'msg-42', conversationId: 'c1', authorId: alice.userId, content: 'irrelevant',
    });
    expect(own.text).toBe('my own words');

    // a non-envelope with no cache entry is honestly unrecoverable
    const missing = await alice.service.decryptMessage({
      id: 'msg-unknown', conversationId: 'c1', authorId: alice.userId, content: 'irrelevant',
    });
    expect(missing.failed).toBe(true);
  });

  it('detects a device identity change and recovers only after explicit acceptance', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const m1 = await alice.service.encryptMessage('c1', bob.userId, 'hi');
    await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: m1 });

    // Bob loses his pickle key: same install (same device id), brand-new identity
    const bobReborn = makeDevice(server, bob.userId, {
      keyProvider: memoryKeyProvider(),
      vaultNamespace: bob.vaultNamespace,
    });
    await bobReborn.service.initialize();
    expect(bobReborn.service.deviceId).toBe(bob.service.deviceId);

    // Alice's pinned identity for that device no longer matches → hard failure
    await expect(alice.service.encryptMessage('c1', bob.userId, 'are you there?')).rejects.toThrow(E2EIdentityChangedError);

    // After explicitly accepting the new identity, messaging resumes
    await alice.service.acceptNewIdentity(bob.userId);
    const m2 = await alice.service.encryptMessage('c1', bob.userId, 'welcome back');
    expect((await bobReborn.service.decryptMessage({ id: 'm2', conversationId: 'c1', authorId: alice.userId, content: m2 })).text).toBe('welcome back');
  });

  it('tracks device-list changes until the user acknowledges them', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    await alice.service.fetchDeviceList(bobId);
    expect(await alice.service.deviceListStatus(bobId)).toMatchObject({ changed: false, newDeviceIds: [] });

    const bobTablet = makeDevice(server, bobId);
    await bobTablet.service.initialize();

    await alice.service.fetchDeviceList(bobId);
    const status = await alice.service.deviceListStatus(bobId);
    expect(status.changed).toBe(true);
    expect(status.newDeviceIds).toEqual([bobTablet.service.deviceId]);

    await alice.service.acknowledgeDeviceList(bobId);
    expect(await alice.service.deviceListStatus(bobId)).toMatchObject({ changed: false, newDeviceIds: [] });
  });

  it('detects a device injected WITHOUT a listVersion bump (hostile server)', async () => {
    // The device SET is authoritative: a server that adds a device it controls
    // and replays the old listVersion must still trigger the warning, or it
    // would silently receive every future group-session key.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);
    const hiddenVersion = server.users.get(bobId)!.listVersion;

    const injected = makeDevice(server, bobId);
    await injected.service.initialize();
    server.users.get(bobId)!.listVersion = hiddenVersion; // hide the change

    await alice.service.fetchDeviceList(bobId, true);
    const status = await alice.service.deviceListStatus(bobId);
    expect(status.changed).toBe(true);
    expect(status.newDeviceIds).toContain(injected.service.deviceId);
  });

  it('treats a rolled-back device list as changed', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    const bobTablet = makeDevice(server, bobId);
    await bobTablet.service.initialize();
    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);

    // Server drops a device and rewinds the version to what Alice acknowledged
    server.users.get(bobId)!.devices.delete(bobTablet.service.deviceId);
    server.users.get(bobId)!.listVersion = 1;

    await alice.service.fetchDeviceList(bobId, true);
    expect((await alice.service.deviceListStatus(bobId)).changed).toBe(true);
  });

  it('notifies device-list listeners from the send path (no UI polling)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    await alice.service.encryptMessage('c1', bob.userId, 'hello');
    const seen: string[] = [];
    const unsubscribe = alice.service.onDeviceListChanged((userId) => seen.push(userId));

    const bobTablet = makeDevice(server, bob.userId);
    await bobTablet.service.initialize();
    await alice.service.encryptMessage('c1', bob.userId, 'hello again');

    expect(seen).toContain(bob.userId);
    unsubscribe();
  });

  it('retries an undelivered share on the SAME session instead of re-keying every message', async () => {
    // Rotating on every transient failure would burn peer one-time keys and
    // flood their inbox; the retry also carries the index-0 key, so a device
    // that recovers can still read the messages it missed.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const sessionIdOf = (envelope: string) => JSON.parse(envelope).sid as string;

    server.setKeyshareUploadFailure(true);
    const first = await alice.service.encryptMessage('c1', bob.userId, 'one');
    const second = await alice.service.encryptMessage('c1', bob.userId, 'two');
    server.setKeyshareUploadFailure(false);
    expect(sessionIdOf(second)).toBe(sessionIdOf(first)); // no rotation storm

    // Bob has no key yet
    expect((await bob.service.decryptMessage({ id: 'm1', conversationId: 'c1', authorId: alice.userId, content: first })).failed).toBe(true);

    // Past the retry backoff the share goes out on the SAME session
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      const third = await alice.service.encryptMessage('c1', bob.userId, 'three');
      expect(sessionIdOf(third)).toBe(sessionIdOf(first));
      expect((await bob.service.decryptMessage({ id: 'm3', conversationId: 'c1', authorId: alice.userId, content: third })).text).toBe('three');
      // …and the earlier messages are recoverable because the retry shared the
      // index-0 key, not the key at the current index
      expect((await bob.service.decryptMessage({ id: 'm2', conversationId: 'c1', authorId: alice.userId, content: second })).text).toBe('two');
    } finally {
      Date.now = realNow;
    }
  });

  it('establishes key-share sessions via the fallback key when OTKs are exhausted', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    server.deviceOf(bob.userId, bob.service.deviceId).oneTimeKeys = []; // drain

    const envelope = await alice.service.encryptMessage('c1', bob.userId, 'via fallback');
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

    const unknownSession = await bob.service.decryptMessage({
      id: 'g3', conversationId: 'c1', authorId: alice.userId,
      content: JSON.stringify({ v: 1, e: 'megolm1', sid: 'AAAA', b: 'QWJjZA' }),
    });
    expect(unknownSession.failed).toBe(true);
  });

  it('searches locally decrypted history per conversation, newest first', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const send = async (id: string, conversationId: string, text: string, createdAt: string) => {
      const envelope = await alice.service.encryptMessage(conversationId, bob.userId, text);
      const result = await bob.service.decryptMessage({
        id, conversationId, authorId: alice.userId, content: envelope, createdAt,
      });
      expect(result.failed).toBeUndefined();
    };
    await send('m1', 'c1', 'the quick brown fox', '2026-07-11T10:00:00.000Z');
    await send('m2', 'c1', 'lazy dog sleeps', '2026-07-11T11:00:00.000Z');
    await send('m3', 'c1', 'another FOX appears', '2026-07-11T12:00:00.000Z');
    // a different conversation must not leak into results
    await send('x1', 'c2', 'fox in another room', '2026-07-11T13:00:00.000Z');

    const hits = await bob.service.searchDecrypted('c1', 'fox');
    expect(hits.map((h) => h.messageId)).toEqual(['m3', 'm1']); // newest first, case-insensitive
    expect(hits[0].authorId).toBe(alice.userId);
    expect(hits[0].createdAt).toBe('2026-07-11T12:00:00.000Z');

    expect(await bob.service.searchDecrypted('c1', 'zebra')).toEqual([]);
  });

  it('computes matching per-device safety numbers and tracks verification', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    const bobTablet = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await bobTablet.service.initialize();

    const fromAlice = await alice.service.perDeviceSafetyNumbers(bobId);
    expect(fromAlice.map((d) => d.deviceId).sort()).toEqual(
      [bobPhone.service.deviceId, bobTablet.service.deviceId].sort()
    );
    for (const entry of fromAlice) {
      expect(entry.digits).toMatch(/^\d{60}$/);
      expect(entry.verified).toBe(false);
    }
    // the phone computes the same number for Alice's single device
    const fromPhone = await bobPhone.service.perDeviceSafetyNumbers(alice.userId);
    expect(fromPhone).toHaveLength(1);
    expect(fromPhone[0].digits).toBe(
      fromAlice.find((d) => d.deviceId === bobPhone.service.deviceId)!.digits
    );
    // …and the two of Bob's devices have different numbers
    expect(fromAlice[0].digits).not.toBe(fromAlice[1].digits);

    await alice.service.markDeviceVerified(bobId, bobPhone.service.deviceId);
    const after = await alice.service.perDeviceSafetyNumbers(bobId);
    expect(after.find((d) => d.deviceId === bobPhone.service.deviceId)!.verified).toBe(true);
    expect(after.find((d) => d.deviceId === bobTablet.service.deviceId)!.verified).toBe(false);
    expect((await alice.service.safetyNumber(bobId))!.verified).toBe(false); // not every device

    await alice.service.markIdentityVerified(bobId);
    expect((await alice.service.safetyNumber(bobId))!.verified).toBe(true);
  });

  it('replenishes one-time keys when the server stock is low', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    await alice.service.initialize();
    await flushQueue();

    // Drain the server below the low-water mark and replenish
    const device = server.deviceOf(alice.userId, alice.service.deviceId);
    device.oneTimeKeys = device.oneTimeKeys.slice(0, E2E_LIMITS.OTK_LOW_WATER - 5);
    await alice.service.replenishOneTimeKeys();
    expect(server.deviceOf(alice.userId, alice.service.deviceId).oneTimeKeys.length).toBeGreaterThanOrEqual(E2E_LIMITS.OTK_LOW_WATER);
  });
});
