// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';

// A missing translation does not throw — i18next renders the raw key, so a
// non-English sharer would see "voice.annotations.maskPrivacyHint" exactly
// where the privacy guarantee is explained. Sibling of e2eKeys.test.ts (its
// regexes are e2e-scoped, so the annotation surface gets its own scan).

const SOURCES = [
  fileURLToPath(new URL('../../components/voice/AnnotationToolbar.tsx', import.meta.url)),
  // the labelKey table the toolbar and the shortcuts share
  fileURLToPath(new URL('../../components/voice/annotationPresets.ts', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/ColorPalettePopover.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/SharePreflightModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/StageZoom.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/Reactions.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/SnapshotMenu.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/AnnotationEditorLayer.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/ScreenShareViewer.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/voice/ScreenShareFloating.tsx', import.meta.url)),
  // sceneFull toast lives in the store's flush path, reached via i18n.t()
  fileURLToPath(new URL('../../stores/annotationStore.ts', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/**
 * Every translation key the annotation surface can reach: `t('...')` calls
 * (the lookbehind rejects identifiers that merely END in `t`), plus the
 * toolbar's `labelKey` table of bare `'voice.annotations.*'` literals, plus
 * `i18n.t('...')` calls in the store.
 */
function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const called = /(?<![A-Za-z0-9_$.])t\(\s*'([^']*)'/g;
    for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
    const member = /i18n\.t\(\s*'([^']*)'/g;
    for (let m = member.exec(source); m; m = member.exec(source)) keys.add(m[1]);
    const bare = /'(voice\.annotations\.[A-Za-z0-9_]+)'/g;
    for (let m = bare.exec(source); m; m = bare.exec(source)) keys.add(m[1]);
  }
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

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// Plurals (i18next JSON v4): `t(key, { count })` resolves `key_<category>`,
// and a key may be a plural family instead of one string. The categories each
// language must spell out are the ones discoveryKeys.test.ts requires.
const REQUIRED_CATEGORIES: Record<string, readonly string[]> = {
  en: ['one', 'other'], fr: ['one', 'other'], de: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ja: ['other'], ko: ['other'], zh: ['other'],
};

/** A key resolves when it is a string or a plural family (`key_other` exists). */
function resolves(bundle: unknown, key: string): boolean {
  return isString(lookup(bundle, key)) || isString(lookup(bundle, `${key}_other`));
}

const keys = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
const localeFiles = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
const locales = localeFiles.map((file) => ({
  name: file.replace(/\.json$/, ''),
  bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown>,
}));

const annotationKeysOf = (bundle: Record<string, unknown>): string[] => {
  const voice = bundle.voice as Record<string, unknown> | undefined;
  const section = voice?.annotations;
  return section && typeof section === 'object' ? Object.keys(section as object) : [];
};

describe('screen-share annotation translation keys', () => {
  it('finds the translation calls it is supposed to check', () => {
    // Guard against the extraction regexes silently matching nothing after a
    // refactor — a vacuous test here would hide every missing translation.
    expect(keys.length).toBeGreaterThan(15);
    // One key from each surface, so a SOURCES entry that stops resolving
    // (renamed, moved) fails here instead of shrinking coverage in silence.
    expect(keys).toContain('voice.annotations.mask');            // presets (labelKey table)
    expect(keys).toContain('voice.annotations.annotate');        // toolbar
    expect(keys).toContain('voice.annotations.addTextPlaceholder'); // editor layer
    expect(keys).toContain('voice.youAreSharing');               // viewer
    expect(keys).toContain('voice.screenShare');                 // floating panel
    expect(keys).toContain('voice.annotations.sceneFull');       // store toast
    expect(keys).toContain('voice.preflight.goLive');             // pre-flight modal
    expect(locales.length).toBeGreaterThan(1);
  });

  it('resolves every key in every locale', () => {
    const missing: string[] = [];
    for (const { name, bundle } of locales) {
      for (const key of keys) {
        if (!resolves(bundle, key)) missing.push(`${name}.json → ${key}`);
      }
    }
    expect(missing, `untranslated keys would render raw to users:\n${missing.join('\n')}`).toEqual(
      []
    );
  });

  it('every key en.json pluralises is pluralised in every locale, with every category that language uses', () => {
    const en = locales.find((l) => l.name === 'en')!;
    const pluralKeys = keys.filter((key) => isString(lookup(en.bundle, `${key}_other`)));
    // the pre-flight modal's mask count said "1 masks" when it was one plain string
    expect(pluralKeys).toContain('voice.preflight.maskCount');
    const problems: string[] = [];
    for (const { name, bundle } of locales) {
      const required = REQUIRED_CATEGORIES[name];
      if (!required) {
        problems.push(`${name}.json has no plural-category entry in this test`);
        continue;
      }
      for (const key of pluralKeys) {
        for (const category of required) {
          if (!isString(lookup(bundle, `${key}_${category}`))) problems.push(`${name}.json → ${key}_${category}`);
        }
        // a leftover plain string beside the family would be a second, unused translation
        if (lookup(bundle, key) !== undefined) problems.push(`${name}.json → ${key} (plain string beside the plural family)`);
      }
    }
    expect(problems, `plural forms a language needs:\n${problems.join('\n')}`).toEqual([]);
  });

  it('renders the mask count in the right form through i18next', async () => {
    const resources = Object.fromEntries(locales.map(({ name, bundle }) => [name, { translation: bundle }]));
    const i18n = i18next.createInstance();
    await i18n.init({ resources, lng: 'en', fallbackLng: false, interpolation: { escapeValue: false } });
    const maskCount = (lng: string, count: number) => i18n.getFixedT(lng)('voice.preflight.maskCount', { count });

    expect(maskCount('en', 1)).toBe('1 mask');
    expect(maskCount('en', 2)).toBe('2 masks');
    expect(maskCount('en', 0)).toBe('0 masks');
    expect(maskCount('fr', 1)).toBe('1 masque');
    expect(maskCount('fr', 3)).toBe('3 masques');
    expect(maskCount('de', 1)).toBe('1 Maske');
    expect(maskCount('ru', 1)).toBe('1 маска');
    expect(maskCount('ru', 3)).toBe('3 маски');
    expect(maskCount('ru', 5)).toBe('5 масок');
    expect(maskCount('ar', 2)).toBe('قناعان');
    expect(maskCount('ja', 1)).toBe('マスク 1 件');
    // every language renders a translation for one mask, never the raw key
    for (const { name } of locales) {
      expect(maskCount(name, 1), `${name}.json`).not.toBe('voice.preflight.maskCount');
    }
  });

  it('has no annotations key in a translation that en.json lacks', () => {
    const en = locales.find((l) => l.name === 'en');
    expect(en, 'en.json is the reference locale and must exist').toBeDefined();
    const reference = new Set(annotationKeysOf(en!.bundle));

    const orphans: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      for (const key of annotationKeysOf(bundle)) {
        if (!reference.has(key)) orphans.push(`${name}.json → voice.annotations.${key}`);
      }
    }
    expect(orphans, `keys absent from en.json (stale or misspelled):\n${orphans.join('\n')}`).toEqual(
      []
    );
  });
});
