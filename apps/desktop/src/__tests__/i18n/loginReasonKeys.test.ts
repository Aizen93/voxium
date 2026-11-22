// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A missing translation does not throw — i18next renders the raw key, so a
// person signed out from another device would read
// "auth.login.reason.signedOutElsewhere" where the page says why. Sibling of
// vaultOwnershipKeys.test.ts, scoped to the reasons the sign-in page shows
// (the closed list in utils/loginReasons.ts).

const SOURCES = [fileURLToPath(new URL('../../utils/loginReasons.ts', import.meta.url))];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`auth\.login\.reason\.`;

function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const literal = new RegExp(String.raw`'(` + PREFIX + String.raw`[A-Za-z0-9_.]+)'`, 'g');
    for (let m = literal.exec(source); m; m = literal.exec(source)) keys.add(m[1]);
  }
  return [...keys].sort();
}

function lookup(bundle: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), bundle);
}

function leafKeys(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : leafKeys(v, `${prefix}${k}.`));
}

const keys = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ name: file.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown> }));
const en = locales.find((l) => l.name === 'en')!;

describe('sign-in page reason translation keys', () => {
  it('finds the keys it is supposed to check, in all 11 locales', () => {
    expect(keys).toEqual([
      'auth.login.reason.accountBanned',
      'auth.login.reason.accountDeleted',
      'auth.login.reason.sessionEnded',
      'auth.login.reason.signedOutElsewhere',
    ]);
    expect(locales).toHaveLength(11);
  });

  it('every key is a non-empty string in every locale, and no locale holds any other under the section', () => {
    for (const l of locales) {
      for (const k of keys) {
        const v = lookup(l.bundle, k);
        expect(typeof v === 'string' && v.trim().length > 0, `${l.name}: ${k}`).toBe(true);
      }
      expect(leafKeys(lookup(l.bundle, 'auth.login.reason'), 'auth.login.reason.').sort(), l.name).toEqual(keys);
    }
  });

  it('each language says it in its own words, with no placeholder', () => {
    for (const l of locales) {
      for (const k of keys) {
        expect(lookup(l.bundle, k) as string, `${l.name}: ${k}`).not.toMatch(/\{\{/);
        if (l.name !== 'en') expect(lookup(l.bundle, k), `${l.name}: ${k}`).not.toBe(lookup(en.bundle, k));
      }
    }
  });

  it('the English is the visible text the browser tests look for, and never says server', () => {
    expect(lookup(en.bundle, 'auth.login.reason.signedOutElsewhere')).toBe('You were signed out from another device.');
    expect(lookup(en.bundle, 'auth.login.reason.sessionEnded')).toBe('Your session ended. Sign in again.');
    expect(lookup(en.bundle, 'auth.login.reason.accountBanned')).toBe('Your account has been banned.');
    expect(lookup(en.bundle, 'auth.login.reason.accountDeleted')).toBe('Your account has been deleted.');
    for (const k of keys) expect(lookup(en.bundle, k) as string).not.toMatch(/\bserver\b/i);
  });
});
