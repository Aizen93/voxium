import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_VERSION } from '@voxium/shared';

// A release bump touches eight manifests. The landing page, the download URLs
// and the user card show APP_VERSION (the shared package's version), the Tauri
// installer and its updater feed carry tauri.conf.json's, Cargo's goes into the
// binary: one left behind means a site announcing a version the installers do
// not have, or an updater that never sees the new build.

const ROOT = resolve(__dirname, '../../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const jsonVersion = (p: string) => (JSON.parse(read(p)) as { version: string }).version;

describe('the version is the same in every manifest the release bump touches', () => {
  it('package manifests', () => {
    for (const p of ['package.json', 'apps/server/package.json', 'apps/desktop/package.json', 'apps/admin/package.json', 'packages/shared/package.json']) {
      expect(jsonVersion(p), p).toBe(APP_VERSION);
    }
  });

  it('the Tauri config, the crate and its lock', () => {
    expect(jsonVersion('apps/desktop/src-tauri/tauri.conf.json'), 'tauri.conf.json').toBe(APP_VERSION);
    const cargoToml = read('apps/desktop/src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1];
    expect(cargoToml, 'Cargo.toml [package] version').toBe(APP_VERSION);
    const cargoLock = read('apps/desktop/src-tauri/Cargo.lock').match(/name = "voxium"\r?\nversion = "([^"]+)"/)?.[1];
    expect(cargoLock, 'Cargo.lock voxium version').toBe(APP_VERSION);
  });

  it('APP_VERSION is a plain semver', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
