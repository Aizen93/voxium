import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseAssetOrigins, withAssetOrigins, releaseConfig } from '../../../scripts/tauriCsp.mjs';

// The desktop CSP names only the app's own hosts; avatars and space icons
// redirect to the deployment's object store and their upload is a direct PUT
// to it. The release build merges that origin into img-src / connect-src
// through a config overlay (`tauri build --config`), read from
// TAURI_ASSET_ORIGIN so the origin never enters the repository. These pin the
// pure functions against the REAL tauri.conf.json and the CLI that prints the
// overlay.

// __dirname, not import.meta.url: under the jsdom environment the latter is
// the page's http URL, not a file URL
const CONF_PATH = resolve(__dirname, '../../../src-tauri/tauri.conf.json');
const CLI_PATH = resolve(__dirname, '../../../scripts/tauri-release-config.mjs');
const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8')) as { app: { security: { csp: string } } };
const BASE = conf.app.security.csp;
const ORIGIN = 'https://assets.example.com';

function directive(csp: string, name: string): string[] {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
  if (!found) throw new Error(`no ${name} directive`);
  return found.split(/\s+/).slice(1);
}

describe('parseAssetOrigins', () => {
  it('unset or blank means no origins', () => {
    expect(parseAssetOrigins(undefined)).toEqual([]);
    expect(parseAssetOrigins(null)).toEqual([]);
    expect(parseAssetOrigins('')).toEqual([]);
    expect(parseAssetOrigins('  ,  ')).toEqual([]);
  });

  it('splits a comma list, trims, dedupes, keeps order, accepts a port', () => {
    expect(parseAssetOrigins(` ${ORIGIN} , http://minio.internal:9000,${ORIGIN}`)).toEqual([ORIGIN, 'http://minio.internal:9000']);
  });

  it('refuses anything that is not a bare scheme://host[:port] (a path, a trailing slash, another scheme, a bare host)', () => {
    for (const bad of [`${ORIGIN}/`, `${ORIGIN}/bucket`, 'ftp://assets.example.com', 'assets.example.com', 'https://', `${ORIGIN}?x=1`, 'https://user@assets.example.com']) {
      expect(() => parseAssetOrigins(bad), bad).toThrow(/TAURI_ASSET_ORIGIN must hold origins like https:\/\/host\[:port\]/);
    }
  });
});

describe('withAssetOrigins', () => {
  it('appends the origin once to img-src and connect-src and leaves every other directive byte-identical', () => {
    const merged = withAssetOrigins(BASE, [ORIGIN]);
    expect(directive(merged, 'img-src')).toEqual([...directive(BASE, 'img-src'), ORIGIN]);
    expect(directive(merged, 'connect-src')).toEqual([...directive(BASE, 'connect-src'), ORIGIN]);
    const others = (csp: string) => csp.split(';').map((d) => d.trim()).filter((d) => !/^(img|connect)-src /.test(d));
    expect(others(merged)).toEqual(others(BASE));
    // the base policy stays what the repository ships: no origin of ours in it
    expect(BASE).not.toContain(ORIGIN);
  });

  it('is idempotent and never duplicates an origin the directive already names', () => {
    const once = withAssetOrigins(BASE, [ORIGIN]);
    expect(withAssetOrigins(once, [ORIGIN])).toBe(once);
    const withSelf = withAssetOrigins(BASE, ["'self'"]);
    expect(withSelf).toBe(BASE.split(';').map((d) => d.trim()).filter(Boolean).join('; '));
  });

  it('adds several origins in order', () => {
    const merged = withAssetOrigins(BASE, [ORIGIN, 'http://minio.internal:9000']);
    expect(directive(merged, 'img-src').slice(-2)).toEqual([ORIGIN, 'http://minio.internal:9000']);
    expect(directive(merged, 'connect-src').slice(-2)).toEqual([ORIGIN, 'http://minio.internal:9000']);
  });

  it('returns the policy untouched without origins', () => {
    expect(withAssetOrigins(BASE, [])).toBe(BASE);
  });

  it('refuses an empty policy and one missing a directive to extend (a silent no-op would ship a build without avatars)', () => {
    expect(() => withAssetOrigins('', [ORIGIN])).toThrow('The base CSP is empty');
    expect(() => withAssetOrigins("default-src 'self'; img-src 'self'", [ORIGIN])).toThrow('no connect-src directive');
    expect(() => withAssetOrigins("default-src 'self'; connect-src 'self'", [ORIGIN])).toThrow('no img-src directive');
  });
});

describe('releaseConfig', () => {
  it('is null when the variable is unset (the base policy ships as is)', () => {
    expect(releaseConfig(conf, undefined)).toBeNull();
    expect(releaseConfig(conf, '')).toBeNull();
  });

  it('is the overlay `tauri build --config` merges: app.security.csp and nothing else', () => {
    const overlay = releaseConfig(conf, ORIGIN);
    expect(Object.keys(overlay!)).toEqual(['app']);
    expect(Object.keys(overlay!.app)).toEqual(['security']);
    expect(Object.keys(overlay!.app.security)).toEqual(['csp']);
    expect(overlay!.app.security.csp).toBe(withAssetOrigins(BASE, [ORIGIN]));
  });

  it('throws on a malformed variable or a conf without a policy', () => {
    expect(() => releaseConfig(conf, 'not an origin')).toThrow(/TAURI_ASSET_ORIGIN/);
    expect(() => releaseConfig({ app: { security: {} } }, ORIGIN)).toThrow('The base CSP is empty');
  });
});

describe('tauri-release-config.mjs (the CLI the release workflow runs)', () => {
  const run = (env: Record<string, string | undefined>) =>
    // stderr captured, not inherited: the malformed-variable case prints its stack
    execFileSync(process.execPath, [CLI_PATH], { env: { ...process.env, TAURI_ASSET_ORIGIN: undefined, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('prints {} with the variable unset', () => {
    expect(JSON.parse(run({}))).toEqual({});
  });

  it('prints the overlay with the origin in both directives', () => {
    const printed = JSON.parse(run({ TAURI_ASSET_ORIGIN: ORIGIN })) as { app: { security: { csp: string } } };
    expect(directive(printed.app.security.csp, 'img-src')).toContain(ORIGIN);
    expect(directive(printed.app.security.csp, 'connect-src')).toContain(ORIGIN);
    expect(printed.app.security.csp).toBe(withAssetOrigins(BASE, [ORIGIN]));
  });

  it('fails the build on a malformed variable instead of shipping the base policy silently', () => {
    expect(() => run({ TAURI_ASSET_ORIGIN: 'assets.example.com' })).toThrow();
  });
});
