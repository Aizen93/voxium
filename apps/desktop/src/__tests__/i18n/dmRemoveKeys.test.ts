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
  fileURLToPath(new URL('../../components/dm/DMList.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/common/ConfirmDialog.tsx', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`dm\.remove\.`;

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

/** `{{name}}` placeholders, sorted. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)(?:\s*,[^}]*)?\s*\}\}/g)].map((m) => m[1]).sort();
}

const keys = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ name: file.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown> }));
const en = locales.find((l) => l.name === 'en')!;

describe('conversation removal translation keys', () => {
  it('finds the keys it is supposed to check, in all 11 locales', () => {
    expect(keys).toEqual([
      'dm.remove.action', 'dm.remove.actionWith', 'dm.remove.body', 'dm.remove.bodyDeleted', 'dm.remove.bodyOther',
      'dm.remove.callEnds', 'dm.remove.confirm', 'dm.remove.done', 'dm.remove.failed', 'dm.remove.removing', 'dm.remove.title',
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
      expect(leafKeys(lookup(l.bundle, 'dm.remove'), 'dm.remove.').sort(), l.name).toEqual(keys);
    }
  });

  it('names the same placeholders as English ({{name}} in the two that address the person)', () => {
    expect(placeholders(lookup(en.bundle, 'dm.remove.actionWith') as string)).toEqual(['name']);
    expect(placeholders(lookup(en.bundle, 'dm.remove.body') as string)).toEqual(['name']);
    for (const l of locales) {
      for (const k of keys) expect(placeholders(lookup(l.bundle, k) as string), `${l.name}: ${k}`).toEqual(placeholders(lookup(en.bundle, k) as string));
    }
  });

  it('each language says it in its own words (no English left in a translation)', () => {
    for (const l of locales.filter((x) => x.name !== 'en')) {
      for (const k of keys) expect(lookup(l.bundle, k), `${l.name}: ${k}`).not.toBe(lookup(en.bundle, k));
    }
  });

  it('the English text says what happens: cleared for you, kept by the other person, and the deleted-account variant cannot come back', () => {
    expect(lookup(en.bundle, 'dm.remove.body') as string).toMatch(/cleared for you, on all your devices/);
    expect(lookup(en.bundle, 'dm.remove.bodyOther') as string).toMatch(/keeps their copy and is not notified/);
    expect(lookup(en.bundle, 'dm.remove.bodyDeleted') as string).toMatch(/cannot come back/);
    // a community is a space in everything the user reads; nothing here names one
    for (const k of keys) expect(lookup(en.bundle, k) as string).not.toMatch(/\bserver\b/i);
  });
});
