// @vitest-environment node
// Engine smoke tests run in the node environment: no DOM dependency, and
// node's WebAssembly/crypto match the browser/webview runtime semantics.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import init, {
  EngineAccount,
  EngineSession,
  EngineGroupSession,
  EngineInboundGroupSession,
  engine_version,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
  encryptAttachment,
  decryptAttachment,
} from '@voxium/crypto-engine';

const require = createRequire(import.meta.url);

beforeAll(async () => {
  const wasmPath = require.resolve('@voxium/crypto-engine/wasm');
  await init({ module_or_path: readFileSync(wasmPath) });
});

interface OneTimeKey {
  keyId: string;
  key: string;
}

/** Simulates the server side of key distribution for a device. */
function publishBundle(account: EngineAccount, otkCount = 5) {
  const oneTimeKeys = account.generateOneTimeKeys(otkCount) as OneTimeKey[];
  account.markKeysAsPublished();
  return {
    curve25519: account.curve25519Key(),
    ed25519: account.ed25519Key(),
    oneTimeKeys,
  };
}

function establish(alice: EngineAccount, bob: EngineAccount, firstMessage = 'hello bob') {
  const bobBundle = publishBundle(bob);
  const aliceSession = alice.createOutboundSession(bobBundle.curve25519, bobBundle.oneTimeKeys[0].key);
  const prekeyMsg = aliceSession.encrypt(firstMessage) as { messageType: number; body: string };
  expect(prekeyMsg.messageType).toBe(0); // pre-key message
  const inbound = bob.createInboundSession(alice.curve25519Key(), prekeyMsg.body);
  expect(inbound.plaintext).toBe(firstMessage);
  const bobSession = inbound.takeSession();
  return { aliceSession, bobSession };
}

