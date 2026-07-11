// @vitest-environment node
// Engine smoke tests run in the node environment: no DOM dependency, and
// node's WebAssembly/crypto match the browser/webview runtime semantics.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import init, {
  EngineAccount,
  EngineSession,
  engine_version,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
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
