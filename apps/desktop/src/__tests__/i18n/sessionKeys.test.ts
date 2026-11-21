// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SESSION_CLIENT_KINDS, SESSION_CLIENT_OSES } from '@voxium/shared';
import { SESSION_ERROR_KEYS } from '../../utils/serverErrors';

// A missing translation does not throw — i18next renders the raw key, so a
// person reading "Where you're signed in" in Japanese would see
// "settings.security.sessions.signOut" where the button should be. Sibling of
// vaultOwnershipKeys.test.ts, scoped to the sign-in sessions section of the
// Security tab.

const SOURCES = [fileURLToPath(new URL('../../components/settings/SessionsSection.tsx', import.meta.url))];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const SECTION = 'settings.security.sessions';
const PREFIX = String.raw`settings\.security\.sessions\.`;

/** Every quoted key under the section the surface names (t() calls and the kind/system maps). */
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

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
// The categories each language needs (the project's convention; CLDR's `many`
// of French, Spanish and Portuguese is a million-scale form that falls back to `other`)
const REQUIRED_CATEGORIES: Record<string, readonly string[]> = {
  en: ['one', 'other'], fr: ['one', 'other'], de: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ja: ['other'], ko: ['other'], zh: ['other'],
};
const PLURAL_BASES = [`${SECTION}.signedOutOthers`];

const source = readFileSync(SOURCES[0], 'utf8');
const found = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
// Keys the component reaches through its two maps are written out there; the
// closed lists decide which ones must exist
const KIND_KEYS = SESSION_CLIENT_KINDS.map((k) => `${SECTION}.kind.${k}`);
const OS_KEYS = SESSION_CLIENT_OSES.map((k) => `${SECTION}.os.${k}`);
const keys = [...new Set([...found, ...PLURAL_BASES])].sort();

const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ name: file.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown> }));
const en = locales.find((l) => l.name === 'en')!;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const resolves = (bundle: unknown, key: string) => isString(lookup(bundle, key)) || isString(lookup(bundle, `${key}_other`));
const isPluralIn = (bundle: unknown, key: string) => isString(lookup(bundle, `${key}_other`));

describe('sign-in sessions section translation keys', () => {
  it('finds the keys it is supposed to check, in all 11 locales', () => {
    expect(locales).toHaveLength(11);
    for (const k of [
      'title', 'description', 'thisDevice', 'kindAndOs', 'signedInOn', 'activeToday', 'activeYesterday', 'activeOn',
      'signOut', 'signOutOthers', 'noOthers', 'confirmTitle', 'confirmOthers', 'confirmOne', 'confirmOneTrusted',
      'password', 'signedOutOne', 'failed', 'loadFailed', 'retry',
    ]) {
      expect(source, k).toContain(`${SECTION}.${k}`);
    }
    expect(found).toContain(`${SECTION}.signedOutOthers`);
    // the closed lists come from the shared package: every member is reached by the component's maps
    for (const k of [...KIND_KEYS, ...OS_KEYS]) expect(found, k).toContain(k);
  });

  it('every key resolves to a non-empty string (or a plural family) in every locale', () => {
    const all = [...keys, ...KIND_KEYS, ...OS_KEYS];
    const missing = locales.flatMap((l) => all.filter((k) => !resolves(l.bundle, k)).map((k) => `${l.name}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('no locale holds a key under the section that the code no longer uses, and every locale holds the same set', () => {
    const expected = (bundle: unknown) => {
      const stems = [...new Set(leafKeys(lookup(bundle, SECTION), `${SECTION}.`).map((k) => k.replace(PLURAL_SUFFIX, '')))].sort();
      return stems;
    };
    const used = [...new Set([...keys, ...KIND_KEYS, ...OS_KEYS])].sort();
    for (const l of locales) expect(expected(l.bundle), l.name).toEqual(used);
  });

  it('the plural count message has exactly the categories of each language', () => {
    for (const l of locales) {
      for (const base of PLURAL_BASES) {
        expect(isPluralIn(l.bundle, base), `${l.name}: ${base}`).toBe(true);
        const present = Object.keys(lookup(l.bundle, base.split('.').slice(0, -1).join('.')) as Record<string, unknown>)
          .filter((k) => k.startsWith(`${base.split('.').pop()}_`))
          .map((k) => k.slice(k.lastIndexOf('_') + 1))
          .sort();
        expect(present, `${l.name}: ${base}`).toEqual([...REQUIRED_CATEGORIES[l.name]].sort());
        for (const c of present) {
          const p = placeholders(lookup(l.bundle, `${base}_${c}`) as string);
          // a form may spell the number out (Arabic zero, one and two); the general forms carry it
          if (c === 'other') expect(p, `${l.name}: ${base}_other`).toEqual(['count']);
          else expect(p.every((x) => x === 'count'), `${l.name}: ${base}_${c}`).toBe(true);
        }
      }
    }
  });

  it('names the same placeholders as English', () => {
    for (const l of locales) {
      for (const k of [...keys, ...KIND_KEYS, ...OS_KEYS].filter((x) => !PLURAL_BASES.includes(x))) {
        expect(placeholders(lookup(l.bundle, k) as string), `${l.name}: ${k}`).toEqual(placeholders(lookup(en.bundle, k) as string));
      }
    }
  });

  it('each language says it in its own words (no English left in a translation)', () => {
    // System and product names (Windows, macOS, Linux, Android, iOS) are the same in every language
    const sameEverywhere = new Set(['kindAndOs', 'os.windows', 'os.macos', 'os.linux', 'os.android', 'os.ios'].map((k) => `${SECTION}.${k}`));
    for (const l of locales.filter((x) => x.name !== 'en')) {
      for (const k of [...keys, ...KIND_KEYS, ...OS_KEYS].filter((x) => !PLURAL_BASES.includes(x) && !sameEverywhere.has(x))) {
        expect(lookup(l.bundle, k), `${l.name}: ${k}`).not.toBe(lookup(en.bundle, k));
      }
    }
  });

  it('the English reads as designed and says space or session, never a machine word it does not mean', () => {
    expect(lookup(en.bundle, `${SECTION}.title`)).toBe("Where you're signed in");
    expect(lookup(en.bundle, `${SECTION}.thisDevice`)).toBe('This device');
    expect(lookup(en.bundle, `${SECTION}.signOutOthers`)).toBe('Sign out of all other sessions');
    expect(lookup(en.bundle, `${SECTION}.signedOutOthers_one`)).toBe('Signed out of {{count}} other session');
    expect(lookup(en.bundle, `${SECTION}.signedOutOthers_other`)).toBe('Signed out of {{count}} other sessions');
    for (const k of keys.filter((x) => !PLURAL_BASES.includes(x))) expect(lookup(en.bundle, k) as string).not.toMatch(/\bserver\b/i);
  });

  it('the server answers the section can show are mapped in every locale', () => {
    for (const l of locales) {
      for (const k of SESSION_ERROR_KEYS) expect(isString(lookup(l.bundle, `serverErrors.${k}`)), `${l.name}: serverErrors.${k}`).toBe(true);
    }
  });
});
