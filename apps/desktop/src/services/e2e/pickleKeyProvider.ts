// Pickle-key storage backends (docs/e2e-dm-spec.md §7.3).
//
// The 32-byte vodozemac pickle key is the only secret the webview handles.
// In the Tauri desktop app it lives in the OS credential store (Windows
// Credential Manager / macOS Keychain / Linux Secret Service) via the
// e2e_pickle_key_* commands; pre-keychain installs are migrated out of
// localStorage on first load. Browser dev builds keep the localStorage
// backend — there is no OS keychain to reach from a plain web context.

/**
 * Raised when the store that HOLDS the pickle key cannot be reached.
 *
 * Distinct from `load` returning null, and the distinction is the whole point.
 * `null` means "this account has no key here" — the honest answer for a first
 * launch, and the cue to mint one. An unreachable keychain is not that answer;
 * it is no answer. Collapsing the two meant one launch with gnome-keyring or
 * D-Bus not yet up minted a SECOND pickle key, which cannot unpickle the Olm
 * account, so the device silently regenerated its identity: history unreadable,
 * every peer's pin broken, everyone re-verifying — from a transient failure
 * that would have fixed itself on the next launch.
 */
export class PickleKeyUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`pickle key store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PickleKeyUnavailableError';
  }
}

export interface PickleKeyProvider {
  /** The stored key, or null if this account provably has none yet. */
  load(userId: string): Promise<string | null>;
  save(userId: string, keyB64: string): Promise<void>;
}

const legacyKey = (userId: string) => `voxium_e2e_pk_${userId}`;

export const localStoragePickleKeys: PickleKeyProvider = {
  async load(userId) {
    return localStorage.getItem(legacyKey(userId));
  },
  async save(userId, keyB64) {
    localStorage.setItem(legacyKey(userId), keyB64);
  },
};

/** Test/DI hook so unit tests don't need a real Tauri runtime. */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createKeychainPickleKeys(invokeFn?: InvokeFn): PickleKeyProvider {
  const doInvoke: InvokeFn = async (cmd, args) => {
    if (invokeFn) return invokeFn(cmd, args);
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
  };

  return {
    async load(userId) {
      try {
        const fromKeychain = await doInvoke<string | null>('e2e_pickle_key_get', { userId });
        if (fromKeychain) {
          // Keychain is authoritative — drop any stale localStorage copy so
          // the secret stops living in plaintext on disk
          localStorage.removeItem(legacyKey(userId));
          return fromKeychain;
        }

        // One-time migration of a pre-keychain install
        const legacy = localStorage.getItem(legacyKey(userId));
        if (legacy) {
          await doInvoke('e2e_pickle_key_set', { userId, keyB64: legacy });
          // Only remove the fallback copy once the keychain provably holds it —
          // losing this key would orphan every pickle in the vault
          const verified = await doInvoke<string | null>('e2e_pickle_key_get', { userId });
          if (verified === legacy) {
            localStorage.removeItem(legacyKey(userId));
            console.info('e2e: pickle key migrated from localStorage to the OS keychain');
          }
          return legacy;
        }
        return null;
      } catch (err) {
        // A pre-keychain install still has its key on disk; that is a real
        // answer and is safe to use.
        const legacy = localStorage.getItem(legacyKey(userId));
        if (legacy !== null) {
          console.warn(
            'e2e: OS keychain unavailable, using localStorage fallback:',
            err instanceof Error ? err.message : err
          );
          return legacy;
        }
        // Nothing on disk either, so we do not KNOW there is no key — the
        // keychain simply did not answer. Returning null here would be read as
        // "no key exists" and mint a new one over the top of the real one.
        // Failing is recoverable; minting is not.
        console.error(
          'e2e: OS keychain unreachable and no local copy — refusing to mint a new pickle key:',
          err instanceof Error ? err.message : err
        );
        throw new PickleKeyUnavailableError(err);
      }
    },

    async save(userId, keyB64) {
      try {
        await doInvoke('e2e_pickle_key_set', { userId, keyB64 });
      } catch (err) {
        // Fail-soft: a key we can't persist at all would orphan the vault on
        // next launch. localStorage is strictly better than losing it.
        console.warn('e2e: OS keychain write failed, storing in localStorage:', err instanceof Error ? err.message : err);
        localStorage.setItem(legacyKey(userId), keyB64);
      }
    },
  };
}

/** Keychain-backed in the Tauri app, localStorage in browser dev builds. */
export function defaultPickleKeyProvider(): PickleKeyProvider {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return isTauri ? createKeychainPickleKeys() : localStoragePickleKeys;
}
