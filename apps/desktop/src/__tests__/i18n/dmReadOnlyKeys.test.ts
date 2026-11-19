// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A missing translation does not throw — i18next renders the raw key, so a
// reader of a conversation whose other side's account was deleted would see
// "dm.deletedParticipant.readOnlyNotice" exactly where the app explains why
// nothing can be written. Sibling of discoveryKeys.test.ts, scoped to the
// read-only conversation surface: the header, the list row, the notice in
// place of the composer, the "Message deleted" line and quote, the call
// panel's name and the search placeholder.

const SOURCES = [
  fileURLToPath(new URL('../../components/dm/DeletedParticipant.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/dm/DMChatArea.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/dm/DMList.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/chat/MessageItem.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/DMVoicePanel.tsx', import.meta.url)),
  fileURLToPath(new URL('../../utils/dmParticipant.ts', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`dm\.deletedParticipant\.`;

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

describe('read-only conversation translation keys', () => {
  it('finds the keys it is supposed to check, in all 11 locales', () => {
    expect(keys).toEqual(['dm.deletedParticipant.messageDeleted', 'dm.deletedParticipant.name', 'dm.deletedParticipant.readOnlyNotice']);
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
      expect(leafKeys(lookup(l.bundle, 'dm.deletedParticipant'), 'dm.deletedParticipant.').sort(), l.name).toEqual(keys);
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

  it('the English notice says why: read-only, because the other person\'s account was deleted', () => {
    const notice = lookup(en.bundle, 'dm.deletedParticipant.readOnlyNotice') as string;
    expect(notice).toMatch(/read-only/);
    expect(notice).toMatch(/account was deleted/);
    // a community is a space in everything the user reads; nothing here names one
    for (const k of keys) expect(lookup(en.bundle, k) as string).not.toMatch(/\bserver\b/i);
  });
});
