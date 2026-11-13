import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { BUILD_VAULT_NAMESPACE, serverVaultNamespace, vaultDbName } from '../../services/e2e/vault';
import type { PickleKeyProvider } from '../../services/e2e/vault';
import { OFFICIAL_SESSION_DOMAIN } from '../../services/sessionOrigin';
import { selfHostedIdentifier } from '../../../scripts/tauriSelfHosted.mjs';

// Builds for different servers keep separate vaults. A desktop build for
// another server names its vault with a digest of that server's origin, on
// top of the identifier (and so the webview data folder) of its own that it
// has; the official desktop build and every browser build keep the name they
// always had.

const digestOf = (origin: string) => createHash('sha256').update(origin, 'utf8').digest('hex').slice(0, 16);
const OFFICIAL = `https://${OFFICIAL_SESSION_DOMAIN}`;

describe('serverVaultNamespace', () => {
  it('the official desktop build has none: its vaults keep the name they always had', () => {
    for (const origin of [OFFICIAL, `https://api.${OFFICIAL_SESSION_DOMAIN}`]) {
      expect(serverVaultNamespace(true, origin), origin).toBeUndefined();
    }
  });

  it('a browser build has none, whatever its server: browser storage is already the page origin\'s own', () => {
    for (const origin of [OFFICIAL, 'https://chat.example.org', 'http://localhost:3001', 'http://10.0.0.5:3001']) {
      expect(serverVaultNamespace(false, origin), origin).toBeUndefined();
    }
  });

  it('a desktop build for another server: a letter and the first 16 hex digits of its origin\'s SHA-256', () => {
    expect(serverVaultNamespace(true, 'https://chat.example.org')).toBe(`s${digestOf('https://chat.example.org')}`);
    expect(serverVaultNamespace(true, 'http://localhost:3001')).toBe(`s${digestOf('http://localhost:3001')}`);
    // look-alikes of the official origin are other servers
    for (const origin of [
      `http://${OFFICIAL_SESSION_DOMAIN}`,
      `${OFFICIAL}:8443`,
      `${OFFICIAL}.example.org`,
      `https://evil${OFFICIAL_SESSION_DOMAIN}`,
    ]) {
      expect(serverVaultNamespace(true, origin), origin).toBe(`s${digestOf(origin)}`);
    }
  });

  it('one per server', () => {
    const origins = ['https://chat.example.org', 'https://chat.example.net', 'http://chat.example.org', 'https://chat.example.org:8443'];
    expect(new Set(origins.map((origin) => serverVaultNamespace(true, origin))).size).toBe(origins.length);
  });

  it('is the label of the identifier the build for that server is made with', () => {
    for (const url of ['https://chat.example.org/api/v1', 'http://10.0.0.5:3001/api/v1', 'https://chat.example.org./api/v1']) {
      expect(selfHostedIdentifier(url)).toBe(`com.voxium.selfhosted.${serverVaultNamespace(true, new URL(url).origin)}`);
    }
  });
});

describe('vaultDbName', () => {
  it('in a browser build, today\'s names: no namespace of the build, an explicit one as before', () => {
    expect(BUILD_VAULT_NAMESPACE).toBeUndefined();
    expect(vaultDbName('user-1')).toBe('voxium-e2e-v2-user-1');
    expect(vaultDbName('user-1', 'v3')).toBe('voxium-e2e-v2-user-1-v3');
  });

  it('with a server namespace: the user id and the server', () => {
    const ns = serverVaultNamespace(true, 'https://chat.example.org')!;
    expect(vaultDbName('user-1', ns)).toBe(`voxium-e2e-v2-user-1-${ns}`);
    expect(vaultDbName('user-1', ns)).not.toBe(vaultDbName('user-1'));
  });
});

describe('the vault name of the running build', () => {
  // Decided once, when the module loads: whether it runs in the Tauri app
  // (`__TAURI_INTERNALS__`) and the API it is compiled for (VITE_API_URL)
  type TauriWindow = { __TAURI_INTERNALS__?: unknown };
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const provider: PickleKeyProvider = { load: async () => key, save: async () => {} };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  async function loadBuild(apiUrl: string, inTauri: boolean) {
    vi.stubEnv('VITE_API_URL', apiUrl);
    if (inTauri) (window as TauriWindow).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    return import('../../services/e2e/vault');
  }

  it('the official desktop build keeps today\'s name', async () => {
    const vault = await loadBuild(`${OFFICIAL}/api/v1`, true);
    expect(vault.BUILD_VAULT_NAMESPACE).toBeUndefined();
    expect(vault.vaultDbName('user-1')).toBe('voxium-e2e-v2-user-1');
  });

  it('a browser build for any server keeps today\'s name', async () => {
    const vault = await loadBuild('https://chat.example.org/api/v1', false);
    expect(vault.BUILD_VAULT_NAMESPACE).toBeUndefined();
    expect(vault.vaultDbName('user-1')).toBe('voxium-e2e-v2-user-1');
  });

  it('a desktop build for another server opens, and the account deletion drops, the vault named with its server', async () => {
    const vault = await loadBuild('https://chat.example.org/api/v1', true);
    const expected = `voxium-e2e-v2-user-9-s${digestOf('https://chat.example.org')}`;
    expect(vault.vaultDbName('user-9')).toBe(expected);

    const opened = new vault.E2EVault('user-9', provider);
    await opened.open();
    expect((await indexedDB.databases()).map((db) => db.name)).toContain(expected);
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain('voxium-e2e-v2-user-9');
    opened.close();

    const { forgetLocalE2EState } = await import('../../services/e2e/e2eService');
    const drop = vi.spyOn(indexedDB, 'deleteDatabase');
    forgetLocalE2EState('user-9');
    expect(drop).toHaveBeenCalledWith(expected);
    expect(drop).not.toHaveBeenCalledWith('voxium-e2e-v2-user-9');
  });
});
