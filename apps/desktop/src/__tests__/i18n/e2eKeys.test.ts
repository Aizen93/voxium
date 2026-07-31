// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A missing translation does not throw — i18next renders the raw key, so a
// user on a non-English locale sees "e2e.masterConflictBadgeTitle" where a
// security warning should be. Nothing in the type system catches that: keys are
// string literals and the locale files are plain JSON. This test is the check.
//
// The E2E surface is the worst place for it to happen: these strings are the
// only explanation a user ever gets for an unsigned device or a key conflict.

const SOURCE = fileURLToPath(new URL('../../components/dm/E2EControls.tsx', import.meta.url));
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/**
 * Every translation key the component can reach.
 *
 * Two patterns, because a key does not have to sit inside a `t()` call to be
 * rendered: the badge picks its title from a table of bare `'e2e.*'` literals
 * and translates the winner. Matching only `t('...')` would silently stop
 * covering exactly the strings that warn people about their own security.
 *
 * The lookbehind rejects identifiers that merely END in `t` (`split(`,
 * `useEffect(`) and member calls (`i18n.t(`).
 */
function extractKeys(source: string): string[] {
  const keys = new Set<string>();
  const called = /(?<![A-Za-z0-9_$.])t\(\s*'([^']*)'/g;
  for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
  const bare = /'(e2e\.[A-Za-z0-9_]+)'/g;
  for (let m = bare.exec(source); m; m = bare.exec(source)) keys.add(m[1]);
  return [...keys].sort();
}

function lookup(bundle: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      bundle
    );
}

const source = readFileSync(SOURCE, 'utf8');
const keys = extractKeys(source);
// Enumerated, never hardcoded: a locale added without translations must fail
// here rather than ship untranslated.
const localeFiles = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
const locales = localeFiles.map((file) => ({
  name: file.replace(/\.json$/, ''),
  bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown>,
}));

const e2eKeysOf = (bundle: Record<string, unknown>): string[] => {
  const section = bundle.e2e;
  return section && typeof section === 'object' ? Object.keys(section as object) : [];
};

describe('E2EControls translation keys', () => {
  it('finds the translation calls it is supposed to check', () => {
    // Guard against the extraction regex silently matching nothing after a
    // refactor — a vacuous test here would hide every missing translation.
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain('e2e.masterConflictBadgeTitle');
    expect(keys).toContain('e2e.thisDeviceUnsignedBadgeTitle');
    expect(locales.length).toBeGreaterThan(1);
  });

  it('resolves every key in every locale', () => {
    const missing: string[] = [];
    for (const { name, bundle } of locales) {
      for (const key of keys) {
        const value = lookup(bundle, key);
        if (typeof value !== 'string' || value.length === 0) missing.push(`${name}.json → ${key}`);
      }
    }
    expect(missing, `untranslated keys would render raw to users:\n${missing.join('\n')}`).toEqual(
      []
    );
  });

  it('has no e2e key in a translation that en.json lacks', () => {
    // Drift the other way: a key renamed in en.json leaves a stale entry behind
    // in the 10 other files, and the next reader cannot tell which one is live.
    const en = locales.find((l) => l.name === 'en');
    expect(en, 'en.json is the reference locale and must exist').toBeDefined();
    const reference = new Set(e2eKeysOf(en!.bundle));

    const orphans: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      for (const key of e2eKeysOf(bundle)) {
        if (!reference.has(key)) orphans.push(`${name}.json → e2e.${key}`);
      }
    }
    expect(orphans, `keys absent from en.json (stale or misspelled):\n${orphans.join('\n')}`).toEqual(
      []
    );
  });
});
