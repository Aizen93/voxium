import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  initEngine,
  EngineMasterKey,
  generateRecoveryKey,
  isRecoveryKeyWellFormed,
  openMasterKeyBackup,
  sealSecret,
  openSecret,
} from '../../services/e2e/engine';

// The recovery key IS the security of key backup: the server holds the blob,
// so anything that weakens the key or lets the blob be opened without it hands
// the account's identity to whoever holds the database.

const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve('@voxium/crypto-engine/wasm'));

beforeAll(async () => {
  await initEngine(wasmBytes);
});

describe('recovery keys', () => {
  it('mints keys that are unique, transcribable and self-checking', () => {
    const a = generateRecoveryKey();
    const b = generateRecoveryKey();
    expect(a).not.toBe(b);
    // 32 secret bytes + 1 checksum byte in base32, grouped in fours
    expect(a).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    expect(isRecoveryKeyWellFormed(a)).toBe(true);
  });

  it('accepts a key however the user retypes it', () => {
    const key = generateRecoveryKey();
    const bare = key.replace(/-/g, '');
    expect(isRecoveryKeyWellFormed(bare)).toBe(true);
    expect(isRecoveryKeyWellFormed(bare.toLowerCase())).toBe(true);
    expect(isRecoveryKeyWellFormed(`  ${key.replace(/-/g, ' ')}  `)).toBe(true);
    // the characters the alphabet leaves out are the ones people substitute
    expect(isRecoveryKeyWellFormed(bare.replace(/O/g, '0').replace(/I/g, '1').replace(/B/g, '8'))).toBe(
      true
    );
  });

  it('rejects a mistyped key before anything else happens', () => {
    // Without the checksum the first sign of a typo would be "decryption
    // failed" after a network round trip, which reads like data loss.
    const key = generateRecoveryKey();
    const bare = key.replace(/-/g, '');
    const swapped = bare[0] === 'A' ? `C${bare.slice(1)}` : `A${bare.slice(1)}`;
    expect(isRecoveryKeyWellFormed(swapped)).toBe(false);
    expect(isRecoveryKeyWellFormed(bare.slice(0, -1))).toBe(false);
    expect(isRecoveryKeyWellFormed('')).toBe(false);
    expect(isRecoveryKeyWellFormed('not a recovery key')).toBe(false);
  });

  it('treats a recovery key as having exactly one spelling', () => {
    // Ignoring trailing characters would let several different strings stand
    // for the same key — so a key with something appended would still verify,
    // which is exactly the typo the checksum exists to catch.
    const key = generateRecoveryKey();
    const bare = key.replace(/-/g, '');
    expect(isRecoveryKeyWellFormed(bare)).toBe(true);
    expect(isRecoveryKeyWellFormed(`${bare}A`)).toBe(false);
    expect(isRecoveryKeyWellFormed(`${bare}AAAAAAAA`)).toBe(false);
    expect(isRecoveryKeyWellFormed(`A${bare}`)).toBe(false);
  });

  it('rejects every single-character substitution', () => {
    // The checksum is one byte, so ~1 in 256 typos slips through by design;
    // over a whole key that still has to catch the overwhelming majority, or
    // the "check it for typos" message is not worth showing.
    const bare = generateRecoveryKey().replace(/-/g, '');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let accepted = 0;
    let tried = 0;
    for (let i = 0; i < bare.length; i++) {
      for (const c of alphabet) {
        if (c === bare[i]) continue;
        tried++;
        if (isRecoveryKeyWellFormed(bare.slice(0, i) + c + bare.slice(i + 1))) accepted++;
      }
    }
    expect(tried).toBeGreaterThan(1000);
    expect(accepted / tried).toBeLessThan(0.02);
  });

  it('never mints the same key twice', () => {
    // 32 bytes from the CSPRNG. A collision here would mean the generator is
    // not seeded, which on wasm means getrandom never reached WebCrypto.
    const keys = new Set(Array.from({ length: 64 }, () => generateRecoveryKey()));
    expect(keys.size).toBe(64);
  });
});

