// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
        const value = lookup(bundle, key);
        if (typeof value !== 'string' || value.length === 0) missing.push(`${name}.json → ${key}`);
      }
    }
    expect(missing, `untranslated keys would render raw to users:\n${missing.join('\n')}`).toEqual(
      []
    );
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
