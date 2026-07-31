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

  it('will not seal under a key that is not a real recovery key', () => {
    const master = new EngineMasterKey();
    expect(() => master.sealForBackup('hunter2')).toThrow(/recovery key is not valid/);
  });
});
