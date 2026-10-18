// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WEBHOOK_ERROR_KEYS } from '../../utils/serverErrors';

// A missing translation does not throw — i18next renders the raw key, so a
// non-English moderator would see "webhooks.reveal.copyNow" exactly where
// the one warning that the URL is shown once lives. Sibling of
// discoveryKeys.test.ts, scoped to the incoming-webhooks surface
// (docs/local/webhooks-plan.html): the Integrations tab and its dialogs, the
// tab label and limit row, the mapped server errors, and the two message-row
// labels a webhook-authored message carries.

const SOURCES = [
  fileURLToPath(new URL('../../components/server/IntegrationsTab.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/WebhookCreateDialog.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/WebhookCreatedPanel.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/WebhookDialog.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/server/ServerSettingsModal.tsx', import.meta.url)),
  fileURLToPath(new URL('../../utils/serverErrors.ts', import.meta.url)),
  fileURLToPath(new URL('../../services/webhooks.ts', import.meta.url)),
  // the message side (step 2b): the APP tag and the deleted-webhook label
  fileURLToPath(new URL('../../components/chat/MessageItem.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/chat/MessageList.tsx', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/** The webhook surface's prefixes: the tab's namespace, the tab label and limit row, the errors, the message labels. */
const PREFIX = String.raw`(?:webhooks\.|serverSettings\.tabs\.integrations|serverSettings\.limits\.maxWebhooks|serverErrors\.webhook|messageItem\.appTag|messageItem\.deletedWebhook)`;

/**
 * Every static key the surface can reach: t() / i18n.t() calls, and the
 * fallback keys the tab hands to getTranslatedError() (`fail(err, 'webhooks.…')`),
 * which no t( call names — any quoted literal under the prefixes is a key.
 */
function extractKeys(sources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const called = new RegExp(String.raw`(?<![A-Za-z0-9_$.])t\(\s*'(` + PREFIX + String.raw`[^']*)'`, 'g');
    for (let m = called.exec(source); m; m = called.exec(source)) keys.add(m[1]);
    const member = new RegExp(String.raw`i18n\.t\(\s*'(` + PREFIX + String.raw`[^']*)'`, 'g');
    for (let m = member.exec(source); m; m = member.exec(source)) keys.add(m[1]);
    const literal = new RegExp(String.raw`'(` + PREFIX + String.raw`[A-Za-z0-9_.]*)'`, 'g');
    for (let m = literal.exec(source); m; m = literal.exec(source)) keys.add(m[1]);
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
// category it uses would silently render the fallback form ("1 messages").
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
/** `{{name}}` placeholders, as a sorted list — a format suffix (`{{count, number}}`) is part of the same placeholder. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)(?:\s*,[^}]*)?\s*\}\}/g)].map((m) => m[1]).sort();
}

// The server strings (exact AND pattern-matched) the client maps to
// serverErrors.* for this feature — exported by the mapping module, which
// reaches them through a template the call regex cannot see.
const ERROR_KEYS = WEBHOOK_ERROR_KEYS.map((k) => `serverErrors.${k}`);

const ALL_KEYS = [...new Set([...keys, ...ERROR_KEYS])];
const en = locales.find((l) => l.name === 'en');

describe('incoming-webhook translation keys', () => {
  it('finds the translation calls it is supposed to check', () => {
    expect(keys.length).toBeGreaterThan(40);
    // One key from each surface, so a SOURCES entry that stops resolving
    // (renamed, moved) fails here instead of shrinking coverage in silence.
    expect(keys).toContain('webhooks.newWebhook');                    // the tab
    expect(keys).toContain('webhooks.off.title');                     // its OFF state
    expect(keys).toContain('webhooks.delete.deletedMessages');        // the delete confirm (plural)
    expect(keys).toContain('webhooks.create.typeGithubHint');         // the create dialog
    expect(keys).toContain('webhooks.reveal.copyNow');                // the copy-once panel
    expect(keys).toContain('webhooks.toggleFailed');                  // a fallback key, no t( call names it
    expect(keys).toContain('serverSettings.tabs.integrations');       // the modal's tab
    expect(keys).toContain('serverSettings.limits.maxWebhooksDesc');  // the Limits row
    expect(ERROR_KEYS).toEqual(expect.arrayContaining(['serverErrors.webhooksDisabled', 'serverErrors.webhookCap', 'serverErrors.webhookNameTooLong']));
    expect(locales.length).toBe(11);
    expect(en, 'en.json is the reference locale and must exist').toBeDefined();
    for (const { name } of locales) {
      expect(REQUIRED_CATEGORIES[name], `${name}.json has no plural-category entry in this test`).toBeDefined();
    }
  });

  it('the message-row labels the other half of step 2 renders exist in every locale', () => {
    // Pinned explicitly too: while MessageItem/MessageList are being wired
    // the source scan may not see them yet, and they must not go untranslated.
    for (const { name, bundle } of locales) {
      expect(isString(lookup(bundle, 'messageItem.appTag')), `${name}.json → messageItem.appTag`).toBe(true);
      expect(isString(lookup(bundle, 'messageItem.deletedWebhook')), `${name}.json → messageItem.deletedWebhook`).toBe(true);
    }
  });

  it('resolves every key and every mapped server error in every locale', () => {
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
    expect(pluralKeys).toEqual(expect.arrayContaining(['webhooks.delete.deletedMessages']));
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

  it('has no webhooks key in a translation that en.json lacks', () => {
    const reference = new Set(leafKeys(en!.bundle.webhooks, 'webhooks.'));
    // a plural form is an orphan only when en.json has no family for it —
    // ru/uk/ar carry categories English does not
    const known = (key: string) => reference.has(key) || (PLURAL_SUFFIX.test(key) && reference.has(key.replace(PLURAL_SUFFIX, '_other')));

    const orphans: string[] = [];
    for (const { name, bundle } of locales) {
      if (name === 'en') continue;
      for (const key of leafKeys(bundle.webhooks, 'webhooks.')) {
        if (!known(key)) orphans.push(`${name}.json → ${key}`);
      }
    }
    expect(orphans, `keys absent from en.json (stale or misspelled):\n${orphans.join('\n')}`).toEqual([]);
  });

  it('every webhooks key en.json defines is reached by the surface (no dead copy)', () => {
    const reached = new Set(ALL_KEYS);
    const dead = leafKeys(en!.bundle.webhooks, 'webhooks.')
      .map((key) => key.replace(PLURAL_SUFFIX, ''))
      .filter((key) => !reached.has(key));
    expect([...new Set(dead)], `en.json keys no source calls:\n${dead.join('\n')}`).toEqual([]);
  });

  it('keeps "webhook" a recognisable term: the tab copy uses the same word as the permission label', () => {
    // The permission row (permissions.MANAGE_WEBHOOKS) is where an owner first
    // meets the word; the tab, the errors and the limit row must say the same.
    const stems: Record<string, string> = {
      en: 'webhook', fr: 'webhook', de: 'Webhook', es: 'webhook', pt: 'webhook',
      ru: 'вебхук', uk: 'вебхук', ja: 'ウェブフック', ko: '웹후크', zh: 'Webhook', ar: 'خطاف',
    };
    for (const { name, bundle } of locales) {
      const stem = stems[name];
      expect(String(lookup(bundle, 'permissions.MANAGE_WEBHOOKS.name')).toLowerCase(), `${name}.json permission label`).toContain(stem.toLowerCase());
      for (const key of ['webhooks.newWebhook', 'serverErrors.webhookNotFound', 'serverSettings.limits.maxWebhooks']) {
        expect(String(lookup(bundle, key)).toLowerCase(), `${name}.json → ${key}`).toContain(stem.toLowerCase());
      }
    }
  });
});