describe('master key backup', () => {
  it('round-trips the account key through a blob only the recovery key opens', () => {
    const master = new EngineMasterKey();
    const recovery = generateRecoveryKey();
    const blob = master.sealForBackup(recovery);

    // the blob is opaque: no key material shows through
    expect(blob).not.toContain(master.publicKey());
    expect(blob).toMatch(/^[A-Za-z0-9+/]+$/);

    const restored = openMasterKeyBackup(blob, recovery, master.publicKey());
    expect(restored.publicKey()).toBe(master.publicKey());
  });

  it('is useless to anyone holding the blob but not the key', () => {
    const master = new EngineMasterKey();
    const blob = master.sealForBackup(generateRecoveryKey());
    expect(() => openMasterKeyBackup(blob, generateRecoveryKey(), master.publicKey())).toThrow(
      /does not open this backup/
    );
  });

  it('refuses a blob that decrypts to a key the account does not publish', () => {
    // The server hands back the blob. If it could substitute one of its own
    // making, "recovery" would install a key it holds — so the recovered
    // secret has to match the published account key or nothing is stored.
    const real = new EngineMasterKey();
    const impostor = new EngineMasterKey();
    const recovery = generateRecoveryKey();
    const impostorBlob = impostor.sealForBackup(recovery);

    expect(() => openMasterKeyBackup(impostorBlob, recovery, real.publicKey())).toThrow(
      /different account key/
    );
  });

  it('detects a tampered blob rather than returning half of one', () => {
    const master = new EngineMasterKey();
    const recovery = generateRecoveryKey();
    const blob = master.sealForBackup(recovery);
    const flipped = `${blob.slice(0, -4)}AAAA`;
    expect(() => openMasterKeyBackup(flipped, recovery, master.publicKey())).toThrow();
  });

  it('keeps the backup context out of the generic sealer', () => {
    // The blob and the typed recovery key both pass through JS. If the generic
    // opener accepted this context, one call would return the account's
    // private half as a plain string — the invariant §7 rests on.
    const master = new EngineMasterKey();
    const recovery = generateRecoveryKey();
    const blob = master.sealForBackup(recovery);
    const key = new Uint8Array(32).fill(7);

    expect(() => sealSecret('anything', 'voxium-backup/master_secret', key)).toThrow(
      /reserved for the engine/
    );
    expect(() => openSecret(blob, 'voxium-backup/master_secret', key)).toThrow(
      /reserved for the engine/
    );
  });

  it('seals a session key so exactly the account that owns it can read it back', () => {
    // History backup rides on the master key rather than a second secret, so
    // every device that can read new messages can read old ones, and the
    // recovery key already restores both.
    const master = new EngineMasterKey();
    const other = new EngineMasterKey();
    const sessionKey = 'AgAAAAAwMTIzNDU2Nzg5QUJERUYwMTIzNDU2Nzg5QUJDREVG';
    const context = 'conv-1|sess-1';

    const blob = master.sealSessionKey(sessionKey, context);
    expect(blob).not.toContain(sessionKey);
    expect(master.openSessionKey(blob, context)).toBe(sessionKey);

    // another account's key is useless against it
    expect(() => other.openSessionKey(blob, context)).toThrow(/does not belong to this account/);
  });

  it('will not let a backed-up key be restored into a different conversation', () => {
    // The AAD binds the blob to the conversation and session it came from. A
    // server that shuffled rows between conversations would otherwise have a
    // client decrypt one conversation's history under another's identity.
    const master = new EngineMasterKey();
    const sessionKey = 'AgAAAAAwMTIzNDU2Nzg5QUJERUYwMTIzNDU2Nzg5QUJDREVG';
    const blob = master.sealSessionKey(sessionKey, 'conv-1|sess-1');

    expect(() => master.openSessionKey(blob, 'conv-2|sess-1')).toThrow(/does not belong/);
    expect(() => master.openSessionKey(blob, 'conv-1|sess-2')).toThrow(/does not belong/);
  });

  it('derives the same backup subkey on every device holding the account key', () => {
    // Two devices of one account must agree, or a session backed up by one is
    // unreadable by the other — which is the whole feature.
    const master = new EngineMasterKey();
    const sealed = master.sealForBackup(generateRecoveryKey());
    void sealed;
    const sessionKey = 'AgAAAAAwMTIzNDU2Nzg5QUJERUYwMTIzNDU2Nzg5QUJDREVG';
    const blob = master.sealSessionKey(sessionKey, 'c|s');

    // the same account key restored elsewhere (as a linked device receives it)
    const recovery = generateRecoveryKey();
    const restored = openMasterKeyBackup(master.sealForBackup(recovery), recovery, master.publicKey());
    expect(restored.openSessionKey(blob, 'c|s')).toBe(sessionKey);
  });

  it('will not seal under a key that is not a real recovery key', () => {
    const master = new EngineMasterKey();
    expect(() => master.sealForBackup('hunter2')).toThrow(/recovery key is not valid/);
  });
});
