// @vitest-environment node
// Cross-version compatibility of the vendored engine, pinned on disk.
//
// Every value in fixtures/vodozemac-0.10.0.json was written by the engine
// built from vodozemac 0.10.0 (the version 2.0.0 shipped). A vodozemac bump
// that changed the Olm/Megolm wire format, the pickle format, the sealed
// formats or a deterministic derivation would make 2.0 and 2.1 clients unable
// to talk, or existing vaults unable to open — and every other engine test
// would stay green, because they round-trip within ONE version. This file is
// the artefact the next bump has to keep passing.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import init, {
  EngineAccount,
  EngineSession,
  EngineGroupSession,
  EngineInboundGroupSession,
  EngineMasterKey,
  engine_version,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
  master_safety_number,
  linkingCode,
  openSecret,
  openMasterKeyBackup,
  decryptAttachment,
} from '@voxium/crypto-engine';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/vodozemac-0.10.0.json', import.meta.url), 'utf8'));
const pickleKey = new Uint8Array(Buffer.from(fixture.pickleKey, 'base64'));

beforeAll(async () => {
  const wasmPath = require.resolve('@voxium/crypto-engine/wasm');
  await init({ module_or_path: readFileSync(wasmPath) });
});

describe('what vodozemac 0.10.0 wrote, the current engine opens', () => {
  it('is a different engine build than the one that wrote the fixture', () => {
    expect(fixture.engine).toBe('olm1/vodozemac-0.10.0');
    expect(engine_version()).not.toBe(fixture.engine);
  });

  it('Olm: an account pickle opens and takes the pre-key message that was sent to it', () => {
    const { olm } = fixture;
    const bob = EngineAccount.fromPickle(olm.accountPickle, pickleKey);
    const inbound = bob.createInboundSession(olm.aliceCurve25519, olm.prekey.body);
    expect(inbound.plaintext).toBe(olm.prekey.plaintext);
    expect(prekey_message_session_id(olm.prekey.body)).toBe(olm.prekeySessionId);
    // and the session keeps ratcheting: a reply from here is a normal message
    const session = inbound.takeSession();
    const out = session.encrypt('from the current engine') as { messageType: number; body: string };
    expect(out.messageType).toBe(1);
  });

  it('Olm: a session pickle opens and decrypts the reply that was waiting for it', () => {
    const { olm } = fixture;
    const alice = EngineSession.fromPickle(olm.sessionPickle, pickleKey);
    expect(alice.decrypt(olm.reply.messageType, olm.reply.body)).toBe(olm.reply.plaintext);
  });

  it('Ed25519: a signature made by 0.10.0 verifies', () => {
    const { olm } = fixture;
    expect(() => verify_ed25519(olm.aliceEd25519, olm.signed.message, olm.signed.signature)).not.toThrow();
    expect(() => verify_ed25519(olm.aliceEd25519, olm.signed.message + '!', olm.signed.signature)).toThrow();
  });

  it('Megolm: the session key, the exported key and both pickles decrypt the old ciphertexts', () => {
    const { megolm } = fixture;
    const [m1, m2] = megolm.messages;
    const fromKey = EngineInboundGroupSession.fromSessionKey(megolm.sessionKey);
    expect(fromKey.sessionId()).toBe(megolm.sessionId);
    const r2 = fromKey.decrypt(m2.ciphertext);
    expect(r2.plaintext).toBe(m2.plaintext);
    expect(r2.messageIndex).toBe(m2.index);
    expect(EngineInboundGroupSession.fromPickle(megolm.inboundPickle, pickleKey).decrypt(m1.ciphertext).plaintext).toBe(m1.plaintext);
    expect(EngineInboundGroupSession.fromExportedSessionKey(megolm.exportedKey).decrypt(m2.ciphertext).plaintext).toBe(m2.plaintext);
    // the outbound session reopens where it stopped and keeps encrypting for the same receivers
    const outbound = EngineGroupSession.fromPickle(megolm.outboundPickle, pickleKey);
    expect(outbound.sessionId()).toBe(megolm.sessionId);
    expect(outbound.messageIndex()).toBe(megolm.outboundIndex);
    const r3 = fromKey.decrypt(outbound.encrypt('third, from the current engine'));
    expect(r3.plaintext).toBe('third, from the current engine');
    expect(r3.messageIndex).toBe(megolm.outboundIndex);
  });

  it('master key: the sealed key, a sealed session key and the recovery backup open', () => {
    const { master, megolm } = fixture;
    const reopened = EngineMasterKey.fromSealed(master.sealed, pickleKey);
    expect(reopened.publicKey()).toBe(master.publicKey);
    expect(reopened.openSessionKey(master.sealedSessionKey.sealed, master.sealedSessionKey.context)).toBe(megolm.sessionKey);
    expect(openMasterKeyBackup(master.backup, master.recoveryKey, master.publicKey).publicKey()).toBe(master.publicKey);
  });

  it('sealed secrets and attachment ciphertexts open', () => {
    const { secret, attachment } = fixture;
    expect(openSecret(secret.sealed, secret.context, pickleKey)).toBe(secret.plaintext);
    const bytes = decryptAttachment(new Uint8Array(Buffer.from(attachment.ciphertext, 'base64')), attachment.key, attachment.iv);
    expect(new TextDecoder().decode(bytes)).toBe(attachment.plaintext);
  });

  it('the deterministic derivations agree: safety numbers and linking codes', () => {
    const { derived, olm, master } = fixture;
    expect(safety_number('alice', olm.aliceEd25519, olm.aliceCurve25519, 'bob', derived.bobEd25519, derived.bobCurve25519)).toBe(derived.safetyNumber);
    expect(linkingCode('u1', 'd1', olm.aliceCurve25519, olm.aliceEd25519)).toBe(derived.linkingCode);
    expect(master_safety_number('a', master.publicKey, 'b', derived.master2PublicKey)).toBe(derived.masterSafetyNumber);
  });
});
