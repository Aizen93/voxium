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
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  E2E_LIMITS,
  buildE2EEnvelope,
  parseE2EEnvelope,
  e2eDeviceCanonical,
  e2eDeviceCrossCanonical,
  e2eKeyCanonical,
  e2eMasterCanonical,
} from '@voxium/shared';

// The real api module drags in axios/socket.io — the service takes an
// injected client, so stub the module out entirely.
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EIdentityChangedError } from '../../services/e2e/e2eService';
import { generateRecoveryKey } from '../../services/e2e/engine';
import { initEngine, EngineAccount, EngineMasterKey } from '../../services/e2e/engine';
import type { PickleKeyProvider } from '../../services/e2e/vault';

const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve('@voxium/crypto-engine/wasm'));

/**
 * Ed25519 verification exactly as the real server does it (utils/e2eVerify.ts):
 * the fake server must reject signatures the real one would, or the client
 * could pass tests by publishing garbage.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch (err) {
    // malformed key/signature encoding — indistinguishable from a bad signature
    console.warn('test server: signature verification failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

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
  /** cross-signature by the account master key (spec §14) — null = unsigned */
  masterSignature: string | null;
  fallbackKey: PreKey | null;
  oneTimeKeys: PreKey[];
  createdAt: string;
}

interface StoredTransfer {
  id: string;
  userId: string;
  recipientDeviceId: string;
  senderDeviceId: string;
  body: string;
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
  /** account master key + its self-signature (spec §14), null before bootstrap */
  masterKey: string | null;
  masterSignature: string | null;
}

