// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The spaces strip's own strings (issue 6, docs/local/spaces-dm-navigation-plan.html):
 * the Messages tab and zone caption, the Spaces caption, New space, the notch
 * and the pin of the folded strip, and the Appearance setting that folds it.
 * A missing translation does not throw — i18next renders the raw key where
 * the one word that leads to Direct Messages should be. Sibling of
 * discoveryKeys.test.ts, scoped to the strip.
 */

const SOURCES = [
  fileURLToPath(new URL('../../components/server/SpacesStrip.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/settings/SettingsModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/common/AppShellMock.tsx', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const PREFIX = String.raw`(?:server\.(?:messagesTab|spacesZone|newSpace|stripRevealHandle|stripKeepOpen)|settings\.appearance\.strip[A-Za-z]*)`;

function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const called = new RegExp(String.raw`(?<![A-Za-z0-9_$.])t\(\s*'(` + PREFIX + String.raw`)'`, 'g');
    for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
  }
  return [...keys].sort();
}

function lookup(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle
  );
}
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();

const keys = extractKeys(SOURCES.map((file) => readFileSync(file, 'utf8')));
const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ name: file.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as Record<string, unknown> }));
const en = locales.find((l) => l.name === 'en')!;

describe('spaces strip translation keys', () => {
  it('finds the calls it is supposed to check', () => {
    expect(locales).toHaveLength(11);
    expect(keys).toEqual([
      'server.messagesTab',
      'server.newSpace',
      'server.spacesZone',
      'server.stripKeepOpen',
      'server.stripRevealHandle',
      'settings.appearance.stripAutoHide',
      'settings.appearance.stripAutoHideDesc',
      'settings.appearance.stripTitle',
    ]);
  });

  it('resolves every key in every locale, with the same placeholders as en.json', () => {
    const missing: string[] = [];
    const drift: string[] = [];
    for (const { name, bundle } of locales) {
      for (const key of keys) {
        const value = lookup(bundle, key);
        if (!isString(value)) {
          missing.push(`${name}.json → ${key}`);
          continue;
        }
        if (placeholders(value).join(',') !== placeholders(String(lookup(en.bundle, key))).join(',')) drift.push(`${name}.json → ${key}`);
      }
    }
    expect(missing, `untranslated keys would render raw to users:\n${missing.join('\n')}`).toEqual([]);
    expect(drift).toEqual([]);
  });

  it('the Messages tab is the short form in every locale: it costs a tab slot per 50 px', () => {
    for (const { name, bundle } of locales) {
      const tab = String(lookup(bundle, 'server.messagesTab'));
      const heading = String(lookup(bundle, 'dm.title'));
      expect(tab.length, `${name}.json server.messagesTab is longer than the sidebar heading`).toBeLessThanOrEqual(heading.length);
      expect(tab.length, `${name}.json server.messagesTab`).toBeLessThanOrEqual(14);
    }
  });

  it('the sidebar heading keeps its text: the e2e suite waits for "Direct Messages" as the app loaded', () => {
    expect(lookup(en.bundle, 'dm.title')).toBe('Direct Messages');
  });
});
