// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A missing translation does not throw — i18next renders the raw key, so a
// non-English admin would see "secureChannel.moderationHint" exactly where
// the one sanctioned moderation path for secure channels is explained.
// Sibling of annotationKeys.test.ts / e2eKeys.test.ts, scoped to the
// secure-channel surface.

const SOURCES = [
  fileURLToPath(new URL('../../components/channel/ChannelSidebar.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/ServerSettingsModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/SecureChannelCreateModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/SecureChannelMembersModal.tsx', import.meta.url)),
  // membersNotReady toast lives in the store's send path, reached via i18n.t()
  fileURLToPath(new URL('../../stores/chatStore.ts', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/** Every `secureChannel.*` key the surface can reach, via t() or i18n.t(). */
function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const called = /(?<![A-Za-z0-9_$.])t\(\s*'(secureChannel\.[^']*)'/g;
    for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
    const member = /i18n\.t\(\s*'(secureChannel\.[^']*)'/g;
    for (let m = member.exec(source); m; m = member.exec(source)) keys.add(m[1]);
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

const sectionKeysOf = (bundle: Record<string, unknown>): string[] => {
  const section = bundle.secureChannel;
  return section && typeof section === 'object' ? Object.keys(section as object) : [];
};

describe('secure-channel translation keys', () => {
  it('finds the translation calls it is supposed to check', () => {
    expect(keys.length).toBeGreaterThan(15);
    // One key from each surface, so a SOURCES entry that stops resolving
    // (renamed, moved) fails here instead of shrinking coverage in silence.
    expect(keys).toContain('secureChannel.copyId');          // sidebar context menu
    expect(keys).toContain('secureChannel.moderationHint');  // server settings
    expect(keys).toContain('secureChannel.createTitle');     // create modal
    expect(keys).toContain('secureChannel.members');         // members modal (and menu)
    expect(keys).toContain('secureChannel.membersNotReady'); // store toast
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

  it('has no secureChannel key in a translation that en.json lacks', () => {
    const en = locales.find((l) => l.name === 'en');
    expect(en, 'en.json is the reference locale and must exist').toBeDefined();
    const reference = new Set(sectionKeysOf(en!.bundle));

    const orphans: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      for (const key of sectionKeysOf(bundle)) {
        if (!reference.has(key)) orphans.push(`${name}.json → secureChannel.${key}`);
      }
    }
    expect(orphans, `keys absent from en.json (stale or misspelled):\n${orphans.join('\n')}`).toEqual(
      []
    );
  });

  it('no longer tells admins to look for a channel id in a report — reports of secure-channel messages are refused', () => {
    // The reference copy only; translations are checked for presence above.
    const en = locales.find((l) => l.name === 'en')!.bundle;
    const hint = String(lookup(en, 'secureChannel.moderationHint'));
    const placeholder = String(lookup(en, 'secureChannel.moderationDeletePlaceholder'));
    expect(hint).not.toMatch(/from a report/i);
    expect(placeholder).not.toMatch(/report/i);
    // ...and says where the id actually comes from
    expect(hint).toMatch(/copy/i);
    expect(hint).toMatch(/member/i);
  });
});
