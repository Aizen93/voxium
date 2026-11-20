// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A missing translation does not throw — i18next renders the raw key, so a
// person whose encrypted vault another tab owns would read
// "vaultOwnership.blockedTitle" where the app explains why it is not shown.
// Sibling of dmReadOnlyKeys.test.ts, scoped to the screens of the vault
// ownership gate: blocked at start, the tab that gave the vault up, "Use it
// here", "Take over anyway", the call warning and the waiting states.

const SOURCES = [fileURLToPath(new URL('../../components/layout/VaultOwnershipGate.tsx', import.meta.url))];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`vaultOwnership\.`;

/** Every static key under the prefix the surface names: t() calls and any quoted literal. */
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

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)(?:\s*,[^}]*)?\s*\}\}/g)].map((m) => m[1]).sort();
}

const keys = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ name: file.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown> }));
const en = locales.find((l) => l.name === 'en')!;

describe('vault ownership screen translation keys', () => {
  it('finds the keys it is supposed to check, in all 11 locales', () => {
    expect(keys).toEqual([
      'vaultOwnership.asking',
      'vaultOwnership.blockedBody',
      'vaultOwnership.blockedTitle',
      'vaultOwnership.callPossible',
      'vaultOwnership.callWarning',
      'vaultOwnership.cancel',
      'vaultOwnership.lostBody',
      'vaultOwnership.lostTitle',
      'vaultOwnership.noReply',
      'vaultOwnership.opening',
      'vaultOwnership.releasing',
      'vaultOwnership.takeOverAnyway',
      'vaultOwnership.useHere',
      'vaultOwnership.waitingNote',
    ]);
    expect(locales).toHaveLength(11);
  });

  it('every key is a non-empty string in every locale', () => {
    const missing = locales.flatMap((l) => keys.filter((k) => {
      const v = lookup(l.bundle, k);
      return typeof v !== 'string' || v.trim().length === 0;
    }).map((k) => `${l.name}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('no locale holds a key under the section that the code no longer uses, and every locale holds the same set', () => {
    for (const l of locales) {
      expect(leafKeys(lookup(l.bundle, 'vaultOwnership'), 'vaultOwnership.').sort(), l.name).toEqual(keys);
    }
  });

  it('names the same placeholders as English (none today)', () => {
    for (const l of locales) {
      for (const k of keys) expect(placeholders(lookup(l.bundle, k) as string), `${l.name}: ${k}`).toEqual(placeholders(lookup(en.bundle, k) as string));
    }
  });

  it('each language says it in its own words (no English left in a translation)', () => {
    for (const l of locales.filter((x) => x.name !== 'en')) {
      for (const k of keys) expect(lookup(l.bundle, k), `${l.name}: ${k}`).not.toBe(lookup(en.bundle, k));
    }
  });

  it('the English names the product and the tab, warns before a call ends, and never says server', () => {
    expect(lookup(en.bundle, 'vaultOwnership.blockedTitle')).toBe('Voxium is open in another tab');
    expect(lookup(en.bundle, 'vaultOwnership.useHere')).toBe('Use it here');
    expect(lookup(en.bundle, 'vaultOwnership.takeOverAnyway')).toBe('Take over anyway');
    expect(lookup(en.bundle, 'vaultOwnership.callWarning')).toBe('A call is in progress in the other tab; it will end.');
    for (const k of keys) expect(lookup(en.bundle, k) as string).not.toMatch(/\bserver\b/i);
  });

  it('every locale keeps the product name', () => {
    for (const l of locales) {
      for (const k of ['vaultOwnership.blockedTitle', 'vaultOwnership.lostTitle']) {
        expect(lookup(l.bundle, k), `${l.name}: ${k}`).toContain('Voxium');
      }
    }
  });
});