describe('crypto engine (vodozemac olm1)', () => {
  it('reports its pinned version', () => {
    expect(engine_version()).toBe('olm1/vodozemac-0.10.0');
  });

  it('completes a full two-party ratchet conversation', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const { aliceSession, bobSession } = establish(alice, bob);

    // Bob replies; once Alice receives it her messages switch to Normal type
    const reply = bobSession.encrypt('hi alice — ratchet ✓🔐') as { messageType: number; body: string };
    expect(reply.messageType).toBe(1);
    expect(aliceSession.decrypt(reply.messageType, reply.body)).toBe('hi alice — ratchet ✓🔐');

    for (let i = 0; i < 5; i++) {
      const a = aliceSession.encrypt(`a${i}`) as { messageType: number; body: string };
      expect(a.messageType).toBe(1);
      expect(bobSession.decrypt(a.messageType, a.body)).toBe(`a${i}`);
      const b = bobSession.encrypt(`b${i}`) as { messageType: number; body: string };
      expect(aliceSession.decrypt(b.messageType, b.body)).toBe(`b${i}`);
    }
  });

  it('handles out-of-order delivery within a chain', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const { aliceSession, bobSession } = establish(alice, bob);

    const m1 = aliceSession.encrypt('m1') as { messageType: number; body: string };
    const m2 = aliceSession.encrypt('m2') as { messageType: number; body: string };
    const m3 = aliceSession.encrypt('m3') as { messageType: number; body: string };
    expect(bobSession.decrypt(m3.messageType, m3.body)).toBe('m3');
    expect(bobSession.decrypt(m1.messageType, m1.body)).toBe('m1');
    expect(bobSession.decrypt(m2.messageType, m2.body)).toBe('m2');
  });

  it('rejects replayed ciphertext (message keys are one-shot)', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const { aliceSession, bobSession } = establish(alice, bob);

    const msg = aliceSession.encrypt('secret') as { messageType: number; body: string };
    expect(bobSession.decrypt(msg.messageType, msg.body)).toBe('secret');
    expect(() => bobSession.decrypt(msg.messageType, msg.body)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const { aliceSession, bobSession } = establish(alice, bob);
    const msg = aliceSession.encrypt('integrity') as { messageType: number; body: string };
    const bytes = Buffer.from(msg.body, 'base64');
    bytes[bytes.length - 5] ^= 0xff;
    const tampered = bytes.toString('base64').replace(/=+$/, '');
    expect(() => bobSession.decrypt(msg.messageType, tampered)).toThrow();
  });

  it('refuses an inbound session when the claimed identity key does not match (authenticated key distribution)', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const mallory = new EngineAccount();

    const bobBundle = publishBundle(bob);
    const aliceSession = alice.createOutboundSession(bobBundle.curve25519, bobBundle.oneTimeKeys[0].key);
    const prekeyMsg = aliceSession.encrypt('hello') as { messageType: number; body: string };

    // Bob expects the message to come from Mallory's pinned identity → must fail
    expect(() => bob.createInboundSession(mallory.curve25519Key(), prekeyMsg.body)).toThrow();
    // With the correct pinned identity it succeeds
    expect(bob.createInboundSession(alice.curve25519Key(), prekeyMsg.body).plaintext).toBe('hello');
  });

  it('signs and verifies key uploads with Ed25519 (strict verification)', () => {
    const account = new EngineAccount();
    const payload = `voxium-e2e-v1|otk|${account.curve25519Key()}`;
    const signature = account.sign(payload);
    expect(() => verify_ed25519(account.ed25519Key(), payload, signature)).not.toThrow();
    expect(() => verify_ed25519(account.ed25519Key(), payload + 'x', signature)).toThrow();
    const other = new EngineAccount();
    expect(() => verify_ed25519(other.ed25519Key(), payload, signature)).toThrow();
  });

  it('pickles and restores accounts and sessions with a 32-byte key', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const { aliceSession, bobSession } = establish(alice, bob);
    const pickleKey = new Uint8Array(32).fill(7);

    const restoredAlice = EngineAccount.fromPickle(alice.pickle(pickleKey), pickleKey);
    expect(restoredAlice.curve25519Key()).toBe(alice.curve25519Key());
    expect(restoredAlice.ed25519Key()).toBe(alice.ed25519Key());

    const restoredAliceSession = EngineSession.fromPickle(aliceSession.pickle(pickleKey), pickleKey);
    expect(restoredAliceSession.sessionId()).toBe(aliceSession.sessionId());

    // restored session still interoperates
    const msg = restoredAliceSession.encrypt('after restore') as { messageType: number; body: string };
    expect(bobSession.decrypt(msg.messageType, msg.body)).toBe('after restore');

    // wrong pickle key must fail
    const wrongKey = new Uint8Array(32).fill(8);
    expect(() => EngineAccount.fromPickle(alice.pickle(pickleKey), wrongKey)).toThrow();
    expect(() => EngineAccount.fromPickle(alice.pickle(pickleKey), new Uint8Array(16))).toThrow();
  });

  it('extracts the session id from a pre-key message for session matching', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const bobBundle = publishBundle(bob);
    const aliceSession = alice.createOutboundSession(bobBundle.curve25519, bobBundle.oneTimeKeys[0].key);
    const prekeyMsg = aliceSession.encrypt('hello') as { messageType: number; body: string };
    expect(prekey_message_session_id(prekeyMsg.body)).toBe(aliceSession.sessionId());
  });

  it('supports fallback keys when one-time keys are exhausted', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    bob.generateFallbackKey();
    const fallback = bob.fallbackKey() as OneTimeKey | null;
    expect(fallback).toBeTruthy();
    bob.markKeysAsPublished();

    const aliceSession = alice.createOutboundSession(bob.curve25519Key(), fallback!.key);
    const msg = aliceSession.encrypt('via fallback') as { messageType: number; body: string };
    const inbound = bob.createInboundSession(alice.curve25519Key(), msg.body);
    expect(inbound.plaintext).toBe('via fallback');
  });

  it('encrypts and decrypts attachment bytes (AES-256-GCM round-trip)', () => {
    const original = new Uint8Array(64 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;

    const encrypted = encryptAttachment(original);
    const key = encrypted.key;
    const iv = encrypted.iv;
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}$/); // 32 bytes
    expect(iv).toMatch(/^[A-Za-z0-9+/]{16}$/); // 12 bytes
    const ciphertext = encrypted.takeCiphertext();
    expect(ciphertext.length).toBe(original.length + 16); // GCM tag
    // ciphertext must not contain the plaintext
    expect(Buffer.from(ciphertext.slice(0, 64)).equals(Buffer.from(original.slice(0, 64)))).toBe(false);

    const decrypted = decryptAttachment(ciphertext, key, iv);
    expect(Buffer.from(decrypted).equals(Buffer.from(original))).toBe(true);
  });

  it('rejects tampered attachment ciphertext and wrong keys (GCM authentication)', () => {
    const encrypted = encryptAttachment(new Uint8Array([1, 2, 3, 4, 5]));
    const key = encrypted.key;
    const iv = encrypted.iv;
    const ciphertext = encrypted.takeCiphertext();

    const tampered = new Uint8Array(ciphertext);
    tampered[2] ^= 0xff;
    expect(() => decryptAttachment(tampered, key, iv)).toThrow();

    const otherKey = encryptAttachment(new Uint8Array([9])).key;
    expect(() => decryptAttachment(ciphertext, otherKey, iv)).toThrow();
    expect(() => decryptAttachment(ciphertext, 'short', iv)).toThrow();
  });

  it('computes matching 60-digit safety numbers on both sides', () => {
    const alice = new EngineAccount();
    const bob = new EngineAccount();
    const fromAlice = safety_number(
      'user-alice', alice.ed25519Key(), alice.curve25519Key(),
      'user-bob', bob.ed25519Key(), bob.curve25519Key()
    );
    const fromBob = safety_number(
      'user-bob', bob.ed25519Key(), bob.curve25519Key(),
      'user-alice', alice.ed25519Key(), alice.curve25519Key()
    );
    expect(fromAlice).toBe(fromBob);
    expect(fromAlice).toMatch(/^\d{60}$/);

    // identity change → different safety number
    const evil = new EngineAccount();
    const changed = safety_number(
      'user-alice', evil.ed25519Key(), evil.curve25519Key(),
      'user-bob', bob.ed25519Key(), bob.curve25519Key()
    );
    expect(changed).not.toBe(fromAlice);
  });
});

