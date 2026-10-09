// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DISCOVERY_TAGS } from '@voxium/shared';

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
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/** The discovery surface's prefixes: the plan's namespaces plus the tab label. */
const PREFIX = String.raw`(?:discovery\.|server\.joinRequests\.|server\.banned\.|server\.removeAndBan|server\.banReason|serverSettings\.tabs\.discovery)`;

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

// The tag labels are reached through a template (`discovery.tags.${tag}`),
// which the static regex cannot see; the vocabulary is the list.
const TAG_KEYS = DISCOVERY_TAGS.map((tag) => `discovery.tags.${tag}`);

// The server strings the client maps to serverErrors.* for this feature
const ERROR_KEYS = [
  'discoveryDisabled', 'listingDisabledByAdmin', 'bannedFromServer', 'requestDeclinedRecently', 'joinRequestNotFound',
  'banNotFound', 'cannotTransferToBanned', 'cannotReportOwnServer', 'noPermissionManageMembers', 'noPermissionKickMembers', 'cannotKickHigherRole',
].map((k) => `serverErrors.${k}`);

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
    expect(locales.length).toBe(11);
  });

  it('resolves every key, every tag label and every mapped server error in every locale', () => {
    const missing: string[] = [];
    for (const { name, bundle } of locales) {
      for (const key of [...keys, ...TAG_KEYS, ...ERROR_KEYS]) {
        const value = lookup(bundle, key);
        if (typeof value !== 'string' || value.length === 0) missing.push(`${name}.json → ${key}`);
      }
    }
    expect(missing, `untranslated keys would render raw to users:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no discovery key in a translation that en.json lacks', () => {
    const en = locales.find((l) => l.name === 'en');
    expect(en, 'en.json is the reference locale and must exist').toBeDefined();
    const reference = new Set([
      ...leafKeys(en!.bundle.discovery, 'discovery.'),
      ...leafKeys((en!.bundle.server as Record<string, unknown>).joinRequests, 'server.joinRequests.'),
      ...leafKeys((en!.bundle.server as Record<string, unknown>).banned, 'server.banned.'),
    ]);

    const orphans: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      const server = bundle.server as Record<string, unknown>;
      for (const key of [
        ...leafKeys(bundle.discovery, 'discovery.'),
        ...leafKeys(server?.joinRequests, 'server.joinRequests.'),
        ...leafKeys(server?.banned, 'server.banned.'),
      ]) {
        if (!reference.has(key)) orphans.push(`${name}.json → ${key}`);
      }
    }
    expect(orphans, `keys absent from en.json (stale or misspelled):\n${orphans.join('\n')}`).toEqual([]);
  });

  it('calls the permission "Manage members" everywhere — kick always bans now, and the label says what the bit does', () => {
    const en = locales.find((l) => l.name === 'en')!.bundle;
    expect(lookup(en, 'permissions.KICK_MEMBERS.name')).toBe('Manage members');
    expect(String(lookup(en, 'permissions.KICK_MEMBERS.description'))).toMatch(/join requests/);
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
      for (const key of ['serverSettings.members.kickMember', 'serverSettings.members.kickConfirm', 'serverSettings.members.kick', 'contextMenu.kick', 'contextMenu.confirmKick']) {
        if (lookup(bundle, key) !== undefined) stale.push(`${name}.json → ${key}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
