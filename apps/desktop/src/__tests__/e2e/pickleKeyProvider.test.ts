// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PickleKeyUnavailableError, createKeychainPickleKeys, localStoragePickleKeys } from '../../services/e2e/pickleKeyProvider';

// node has no localStorage — a minimal in-memory stand-in
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
});

const KEY_B64 = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq83'; // 43 chars, shape only

function fakeKeychain(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    const userId = args?.userId as string;
    if (cmd === 'e2e_pickle_key_get') return (entries.get(userId) ?? null) as T;
    if (cmd === 'e2e_pickle_key_set') {
      entries.set(userId, args?.keyB64 as string);
      return undefined as T;
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return { entries, calls, invoke };
}

describe('keychain pickle key provider', () => {
  it('reads from the keychain and clears any stale localStorage copy', async () => {
    storage.set('voxium_e2e_pk_user-1', 'stale-copy');
    const keychain = fakeKeychain({ 'user-1': KEY_B64 });
    const provider = createKeychainPickleKeys(keychain.invoke);

    expect(await provider.load('user-1')).toBe(KEY_B64);
    expect(storage.has('voxium_e2e_pk_user-1')).toBe(false);
  });

  it('migrates a legacy localStorage key into the keychain (removing it only after verified write)', async () => {
    storage.set('voxium_e2e_pk_user-1', KEY_B64);
    const keychain = fakeKeychain();
    const provider = createKeychainPickleKeys(keychain.invoke);

    expect(await provider.load('user-1')).toBe(KEY_B64);
    expect(keychain.entries.get('user-1')).toBe(KEY_B64); // migrated in
    expect(storage.has('voxium_e2e_pk_user-1')).toBe(false); // plaintext copy gone
    // write was verified with a read-back before deleting the fallback
    expect(keychain.calls.map((c) => c.cmd)).toEqual([
      'e2e_pickle_key_get',
      'e2e_pickle_key_set',
      'e2e_pickle_key_get',
    ]);
  });

  it('keeps the localStorage copy when the migration write cannot be verified', async () => {
    storage.set('voxium_e2e_pk_user-1', KEY_B64);
    const invoke = async <T>(cmd: string): Promise<T> => {
      if (cmd === 'e2e_pickle_key_get') return null as T; // write never sticks
      return undefined as T;
    };
    const provider = createKeychainPickleKeys(invoke);

    expect(await provider.load('user-1')).toBe(KEY_B64);
    expect(storage.get('voxium_e2e_pk_user-1')).toBe(KEY_B64); // fallback retained
  });

  it('falls back to localStorage when the keychain is unavailable', async () => {
    storage.set('voxium_e2e_pk_user-1', KEY_B64);
    const invoke = async <T>(): Promise<T> => {
      throw new Error('keychain locked');
    };
    const provider = createKeychainPickleKeys(invoke);

    expect(await provider.load('user-1')).toBe(KEY_B64);

    await provider.save('user-2', KEY_B64); // save must not throw either
    expect(storage.get('voxium_e2e_pk_user-2')).toBe(KEY_B64);
  });

  it('throws rather than reporting "no key" when the keychain cannot be reached', async () => {
    // The dangerous case, and the one the suite did not cover: keychain down
    // AND no localStorage copy — which is every keychain-era install, since the
    // migration deletes the disk copy once the keychain provably holds it.
    //
    // Returning null here reads as "this account has no key yet", so the vault
    // mints a second one. The Olm account then fails to unpickle, the device
    // regenerates its identity, all DM history goes dark and every peer's pin
    // breaks — from one launch where gnome-keyring or D-Bus was slow to start.
    const provider = createKeychainPickleKeys(async () => {
      throw new Error('Secret Service not available');
    });

    await expect(provider.load('user-1')).rejects.toThrow(/unavailable/);
    // and specifically NOT a null that the caller would act on
    await expect(provider.load('user-1')).rejects.toBeInstanceOf(PickleKeyUnavailableError);
  });

  it('still prefers a real local answer over failing', async () => {
    // A pre-keychain install genuinely has its key on disk. That IS an answer,
    // so an unreachable keychain must not turn it into an error.
    storage.set('voxium_e2e_pk_user-1', KEY_B64);
    const provider = createKeychainPickleKeys(async () => {
      throw new Error('keychain locked');
    });

    expect(await provider.load('user-1')).toBe(KEY_B64);
  });

  it('returns null for a brand-new account', async () => {
    const provider = createKeychainPickleKeys(fakeKeychain().invoke);
    expect(await provider.load('fresh-user')).toBeNull();
  });

  it('saves through to the keychain when available', async () => {
    const keychain = fakeKeychain();
    const provider = createKeychainPickleKeys(keychain.invoke);
    await provider.save('user-1', KEY_B64);
    expect(keychain.entries.get('user-1')).toBe(KEY_B64);
    expect(storage.size).toBe(0); // no plaintext copy written
  });
});

describe('localStorage pickle key provider (browser dev fallback)', () => {
  it('round-trips keys', async () => {
    expect(await localStoragePickleKeys.load('u1')).toBeNull();
    await localStoragePickleKeys.save('u1', KEY_B64);
    expect(await localStoragePickleKeys.load('u1')).toBe(KEY_B64);
  });
});