describe('crypto engine (vodozemac megolm1 group sessions)', () => {
  it('round-trips outbound encrypt → inbound decrypt with message indexes', () => {
    const outbound = new EngineGroupSession();
    expect(outbound.messageIndex()).toBe(0);
    expect(outbound.sessionId()).toMatch(/^[A-Za-z0-9+/]+$/);

    // Session key exported at index 0 → importer sees the whole history
    const inbound = EngineInboundGroupSession.fromSessionKey(outbound.sessionKey());
    expect(inbound.sessionId()).toBe(outbound.sessionId());
    expect(inbound.firstKnownIndex()).toBe(0);

    for (let i = 0; i < 5; i++) {
      expect(outbound.messageIndex()).toBe(i);
      const ciphertext = outbound.encrypt(`group message ${i} ✓🔐`);
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext).not.toContain('group message');
      const result = inbound.decrypt(ciphertext);
      expect(result.plaintext).toBe(`group message ${i} ✓🔐`);
      expect(result.messageIndex).toBe(i);
    }
    expect(outbound.messageIndex()).toBe(5);
  });

  it('decrypts out of order and re-decrypts the same ciphertext (megolm keys are not one-shot)', () => {
    const outbound = new EngineGroupSession();
    const inbound = EngineInboundGroupSession.fromSessionKey(outbound.sessionKey());

    const m0 = outbound.encrypt('m0');
    const m1 = outbound.encrypt('m1');
    const m2 = outbound.encrypt('m2');

    expect(inbound.decrypt(m2).plaintext).toBe('m2');
    expect(inbound.decrypt(m0).plaintext).toBe('m0');
    expect(inbound.decrypt(m1).plaintext).toBe('m1');
    // Unlike Olm, replaying a megolm message decrypts again — history re-reads
    // must work for every device that holds the session.
    expect(inbound.decrypt(m0).plaintext).toBe('m0');
  });

  it('lets a second importer decrypt the same ciphertext (multi-device fanout)', () => {
    const outbound = new EngineGroupSession();
    const sessionKey = outbound.sessionKey();
    const deviceA = EngineInboundGroupSession.fromSessionKey(sessionKey);
    const deviceB = EngineInboundGroupSession.fromSessionKey(sessionKey);

    const ciphertext = outbound.encrypt('shared with both devices');
    const a = deviceA.decrypt(ciphertext);
    const b = deviceB.decrypt(ciphertext);
    expect(a.plaintext).toBe('shared with both devices');
    expect(b.plaintext).toBe('shared with both devices');
    expect(a.messageIndex).toBe(b.messageIndex);
    expect(deviceB.sessionId()).toBe(outbound.sessionId());
  });

  it('cannot decrypt messages sent before a late importer received the key', () => {
    const outbound = new EngineGroupSession();
    const early = outbound.encrypt('before the share');
    const middle = outbound.encrypt('also before the share');

    // Key exported after 2 messages → first known index is 2
    const late = EngineInboundGroupSession.fromSessionKey(outbound.sessionKey());
    expect(late.firstKnownIndex()).toBe(2);
    expect(() => late.decrypt(early)).toThrow();
    expect(() => late.decrypt(middle)).toThrow();

    const after = outbound.encrypt('after the share');
    const result = late.decrypt(after);
    expect(result.plaintext).toBe('after the share');
    expect(result.messageIndex).toBe(2);
  });

  it('rejects tampered group ciphertext and garbage input', () => {
    const outbound = new EngineGroupSession();
    const inbound = EngineInboundGroupSession.fromSessionKey(outbound.sessionKey());
    const ciphertext = outbound.encrypt('integrity matters');

    const bytes = Buffer.from(ciphertext, 'base64');
    bytes[bytes.length - 5] ^= 0xff;
    const tampered = bytes.toString('base64').replace(/=+$/, '');
    expect(() => inbound.decrypt(tampered)).toThrow();

    expect(() => inbound.decrypt('not base64 !!!')).toThrow();
    expect(() => EngineInboundGroupSession.fromSessionKey('nonsense')).toThrow();

    // A different session's ciphertext must not verify against this session
    const other = new EngineGroupSession();
    expect(() => inbound.decrypt(other.encrypt('foreign'))).toThrow();

    // untouched ciphertext still decrypts
    expect(inbound.decrypt(ciphertext).plaintext).toBe('integrity matters');
  });

  it('pickles and restores both group session halves with a 32-byte key', () => {
    const pickleKey = new Uint8Array(32).fill(11);
    const wrongKey = new Uint8Array(32).fill(12);

    const outbound = new EngineGroupSession();
    const inbound = EngineInboundGroupSession.fromSessionKey(outbound.sessionKey());
    const first = outbound.encrypt('before pickle');
    expect(inbound.decrypt(first).plaintext).toBe('before pickle');

    const restoredOutbound = EngineGroupSession.fromPickle(outbound.pickle(pickleKey), pickleKey);
    expect(restoredOutbound.sessionId()).toBe(outbound.sessionId());
    expect(restoredOutbound.messageIndex()).toBe(outbound.messageIndex());

    const restoredInbound = EngineInboundGroupSession.fromPickle(
      inbound.pickle(pickleKey),
      pickleKey
    );
    expect(restoredInbound.sessionId()).toBe(inbound.sessionId());
    expect(restoredInbound.firstKnownIndex()).toBe(inbound.firstKnownIndex());

    // The restored halves keep interoperating across the pickle boundary
    const next = restoredOutbound.encrypt('after pickle');
    const result = restoredInbound.decrypt(next);
    expect(result.plaintext).toBe('after pickle');
    expect(result.messageIndex).toBe(1);
    // ...and the restored inbound session still reads pre-pickle history
    expect(restoredInbound.decrypt(first).plaintext).toBe('before pickle');

    expect(() => EngineGroupSession.fromPickle(outbound.pickle(pickleKey), wrongKey)).toThrow();
    expect(() =>
      EngineInboundGroupSession.fromPickle(inbound.pickle(pickleKey), wrongKey)
    ).toThrow();
    expect(() => outbound.pickle(new Uint8Array(16))).toThrow();
    expect(() => inbound.pickle(new Uint8Array(16))).toThrow();
  });
});
