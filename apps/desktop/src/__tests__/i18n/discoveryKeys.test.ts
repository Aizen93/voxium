// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DISCOVERY_TAGS, DISCOVERY_SORTS } from '@voxium/shared';
import { DISCOVERY_ERROR_KEYS } from '../../utils/serverErrors';

// A missing translation does not throw — i18next renders the raw key, so a
// non-English owner would see "discovery.settings.blockedByAdmin" exactly
// where the one notice that explains an admin block lives. Sibling of
// secureChannelKeys.test.ts, scoped to the server-discovery surface
// (docs/local/server-discovery-plan.html, "i18n").

const SOURCES = [
  fileURLToPath(new URL('../../components/discovery/DiscoveryCard.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/DiscoveryTab.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/JoinRequestsSection.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/BannedSection.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/ServerSettingsModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/MemberContextMenu.tsx', import.meta.url)),
  fileURLToPath(new URL('../../stores/serverStore.ts', import.meta.url)),
  // step 4 — the member side
  fileURLToPath(new URL('../../components/discovery/DiscoveryModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/discovery/JoinRequestDialog.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/SpacesStrip.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/ServerSwitcher.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/CreateServerModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/chat/ReportModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../stores/discoveryStore.ts', import.meta.url)),
  fileURLToPath(new URL('../../services/discoverySocketHandlers.ts', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/** The discovery surface's prefixes: the plan's namespaces plus the tab label. */
const PREFIX = String.raw`(?:discovery\.|server\.joinRequests\.|server\.banned\.|server\.removeAndBan|server\.banReason|serverSettings\.tabs\.discovery|chat\.report\.reportSpace)`;

/** Every static key the surface can reach, via t() or i18n.t(). */
function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const called = new RegExp(String.raw`(?<![A-Za-z0-9_$.])t\(\s*'(` + PREFIX + String.raw`[^']*)'`, 'g');
    for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
    const member = new RegExp(String.raw`i18n\.t\(\s*'(` + PREFIX + String.raw`[^']*)'`, 'g');
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

/** The leaf keys of a section, dotted, for the orphan check. */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : leafKeys(v, `${prefix}${k}.`));
}

// ─── Plurals (i18next JSON v4): `t(key, { count })` resolves `key_<category>`
// and every CLDR category falls back to `key_other`. A locale that lacks a
// category it uses would silently render the fallback form ("1 members").
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const REQUIRED_CATEGORIES: Record<string, readonly string[]> = {
  en: ['one', 'other'], fr: ['one', 'other'], de: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ja: ['other'], ko: ['other'], zh: ['other'],
};

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
/** A key resolves when it is a leaf or a plural family (`key_other` exists). */
function resolves(bundle: unknown, key: string): boolean {
  return isString(lookup(bundle, key)) || isString(lookup(bundle, `${key}_other`));
}
function isPluralIn(bundle: unknown, key: string): boolean {
  return isString(lookup(bundle, `${key}_other`));
}
/** `{{name}}` placeholders, as a sorted list. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

// The tag labels are reached through a template (`discovery.tags.${tag}`),
// which the static regex cannot see; the vocabulary is the list.
const TAG_KEYS = DISCOVERY_TAGS.map((tag) => `discovery.tags.${tag}`);
// Same for the sort labels (`discovery.sort.${sort}` in the Explore modal)
const SORT_KEYS = DISCOVERY_SORTS.map((sort) => `discovery.sort.${sort}`);
// The report modal picks its title inside a ternary (`t(a ? '…' : b ? '…' : '…')`),
// which the call regex cannot see either
const TERNARY_KEYS = ['chat.report.reportSpace'];

// The server strings the client maps to serverErrors.* for this feature —
// the list is exported by the mapping module, so a new mapping is checked
// here without anyone remembering to copy its key.
const ERROR_KEYS = DISCOVERY_ERROR_KEYS.map((k) => `serverErrors.${k}`);

const ALL_KEYS = [...keys, ...TAG_KEYS, ...SORT_KEYS, ...TERNARY_KEYS, ...ERROR_KEYS];
const en = locales.find((l) => l.name === 'en');

describe('server-discovery translation keys', () => {
  it('finds the translation calls it is supposed to check', () => {
    expect(keys.length).toBeGreaterThan(40);
    // One key from each surface, so a SOURCES entry that stops resolving
    // (renamed, moved) fails here instead of shrinking coverage in silence.
    expect(keys).toContain('discovery.card.requestToJoin');          // the card
    expect(keys).toContain('discovery.settings.blockedByAdmin');     // the Discovery tab
    expect(keys).toContain('server.joinRequests.approve');           // join requests section
    expect(keys).toContain('server.banned.unban');                   // banned section
    expect(keys).toContain('serverSettings.tabs.discovery');         // the modal's tab
    expect(keys).toContain('server.removeAndBanDescription');        // context menu + members tab
    expect(keys).toContain('discovery.modal.loadMore');              // the Explore modal
    expect(keys).toContain('discovery.request.send');                // the request dialog
    expect(keys).toContain('discovery.explore');                     // the strip's compass
    expect(keys).toContain('discovery.switcherExplore');             // the switcher's no-match offer
    expect(keys).toContain('discovery.browsePublic');                // the create/join modal link
    expect(keys).toContain('discovery.toasts.approved');             // the socket handlers
    // the report modal's server title is template-reached: pinned via TERNARY_KEYS
    expect(readFileSync(SOURCES[SOURCES.length - 3], 'utf8')).toContain("'chat.report.reportSpace'");
    expect(ERROR_KEYS.length).toBeGreaterThan(10);
    expect(locales.length).toBe(11);
    expect(en, 'en.json is the reference locale and must exist').toBeDefined();
    for (const { name } of locales) {
      expect(REQUIRED_CATEGORIES[name], `${name}.json has no plural-category entry in this test`).toBeDefined();
    }
  });

  it('resolves every key, every tag label and every mapped server error in every locale', () => {
    const missing: string[] = [];
    for (const { name, bundle } of locales) {
      for (const key of ALL_KEYS) {
        if (!resolves(bundle, key)) missing.push(`${name}.json → ${key}`);
      }
    }
    expect(missing, `untranslated keys would render raw to users:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every key en.json pluralises is pluralised in every locale, with every category that language uses', () => {
    const problems: string[] = [];
    const pluralKeys = ALL_KEYS.filter((key) => isPluralIn(en!.bundle, key));
    // the three card figures and the badge label are the ones that bit
    expect(pluralKeys).toEqual(expect.arrayContaining([
      'discovery.card.online', 'discovery.card.members', 'discovery.card.messages', 'server.joinRequests.pending',
    ]));
    for (const { name, bundle } of locales) {
      for (const key of pluralKeys) {
        if (isString(lookup(bundle, key))) problems.push(`${name}.json → ${key} is a bare string (en.json pluralises it)`);
        for (const category of REQUIRED_CATEGORIES[name]) {
          if (!isString(lookup(bundle, `${key}_${category}`))) problems.push(`${name}.json → ${key}_${category} missing`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('keeps the same {{placeholders}} as en.json in every locale (a plural form may omit {{count}}, never invent one)', () => {
    const problems: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      for (const key of ALL_KEYS) {
        if (isPluralIn(en!.bundle, key)) {
          const reference = placeholders(String(lookup(en!.bundle, `${key}_other`)));
          for (const category of PLURAL_CATEGORIES) {
            const form = lookup(bundle, `${key}_${category}`);
            if (!isString(form)) continue;
            const extra = placeholders(form).filter((p) => !reference.includes(p));
            if (extra.length) problems.push(`${name}.json → ${key}_${category} uses {{${extra.join('}}, {{')}}} which en.json does not`);
          }
        } else {
          const ref = lookup(en!.bundle, key);
          const val = lookup(bundle, key);
          if (!isString(ref) || !isString(val)) continue;
          const a = placeholders(ref).join(',');
          const b = placeholders(val).join(',');
          if (a !== b) problems.push(`${name}.json → ${key}: {{${b || '∅'}}} vs en {{${a || '∅'}}}`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('has no discovery key in a translation that en.json lacks', () => {
    const reference = new Set([
      ...leafKeys(en!.bundle.discovery, 'discovery.'),
      ...leafKeys((en!.bundle.server as Record<string, unknown>).joinRequests, 'server.joinRequests.'),
      ...leafKeys((en!.bundle.server as Record<string, unknown>).banned, 'server.banned.'),
    ]);
    // a plural form is an orphan only when en.json has no family for it —
    // ru/uk/ar carry categories English does not
    const known = (key: string) => reference.has(key) || (PLURAL_SUFFIX.test(key) && reference.has(key.replace(PLURAL_SUFFIX, '_other')));

    const orphans: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      const server = bundle.server as Record<string, unknown>;
      for (const key of [
        ...leafKeys(bundle.discovery, 'discovery.'),
        ...leafKeys(server?.joinRequests, 'server.joinRequests.'),
        ...leafKeys(server?.banned, 'server.banned.'),
      ]) {
        if (!known(key)) orphans.push(`${name}.json → ${key}`);
      }
    }
    expect(orphans, `keys absent from en.json (stale or misspelled):\n${orphans.join('\n')}`).toEqual([]);
  });

  it('calls the permission "Manage members" everywhere — kick always bans now, and the label says what the bit does', () => {
    expect(lookup(en!.bundle, 'permissions.KICK_MEMBERS.name')).toBe('Manage members');
    expect(String(lookup(en!.bundle, 'permissions.KICK_MEMBERS.description'))).toMatch(/join requests/);
    for (const { name, bundle } of locales) {
      const label = String(lookup(bundle, 'permissions.KICK_MEMBERS.name'));
      // the old wording in every locale was a bare "kick/expel members" label;
      // the new one must at least differ from it and be present
      expect(label.length, `${name}.json permissions.KICK_MEMBERS.name`).toBeGreaterThan(0);
      expect(String(lookup(bundle, 'permissions.KICK_MEMBERS.description')).length).toBeGreaterThan(20);
    }
  });

  it('no locale still carries the pre-discovery kick keys (removed with the rename)', () => {
    const stale: string[] = [];
    for (const { name, bundle } of locales) {
      for (const key of [
        'serverSettings.members.kickMember', 'serverSettings.members.kickConfirm', 'serverSettings.members.kick',
        'serverSettings.members.kickDescription', 'serverSettings.members.failedToKick',
        'contextMenu.kick', 'contextMenu.confirmKick', 'contextMenu.failedToKick',
      ]) {
        if (lookup(bundle, key) !== undefined) stale.push(`${name}.json → ${key}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