function createFakeServer() {
  const users = new Map<string, StoredUser>();
  const shares: StoredShare[] = [];
  const transfers: StoredTransfer[] = [];
  let shareSeq = 0;
  let transferSeq = 0;
  let failKeyshareUploads = false;
  let failSignaturePublish = false;
  let failDeviceListReads = false;
  const hiddenDevices = new Set<string>();
  const backups = new Map<string, { blob: string; updatedAt: string }>();
  interface StoredMessageKey {
    userId: string;
    conversationId: string;
    sessionId: string;
    blob: string;
    firstKnownIndex: number;
  }
  const messageKeys: StoredMessageKey[] = [];
  let failMasterKeyPublish = false;
  let crossSigningSupported = true;
  /** Keys the server LIES about for a device, to test what we sign (C1). */
  const forgedOwnKeys = new Map<string, { curve25519Key: string; ed25519Key: string }>();

  const ok = (data: unknown) => ({ data: { success: true, data } });
  const userOf = (userId: string): StoredUser => {
    let user = users.get(userId);
    if (!user) {
      user = { devices: new Map(), listVersion: 0, masterKey: null, masterSignature: null };
      users.set(userId, user);
    }
    return user;
  };
  const serialize = (d: StoredDevice) => ({
    deviceId: d.deviceId,
    curve25519Key: d.curve25519Key,
    ed25519Key: d.ed25519Key,
    deviceSignature: d.deviceSignature,
    // devices registered before cross-signing serialize as an explicit null
    masterSignature: d.masterSignature,
    createdAt: d.createdAt,
  });
  const masterOf = (user: StoredUser) =>
    // An old node has none of these fields at all — not even as null.
    crossSigningSupported
      ? { masterKey: user.masterKey, masterSignature: user.masterSignature, crossSigning: true }
      : {};
  const split = (url: string): [string, URLSearchParams] => {
    const [path, query] = url.split('?');
    return [path, new URLSearchParams(query ?? '')];
  };

  function apiFor(userId: string) {
    return {
      async get(url: string) {
        const [path, query] = split(url);

        if (path === '/e2e/master-transfers') {
          const deviceId = query.get('deviceId')!;
          if (!userOf(userId).devices.has(deviceId)) throw new Error('403: unknown device');
          const mine = transfers.filter((t) => t.userId === userId && t.recipientDeviceId === deviceId);
          // read-only: rows survive until the claimant acks them
          const claimed = mine.slice(0, E2E_LIMITS.MASTER_TRANSFER_STORE_CAP);
          return ok({
            transfers: claimed.map(({ userId: _u, recipientDeviceId: _r, ...rest }) => rest),
          });
        }

        if (path === '/e2e/message-keys') {
          const mine = messageKeys.filter((k) => k.userId === userId);
          const from = Number(query.get('cursor') ?? '0');
          const page = mine.slice(from, from + 2); // tiny page: exercise paging
          const next = from + page.length < mine.length ? String(from + page.length) : null;
          return ok({
            keys: page.map(({ userId: _u, firstKnownIndex: _f, ...rest }) => rest),
            nextCursor: next,
          });
        }

        if (path === '/e2e/backup') {
          const row = backups.get(userId);
          return ok({
            exists: !!row,
            blob: row?.blob ?? null,
            createdAt: row?.updatedAt ?? null,
            updatedAt: row?.updatedAt ?? null,
          });
        }

        if (path === '/e2e/devices/me') {
          const user = userOf(userId);
          const all = [...user.devices.values()]
            .filter((d) => !hiddenDevices.has(`${userId}/${d.deviceId}`))
            .map((d) => {
            const forged = forgedOwnKeys.get(`${userId}/${d.deviceId}`);
            return forged ? { ...d, ...forged } : d;
          });
          const base = { devices: all.map(serialize), listVersion: user.listVersion, ...masterOf(user) };
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
          if (failDeviceListReads) throw new Error('429: too many requests');
          const user = userOf(deviceMatch[1]);
          return ok({
            devices: [...user.devices.values()]
              .filter((d) => !hiddenDevices.has(`${deviceMatch[1]}/${d.deviceId}`))
              .map((d) => {
                const forged = forgedOwnKeys.get(`${deviceMatch[1]}/${d.deviceId}`);
                return forged ? { ...d, ...forged } : d;
              })
              .map(serialize),
            listVersion: user.listVersion,
            ...masterOf(user),
          });
        }
        throw new Error(`unmocked GET ${url}`);
      },

      async put(url: string, body: any) {
        if (url === '/e2e/devices') {
          const user = userOf(userId);
          const existing = user.devices.get(body.deviceId);
          if (!existing && user.devices.size >= E2E_LIMITS.MAX_DEVICES) {
            throw new Error('409: device limit reached');
          }
          if (!verifyEd25519(
            body.ed25519Key,
            e2eDeviceCanonical(userId, body.deviceId, body.curve25519Key, body.ed25519Key),
            body.deviceSignature
          )) {
            throw new Error('400: device signature verification failed');
          }
          user.devices.set(body.deviceId, {
            deviceId: body.deviceId,
            curve25519Key: body.curve25519Key,
            ed25519Key: body.ed25519Key,
            deviceSignature: body.deviceSignature,
            // like the real route, re-registering does NOT clear the stored
            // cross-signature — it simply stops verifying against the new keys
            masterSignature: existing?.masterSignature ?? null,
            fallbackKey: body.fallbackKey,
            oneTimeKeys: [...body.oneTimeKeys],
            createdAt: existing?.createdAt ?? new Date(Date.now() + user.devices.size).toISOString(),
          });
          user.listVersion += 1;
          return ok({
            registered: true,
            deviceId: body.deviceId,
            oneTimeKeyCount: body.oneTimeKeys.length,
            listVersion: user.listVersion,
          });
        }

        if (url === '/e2e/backup') {
          if (typeof body?.blob !== 'string' || body.blob.length === 0) throw new Error('400: bad blob');
          if (body.blob.length > E2E_LIMITS.KEY_BACKUP_MAX) throw new Error('400: blob too large');
          const updatedAt = new Date().toISOString();
          backups.set(userId, { blob: body.blob, updatedAt });
          return ok({ createdAt: updatedAt, updatedAt });
        }

        if (url === '/e2e/master-key') {
          if (failMasterKeyPublish) throw new Error('503: master key publish unavailable');
          const user = userOf(userId);
          if (!verifyEd25519(body.masterKey, e2eMasterCanonical(userId, body.masterKey), body.masterSignature)) {
            throw new Error('400: master key signature verification failed');
          }
          const entries: Array<{ deviceId: string; signature: string }> = body.deviceSignatures ?? [];
          if (entries.length > E2E_LIMITS.MAX_DEVICES) throw new Error('400: too many deviceSignatures');
          // a replaced master key invalidates every signature the old one made
          if (user.masterKey && user.masterKey !== body.masterKey) {
            for (const device of user.devices.values()) device.masterSignature = null;
          }
          for (const entry of entries) {
            const device = user.devices.get(entry.deviceId);
            if (!device) throw new Error('400: unknown device in deviceSignatures');
            if (!verifyEd25519(
              body.masterKey,
              e2eDeviceCrossCanonical(userId, device.deviceId, device.curve25519Key, device.ed25519Key),
              entry.signature
            )) {
              throw new Error('400: device cross-signature verification failed');
            }
          }
          user.masterKey = body.masterKey;
          user.masterSignature = body.masterSignature;
          for (const entry of entries) user.devices.get(entry.deviceId)!.masterSignature = entry.signature;
          user.listVersion += 1;
          return ok({
            masterKey: user.masterKey,
            masterSignature: user.masterSignature,
            signedDevices: entries.length,
            listVersion: user.listVersion,
            updatedAt: new Date().toISOString(),
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

        if (path === '/e2e/message-keys') {
          if (!Array.isArray(body?.keys) || body.keys.length === 0) throw new Error('400: bad batch');
          if (body.keys.length > E2E_LIMITS.MESSAGE_KEY_BATCH_MAX) throw new Error('400: batch too large');
          for (const k of body.keys) {
            if (typeof k.firstKnownIndex !== 'number' || !Number.isInteger(k.firstKnownIndex) || k.firstKnownIndex < 0) {
              throw new Error('400: bad firstKnownIndex');
            }
            const existing = messageKeys.find((r) => r.userId === userId && r.sessionId === k.sessionId);
            if (!existing) {
              messageKeys.push({ userId, ...k });
            } else if (k.firstKnownIndex < existing.firstKnownIndex) {
              // only ever move a session EARLIER in the ratchet
              existing.blob = k.blob;
              existing.conversationId = k.conversationId;
              existing.firstKnownIndex = k.firstKnownIndex;
            }
          }
          return ok({ stored: body.keys.length });
        }

        if (path === '/e2e/master-transfers') {
          const user = userOf(userId);
          if (!user.devices.has(body.deviceId)) throw new Error('403: unknown sender device');
          if (!Array.isArray(body.transfers) || body.transfers.length === 0 ||
              body.transfers.length > E2E_LIMITS.MASTER_TRANSFER_BATCH_MAX) {
            throw new Error('400: bad transfer batch');
          }
          for (const t of body.transfers) {
            if (t.recipientDeviceId === body.deviceId) throw new Error('400: cannot transfer to the sender');
            // recipients are scoped to the caller's own devices — the mailbox
            // has no cross-user form at all
            if (!user.devices.has(t.recipientDeviceId)) throw new Error('400: unknown recipient device');
            const envelope = parseE2EEnvelope(t.body);
            if (!envelope || envelope.e !== 'olm1') throw new Error('400: invalid body envelope');
          }
          let evicted = 0;
          for (const t of body.transfers) {
            const existing = transfers.filter(
              (row) => row.userId === userId && row.recipientDeviceId === t.recipientDeviceId
            );
            if (existing.length >= E2E_LIMITS.MASTER_TRANSFER_STORE_CAP) {
              transfers.splice(transfers.indexOf(existing[0]), 1);
              evicted++;
            }
            transfers.push({
              id: `mt-${++transferSeq}`,
              userId,
              recipientDeviceId: t.recipientDeviceId,
              senderDeviceId: body.deviceId,
              body: t.body,
              createdAt: new Date().toISOString(),
            });
          }
          return ok({ stored: body.transfers.length, evicted });
        }

        if (path === '/e2e/master-transfers/ack') {
          const user = userOf(userId);
          if (!user.devices.has(body.deviceId)) throw new Error('403: unknown device');
          if (!Array.isArray(body.ids) || body.ids.length === 0) throw new Error('400: bad ids');
          let cleared = 0;
          for (let i = transfers.length - 1; i >= 0; i--) {
            const row = transfers[i];
            if (row.userId === userId && row.recipientDeviceId === body.deviceId && body.ids.includes(row.id)) {
              transfers.splice(i, 1);
              cleared++;
            }
          }
          return ok({ cleared });
        }

        const signatureMatch = path.match(/^\/e2e\/devices\/([^/]+)\/signature$/);
        if (signatureMatch) {
          if (failSignaturePublish) throw new Error('503: signature publish unavailable');
          const user = userOf(userId);
          const device = user.devices.get(signatureMatch[1]);
          if (!device) throw new Error('404: E2E device');
          if (!user.masterKey) throw new Error('409: No master key published');
          if (!verifyEd25519(
            user.masterKey,
            e2eDeviceCrossCanonical(userId, device.deviceId, device.curve25519Key, device.ed25519Key),
            body.signature
          )) {
            throw new Error('400: device cross-signature verification failed');
          }
          device.masterSignature = body.signature;
          user.listVersion += 1;
          return ok({ deviceId: device.deviceId, signed: true, listVersion: user.listVersion });
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
        if (url === '/e2e/backup') {
          return ok({ deleted: backups.delete(userId) });
        }
        if (url === '/e2e/message-keys') {
          for (let i = messageKeys.length - 1; i >= 0; i--) {
            if (messageKeys[i].userId === userId) messageKeys.splice(i, 1);
          }
          return ok({ deleted: true });
        }
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
          for (let i = transfers.length - 1; i >= 0; i--) {
            if (transfers[i].userId === userId && transfers[i].recipientDeviceId === deviceId) {
              transfers.splice(i, 1);
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
    transfers,
    apiFor,
    deviceOf: (u: string, d: string) => userOf(u).devices.get(d)!,
    userOf,
    setKeyshareUploadFailure: (fail: boolean) => { failKeyshareUploads = fail; },
    backups,
    messageKeys,
    setSignaturePublishFailure: (fail: boolean) => { failSignaturePublish = fail; },
    setMasterKeyPublishFailure: (fail: boolean) => { failMasterKeyPublish = fail; },
    /** Rate limit / network blip on device-list reads. */
    setDeviceListReadFailure: (fail: boolean) => { failDeviceListReads = fail; },
    /** Omit one device from every list response (a server can do this at will). */
    hideDevice: (u: string, d: string | null) => {
      if (d) hiddenDevices.add(`${u}/${d}`);
      else hiddenDevices.clear();
    },
    /** Simulate a node that predates cross-signing (mid-rollout). */
    setCrossSigningSupported: (supported: boolean) => { crossSigningSupported = supported; },
    /** Answer device-list reads with keys the server chose for someone's device. */
    forgeDeviceKeys: (u: string, d: string, keys: { curve25519Key: string; ed25519Key: string }) => {
      forgedOwnKeys.set(`${u}/${d}`, keys);
    },
    /** Simulate an account registered before cross-signing shipped (D11). */
    clearCrossSigning: (u: string) => {
      const user = userOf(u);
      user.masterKey = null;
      user.masterSignature = null;
      for (const device of user.devices.values()) device.masterSignature = null;
    },
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

/**
 * A device registered straight against the fake server, without an E2EService —
 * used to play a hostile/rogue device of an account (it can talk Olm, but it
 * holds no account master key).
 */
async function registerRawDevice(server: Server, userId: string, deviceId: string) {
  const account = new EngineAccount();
  const api = server.apiFor(userId);
  account.generateOneTimeKeys(2);
  const oneTimeKeys = account.oneTimeKeys() as Array<{ keyId: string; key: string }>;
  account.generateFallbackKey();
  const fallback = account.fallbackKey() as { keyId: string; key: string };
  const signPreKey = (k: { keyId: string; key: string }) => ({
    ...k,
    signature: account.sign(e2eKeyCanonical(userId, deviceId, account.curve25519Key(), k.keyId, k.key)),
  });
  await api.put('/e2e/devices', {
    deviceId,
    curve25519Key: account.curve25519Key(),
    ed25519Key: account.ed25519Key(),
    deviceSignature: account.sign(
      e2eDeviceCanonical(userId, deviceId, account.curve25519Key(), account.ed25519Key())
    ),
    oneTimeKeys: oneTimeKeys.map(signPreKey),
    fallbackKey: signPreKey(fallback),
  });
  account.markKeysAsPublished();

  /** Olm-encrypt an arbitrary payload to another device of the same account. */
  const sendMasterTransfer = async (recipientDeviceId: string, master: EngineMasterKey) => {
    const res = await api.post(
      `/e2e/bundles/${userId}/${recipientDeviceId}?fromDeviceId=${encodeURIComponent(deviceId)}`
    );
    const bundle = res.data.data as { curve25519Key: string; preKey: { key: string } };
    const session = account.createOutboundSession(bundle.curve25519Key, bundle.preKey.key);
    const { messageType, body } = session.encryptMasterSecret(master) as {
      messageType: 0 | 1;
      body: string;
    };
    await api.post('/e2e/master-transfers', {
      deviceId,
      transfers: [{ recipientDeviceId, body: buildE2EEnvelope(messageType, body) }],
    });
  };

  return { deviceId, account, api, sendMasterTransfer };
}

beforeAll(async () => {
  uniq = Date.now() % 100000;
  // the raw-engine helpers above run outside any E2EService
  await initEngine(wasmBytes);
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
    // registration + the master-key bootstrap that cross-signs it (spec §14)
    expect(server.users.get(alice.userId)!.listVersion).toBe(2);

    // the device id survives a restart of the same install
    const restarted = makeDevice(server, alice.userId, {
      keyProvider: alice.keyProvider,
      vaultNamespace: alice.vaultNamespace,
    });
    await restarted.service.initialize();
    expect(restarted.service.deviceId).toBe(deviceId);
    // neither the device nor the master key is re-published
    expect(server.users.get(alice.userId)!.listVersion).toBe(2);
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

  it('tracks device-list changes until the peer cross-signs the new device', async () => {
    // Since §14 an unsigned device cannot be acknowledged away (D8): only the
    // account key vouching for it (or a revocation) clears the warning.
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
    expect(status.unsignedDeviceIds).toEqual([bobTablet.service.deviceId]);

    await alice.service.acknowledgeDeviceList(bobId);
    const acknowledged = await alice.service.deviceListStatus(bobId);
    expect(acknowledged.changed).toBe(true);
    expect(acknowledged.newDeviceIds).toEqual([bobTablet.service.deviceId]);

    await bobPhone.service.approveDevice(bobTablet.service.deviceId);
    await alice.service.fetchDeviceList(bobId, true);
    expect(await alice.service.deviceListStatus(bobId)).toMatchObject({
      changed: false,
      newDeviceIds: [],
      unsignedDeviceIds: [],
    });
  });

  it('keeps warning after an injected device is withdrawn again (flap-back)', async () => {
    // The device already holds the session key it was fanned; erasing the
    // warning because the list reverted would hide that entirely.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);

    const injected = makeDevice(server, bobId);
    await injected.service.initialize();
    await alice.service.fetchDeviceList(bobId, true);
    expect((await alice.service.deviceListStatus(bobId)).changed).toBe(true);

    // server withdraws it and replays the acknowledged version
    server.users.get(bobId)!.devices.delete(injected.service.deviceId);
    server.users.get(bobId)!.listVersion = 1;
    await alice.service.fetchDeviceList(bobId, true);

    const status = await alice.service.deviceListStatus(bobId);
    expect(status.changed).toBe(true);
    expect(status.newDeviceIds).toContain(injected.service.deviceId);
  });

  it('acknowledges only the devices the UI actually showed (account without cross-signing)', async () => {
    // Pre-§14 accounts publish no master key, so nothing can be cross-signed
    // and acknowledgement is the only control there is (D11).
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    server.clearCrossSigning(bobId);
    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);

    const first = makeDevice(server, bobId);
    await first.service.initialize();
    server.clearCrossSigning(bobId);
    await alice.service.fetchDeviceList(bobId, true);
    const shown = (await alice.service.deviceListStatus(bobId)).deviceIds;

    // a second device slips in between render and click
    const second = makeDevice(server, bobId);
    await second.service.initialize();
    server.clearCrossSigning(bobId);
    await alice.service.fetchDeviceList(bobId, true);

    await alice.service.acknowledgeDeviceList(bobId, shown);
    const status = await alice.service.deviceListStatus(bobId);
    expect(status.changed).toBe(true);
    expect(status.newDeviceIds).toEqual([second.service.deviceId]);
    // no master key ⇒ "unsigned" carries no information and is not reported
    expect(status.unsignedDeviceIds).toEqual([]);
  });

  it('refuses to send when every device of the peer fails signature verification', async () => {
    // A tampered device entry is dropped, not trusted. Encrypting to an empty
    // device set would hand the user ciphertext their peer can never read.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bob = makeParty(server, 'bob');
    await alice.service.initialize();
    await bob.service.initialize();

    const impostor = makeParty(server, 'impostor');
    await impostor.service.initialize();
    const evil = server.deviceOf(impostor.userId, impostor.service.deviceId);
    const target = server.deviceOf(bob.userId, bob.service.deviceId);
    target.curve25519Key = evil.curve25519Key;
    target.ed25519Key = evil.ed25519Key; // signature no longer covers these keys

    await expect(alice.service.encryptMessage('c1', bob.userId, 'nope')).rejects.toThrow(/no usable E2E device/);
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

    // Comparing the ACCOUNT number vouches for the account key, and through it
    // for every device that key signs — but not for the tablet, which Bob
    // never approved. Blessing that one would put "Verified" on precisely the
    // device cross-signing exists to expose.
    await alice.service.markIdentityVerified(bobId);
    const afterAccount = await alice.service.perDeviceSafetyNumbers(bobId);
    expect(afterAccount.find((d) => d.deviceId === bobTablet.service.deviceId)!.verified).toBe(false);
    expect((await alice.service.safetyNumber(bobId))!.verified).toBe(false);

    // Once Bob approves the tablet, it is covered by the same comparison —
    // no second number to read out.
    await bobPhone.service.approveDevice(bobTablet.service.deviceId);
    const afterApproval = await alice.service.perDeviceSafetyNumbers(bobId);
    expect(afterApproval.every((d) => d.verified)).toBe(true);
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

// ─── Cross-signing (spec §14) ────────────────────────────────────────────────

describe('E2EService (cross-signing)', () => {
  /** Is this device carrying a signature the account master key really made? */
  const crossSignatureValid = (server: Server, userId: string, deviceId: string): boolean => {
    const user = server.userOf(userId);
    const device = user.devices.get(deviceId)!;
    if (!user.masterKey || !device.masterSignature) return false;
    return verifyEd25519(
      user.masterKey,
      e2eDeviceCrossCanonical(userId, deviceId, device.curve25519Key, device.ed25519Key),
      device.masterSignature
    );
  };

  it('bootstraps an account master key on the first device and cross-signs it (D1, D5)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    await alice.service.initialize();
    await flushQueue();

    const user = server.userOf(alice.userId);
    expect(user.masterKey).toMatch(/^[A-Za-z0-9+/]{43}$/);
    // D1: the published key proves possession of its own private half
    expect(verifyEd25519(user.masterKey!, e2eMasterCanonical(alice.userId, user.masterKey!), user.masterSignature!))
      .toBe(true);
    // D2: …and it vouches for the device that published it
    expect(crossSignatureValid(server, alice.userId, alice.service.deviceId)).toBe(true);

    expect(alice.service.hasMasterSecret()).toBe(true);
    expect(alice.service.canApproveDevices()).toBe(true);

    const own = await alice.service.listOwnDevices();
    expect(own.masterKey).toBe(user.masterKey);
    expect(own.canApprove).toBe(true);
    expect(own.devices.every((d) => d.crossSigned)).toBe(true);

    // a restart re-opens the SEALED secret from the vault, without republishing
    const restarted = makeDevice(server, alice.userId, {
      keyProvider: alice.keyProvider,
      vaultNamespace: alice.vaultNamespace,
    });
    await restarted.service.initialize();
    expect(restarted.service.hasMasterSecret()).toBe(true);
    expect(server.userOf(alice.userId).masterKey).toBe(user.masterKey); // never replaced
  });

  it('leaves a second device unsigned until an existing one approves it, then hands over the key (D6)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();

    // registering while a master key exists must NOT throw and must NOT replace it
    expect(server.userOf(aliceId).masterKey).toBeTruthy();
    expect(laptop.service.hasMasterSecret()).toBe(false);
    expect(laptop.service.canApproveDevices()).toBe(false);
    expect(server.deviceOf(aliceId, laptop.service.deviceId).masterSignature).toBeNull();
    await expect(laptop.service.approveDevice(phone.service.deviceId)).rejects.toThrow(
      /does not hold the account key/
    );

    await phone.service.approveDevice(laptop.service.deviceId);
    expect(crossSignatureValid(server, aliceId, laptop.service.deviceId)).toBe(true);
    expect(server.transfers).toHaveLength(1);

    expect(await laptop.service.claimMasterTransfers()).toBe(true);
    expect(laptop.service.hasMasterSecret()).toBe(true);
    expect(laptop.service.canApproveDevices()).toBe(true);
    expect(server.transfers).toHaveLength(0); // claim-and-delete

    // the approved device can now approve a third one on its own
    const desktop = makeDevice(server, aliceId);
    await desktop.service.initialize();
    await laptop.service.approveDevice(desktop.service.deviceId);
    expect(crossSignatureValid(server, aliceId, desktop.service.deviceId)).toBe(true);
    expect(await desktop.service.claimMasterTransfers()).toBe(true);
    // …with the SAME account key — approvals never fork the account identity
    expect((await desktop.service.listOwnDevices()).masterKey).toBe(server.userOf(aliceId).masterKey);
  });

  it('picks up an approved master secret on the next start (initialize claims transfers)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();

    await phone.service.approveDevice(laptop.service.deviceId);

    const restarted = makeDevice(server, aliceId, {
      keyProvider: laptop.keyProvider,
      vaultNamespace: laptop.vaultNamespace,
    });
    await restarted.service.initialize();
    await flushQueue();
    expect(restarted.service.hasMasterSecret()).toBe(true);
    expect(server.transfers).toHaveLength(0);

    // and it now lives sealed in the vault: a further restart needs no transfer
    const again = makeDevice(server, aliceId, {
      keyProvider: laptop.keyProvider,
      vaultNamespace: laptop.vaultNamespace,
    });
    await again.service.initialize();
    expect(again.service.hasMasterSecret()).toBe(true);
  });

  it('raises no new-device warning for a cross-signed device — peer or own (D8)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.encryptMessage('c1', bobId, 'hello');

    // Bob adds a device and approves it BEFORE Alice looks again: trust is
    // transitive from an account key she already pinned, so there is nothing
    // to warn about.
    const bobTablet = makeDevice(server, bobId);
    await bobTablet.service.initialize();
    await bobPhone.service.approveDevice(bobTablet.service.deviceId);

    await alice.service.fetchDeviceList(bobId, true);
    const peer = await alice.service.deviceListStatus(bobId);
    expect(peer.deviceIds).toContain(bobTablet.service.deviceId);
    expect(peer.newDeviceIds).toEqual([]);
    expect(peer.unsignedDeviceIds).toEqual([]);
    expect(peer.changed).toBe(false);

    // Same on our OWN account: an approved device of ours is not "unrecognised"
    const aliceLaptop = makeDevice(server, alice.userId);
    await aliceLaptop.service.initialize();
    await alice.service.approveDevice(aliceLaptop.service.deviceId);
    const own = await alice.service.deviceListStatus(alice.userId);
    expect(own.newDeviceIds).toEqual([]);
    expect(own.unsignedDeviceIds).toEqual([]);
    expect(own.changed).toBe(false);
  });

  it('keeps flagging an unsigned device no acknowledgement can clear, until it is revoked (D8)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await alice.service.fetchDeviceList(bobId, true);

    const injected = makeDevice(server, bobId);
    await injected.service.initialize();
    await alice.service.fetchDeviceList(bobId, true);

    for (let attempt = 0; attempt < 2; attempt++) {
      await alice.service.acknowledgeDeviceList(bobId);
      const status = await alice.service.deviceListStatus(bobId);
      expect(status.changed).toBe(true);
      expect(status.newDeviceIds).toEqual([injected.service.deviceId]);
      expect(status.unsignedDeviceIds).toEqual([injected.service.deviceId]);
    }

    // …but the session key still goes out (warn-not-block, spec §12.5)
    const envelope = await alice.service.encryptMessage('c1', bobId, 'delivered anyway');
    expect((await injected.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope,
    })).text).toBe('delivered anyway');

    await bobPhone.service.revokeDevice(injected.service.deviceId);
    await alice.service.fetchDeviceList(bobId, true);
    const cleared = await alice.service.deviceListStatus(bobId);
    // gone from the list ⇒ nothing left to label as unsigned…
    expect(cleared.unsignedDeviceIds).toEqual([]);
    // …but the sticky notice survives, because Alice cannot tell a revocation
    // from a hostile withdrawal and that device already holds a session key
    // (§12.5 flap-back).
    expect(cleared.newDeviceIds).toEqual([injected.service.deviceId]);
  });

  it('computes one account safety number per peer, stable across cross-signed devices (D3, D9)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    const fromAlice = await alice.service.accountSafetyNumber(bobId);
    const fromBob = await bobPhone.service.accountSafetyNumber(alice.userId);
    expect(fromAlice!.digits).toMatch(/^\d{60}$/);
    expect(fromAlice!.digits).toBe(fromBob!.digits);
    expect(fromAlice!.verified).toBe(false);
    // …and it is NOT one of the per-device numbers
    const perDevice = await alice.service.perDeviceSafetyNumbers(bobId);
    expect(perDevice.map((d) => d.digits)).not.toContain(fromAlice!.digits);
    expect(perDevice.every((d) => d.crossSigned)).toBe(true);

    await alice.service.markIdentityVerified(bobId);
    expect((await alice.service.accountSafetyNumber(bobId))!.verified).toBe(true);
    expect(await alice.service.isAccountVerified(bobId)).toBe(true);

    // THE payoff: a new device of Bob changes nothing — same number, and it
    // inherits the account-level verification instead of demanding a new one.
    const bobTablet = makeDevice(server, bobId);
    await bobTablet.service.initialize();
    await bobPhone.service.approveDevice(bobTablet.service.deviceId);

    const after = await alice.service.accountSafetyNumber(bobId);
    expect(after!.digits).toBe(fromAlice!.digits);
    expect(after!.verified).toBe(true);
    const devices = (await alice.service.fetchDeviceList(bobId, true)).devices;
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.crossSigned && d.verified)).toBe(true);
  });

  it('treats a changed master key as an account identity change (D7)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    const before = await alice.service.accountSafetyNumber(bobId);
    await alice.service.markIdentityVerified(bobId);

    // the server swaps in a master key of its own, correctly self-signed
    const forged = new EngineMasterKey();
    const user = server.userOf(bobId);
    user.masterKey = forged.publicKey();
    user.masterSignature = forged.sign(e2eMasterCanonical(bobId, forged.publicKey()));
    for (const device of user.devices.values()) device.masterSignature = null;
    user.listVersion += 1;

    await expect(alice.service.fetchDeviceList(bobId, true)).rejects.toThrow(E2EIdentityChangedError);
    await expect(alice.service.encryptMessage('c1', bobId, 'nope')).rejects.toThrow(E2EIdentityChangedError);

    await alice.service.acceptNewIdentity(bobId);
    const after = await alice.service.accountSafetyNumber(bobId);
    expect(after!.digits).not.toBe(before!.digits);
    expect(after!.verified).toBe(false); // the old comparison is void
  });

  it('ignores a master key whose self-signature does not verify (D7 step 1)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    // A key nobody can sign with: the account must read as having none, and its
    // devices must NOT inherit any trust from it.
    const user = server.userOf(bobId);
    user.masterKey = new EngineMasterKey().publicKey();
    await expect(alice.service.fetchDeviceList(bobId, true)).resolves.toBeTruthy();
    const list = await alice.service.fetchDeviceList(bobId, true);
    expect(list.masterKey).toBeNull();
    expect(list.devices.every((d) => !d.crossSigned)).toBe(true);
    expect(await alice.service.accountSafetyNumber(bobId)).toBeNull();
  });

  it('rejects a master-secret transfer that does not derive to the published key (D6)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();

    const published = server.userOf(aliceId).masterKey!;
    const rogue = await registerRawDevice(server, aliceId, 'rogue-device-1');
    const impostor = new EngineMasterKey();

    // A rogue device pushes ITS OWN master key: the receiver must refuse it,
    // because the key it derives is not the one the account publishes.
    await rogue.sendMasterTransfer(laptop.service.deviceId, impostor);
    expect(await laptop.service.claimMasterTransfers()).toBe(false);
    expect(laptop.service.hasMasterSecret()).toBe(false);
    expect(impostor.publicKey()).not.toBe(published);

    // The "announces the real key but ships a different secret" forgery is no
    // longer expressible: the engine derives the announced key from the secret
    // it is given, and JS has no way to build the payload by hand (§14).
    expect(server.deviceOf(aliceId, laptop.service.deviceId).masterSignature).toBeNull();

    // the genuine handover still works afterwards
    await phone.service.approveDevice(laptop.service.deviceId);
    expect(await laptop.service.claimMasterTransfers()).toBe(true);
    expect(laptop.service.hasMasterSecret()).toBe(true);
  });

  it('keeps its own master secret when the server serves a different account key (D5)', async () => {
    // A server that swaps the published master key must not be able to make us
    // delete the secret we hold (that would destroy approval capability and
    // break sending) nor adopt its key (that would hand it the account).
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const realMaster = server.userOf(aliceId).masterKey;

    const replacement = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = replacement.publicKey();
    user.masterSignature = replacement.sign(e2eMasterCanonical(aliceId, replacement.publicKey()));
    for (const device of user.devices.values()) device.masterSignature = null;

    const restarted = makeDevice(server, aliceId, {
      keyProvider: phone.keyProvider,
      vaultNamespace: phone.vaultNamespace,
    });
    await restarted.service.initialize();
    await flushQueue();

    // the local secret survives, and the imposter key is neither adopted nor
    // overwritten by a silent republish — the conflict is surfaced instead
    expect(restarted.service.hasMasterSecret()).toBe(true);
    expect(restarted.service.hasMasterKeyConflict()).toBe(true);
    expect(server.userOf(aliceId).masterKey).toBe(replacement.publicKey());
    expect(realMaster).not.toBe(replacement.publicKey());
  });

  it('does not mint a replacement master key when the server claims there is none', async () => {
    // "The account has no master key" is the server's word. A client that
    // believed it would publish a fresh key, wiping every device signature and
    // forcing an identity-change prompt on every peer — a remote trust reset.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const original = server.userOf(aliceId).masterKey;

    // second install of the same account: no secret, but it pinned the key
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();
    expect(laptop.service.hasMasterSecret()).toBe(false);

    // server now pretends the account never had a master key
    const user = server.userOf(aliceId);
    user.masterKey = null;
    user.masterSignature = null;

    const relaunched = makeDevice(server, aliceId, {
      keyProvider: laptop.keyProvider,
      vaultNamespace: laptop.vaultNamespace,
    });
    await relaunched.service.initialize();
    await flushQueue();

    // nothing was minted or published: the pin still rules
    expect(relaunched.service.hasMasterSecret()).toBe(false);
    expect(server.userOf(aliceId).masterKey).toBeNull();
    expect(original).toBeTruthy();
  });

  it('does not mark a server-supplied OWN master key as verified (H1)', async () => {
    // A fresh install cannot prove the account key it is handed. Pinning it
    // "verified" would let the server sign its own injected devices with it and
    // have them auto-trusted with no warning.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const evil = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = evil.publicKey();
    user.masterSignature = evil.sign(e2eMasterCanonical(aliceId, evil.publicKey()));

    const fresh = makeDevice(server, aliceId);
    await fresh.service.initialize();
    await flushQueue();

    // it holds no secret, so it must not claim the key as proven
    expect(fresh.service.hasMasterSecret()).toBe(false);
    const account = await fresh.service.accountSafetyNumber(aliceId).catch(() => null);
    if (account) expect(account.verified).toBe(false);
  });

  it('does not let a first-seen master key silently bless the devices it arrives with (H2)', async () => {
    // Alice knows Bob from before cross-signing. The server publishes a master
    // key for Bob AND a device signed by it in the same breath. Trust must not
    // be transitive from a key the user has never acknowledged.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await flushQueue();

    // Rewind Bob's account to its pre-cross-signing state BEFORE Alice ever
    // sees it, so she pins his devices with no master key in play.
    const bobUser = server.userOf(bobId);
    bobUser.masterKey = null;
    bobUser.masterSignature = null;
    for (const d of bobUser.devices.values()) d.masterSignature = null;

    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);
    expect((await alice.service.deviceListStatus(bobId)).changed).toBe(false);

    // server mints a master key for Bob and a device cross-signed by it
    const evil = new EngineMasterKey();
    bobUser.masterKey = evil.publicKey();
    bobUser.masterSignature = evil.sign(e2eMasterCanonical(bobId, evil.publicKey()));
    const injected = makeDevice(server, bobId);
    await injected.service.initialize();
    const injectedRow = server.deviceOf(bobId, injected.service.deviceId);
    injectedRow.masterSignature = evil.sign(
      e2eDeviceCrossCanonical(bobId, injectedRow.deviceId, injectedRow.curve25519Key, injectedRow.ed25519Key)
    );

    await alice.service.fetchDeviceList(bobId, true);
    const status = await alice.service.deviceListStatus(bobId);
    expect(status.changed).toBe(true);
    expect(status.newDeviceIds).toContain(injected.service.deviceId);
  });

  it('works unchanged against devices registered before cross-signing (D11)', async () => {
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    const bobTablet = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await bobTablet.service.initialize();
    // both of Bob's devices predate §14: no master key, masterSignature null
    server.clearCrossSigning(bobId);

    const list = await alice.service.fetchDeviceList(bobId, true);
    expect(list.masterKey).toBeNull();
    expect(list.devices).toHaveLength(2);
    expect(list.devices.every((d) => !d.crossSigned)).toBe(true);

    const envelope = await alice.service.encryptMessage('c1', bobId, 'still encrypted');
    expect((await bobPhone.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope,
    })).text).toBe('still encrypted');
    expect((await bobTablet.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: alice.userId, content: envelope,
    })).text).toBe('still encrypted');

    // no master key ⇒ no account number and no unsigned-device noise
    expect(await alice.service.accountSafetyNumber(bobId)).toBeNull();
    expect((await alice.service.deviceListStatus(bobId)).unsignedDeviceIds).toEqual([]);
    // per-device verification is still the fallback control there
    await alice.service.markIdentityVerified(bobId);
    expect((await alice.service.perDeviceSafetyNumbers(bobId)).every((d) => d.verified)).toBe(true);
  });

  it('cross-signs the keys it holds, not the ones the server reports (C1)', async () => {
    // We own this device's private halves, so taking the server's word for the
    // public ones is pure downside: a server that answers with an Olm identity
    // IT generated would collect a valid account signature over a key it
    // controls, and every peer who compared the account safety number would
    // then trust that device silently — the exact attack cross-signing exists
    // to stop, with the warning switched off.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();

    const realKeys = server.deviceOf(aliceId, phone.service.deviceId);
    const imposter = new EngineAccount();
    server.forgeDeviceKeys(aliceId, phone.service.deviceId, {
      curve25519Key: imposter.curve25519Key(),
      ed25519Key: imposter.ed25519Key(),
    });
    // drop the existing signature so bootstrap re-signs on the next launch
    server.deviceOf(aliceId, phone.service.deviceId).masterSignature = null;

    const restarted = makeDevice(server, aliceId, {
      keyProvider: phone.keyProvider,
      vaultNamespace: phone.vaultNamespace,
    });
    await restarted.service.initialize();
    await flushQueue();

    const masterKey = server.userOf(aliceId).masterKey!;
    const published = server.deviceOf(aliceId, phone.service.deviceId).masterSignature;
    expect(published).toBeTruthy();
    // signs OUR keys…
    expect(
      verifyEd25519(
        masterKey,
        e2eDeviceCrossCanonical(aliceId, phone.service.deviceId, realKeys.curve25519Key, realKeys.ed25519Key),
        published!
      )
    ).toBe(true);
    // …and never the server's substitutes
    expect(
      verifyEd25519(
        masterKey,
        e2eDeviceCrossCanonical(
          aliceId,
          phone.service.deviceId,
          imposter.curve25519Key(),
          imposter.ed25519Key()
        ),
        published!
      )
    ).toBe(false);
  });

  it('does not treat a master key seen on a quiet response as acknowledged (C2)', async () => {
    // The H2 gate is "only a key the user acknowledged may vouch for devices".
    // Advancing it whenever nothing is outstanding hands the attack back in two
    // steps: publish the forged key alone (looks settled), then add a device
    // signed by it (now "transitively trusted"). Splitting one response into
    // two must not buy the server anything.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();

    // Alice knows Bob from before cross-signing: no master key in sight.
    server.clearCrossSigning(bobId);
    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);

    // Response 1: a forged account key, alone, nothing else changed.
    const forged = new EngineMasterKey();
    const bob = server.userOf(bobId);
    bob.masterKey = forged.publicKey();
    bob.masterSignature = forged.sign(e2eMasterCanonical(bobId, forged.publicKey()));
    bob.listVersion += 1;
    await alice.service.fetchDeviceList(bobId, true);

    // Response 2: a device the forged key vouches for.
    const injected = makeDevice(server, bobId);
    await injected.service.initialize();
    const victimDevice = server.deviceOf(bobId, injected.service.deviceId);
    victimDevice.masterSignature = forged.sign(
      e2eDeviceCrossCanonical(bobId, victimDevice.deviceId, victimDevice.curve25519Key, victimDevice.ed25519Key)
    );
    await alice.service.fetchDeviceList(bobId, true);

    const status = await alice.service.deviceListStatus(bobId);
    expect(status.changed).toBe(true);
    expect(status.newDeviceIds).toContain(injected.service.deviceId);
  });

  it('keeps sending when our own account key conflicts, and offers a way out (C3/P9)', async () => {
    // fetchDeviceList refreshes OUR OWN list on every send. Raising the
    // peer-facing "identity changed" error there would not inform anyone — it
    // would make encrypted DMs permanently unsendable, with no UI able to
    // clear it because the warning is filed under our own id.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const bob = makeParty(server, 'bob');
    await phone.service.initialize();
    await bob.service.initialize();
    await flushQueue();
    await phone.service.encryptMessage('c1', bob.userId, 'before the swap');

    const replacement = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = replacement.publicKey();
    user.masterSignature = replacement.sign(e2eMasterCanonical(aliceId, replacement.publicKey()));
    for (const device of user.devices.values()) device.masterSignature = null;

    const restarted = makeDevice(server, aliceId, {
      keyProvider: phone.keyProvider,
      vaultNamespace: phone.vaultNamespace,
    });
    await restarted.service.initialize();
    await flushQueue();
    expect(restarted.service.hasMasterKeyConflict()).toBe(true);

    // still usable — the conflict is a warning, not a lockout
    const envelope = await restarted.service.encryptMessage('c1', bob.userId, 'still sending');
    expect(envelope).toBeTruthy();

    // and the user has an exit: a deliberate new account identity
    await restarted.service.resetAccountIdentity();
    expect(restarted.service.hasMasterKeyConflict()).toBe(false);
    expect(server.userOf(aliceId).masterKey).not.toBe(replacement.publicKey());
    const own = server.deviceOf(aliceId, restarted.service.deviceId);
    expect(
      verifyEd25519(
        server.userOf(aliceId).masterKey!,
        e2eDeviceCrossCanonical(aliceId, own.deviceId, own.curve25519Key, own.ed25519Key),
        own.masterSignature!
      )
    ).toBe(true);
  });

  it('does not bootstrap an account key against a node that predates cross-signing (P10)', async () => {
    // An old node omits the master-key fields entirely, which reads exactly
    // like "this account has no key". Acting on that during a rolling deploy
    // would mint a replacement for an account that already has one, wiping
    // every signature and prompting every peer.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const established = server.userOf(aliceId).masterKey;
    expect(established).toBeTruthy();

    server.setCrossSigningSupported(false);
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();

    // nothing minted, nothing replaced, nothing pinned from a blank answer
    expect(server.userOf(aliceId).masterKey).toBe(established);
    expect(laptop.service.hasMasterSecret()).toBe(false);
    expect(laptop.service.hasMasterKeyConflict()).toBe(false);

    // and a device the old node cannot describe is not reported as unsigned
    const status = await laptop.service.deviceListStatus(aliceId);
    expect(status.unsignedDeviceIds).toEqual([]);
  });

  it('leaves a master transfer in place until it has actually been used (P1)', async () => {
    // The approving device publishes the cross-signature right after queueing
    // the secret, so a claim that consumed the row and then failed would leave
    // a device everyone trusts, that holds no key, and that is no longer
    // offered for approval — unrecoverable. Reads must not consume.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();
    await phone.service.approveDevice(laptop.service.deviceId);
    expect(server.transfers).toHaveLength(1);

    // a claim that fails partway — a rate limit on a laptop that just woke up —
    // must leave the row where it is
    server.setDeviceListReadFailure(true);
    await expect(laptop.service.claimMasterTransfers()).rejects.toThrow();
    expect(server.transfers).toHaveLength(1);
    expect(laptop.service.hasMasterSecret()).toBe(false);

    // the retry then works off the same row
    server.setDeviceListReadFailure(false);
    expect(await laptop.service.claimMasterTransfers()).toBe(true);
    expect(laptop.service.hasMasterSecret()).toBe(true);
    expect(server.transfers).toHaveLength(0); // acked only after it was used
  });

  it('keeps a master transfer whose failure is not the payload’s fault (S1)', async () => {
    // The whole point of read-then-ack is that a device already published as
    // cross-signed can still receive the key. Dropping a row because the SENDER
    // could not be looked up would put the dead end straight back, with the
    // client doing the deleting instead of the server.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();

    // the laptop's very first look at its own account is served without the
    // phone, so it never pins the device that is about to approve it
    const laptop = makeDevice(server, aliceId);
    server.hideDevice(aliceId, phone.service.deviceId);
    await laptop.service.initialize();
    await flushQueue();

    await phone.service.approveDevice(laptop.service.deviceId);
    expect(server.transfers).toHaveLength(1);

    expect(await laptop.service.claimMasterTransfers()).toBe(false);
    expect(laptop.service.hasMasterSecret()).toBe(false);
    expect(server.transfers).toHaveLength(1); // NOT discarded

    // and once the list is honest again the same row still delivers
    server.hideDevice(aliceId, null);
    expect(await laptop.service.claimMasterTransfers()).toBe(true);
    expect(laptop.service.hasMasterSecret()).toBe(true);
    expect(server.transfers).toHaveLength(0);
  });

  it('discards a transfer that can never work, so it cannot retry forever (S1b)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();
    await phone.service.approveDevice(laptop.service.deviceId);

    // corrupt the envelope: no retry can ever make this parse
    server.transfers[0].body = 'not-an-envelope';
    const fresh = makeDevice(server, aliceId, {
      keyProvider: laptop.keyProvider,
      vaultNamespace: laptop.vaultNamespace,
    });
    await fresh.service.initialize();
    await flushQueue();
    expect(server.transfers).toHaveLength(0);
    expect(fresh.service.hasMasterSecret()).toBe(false);
  });

  it('stops carrying cross-signatures forward once the server has proved it can send them (S2)', async () => {
    // The rollout grace exists for nodes that predate cross-signing. Letting it
    // apply forever would hand the server a mute button: drop one boolean and
    // "these devices are not signed by the account key" becomes silence.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const bobId = `bob-${uniq}`;
    const bobPhone = makeDevice(server, bobId);
    await alice.service.initialize();
    await bobPhone.service.initialize();
    await flushQueue();

    // healthy read from a capable node: Bob's device is signed and quiet
    await alice.service.fetchDeviceList(bobId, true);
    await alice.service.acknowledgeDeviceList(bobId);
    expect((await alice.service.deviceListStatus(bobId)).unsignedDeviceIds).toEqual([]);

    // now the server withholds the signatures AND the capability flag
    server.setCrossSigningSupported(false);
    for (const device of server.userOf(bobId).devices.values()) device.masterSignature = null;
    await alice.service.fetchDeviceList(bobId, true);

    const status = await alice.service.deviceListStatus(bobId);
    expect(status.unsignedDeviceIds).toContain(bobPhone.service.deviceId);
  });

  it('clears the master-key conflict when the account key matches again (S3)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const real = server.userOf(aliceId).masterKey!;
    const realSignature = server.userOf(aliceId).masterSignature!;

    const imposter = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = imposter.publicKey();
    user.masterSignature = imposter.sign(e2eMasterCanonical(aliceId, imposter.publicKey()));
    await phone.service.fetchDeviceList(aliceId, true);
    expect(phone.service.hasMasterKeyConflict()).toBe(true);

    // the server goes back to serving the real key: a latched warning would
    // keep a destructive "reset your identity" affordance on screen forever
    user.masterKey = real;
    user.masterSignature = realSignature;
    await phone.service.fetchDeviceList(aliceId, true);
    expect(phone.service.hasMasterKeyConflict()).toBe(false);
  });

  it('does not destroy the key it holds when a reset cannot be published (S4)', async () => {
    // A reset can be replacing a WORKING key. Sealing the new one first means a
    // failed publish leaves the device holding a key the account never heard
    // of, having thrown away the one that worked.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const original = server.userOf(aliceId).masterKey;

    server.setMasterKeyPublishFailure(true);
    await expect(phone.service.resetAccountIdentity()).rejects.toThrow();
    server.setMasterKeyPublishFailure(false);

    // nothing changed: the account key is intact and this device still holds it
    expect(server.userOf(aliceId).masterKey).toBe(original);
    expect(phone.service.hasMasterSecret()).toBe(true);

    // and the damage would be in the VAULT, so it only shows on the next
    // launch: sealing the new key first leaves this device holding a key the
    // account never heard of, having thrown away the one that worked
    const restarted = makeDevice(server, aliceId, {
      keyProvider: phone.keyProvider,
      vaultNamespace: phone.vaultNamespace,
    });
    await restarted.service.initialize();
    await flushQueue();
    expect(restarted.service.hasMasterSecret()).toBe(true);
    expect(restarted.service.hasMasterKeyConflict()).toBe(false);

    // it can still approve, which is what holding the account key is for
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();
    await restarted.service.approveDevice(laptop.service.deviceId);
    expect(server.deviceOf(aliceId, laptop.service.deviceId).masterSignature).toBeTruthy();
  });

  it('rescues the other devices after a §14.4 reset, instead of stranding them (T1)', async () => {
    // The documented recovery, end to end. The device that resets is one that
    // never held the key (the holder is gone), so the account really does get
    // a new identity — and the devices that pinned the OLD one have to be
    // rescuable. Checking an incoming secret against the stale pin rather than
    // against what the account now publishes would reject the very approval
    // meant to rescue them, then delete the row as unusable.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId); // holds the original key, then is lost
    const laptop = makeDevice(server, aliceId);
    const tablet = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await tablet.service.initialize();
    await flushQueue();
    const originalKey = server.userOf(aliceId).masterKey;

    // both survivors pinned the ORIGINAL account key
    await laptop.service.fetchDeviceList(aliceId, true);
    await tablet.service.fetchDeviceList(aliceId, true);
    expect(laptop.service.hasMasterSecret()).toBe(false);

    // the phone is gone for good, so the laptop starts a new identity
    await laptop.service.resetAccountIdentity();
    const newKey = server.userOf(aliceId).masterKey;
    expect(newKey).not.toBe(originalKey);
    expect(laptop.service.hasMasterSecret()).toBe(true);

    // approving the tablet — which still pins the old key — must actually work
    await laptop.service.approveDevice(tablet.service.deviceId);
    expect(await tablet.service.claimMasterTransfers()).toBe(true);
    expect(tablet.service.hasMasterSecret()).toBe(true);
    expect(server.transfers).toHaveLength(0);

    // and the rescued device agrees with the account rather than reporting a
    // conflict against the key it is itself holding
    expect(tablet.service.hasMasterKeyConflict()).toBe(false);
    const own = await tablet.service.listOwnDevices();
    expect(own.masterKey).toBe(newKey);
    expect(own.canApprove).toBe(true);
  });

  it('re-publishes the key it holds instead of burning the account identity (T2)', async () => {
    // A server that overwrites the published key must not cost every contact a
    // re-verification: this device can prove the original key by holding it,
    // so the fix is to publish it again — same safety number, nobody prompted.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const realKey = server.userOf(aliceId).masterKey;

    const imposter = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = imposter.publicKey();
    user.masterSignature = imposter.sign(e2eMasterCanonical(aliceId, imposter.publicKey()));
    for (const device of user.devices.values()) device.masterSignature = null;
    await phone.service.fetchDeviceList(aliceId, true);
    expect(phone.service.hasMasterKeyConflict()).toBe(true);

    await phone.service.resetAccountIdentity();

    expect(server.userOf(aliceId).masterKey).toBe(realKey); // unchanged identity
    expect(phone.service.hasMasterKeyConflict()).toBe(false);
    expect(server.deviceOf(aliceId, phone.service.deviceId).masterSignature).toBeTruthy();
  });

  it('forgets the cross-signature of a revoked device id (T3)', async () => {
    // Under the rollout grace the stored cross-signed set stands IN PLACE OF
    // checking a signature. A stale id left there means a device that
    // re-registers under the same id is reported signed without any signature
    // ever being verified.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();
    await phone.service.approveDevice(laptop.service.deviceId);
    const laptopId = laptop.service.deviceId;
    await phone.service.revokeDevice(laptopId);

    // the same device id comes back, unsigned
    const reborn = makeDevice(server, aliceId, {
      vaultNamespace: laptop.vaultNamespace,
      keyProvider: laptop.keyProvider,
    });
    await reborn.service.initialize();
    await flushQueue();
    expect(reborn.service.deviceId).toBe(laptopId);

    // …and the phone now only ever hears from nodes that cannot report
    // signatures, so it falls back on what it remembered
    server.setCrossSigningSupported(false);
    const restarted = makeDevice(server, aliceId, {
      vaultNamespace: phone.vaultNamespace,
      keyProvider: phone.keyProvider,
    });
    await restarted.service.initialize();
    await flushQueue();
    await restarted.service.fetchDeviceList(aliceId, true);

    const status = await restarted.service.deviceListStatus(aliceId);
    expect(status.unsignedDeviceIds).toContain(laptopId);
  });

  it('names the recipient who has not set up a device yet (A1)', async () => {
    // Under always-on this is the ONLY reason a DM cannot be sent, and it is a
    // normal state — an account that exists but has never opened the app. It
    // has to arrive as something the UI can explain, not as a generic failure
    // the user reads as the product being broken.
    uniq++;
    const server = createFakeServer();
    const alice = makeParty(server, 'alice');
    const strangerId = `stranger-${uniq}`;
    await alice.service.initialize();
    await flushQueue();

    // the account exists on the server but has registered no device
    server.userOf(strangerId);

    await expect(alice.service.encryptMessage('c1', strangerId, 'hello?')).rejects.toMatchObject({
      name: 'E2EPeerNotReadyError',
      peerUserId: strangerId,
    });
  });

  it('links a new device by the code it displays (L1)', async () => {
    // Replaces "find your new device in a list and press Approve" — the user
    // reads a code off the device in front of them, which is also what makes
    // it safe.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    const code = laptop.service.linkingCode();
    // 80 bits: 40 was grindable offline, because whoever registers a device
    // chooses its id and keys and can hunt for one that matches the code.
    expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

    const found = await phone.service.findLinkableDevice(code);
    expect(found?.deviceId).toBe(laptop.service.deviceId);

    await phone.service.approveDevice(found!.deviceId);
    expect(await laptop.service.claimMasterTransfers()).toBe(true);
    expect(laptop.service.hasMasterSecret()).toBe(true);
  });

  it('accepts the code however the user retypes it (L2)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    const code = laptop.service.linkingCode();
    for (const typed of [code, code.replace('-', ''), code.toLowerCase(), ` ${code} `]) {
      expect((await phone.service.findLinkableDevice(typed))?.deviceId).toBe(laptop.service.deviceId);
    }
  });

  it('refuses to approve if the keys behind the id changed after the lookup (L6)', async () => {
    // The typed code authenticates KEYS; everything after travels by device id.
    // Those are two separate questions to the server, and it may answer the
    // second one differently: same id, attacker keys, valid self-signature.
    // Without re-checking, the account master secret gets sealed to the
    // attacker's curve25519 and cross-signed under the account key.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    const found = await phone.service.findLinkableDevice(laptop.service.linkingCode());
    expect(found).not.toBeNull();

    // Between the user confirming and pressing approve, the server swaps the
    // keys it serves under that id.
    //
    // Note what this attacker has to do, because a weaker forge is already
    // caught: fetchDeviceList verifies each entry's self-signature over
    // e2eDeviceCanonical(userId, deviceId, curve, ed), so simply pasting in
    // foreign keys makes the entry fail verification and vanish from the list.
    // But that signature is self-referential — it is checked with the very key
    // that claims it — so an attacker signs the canonical string for SOMEONE
    // ELSE'S device id with their own key and the entry verifies fine. That is
    // the gap the linking code has to close, and nothing else does.
    const evil = new EngineAccount();
    const record = server.deviceOf(aliceId, laptop.service.deviceId);
    record.curve25519Key = evil.curve25519Key();
    record.ed25519Key = evil.ed25519Key();
    record.deviceSignature = evil.sign(
      e2eDeviceCanonical(
        aliceId,
        laptop.service.deviceId,
        evil.curve25519Key(),
        evil.ed25519Key()
      )
    );
    // The swap really is invisible to every other check: the entry still
    // verifies and is still offered for approval.
    const relisted = await phone.service.listOwnDevices();
    expect(
      relisted.devices.find((d) => d.deviceId === laptop.service.deviceId)?.curve25519Key
    ).toBe(evil.curve25519Key());

    await expect(
      phone.service.approveDevice(found!.deviceId, found!.linkingCode)
    ).rejects.toThrow(/no longer showing the code/);

    // Nothing was handed over: no master transfer queued, no signature published.
    expect(
      server.transfers.filter(
        (tr) => tr.userId === aliceId && tr.recipientDeviceId === laptop.service.deviceId
      )
    ).toHaveLength(0);
    expect(server.deviceOf(aliceId, laptop.service.deviceId).masterSignature ?? null).toBeNull();
  });

  it('still approves when the keys are the ones the code named (L7)', async () => {
    // The guard must not break the flow it protects.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    const found = await phone.service.findLinkableDevice(laptop.service.linkingCode());
    await phone.service.approveDevice(found!.deviceId, found!.linkingCode);
    expect(await laptop.service.claimMasterTransfers()).toBe(true);
  });

  it('refuses a code that matches two devices rather than picking one (L5)', async () => {
    // The server chooses the order of the device list, so "first match" would
    // let it put a device of its own ahead of the real one. A collision at 80
    // bits does not happen by accident, so seeing two is itself the signal.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    // a second unsigned device that produces the SAME code as the laptop
    const twin = makeDevice(server, aliceId);
    await twin.service.initialize();
    await flushQueue();
    const real = server.deviceOf(aliceId, laptop.service.deviceId);
    const impostor = server.deviceOf(aliceId, twin.service.deviceId);
    impostor.curve25519Key = real.curve25519Key;
    impostor.ed25519Key = real.ed25519Key;
    server.forgeDeviceKeys(aliceId, twin.service.deviceId, {
      curve25519Key: real.curve25519Key,
      ed25519Key: real.ed25519Key,
    });
    // same keys AND same id component would be the same device, so line the
    // impostor up on the code itself: reuse the laptop's id in the digest by
    // giving the fake device that id in the served list
    impostor.deviceId = laptop.service.deviceId;

    await expect(phone.service.findLinkableDevice(laptop.service.linkingCode())).rejects.toThrow(
      /matches more than one device/
    );
  });

  it('cannot be used to approve a device the server injected (L3)', async () => {
    // THE security property. The approving device recomputes the code from the
    // keys the SERVER served, so a device with keys of the server's choosing
    // produces a different code — a user typing what their real new device
    // shows can never land on the injected one.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    const realCode = laptop.service.linkingCode();
    const impostor = new EngineAccount();
    server.forgeDeviceKeys(aliceId, laptop.service.deviceId, {
      curve25519Key: impostor.curve25519Key(),
      ed25519Key: impostor.ed25519Key(),
    });

    // the code the user is reading no longer matches what the server serves
    expect(await phone.service.findLinkableDevice(realCode)).toBeNull();
  });

  it('will not link a device that is already trusted, or a wrong code (L4)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    expect(await phone.service.findLinkableDevice('AAAA-BBBB')).toBeNull();
    // this device is not something to link to itself
    expect(await phone.service.findLinkableDevice(phone.service.linkingCode())).toBeNull();

    // once approved there is nothing left to link
    const code = laptop.service.linkingCode();
    await phone.service.approveDevice(laptop.service.deviceId);
    expect(await phone.service.findLinkableDevice(code)).toBeNull();
  });

  it('carries history to a device joined by LINKING, not just by recovery (M6)', async () => {
    // Linking is the primary way a device joins an account; recovery is the
    // rare one. History arriving only on the rare path meant the common path
    // produced a device that could send but showed empty conversations.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const bob = makeParty(server, 'bob');
    await phone.service.initialize();
    await bob.service.initialize();
    await flushQueue();

    const envelope = await bob.service.encryptMessage('c1', aliceId, 'said before the laptop existed');
    await phone.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: bob.userId, content: envelope,
    });
    await phone.service.createKeyBackup();
    expect(await phone.service.backupMessageKeys()).toBeGreaterThan(0);

    // a NEW device joins by being approved — no recovery key involved
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();
    const found = await phone.service.findLinkableDevice(laptop.service.linkingCode());
    await phone.service.approveDevice(found!.deviceId);
    expect(await laptop.service.claimMasterTransfers()).toBe(true);

    expect(
      await laptop.service.decryptMessage({
        id: 'm1', conversationId: 'c1', authorId: bob.userId, content: envelope,
      })
    ).toEqual({ text: 'said before the laptop existed' });
  });

  it('carries history to a device that was never sent it (M1)', async () => {
    // The point of the phase: after the wipe there is no plaintext history to
    // fall back on, so a device that joins later either restores the session
    // keys or shows the user a blank window.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const bob = makeParty(server, 'bob');
    await phone.service.initialize();
    await bob.service.initialize();
    await flushQueue();

    // Bob writes history that only Alice's phone can read
    const envelope = await bob.service.encryptMessage('c1', aliceId, 'said before the laptop existed');
    await phone.service.decryptMessage({
      id: 'm1', conversationId: 'c1', authorId: bob.userId, content: envelope,
    });
    const recoveryKey = await phone.service.createKeyBackup();
    expect(await phone.service.backupMessageKeys()).toBeGreaterThan(0);

    // the phone is lost; a fresh install recovers the account
    const laptop = makeDevice(server, aliceId);
    await laptop.service.initialize();
    await flushQueue();
    await laptop.service.restoreKeyBackup(recoveryKey);

    // …and can read what it was never sent
    expect(
      await laptop.service.decryptMessage({
        id: 'm1', conversationId: 'c1', authorId: bob.userId, content: envelope,
      })
    ).toEqual({ text: 'said before the laptop existed' });
  });

  it('does not let a device holding less of a session overwrite one holding more (M2)', async () => {
    // A device that joined a Megolm session late exports from a later ratchet
    // index. Overwriting an earlier device's key would destroy the messages in
    // between — silently, and exactly the history this feature exists to keep.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    await phone.service.createKeyBackup();

    const api = server.apiFor(aliceId);
    const stored = () => server.messageKeys.find((k) => k.sessionId === 'sess-1')!;
    server.messageKeys.push({
      userId: aliceId,
      conversationId: 'c1',
      sessionId: 'sess-1',
      blob: 'covers-from-10',
      firstKnownIndex: 10,
    });

    // a device holding LESS of the session must not replace it
    await api.post('/e2e/message-keys', {
      keys: [{ conversationId: 'c1', sessionId: 'sess-1', blob: 'covers-from-50', firstKnownIndex: 50 }],
    });
    expect(stored().blob).toBe('covers-from-10');

    // an equal index changes nothing either — there is nothing to gain
    await api.post('/e2e/message-keys', {
      keys: [{ conversationId: 'c1', sessionId: 'sess-1', blob: 'also-from-10', firstKnownIndex: 10 }],
    });
    expect(stored().blob).toBe('covers-from-10');

    // …but a device holding MORE of it replaces it
    await api.post('/e2e/message-keys', {
      keys: [{ conversationId: 'c1', sessionId: 'sess-1', blob: 'covers-from-0', firstKnownIndex: 0 }],
    });
    expect(stored().blob).toBe('covers-from-0');
  });

  it('will not seal history without the account key (M3)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    // the laptop is unapproved: it holds no account key, so it can neither
    // seal history nor read what is stored
    expect(laptop.service.hasMasterSecret()).toBe(false);
    expect(await laptop.service.backupMessageKeys()).toBe(0);
    await expect(laptop.service.restoreMessageKeys()).rejects.toThrow(/does not hold the account key/);
  });

  it('drops history keys a new identity can never read again (M4)', async () => {
    // The subkey is derived from the master key, so a reset leaves every row
    // undecryptable. Keeping them would bill storage for rows nothing can read.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();
    server.messageKeys.push({
      userId: aliceId, conversationId: 'c1', sessionId: 's1', blob: 'x', firstKnownIndex: 0,
    });

    // the laptop holds no key, so resetting really mints a new identity
    await laptop.service.resetAccountIdentity();
    expect(server.messageKeys.filter((k) => k.userId === aliceId)).toHaveLength(0);
  });

  it('pages through every stored key rather than reading the first page (M5)', async () => {
    // An account accumulates thousands of sessions; stopping at page one would
    // restore a slice of someone's history and look like it worked.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const bob = makeParty(server, 'bob');
    await phone.service.initialize();
    await bob.service.initialize();
    await flushQueue();

    const envelopes: string[] = [];
    for (let i = 0; i < 5; i++) {
      // a fresh session per message: revoking forces the sender to rotate
      const envelope = await bob.service.encryptMessage(`conv-${i}`, aliceId, `history ${i}`);
      await phone.service.decryptMessage({
        id: `m${i}`, conversationId: `conv-${i}`, authorId: bob.userId, content: envelope,
      });
      envelopes.push(envelope);
    }
    await phone.service.createKeyBackup();
    await phone.service.backupMessageKeys();
    expect(server.messageKeys.length).toBeGreaterThan(2); // more than one page

    const restored = makeDevice(server, aliceId);
    await restored.service.initialize();
    await flushQueue();
    // give it the account key without going through the backup blob
    await restored.service.restoreKeyBackup(await phone.service.createKeyBackup());

    for (let i = 0; i < envelopes.length; i++) {
      expect(
        await restored.service.decryptMessage({
          id: `m${i}`, conversationId: `conv-${i}`, authorId: bob.userId, content: envelopes[i],
        })
      ).toEqual({ text: `history ${i}` });
    }
  });

  it('recovers the account key from backup instead of starting a new identity (B1)', async () => {
    // The point of the whole feature: losing every device used to mean every
    // contact seeing a changed safety number and having to verify again.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const bob = makeParty(server, 'bob');
    await phone.service.initialize();
    await bob.service.initialize();
    await flushQueue();
    const accountKey = server.userOf(aliceId).masterKey;

    const recoveryKey = await phone.service.createKeyBackup();
    expect(recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    expect(server.backups.get(aliceId)).toBeTruthy();
    // the server holds the blob and nothing it can read
    expect(server.backups.get(aliceId)!.blob).not.toContain(accountKey!);

    // every device is gone; the user reinstalls
    const reinstall = makeDevice(server, aliceId);
    await reinstall.service.initialize();
    await flushQueue();
    expect(reinstall.service.hasMasterSecret()).toBe(false);

    await reinstall.service.restoreKeyBackup(recoveryKey);

    // same account identity — nobody has to re-verify anything
    expect(server.userOf(aliceId).masterKey).toBe(accountKey);
    expect(reinstall.service.hasMasterSecret()).toBe(true);
    expect(reinstall.service.hasMasterKeyConflict()).toBe(false);
    // …and the recovered device is signed by the account key, so peers see no
    // unsigned-device warning either
    const own = await reinstall.service.listOwnDevices();
    expect(own.devices.find((d) => d.deviceId === reinstall.service.deviceId)?.crossSigned).toBe(true);
    expect(own.canApprove).toBe(true);
  });

  it('refuses a blob the server swapped for one of its own (B2)', async () => {
    // The server hands back the blob. If restore trusted whatever decrypted,
    // a server could mint a key, back it up under a recovery key it knows, and
    // wait for the user to "recover" into an identity it controls.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    await phone.service.createKeyBackup();

    const impostor = new EngineMasterKey();
    const impostorRecovery = generateRecoveryKey();
    server.backups.set(aliceId, {
      blob: impostor.sealForBackup(impostorRecovery),
      updatedAt: new Date().toISOString(),
    });

    const reinstall = makeDevice(server, aliceId);
    await reinstall.service.initialize();
    await flushQueue();
    await expect(reinstall.service.restoreKeyBackup(impostorRecovery)).rejects.toThrow(
      /different account key/
    );
    expect(reinstall.service.hasMasterSecret()).toBe(false);
  });

  it('rejects a mistyped recovery key without asking the server for anything (B3)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    await phone.service.createKeyBackup();

    await expect(phone.service.restoreKeyBackup('NOPE-NOPE-NOPE')).rejects.toThrow(
      /does not look like a recovery key/
    );
  });

  it('will not back up a key this device does not hold (B4)', async () => {
    // Otherwise a device that was never approved could publish a backup blob
    // for a key it cannot produce — at best useless, at worst confusing the
    // real recovery path.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    expect(laptop.service.hasMasterSecret()).toBe(false);
    await expect(laptop.service.createKeyBackup()).rejects.toThrow(/does not hold the account key/);
    expect(server.backups.has(aliceId)).toBe(false);
  });

  it('will not back up a key the account does not publish (B8)', async () => {
    // Holding a key is not the same as the account publishing it. A bootstrap
    // that minted one and then failed to publish would otherwise have the user
    // write down a recovery key for an identity that never existed — and only
    // find out at the moment they needed it.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();

    // the server publishes someone else's key
    const impostor = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = impostor.publicKey();
    user.masterSignature = impostor.sign(e2eMasterCanonical(aliceId, impostor.publicKey()));

    await expect(phone.service.createKeyBackup()).rejects.toThrow(/publishes a different key/);
    expect(server.backups.has(aliceId)).toBe(false);
  });

  it('drops a backup that a new identity has made useless (B5)', async () => {
    // After a reset the old blob decrypts to a key the account no longer
    // publishes, so keeping it would leave the user holding a recovery key
    // that looks like a way back and is not.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();
    const stale = await phone.service.createKeyBackup();
    expect(server.backups.has(aliceId)).toBe(true);

    // the laptop holds no key, so resetting really does mint a new identity
    await laptop.service.resetAccountIdentity();
    expect(server.backups.has(aliceId)).toBe(false);

    const reinstall = makeDevice(server, aliceId);
    await reinstall.service.initialize();
    await flushQueue();
    await expect(reinstall.service.restoreKeyBackup(stale)).rejects.toThrow(/no key backup/);
  });

  it('keeps a backup that is still valid when the held key is merely re-published (B6)', async () => {
    // Re-publishing does not change the account key, so the backup still opens
    // it. Deleting it there would destroy a working recovery for no reason.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();
    const recoveryKey = await phone.service.createKeyBackup();

    const impostor = new EngineMasterKey();
    const user = server.userOf(aliceId);
    user.masterKey = impostor.publicKey();
    user.masterSignature = impostor.sign(e2eMasterCanonical(aliceId, impostor.publicKey()));
    await phone.service.fetchDeviceList(aliceId, true);
    await phone.service.resetAccountIdentity(); // re-publishes the held key

    expect(server.backups.has(aliceId)).toBe(true);
    const reinstall = makeDevice(server, aliceId);
    await reinstall.service.initialize();
    await flushQueue();
    await reinstall.service.restoreKeyBackup(recoveryKey);
    expect(reinstall.service.hasMasterSecret()).toBe(true);
  });

  it('replaces the blob when a new recovery key is minted (B7)', async () => {
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    await phone.service.initialize();
    await flushQueue();

    const first = await phone.service.createKeyBackup();
    const second = await phone.service.createKeyBackup();
    expect(first).not.toBe(second);
    expect((await phone.service.keyBackupInfo()).exists).toBe(true);

    const reinstall = makeDevice(server, aliceId);
    await reinstall.service.initialize();
    await flushQueue();
    // the superseded key no longer opens what is stored
    await expect(reinstall.service.restoreKeyBackup(first)).rejects.toThrow(/does not open this backup/);
    await reinstall.service.restoreKeyBackup(second);
    expect(reinstall.service.hasMasterSecret()).toBe(true);
  });

  it('hands over the secret before publishing the signature (P11)', async () => {
    // Order is load-bearing: a device that is cross-signed but never received
    // the key looks fully trusted to every peer while being unable to approve
    // anything, and the approve button is gone because approval is only
    // offered for unsigned devices.
    uniq++;
    const server = createFakeServer();
    const aliceId = `alice-${uniq}`;
    const phone = makeDevice(server, aliceId);
    const laptop = makeDevice(server, aliceId);
    await phone.service.initialize();
    await laptop.service.initialize();
    await flushQueue();

    server.setSignaturePublishFailure(true);
    await expect(phone.service.approveDevice(laptop.service.deviceId)).rejects.toThrow();

    // the signature did not land…
    expect(server.deviceOf(aliceId, laptop.service.deviceId).masterSignature).toBeNull();
    // …but the secret is already waiting, so retrying is all it takes
    expect(server.transfers).toHaveLength(1);

    server.setSignaturePublishFailure(false);
    await phone.service.approveDevice(laptop.service.deviceId);
    expect(server.deviceOf(aliceId, laptop.service.deviceId).masterSignature).toBeTruthy();
    expect(await laptop.service.claimMasterTransfers()).toBe(true);
  });
});
