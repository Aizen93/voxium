// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The member-list surface (the People panel, Server settings → Members):
// every key it names must resolve in every locale, and the plural family the
// panel uses for "and N more online" must carry every CLDR category its
// language needs — a missing one renders the fallback form in silence.
// Sibling of discoveryKeys.test.ts.

const SOURCES = [
  fileURLToPath(new URL('../../components/server/MemberSidebar.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/MembersDirectory.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/MembersDialog.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/ServerSettingsModal.tsx', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`(?:people\.|serverSettings\.members\.)`;

function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const called = new RegExp(String.raw`(?<![A-Za-z0-9_$.])t\(\s*'(` + PREFIX + String.raw`[^']*)'`, 'g');
    for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
    // the count line picks its key inside a ternary: both arms
    const ternary = new RegExp(String.raw`'(` + PREFIX + String.raw`memberCount(?:Plural)?)'`, 'g');
    for (let m = ternary.exec(source); m; m = ternary.exec(source)) keys.add(m[1]);
    // the toast fallbacks reach t() through getTranslatedError(err, t, key)
    const fallback = new RegExp(String.raw`getTranslatedError\([^;]*?,\s*'(` + PREFIX + String.raw`[^']*)'\s*\)`, 'g');
    for (let m = fallback.exec(source); m; m = fallback.exec(source)) keys.add(m[1]);
  }
  return [...keys].sort();
}

function lookup(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
}

const keys = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
const locales = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json')).map((file) => ({
  name: file.replace(/\.json$/, ''),
  bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown>,
}));

const REQUIRED_CATEGORIES: Record<string, readonly string[]> = {
  en: ['one', 'other'], fr: ['one', 'other'], de: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ja: ['other'], ko: ['other'], zh: ['other'],
};
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const resolves = (bundle: unknown, key: string) => isString(lookup(bundle, key)) || isString(lookup(bundle, `${key}_other`));
const isPluralIn = (bundle: unknown, key: string) => isString(lookup(bundle, `${key}_other`));
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)(?:\s*,[^}]*)?\s*\}\}/g)].map((m) => m[1]).sort();

const en = locales.find((l) => l.name === 'en')!;

describe('member-list translation keys', () => {
  it('finds the translation calls it is supposed to check', () => {
    expect(locales.length).toBe(11);
    expect(keys).toContain('people.browseAll');                     // the panel's way into the directory
    expect(keys).toContain('people.directoryTitle');                // the directory dialog
    expect(keys).toContain('people.moreOnline');                    // the cut slice's footer
    expect(keys).toContain('serverSettings.members.loadMore');      // the directory's next page
    expect(keys).toContain('serverSettings.members.failedToLoad');  // its failure toast
    expect(keys).toContain('serverSettings.members.memberCountPlural');
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('every key resolves in %s', (name, bundle) => {
    const missing = keys.filter((key) => !resolves(bundle, key));
    expect(missing, `${name} is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('plural families carry every category %s needs, and only those', (name, bundle) => {
    const required = REQUIRED_CATEGORIES[name];
    expect(required, `no plural rule listed for ${name}`).toBeDefined();
    for (const key of keys.filter((k) => isPluralIn(en.bundle, k))) {
      expect(isPluralIn(bundle, key), `${name}: ${key} must be a plural family`).toBe(true);
      for (const cat of required) {
        expect(isString(lookup(bundle, `${key}_${cat}`)), `${name}: ${key}_${cat}`).toBe(true);
      }
    }
  });

  it.each(locales.filter((l) => l.name !== 'en').map((l) => [l.name, l.bundle] as const))('placeholders match English in %s', (name, bundle) => {
    for (const key of keys) {
      const enText = lookup(en.bundle, key) ?? lookup(en.bundle, `${key}_other`);
      const text = lookup(bundle, key) ?? lookup(bundle, `${key}_other`);
      if (!isString(enText) || !isString(text)) continue;
      expect(placeholders(text), `${name}: ${key}`).toEqual(placeholders(enText));
    }
  });
});
