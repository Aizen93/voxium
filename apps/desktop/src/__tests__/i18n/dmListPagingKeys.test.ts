// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A missing translation does not throw — i18next renders the raw key, so a
// person asked to confirm clearing a history would see "dm.remove.body"
// exactly where the app says what is lost. Sibling of dmReadOnlyKeys.test.ts,
// scoped to the conversation-removal surface: the list's X and its
// confirmation dialog.

const SOURCES = [
  fileURLToPath(new URL('../../components/dm/DMListFooter.tsx', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`dm\.list\.`;

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

/** The leaf keys of a section, dotted, for the orphan check. */
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

describe('conversation list paging translation keys', () => {
  it('finds the keys it is supposed to check, in all 11 locales', () => {
    expect(keys).toEqual(['dm.list.loadMore', 'dm.list.loadMoreFailed', 'dm.list.loadMoreRetry']);
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
      expect(leafKeys(lookup(l.bundle, 'dm.list'), 'dm.list.').sort(), l.name).toEqual(keys);
    }
  });

  it('each language says it in its own words', () => {
    for (const l of locales.filter((x) => x.name !== 'en')) {
      for (const k of keys) expect(lookup(l.bundle, k), `${l.name}: ${k}`).not.toBe(lookup(en.bundle, k));
    }
  });

  it('French uses the typographic apostrophe', () => {
    const fr = locales.find((l) => l.name === 'fr')!;
    for (const k of keys) expect(lookup(fr.bundle, k) as string).not.toContain("'");
  });
});
