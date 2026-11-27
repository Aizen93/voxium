// @vitest-environment node
// Pure filesystem check. A missing translation does not throw: i18next renders
// the raw key, so a French reader would see "emojiPickerLabels.category.flags"
// as a category header. Covers the emoji picker's labels and the updater's
// failure sentences, all 11 locales.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));
const SOURCES = [
  fileURLToPath(new URL('../../components/common/EmojiPicker.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/updater/UpdateChecker.tsx', import.meta.url)),
];

const CATEGORIES = ['suggested', 'smileys_people', 'animals_nature', 'food_drink', 'travel_places', 'activities', 'objects', 'symbols', 'flags'];
const KEYS = [
  ...CATEGORIES.map((c) => `emojiPickerLabels.category.${c}`),
  'emojiPickerLabels.defaultCaption',
  'emojiPickerLabels.clearSearch',
  'updater.failed',
  'updater.failedNetwork',
];

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

const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ name: file.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown> }));
const en = locales.find((l) => l.name === 'en')!;

describe('emoji picker and updater translation keys', () => {
  it('covers all 11 locales', () => {
    expect(locales).toHaveLength(11);
  });

  it('every key is a non-empty string in every locale, with no placeholder', () => {
    for (const l of locales) {
      for (const k of KEYS) {
        const v = lookup(l.bundle, k);
        expect(typeof v === 'string' && v.trim().length > 0, `${l.name}: ${k}`).toBe(true);
        expect(v as string, `${l.name}: ${k}`).not.toMatch(/\{\{/);
      }
      expect(leafKeys(lookup(l.bundle, 'emojiPickerLabels'), 'emojiPickerLabels.').sort(), l.name)
        .toEqual(KEYS.filter((k) => k.startsWith('emojiPickerLabels.')).sort());
    }
  });

  it('each non-English language says it in its own words', () => {
    for (const l of locales.filter((x) => x.name !== 'en')) {
      for (const k of KEYS.filter((x) => x !== 'updater.failed')) {
        expect(lookup(l.bundle, k), `${l.name}: ${k}`).not.toBe(lookup(en.bundle, k));
      }
    }
  });

  it('French uses typographic apostrophes and a no-break space before : ; ? !', () => {
    const fr = locales.find((l) => l.name === 'fr')!;
    for (const k of KEYS) {
      const v = lookup(fr.bundle, k) as string;
      expect(v, k).not.toContain("'");
      expect(v, k).not.toMatch(/ [:;?!]/);
    }
    expect(lookup(fr.bundle, 'emojiPickerLabels.defaultCaption')).toBe('Quelle est votre humeur ?');
  });

  it('every key the two components name literally exists', () => {
    const named = new Set<string>();
    for (const file of SOURCES) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/'((?:emojiPickerLabels|updater)\.[A-Za-z0-9_.]+)'/g)) named.add(m[1]);
    }
    expect(named.size).toBeGreaterThan(0);
    for (const k of named) expect(KEYS.includes(k) || lookup(en.bundle, k) !== undefined, k).toBe(true);
  });
});
